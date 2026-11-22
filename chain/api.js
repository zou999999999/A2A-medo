/**
 * Vercel Serverless & Local HTTP Entrypoint for the A2A Private Chain (chain/api.js)
 *
 * Security & Persistence Design:
 *   1. Authenticated Method B Persistence (`ANCHOR_HOST_URL` + `ANCHOR_SECRET` in Vercel Env):
 *      - Pulls/pushes ledger snapshots from/to the Anchor Host PC hard drive using `X-Anchor-Secret`.
 *   2. Ownership-Protected Sequential Registration (`POST /chain/register`):
 *      - New Agent -> Auto-assigned sequential AID (`2, 3, 4...`) + issued one-time `ownerSecret`.
 *      - Updating existing AID (`aid` or same `agentName`) -> Requires valid `X-Aid-Owner-Secret`
 *        (automatically stored & sent by `server/host_cli.js`) OR Admin `X-Chain-Admin-Key`.
 *      - Genesis `AID = "1"` -> STRICTLY requires `X-Chain-Admin-Key` matching `process.env.CHAIN_ADMIN_KEY`
 *        (NEVER reads privilege flags from request body!).
 */

const {
  safeEqual,
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
    'Access-Control-Allow-Headers': 'Content-Type, X-Chain-Admin-Key, X-Aid-Owner-Secret'
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

  // Method B: Pull/merge the latest ledger from the authenticated Anchor Host PC hard drive first
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
          'POST /chain/register -> 新用户自动按序分配 AID (2,3..) 并颁发 ownerSecret；更新已有 AID 需携带 X-Aid-Owner-Secret 请求头；修改 AID=1 需 X-Chain-Admin-Key',
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

  // 6. Register New Sequential AID (2, 3, 4...) OR Authenticated In-Place Update
  if (req.method === 'POST' && (pathname === '/chain/register' || pathname === '/chain/update' || pathname === '/chain/admin/commit')) {
    try {
      const body = await readJsonBody(req);
      if (!body.httpsEndpoint) {
        return sendJson(res, 400, { ok: false, error: 'httpsEndpoint is required' });
      }

      // Server-side Admin verification strictly from Vercel Environment Variable (ZERO hardcoded fallback!)
      const configuredAdminKey = process.env.CHAIN_ADMIN_KEY || null;
      const providedAdminKey = req.headers['x-chain-admin-key'] || '';
      const isAdmin = Boolean(configuredAdminKey && providedAdminKey && safeEqual(providedAdminKey, configuredAdminKey));

      const providedOwnerSecret = req.headers['x-aid-owner-secret'] || body.ownerSecret || '';

      const result = registerOrUpdateAIDOnLedger(ledger, {
        aid: body.aid,
        httpsEndpoint: body.httpsEndpoint,
        agentName: body.agentName,
        role: body.role || 'host',
        tags: body.tags,
        description: body.description,
        mailboxAddress: body.mailboxAddress,
        providedOwnerSecret,
        isAdmin
      });

      // Method B: Immediately push the updated ledger back to the Anchor Host PC hard drive!
      const persistedToAnchor = await pushLedgerToAnchorHost(ledger);

      return sendJson(res, 200, {
        ok: true,
        mode: result.isUpdate ? 'AID_ENDPOINT_UPDATED' : 'SEQUENTIAL_AID_MINTED',
        persistedToAnchorHost: persistedToAnchor,
        message: result.isUpdate
          ? `AID = ${result.assignedAid} 的 HTTPS 地址已通过所有权校验并原地更新 (Block #${result.block.blockNumber})`
          : `新 AID 注册成功！系统按顺序自动分配 AID = ${result.assignedAid} (Block #${result.block.blockNumber})，请妥善保存本次返回的 ownerSecret 用于后续更新临时隧道地址`,
        ...result
      });
    } catch (err) {
      const forbiddenCodes = new Set(['GENESIS_AID_PROTECTED', 'CHAIN_AID_OWNERSHIP_PROTECTED', 'INVALID_ARBITRARY_AID']);
      const status = forbiddenCodes.has(err.code) ? 403 : 500;
      return sendJson(res, status, {
        ok: false,
        errorCode: err.code || 'CHAIN_REGISTER_ERROR',
        message: err.message
      });
    }
  }

  return sendJson(res, 404, { ok: false, error: `Private chain route not found: ${req.method} ${pathname}` });
};
