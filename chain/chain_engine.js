/**
 * Private Chain Engine with Authenticated Host Hard-Drive Anchor Persistence (chain/chain_engine.js)
 *
 * Security & Governance Model:
 *   1. Sequential Auto-Increment AID Minting (1 -> 2 -> 3 -> 4...):
 *      - New users registering for the first time automatically get the next integer AID,
 *        receive a unique one-time `ownerSecret` (only its SHA-256 `ownerKeyHash` is stored on-chain).
 *   2. Protected In-Place Tunnel Updates:
 *      - Genesis `AID = "1"` can ONLY be updated with valid `X-Chain-Admin-Key` (Vercel env `CHAIN_ADMIN_KEY`).
 *      - Any existing AID (`2, 3, ...`) can ONLY be updated by providing its matching `X-Aid-Owner-Secret`
 *        (automatically saved & sent by `server/host_cli.js`) OR `X-Chain-Admin-Key`.
 *   3. Authenticated Method B Persistence (Sync with Anchor Host Hard Drive):
 *      - Configured strictly via Vercel env vars `ANCHOR_HOST_URL` and `ANCHOR_SECRET`.
 *      - All `/chain-anchor/ledger` requests authenticate via `X-Anchor-Secret`.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const LOCAL_ANCHOR_LEDGER_FILE = process.env.LOCAL_CHAIN_LEDGER_FILE
  ? path.resolve(process.env.LOCAL_CHAIN_LEDGER_FILE)
  : path.resolve(__dirname, '..', 'server', 'data', 'chain_ledger.json');
const TMP_LEDGER_FILE = path.join(os.tmpdir(), 'a2a_poa_private_chain_ledger.json');

function getAnchorHostUrl() {
  return process.env.ANCHOR_HOST_URL ? process.env.ANCHOR_HOST_URL.replace(/\/+$/, '') : null;
}

function getAnchorSecret() {
  return process.env.ANCHOR_SECRET || '';
}

function sha256Hex(input) {
  return '0x' + crypto.createHash('sha256').update(String(input)).digest('hex');
}

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  if (bufA.length === 0 || bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function computeBlockHash({ blockNumber, prevBlockHash, timestamp, txHash, action, payload }) {
  const canonical = JSON.stringify({
    blockNumber,
    prevBlockHash,
    timestamp,
    txHash,
    action,
    payload
  });
  return sha256Hex(canonical);
}

function createEmptyLedger() {
  const genesisTimestamp = '2026-11-22T00:00:00.000Z';
  return {
    chainId: 'a2a-private-chain-v1',
    chainName: 'A2A Sequential-AID Private Chain',
    consensus: 'Append-Only SHA-256 Hash Chain (Sequential AID + OwnerSecret/Admin Guard + Authenticated Anchor Sync)',
    createdAt: genesisTimestamp,
    nextAidNumber: 1,
    blockHeight: 0,
    latestBlockHash: '0x0000000000000000000000000000000000000000000000000000000000000000',
    blocks: [],
    stateRecords: {}
  };
}

function saveLedger(ledger) {
  const serialized = JSON.stringify(ledger, null, 2);
  let savedToLocalAnchor = false;
  try {
    if (fs.existsSync(path.dirname(LOCAL_ANCHOR_LEDGER_FILE))) {
      const tmp = `${LOCAL_ANCHOR_LEDGER_FILE}.tmp.${process.pid}.${Date.now()}`;
      fs.writeFileSync(tmp, serialized, 'utf-8');
      fs.renameSync(tmp, LOCAL_ANCHOR_LEDGER_FILE);
      savedToLocalAnchor = true;
    }
  } catch {
    // In Vercel Serverless, fall through to TMP_LEDGER_FILE
  }
  try {
    fs.writeFileSync(TMP_LEDGER_FILE, serialized, 'utf-8');
  } catch {
    // ignore
  }
  return savedToLocalAnchor;
}

function pickNewerLedger(a, b) {
  if (!a) return b;
  if (!b) return a;
  const hA = Number(a.blockHeight || (a.blocks ? a.blocks.length : 0));
  const hB = Number(b.blockHeight || (b.blocks ? b.blocks.length : 0));
  if (hA !== hB) return hB > hA ? b : a;
  const countA = Object.keys(a.stateRecords || {}).length;
  const countB = Object.keys(b.stateRecords || {}).length;
  return countB >= countA ? b : a;
}

function loadLedger() {
  let anchorLedger = null;
  let tmpLedger = null;

  try {
    if (fs.existsSync(LOCAL_ANCHOR_LEDGER_FILE)) {
      const raw = fs.readFileSync(LOCAL_ANCHOR_LEDGER_FILE, 'utf-8');
      if (raw.trim()) anchorLedger = JSON.parse(raw);
    }
  } catch {
    // ignore
  }

  try {
    if (fs.existsSync(TMP_LEDGER_FILE)) {
      const raw = fs.readFileSync(TMP_LEDGER_FILE, 'utf-8');
      if (raw.trim()) tmpLedger = JSON.parse(raw);
    }
  } catch {
    // ignore
  }

  let active = pickNewerLedger(anchorLedger, tmpLedger);

  if (!active || !active.blocks || !active.stateRecords) {
    active = createEmptyLedger();
  }

  const numericIds = Object.keys(active.stateRecords)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n));
  const computedNext = numericIds.length > 0 ? Math.max(...numericIds) + 1 : 1;
  if (!active.nextAidNumber || active.nextAidNumber < computedNext) {
    active.nextAidNumber = computedNext;
  }

  return active;
}

/**
 * Cryptographically verify the SHA-256 hash chain from Genesis Block #0 to latest block
 */
