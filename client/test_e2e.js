/**
 * End-to-End Verification Suite for A2A Core Architecture & Foundation Mechanisms (client/test_e2e.js)
 *
 * Verifies all 8 core mechanisms from demands.docx & architectural discussion:
 *   1. Stranger Discovery on-chain by Capability Tags/Clues + Local Fixed HTTPS Caching + Mailbox Delivery
 *   2. Single-Task Multi-Turn Dialogue (mode="task") + Counter-Question (反问) in the SAME taskId
 *      + 3-Tier Anti-Fooling Guard when Owner Intent Card omits budget/airline preferences!
 *   3. Cross-Day / Multi-Reboot / Changed-Endpoint `taskId` Continuity (same taskId keeps exact thread across reboots)
 *   4. Dual-Side Idempotent `CancelTask` (Simultaneous Host + Client CancelTask -> 0 crash, 0 duplicate notes)
 *   5. Physical Task Sandbox Isolation (Active task-02 cannot peek at closed task-01 raw chat)
 *      + Explicit Audited `RecallArchivedTask` via `[sourceTaskId]` pointer
 *   6. Anti-Pollution Top-K Funnel (1 Rolling Peer Profile + Top-3 Relevant Distilled Notes out of massive archive)
 *   7. Multi-Turn Continuous Session (mode="session") & Redefined ListTasks
 *   8. Host Powered-Off / Unreachable Alert & Offline Mailbox Voicemail Recovery on Reboot
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Isolate all E2E test data in a temporary directory so real user data in server/data/ and client/data/ is NEVER touched!
const testTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a2a_e2e_test_'));
process.env.NETWORK_STATE_DIR = path.join(testTempRoot, 'network_state');
process.env.HOST_MEMORY_FILE = path.join(testTempRoot, 'host_memory.json');
process.env.CLIENT_MEMORY_FILE = path.join(testTempRoot, 'client_memory.json');
process.env.LOCAL_CHAIN_LEDGER_FILE = path.join(testTempRoot, 'chain_ledger.json');
process.env.HOST_AID = 'host-1001';
process.env.HOST_NAME = 'Alpha-Host-Headset';
process.env.PRIVATE_CHAIN_URL = '';
process.env.ALLOW_TEST_AUTO_REPLY = 'true';
process.env.HOST_LOCAL_TOKEN = 'test_local_token_e2e';
process.env.ANCHOR_SECRET = 'test_anchor_secret_e2e';
process.env.CHAIN_ADMIN_KEY = 'test_chain_admin_key_e2e';

const http = require('node:http');
const { startHostServer, memoryStore: hostMemory } = require('../server/host_server');
const { sendToMailbox } = require('../server/discovery_store');
const { A2AHeadsetClient } = require('./headset_client');
const { ClientMemoryStore } = require('./memory_store');
const { HostMemoryStore } = require('../server/memory_store');
const chainHandler = require('../chain/api');
const { createEmptyLedger, saveLedger, TMP_LEDGER_FILE, registerOrUpdateAIDOnLedger } = require('../chain/chain_engine');

async function runTests() {
  console.log('======================================================================');
  console.log('🚀 开始验证 A2A 核心架构与讨论共识机制全链路测试 (共 8 大场景)');
  console.log('======================================================================\n');

  // ---------------------------------------------------------------------------
  // 场景 1：完全陌生的两个 Agent —— 凭链上“能力标签/线索”发现 AID + 本地缓存长期 HTTPS + 邮箱投递
  // ---------------------------------------------------------------------------
  console.log('--- [测试 1] 陌生 Agent 链上线索发现 (Tag Clues) + 长期固定 HTTPS 本地缓存 + 邮箱投递 ---');
  let hostInstance = await startHostServer(0, {
    customTags: ['香港差旅', '机票酒店', '高管会议安排'],
    customDescription: '专注香港本地会议行程与机票酒店协调的个人Agent'
  });
  let { server, port, endpointUrl } = hostInstance;

  const client = new A2AHeadsetClient({
    clientAid: 'client-2002',
    clientName: 'Beta-Client-Headset',
    timeoutMs: 2500
  });

  // 1.1 最初完全陌生：Client 不知道 host-1001，仅凭线索 "香港差旅" 在链上搜索
  const clueSearch = client.discoverStrangerHostsByClue({ query: '香港差旅' });
  assert.equal(clueSearch.foundCount, 1, '陌生 Client 应能通过能力标签线索在链上搜到匹配的 Host');
  const discoveredAid = clueSearch.candidates[0].aid;
  assert.equal(discoveredAid, 'host-1001');
  console.log(`✅ 1.1 陌生线索发现成功: 搜索 "香港差旅" -> 找到 AID=${discoveredAid} (${clueSearch.candidates[0].httpsEndpoint})`);

  // 1.2 验证 Client 已将长期固定 HTTPS 缓存在本地，后续解析直接命中本地缓存无需每次查链
  const cachedResolve = client.resolveEndpointOrThrow('host-1001');
  assert.equal(cachedResolve.httpsEndpoint, endpointUrl);
  assert.equal(cachedResolve.source, 'onchain_tag_clue_discovery');
  console.log(`✅ 1.2 长期固定 HTTPS 本地缓存生效: source=${cachedResolve.source} -> ${cachedResolve.httpsEndpoint}`);

  // 1.3 验证收件箱（Mailbox）地址投递机制
  sendToMailbox({
    toAid: 'client-2002',
    fromAid: 'host-1001',
    type: 'ENDPOINT_DELIVERY',
    httpsEndpoint: endpointUrl,
    payload: { note: 'Host 投递固定 HTTPS 地址名片至 Client 邮箱' }
  });
  const mailboxDisc = client.discoverHost('host-1001', { strategy: 'mailbox' });
  assert.equal(mailboxDisc.found, true);
  console.log(`✅ 1.3 收件箱地址名片读取通过: MailID=${mailboxDisc.mailItem.mailId}`);

  // ---------------------------------------------------------------------------
  // 场景 2：同一 taskId 内反问（不终止 Task）+ 《初衷卡》漏写底线时的三级防忽悠拦截与主人确认学习
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 2] 同一 taskId 内反问 + 《初衷卡》漏写预算/航司时的防忽悠拦截与偏好学习 ---');
  const taskId1 = 'task-hk-flight-01';

  // 主人下达任务时生成《初衷卡》，但故意【漏写了预算上限 maxBudget: null】和【航司偏好】！
  client.setOwnerIntentCard(taskId1, {
    goal: '订明天下午从上海去香港的机票，配合明晚香港会议',
    maxBudget: null, // 漏写预算！
    allowedProviders: null, // 漏写航司！
    forbiddenProviders: [],
    mustConfirmBeforeOrder: true
  });

  // 第 1 轮：Client 发起诉求
  const t1 = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: taskId1,
    topic: '明日上海飞香港机票预订',
    text: '你好，请帮我安排明天下午上海飞香港的机票。'
  });
  assert.equal(t1.ok, true);
  assert.equal(t1.turnCount, 1);

  // 第 2 轮：Host 在【同一个 taskId1】内发起反问/高价推销（8500 元 + 某高价廉航），试图忽悠直接锁单
  await fetch(`${endpointUrl}/host/reply`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-host-local-token': process.env.HOST_LOCAL_TOKEN
    },
    body: JSON.stringify({
      toAid: 'client-2002',
      mode: 'task',
      taskId: taskId1,
      messageType: 'proposal',
      proposal: { price: 8500, provider: '某高价坑人航司', requiresOwnerConfirm: true },
      text: '明天下午只剩【某高价坑人航司】头等特惠 8500 元，以及【东航】14:00 经济舱 1850 元（起飞前4小时可免费改签1次）。我现在直接帮你锁单 8500 元那张吗？'
    })
  });

  // Client 拉取第 2 轮反问，耳机防忽悠守卫应立即拦截并触发 ESCALATE_TO_HUMAN_OWNER！
  const pullCounterQ = await client.getTask({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: taskId1
  });
  assert.equal(pullCounterQ.ok, true);
  assert.ok(pullCounterQ.counterQuestionGuard, '收到反问/报价时必须触发防忽悠检查');
  assert.equal(
    pullCounterQ.counterQuestionGuard.decision,
    'ESCALATE_TO_HUMAN_OWNER',
    '《初衷卡》漏写预算和航司时，必须强制挂起请示人类主人，严禁被对方忽悠直接下单'
  );
  console.log(`✅ 2.1 防忽悠拦截生效 (${pullCounterQ.counterQuestionGuard.decision}):\n${pullCounterQ.counterQuestionGuard.promptForHumanOwner}`);

  // 第 3 轮：人类主人拍板拒绝 8500 元方案，设定【预算上限 2500 元】、【拉黑：某高价坑人航司】、【偏好：东航】，并在同一 taskId1 内回复！
  const ownerConfirmRes = await client.confirmEscalatedProposal({
    hostAid: 'host-1001',
    taskId: taskId1,
    approved: false,
    learnedMaxBudget: 2500,
    learnedBlacklistedProvider: '某高价坑人航司',
    learnedPreferredProvider: '东航',
    learnedCustomRule: '绝不坐红眼航班，优先选含免费改签条款的航班',
    ownerReplyText: '主人已确认：拒绝 8500 元方案！预算上限 2500 元，拉黑某高价坑人航司；请锁定【东航 14:00 经济舱 1850 元（含起飞前4小时免费改签1次）】。'
  });
  assert.equal(ownerConfirmRes.ok, true);
  assert.equal(ownerConfirmRes.sendResult.turnCount, 3, '反问与回答始终保持在同一个 taskId 内，第3轮平滑衔接');
  console.log(`✅ 2.2 主人确认后自动补全《主人长期偏好档案》，并在同一 taskId (${taskId1}) 完成第 3 轮回复`);

  // 验证学习后的防忽悠自动拦截：如果再遇到黑名单航司或超 2500 元报价，耳机直接自动回绝无需再烦主人！
  const blacklistEval = client.memory.evaluateHostProposalOrCounterQuestion(taskId1, {
    text: '再推一次某高价坑人航司',
    proposal: { price: 1200, provider: '某高价坑人航司' }
  });
  assert.equal(blacklistEval.decision, 'AUTO_REJECT_KNOWN_BLACKLIST');
  const overBudgetEval = client.memory.evaluateHostProposalOrCounterQuestion(taskId1, {
    text: '国泰商务舱 3600 元',
    proposal: { price: 3600, provider: '国泰' }
  });
  assert.equal(overBudgetEval.decision, 'AUTO_REJECT_OVER_BUDGET');
  console.log(`✅ 2.3 长期偏好自动防御验证通过: 黑名单拦截=${blacklistEval.decision}, 超预算拦截=${overBudgetEval.decision}`);

  // ---------------------------------------------------------------------------
  // 场景 3：跨天/多次开关机/甚至更换 HTTPS 隧道端口后，同一 taskId 依然保持完整上下文
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 3] 模拟双方电脑关机重启 & HTTPS 端口变化后，同一 taskId 跨天接续同一套内容 ---');
  await new Promise((resolve) => server.close(resolve));

  // Host 在一个全新的端口重新开机（模拟第二天重新开机、甚至隧道地址发生了变化）
  hostInstance = await startHostServer(0, {
    customTags: ['香港差旅', '机票酒店', '高管会议安排']
  });
  server = hostInstance.server;
  port = hostInstance.port;
  endpointUrl = hostInstance.endpointUrl;

  // Client 继续在 taskId1 下发第 4 轮消息（Client 会自动发现新地址，且 Host 从本地硬盘按 (client-2002, task-hk-flight-01) 接着记第 4 轮！）
  const t4AfterReboot = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: taskId1,
    text: '第二天早上好！确认一下昨天聊的东航 1850 元机票出票成功了吗？',
    autoReplyText: '出票已确认！航班号 MU501，明日14:00虹桥T1起飞，总价1850元，含起飞前4小时免费改签1次承诺。'
  });
  assert.equal(t4AfterReboot.ok, true);
  assert.equal(t4AfterReboot.turnCount, 5, '即使经历关机重启与端口变化，taskId1 依然从前3轮无缝延续到第4、5轮！');
  console.log(`✅ 3.1 跨开关机与地址变更后，${taskId1} 无缝接续至第 ${t4AfterReboot.turnCount} 轮: "${t4AfterReboot.hostReply.text}"`);

  // ---------------------------------------------------------------------------
  // 场景 4：双端同时触发 CancelTask 幂等防崩溃验证 + Agent 自主提炼带索引《极简档案》
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 4] Host 与 Client 同时并发触发 CancelTask (幂等零崩溃、极简档案零重复) ---');

  const [clientCancelRes, hostCancelHttpResp] = await Promise.all([
    client.cancelTask({
      hostAid: 'host-1001',
      taskId: taskId1,
      outcome: 'completed',
      reason: '机票预订与改签条款确认完毕',
      summary: '预订明日14:00上海飞香港东航MU501经济舱(1850元)，对方承诺起飞前4小时可免费改签1次。',
      tags: ['香港', '机票', '东航', 'MU501', '免费改签'],
      factsAndCommitments: ['航班: MU501 明日14:00', '价格: 1850元', '承诺: 起飞前4小时免费改签1次'],
      peerEvaluation: '报价透明，响应迅速，可信度高'
    }),
    fetch(`${endpointUrl}/host/cancel-task`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-local-token': process.env.HOST_LOCAL_TOKEN
      },
      body: JSON.stringify({
        peerAid: 'client-2002',
        taskId: taskId1,
        outcome: 'completed',
        reason: 'Host 端同步确认出票完成',
        summary: '已完成 MU501 出票交付（1850元，含免费改签1次权益）。'
      })
    }).then((r) => r.json())
  ]);

  assert.equal(clientCancelRes.ok, true, 'Client 端 CancelTask 不应报错');
  assert.equal(hostCancelHttpResp.ok, true, 'Host 端同时触发 CancelTask 不应报错或崩溃');
  assert.equal(
    clientCancelRes.alreadyClosed || hostCancelHttpResp.alreadyClosed,
    true,
    '并发触发时后到达的一方应幂等返回 alreadyClosed: true'
  );

  // 检查极简档案是否严格按 sourceTaskId 唯一去重
  const hostNotesForTask1 = hostMemory.state.peers['client-2002'].longTermNotes.filter(
    (n) => n.sourceTaskId === taskId1
  );
  assert.equal(hostNotesForTask1.length, 1, '同一 taskId 即使双端同时 CancelTask 也只能生成唯一 1 条极简档案');
  console.log(`✅ 4.1 双端并发 CancelTask 零崩溃通过! 唯一极简档案 (${hostNotesForTask1[0].noteId}): "${hostNotesForTask1[0].summary}"`);

  // ---------------------------------------------------------------------------
  // 场景 5 & 6：旧 Task 物理沙箱隔离（防偷看）+ 海量极简档案 Top-3 防污染漏斗 + 按索引显式调卷 (Recall)
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 5 & 6] 物理沙箱隔离(防偷看旧Task) + 海量极简档案 Top-3 漏斗 + 显式审计调卷 ---');

  // 模拟产生 30 条其他领域的历史已完结任务与极简档案（模拟积累了大量极简档案）
  for (let i = 1; i <= 30; i++) {
    const dummyId = `task-history-${i}`;
    hostMemory.appendMessage({
      peerAid: 'client-2002',
      senderAid: 'client-2002',
      role: 'client',
      mode: 'task',
      taskId: dummyId,
      topic: i % 2 === 0 ? `无关领域_餐饮预订_${i}` : `无关领域_租车服务_${i}`,
      text: `历史任务 ${i} 的私密聊天细节，新任务绝对不能偷看这句话！`
    });
    hostMemory.closeTask({
      peerAid: 'client-2002',
      taskId: dummyId,
      initiatedBy: 'host',
      outcome: 'completed',
      summary: `历史档案 ${i}: 完成了常规服务 #${i}`,
      tags: i % 2 === 0 ? ['餐饮', '晚宴'] : ['租车', '大巴']
    });
  }

  // 现在开启一个全新的任务 taskId2（关于“香港东航机票改签咨询”）
  const taskId2 = 'task-hk-rebook-02';
  const t2Turn1 = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: taskId2,
    topic: '香港东航MU501机票改签咨询',
    text: '你好，我今天下午临时有事，想咨询一下之前订的香港东航机票能不能改签？'
  });
  assert.equal(t2Turn1.ok, true);

  const memCtx = t2Turn1.memoryContext;
  // 验证 1：物理沙箱隔离 —— 新任务上下文中绝不包含任何已归档旧任务的原始聊天记录！
  assert.equal(memCtx.excludedArchivedTaskCount, 31, '全部 31 个已归档旧任务（含 taskId1 和 30 个历史任务）的原始对话必须被物理隔离排除');
  assert.equal(memCtx.currentTask.taskId, taskId2);
  assert.equal(memCtx.currentTask.recentMessages.length, 1, '当前任务工作记忆只包含 taskId2 自己的 1 条消息');

  // 验证 2：海量极简档案 Top-3 防污染漏斗 —— 虽然磁盘上有 31 份极简档案，但只注入 1 张滚动总画像 + 最相关的 Top 3 条！
  assert.equal(memCtx.totalDistilledNotesInArchive, 31);
  assert.equal(memCtx.relevantDistilledNotes.length, 3, 'Top-K 漏斗必须严格限制只加载最相关的 3 条极简档案，拒绝全量污染');
  assert.equal(
    memCtx.relevantDistilledNotes[0].sourceTaskId,
    taskId1,
    '按标签相关性匹配，排在第一位的极简档案必须是关于“香港/东航/机票/免费改签”的 task-hk-flight-01！'
  );
  console.log(`✅ 5.1 物理沙箱隔离验证通过: 已硬性排除 ${memCtx.excludedArchivedTaskCount} 个旧 Task 的原始聊天记录（防偷看与跑偏）`);
  console.log(`✅ 6.1 极简档案 Top-3 防污染漏斗通过: 磁盘共 ${memCtx.totalDistilledNotesInArchive} 份档案 -> 仅精准注入 Top ${memCtx.relevantDistilledNotes.length} 条 (首选命中: ${memCtx.relevantDistilledNotes[0].sourceTaskId})`);
  console.log(`✅ 6.2 对端滚动总画像 (固定<=200字): "${memCtx.peerRollingProfile.rollingSummaryText}"`);

  // 验证 3：当出现争议或需要核对当年 task-hk-flight-01 的具体承诺原话时，凭极简档案上的 sourceTaskId 显式调卷！
  const recalled = await client.recallArchivedTask({
    hostAid: 'host-1001',
    taskId: taskId1,
    reason: '根据极简档案索引 task-hk-flight-01 核对起飞前4小时免费改签1次的原始承诺'
  });
  assert.equal(recalled.ok, true);
  assert.equal(recalled.rawMessages.length, 5, '显式申请调卷后，应完整找回 task-hk-flight-01 当年的 5 轮原始对话记录');
  assert.ok(recalled.auditEntry.recallId, '显式调卷必须留下审计记录');
  console.log(`✅ 5.2 按极简档案索引显式调阅原始卷宗 (RecallArchivedTask) 通过: 成功找回 ${taskId1} 的 ${recalled.rawMessages.length} 轮原话 (审计ID: ${recalled.auditEntry.recallId})`);

  // ---------------------------------------------------------------------------
  // 场景 7：多轮连续会话 (mode="session") 与 ListTasks 会话总览
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 7] 多轮连续会话 (mode="session") 与 ListTasks 会话总览 ---');
  const s1 = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'session',
    text: '我们在连续会话窗口也打个招呼！',
    autoReplyText: '收到！连续会话窗口随时保持畅通。'
  });
  assert.equal(s1.ok, true);
  assert.equal(s1.mode, 'session');

  const listAll = await client.listTasks({ hostAid: 'host-1001', mode: 'all' });
  assert.equal(listAll.ok, true);
  assert.ok(listAll.totalCount >= 32);
  console.log(`✅ 7.1 多轮连续会话与 ListTasks 验证通过 (当前共管理 ${listAll.totalCount} 个会话/任务项)`);

  // ---------------------------------------------------------------------------
  // 场景 8：对方电脑关机/失联告警提示与开机收件箱离线留言恢复
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 8] 电脑关机/失联告警提示与开机收件箱离线留言恢复 ---');
  await new Promise((resolve) => server.close(resolve));

  const offlineSend = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: taskId2,
    text: 'Host 你电脑关机了吗？我把改签到明天16:30的确认留言放在你收件箱里了！'
  });
  assert.equal(offlineSend.ok, false);
  assert.equal(offlineSend.status, 'offline_queued_to_mailbox');
  assert.equal(offlineSend.offlineAlert.alertCode, 'HOST_OFFLINE_OR_UNREACHABLE');
  console.log(`✅ 8.1 关机失联告警与离线投递通过 (MailID: ${offlineSend.offlineAlert.mailboxId})`);

  const rebooted = await startHostServer(port);
  const task2AfterReboot = hostMemory.getConversation({
    peerAid: 'client-2002',
    mode: 'task',
    taskId: taskId2
  });
  assert.equal(task2AfterReboot.totalMessages, 2, 'Host 重新开机后应自动把离线留言恢复进 task-hk-rebook-02 的第 2 轮');
  console.log(`✅ 8.2 Host 重新开机收件箱自检恢复通过: 离线留言已精准汇入任务 ${taskId2} 第 2 轮`);

  // ---------------------------------------------------------------------------
  // 场景 9：安全边界加固验证（封死公网 /host/*、锚点落盘验权、真 AID 1 保护 + ownerSecret、禁用公网 autoReplyText、跨机 HTTP 补发队列）
  // ---------------------------------------------------------------------------
  console.log('\n--- [测试 9] 安全边界加固与跨机 HTTP 离线补发队列验证 ---');

  // 9.1 公网隧道转发请求（带 x-forwarded-for）打 /host/inbox -> 必须 403 拦截
  const forwardedHostInbox = await fetch(`${rebooted.endpointUrl}/host/inbox`, {
    headers: {
      'x-forwarded-for': '8.8.8.8',
      'x-host-local-token': process.env.HOST_LOCAL_TOKEN
    }
  });
  assert.equal(forwardedHostInbox.status, 403, '带 x-forwarded-for 的公网隧道请求访问 /host/inbox 必须被 403 拦截');
  console.log('✅ 9.1 公网隧道访问 /host/inbox 被成功 403 拦截');

  // 9.2 缺失本机令牌打 /host/reply -> 必须 403 拦截
  const noTokenReply = await fetch(`${rebooted.endpointUrl}/host/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ toAid: 'client-2002', text: 'fake reply' })
  });
  assert.equal(noTokenReply.status, 403, '缺失 X-Host-Local-Token 的 /host/reply 必须被 403 拦截');
  console.log('✅ 9.2 无令牌调用 /host/reply 被成功 403 拦截');

  // 9.3 无共享密钥打 /chain-anchor/ledger -> 必须 403 拦截；带密钥但篡改哈希链 -> 必须 400 拦截
  const unauthAnchor = await fetch(`${rebooted.endpointUrl}/chain-anchor/ledger`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ledger: { blockHeight: 9999, blocks: [], stateRecords: {} } })
  });
  assert.equal(unauthAnchor.status, 403, '无 X-Anchor-Secret 访问 /chain-anchor/ledger 必须被 403 拦截');

  const tamperedAnchor = await fetch(`${rebooted.endpointUrl}/chain-anchor/ledger`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-anchor-secret': process.env.ANCHOR_SECRET
    },
    body: JSON.stringify({
      ledger: {
        blockHeight: 1,
        blocks: [{ blockNumber: 0, prevBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000', blockHash: '0xfake', timestamp: '2026', txHash: '0x1', action: 'FAKE', payload: {} }],
        stateRecords: {}
      }
    })
  });
  assert.equal(tamperedAnchor.status, 400, '伪造哈希链的账本落盘必须被 400 拦截');
  console.log('✅ 9.3 /chain-anchor/ledger 无密钥 403 拦截 + 假哈希链 400 拦截通过');

  // 9.4 生产模式下（ALLOW_TEST_AUTO_REPLY=false），远程 Client 传 autoReplyText 严禁注入伪造 Host 回复
  process.env.ALLOW_TEST_AUTO_REPLY = 'false';
  const spoofRes = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'session',
    text: '试图伪造 Host 回复',
    autoReplyText: '我是假冒的 Host 自动回复！'
  });
  assert.equal(spoofRes.ok, true);
  assert.equal(spoofRes.hostReply, null, '生产环境下必须忽略客户端传入的 autoReplyText，防止冒充 Host 发言');
  process.env.ALLOW_TEST_AUTO_REPLY = 'true';
  console.log('✅ 9.4 生产模式下成功屏蔽客户端 autoReplyText 冒充 Host 发言');

  // 9.5 私链真正防篡改校验：拒绝 body.allowUpdateAid1=true 改 AID=1；普通 AID 必须凭 ownerSecret 更新
  const chainServer = http.createServer(chainHandler);
  await new Promise((r) => chainServer.listen(0, '127.0.0.1', r));
  const chainUrl = `http://127.0.0.1:${chainServer.address().port}`;
  const backupTmp = fs.existsSync(TMP_LEDGER_FILE) ? fs.readFileSync(TMP_LEDGER_FILE, 'utf8') : null;
  try {
    process.env.IS_LOCAL_ANCHOR_HOST = 'true';
    const freshLedger = createEmptyLedger();
    registerOrUpdateAIDOnLedger(freshLedger, {
      aid: '1',
      agentName: 'genesis-node',
      httpsEndpoint: 'https://genesis.example',
      isAdmin: true
    });
    fs.writeFileSync(TMP_LEDGER_FILE, JSON.stringify(freshLedger, null, 2), 'utf8');

    // 攻击者尝试在 body 里自填 allowUpdateAid1: true 修改 AID=1 -> 必须 403！
    const fakeAdmin = await fetch(`${chainUrl}/chain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aid: '1', allowUpdateAid1: true, httpsEndpoint: 'https://hijack.example' })
    });
    assert.equal(fakeAdmin.status, 403, '请求体里的 allowUpdateAid1:true 绝对不能绕过 AID=1 管理员保护');

    // 正常注册 AID=2 -> 获得 ownerSecret
    const reg2 = await (await fetch(`${chainUrl}/chain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'peer-muse', httpsEndpoint: 'https://muse-1.example' })
    })).json();
    assert.equal(reg2.ok, true);
    assert.equal(reg2.assignedAid, '2');
    assert.ok(reg2.ownerSecret, '新注册必须返回一次性 ownerSecret');

    // 陌生人试图凭同名 agentName 或 aid="2" 无密钥劫持 AID=2 -> 必须 403！
    const hijack2 = await fetch(`${chainUrl}/chain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentName: 'peer-muse', httpsEndpoint: 'https://evil-muse.example' })
    });
    assert.equal(hijack2.status, 403, '无 X-Aid-Owner-Secret 严禁按同名 agentName 劫持已有 AID');

    // 持有正确 X-Aid-Owner-Secret 更新 AID=2 的临时隧道 -> 200 成功！
    const validUpdate2 = await (await fetch(`${chainUrl}/chain/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aid-owner-secret': reg2.ownerSecret
      },
      body: JSON.stringify({ aid: '2', httpsEndpoint: 'https://muse-2.example' })
    })).json();
    assert.equal(validUpdate2.ok, true);
    assert.equal(validUpdate2.record.httpsEndpoint, 'https://muse-2.example');
    console.log('✅ 9.5 私链防劫持验证通过: body.allowUpdateAid1=true 已封死(403), 同名无密更新拦截(403), 凭 ownerSecret 更新通过(200)');
  } finally {
    delete process.env.IS_LOCAL_ANCHOR_HOST;
    if (backupTmp !== null) fs.writeFileSync(TMP_LEDGER_FILE, backupTmp, 'utf8');
    else if (fs.existsSync(TMP_LEDGER_FILE)) fs.unlinkSync(TMP_LEDGER_FILE);
    await new Promise((r) => chainServer.close(r));
  }

  // 9.6 跨机真实离线补发验证（关闭 Host -> Client 队列暂存且不走共享文件 -> 重启 Host -> flushPendingOutbox 通过 HTTP 真实补发）
  await new Promise((resolve) => rebooted.server.close(resolve));
  // 故意让 Client 写进另一个目录，验证即便不共享 .network_state，靠 flushPendingOutbox 也能跨机 HTTP 补发！
  const crossMachineTask = 'task-cross-machine-flush';
  const offlineQueued = await client.sendMessage({
    hostAid: 'host-1001',
    mode: 'task',
    taskId: crossMachineTask,
    topic: '跨机离线补发验证',
    text: '这是一条对方关机时积压在 Client 本机待发队列中的消息！'
  });
  assert.equal(offlineQueued.ok, false);
  // 清空模拟的本地共享邮箱文件，确保重启后的 Host 绝不会靠共享文件“作弊”拿到这条消息
  const sharedMailboxFile = path.join(process.env.NETWORK_STATE_DIR, 'mailbox_store.json');
  if (fs.existsSync(sharedMailboxFile)) fs.unlinkSync(sharedMailboxFile);

  const rebooted2 = await startHostServer(port);
  const beforeFlush = hostMemory.getConversation({ peerAid: 'client-2002', mode: 'task', taskId: crossMachineTask });
  assert.equal(beforeFlush, null, '清除共享文件后，重连补发前 Host 确实尚未收到该跨机离线消息');

  const flushRes = await client.flushPendingOutbox('host-1001');
  assert.equal(flushRes.ok, true);
  assert.ok(flushRes.flushedCount >= 1, 'flushPendingOutbox 必须通过 HTTP 将积压的离线消息补发给 Host');
  assert.equal(flushRes.remainingCount, 0, '补发完成后待发队列应清空为 0');

  const afterFlush = hostMemory.getConversation({ peerAid: 'client-2002', mode: 'task', taskId: crossMachineTask });
  assert.ok(afterFlush && afterFlush.totalMessages === 1, 'Host 应通过 HTTP 补发真实收到该跨机离线消息');
  console.log(`✅ 9.6 跨机 HTTP 离线补发队列验证通过: 已补发 ${flushRes.flushedCount} 条离线消息，队列清零`);

  await new Promise((resolve) => rebooted2.server.close(resolve));

  console.log('\n======================================================================');
  console.log('🎉 全部 9 大核心架构、安全边界与跨机补发测试 100% 通过！');
  console.log('======================================================================');
}

runTests()
  .catch((err) => {
    console.error('❌ 测试失败:', err);
    process.exitCode = 1;
  })
  .finally(() => {
    try {
      fs.rmSync(testTempRoot, { recursive: true, force: true });
    } catch {
      // ignore temp cleanup failure
    }
  });
