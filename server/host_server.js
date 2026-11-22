/**
 * A2A v1 Core Architecture - Host Headset Server (server/host_server.js)
 *
 * Implements:
 *   1. On-Chain AID Registration with Capability Tags (Clues for Stranger Discovery) & Long-Term Fixed HTTPS Endpoint
 *   2. 4 Redefined A2A Philosophy Methods + Audited Recall:
 *      - SendMessage        (Supports mode="session" & mode="task", counter-questions, and proposals)
 *      - GetTask            (Physically sandboxed per taskId, Top-K distilled notes funnel, sinceSeq cursor)
 *      - ListTasks          (Chat sidebar listing continuous session + task threads)
 *      - CancelTask         (100% Idempotent dual-side task closure + memory distillation + cold archive)
 *      - RecallArchivedTask (Audited on-demand recall of a closed task's raw transcript by sourceTaskId)
 *   3. Host Control Endpoints:
 *      - POST /host/reply       (Supports normal replies AND counter-questions / proposals within the same taskId!)
 *      - POST /host/cancel-task (Allows Host to initiate CancelTask idempotently alongside Client)
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const {
  registerAIDOnChain,
  resolveAIDFromChain,
  searchAIDsOnChain,
  sendToMailbox,
  checkMailbox
} = require('./discovery_store');
const { HostMemoryStore } = require('./memory_store');

const LOCAL_CHAIN_LEDGER_FILE = path.resolve(__dirname, 'data', 'chain_ledger.json');

const IDENTITY_FILE = path.resolve(__dirname, 'data', 'host_identity.json');
function loadHostIdentity() {
  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      return JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
    }
  } catch {
    // ignore
  }
  return {};
}
const savedIdentity = loadHostIdentity();

const HOST_AID = process.env.HOST_AID || savedIdentity.aid || 'unregistered-host';
const HOST_NAME = process.env.HOST_NAME || savedIdentity.name || 'Personal-Host-Headset';
const HOST_TAGS = process.env.HOST_TAGS
  ? process.env.HOST_TAGS.split(',').map((s) => s.trim())
  : (savedIdentity.tags || []);
const HOST_DESC = process.env.HOST_DESC || savedIdentity.description || '个人Agent宿主节点';
const PORT = Number(process.env.PORT || 3100);
let activePublicEndpoint = (process.env.PUBLIC_HTTPS_URL || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const AUTO_REPLY_ENABLED = process.env.AUTO_REPLY_ENABLED === 'true';

const memoryStore = new HostMemoryStore(HOST_AID);

// Pending long-poll waiters when Client passes waitReplyMs > 0 in SendMessage
const replyWaiters = new Map();

function getWaiterKey(peerAid, mode, taskId) {
  return `${peerAid}:${mode}:${mode === 'session' ? 'session' : taskId}`;
}

function notifyReplyWaiters(peerAid, mode, taskId, replyMessage) {
  const key = getWaiterKey(peerAid, mode, taskId);
  const waiters = replyWaiters.get(key);
  if (waiters && waiters.length > 0) {
    replyWaiters.delete(key);
    for (const resolve of waiters) {
      resolve(replyMessage);
    }
  }
}

function waitForHostReply(peerAid, mode, taskId, timeoutMs) {
  if (!timeoutMs || timeoutMs <= 0) return Promise.resolve(null);
  const key = getWaiterKey(peerAid, mode, taskId);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const list = replyWaiters.get(key) || [];
      const idx = list.indexOf(onReply);
      if (idx !== -1) list.splice(idx, 1);
      resolve(null);
    }, timeoutMs);

    function onReply(msg) {
      clearTimeout(timer);
      resolve(msg);
    }

    if (!replyWaiters.has(key)) {
      replyWaiters.set(key, []);
    }
    replyWaiters.get(key).push(onReply);
  });
}

/**
 * Sync any offline messages or endpoint cards dropped into Host's Mailbox while Host PC was powered off
 */
