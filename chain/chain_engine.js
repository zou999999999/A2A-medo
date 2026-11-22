/**
 * Simplified Private Chain Engine with Host Hard-Drive Anchor Persistence (chain/chain_engine.js)
 *
 * Implements:
 *   1. Sequential Auto-Increment AID Minting (1 -> 2 -> 3 -> 4...):
 *      - New users registering for the first time automatically get the next integer AID.
 *   2. Zero-Friction In-Place Tunnel Update for Temporary Tunnels:
 *      - When an existing Agent restarts its temporary tunnel and sends `{ aid, httpsEndpoint }`
 *        or `{ agentName, httpsEndpoint }`, the chain directly updates that existing AID's
 *        `httpsEndpoint` in-place (appending a new block) without requiring any secret key ceremony.
 *   3. Method B Persistence (Sync with Anchor Host Hard Drive):
 *      - Every update on Vercel automatically syncs to the Anchor Host's local hard drive (`server/data/chain_ledger.json`).
 *      - Whenever a Vercel Serverless instance cold-starts or wakes up, it automatically pulls
 *        the latest ledger back from the Anchor Host's hard drive so registered AIDs are never lost.
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const LOCAL_ANCHOR_LEDGER_FILE = path.resolve(__dirname, '..', 'server', 'data', 'chain_ledger.json');
const TMP_LEDGER_FILE = path.join(os.tmpdir(), 'a2a_poa_private_chain_ledger.json');

// Anchor Host URL is configured strictly via Vercel Environment Variable `ANCHOR_HOST_URL`
// so zero host tunnel URLs ever appear in GitHub source files!
const ANCHOR_HOST_URL = process.env.ANCHOR_HOST_URL
  ? process.env.ANCHOR_HOST_URL.replace(/\/+$/, '')
  : null;

function sha256Hex(input) {
  return '0x' + crypto.createHash('sha256').update(String(input)).digest('hex');
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
    consensus: 'Append-Only SHA-256 Hash Chain (Sequential AID + PC Hard-Drive Anchor Sync)',
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
      fs.writeFileSync(LOCAL_ANCHOR_LEDGER_FILE, serialized, 'utf-8');
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
 * Method B: Pull latest ledger from the Anchor Host PC's hard drive (`GET /chain-anchor/ledger`)
 */
async function syncLedgerFromAnchorHost() {
  const localLedger = loadLedger();
  if (process.env.IS_LOCAL_ANCHOR_HOST === 'true' || !ANCHOR_HOST_URL) {
    return localLedger;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2500);
  try {
    const resp = await fetch(`${ANCHOR_HOST_URL}/chain-anchor/ledger`, {
      method: 'GET',
      headers: {
        'ngrok-skip-browser-warning': 'true',
        'bypass-tunnel-reminder': 'true'
      },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (resp.ok) {
      const data = await resp.json();
      if (data && data.ledger && data.ledger.blocks && data.ledger.stateRecords) {
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
 */
async function pushLedgerToAnchorHost(ledger) {
  saveLedger(ledger);
  if (process.env.IS_LOCAL_ANCHOR_HOST === 'true' || !ANCHOR_HOST_URL) {
    return false;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const resp = await fetch(`${ANCHOR_HOST_URL}/chain-anchor/ledger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'ngrok-skip-browser-warning': 'true',
        'bypass-tunnel-reminder': 'true'
      },
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
 * Cryptographically verify the SHA-256 hash chain
 */
function verifyChainIntegrity(ledger = loadLedger()) {
  const blocks = ledger.blocks || [];
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
 * Register a New Sequential AID (1 -> 2 -> 3...) OR Update an Existing AID's Temporary Tunnel URL
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
    allowUpdateAid1 = false
  }
) {
  if (!httpsEndpoint) {
    throw new Error('httpsEndpoint is required');
  }

  let targetAid = aid !== null && aid !== undefined && String(aid).trim() !== '' ? String(aid).trim() : null;

  if (!targetAid && agentName) {
    const cleanName = String(agentName).trim().toLowerCase();
    const matched = Object.values(ledger.stateRecords || {}).find(
      (r) => String(r.agentName || '').trim().toLowerCase() === cleanName
    );
    if (matched) {
      targetAid = String(matched.aid);
    }
  }

  if (targetAid === '1' && ledger.stateRecords['1'] && !allowUpdateAid1) {
    const err = new Error('AID 1 为创世主节点，外部节点请使用 AID 2 及后续号码进行注册或更新。');
    err.code = 'GENESIS_AID_PROTECTED';
    throw err;
  }

  const existing = targetAid ? ledger.stateRecords[targetAid] : null;
  const isUpdate = Boolean(existing);
  const assignedAid = targetAid || String(ledger.nextAidNumber || 1);

  const numAssigned = Number(assignedAid);
  if (Number.isFinite(numAssigned) && numAssigned >= (ledger.nextAidNumber || 1)) {
    ledger.nextAidNumber = numAssigned + 1;
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
    mailboxAddress: mailboxAddress !== undefined ? mailboxAddress : (existing ? existing.mailboxAddress : null)
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
    authority: `AID_${assignedAid}`,
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

  return {
    isUpdate,
    assignedAid,
    block: newBlock,
    record: ledger.stateRecords[assignedAid],
    chainHeight: ledger.blockHeight
  };
}

function registerNewSequentialAID(options) {
  const ledger = loadLedger();
  return registerOrUpdateAIDOnLedger(ledger, options);
}

function updateExistingAID(options) {
  const ledger = loadLedger();
  return registerOrUpdateAIDOnLedger(ledger, {
    ...options,
    allowUpdateAid1: Boolean(options.isAdmin)
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
  ANCHOR_HOST_URL,
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
