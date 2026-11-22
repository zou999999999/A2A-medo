/**
 * A2A v1 Core Architecture - Client Headset SDK (client/headset_client.js)
 *
 * Implements:
 *   1. Stranger Discovery on-chain by capability clues/tags (`discoverStrangerHostsByClue`)
 *      + Local caching of Host's long-term fixed HTTPS endpoint (no repeated chain queries needed).
 *   2. Cross-reboot / Cross-endpoint `taskId` continuity:
 *      Even if laptops reboot or HTTPS URL updates across days, `(hostAid, taskId)` seamlessly continues.
 *   3. Counter-Question & Proposal Anti-Fooling Guard (`evaluateHostProposalOrCounterQuestion`):
 *      - Automatically rejects blacklisted providers or over-budget proposals based on `ownerPreferences`.
 *      - If the owner forgot to write max budget or provider preference on the `ownerIntentCard`,
 *        automatically triggers `ESCALATE_TO_HUMAN_OWNER` (`waiting_owner_confirmation`) instead of letting
 *        the Agent get tricked into placing an expensive order!
 *      - When the human owner confirms (`confirmEscalatedProposal`), learns the new preference permanently.
 *   4. Physical Task Sandbox Isolation + Top-K Distilled Notes Funnel + Audited `recallArchivedTask`.
 *   5. Dual-Side Idempotent `cancelTask` (safe even when triggered simultaneously by Host and Client).
 */

const crypto = require('node:crypto');
const {
  searchHostsByClueOnChain,
  findHostByRemoteChainAID,
  discoverHostEndpoint,
  deliverToMailbox,
  checkClientMailbox
} = require('./discovery_client');
const { ClientMemoryStore } = require('./memory_store');

class A2AHeadsetClient {
  constructor({
    clientAid = process.env.CLIENT_AID || 'client-2002',
    clientName = process.env.CLIENT_NAME || 'Beta-Client-Headset',
    clientEndpoint = process.env.CLIENT_HTTPS_URL || null,
    timeoutMs = Number(process.env.REQUEST_TIMEOUT_MS || 5000),
    memoryFilePath = undefined
  } = {}) {
    this.clientAid = clientAid;
    this.clientName = clientName;
    this.clientEndpoint = clientEndpoint;
    this.timeoutMs = timeoutMs;
    this.memory = new ClientMemoryStore(this.clientAid, memoryFilePath);
  }

  /**
   * Step 0 (For Complete Strangers):
   * Find unknown Host Agents on-chain by searching capability tags or task keywords
   * Automatically caches the top match's fixed HTTPS endpoint locally so future calls don't need chain lookups!
   */
  discoverStrangerHostsByClue({ query = '', tag = '', autoBindFirst = true } = {}) {
    const searchRes = searchHostsByClueOnChain({ query, tag });
    if (autoBindFirst && searchRes.candidates.length > 0) {
      const top = searchRes.candidates[0];
      this.memory.recordDiscovery(top.aid, {
        httpsEndpoint: top.httpsEndpoint,
        mailboxAddress: top.mailboxAddress,
        tags: top.tags,
        source: 'onchain_tag_clue_discovery'
      });
    }
    return searchRes;
  }

  /**
   * Step 1: Discover Host's HTTPS endpoint by known AID (via On-Chain AID or Mailbox)
   */
  discoverHost(hostAid, { strategy = 'auto' } = {}) {
    const res = discoverHostEndpoint({
      clientAid: this.clientAid,
      hostAid,
      strategy
    });

    if (res.found && res.httpsEndpoint) {
      this.memory.recordDiscovery(hostAid, {
        httpsEndpoint: res.httpsEndpoint,
        mailboxAddress: res.mailboxAddress || null,
        tags: res.tags || [],
        source: res.source
      });
    }

    return res;
  }

  /**
   * Resolve Host's long-term HTTPS endpoint (prioritizes local memory cache so Client doesn't query chain every time!)
   */
  resolveEndpointOrThrow(hostAid, { forceRefresh = false, strategy = 'auto' } = {}) {
    const hostMem = this.memory.ensureHost(hostAid);
    if (!forceRefresh && hostMem.httpsEndpoint) {
      return {
        httpsEndpoint: hostMem.httpsEndpoint,
        source: hostMem.discoverySource || 'local_cached_fixed_https'
      };
    }

    const discovered = this.discoverHost(hostAid, { strategy });
    if (discovered.found && discovered.httpsEndpoint) {
      return {
        httpsEndpoint: discovered.httpsEndpoint,
        source: discovered.source
      };
    }

    return {
      httpsEndpoint: null,
      source: 'not_found'
    };
  }