function syncHostMailboxOnBoot() {
  const unreadMails = checkMailbox(HOST_AID, { unreadOnly: true, markAsRead: true });
  const syncedOfflineMessages = [];
  const receivedEndpointCards = [];

  for (const mail of unreadMails) {
    if (mail.type === 'OFFLINE_MESSAGE' && mail.payload && mail.payload.text) {
      const { mode = 'session', taskId = null, topic = null, text, msgId = null } = mail.payload;
      const recorded = memoryStore.appendMessage({
        peerAid: mail.fromAid,
        peerEndpoint: mail.httpsEndpoint || null,
        senderAid: mail.fromAid,
        role: 'client',
        mode,
        taskId,
        topic,
        text,
        msgId,
        viaOfflineMailbox: true
      });
      syncedOfflineMessages.push({
        mailId: mail.mailId,
        fromAid: mail.fromAid,
        mode,
        taskId: recorded.thread.taskId || 'session',
        text,
        createdAt: mail.createdAt
      });
    } else if (mail.type === 'ENDPOINT_DELIVERY') {
      memoryStore._ensurePeer(mail.fromAid, mail.httpsEndpoint);
      memoryStore.save();
      receivedEndpointCards.push({
        mailId: mail.mailId,
        fromAid: mail.fromAid,
        httpsEndpoint: mail.httpsEndpoint,
        note: mail.payload?.note || '',
        createdAt: mail.createdAt
      });
    }
  }

  if (syncedOfflineMessages.length > 0 || receivedEndpointCards.length > 0) {
    console.log('\n================================================================');
    console.log(`📬 [耳机开机收件箱提醒] 检测到关机/离线期间收到的 ${unreadMails.length} 封信件：`);
    for (const m of syncedOfflineMessages) {
      console.log(`   - [离线聊天留言] 来自 ${m.fromAid} (${m.mode}/${m.taskId}): "${m.text}" (已自动按 taskId 载入本地记忆)`);
    }
    for (const c of receivedEndpointCards) {
      console.log(`   - [对端地址名片] 来自 ${c.fromAid} 的最新 HTTPS 地址: ${c.httpsEndpoint}`);
    }
    console.log('================================================================\n');
  }

  return { syncedOfflineMessages, receivedEndpointCards };
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON payload'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(body);
}

/**
 * Handle A2A JSON-RPC 2.0 Methods on POST /a2a
 */