function verifyChainIntegrity(ledger = loadLedger()) {
  const blocks = ledger && Array.isArray(ledger.blocks) ? ledger.blocks : null;
  if (!blocks) {
    return { valid: false, reason: 'Invalid ledger: missing blocks array' };
  }
  if (blocks.length === 0) {
    return { valid: true, verifiedBlocks: 0, nextSequentialAid: '1' };
  }

  const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const expectedPrev = i === 0 ? zeroHash : blocks[i - 1].blockHash;
    if (b.prevBlockHash !== expectedPrev) {
      return {
        valid: false,
        brokenAtBlock: i,
        reason: `Block #${i} prevBlockHash mismatch (expected ${expectedPrev}, got ${b.prevBlockHash})`
      };
    }
    const recomputedHash = computeBlockHash({
      blockNumber: b.blockNumber,
      prevBlockHash: b.prevBlockHash,
      timestamp: b.timestamp,
      txHash: b.txHash,
      action: b.action,
      payload: b.payload
    });
    if (b.blockHash !== recomputedHash) {
      return {
        valid: false,
        brokenAtBlock: i,
        reason: `Block #${i} hash tampered! (expected ${recomputedHash}, got ${b.blockHash})`
      };
    }
  }

  return {
    valid: true,
    verifiedBlocks: blocks.length,
    nextSequentialAid: String(ledger.nextAidNumber || blocks.length + 1),
    genesisBlockHash: blocks[0].blockHash,
    latestBlockHash: blocks[blocks.length - 1].blockHash
  };
}

/**
 * Method B: Pull latest ledger from the Anchor Host PC's hard drive (`GET /chain-anchor/ledger`)
 * Authenticated via `X-Anchor-Secret`.
 */
async function syncLedgerFromAnchorHost() {
  const localLedger = loadLedger();
  const anchorUrl = getAnchorHostUrl();
  const anchorSecret = getAnchorSecret();
  if (process.env.IS_LOCAL_ANCHOR_HOST === 'true' || !anchorUrl) {
    return localLedger;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const headers = {
      'ngrok-skip-browser-warning': 'true',
      'bypass-tunnel-reminder': 'true'
    };
    if (anchorSecret) headers['x-anchor-secret'] = anchorSecret;

    const resp = await fetch(`${anchorUrl}/chain-anchor/ledger`, {
      method: 'GET',
      headers,
      signal: controller.signal
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.ledger && verifyChainIntegrity(data.ledger).valid) {
        const merged = pickNewerLedger(localLedger, data.ledger);
        saveLedger(merged);
        return merged;
      }
    }
  } catch {
    clearTimeout(timer);
  }
  return localLedger;
}

/**
 * Method B: Push updated ledger back to the Anchor Host PC's hard drive (`POST /chain-anchor/ledger`)
 * Authenticated via `X-Anchor-Secret`.
 */
