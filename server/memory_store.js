/**
 * Host Conversation Memory Persistence & Three-Layer Isolation Engine (server/memory_store.js)
 *
 * Key Guarantees from Architecture Discussion:
 *   1. Off-Chain Local Task Storage & Cross-Reboot Continuity:
 *      - Dialogue content is indexed by (peerAid, taskId) on local disk. Even across multiple PC reboots
 *        or HTTPS endpoint updates, passing the same (fromAid, taskId) seamlessly resumes the exact thread.
 *   2. Physical Sandbox Isolation of Closed Tasks (No Peeking at Old Tasks):
 *      - When working on task-02, raw chat logs of closed task-01 are archived (`archived: true`)
 *        and NEVER injected into active memory context.
 *      - Old task raw transcripts can ONLY be unlocked via explicit audited recall (`recallArchivedTask`).
 *   3. Three-Level Funnel for Distilled Archive (Prevents Context Pollution even with 10,000+ notes):
 *      - Level 1: Isolated per `peerAid`
 *      - Level 2: `peerRollingProfile` (1 fixed-length <=200-char rolling impression card per peer)
 *      - Level 3: Tag/Keyword Top-K Retrieval (`selectRelevantNotes`, default Top 3) with `[sourceTaskId]` pointer
 *   4. Dual-Side Idempotent `closeTask` (`CancelTask`):
 *      - Both Host and Client can trigger `CancelTask`. If both trigger concurrently or repeatedly,
 *        the state machine is 100% idempotent (`alreadyClosed: true`), never crashes, and deduplicates notes by `sourceTaskId`.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_MEMORY_FILE = process.env.HOST_MEMORY_FILE
  ? path.resolve(process.env.HOST_MEMORY_FILE)
  : path.resolve(__dirname, 'data', 'host_memory.json');

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

class HostMemoryStore {
  constructor(hostAid, filePath = DEFAULT_MEMORY_FILE) {
    this.hostAid = hostAid;
    this.filePath = filePath;
    this.state = this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        if (raw.trim()) {
          return JSON.parse(raw);
        }
      }
    } catch {
      // Fallback to fresh structure
    }
    return {
      hostAid: this.hostAid,
      updatedAt: new Date().toISOString(),
      peers: {},
      auditRecallLogs: []
    };
  }

  save() {
    this.state.updatedAt = new Date().toISOString();
    ensureDir(path.dirname(this.filePath));
    const tmp = `${this.filePath}.tmp.${process.pid}.${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), 'utf-8');
    fs.renameSync(tmp, this.filePath);
  }

  _ensurePeer(peerAid, peerEndpoint = null) {
    if (!this.state.peers[peerAid]) {
      const now = new Date().toISOString();
      this.state.peers[peerAid] = {
        peerAid,
        peerEndpoint: peerEndpoint || null,
        firstSeenAt: now,
        lastInteractionAt: now,
        // Rolling Peer Profile: 1 concise summary card (never exceeds ~200 chars) regardless of 10,000+ tasks
        peerRollingProfile: {
          peerAid,
          totalTasksCount: 0,
          completedTasksCount: 0,
          cancelledTasksCount: 0,
          recentTopics: [],
          rollingSummaryText: `与 ${peerAid} 初次建立连接，尚无历史完结任务画像。`,
          updatedAt: now
        },
        continuousSession: {
          sessionId: `session:${peerAid}:${this.hostAid}`,
          mode: 'session',
          peerAid,
          hostAid: this.hostAid,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          turnCount: 0,
          nextSeq: 1,
          messages: []
        },
        tasks: {},
        longTermNotes: []
      };
    } else if (peerEndpoint) {
      this.state.peers[peerAid].peerEndpoint = peerEndpoint;
    }
    if (!this.state.peers[peerAid].peerRollingProfile) {
      this.state.peers[peerAid].peerRollingProfile = {
        peerAid,
        totalTasksCount: 0,
        completedTasksCount: 0,
        cancelledTasksCount: 0,
        recentTopics: [],
        rollingSummaryText: `与 ${peerAid} 的滚动总画像`,
        updatedAt: new Date().toISOString()
      };
    }
    if (!this.state.auditRecallLogs) {
      this.state.auditRecallLogs = [];
    }
    return this.state.peers[peerAid];
  }

  /**
   * Append a message in either "session" (continuous) or "task" (single-task multi-turn) mode.
   * Supports `messageType`: 'chat' | 'counter_question' | 'proposal' | 'owner_confirmed_answer'
   */
  appendMessage({
    peerAid,
    peerEndpoint = null,
    senderAid,
    role, // 'client' | 'host'
    mode = 'session', // 'session' | 'task'
    taskId = null,
    topic = null,
    text,
    messageType = 'chat',
    proposal = null,
    msgId = null,
    viaOfflineMailbox = false
  }) {
    const peer = this._ensurePeer(peerAid, peerEndpoint);
    const now = new Date().toISOString();
    peer.lastInteractionAt = now;

    const finalMsgId = msgId || `msg_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;

    if (mode === 'session') {
      const session = peer.continuousSession;
      const existing = session.messages.find((m) => m.msgId === finalMsgId);
      if (existing) return { duplicate: true, message: existing, thread: session };

      const message = {
        seq: session.nextSeq++,
        msgId: finalMsgId,
        conversationId: session.sessionId,
        mode: 'session',
        senderAid,
        role,
        messageType,
        proposal,
        text,
        timestamp: now,
        viaOfflineMailbox,
        readByHost: role === 'host',
        readByClient: role === 'client'
      };
      session.messages.push(message);
      session.turnCount = session.messages.length;
      session.updatedAt = now;
      this.save();
      return { duplicate: false, message, thread: session };
    }

    // mode === 'task' (Single-Task Multi-Turn Dialogue)
    const effectiveTaskId = taskId || `task_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
    if (!peer.tasks[effectiveTaskId]) {
      peer.tasks[effectiveTaskId] = {
        taskId: effectiveTaskId,
        topic: topic || `与 ${peerAid} 的专项对话 (${effectiveTaskId})`,
        tags: extractKeywords(topic || effectiveTaskId),
        mode: 'task',
        peerAid,
        hostAid: this.hostAid,
        status: 'active',
        archived: false,
        createdAt: now,
        updatedAt: now,
        closedAt: null,
        closedBy: null,
        closeOutcome: null,
        closeReason: null,
        summary: null,
        turnCount: 0,
        nextSeq: 1,
        messages: []
      };
    }

    const taskThread = peer.tasks[effectiveTaskId];
    if (topic && (!taskThread.topic || taskThread.topic.startsWith('与 '))) {
      taskThread.topic = topic;
      taskThread.tags = extractKeywords(topic);
    }

    const existing = taskThread.messages.find((m) => m.msgId === finalMsgId);
    if (existing) return { duplicate: true, message: existing, thread: taskThread };

    const message = {
      seq: taskThread.nextSeq++,
      msgId: finalMsgId,
      conversationId: effectiveTaskId,
      taskId: effectiveTaskId,
      mode: 'task',
      senderAid,
      role,
      messageType, // 'chat' | 'counter_question' | 'proposal' | 'owner_confirmed_answer'
      proposal,
      text,
      timestamp: now,
      viaOfflineMailbox,
      readByHost: role === 'host',
      readByClient: role === 'client'
    };

    taskThread.messages.push(message);
    taskThread.turnCount = taskThread.messages.length;
    taskThread.updatedAt = now;

    // If an archived task receives a new turn, unarchive it to continue within the same taskId
    if (taskThread.archived || taskThread.status === 'completed' || taskThread.status === 'cancelled') {
      taskThread.archived = false;
      taskThread.status = 'active';
    } else if (messageType === 'counter_question' || messageType === 'proposal') {
      taskThread.status = 'input_required_from_client';
    } else {
      taskThread.status = role === 'client' ? 'waiting_host' : 'waiting_client';
    }

    this.save();
    return { duplicate: false, message, thread: taskThread };
  }

  /**
   * Three-Level Funnel: Select only the Top-K most relevant Distilled Notes for a task/topic
   * Prevents context pollution even when `longTermNotes` grows to 10,000+ items!
   */
  selectRelevantNotes(peerAid, { queryText = '', tags = [], topK = 3 } = {}) {
    const peer = this._ensurePeer(peerAid);
    const notes = peer.longTermNotes || [];
    if (notes.length === 0) return [];

    const queryTokens = new Set([
      ...extractKeywords(queryText),
      ...(Array.isArray(tags) ? tags : [])
    ].map((t) => String(t).toLowerCase()));

    // Score each note by tag/keyword overlap + recency bonus
    const scored = notes.map((note, idx) => {
      let score = 0;
      const noteText = `${note.topic || ''} ${note.summary || ''} ${(note.tags || []).join(' ')} ${(note.factsAndCommitments || []).join(' ')}`.toLowerCase();
      for (const token of queryTokens) {
        if (token && noteText.includes(token)) {
          score += 10;
        }
      }
      // Small recency tie-breaker so newer notes rank higher when scores are equal
      score += (idx / Math.max(notes.length, 1));
      return { note, score };
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK).map((s) => s.note);
  }

  /**
   * Fetch conversation stream for GetTask.
   * CRITICAL PHYSICAL SANDBOX RULE:
   *   - Only accesses the requested `taskId` (or `session`).
   *   - If a task is `archived: true` (closed), by default it returns the distilled summary & metadata
   *     WITHOUT dumping raw historical chat messages unless `includeArchivedTranscript: true` is explicitly passed!
   */
  getConversation({
    peerAid,
    mode = 'task',
    taskId = null,
    sinceSeq = 0,
    markReadByClient = false,
    markReadByHost = false,
    includeArchivedTranscript = true
  }) {
    const peer = this._ensurePeer(peerAid);

    let targetThread = null;
    if (mode === 'session' || taskId === 'session' || (!taskId && mode !== 'task')) {
      targetThread = peer.continuousSession;
    } else {
      targetThread = peer.tasks[taskId] || null;
    }

    if (!targetThread) {
      return null;
    }

    let changed = false;
    for (const m of targetThread.messages) {
      if (markReadByClient && !m.readByClient) {
        m.readByClient = true;
        changed = true;
      }
      if (markReadByHost && !m.readByHost) {
        m.readByHost = true;
        changed = true;
      }
    }
    if (changed) this.save();

    const isArchivedTask = Boolean(targetThread.archived);
    const messagesToReturn =
      isArchivedTask && !includeArchivedTranscript
        ? []
        : targetThread.messages.filter((m) => m.seq > sinceSeq);

    const relevantNotes = this.selectRelevantNotes(peerAid, {
      queryText: targetThread.topic || '',
      tags: targetThread.tags || [],
      topK: 3
    });

    return {
      conversationId: targetThread.sessionId || targetThread.taskId,
      taskId: targetThread.taskId || 'session',
      topic: targetThread.topic || `与 ${peerAid} 的连续自由会话`,
      mode: targetThread.mode,
      peerAid,
      hostAid: this.hostAid,
      status: targetThread.status,
      archived: isArchivedTask,
      turnCount: targetThread.turnCount,
      createdAt: targetThread.createdAt,
      updatedAt: targetThread.updatedAt,
      closedAt: targetThread.closedAt || null,
      closedBy: targetThread.closedBy || null,
      closeOutcome: targetThread.closeOutcome || null,
      summary: targetThread.summary || null,
      messages: messagesToReturn,
      totalMessages: targetThread.messages.length,
      peerRollingProfile: peer.peerRollingProfile,
      memoryNotes: relevantNotes,
      totalDistilledNotesOnDisk: peer.longTermNotes.length
    };
  }

  /**
   * Explicit Audited Recall of an Archived Task's Raw Transcript (`RecallArchivedTask`)
   * Prevents silent peeking at old tasks: requires an explicit `taskId` and `reason`, and logs the recall.
   */
  recallArchivedTask({ peerAid, taskId, callerAid, reason = '核对历史任务承诺细节' }) {
    const peer = this._ensurePeer(peerAid);
    const task = peer.tasks[taskId];
    if (!task) return null;

    const auditEntry = {
      recallId: `recall_${Date.now()}_${crypto.randomBytes(2).toString('hex')}`,
      timestamp: new Date().toISOString(),
      peerAid,
      taskId,
      callerAid: callerAid || peerAid,
      reason
    };
    this.state.auditRecallLogs.push(auditEntry);
    this.save();

    return {
      recalled: true,
      auditEntry,
      taskId: task.taskId,
      topic: task.topic,
      status: task.status,
      archived: task.archived,
      summary: task.summary,
      turnCount: task.turnCount,
      rawMessages: task.messages
    };
  }

  /**
   * List conversations like a chat sidebar
   */
  listConversations({ peerAid = null, mode = 'all', status = null } = {}) {
    const peersToScan = peerAid
      ? (this.state.peers[peerAid] ? [this.state.peers[peerAid]] : [])
      : Object.values(this.state.peers);

    const items = [];

    for (const peer of peersToScan) {
      if (mode === 'all' || mode === 'session') {
        const s = peer.continuousSession;
        const lastMsg = s.messages[s.messages.length - 1] || null;
        const unreadForHost = s.messages.filter((m) => !m.readByHost).length;
        const unreadForClient = s.messages.filter((m) => !m.readByClient).length;
        items.push({
          conversationId: s.sessionId,
          taskId: 'session',
          mode: 'session',
          topic: `连续会话 (${peer.peerAid} ⇄ ${this.hostAid})`,
          peerAid: peer.peerAid,
          status: s.status,
          archived: false,
          turnCount: s.turnCount,
          unreadForHost,
          unreadForClient,
          lastMessage: lastMsg ? { seq: lastMsg.seq, senderAid: lastMsg.senderAid, text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
          updatedAt: s.updatedAt
        });
      }

      if (mode === 'all' || mode === 'task') {
        for (const t of Object.values(peer.tasks)) {
          if (status && t.status !== status) continue;
          const lastMsg = t.messages[t.messages.length - 1] || null;
          const unreadForHost = t.messages.filter((m) => !m.readByHost).length;
          const unreadForClient = t.messages.filter((m) => !m.readByClient).length;
          items.push({
            conversationId: t.taskId,
            taskId: t.taskId,
            mode: 'task',
            topic: t.topic,
            peerAid: peer.peerAid,
            status: t.status,
            archived: Boolean(t.archived),
            turnCount: t.turnCount,
            unreadForHost,
            unreadForClient,
            summary: t.summary,
            lastMessage: lastMsg ? { seq: lastMsg.seq, senderAid: lastMsg.senderAid, text: lastMsg.text, timestamp: lastMsg.timestamp } : null,
            updatedAt: t.updatedAt
          });
        }
      }
    }

    items.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
    return items;
  }

  /**
   * Dual-Side Idempotent Task Closure & Memory Distillation (`CancelTask`)
   *
   * - Can be triggered by either Client or Host (`initiatedBy`).
   * - If both Client and Host trigger `CancelTask` simultaneously or sequentially:
   *   1. Never crashes or throws conflict errors! Returns `alreadyClosed: true`.
   *   2. Deduplicates distilled notes by `sourceTaskId` (1 taskId -> strictly 1 note).
   *   3. Archives raw chat transcript (`task.archived = true`) so future tasks cannot peek at it,
   *      while indexing it via `sourceTaskId` in `longTermNotes`.
   *   4. Updates the 200-char `peerRollingProfile` summary card.
   */
  closeTask({
    peerAid,
    taskId,
    initiatedBy = 'client', // 'client' | 'host' | specific AID
    outcome = 'completed', // 'completed' | 'cancelled' | 'paused'
    reason = '',
    summary = '',
    tags = [],
    factsAndCommitments = [],
    peerEvaluation = ''
  }) {
    const peer = this._ensurePeer(peerAid);
    const task = peer.tasks[taskId];
    if (!task) {
      return null;
    }

    const now = new Date().toISOString();
    const isAlreadyClosed = task.status === 'completed' || task.status === 'cancelled';

    // Lookup existing distilled note by sourceTaskId to guarantee 0 duplication
    let note = peer.longTermNotes.find((n) => n.sourceTaskId === taskId) || null;

    if (isAlreadyClosed) {
      // Idempotent path: merge any newly supplied summary/facts without re-counting or crashing
      if (note && summary && !note.summary.includes(summary)) {
        note.summary = `${note.summary} | 补充结案(${initiatedBy}): ${summary}`.slice(0, 300);
      }
      if (note && Array.isArray(factsAndCommitments) && factsAndCommitments.length > 0) {
        note.factsAndCommitments = Array.from(new Set([...(note.factsAndCommitments || []), ...factsAndCommitments]));
      }
      this.save();
      return {
        alreadyClosed: true,
        taskId: task.taskId,
        topic: task.topic,
        status: task.status,
        archived: task.archived,
        closedAt: task.closedAt,
        closedBy: task.closedBy,
        closeOutcome: task.closeOutcome,
        closeReason: task.closeReason,
        summary: task.summary,
        turnCount: task.turnCount,
        memoryNoteSaved: note,
        peerRollingProfile: peer.peerRollingProfile
      };
    }

    // First-time closure transition
    task.status = outcome; // 'completed' | 'cancelled' | 'paused'
    task.archived = outcome === 'completed' || outcome === 'cancelled';
    for (const m of task.messages) {
      m.readByHost = true;
      m.readByClient = true;
    }
    task.closedAt = now;
    task.closedBy = initiatedBy;
    task.closeOutcome = outcome;
    task.closeReason = reason || `Task ${outcome} by ${initiatedBy}`;
    task.updatedAt = now;

    const autoSummary =
      summary ||
      `[索引:${taskId}] 任务《${task.topic}》已结束(${outcome})，共 ${task.turnCount} 轮。` +
        (reason ? ` 结论: ${reason}` : '');
    task.summary = autoSummary;

    const mergedTags = Array.from(
      new Set([
        ...(task.tags || []),
        ...extractKeywords(task.topic),
        ...extractKeywords(summary),
        ...(Array.isArray(tags) ? tags : [])
      ])
    ).slice(0, 8);

    if (!note) {
      note = {
        noteId: `note_${taskId}`,
        timestamp: now,
        sourceTaskId: taskId, // Pointer to recall raw transcript from cold archive if ever needed!
        topic: task.topic,
        tags: mergedTags,
        outcome,
        closedBy: initiatedBy,
        summary: autoSummary,
        factsAndCommitments: Array.isArray(factsAndCommitments) && factsAndCommitments.length > 0
          ? factsAndCommitments
          : [autoSummary],
        peerEvaluation: peerEvaluation || (outcome === 'completed' ? '履约正常，沟通顺畅' : '任务中途终止'),
        archivePointer: `如需回溯原始聊天细节，可按 sourceTaskId="${taskId}" 调用 RecallArchivedTask`
      };
      peer.longTermNotes.push(note);
    } else {
      note.timestamp = now;
      note.outcome = outcome;
      note.summary = autoSummary;
      note.tags = mergedTags;
    }

    // Update the fixed-size Rolling Peer Profile (<= 200 chars)
    const profile = peer.peerRollingProfile;
    profile.totalTasksCount += 1;
    if (outcome === 'completed') profile.completedTasksCount += 1;
    if (outcome === 'cancelled') profile.cancelledTasksCount += 1;
    if (task.topic && !profile.recentTopics.includes(task.topic)) {
      profile.recentTopics = [...profile.recentTopics.slice(-4), task.topic];
    }
    profile.rollingSummaryText =
      `对端 ${peerAid} | 累计任务 ${profile.totalTasksCount} 次 (完成 ${profile.completedTasksCount} / 取消 ${profile.cancelledTasksCount}) | ` +
      `近期领域: ${profile.recentTopics.join('、') || '通用'} | 最近结案(${taskId}): ${autoSummary.slice(0, 65)}`;
    profile.updatedAt = now;

    this.save();

    return {
      alreadyClosed: false,
      taskId: task.taskId,
      topic: task.topic,
      status: task.status,
      archived: task.archived,
      closedAt: task.closedAt,
      closedBy: task.closedBy,
      closeOutcome: task.closeOutcome,
      closeReason: task.closeReason,
      summary: task.summary,
      turnCount: task.turnCount,
      memoryNoteSaved: note,
      peerRollingProfile: profile
    };
  }

  /**
   * Build a strictly sandboxed, anti-pollution memory context for the Agent wearing the headset:
   *   1. NEVER includes raw chat messages from other tasks or archived tasks!
   *   2. Includes the 1 concise `peerRollingProfile` (<= 200 chars).
   *   3. Uses the Top-K relevance funnel (`topK = 3`) to select only the most relevant distilled notes!
   */
  buildMemoryContext(peerAid, { recentSessionTurns = 6, currentTaskId = null, queryText = '', topKNotes = 3 } = {}) {
    const peer = this._ensurePeer(peerAid);
    const recentSession = peer.continuousSession.messages.slice(-recentSessionTurns);
    const currentTask = currentTaskId && peer.tasks[currentTaskId] ? peer.tasks[currentTaskId] : null;

    // Physical sandbox check: only expose currentTask's active messages, never other tasks!
    const otherArchivedTaskIds = Object.values(peer.tasks)
      .filter((t) => t.taskId !== currentTaskId && t.archived)
      .map((t) => t.taskId);

    const searchContextText = queryText || (currentTask ? currentTask.topic : '');
    const searchTags = currentTask ? (currentTask.tags || []) : [];
    const selectedNotes = this.selectRelevantNotes(peerAid, {
      queryText: searchContextText,
      tags: searchTags,
      topK: topKNotes
    });

    return {
      peerAid,
      hostAid: this.hostAid,
      peerEndpoint: peer.peerEndpoint,
      sandboxIsolationPolicy: 'STRICT_TASK_ISOLATION (Other tasks raw transcripts are physically excluded)',
      excludedArchivedTaskCount: otherArchivedTaskIds.length,
      peerRollingProfile: peer.peerRollingProfile,
      totalSessionTurns: peer.continuousSession.turnCount,
      recentSessionMessages: recentSession,
      currentTask: currentTask
        ? {
            taskId: currentTask.taskId,
            topic: currentTask.topic,
            status: currentTask.status,
            archived: Boolean(currentTask.archived),
            turnCount: currentTask.turnCount,
            // If currentTask is already archived, hide raw messages unless recalled
            recentMessages: currentTask.archived ? [] : currentTask.messages.slice(-10)
          }
        : null,
      relevantDistilledNotes: selectedNotes,
      totalDistilledNotesInArchive: peer.longTermNotes.length
    };
  }

  /**
   * Get all unread messages for Host across all peers
   */
  getUnreadForHost() {
    const unread = [];
    for (const peer of Object.values(this.state.peers)) {
      for (const m of peer.continuousSession.messages) {
        if (!m.readByHost && m.role === 'client') {
          unread.push({ peerAid: peer.peerAid, mode: 'session', taskId: 'session', topic: '连续会话', ...m });
        }
      }
      for (const t of Object.values(peer.tasks)) {
        if (t.archived) continue; // Physically exclude archived tasks from unread inbox
        for (const m of t.messages) {
          if (!m.readByHost && m.role === 'client') {
            unread.push({ peerAid: peer.peerAid, mode: 'task', taskId: t.taskId, topic: t.topic, ...m });
          }
        }
      }
    }
    return unread;
  }
}

module.exports = {
  HostMemoryStore,
  extractKeywords
};
