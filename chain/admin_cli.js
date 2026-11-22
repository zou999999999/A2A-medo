/**
 * Private Chain CLI (chain/admin_cli.js)
 *
 * Commands:
 *   - status                                         : View blocks, sequential nextAidNumber, and all AIDs
 *   - register <name> <httpsUrl> [--tags "a,b"]      : Public registration (auto-assigns sequential AID 2, 3, 4...)
 *   - admin-commit <aid> <name> <httpsUrl> [--tags]  : Admin-only override/update for any AID
 *   - reset-genesis                                  : Reset ledger back to empty Genesis state
 *   - verify                                         : Verify SHA-256 hash chain integrity
 */

const {
  createEmptyLedger,
  saveLedger,
  loadLedger,
  verifyChainIntegrity,
  registerNewSequentialAID,
  updateExistingAID
} = require('./chain_engine');

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

function main() {
  const { flags, positional } = parseFlags(process.argv.slice(2));
  const cmd = positional[0] || 'status';

  if (cmd === 'reset-genesis') {
    const empty = createEmptyLedger();
    saveLedger(empty);
    console.log('✅ 已重置私链账本状态');
    return;
  }

  if (cmd === 'verify') {
    const res = verifyChainIntegrity();
    console.log('⛓️  [私链哈希完整性校验结果]:', JSON.stringify(res, null, 2));
    return;
  }

  if (cmd === 'register') {
    const agentName = positional[1] || flags.name || 'New-Agent';
    const httpsEndpoint = positional[2] || flags.url;
    const tags = flags.tags ? flags.tags.split(',').map((s) => s.trim()) : ['通用协同'];
    const description = flags.desc || '个人Agent节点';

    if (!httpsEndpoint) {
      console.error('用法: node ./chain/admin_cli.js register <名称> <httpsUrl> [--tags "标签1,标签2"]');
      process.exit(1);
    }

    const res = registerNewSequentialAID({
      agentName,
      httpsEndpoint,
      tags,
      description
    });
    console.log(`✅ [按序注册新 AID 成功 —— Block #${res.block.blockNumber}]`);
    console.log(`   • 自动分配 AID         : ${res.assignedAid}`);
    console.log(`   • 专属所有权凭证(请保存): ${res.ownerSecret}`);
    console.log(`   • 区块哈希 (blockHash) : ${res.block.blockHash}`);
    console.log(`   • 前序哈希 (prevHash)  : ${res.block.prevBlockHash}`);
    return;
  }

  if (cmd === 'admin-commit' || cmd === 'commit') {
    const aid = positional[1] || flags.aid;
    const agentName = positional[2] || flags.name || aid;
    const httpsEndpoint = positional[3] || flags.url;
    const tags = flags.tags ? flags.tags.split(',').map((s) => s.trim()) : ['香港差旅', '机票酒店', '会议安排'];
    const description = flags.desc || '个人Agent宿主节点';

    if (!aid || !httpsEndpoint) {
      console.error('用法: node ./chain/admin_cli.js admin-commit <aid> <name> <httpsUrl> [--tags "标签1,标签2"]');
      process.exit(1);
    }

    const res = updateExistingAID({
      aid,
      agentName,
      httpsEndpoint,
      tags,
      description,
      isAdmin: true
    });
    console.log(`✅ [管理员成功出块 Block #${res.block.blockNumber}]`);
    console.log(`   • 区块哈希 (blockHash) : ${res.block.blockHash}`);
    console.log(`   • 链上绑定记录         : AID=${res.record.aid} (${res.record.agentName}) -> ${res.record.httpsEndpoint}`);
    return;
  }

  const ledger = loadLedger();
  const integrity = verifyChainIntegrity(ledger);
  console.log(`⛓️  [${ledger.chainName}]`);
  console.log(`   • 区块高度       : ${ledger.blockHeight} | 下一个排号 AID: ${ledger.nextAidNumber}`);
  console.log(`   • 哈希链完整性   : ${integrity.valid ? '✅ VALID' : '❌ BROKEN'}`);
  console.log(`   • 最新块哈希     : ${ledger.latestBlockHash}`);
  console.log(`   • 链上已注册 AID :`);
  console.log(JSON.stringify(ledger.stateRecords, null, 2));
}

main();