async function pushLedgerToAnchorHost(ledger) {
  saveLedger(ledger);
  const anchorUrl = getAnchorHostUrl();
  const anchorSecret = getAnchorSecret();
  if (process.env.IS_LOCAL_ANCHOR_HOST === 'true' || !anchorUrl) {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const headers = {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      'bypass-tunnel-reminder': 'true'
    };
    if (anchorSecret) headers['x-anchor-secret'] = anchorSecret;

    const resp = await fetch(`${anchorUrl}/chain-anchor/ledger`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ledger }),
      signal: controller.signal
    });
    clearTimeout(timer);
    return resp.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}

/**
 * Register a New Sequential AID (1 -> 2 -> 3...) OR Update an Existing AID with Ownership/Admin Guard
 *
 * Governance Rules:
 *   - New registration (no existing `aid` and no existing `agentName`):
 *       Auto-assigns next sequential AID, generates a one-time `ownerSecret`,
 *       stores ONLY `ownerKeyHash = sha256Hex(ownerSecret)` on-chain, and returns `ownerSecret` once.
 *   - Updating Genesis `AID = "1"`:
 *       Requires `isAdmin === true` (authenticated via `X-Chain-Admin-Key`).
 *   - Updating ANY existing AID (`2, 3, ...`, whether by `aid` or matching `agentName`):
 *       Requires `isAdmin === true` OR `sha256Hex(providedOwnerSecret) === existing.ownerKeyHash`.
 */
function registerOrUpdateAIDOnLedger(
  ledger,
  {
    aid = null,
    httpsEndpoint,
    agentName = '',
    role = 'host',
    tags = null,
    description = '',
    mailboxAddress = null,
    providedOwnerSecret = '',
    isAdmin = false
  }
) {
  if (!httpsEndpoint) {
    throw new Error('httpsEndpoint is required');
  }

  let targetAid = aid !== null && aid !== undefined && String(aid).trim() !== '' ? String(aid).trim() : null;

  // Check if agentName matches an existing record (e.g. Muse re-updating its temporary tunnel URL)
  if (!targetAid && agentName) {
    const cleanName = String(agentName).trim().toLowerCase();
    const matched = Object.values(ledger.stateRecords || {}).find(
      (r) => String(r.agentName || '').trim().toLowerCase() === cleanName
    );
    if (matched) {
      targetAid = String(matched.aid);
    }
  }

  const existing = targetAid ? ledger.stateRecords[targetAid] : null;

  // 1. Strict Genesis AID = 1 Protection (Server-side `isAdmin` ONLY; never read from request body!)
  if (targetAid === '1' && existing && !isAdmin) {
    const err = new Error('权限拒绝：AID 1 为创世主节点，仅携带有效管理员凭证 (X-Chain-Admin-Key) 方可修改！');
    err.code = 'GENESIS_AID_PROTECTED';
    throw err;
  }

  // 2. Strict Ownership Protection for ANY existing AID (prevents hijacking by aid OR same agentName)
  if (existing && !isAdmin) {
    const providedHash = providedOwnerSecret ? sha256Hex(providedOwnerSecret) : '';
    if (!existing.ownerKeyHash || !providedOwnerSecret || !safeEqual(providedHash, existing.ownerKeyHash)) {
      const err = new Error(
        `权限拒绝：AID ${targetAid} (${existing.agentName}) 已注册且受所有权保护！更新地址必须提供首次注册时颁发的 X-Aid-Owner-Secret 或管理员凭证 X-Chain-Admin-Key。`
      );
      err.code = 'CHAIN_AID_OWNERSHIP_PROTECTED';
      throw err;
    }
  }

  // Disallow non-admins from inventing arbitrary nonexistent AIDs (must register sequentially without specifying `aid`)
  if (targetAid && !existing && !isAdmin) {
    const err = new Error(
      `非法请求：AID ${targetAid} 尚未注册。新用户请不要手填 aid，直接注册以获取系统按顺序分配的下一个 AID (${ledger.nextAidNumber || 1})。`
    );
    err.code = 'INVALID_ARBITRARY_AID';
    throw err;
  }

  const isUpdate = Boolean(existing);
  const assignedAid = targetAid || String(ledger.nextAidNumber || 1);

  const numAssigned = Number(assignedAid);
  if (Number.isFinite(numAssigned) && numAssigned >= (ledger.nextAidNumber || 1)) {
    ledger.nextAidNumber = numAssigned + 1;
  }

  // Issue a new one-time ownerSecret ONLY on brand-new registration
  let issuedOwnerSecret = null;
  let ownerKeyHash = existing ? existing.ownerKeyHash : null;
  if (!isUpdate) {
    issuedOwnerSecret = providedOwnerSecret || `aid_${assignedAid}_${crypto.randomBytes(16).toString('hex')}`;
    ownerKeyHash = sha256Hex(issuedOwnerSecret);
  }

  const zeroHash = '0x0000000000000000000000000000000000000000000000000000000000000000';
  const prevBlock = ledger.blocks.length > 0 ? ledger.blocks[ledger.blocks.length - 1] : null;
  const blockNumber = prevBlock ? prevBlock.blockNumber + 1 : 0;
  const prevBlockHash = prevBlock ? prevBlock.blockHash : zeroHash;
  const timestamp = new Date().toISOString();
  const action = blockNumber === 0 ? 'GENESIS_MINT_AID' : (isUpdate ? 'UPDATE_AID_ENDPOINT' : 'MINT_SEQUENTIAL_AID');

  const parsedTags = Array.isArray(tags)
    ? tags
    : typeof tags === 'string' && tags.trim()
      ? tags.split(',').map((s) => s.trim()).filter(Boolean)
      : existing
        ? existing.tags
        : ['通用协同'];

  const payload = {
    aid: assignedAid,
    role: role || (existing ? existing.role : 'host'),
    agentName: agentName || (existing ? existing.agentName : `Agent-${assignedAid}`),
    tags: parsedTags,
    description: description || (existing ? existing.description : '个人Agent节点'),
    httpsEndpoint: String(httpsEndpoint).replace(/\/+$/, ''),
    mailboxAddress: mailboxAddress !== undefined ? mailboxAddress : (existing ? existing.mailboxAddress : null),
    ownerKeyHash
  };

  const txHash = sha256Hex(`${action}:${blockNumber}:${payload.aid}:${payload.httpsEndpoint}:${timestamp}`);
  const blockHash = computeBlockHash({
    blockNumber,
    prevBlockHash,
    timestamp,
    txHash,
    action,
    payload
  });

  const newBlock = {
    blockNumber,
    prevBlockHash,
    blockHash,
    timestamp,
    txHash,
    authority: isAdmin ? 'CHAIN_ADMIN' : `AID_${assignedAid}`,
    action,
    payload
  };

  ledger.blocks.push(newBlock);
  ledger.blockHeight = ledger.blocks.length;
  ledger.latestBlockHash = blockHash;
  ledger.stateRecords[assignedAid] = {
    ...payload,
    blockNumber,
    txHash,
    blockHash,
    updatedAt: timestamp
  };

  saveLedger(ledger);

  const response = {
    isUpdate,
    assignedAid,
    block: newBlock,
    record: ledger.stateRecords[assignedAid],
    chainHeight: ledger.blockHeight
  };
  if (issuedOwnerSecret) {
    response.ownerSecret = issuedOwnerSecret;
  }
  return response;
}

