/**
 * Host Headset CLI Controller (server/host_cli.js)
 * Commands:
 *   - publish-aid [httpsUrl] [--tags "标签1,标签2"] [--desc "描述"]
 *   - drop-mailbox <clientAid> [httpsUrl]
 *   - inbox
 *   - reply <clientAid> "<内容>" [--task id] [--type chat|counter_question|proposal] [--price 2000] [--provider "东航"]
 *   - cancel-task <clientAid> <taskId> [--outcome completed|cancelled] [--summary "..."]
 *   - memory [clientAid] [--task id]
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  registerAIDOnChain,
  sendToMailbox,
  checkMailbox
} = require('./discovery_store');
const { HostMemoryStore } = require('./memory_store');

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
const PORT = Number(process.env.PORT || 3100);
const PUBLIC_HTTPS_URL = (process.env.PUBLIC_HTTPS_URL || savedIdentity.httpsEndpoint || `http://127.0.0.1:${PORT}`).replace(/\/+$/, '');
const DEFAULT_PRIVATE_CHAIN_URL = process.env.PRIVATE_CHAIN_URL || 'https://a2a-medo.vercel.app';

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
  const memoryStore = new HostMemoryStore(HOST_AID);

  if (cmd === 'register-chain' || cmd === 'update-chain') {
    const targetAid = flags.aid || savedIdentity.aid || null;
    const newName = flags.name || positional[1] || savedIdentity.name || HOST_NAME;
    const newUrl = flags.url || positional[2] || PUBLIC_HTTPS_URL;
    const newTags = flags.tags
      ? flags.tags.split(',').map((s) => s.trim())
      : (savedIdentity.tags || []);
    const newDesc = flags.desc || savedIdentity.description || '个人Agent节点';

    const resp = await fetch(`${DEFAULT_PRIVATE_CHAIN_URL}/chain/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        aid: targetAid && targetAid !== 'unregistered-host' ? targetAid : undefined,
        agentName: newName,
        httpsEndpoint: newUrl,
        tags: newTags,
        description: newDesc
      })
    });
    const data = await resp.json();
    if (!resp.ok || !data.ok) {
      console.error('❌ 链上注册/更新失败:', data.message || data.error || resp.status);
      process.exit(1);
    }

    if (!fs.existsSync(path.dirname(IDENTITY_FILE))) {
      fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    }
    const identityObj = {
      aid: data.assignedAid,
      name: newName,
      tags: newTags,
      description: newDesc,
      httpsEndpoint: newUrl,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identityObj, null, 2), 'utf-8');
    console.log(`✅ [${data.isUpdate ? '链上临时隧道地址原地更新成功' : '链上按序注册成功'} —— Block #${data.block.blockNumber}]`);
    console.log(`   • 节点 AID     : ${data.assignedAid}`);
    console.log(`   • 节点名称     : ${newName}`);
    console.log(`   • 最新 HTTPS   : ${newUrl}`);
    console.log(`   • 主节点硬盘同步: ${data.persistedToAnchorHost ? '✅ 已永久同步至主节点电脑硬盘' : '⚠️ 已存入私链内存'}`);
    return;
  }

  if (cmd === 'set-identity') {
    const newAid = flags.aid || positional[1] || HOST_AID;
    const newName = flags.name || positional[2] || HOST_NAME;
    const newTags = flags.tags
      ? flags.tags.split(',').map((s) => s.trim())
      : (savedIdentity.tags || []);
    const newDesc = flags.desc || savedIdentity.description || '个人Agent宿主节点';
    const newUrl = flags.url || PUBLIC_HTTPS_URL;

    if (!fs.existsSync(path.dirname(IDENTITY_FILE))) {
      fs.mkdirSync(path.dirname(IDENTITY_FILE), { recursive: true });
    }
    let ngrokDomain = savedIdentity.ngrokDomain || null;
    try {
      const parsed = new URL(newUrl);
      if (parsed.hostname.includes('ngrok')) ngrokDomain = parsed.hostname;
    } catch {
      // ignore
    }
    const identityObj = {
      aid: newAid,
      name: newName,
      tags: newTags,
      description: newDesc,
      httpsEndpoint: newUrl,
      ngrokDomain,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(IDENTITY_FILE, JSON.stringify(identityObj, null, 2), 'utf-8');
    const rec = registerAIDOnChain({
      aid: newAid,
      httpsEndpoint: newUrl,
      agentName: newName,
      role: 'host',
      tags: newTags,
      description: newDesc
    });
    console.log(`✅ [Host 身份已定制并永久保存]`);
    console.log(`   • 自定义 AID   : ${rec.aid}`);
    console.log(`   • 自定义名称   : ${rec.agentName}`);
    console.log(`   • 能力标签线索 : [${rec.tags.join(', ')}]`);
    console.log(`   • 绑定 HTTPS   : ${rec.httpsEndpoint}`);
    return;
  }

  if (cmd === 'publish-aid') {
    const url = positional[1] || flags.url || PUBLIC_HTTPS_URL;
    const tags = flags.tags ? flags.tags.split(',').map((s) => s.trim()) : (savedIdentity.tags || []);
    const rec = registerAIDOnChain({
      aid: HOST_AID,
      httpsEndpoint: url,
      agentName: HOST_NAME,
      role: 'host',
      tags,
      description: flags.desc || '个人Agent宿主节点'
    });
    console.log(`✅ [链上 AID 注册成功] AID: ${rec.aid} | 标签: [${rec.tags.join(', ')}] -> 长期 HTTPS: ${rec.httpsEndpoint}`);
    return;
  }

  if (cmd === 'drop-mailbox') {
    const toClientAid = positional[1] || flags.to;
    const url = positional[2] || flags.url || PUBLIC_HTTPS_URL;
    if (!toClientAid) {
      console.error('用法: node host_cli.js drop-mailbox <clientAid> [httpsUrl]');
      process.exit(1);
    }
    const mail = sendToMailbox({
      toAid: toClientAid,
      fromAid: HOST_AID,
      type: 'ENDPOINT_DELIVERY',
      httpsEndpoint: url,
      payload: {
        note: flags.note || `Host (${HOST_AID}) 已将最新 HTTPS 访问地址投递至您的收件箱`
      }
    });
    console.log(`📬 [邮箱投递成功] 已将 HTTPS 地址 (${url}) 投递至 ${toClientAid} 的收件箱 (MailID: ${mail.mailId})`);
    return;
  }

  if (cmd === 'inbox') {
    const unreadMails = checkMailbox(HOST_AID, { unreadOnly: true, markAsRead: true });
    for (const mail of unreadMails) {
      if (mail.type === 'OFFLINE_MESSAGE' && mail.payload?.text) {
        memoryStore.appendMessage({
          peerAid: mail.fromAid,
          peerEndpoint: mail.httpsEndpoint,
          senderAid: mail.fromAid,
          role: 'client',
          mode: mail.payload.mode || 'session',
          taskId: mail.payload.taskId || null,
          topic: mail.payload.topic || null,
          text: mail.payload.text,
          msgId: mail.payload.msgId || null,
          viaOfflineMailbox: true
        });
      }
    }

    const unread = memoryStore.getUnreadForHost();
    const conversations = memoryStore.listConversations();
    console.log(`🎧 [Host 耳机收件箱 (${HOST_AID})] 未读消息: ${unread.length} 条 | 会话总数: ${conversations.length}`);
    for (const m of unread) {
      console.log(`  🔔 [${m.mode === 'session' ? '连续会话' : `任务:${m.taskId}`}] ${m.senderAid}: "${m.text}" (${m.timestamp})`);
    }
    return;
  }

  if (cmd === 'reply') {
    const toAid = positional[1] || flags.to;
    const text = positional[2] || flags.text;
    const taskId = flags.task || null;
    const mode = taskId ? 'task' : (flags.mode || 'session');
    const messageType = flags.type || 'chat';
    const proposal =
      flags.price || flags.provider
        ? {
            price: flags.price ? Number(flags.price) : null,
            provider: flags.provider || null,
            requiresOwnerConfirm: flags.confirm === 'true'
          }
        : null;

    if (!toAid || !text) {
      console.error('用法: node host_cli.js reply <clientAid> "<内容>" [--task <taskId>] [--type counter_question|proposal]');
      process.exit(1);
    }

    try {
      const resp = await fetch(`http://127.0.0.1:${PORT}/host/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toAid, mode, taskId, text, messageType, proposal })
      });
      if (resp.ok) {
        const data = await resp.json();
        console.log(`🗣️  [Host 已通过运行中耳机回复(${messageType})] -> ${toAid} (${data.mode}/${data.taskId}) 第 ${data.message.seq} 轮: "${text}"`);
        return;
      }
    } catch {
      // Offline fallback
    }

    memoryStore.getConversation({ peerAid: toAid, mode, taskId, markReadByHost: true });
    const rec = memoryStore.appendMessage({
      peerAid: toAid,
      senderAid: HOST_AID,
      role: 'host',
      mode,
      taskId,
      text,
      messageType,
      proposal
    });
    sendToMailbox({
      toAid,
      fromAid: HOST_AID,
      type: 'HOST_REPLY_NOTICE',
      httpsEndpoint: PUBLIC_HTTPS_URL,
      payload: {
        mode,
        taskId: mode === 'task' ? rec.thread.taskId : 'session',
        msgId: rec.message.msgId,
        seq: rec.message.seq,
        messageType,
        proposal,
        text
      }
    });
    console.log(`🗣️  [Host 已写入本地记忆与对方收件箱] -> ${toAid} (${mode}) 第 ${rec.message.seq} 轮: "${text}"`);
    return;
  }

  if (cmd === 'cancel-task') {
    const peerAid = positional[1] || flags.peer;
    const taskId = positional[2] || flags.task;
    if (!peerAid || !taskId) {
      console.error('用法: node host_cli.js cancel-task <clientAid> <taskId> [--outcome completed|cancelled] [--summary "..."]');
      process.exit(1);
    }
    const closed = memoryStore.closeTask({
      peerAid,
      taskId,
      initiatedBy: 'host',
      outcome: flags.outcome || 'completed',
      reason: flags.reason || '',
      summary: flags.summary || ''
    });
    console.log(JSON.stringify(closed, null, 2));
    return;
  }

  if (cmd === 'memory') {
    const peerAid = positional[1] || flags.peer;
    if (peerAid) {
      console.log(
        JSON.stringify(
          memoryStore.buildMemoryContext(peerAid, {
            recentSessionTurns: 10,
            currentTaskId: flags.task || null,
            queryText: flags.query || ''
          }),
          null,
          2
        )
      );
    } else {
      console.log(JSON.stringify(memoryStore.listConversations(), null, 2));
    }
    return;
  }

  console.log(`Host 耳机 CLI 命令说明:
  node host_cli.js publish-aid [httpsUrl] [--tags "标签1,标签2"]         将 Host 长期 HTTPS 端口与能力标签绑定到链上 AID
  node host_cli.js drop-mailbox <clientAid> [httpsUrl]                  将 HTTPS 地址直接投递到 Client 的收件箱
  node host_cli.js inbox                                                查看收件箱、同步关机期间的离线留言
  node host_cli.js reply <clientAid> "<内容>" [--task id] [--type ...]  在同一 taskId 内回复或发起反问(counter_question)
  node host_cli.js cancel-task <clientAid> <taskId> [--summary "..."]   Host 端主动幂等完结/关闭任务并提炼极简档案
  node host_cli.js memory [clientAid] [--task id]                       查看沙箱隔离后的对话记忆与 Top-K 极简档案`);
}

main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
