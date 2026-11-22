/**
 * Client Conversation Memory Persistence & Three-Layer Protection Engine (client/memory_store.js)
 *
 * Implements the 3-Layer Memory Architecture agreed in Discussion:
 *   1. Layer 1: Owner Intent Cards (`ownerIntentCards[taskId]`) & Owner Long-Term Preferences (`ownerPreferences`)
 *      - Prevents the Client Agent from being tricked by a Host Agent when the owner forgot to state a boundary
 *        (e.g., forgot to state max budget or disliked airlines).
 *      - Automatically learns new preferences whenever the owner confirms an escalated counter-question!
 *   2. Layer 2: Physically Sandboxed Task Working Memory (`tasks[taskId]`)
 *      - Active tasks NEVER load raw chat transcripts from closed/archived tasks.
 *      - Persists locally by `(hostAid, taskId)` so multi-day conversations survive reboots and endpoint updates.
 *   3. Layer 3: Distilled Archive with Rolling Peer Profile (`peerRollingProfile`) & Top-K Tag Funnel (`selectRelevantNotes`)
 *      - Even with 10,000+ distilled notes, only the 1 concise Rolling Peer Profile + Top 3 relevant notes are loaded.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_CLIENT_MEMORY_FILE = process.env.CLIENT_MEMORY_FILE
  ? path.resolve(process.env.CLIENT_MEMORY_FILE)
  : path.resolve(__dirname, 'data', 'client_memory.json');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function extractKeywords(text = '') {
  const clean = String(text || '').trim();
  if (!clean) return [];
  const tokens = new Set();
  const alphaMatches = clean.match(/[a-zA-Z0-9_-]{2,}/g) || [];
  for (const m of alphaMatches) tokens.add(m.toLowerCase());

  const rawParts = clean
    .split(/[\s,，。！？；：、/\\|()（）[\]【】"“”'‘’+-]+/)
    .filter((w) => w.length >= 2);
  for (const part of rawParts) {
    tokens.add(part.toLowerCase());
    const cjkRuns = part.match(/[\u4e00-\u9fa5]{2,}/g) || [];
    for (const run of cjkRuns) {
      for (let i = 0; i <= run.length - 2; i++) {
        tokens.add(run.slice(i, i + 2));
      }
    }
  }
  return Array.from(tokens).slice(0, 40);
}

class ClientMemoryStore {
  constructor(clientAid, filePath = DEFAULT_CLIENT_MEMORY_FILE) {
    this.clientAid = clientAid;
    this.filePath = filePath;
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        if (raw.trim()) return JSON.parse(raw);
      }
    } catch {
      // Fallback
    }
    return {
      clientAid: this.clientAid,
      updatedAt: new Date().toISOString(),
      // Layer 1A: Owner's durable preferences learned across tasks (never shared blindly, used to guard decisions)
      ownerPreferences: {
        maxBudgetByCategory: {},    // e.g. { flight: 2500 }
        blacklistedProviders: [],   // e.g. ['某高价黑心航司', '某廉航']
        preferredProviders: [],     // e.g. ['东航', '国泰']
        customRules: []             // e.g. ['绝不坐红眼航班', '偏好靠窗座位']
      },
      // Layer 1B: Task-specific Owner Intent Cards (pinned at top of each taskId)
      ownerIntentCards: {},
      hosts: {}
    };
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    ensureDir(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  /**
   * Layer 1: Pin an Owner Intent Card for a taskId (may have unstated boundaries that require counter-question guard!)
   */
  setOwnerIntentCard(taskId, {
    goal,
    maxBudget = null,          // null if the human owner forgot to specify budget!
    allowedProviders = null,   // null if the human owner forgot to specify preferred airlines/vendors!
    forbiddenProviders = [],
    mustConfirmBeforeOrder = true,
    notes = ''
  }) {
    if (!this.state.ownerIntentCards) this.state.ownerIntentCards = {};
    this.state.ownerIntentCards[taskId] = {
      taskId,
      goal,
      maxBudget,
      allowedProviders,
      forbiddenProviders,
      mustConfirmBeforeOrder,
      notes,
      createdAt: new Date().toISOString()
    };
    this.save();
    return this.state.ownerIntentCards[taskId];
  }

  getOwnerIntentCard(taskId) {
    return (this.state.ownerIntentCards && this.state.ownerIntentCards[taskId]) || null;
  }

  /**
   * Layer 1: Update Owner Long-Term Preferences (e.g. after human owner answers an escalated counter-question)
   */
  updateOwnerPreferences({ category = 'default', maxBudget = null, addBlacklistedProvider = null, addPreferredProvider = null, addCustomRule = null }) {
    if (!this.state.ownerPreferences) {
      this.state.ownerPreferences = {
        maxBudgetByCategory: {},
        blacklistedProviders: [],
        preferredProviders: [],
        customRules: []
      };
    }
    const prefs = this.state.ownerPreferences;
    if (maxBudget !== null && maxBudget !== undefined) {
      prefs.maxBudgetByCategory[category] = Number(maxBudget);
    }
    if (addBlacklistedProvider && !prefs.blacklistedProviders.includes(addBlacklistedProvider)) {
      prefs.blacklistedProviders.push(addBlacklistedProvider);
    }
    if (addPreferredProvider && !prefs.preferredProviders.includes(addPreferredProvider)) {
      prefs.preferredProviders.push(addPreferredProvider);
    }
    if (addCustomRule && !prefs.customRules.includes(addCustomRule)) {
      prefs.customRules.push(addCustomRule);
    }
    this.save();
    return prefs;
  }

  /**
   * Evaluate a Host Counter-Question or Proposal against Layer 1 (Owner Intent Card + Owner Preferences)
   * Prevents the Client Agent from being tricked into ordering expensive or disliked options!
   */
  evaluateHostProposalOrCounterQuestion(taskId, { text = '', proposal = null }) {
    const card = this.getOwnerIntentCard(taskId);
    const prefs = this.state.ownerPreferences || {
      maxBudgetByCategory: {},
      blacklistedProviders: [],
      preferredProviders: [],
      customRules: []
    };

    const effectiveMaxBudget =
      (card && card.maxBudget !== null ? card.maxBudget : null) ??
      prefs.maxBudgetByCategory.flight ??
      prefs.maxBudgetByCategory.default ??
      null;

    const blacklisted = new Set([
      ...((card && card.forbiddenProviders) || []),
      ...(prefs.blacklistedProviders || [])
    ]);

    // If Host sent a concrete proposal (e.g. { price, provider, requiresOwnerConfirm })
    if (proposal) {
      const { price = null, provider = null, requiresOwnerConfirm = false } = proposal;

      // 1. Check against known blacklisted providers
      if (provider && blacklisted.has(provider)) {
        return {
          decision: 'AUTO_REJECT_KNOWN_BLACKLIST',
          requiresHumanOwnerConfirm: false,
          reason: `触发本地防忽悠拦截：服务商/航司 [${provider}] 位于主人的黑名单中，直接回绝！`
        };
      }

      // 2. Check against known max budget
      if (price !== null && effectiveMaxBudget !== null && Number(price) > Number(effectiveMaxBudget)) {
        return {
          decision: 'AUTO_REJECT_OVER_BUDGET',
          requiresHumanOwnerConfirm: false,
          reason: `触发本地防忽悠拦截：对方报价 (${price} 元) 超出主人预算上限 (${effectiveMaxBudget} 元)，直接回绝！`
        };
      }

      // 3. What if the owner FORGOT to write maxBudget or airline preference in the Intent Card?
      const isBudgetUnstated = price !== null && effectiveMaxBudget === null;
      const isProviderUnKnown =
        provider &&
        (!card || !card.allowedProviders) &&
        !(prefs.preferredProviders || []).includes(provider);

      if (isBudgetUnstated || isProviderUnKnown || requiresOwnerConfirm || (card && card.mustConfirmBeforeOrder)) {
        const missingItems = [];
        if (isBudgetUnstated) missingItems.push(`预算上限未在《初衷卡》中写明（对方当前报价: ${price} 元）`);
        if (isProviderUnKnown) missingItems.push(`航司/服务商偏好未写明（对方当前推荐: ${provider}）`);
        if (requiresOwnerConfirm) missingItems.push('涉及最终锁单/付款动作');

        return {
          decision: 'ESCALATE_TO_HUMAN_OWNER',
          requiresHumanOwnerConfirm: true,
          missingBoundaries: missingItems,
          proposal,
          promptForHumanOwner:
            `🛑 [耳机防忽悠拦截 —— 请示人类主人确认]\n` +
            `   • 任务 (${taskId}): ${card ? card.goal : taskId}\n` +
            `   • 对方反问/报价方案: "${text}" (报价: ${price ?? '未定'} 元, 提供方: ${provider ?? '未定'})\n` +
            `   • 需您拍板原因: ${missingItems.join('；')}\n` +
            `   👉 请确认是否接受该方案，或补充您的预算上限与航司黑名单！`
        };
      }

      return {
        decision: 'SAFE_WITHIN_KNOWN_BOUNDARIES',
        requiresHumanOwnerConfirm: false,
        reason: `方案 (${provider} / ${price}元) 符合主人已知预算(${effectiveMaxBudget}元)与偏好白名单`
      };
    }

    // Plain counter-question without concrete lock-in proposal yet -> Tier 2: Collect options or escalate if asking for unknown boundary
    return {
      decision: 'COUNTER_QUESTION_RECEIVED',
      requiresHumanOwnerConfirm: true,
      promptForHumanOwner: `🔔 [收到对方反问 (${taskId})]: "${text}" —— 若《初衷卡》未涵盖此条件，请向主人确认后再拍板。`
    };
  }

  ensureHost(hostAid) {
    if (!this.state.hosts[hostAid]) {
      const now = new Date().toISOString();
      this.state.hosts[hostAid] = {
        hostAid,
        httpsEndpoint: null,
        mailboxAddress: null,
        tags: [],
        discoverySource: null,
        lastSeenOnlineAt: null,
        lastOfflineAlertAt: null,
        peerRollingProfile: {
          peerAid: hostAid,
          totalTasksCount: 0,
          completedTasksCount: 0,
          cancelledTasksCount: 0,
          recentTopics: [],
          rollingSummaryText: `与 ${hostAid} 初次建立连接，尚无历史完结任务画像。`,
          updatedAt: now
        },
        continuousSession: {
          sessionId: `session:${this.clientAid}:${hostAid}`,
          mode: 'session',
          lastSyncedSeq: 0,
          messages: []
        },
        tasks: {},
        longTermNotes: [],
        pendingOutbox: []
      };
    }
    if (!this.state.hosts[hostAid].peerRollingProfile) {
      this.state.hosts[hostAid].peerRollingProfile = {
        peerAid: hostAid,
        totalTasksCount: 0,
        completedTasksCount: 0,
        cancelledTasksCount: 0,
        recentTopics: [],
        rollingSummaryText: `与 ${hostAid} 的滚动总画像`,
        updatedAt: new Date().toISOString()
      };
    }
    return this.state.hosts[hostAid];
  }

  recordDiscovery(hostAid, { httpsEndpoint, source, mailboxAddress = null, tags = [] }) {
    const host = this.ensureHost(hostAid);
    host.httpsEndpoint = httpsEndpoint ? httpsEndpoint.replace(/\/+$/, '') : null;
    host.discoverySource = source;
    if (mailboxAddress) host.mailboxAddress = mailboxAddress;
    if (Array.isArray(tags) && tags.length > 0) host.tags = tags;
    this.save();
    return host;
  }

  markHostOnline(hostAid, httpsEndpoint = null) {
    const host = this.ensureHost(hostAid);
    host.lastSeenOnlineAt = new Date().toISOString();
    if (httpsEndpoint) host.httpsEndpoint = httpsEndpoint.replace(/\/+$/, '');
    this.save();
  }

  markHostOffline(hostAid, reason) {
    const host = this.ensureHost(hostAid);
    host.lastOfflineAlertAt = new Date().toISOString();
    host.lastOfflineReason = reason;
    this.save();
  }

  /**
   * Merge messages into Client's persistent memory under `(hostAid, taskId)`.
   * Even if HTTPS endpoint changes across days or laptops reboot, `(hostAid, taskId)` keeps the exact thread!
   */
  syncMessages(hostAid, { mode = 'session', taskId = null, topic = null, status = 'active', archived = false, messages = [] }) {
    const host = this.ensureHost(hostAid);

    if (mode === 'session' || taskId === 'session') {
      const session = host.continuousSession;
      for (const msg of messages) {
        if (!msg) continue;
        const exists = session.messages.find(
          (m) => m.msgId === msg.msgId || (m.seq && m.seq === msg.seq && m.senderAid === msg.senderAid)
        );
        if (!exists) {
          session.messages.push(msg);
        }
        if (msg.seq && msg.seq > session.lastSyncedSeq) {
          session.lastSyncedSeq = msg.seq;
        }
      }
      this.save();
      return session;
    }

    // mode === 'task'
    if (!host.tasks[taskId]) {
      host.tasks[taskId] = {
        taskId,
        topic: topic || taskId,
        tags: extractKeywords(topic || taskId),
        mode: 'task',
        status,
        archived: Boolean(archived),
        lastSyncedSeq: 0,
        summary: null,
        pendingHumanConfirmation: null,
        messages: []
      };
    }

    const t = host.tasks[taskId];
    if (topic) {
      t.topic = topic;
      t.tags = extractKeywords(topic);
    }
    if (status) t.status = status;
    t.archived = Boolean(archived);

    for (const msg of messages) {
      if (!msg) continue;
      const exists = t.messages.find(
        (m) => m.msgId === msg.msgId || (m.seq && m.seq === msg.seq && m.senderAid === msg.senderAid)
      );
      if (!exists) {
        t.messages.push(msg);
      }
      if (msg.seq && msg.seq > t.lastSyncedSeq) {
        t.lastSyncedSeq = msg.seq;
      }
    }

    this.save();
    return t;
  }

  /**
   * Idempotent Task Conclusion & Distilled Memory Recording on Client Side
   */
  recordTaskConclusion(hostAid, { taskId, status, summary, memoryNote, peerRollingProfile = null }) {
    const host = this.ensureHost(hostAid);
    if (host.tasks[taskId]) {
      host.tasks[taskId].status = status;
      host.tasks[taskId].archived = status === 'completed' || status === 'cancelled';
      host.tasks[taskId].summary = summary;
    }
    if (memoryNote) {
      const existingIdx = host.longTermNotes.findIndex(
        (n) => n.sourceTaskId === taskId || n.noteId === memoryNote.noteId
      );
      if (existingIdx === -1) {
        host.longTermNotes.push(memoryNote);
      } else {
        host.longTermNotes[existingIdx] = memoryNote;
      }
    }
    if (peerRollingProfile) {
      host.peerRollingProfile = peerRollingProfile;
    }
    this.save();
  }

  /**
   * Top-K Distilled Notes Funnel on Client Side (prevents loading 10,000+ notes at once)
   */
  selectRelevantNotes(hostAid, { queryText = '', tags = [], topK = 3 } = {}) {
    const host = this.ensureHost(hostAid);
    const notes = host.longTermNotes || [];
    if (notes.length === 0) return [];

    const queryTokens = new Set([
      ...extractKeywords(queryText),
      ...(Array.isArray(tags) ? tags : [])
    ].map((t) => String(t).toLowerCase()));

    const scored = notes.map((note, idx) => {
      let score = 0;
      const noteText = `${note.topic || ''} ${note.summary || ''} ${(note.tags || []).join(' ')} ${(note.factsAndCommitments || []).join(' ')}`.toLowerCase();
      for (const token of queryTokens) {
        if (token && noteText.includes(token)) {
          score += 10;
        }
      }
      score += idx / Math.max(notes.length, 1);
      return { note, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.note);
  }

  /**
   * Build Sandboxed Task Context on Client Side:
   *   - Pins Layer 1 (`ownerIntentCard` + `ownerPreferences`) at the top!
   *   - Excludes all other tasks' raw messages (Physical Sandbox Isolation)!
   *   - Loads only the 1 `peerRollingProfile` + Top-3 relevant distilled notes!
   */
  buildSandboxedTaskContext(hostAid, { taskId = null, queryText = '', topKNotes = 3 } = {}) {
    const host = this.ensureHost(hostAid);
    const activeTask = taskId && host.tasks[taskId] ? host.tasks[taskId] : null;
    const intentCard = taskId ? this.getOwnerIntentCard(taskId) : null;
    const otherArchivedTasksCount = Object.values(host.tasks).filter(
      (t) => t.taskId !== taskId && t.archived
    ).length;

    const relevantNotes = this.selectRelevantNotes(hostAid, {
      queryText: queryText || (activeTask ? activeTask.topic : '') || (intentCard ? intentCard.goal : ''),
      tags: activeTask ? activeTask.tags : [],
      topK: topKNotes
    });

    return {
      clientAid: this.clientAid,
      hostAid,
      httpsEndpoint: host.httpsEndpoint,
      sandboxIsolationPolicy: 'STRICT_TASK_ISOLATION (Other closed tasks raw transcripts are hidden)',
      excludedArchivedTasksCount: otherArchivedTasksCount,
      // Layer 1: Owner Intent Anchor & Preferences
      layer1_ownerIntentCard: intentCard,
      layer1_ownerPreferences: this.state.ownerPreferences,
      // Layer 2: Only the active taskId's messages (empty if archived unless explicitly recalled)
      layer2_activeTaskWorkingMemory: activeTask
        ? {
            taskId: activeTask.taskId,
            topic: activeTask.topic,
            status: activeTask.status,
            archived: Boolean(activeTask.archived),
            pendingHumanConfirmation: activeTask.pendingHumanConfirmation || null,
            messages: activeTask.archived ? [] : activeTask.messages
          }
        : null,
      // Layer 3: Rolling Peer Profile + Top-3 Relevant Distilled Notes
      layer3_peerRollingProfile: host.peerRollingProfile,
      layer3_topRelevantDistilledNotes: relevantNotes,
      totalDistilledNotesOnDisk: host.longTermNotes.length
    };
  }

  queueOfflineMessage(hostAid, { msgId, mode, taskId, topic, text, mailId }) {
    const host = this.ensureHost(hostAid);
    const item = {
      msgId,
      mode,
      taskId: taskId || 'session',
      topic,
      text,
      mailId,
      queuedAt: new Date().toISOString(),
      status: 'delivered_to_offline_mailbox'
    };
    host.pendingOutbox.push(item);

    this.syncMessages(hostAid, {
      mode,
      taskId: taskId || 'session',
      topic,
      messages: [
        {
          seq: null,
          msgId,
          senderAid: this.clientAid,
          role: 'client',
          mode,
          taskId: taskId || 'session',
          text,
          timestamp: item.queuedAt,
          offlineQueued: true
        }
      ]
    });

    this.save();
    return item;
  }

  getHostMemorySummary(hostAid) {
    const host = this.ensureHost(hostAid);
    return {
      clientAid: this.clientAid,
      hostAid,
      httpsEndpoint: host.httpsEndpoint,
      discoverySource: host.discoverySource,
      lastSeenOnlineAt: host.lastSeenOnlineAt,
      ownerPreferences: this.state.ownerPreferences,
      peerRollingProfile: host.peerRollingProfile,
      continuousSessionTurns: host.continuousSession.messages.length,
      continuousSessionRecent: host.continuousSession.messages.slice(-10),
      taskCount: Object.keys(host.tasks).length,
      tasks: host.tasks,
      longTermNotesCount: host.longTermNotes.length,
      longTermNotesRecent: host.longTermNotes.slice(-5),
      pendingOutboxCount: host.pendingOutbox.length,
      pendingOutbox: host.pendingOutbox
    };
  }
}

module.exports = {
  ClientMemoryStore
};