function registerNewSequentialAID(options) {
  const ledger = loadLedger();
  return registerOrUpdateAIDOnLedger(ledger, options);
}

function updateExistingAID(options) {
  const ledger = loadLedger();
  return registerOrUpdateAIDOnLedger(ledger, {
    ...options,
    isAdmin: Boolean(options.isAdmin)
  });
}

function searchChainRecords({ query = '', tag = '' } = {}, customLedger = null) {
  const ledger = customLedger || loadLedger();
  const all = Object.values(ledger.stateRecords || {});
  const q = String(query || '').trim().toLowerCase();
  const t = String(tag || '').trim().toLowerCase();

  return all.filter((rec) => {
    const recTags = (rec.tags || []).map((x) => String(x).toLowerCase());
    const haystack = `${rec.aid} ${rec.agentName} ${rec.description || ''} ${recTags.join(' ')}`.toLowerCase();
    const matchQuery = !q || haystack.includes(q);
    const matchTag = !t || recTags.some((rt) => rt.includes(t));
    return matchQuery && matchTag;
  });
}

module.exports = {
  LOCAL_ANCHOR_LEDGER_FILE,
  TMP_LEDGER_FILE,
  getAnchorHostUrl,
  getAnchorSecret,
  sha256Hex,
  safeEqual,
  computeBlockHash,
  createEmptyLedger,
  saveLedger,
  loadLedger,
  syncLedgerFromAnchorHost,
  pushLedgerToAnchorHost,
  verifyChainIntegrity,
  registerOrUpdateAIDOnLedger,
  registerNewSequentialAID,
  updateExistingAID,
  searchChainRecords
};