  async resolveEndpointAsync(hostAid, { forceRefresh = false, strategy = 'auto' } = {}) {
    const syncRes = this.resolveEndpointOrThrow(hostAid, { forceRefresh, strategy });
    if (!forceRefresh && syncRes.httpsEndpoint) return syncRes;

    try {
      const remoteRes = await findHostByRemoteChainAID(hostAid);
      if (remoteRes.found && remoteRes.httpsEndpoint) {
        this.memory.recordDiscovery(hostAid, {
          httpsEndpoint: remoteRes.httpsEndpoint,
          mailboxAddress: remoteRes.mailboxAddress || null,
          tags: remoteRes.tags || [],
          source: remoteRes.source
        });
        return {
          httpsEndpoint: remoteRes.httpsEndpoint,
          source: remoteRes.source
        };
      }
    } catch {
      // Remote chain unreachable, fall back to syncRes
    }

    return syncRes;
  }
  setOwnerIntentCard(taskId, cardOptions) {
    return this.memory.setOwnerIntentCard(taskId, cardOptions);
  }

  /**
   * When a Host counter-question/proposal is escalated to the human owner, the owner confirms or rejects here,
   * and the headset automatically learns the owner's new budget/provider preference for all future tasks!
   */
  async confirmEscalatedProposal({
    hostAid,
    taskId,
    approved,
    ownerReplyText,
    learnedMaxBudget = null,
    learnedBlacklistedProvider = null,
    learnedPreferredProvider = null,
    learnedCustomRule = null
  }) {
    // 1. Save newly learned boundaries into permanent Owner Preferences
    const updatedPrefs = this.memory.updateOwnerPreferences({
      category: 'flight',
      maxBudget: learnedMaxBudget,
      addBlacklistedProvider: learnedBlacklistedProvider,
      addPreferredProvider: learnedPreferredProvider,
      addCustomRule: learnedCustomRule
    });

    // Also update the active task's Owner Intent Card if budget was specified
    const card = this.memory.getOwnerIntentCard(taskId);
    if (card && learnedMaxBudget !== null) {
      card.maxBudget = Number(learnedMaxBudget);
    }
    if (card && learnedBlacklistedProvider) {
      card.forbiddenProviders = Array.from(new Set([...(card.forbiddenProviders || []), learnedBlacklistedProvider]));
    }

    const host = this.memory.ensureHost(hostAid);
    if (host.tasks[taskId]) {
      host.tasks[taskId].pendingHumanConfirmation = null;
    }
    this.memory.save();

    // 2. Send the owner-confirmed response back to Host under the exact same taskId!
    const sendRes = await this.sendMessage({
      hostAid,
      mode: 'task',
      taskId,
      messageType: 'owner_confirmed_answer',
      text:
        ownerReplyText ||
        (approved
          ? '主人已确认同意该方案，请继续执行。'
          : `主人已拒绝该方案（已更新底线约束：预算<=${learnedMaxBudget ?? '未变'}，拉黑:${learnedBlacklistedProvider ?? '无'}），请重新提供符合条件的方案。`)
    });

    return {
      ok: true,
      approved,
      updatedOwnerPreferences: updatedPrefs,
      sendResult: sendRes
    };
  }

