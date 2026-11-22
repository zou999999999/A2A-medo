/**
 * Client Headset CLI (client/client_cli.js)
 * Commands:
 *   - search-clue "<关键词或标签>"
 *   - discover <hostAid> [--strategy auto|onchain_aid|mailbox]
 *   - set-intent <taskId> "<初衷目标>" [--budget 2500] [--blacklist "某廉航"]
 *   - chat <hostAid> "<text>" [--wait 3000]
 *   - task-chat <hostAid> <taskId> "<text>" [--topic "..."] [--wait 3000]
 *   - get <hostAid> [--task <taskId>|session] [--since 0]
 *   - list <hostAid> [--mode all|session|task]
 *   - end-task <hostAid> <taskId> [--outcome completed|cancelled|paused] [--summary "..."]
 *   - recall-task <hostAid> <taskId> [--reason "..."]
 *   - memory <hostAid> [--task <taskId>]
 *   - mailbox
 */

const fs = require('node:fs');
const path = require('node:path');
const { A2AHeadsetClient } = require('./headset_client');
const {
  checkClientMailbox,
  getConfiguredPrivateChainUrl,
  searchHostsByClueFromRemoteChain,
  findHostByRemoteChainAID
} = require('./discovery_client');

const CLIENT_AID = process.env.CLIENT_AID || 'client-2002';
const TARGET_HOST_AID = process.env.TARGET_HOST_AID || '';

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
      flags[key] = val;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] || 'help';
  const client = new A2AHeadsetClient({ clientAid: flags.client || CLIENT_AID });

  if (cmd === 'set-chain') {
    const chainUrl = positional[1] || flags.url;
    if (!chainUrl) {
      console.error('用法: node client_cli.js set-chain <https://你的vercel私链域名.vercel.app>');
      process.exit(1);
    }
    const cfgDir = path.resolve(__dirname, 'data');
    if (!fs.existsSync(cfgDir)) fs.mkdirSync(cfgDir, { recursive: true });
    const cfgFile = path.join(cfgDir, 'chain_url.json');
    fs.writeFileSync(cfgFile, JSON.stringify({ privateChainUrl: chainUrl.replace(/\/+$/, '') }, null, 2), 'utf-8');
    console.log(`⛓️  [已绑定远端 PoA 私链节点] -> ${chainUrl}`);
    return;
  }

  if (cmd === 'search-clue') {
    const query = positional[1] || flags.query || '';
    const tag = flags.tag || '';
    const remoteUrl = flags.chain || getConfiguredPrivateChainUrl();
    const res = remoteUrl
      ? await searchHostsByClueFromRemoteChain({ query, tag, chainUrl: remoteUrl })
      : client.discoverStrangerHostsByClue({ query, tag });
    if (res.candidates && res.candidates.length > 0) {
      const top = res.candidates[0];
      client.memory.recordDiscovery(top.aid, {
        httpsEndpoint: top.httpsEndpoint,
        mailboxAddress: top.mailboxAddress || null,
        tags: top.tags || [],
        source: remoteUrl ? 'vercel_poa_private_chain' : 'onchain_tag_clue_discovery'
      });
    }
    console.log(`🔎 [私链陌生人线索搜索 (${remoteUrl || 'PoA私链账本'})] 关键词: "${query}" | 匹配到 ${res.foundCount} 个 Host Agent:`);
    console.log(JSON.stringify(res.candidates, null, 2));
    return;
  }

  if (cmd === 'bind') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const httpsUrl = positional[2] || flags.url;
    if (!httpsUrl) {
      console.error('用法: node client_cli.js bind <hostAid> <https://公网隧道地址>');
      process.exit(1);
    }
    client.memory.recordDiscovery(hostAid, {
      httpsEndpoint: httpsUrl,
      source: 'cross_machine_fixed_https_bind'
    });
    console.log(`🔗 [跨机长期 HTTPS 绑定成功] 已将 ${hostAid} -> ${httpsUrl} 缓存至本机 Client 耳机通讯录！`);
    return;
  }

  if (cmd === 'discover') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const strategy = flags.strategy || 'auto';
    const remoteUrl = flags.chain || getConfiguredPrivateChainUrl();
    const res = remoteUrl
      ? await findHostByRemoteChainAID(hostAid, { chainUrl: remoteUrl })
      : client.discoverHost(hostAid, { strategy });
    if (res.found && res.httpsEndpoint) {
      client.memory.recordDiscovery(hostAid, {
        httpsEndpoint: res.httpsEndpoint,
        mailboxAddress: res.mailboxAddress || null,
        tags: res.tags || [],
        source: res.source
      });
      console.log(`🔍 [从私链发现 Host 成功] Host AID: ${hostAid}`);
      console.log(`   • 发现途径   : ${res.source}`);
      console.log(`   • 长期 HTTPS : ${res.httpsEndpoint}`);
    } else {
      console.log(`❌ 未找到 Host (${hostAid}) 的 HTTPS 地址（查询策略: ${strategy}）`);
    }
    return;
  }

  if (cmd === 'set-intent') {
    const taskId = positional[1] || flags.task;
    const goal = positional[2] || flags.goal;
    if (!taskId || !goal) {
      console.error('用法: node client_cli.js set-intent <taskId> "<任务初衷目标>" [--budget 2500] [--blacklist "某廉航"]');
      process.exit(1);
    }
    const card = client.setOwnerIntentCard(taskId, {
      goal,
      maxBudget: flags.budget ? Number(flags.budget) : null,
      forbiddenProviders: flags.blacklist ? flags.blacklist.split(',').map((s) => s.trim()) : []
    });
    console.log(`📌 [主人初衷卡已锚定] (${taskId}):`);
    console.log(JSON.stringify(card, null, 2));
    return;
  }

  if (cmd === 'chat') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const text = positional[2] || flags.text;
    if (!text) {
      console.error('用法: node client_cli.js chat <hostAid> "<消息内容>" [--wait 毫秒]');
      process.exit(1);
    }
    const res = await client.sendMessage({
      hostAid,
      mode: 'session',
      text,
      waitReplyMs: Number(flags.wait || 0),
      autoReplyText: flags.autoreply || null
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'task-chat') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const taskId = positional[2] || flags.task;
    const text = positional[3] || flags.text;
    if (!taskId || !text) {
      console.error('用法: node client_cli.js task-chat <hostAid> <taskId> "<消息内容>" [--topic "主题"]');
      process.exit(1);
    }
    const res = await client.sendMessage({
      hostAid,
      mode: 'task',
      taskId,
      topic: flags.topic || null,
      text,
      waitReplyMs: Number(flags.wait || 0),
      autoReplyText: flags.autoreply || null
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'get') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const taskId = flags.task || 'session';
    const mode = taskId === 'session' ? 'session' : 'task';
    const res = await client.getTask({
      hostAid,
      mode,
      taskId,
      sinceSeq: Number(flags.since || 0)
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'list') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const res = await client.listTasks({
      hostAid,
      mode: flags.mode || 'all',
      status: flags.status || null
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'end-task') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const taskId = positional[2] || flags.task;
    if (!taskId) {
      console.error('用法: node client_cli.js end-task <hostAid> <taskId> [--outcome completed|cancelled|paused] [--summary "..."]');
      process.exit(1);
    }
    const res = await client.cancelTask({
      hostAid,
      taskId,
      outcome: flags.outcome || 'completed',
      reason: flags.reason || '',
      summary: flags.summary || '',
      tags: flags.tags ? flags.tags.split(',').map((s) => s.trim()) : []
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'recall-task') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    const taskId = positional[2] || flags.task;
    if (!taskId) {
      console.error('用法: node client_cli.js recall-task <hostAid> <taskId> [--reason "核对承诺细节"]');
      process.exit(1);
    }
    const res = await client.recallArchivedTask({
      hostAid,
      taskId,
      reason: flags.reason || '按极简档案索引回溯历史任务细节'
    });
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'memory') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    if (flags.task) {
      console.log(JSON.stringify(client.memory.buildSandboxedTaskContext(hostAid, { taskId: flags.task }), null, 2));
    } else {
      console.log(JSON.stringify(client.memory.getHostMemorySummary(hostAid), null, 2));
    }
    return;
  }

  if (cmd === 'flush-outbox') {
    const hostAid = positional[1] || TARGET_HOST_AID;
    if (!hostAid) {
      console.error('用法: node client_cli.js flush-outbox <hostAid>');
      process.exit(1);
    }
    const res = await client.flushPendingOutbox(hostAid);
    console.log(`📤 [跨机离线待发队列补发结果 (${hostAid})]:`);
    console.log(JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'mailbox') {
    const mails = checkClientMailbox(client.clientAid, { unreadOnly: false, markAsRead: true });
    console.log(`📬 [Client (${client.clientAid}) 收件箱] 共 ${mails.length} 封信件:`);
    console.log(JSON.stringify(mails, null, 2));
    return;
  }

  console.log(`Client 耳机 CLI 命令说明:
  node client_cli.js search-clue "<关键词>"                                   (陌生发现: 在链上按能力标签/线索搜 Host AID)
  node client_cli.js discover <hostAid>                                      (按已知 AID 解析并本地缓存长期固定 HTTPS)
  node client_cli.js set-intent <taskId> "<初衷>" [--budget 2500]            (立锚点: 生成本地《主人初衷卡》防忽悠)
  node client_cli.js chat <hostAid> "<消息>"                                 (机制二: 多轮连续会话)
  node client_cli.js task-chat <hostAid> <taskId> "<消息>" [--topic "主题"]   (机制一: 单任务多轮对话)
  node client_cli.js get <hostAid> [--task <taskId>|session]                 (改造版 GetTask: 物理隔离沙箱拉取)
  node client_cli.js list <hostAid>                                          (改造版 ListTasks: 会话与任务列表)
  node client_cli.js end-task <hostAid> <taskId> [--summary "极简档案结论"]   (改造版 CancelTask: 双端幂等结案与极简提纯)
  node client_cli.js recall-task <hostAid> <taskId> [--reason "原因"]        (按极简档案索引显式调阅已归档 Task 原始记录)
  node client_cli.js flush-outbox <hostAid>                                  (跨机重连补发: 将本机离线待发队列通过 HTTPS 补发给对方)
  node client_cli.js memory <hostAid> [--task <taskId>]                      (查看三层隔离记忆与 Top-K 极简档案)`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
