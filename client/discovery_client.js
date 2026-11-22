/**
 * Dual-Track Discovery & Mailbox Client (client/discovery_client.js)
 *
 * Solves:
 *   1. Stranger Discovery via Clues/Tags on-chain (`searchHostsByClueOnChain`):
 *      When Client and Host are complete strangers, Client searches the On-Chain AID Registry
 *      by capability tags or task keywords -> discovers Host's AID and its long-term fixed HTTPS endpoint!
 *   2. Direct AID Resolution (`findHostByOnChainAID`) & Mailbox Discovery (`findHostFromMailbox`).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_NETWORK_DIR = process.env.NETWORK_STATE_DIR
  ? path.resolve(process.env.NETWORK_STATE_DIR)
  : path.resolve(__dirname, '..', '.network_state');

const CHAIN_REGISTRY_FILE = path.join(DEFAULT_NETWORK_DIR, 'onchain_aid_registry.json');
const MAILBOX_STORE_FILE = path.join(DEFAULT_NETWORK_DIR, 'mailbox_store.json');
const PRIVATE_CHAIN_URL_FILE = path.resolve(__dirname, 'data', 'chain_url.json');
const DEFAULT_PRIVATE_CHAIN_URL = 'https://a2a-medo.vercel.app';

function getConfiguredPrivateChainUrl() {
  if (process.env.PRIVATE_CHAIN_URL !== undefined) {
    const trimmed = process.env.PRIVATE_CHAIN_URL.trim().replace(/\/+$/, '');
    return trimmed || null;
  }
  try {
    if (fs.existsSync(PRIVATE_CHAIN_URL_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(PRIVATE_CHAIN_URL_FILE, 'utf-8'));
      if (cfg.privateChainUrl) return cfg.privateChainUrl.replace(/\/+$/, '');
    }
  } catch {
    // ignore
  }
  return DEFAULT_PRIVATE_CHAIN_URL;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    return raw.trim() ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonSafe(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tmpFile = `${filePath}.tmp.${process.pid}.${Date.now()}_${crypto.randomBytes(2).toString('hex')}`;
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpFile, filePath);
}

function loadMergedOnChainRecords() {
  const localReg = readJsonSafe(CHAIN_REGISTRY_FILE, { records: {} });
  return {
    ...(localReg.records || {})
  };
}

/**
 * Step 0 for Complete Strangers:
 * Search the On-Chain AID Registry by capability tag or keyword clue to find matching Host AIDs!
 */
function searchHostsByClueOnChain({ query = '', tag = '' } = {}) {
  const all = Object.values(loadMergedOnChainRecords());
  const q = String(query || '').trim().toLowerCase();
  const t = String(tag || '').trim().toLowerCase();

  const matches = all.filter((rec) => {
    const recTags = (rec.tags || []).map((x) => String(x).toLowerCase());
    const haystack = `${rec.aid} ${rec.agentName} ${rec.description || ''} ${recTags.join(' ')}`.toLowerCase();
    const matchQuery = !q || haystack.includes(q);
    const matchTag = !t || recTags.some((rt) => rt.includes(t));
    return matchQuery && matchTag;
  });

  return {
    foundCount: matches.length,
    query,
    tag,
    candidates: matches
  };
}

/**
 * Remote Private Chain HTTP Lookup (Queries Vercel PoA Private Chain when PRIVATE_CHAIN_URL is configured)
 */
async function searchHostsByClueFromRemoteChain({ query = '', tag = '', chainUrl = null } = {}) {
  const targetChainUrl = (chainUrl || getConfiguredPrivateChainUrl() || '').replace(/\/+$/, '');
  if (!targetChainUrl) {
    return searchHostsByClueOnChain({ query, tag });
  }
  const params = new URLSearchParams();
  if (query) params.set('query', query);
  if (tag) params.set('tag', tag);
  const res = await fetch(`${targetChainUrl}/chain/search?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`Remote Private Chain returned HTTP ${res.status}`);
  }
  return await res.json();
}

async function findHostByRemoteChainAID(hostAid, { chainUrl = null } = {}) {
  const targetChainUrl = (chainUrl || getConfiguredPrivateChainUrl() || '').replace(/\/+$/, '');
  if (!targetChainUrl) {
    return findHostByOnChainAID(hostAid);
  }
  const res = await fetch(`${targetChainUrl}/chain/resolve?aid=${encodeURIComponent(hostAid)}`);
  if (res.status === 404) {
    return { found: false, source: 'remote_poa_private_chain', hostAid, httpsEndpoint: null, record: null };
  }
  if (!res.ok) {
    throw new Error(`Remote Private Chain returned HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.found || !data.record) {
    return { found: false, source: 'remote_poa_private_chain', hostAid, httpsEndpoint: null, record: null };
  }
  return {
    found: true,
    source: 'remote_poa_private_chain',
    chainUrl: targetChainUrl,
    chainIntegrityValid: data.chainIntegrityValid,
    hostAid,
    httpsEndpoint: data.record.httpsEndpoint,
    mailboxAddress: data.record.mailboxAddress || null,
    tags: data.record.tags || [],
    record: data.record
  };
}

