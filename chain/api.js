/**
 * Vercel Serverless & Local HTTP Entrypoint for the A2A Private Chain (chain/api.js)
 *
 * Simplified & Persistent Design (Method B - PC Hard-Drive Anchor Sync):
 *   1. On every read/write, syncs with the Anchor Host's hard drive (`/chain-anchor/ledger`)
 *      so even if Vercel Serverless instances recycle `/tmp`, registered AIDs are restored automatically!
 *   2. Zero-Friction Registration & Temporary Tunnel Update (`POST /chain/register`):
 *      - New Agent -> Auto-assigned sequential AID (2, 3, 4...).
 *      - Existing Agent (e.g. Muse passing `{ aid: "2", httpsEndpoint: "https://new-temp-url" }`
 *        or `{ agentName: "muse", httpsEndpoint: "https://new-temp-url" }`) -> Directly updates
 *        that AID's `httpsEndpoint` in-place without requiring any password or secret key!
 */

const {
  syncLedgerFromAnchorHost,
  pushLedgerToAnchorHost,
  verifyChainIntegrity,
  registerOrUpdateAIDOnLedger,
  searchChainRecords
} = require('./chain_engine');

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(body);
}

function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return Promise.resolve(req.body);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const pathname = url.searchParams.get('__path') || url.pathname;

  // Method B: Always pull/merge the latest ledger from the Anchor Host PC hard drive first!
  const ledger = await syncLedgerFromAnchorHost();
  const integrity = verifyChainIntegrity(ledger);

  // 1. Root / Chain Explorer Overview
  if (req.method === 'GET' && (pathname === '/' || pathname === '/chain' || pathname === '/chain/status')) {
    return sendJson(res, 200, {
      chainId: ledger.chainId,
      chainName: ledger.chainName,
      consensus: ledger.consensus,
      nextSequentialAid: String(ledger.nextAidNumber),
      chainIntegrity: integrity,
      blockHeight: ledger.blockHeight,
      latestBlockHash: ledger.latestBlockHash,
      totalRegisteredAIDs: Object.keys(ledger.stateRecords).length,
      records: ledger.stateRecords,
      endpoints: {
        registerOrUpdateAID:
          'POST /chain/register (Body: { aid?, agentName, httpsEndpoint, tags?, description? }) -> 新用户自动按序分配 AID (2,3..)，老用户传 aid 或同名 agentName 直接原地更新临时隧道地址',
        resolveAID: 'GET /chain/resolve?aid=1',
        searchByClue: 'GET /chain/search?query=关键词',
        viewBlocks: 'GET /chain/blocks',
        verifyIntegrity: 'GET /chain/verify'
      }
    });
  }

  // 2. Resolve AID on-chain: GET /chain/resolve?aid=1
  if (req.method === 'GET' && pathname === '/chain/resolve') {
    const aid = url.searchParams.get('aid');
    if (!aid) {
      return sendJson(res, 400, { ok: false, error: 'Missing aid query parameter (?aid=1)' });
    }
    const record = ledger.stateRecords[String(aid)] || null;
    if (!record) {
      return sendJson(res, 404, { ok: false, found: false, aid, message: `AID ${aid} not found on private chain` });
    }
    return sendJson(res, 200, {
      ok: true,
      found: true,
      chainId: ledger.chainId,
      chainIntegrityValid: integrity.valid,
      record
    });
  }

  // 3. Search AIDs on-chain by capability tag / clue: GET /chain/search?query=...
  if (req.method === 'GET' && pathname === '/chain/search') {
    const query = url.searchParams.get('query') || '';
    const tag = url.searchParams.get('tag') || '';
    const candidates = searchChainRecords({ query, tag }, ledger);
    return sendJson(res, 200, {
      ok: true,
      chainId: ledger.chainId,
      chainIntegrityValid: integrity.valid,
      foundCount: candidates.length,
      query,
      tag,
      candidates
    });
  }

  // 4. View all immutable hash-chained blocks: GET /chain/blocks
  if (req.method === 'GET' && pathname === '/chain/blocks') {
    return sendJson(res, 200, {
      ok: true,
      chainId: ledger.chainId,
      chainIntegrity: integrity,
      blockHeight: ledger.blockHeight,
      blocks: ledger.blocks
    });
  }

  // 5. Cryptographic Hash Chain Verification: GET /chain/verify
  if (req.method === 'GET' && pathname === '/chain/verify') {
    return sendJson(res, 200, {
      ok: integrity.valid,
      chainId: ledger.chainId,
      ...integrity
    });
  }

  // 6. Register New Sequential AID (2, 3, 4...) OR In-Place Update of Temporary Tunnel URL
  if (req.method === 'POST' && (pathname === '/chain/register' || pathname === '/chain/update' || pathname === '/chain/admin/commit')) {
    try {
      const body = await readJsonBody(req);
      if (!body.httpsEndpoint) {
        return sendJson(res, 400, { ok: false, error: 'httpsEndpoint is required' });
      }

      const result = registerOrUpdateAIDOnLedger(ledger, {
        aid: body.aid,
        httpsEndpoint: body.httpsEndpoint,
        agentName: body.agentName,
        role: body.role || 'host',
        tags: body.tags,
        description: body.description,
        mailboxAddress: body.mailboxAddress,
        allowUpdateAid1: Boolean(body.allowUpdateAid1)
      });

      // Method B: Immediately push the updated ledger back to the Anchor Host PC hard drive!
      const persistedToAnchor = await pushLedgerToAnchorHost(ledger);

      return sendJson(res, 200, {
        ok: true,
        mode: result.isUpdate ? 'AID_ENDPOINT_UPDATED' : 'SEQUENTIAL_AID_MINTED',
        persistedToAnchorHost: persistedToAnchor,
        message: result.isUpdate
          ? `AID = ${result.assignedAid} 的 HTTPS 地址已原地更新为最新隧道地址 (Block #${result.block.blockNumber})，并同步写入主节点硬盘！`
          : `新 AID 注册成功！系统按顺序自动分配 AID = ${result.assignedAid} (Block #${result.block.blockNumber})，并同步写入主节点硬盘！`,
        ...result
      });
    } catch (err) {
      const status = err.code === 'GENESIS_AID_PROTECTED' ? 403 : 500;
      return sendJson(res, status, {
        ok: false,
        errorCode: err.code || 'CHAIN_REGISTER_ERROR',
        message: err.message
      });
    }
  }

  return sendJson(res, 404, { ok: false, error: `Private chain route not found: ${req.method} ${pathname}` });
};