async function handleA2ARpc(body) {
  const { jsonrpc = '2.0', id = null, method, params = {} } = body;

  if (!method) {
    return {
      jsonrpc,
      id,
      error: { code: -32600, message: 'Missing method name in A2A request' }
    };
  }

  // ---------------------------------------------------------------------------
  // Method 1: SendMessage (Supports "session" & "task", counter-questions, and cross-reboot continuity)
  // ---------------------------------------------------------------------------
  if (method === 'SendMessage') {
    const {
      fromAid,
      fromEndpoint = null,
      mode = 'session', // 'session' | 'task'
      taskId = null,
      topic = null,
      text,
      messageType = 'chat',
      msgId = null,
      waitReplyMs = 0,
      autoReplyText = null
    } = params;

    if (!fromAid || !text) {
      return {
        jsonrpc,
        id,
        error: { code: -32602, message: 'SendMessage requires fromAid and text' }
      };
    }

    if (mode !== 'session' && mode !== 'task') {
      return {
        jsonrpc,
        id,
        error: { code: -32602, message: 'mode must be either "session" or "task"' }
      };
    }

    // 1. Append Client's message to persistent memory under (fromAid, taskId)
    const recorded = memoryStore.appendMessage({
      peerAid: fromAid,
      peerEndpoint: fromEndpoint,
      senderAid: fromAid,
      role: 'client',
      mode,
      taskId,
      topic,
      text,
      messageType,
      msgId
    });

    const activeTaskId = mode === 'task' ? recorded.thread.taskId : 'session';

    // 2. Piggyback any prior Host messages (including counter-questions!) in this thread not yet read by Client
    const unreadFromHost = recorded.thread.messages.filter(
      (m) => m.role === 'host' && !m.readByClient
    );
    for (const m of unreadFromHost) {
      m.readByClient = true;
    }
    if (unreadFromHost.length > 0) {
      memoryStore.save();
    }

    // 3. Check if Host has auto-reply or immediate reply waiter
    let hostReply = null;
    if (AUTO_REPLY_ENABLED || autoReplyText) {
      const replyContent =
        autoReplyText ||
        `[${HOST_NAME} 耳机自动应答] 已收到你在${mode === 'session' ? '连续会话' : `任务(${activeTaskId})`}中的第 ${recorded.message.seq} 条消息：“${text}”`;
      const replyRecorded = memoryStore.appendMessage({
        peerAid: fromAid,
        senderAid: HOST_AID,
        role: 'host',
        mode,
        taskId: activeTaskId,
        text: replyContent
      });
      replyRecorded.message.readByClient = true;
      memoryStore.save();
      hostReply = replyRecorded.message;
    } else if (waitReplyMs > 0) {
      const waitedMsg = await waitForHostReply(fromAid, mode, activeTaskId, Math.min(waitReplyMs, 25000));
      if (waitedMsg) {
        waitedMsg.readByClient = true;
        memoryStore.save();
        hostReply = waitedMsg;
      }
    }

    return {
      jsonrpc,
      id,
      result: {
        protocol: 'A2A-TrueChat/1.0',
        hostAid: HOST_AID,
        peerAid: fromAid,
        mode,
        conversationId: recorded.thread.sessionId || recorded.thread.taskId,
        taskId: activeTaskId,
        topic: recorded.thread.topic || `连续会话 (${fromAid} ⇄ ${HOST_AID})`,
        status: hostReply
          ? (hostReply.messageType === 'counter_question' || hostReply.messageType === 'proposal'
              ? 'counter_question_from_host'
              : 'replied')
          : 'delivered_waiting_host',
        turnCount: recorded.thread.turnCount,
        clientMessage: recorded.message,
        hostReply,
        unreadFromHost,
        memoryContext: memoryStore.buildMemoryContext(fromAid, {
          currentTaskId: mode === 'task' ? activeTaskId : null,
          queryText: `${topic || ''} ${text}`
        })
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Method 2: GetTask (Sandboxed per taskId + Top-K Distilled Notes Funnel)
  // ---------------------------------------------------------------------------
  if (method === 'GetTask') {
    const {
      fromAid,
      mode = 'task',
      taskId = null,
      sinceSeq = 0,
      markRead = true,
      includeArchivedTranscript = false
    } = params;

    if (!fromAid) {
      return {
        jsonrpc,
        id,
        error: { code: -32602, message: 'GetTask requires fromAid' }
      };
    }

    const effectiveMode = taskId === 'session' || mode === 'session' ? 'session' : 'task';
    const conv = memoryStore.getConversation({
      peerAid: fromAid,
      mode: effectiveMode,
      taskId,
      sinceSeq: Number(sinceSeq || 0),
      markReadByClient: Boolean(markRead),
      includeArchivedTranscript: Boolean(includeArchivedTranscript)
    });

    if (!conv) {
      return {
        jsonrpc,
        id,
        error: { code: -32004, message: `Conversation/Task not found: ${taskId || effectiveMode}` }
      };
    }

    return {
      jsonrpc,
      id,
      result: {
        protocol: 'A2A-TrueChat/1.0',
        hostStatus: 'online',
        ...conv
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Method 3: ListTasks (Chat sidebar listing continuous session + task threads)
  // ---------------------------------------------------------------------------
  if (method === 'ListTasks') {
    const { fromAid = null, mode = 'all', status = null } = params;
    const conversations = memoryStore.listConversations({
      peerAid: fromAid,
      mode,
      status
    });

    return {
      jsonrpc,
      id,
      result: {
        protocol: 'A2A-TrueChat/1.0',
        hostAid: HOST_AID,
        totalCount: conversations.length,
        conversations
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Method 4: CancelTask (Idempotent Dual-Side Task Closure + Distilled Archive)
  // ---------------------------------------------------------------------------
  if (method === 'CancelTask') {
    const {
      fromAid,
      taskId,
      initiatedBy = 'client',
      outcome = 'completed', // 'completed' | 'cancelled' | 'paused'
      reason = '',
      summary = '',
      tags = [],
      factsAndCommitments = [],
      peerEvaluation = ''
    } = params;

    if (!fromAid || !taskId) {
      return {
        jsonrpc,
        id,
        error: { code: -32602, message: 'CancelTask requires fromAid and taskId' }
      };
    }

    const closed = memoryStore.closeTask({
      peerAid: fromAid,
      taskId,
      initiatedBy,
      outcome,
      reason,
      summary,
      tags,
      factsAndCommitments,
      peerEvaluation
    });

    if (!closed) {
      return {
        jsonrpc,
        id,
        error: { code: -32004, message: `Task not found: ${taskId}` }
      };
    }

    return {
      jsonrpc,
      id,
      result: {
        protocol: 'A2A-TrueChat/1.0',
        hostAid: HOST_AID,
        peerAid: fromAid,
        ...closed
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Method 5 (Extension): RecallArchivedTask (Audited on-demand recall of closed task transcript)
  // ---------------------------------------------------------------------------
  if (method === 'RecallArchivedTask') {
    const { fromAid, taskId, reason = '核对历史任务详情' } = params;
    if (!fromAid || !taskId) {
      return {
        jsonrpc,
        id,
        error: { code: -32602, message: 'RecallArchivedTask requires fromAid and taskId' }
      };
    }
    const recalled = memoryStore.recallArchivedTask({
      peerAid: fromAid,
      taskId,
      callerAid: fromAid,
      reason
    });
    if (!recalled) {
      return {
        jsonrpc,
        id,
        error: { code: -32004, message: `Archived task not found: ${taskId}` }
      };
    }
    return {
      jsonrpc,
      id,
      result: {
        protocol: 'A2A-TrueChat/1.0',
        hostAid: HOST_AID,
        ...recalled
      }
    };
  }

  return {
    jsonrpc,
    id,
    error: { code: -32601, message: `Unsupported method: ${method}` }
  };
}

function createHostServer() {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      });
      return res.end();
    }

    try {
      // 1. Public Headset Info & Presence Probe (Also accessible at root GET / for direct browser visits)
      if (
        req.method === 'GET' &&
        (url.pathname === '/' || url.pathname === '/a2a/info' || url.pathname === '/.well-known/agent.json')
      ) {
        return sendJson(res, 200, {
          protocol: 'A2A-TrueChat/1.0',
          role: 'host',
          aid: HOST_AID,
          name: HOST_NAME,
          tags: HOST_TAGS,
          description: HOST_DESC,
          status: 'online',
          httpsEndpoint: activePublicEndpoint,
          mailboxAddress: null,
          supportedModes: ['session', 'task'],
          methods: ['SendMessage', 'GetTask', 'ListTasks', 'CancelTask', 'RecallArchivedTask'],
          timestamp: new Date().toISOString()
        });
      }

      // 2. Main A2A TrueChat JSON-RPC 2.0 Endpoint
      if (req.method === 'POST' && url.pathname === '/a2a') {
        const body = await readJsonBody(req);
        const rpcResponse = await handleA2ARpc(body);
        return sendJson(res, 200, rpcResponse);
      }

      // 3. Direct Mailbox Delivery Endpoint
      if (req.method === 'POST' && url.pathname === '/a2a/mailbox') {
        const body = await readJsonBody(req);
        const mailItem = sendToMailbox({
          toAid: HOST_AID,
          fromAid: body.fromAid,
          type: body.type || 'ENDPOINT_DELIVERY',
          httpsEndpoint: body.httpsEndpoint || null,
          payload: body.payload || {}
        });
        const synced = syncHostMailboxOnBoot();
        return sendJson(res, 200, { ok: true, mailItem, synced });
      }

      // 4. Local Host Agent Control API: View Unread Inbox & Conversations
      if (req.method === 'GET' && url.pathname === '/host/inbox') {
        syncHostMailboxOnBoot();
        const unreadMessages = memoryStore.getUnreadForHost();
        const conversations = memoryStore.listConversations();
        return sendJson(res, 200, {
          ok: true,
          hostAid: HOST_AID,
          httpsEndpoint: activePublicEndpoint,
          unreadCount: unreadMessages.length,
          unreadMessages,
          conversations
        });
      }

      // 5. Local Host Agent Control API: Host Agent Speaks / Counter-Questions / Proposes within Same taskId
      if (req.method === 'POST' && url.pathname === '/host/reply') {
        const body = await readJsonBody(req);
        const {
          toAid,
          mode = 'session',
          taskId = null,
          topic = null,
          text,
          messageType = 'chat', // 'chat' | 'counter_question' | 'proposal'
          proposal = null,      // e.g. { price: 8500, provider: '某廉航', requiresOwnerConfirm: true }
          deliverToMailboxIfOffline = true
        } = body;

        if (!toAid || !text) {
          return sendJson(res, 400, { ok: false, error: 'toAid and text are required' });
        }

        // Mark prior client messages in this thread as read by Host
        memoryStore.getConversation({
          peerAid: toAid,
          mode,
          taskId,
          markReadByHost: true
        });

        const recorded = memoryStore.appendMessage({
          peerAid: toAid,
          senderAid: HOST_AID,
          role: 'host',
          mode,
          taskId,
          topic,
          text,
          messageType,
          proposal
        });

        const effectiveTaskId = mode === 'task' ? recorded.thread.taskId : 'session';
        notifyReplyWaiters(toAid, mode, effectiveTaskId, recorded.message);

        let mailboxReceipt = null;
        if (deliverToMailboxIfOffline) {
          mailboxReceipt = sendToMailbox({
            toAid,
            fromAid: HOST_AID,
            type: 'HOST_REPLY_NOTICE',
            httpsEndpoint: activePublicEndpoint,
            payload: {
              mode,
              taskId: effectiveTaskId,
              msgId: recorded.message.msgId,
              seq: recorded.message.seq,
              messageType,
              proposal,
              text
            }
          });
        }

        return sendJson(res, 200, {
          ok: true,
          hostAid: HOST_AID,
          toAid,
          mode,
          taskId: effectiveTaskId,
          status: recorded.thread.status,
          message: recorded.message,
          turnCount: recorded.thread.turnCount,
          mailboxReceipt
        });
      }

      // 6. Local Host Agent Control API: Host-Initiated Idempotent CancelTask
      if (req.method === 'POST' && url.pathname === '/host/cancel-task') {
        const body = await readJsonBody(req);
        const {
          peerAid,
          taskId,
          outcome = 'completed',
          reason = '',
          summary = '',
          tags = [],
          factsAndCommitments = [],
          peerEvaluation = ''
        } = body;

        if (!peerAid || !taskId) {
          return sendJson(res, 400, { ok: false, error: 'peerAid and taskId are required' });
        }

        const closed = memoryStore.closeTask({
          peerAid,
          taskId,
          initiatedBy: 'host',
          outcome,
          reason,
          summary,
          tags,
          factsAndCommitments,
          peerEvaluation
        });

        if (!closed) {
          return sendJson(res, 404, { ok: false, error: `Task not found: ${taskId}` });
        }

        // Also notify Client's mailbox so Client can sync the closure
        sendToMailbox({
          toAid: peerAid,
          fromAid: HOST_AID,
          type: 'TASK_CLOSED_NOTICE',
          httpsEndpoint: activePublicEndpoint,
          payload: closed
        });

        return sendJson(res, 200, {
          ok: true,
          hostAid: HOST_AID,
          peerAid,
          ...closed
        });
      }

      // 7. Local Host Agent Control API: Inspect Sandboxed Memory or Recall Archived Task
      if (req.method === 'GET' && url.pathname === '/host/memory') {
        const peerAid = url.searchParams.get('peerAid');
        const currentTaskId = url.searchParams.get('taskId') || null;
        const queryText = url.searchParams.get('query') || '';
        if (peerAid) {
          return sendJson(res, 200, {
            ok: true,
            memory: memoryStore.buildMemoryContext(peerAid, {
              recentSessionTurns: 20,
              currentTaskId,
              queryText
            })
          });
        }
        return sendJson(res, 200, {
          ok: true,
          allPeers: Object.keys(memoryStore.state.peers),
          auditRecallLogs: memoryStore.state.auditRecallLogs
        });
      }

      // 8. Local Host Agent Control API: Publish/Refresh Fixed HTTPS Endpoint to On-Chain AID
      if (req.method === 'POST' && url.pathname === '/host/publish-endpoint') {
        const body = await readJsonBody(req);
        const newEndpoint = (body.httpsEndpoint || activePublicEndpoint).replace(/\/+$/, '');
        activePublicEndpoint = newEndpoint;
        const chainRecord = registerAIDOnChain({
          aid: HOST_AID,
          httpsEndpoint: newEndpoint,
          agentName: HOST_NAME,
          role: 'host',
          tags: body.tags || HOST_TAGS,
          description: body.description || HOST_DESC
        });

        let mailboxDelivery = null;
        if (body.toClientAid) {
          mailboxDelivery = sendToMailbox({
            toAid: body.toClientAid,
            fromAid: HOST_AID,
            type: 'ENDPOINT_DELIVERY',
            httpsEndpoint: newEndpoint,
            payload: {
              note: body.note || `Host ${HOST_AID} 已更新长期固定 HTTPS 访问地址`
            }
          });
        }

        return sendJson(res, 200, {
          ok: true,
          chainRecord,
          mailboxDelivery
        });
      }

      // 9. Method B Private Chain Hard-Drive Anchor Endpoints (Persists Vercel Private Chain ledger to local disk!)
      if (req.method === 'GET' && url.pathname === '/chain-anchor/ledger') {
        try {
          if (fs.existsSync(LOCAL_CHAIN_LEDGER_FILE)) {
            const ledger = JSON.parse(fs.readFileSync(LOCAL_CHAIN_LEDGER_FILE, 'utf-8'));
            return sendJson(res, 200, { ok: true, ledger });
          }
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: err.message });
        }
        return sendJson(res, 404, { ok: false, error: 'Local ledger file not found' });
      }

      if (req.method === 'POST' && url.pathname === '/chain-anchor/ledger') {
        const body = await readJsonBody(req);
        if (!body.ledger || !body.ledger.blocks || !body.ledger.stateRecords) {
          return sendJson(res, 400, { ok: false, error: 'Valid ledger object required' });
        }
        if (!fs.existsSync(path.dirname(LOCAL_CHAIN_LEDGER_FILE))) {
          fs.mkdirSync(path.dirname(LOCAL_CHAIN_LEDGER_FILE), { recursive: true });
        }
        fs.writeFileSync(LOCAL_CHAIN_LEDGER_FILE, JSON.stringify(body.ledger, null, 2), 'utf-8');
        console.log(
          `⛓️  [私链账本已同步落盘至本机硬盘] 区块高度: ${body.ledger.blockHeight} | 已注册 AID 数: ${Object.keys(body.ledger.stateRecords).length}`
        );
        return sendJson(res, 200, {
          ok: true,
          savedBlockHeight: body.ledger.blockHeight,
          totalRegisteredAIDs: Object.keys(body.ledger.stateRecords).length
        });
      }

      return sendJson(res, 404, { error: `Route not found: ${req.method} ${url.pathname}` });
    } catch (err) {
      return sendJson(res, 500, { error: err.message });
    }
  });

  return server;
}

function startHostServer(customPort = PORT, { customTags = null, customDescription = null } = {}) {
  const server = createHostServer();
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(customPort, '127.0.0.1', () => {
      const actualPort = server.address().port;
      const endpointUrl = process.env.PUBLIC_HTTPS_URL
        ? process.env.PUBLIC_HTTPS_URL.replace(/\/+$/, '')
        : `http://127.0.0.1:${actualPort}`;
      activePublicEndpoint = endpointUrl;

      // 1. Register Host's AID, capability tags (clues), and fixed HTTPS endpoint on-chain
      const chainRecord = registerAIDOnChain({
        aid: HOST_AID,
        httpsEndpoint: endpointUrl,
        agentName: HOST_NAME,
        role: 'host',
        tags: customTags || HOST_TAGS,
        description: customDescription || HOST_DESC
      });

      console.log(`🎧 [Host 耳机服务已启动] AID: ${HOST_AID} (${HOST_NAME})`);
      console.log(`🏷️  链上发现标签(线索): [${chainRecord.tags.join(', ')}]`);
      console.log(`🔗 长期固定 HTTPS 端点: ${endpointUrl} | 邮箱(Optional): ${chainRecord.mailboxAddress || '暂未设置(空)'}`);

      // 2. Check Mailbox for any offline messages received while PC was off
      syncHostMailboxOnBoot();

      resolve({ server, port: actualPort, endpointUrl, chainRecord });
    });
  });
}

if (require.main === module) {
  startHostServer().catch((err) => {
    console.error('❌ Host server failed to start:', err.message);
    process.exit(1);
  });
}

module.exports = {
  HOST_AID,
  HOST_NAME,
  HOST_TAGS,
  memoryStore,
  createHostServer,
  startHostServer,
  syncHostMailboxOnBoot
};