/**
 * Path 1: Look up Host's AID on-chain to get its long-term fixed HTTPS endpoint & mailbox address
 */
function findHostByOnChainAID(hostAid) {
  const records = loadMergedOnChainRecords();
  const record = records[hostAid] || null;
  if (!record) {
    return { found: false, source: 'onchain_aid', hostAid, httpsEndpoint: null, record: null };
  }
  return {
    found: true,
    source: 'onchain_aid',
    hostAid,
    httpsEndpoint: record.httpsEndpoint,
    mailboxAddress: record.mailboxAddress || null,
    tags: record.tags || [],
    record
  };
}

/**
 * Path 2: Check Client's Mailbox for an HTTPS endpoint card or reply notification delivered by Host
 */
function findHostFromMailbox(clientAid, hostAid, { markAsRead = false } = {}) {
  const store = readJsonSafe(MAILBOX_STORE_FILE, { mailboxes: {} });
  const list = store.mailboxes[clientAid] || [];
  const matching = list.filter(
    (m) =>
      m.fromAid === hostAid &&
      m.httpsEndpoint &&
      (m.type === 'ENDPOINT_DELIVERY' || m.type === 'HOST_REPLY_NOTICE' || m.type === 'TASK_CLOSED_NOTICE')
  );

  if (matching.length === 0) {
    return { found: false, source: 'mailbox', hostAid, httpsEndpoint: null, mailItem: null };
  }

  const latestMail = matching[matching.length - 1];
  if (markAsRead) {
    const now = new Date().toISOString();
    for (const m of matching) {
      if (!m.read) {
        m.read = true;
        m.readAt = now;
      }
    }
    writeJsonSafe(MAILBOX_STORE_FILE, store);
  }

  return {
    found: true,
    source: 'mailbox',
    hostAid,
    httpsEndpoint: latestMail.httpsEndpoint,
    mailItem: latestMail
  };
}

/**
 * Unified Endpoint Discovery
 */
function discoverHostEndpoint({ clientAid, hostAid, strategy = 'auto' }) {
  if (strategy === 'onchain_aid') {
    return findHostByOnChainAID(hostAid);
  }
  if (strategy === 'mailbox') {
    return findHostFromMailbox(clientAid, hostAid, { markAsRead: true });
  }

  const mailboxRes = findHostFromMailbox(clientAid, hostAid, { markAsRead: true });
  const chainRes = findHostByOnChainAID(hostAid);

  if (mailboxRes.found && chainRes.found) {
    const mailTime = mailboxRes.mailItem?.createdAt || '';
    const chainTime = chainRes.record?.updatedAt || '';
    return mailTime >= chainTime ? mailboxRes : chainRes;
  }
  if (mailboxRes.found) return mailboxRes;
  if (chainRes.found) return chainRes;

  return {
    found: false,
    source: 'none',
    hostAid,
    httpsEndpoint: null
  };
}

/**
 * Deliver an Offline Message or Endpoint Card to Host's Mailbox
 */
function deliverToMailbox({ toAid, fromAid, type, httpsEndpoint = null, payload = {} }) {
  const store = readJsonSafe(MAILBOX_STORE_FILE, { mailboxes: {} });
  if (!store.mailboxes[toAid]) {
    store.mailboxes[toAid] = [];
  }

  const mailItem = {
    mailId: `mail_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    toAid,
    fromAid,
    type,
    httpsEndpoint: httpsEndpoint ? httpsEndpoint.replace(/\/+$/, '') : null,
    payload,
    createdAt: new Date().toISOString(),
    read: false,
    readAt: null
  };

  store.mailboxes[toAid].push(mailItem);
  writeJsonSafe(MAILBOX_STORE_FILE, store);
  return mailItem;
}

function checkClientMailbox(clientAid, { unreadOnly = false, markAsRead = false } = {}) {
  const store = readJsonSafe(MAILBOX_STORE_FILE, { mailboxes: {} });
  const list = store.mailboxes[clientAid] || [];
  const filtered = unreadOnly ? list.filter((m) => !m.read) : [...list];

  if (markAsRead && list.some((m) => !m.read)) {
    const now = new Date().toISOString();
    for (const m of list) {
      if (!m.read) {
        m.read = true;
        m.readAt = now;
      }
    }
    writeJsonSafe(MAILBOX_STORE_FILE, store);
  }

  return filtered;
}

module.exports = {
  getConfiguredPrivateChainUrl,
  searchHostsByClueOnChain,
  searchHostsByClueFromRemoteChain,
  findHostByOnChainAID,
  findHostByRemoteChainAID,
  findHostFromMailbox,
  discoverHostEndpoint,
  deliverToMailbox,
  checkClientMailbox
};
