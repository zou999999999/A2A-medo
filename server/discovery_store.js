/**
 * Dual-Track Discovery & Mailbox Store (Host Side - server/discovery_store.js)
 *
 * Implements:
 *   1. On-Chain AID Registry with Skills/Tags Clues & Long-Term Fixed HTTPS Endpoint:
 *      - Stranger Clients can search on-chain by keyword/tag clues
 *        to discover Host's AID and its long-term fixed HTTPS endpoint.
 *   2. Mailbox / Inbox Delivery:
 *      - Supports offline voicemail storage (OFFLINE_MESSAGE), reply notifications (HOST_REPLY_NOTICE),
 *        and endpoint card delivery (ENDPOINT_DELIVERY).
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_NETWORK_DIR = process.env.NETWORK_STATE_DIR
  ? path.resolve(process.env.NETWORK_STATE_DIR)
  : path.resolve(__dirname, '..', '.network_state');

const CHAIN_REGISTRY_FILE = path.join(DEFAULT_NETWORK_DIR, 'onchain_aid_registry.json');
const MAILBOX_STORE_FILE = path.join(DEFAULT_NETWORK_DIR, 'mailbox_store.json');

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

/**
 * Register or update an Agent's AID on-chain with capability tags (discovery clues),
 * long-term fixed HTTPS endpoint, and permanent mailbox address.
 */
function registerAIDOnChain({
  aid,
  httpsEndpoint,
  agentName = '',
  role = 'host',
  tags = ['通用协同', 'A2A对话'],
  description = '个人Agent通信节点',
  mailboxAddress = null,
  metadata = {}
}) {
  if (!aid || !httpsEndpoint) {
    throw new Error('registerAIDOnChain requires both aid and httpsEndpoint');
  }
  const registry = readJsonSafe(CHAIN_REGISTRY_FILE, { contract: 'A2A-AID-Registry-v1', records: {} });
  const now = new Date().toISOString();
  const txHash = '0x' + crypto.createHash('sha256').update(`${aid}:${httpsEndpoint}:${now}`).digest('hex');

  registry.records[aid] = {
    aid,
    role,
    agentName: agentName || aid,
    tags: Array.isArray(tags) ? tags : [String(tags)],
    description,
    httpsEndpoint: httpsEndpoint.replace(/\/+$/, ''),
    mailboxAddress: mailboxAddress || null, // Optional: left empty unless explicitly configured
    updatedAt: now,
    txHash,
    metadata
  };

  writeJsonSafe(CHAIN_REGISTRY_FILE, registry);
  return registry.records[aid];
}

function resolveAIDFromChain(aid) {
  const registry = readJsonSafe(CHAIN_REGISTRY_FILE, { contract: 'A2A-AID-Registry-v1', records: {} });
  return registry.records[aid] || null;
}

/**
 * Search On-Chain AIDs by keyword or capability tag (Stranger Discovery via Clues)
 */
function searchAIDsOnChain({ query = '', tag = '' } = {}) {
  const registry = readJsonSafe(CHAIN_REGISTRY_FILE, { contract: 'A2A-AID-Registry-v1', records: {} });
  const all = Object.values(registry.records);
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

function listAllChainAIDs() {
  const registry = readJsonSafe(CHAIN_REGISTRY_FILE, { contract: 'A2A-AID-Registry-v1', records: {} });
  return Object.values(registry.records);
}

/**
 * Mailbox / Inbox Delivery Operations
 */
function sendToMailbox({ toAid, fromAid, type, httpsEndpoint = null, payload = {} }) {
  if (!toAid || !fromAid || !type) {
    throw new Error('sendToMailbox requires toAid, fromAid, and type');
  }
  const store = readJsonSafe(MAILBOX_STORE_FILE, { mailboxes: {} });
  if (!store.mailboxes[toAid]) {
    store.mailboxes[toAid] = [];
  }

  const mailItem = {
    mailId: `mail_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`,
    toAid,
    fromAid,
    type, // 'ENDPOINT_DELIVERY' | 'OFFLINE_MESSAGE' | 'HOST_REPLY_NOTICE' | 'TASK_CLOSED_NOTICE'
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

function checkMailbox(ownerAid, { unreadOnly = false, markAsRead = false } = {}) {
  const store = readJsonSafe(MAILBOX_STORE_FILE, { mailboxes: {} });
  const list = store.mailboxes[ownerAid] || [];
  const filtered = unreadOnly ? list.filter((m) => !m.read) : [...list];

  if (markAsRead && list.some((m) => !m.read)) {
    const now = new Date().toISOString();
    for (const item of list) {
      if (!item.read) {
        item.read = true;
        item.readAt = now;
      }
    }
    writeJsonSafe(MAILBOX_STORE_FILE, store);
  }

  return filtered;
}

module.exports = {
  CHAIN_REGISTRY_FILE,
  MAILBOX_STORE_FILE,
  registerAIDOnChain,
  resolveAIDFromChain,
  searchAIDsOnChain,
  listAllChainAIDs,
  sendToMailbox,
  checkMailbox
};