  /**
   * Internal JSON-RPC 2.0 over HTTPS caller with timeout & offline diagnostics
   */
  async _callHostRpc(hostAid, httpsEndpoint, method, params, customTimeoutMs = null) {
    const effectiveTimeout = customTimeoutMs || this.timeoutMs;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), effectiveTimeout);

    try {
      const response = await fetch(`${httpsEndpoint}/a2a`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'bypass-tunnel-reminder': 'true',
          'ngrok-skip-browser-warning': 'true'
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `rpc_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
          method,
          params
        }),
        signal: controller.signal
      });

      clearTimeout(timer);

      if (!response.ok) {
        const err = new Error(`HTTPS tunnel or endpoint returned HTTP ${response.status}`);
        err.code = `HTTP_${response.status}`;
        err.isOfflineError = [404, 502, 503, 504, 530].includes(response.status);
        throw err;
      }

      const data = await response.json();
      this.memory.markHostOnline(hostAid, httpsEndpoint);
      return { ok: true, rpc: data };
    } catch (err) {
      clearTimeout(timer);
      const causeCode = err.cause?.code || err.code || '';
      const isTimeout = err.name === 'AbortError' || causeCode === 'ETIMEDOUT';
      const isRefused =
        causeCode === 'ECONNREFUSED' ||
        causeCode === 'ENOTFOUND' ||
        causeCode === 'ECONNRESET' ||
        err.message.includes('fetch failed') ||
        Boolean(err.isOfflineError);

      let diagnosis = '未知网络异常';
      if (isTimeout) {
        diagnosis = `连接超时 (${effectiveTimeout}ms) —— 对方电脑可能已关机、休眠或网络中断`;
      } else if (causeCode === 'ECONNREFUSED' || err.message.includes('fetch failed')) {
        diagnosis = '目标 HTTPS 端口拒绝连接 (ECONNREFUSED) —— Host 耳机服务未启动或对方电脑已关机';
      } else if (err.isOfflineError) {
        diagnosis = `反向 HTTPS 隧道不可达 (${err.code}) —— Host 的打洞隧道当前处于关闭状态`;
      }

      this.memory.markHostOffline(hostAid, diagnosis);

      return {
        ok: false,
        offline: isTimeout || isRefused,
        errorCode: isTimeout ? 'HOST_TIMEOUT' : (causeCode || 'HOST_UNREACHABLE'),
        diagnosis,
        rawError: err.message
      };
    }
  }

  _buildOfflineAlert({ hostAid, httpsEndpoint, diagnosis, fallbackMail }) {
    const hostMem = this.memory.ensureHost(hostAid);
    const lastSeen = hostMem.lastSeenOnlineAt || '从未在线';
    const alertText =
      `⚠️ [耳机信号提示: 对方电脑关机或无法连接 (HOST_OFFLINE_ALERT)]\n` +
      `   • 目标 Host AID : ${hostAid}\n` +
      `   • 访问 HTTPS 地址: ${httpsEndpoint || '未找到地址'}\n` +
      `   • 失联诊断原因   : ${diagnosis}\n` +
      `   • 最后在线时间   : ${lastSeen}\n` +
      `   • 自动兜底处理   : 消息未丢失！已存入本机待发队列 (pendingOutbox) 并写入离线记录 (MailID: ${fallbackMail.mailId})。待对方重新上线后，本机再次通信或运行 flush-outbox 时将自动通过 HTTPS 跨机补发！`;

    return {
      alertCode: 'HOST_OFFLINE_OR_UNREACHABLE',
      hostAid,
      httpsEndpoint,
      lastSeenOnlineAt: lastSeen,
      diagnosis,
      fallbackAction: 'DELIVERED_TO_MAILBOX_AND_LOCAL_OUTBOX',
      mailboxId: fallbackMail.mailId,
      alertMessage: alertText
    };
  }

  /**
   * Inspect incoming Host messages (from SendMessage response or GetTask) for Counter-Questions / Proposals
   * and run the 3-Tier Anti-Fooling Guard!
   */
  _inspectCounterQuestions(hostAid, taskId, messages = []) {
    if (!taskId || taskId === 'session') return null;
    const hostMsgs = messages.filter(
      (m) => m && m.role === 'host' && (m.messageType === 'counter_question' || m.messageType === 'proposal' || m.proposal)
    );
    if (hostMsgs.length === 0) return null;

    const latest = hostMsgs[hostMsgs.length - 1];
    const guardEvaluation = this.memory.evaluateHostProposalOrCounterQuestion(taskId, {
      text: latest.text,
      proposal: latest.proposal
    });

    if (guardEvaluation.requiresHumanOwnerConfirm) {
      const host = this.memory.ensureHost(hostAid);
      if (host.tasks[taskId]) {
        host.tasks[taskId].status = 'paused_for_owner_confirm';
        host.tasks[taskId].pendingHumanConfirmation = guardEvaluation;
        this.memory.save();
      }
    }

    return guardEvaluation;
  }

  /**
   * Method 1: SendMessage
   */
  async sendMessage({
    hostAid,
    mode = 'session',
    taskId = null,
    topic = null,
    text,
    messageType = 'chat',
    waitReplyMs = 0,
    autoReplyText = null
  }) {
    const msgId = `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
    const resolved = await this.resolveEndpointAsync(hostAid);

    if (!resolved.httpsEndpoint) {
      const mail = deliverToMailbox({
        toAid: hostAid,
        fromAid: this.clientAid,
        type: 'OFFLINE_MESSAGE',
        httpsEndpoint: this.clientEndpoint,
        payload: { msgId, mode, taskId, topic, text }
      });
      this.memory.queueOfflineMessage(hostAid, { msgId, mode, taskId, topic, text, mailId: mail.mailId });
      const alert = this._buildOfflineAlert({
        hostAid,
        httpsEndpoint: null,
        diagnosis: `在链上 AID 注册表与收件箱中均未找到 ${hostAid} 的活跃 HTTPS 端口`,
        fallbackMail: mail
      });
      console.warn('\n' + alert.alertMessage + '\n');
      return {
        ok: false,
        status: 'offline_queued_to_mailbox',
        offlineAlert: alert
      };
    }

    const rpcTimeout = waitReplyMs > 0 ? this.timeoutMs + waitReplyMs : this.timeoutMs;
    const callRes = await this._callHostRpc(
      hostAid,
      resolved.httpsEndpoint,
      'SendMessage',
      {
        fromAid: this.clientAid,
        fromEndpoint: this.clientEndpoint,
        mode,
        taskId,
        topic,
        text,
        messageType,
        msgId,
        waitReplyMs,
        autoReplyText
      },
      rpcTimeout
    );

    if (!callRes.ok) {
      // Check if Host updated its temporary HTTPS tunnel endpoint on the remote Vercel Private Chain or local registry!
      const refreshed = await this.resolveEndpointAsync(hostAid, { forceRefresh: true, strategy: 'auto' });
      if (refreshed.httpsEndpoint && refreshed.httpsEndpoint !== resolved.httpsEndpoint) {
        const retryRes = await this._callHostRpc(
          hostAid,
          refreshed.httpsEndpoint,
          'SendMessage',
          {
            fromAid: this.clientAid,
            fromEndpoint: this.clientEndpoint,
            mode,
            taskId,
            topic,
            text,
            messageType,
            msgId,
            waitReplyMs,
            autoReplyText
          },
          rpcTimeout
        );
        if (retryRes.ok && retryRes.rpc?.result) {
          return this._processSendMessageSuccess(hostAid, retryRes.rpc.result);
        }
      }

      const mail = deliverToMailbox({
        toAid: hostAid,
        fromAid: this.clientAid,
        type: 'OFFLINE_MESSAGE',
        httpsEndpoint: this.clientEndpoint,
        payload: { msgId, mode, taskId, topic, text }
      });
      this.memory.queueOfflineMessage(hostAid, { msgId, mode, taskId, topic, text, mailId: mail.mailId });
      const alert = this._buildOfflineAlert({
        hostAid,
        httpsEndpoint: resolved.httpsEndpoint,
        diagnosis: callRes.diagnosis,
        fallbackMail: mail
      });
      console.warn('\n' + alert.alertMessage + '\n');
      return {
        ok: false,
        status: 'offline_queued_to_mailbox',
        offlineAlert: alert
      };
    }

    if (callRes.rpc.error) {
      return { ok: false, error: callRes.rpc.error };
    }

    const processed = this._processSendMessageSuccess(hostAid, callRes.rpc.result);
    // Cross-machine offline recovery: if any earlier messages were queued in pendingOutbox while Host was off, flush them now!
    const hostMem = this.memory.ensureHost(hostAid);
    if (hostMem.pendingOutbox.length > 0) {
      processed.flushedOfflineOutbox = await this.flushPendingOutbox(hostAid);
    }
    return processed;
  }

  /**
   * Cross-Machine Offline Outbox Flush (`flushPendingOutbox`):
   * Re-sends messages queued in local `pendingOutbox` over real HTTPS to Host's `/a2a` endpoint
   * once Host comes back online (deduplicated safely on Host side by original `msgId`).
   */
  async flushPendingOutbox(hostAid) {
    const hostMem = this.memory.ensureHost(hostAid);
    if (!hostMem.pendingOutbox || hostMem.pendingOutbox.length === 0) {
      return { ok: true, flushedCount: 0, remainingCount: 0, delivered: [] };
    }

    let resolved = await this.resolveEndpointAsync(hostAid);
    if (!resolved.httpsEndpoint) {
      resolved = await this.resolveEndpointAsync(hostAid, { forceRefresh: true });
    }
    if (!resolved.httpsEndpoint) {
      return {
        ok: false,
        flushedCount: 0,
        remainingCount: hostMem.pendingOutbox.length,
        error: `Unable to resolve HTTPS endpoint for Host ${hostAid}`
      };
    }

    const deliveredIds = [];
    const deliveredResults = [];
    const snapshot = [...hostMem.pendingOutbox];

    for (const item of snapshot) {
      let callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'SendMessage', {
        fromAid: this.clientAid,
        fromEndpoint: this.clientEndpoint,
        mode: item.mode || 'session',
        taskId: item.taskId === 'session' ? null : item.taskId,
        topic: item.topic || null,
        text: item.text,
        msgId: item.msgId
      });

      if (!callRes.ok) {
        const refreshed = await this.resolveEndpointAsync(hostAid, { forceRefresh: true });
        if (refreshed.httpsEndpoint && refreshed.httpsEndpoint !== resolved.httpsEndpoint) {
          resolved = refreshed;
          callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'SendMessage', {
            fromAid: this.clientAid,
            fromEndpoint: this.clientEndpoint,
            mode: item.mode || 'session',
            taskId: item.taskId === 'session' ? null : item.taskId,
            topic: item.topic || null,
            text: item.text,
            msgId: item.msgId
          });
        }
      }

      if (callRes.ok && callRes.rpc && !callRes.rpc.error) {
        deliveredIds.push(item.msgId);
        this._processSendMessageSuccess(hostAid, callRes.rpc.result);
        deliveredResults.push({
          msgId: item.msgId,
          mode: item.mode,
          taskId: item.taskId,
          text: item.text
        });
      } else {
        // Stop early if Host went offline again
        break;
      }
    }

    const flushedCount = this.memory.markPendingOutboxDelivered(hostAid, deliveredIds);
    return {
      ok: flushedCount === snapshot.length,
      flushedCount,
      remainingCount: this.memory.ensureHost(hostAid).pendingOutbox.length,
      delivered: deliveredResults
    };
  }

  _processSendMessageSuccess(hostAid, result) {
    const messagesToSync = [];
    if (result.clientMessage) messagesToSync.push(result.clientMessage);
    if (Array.isArray(result.unreadFromHost)) messagesToSync.push(...result.unreadFromHost);
    if (result.hostReply) messagesToSync.push(result.hostReply);

    this.memory.syncMessages(hostAid, {
      mode: result.mode,
      taskId: result.taskId,
      topic: result.topic,
      status: result.status,
      messages: messagesToSync
    });

    const guardEvaluation = this._inspectCounterQuestions(hostAid, result.taskId, messagesToSync);

    return {
      ok: true,
      ...result,
      counterQuestionGuard: guardEvaluation
    };
  }

  /**
   * Method 2: GetTask (Sandboxed per taskId + Counter-Question Anti-Fooling Inspection)
   */
  async getTask({ hostAid, mode = 'task', taskId = null, sinceSeq = 0, markRead = true }) {
    const notices = checkClientMailbox(this.clientAid, { unreadOnly: true, markAsRead: true });
    for (const n of notices) {
      if (n.fromAid === hostAid && n.httpsEndpoint) {
        this.memory.recordDiscovery(hostAid, { httpsEndpoint: n.httpsEndpoint, source: 'mailbox_notice' });
      }
      if (n.fromAid === hostAid && n.type === 'HOST_REPLY_NOTICE' && n.payload?.text) {
        this.memory.syncMessages(hostAid, {
          mode: n.payload.mode || 'session',
          taskId: n.payload.taskId || 'session',
          messages: [
            {
              seq: n.payload.seq,
              msgId: n.payload.msgId,
              senderAid: hostAid,
              role: 'host',
              mode: n.payload.mode || 'session',
              taskId: n.payload.taskId || 'session',
              messageType: n.payload.messageType || 'chat',
              proposal: n.payload.proposal || null,
              text: n.payload.text,
              timestamp: n.createdAt
            }
          ]
        });
      } else if (n.fromAid === hostAid && n.type === 'TASK_CLOSED_NOTICE' && n.payload?.taskId) {
        this.memory.recordTaskConclusion(hostAid, {
          taskId: n.payload.taskId,
          status: n.payload.status,
          summary: n.payload.summary,
          memoryNote: n.payload.memoryNoteSaved,
          peerRollingProfile: n.payload.peerRollingProfile
        });
      }
    }

    const resolved = await this.resolveEndpointAsync(hostAid);
    if (!resolved.httpsEndpoint) {
      return {
        ok: false,
        hostOffline: true,
        localMemoryFallback: this.memory.getHostMemorySummary(hostAid)
      };
    }

    const callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'GetTask', {
      fromAid: this.clientAid,
      mode,
      taskId,
      sinceSeq,
      markRead
    });

    if (!callRes.ok) {
      console.warn(
        `⚠️ [耳机信号提示] 拉取对话时无法连接 Host (${hostAid} @ ${resolved.httpsEndpoint}): ${callRes.diagnosis}。已自动切换为展示本地持久化对话记忆。`
      );
      return {
        ok: false,
        hostOffline: true,
        diagnosis: callRes.diagnosis,
        localMemoryFallback: this.memory.getHostMemorySummary(hostAid)
      };
    }

    if (callRes.rpc.error) {
      return { ok: false, error: callRes.rpc.error };
    }

    const res = callRes.rpc.result;
    this.memory.syncMessages(hostAid, {
      mode: res.mode,
      taskId: res.taskId,
      topic: res.topic,
      status: res.status,
      archived: res.archived,
      messages: res.messages || []
    });

    const guardEvaluation = this._inspectCounterQuestions(hostAid, res.taskId, res.messages || []);

    let flushedOfflineOutbox = null;
    const hostMem = this.memory.ensureHost(hostAid);
    if (hostMem.pendingOutbox.length > 0) {
      flushedOfflineOutbox = await this.flushPendingOutbox(hostAid);
    }

    return {
      ok: true,
      ...res,
      counterQuestionGuard: guardEvaluation,
      flushedOfflineOutbox
    };
  }

  /**
   * Method 3: ListTasks
   */
  async listTasks({ hostAid, mode = 'all', status = null }) {
    const resolved = await this.resolveEndpointAsync(hostAid);
    if (!resolved.httpsEndpoint) {
      return {
        ok: false,
        hostOffline: true,
        localMemoryFallback: this.memory.getHostMemorySummary(hostAid)
      };
    }

    const callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'ListTasks', {
      fromAid: this.clientAid,
      mode,
      status
    });

    if (!callRes.ok) {
      return {
        ok: false,
        hostOffline: true,
        diagnosis: callRes.diagnosis,
        localMemoryFallback: this.memory.getHostMemorySummary(hostAid)
      };
    }

    if (callRes.rpc.error) {
      return { ok: false, error: callRes.rpc.error };
    }

    return {
      ok: true,
      ...callRes.rpc.result
    };
  }

  /**
   * Method 4: CancelTask (Dual-Side Idempotent Task Closure & Memory Distillation)
   */
  async cancelTask({
    hostAid,
    taskId,
    outcome = 'completed',
    reason = '',
    summary = '',
    tags = [],
    factsAndCommitments = [],
    peerEvaluation = ''
  }) {
    const resolved = await this.resolveEndpointAsync(hostAid);
    if (!resolved.httpsEndpoint) {
      return { ok: false, error: `No HTTPS endpoint found for Host ${hostAid}` };
    }

    const callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'CancelTask', {
      fromAid: this.clientAid,
      taskId,
      initiatedBy: 'client',
      outcome,
      reason,
      summary,
      tags,
      factsAndCommitments,
      peerEvaluation
    });

    if (!callRes.ok) {
      return {
        ok: false,
        hostOffline: true,
        diagnosis: callRes.diagnosis
      };
    }

    if (callRes.rpc.error) {
      return { ok: false, error: callRes.rpc.error };
    }

    const res = callRes.rpc.result;
    this.memory.recordTaskConclusion(hostAid, {
      taskId: res.taskId,
      status: res.status,
      summary: res.summary,
      memoryNote: res.memoryNoteSaved,
      peerRollingProfile: res.peerRollingProfile
    });

    return {
      ok: true,
      ...res
    };
  }

  /**
   * Method 5 (Extension): RecallArchivedTask
   * Explicitly recalls a closed task's raw chat transcript from cold archive by `taskId` with an audit reason.
   */
  async recallArchivedTask({ hostAid, taskId, reason = '核对历史任务承诺条款' }) {
    const resolved = await this.resolveEndpointAsync(hostAid);
    if (!resolved.httpsEndpoint) {
      return { ok: false, error: `No HTTPS endpoint found for Host ${hostAid}` };
    }

    const callRes = await this._callHostRpc(hostAid, resolved.httpsEndpoint, 'RecallArchivedTask', {
      fromAid: this.clientAid,
      taskId,
      reason
    });

    if (!callRes.ok) {
      return { ok: false, hostOffline: true, diagnosis: callRes.diagnosis };
    }
    if (callRes.rpc.error) {
      return { ok: false, error: callRes.rpc.error };
    }
    return {
      ok: true,
      ...callRes.rpc.result
    };
  }
}

module.exports = {
  A2AHeadsetClient
};
