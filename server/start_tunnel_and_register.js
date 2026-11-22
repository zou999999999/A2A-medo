/**
 * One-Click Permanent Public HTTPS Tunnel (Ngrok) & On-Chain AID Registration Launcher
 * (server/start_tunnel_and_register.js)
 *
 * Uses your configured permanent Ngrok Static Domain
 * so your HTTPS endpoint never changes across computer reboots!
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const { startHostServer, getLocalControlToken, HOST_AID, HOST_NAME, HOST_TAGS } = require('./host_server');
const { registerAIDOnChain } = require('./discovery_store');

const PORT = Number(process.env.PORT || 3100);
const IDENTITY_FILE = path.resolve(__dirname, 'data', 'host_identity.json');
function loadSavedDomain() {
  try {
    if (fs.existsSync(IDENTITY_FILE)) {
      const id = JSON.parse(fs.readFileSync(IDENTITY_FILE, 'utf-8'));
      if (id.ngrokDomain) return id.ngrokDomain;
      if (id.httpsEndpoint) return new URL(id.httpsEndpoint).hostname;
    }
  } catch {
    // ignore
  }
  return null;
}
const PERMANENT_NGROK_DOMAIN = process.env.NGROK_DOMAIN || loadSavedDomain();
if (!PERMANENT_NGROK_DOMAIN) {
  console.error('❌ 请先通过 node ./server/host_cli.js set-identity --url https://你的固定域名 配置您的隧道域名，或设置环境变量 NGROK_DOMAIN');
  process.exit(1);
}
const PERMANENT_HTTPS_URL = `https://${PERMANENT_NGROK_DOMAIN}`;

function findNgrokBinary() {
  const pkgRoot = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Packages');
  if (fs.existsSync(pkgRoot)) {
    const dirs = fs.readdirSync(pkgRoot).filter((d) => d.startsWith('Ngrok.Ngrok'));
    for (const d of dirs) {
      const candidate = path.join(pkgRoot, d, 'ngrok.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  const wingetLink = path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', 'ngrok.exe');
  if (fs.existsSync(wingetLink)) return wingetLink;
  return 'ngrok';
}

async function ensureHostRunning() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/a2a/info`);
    if (res.ok) {
      console.log(`🎧 检测到本地 Host 耳机服务已在端口 ${PORT} 运行。`);
      return;
    }
  } catch {
    // Not running yet, start it
  }
  await startHostServer(PORT);
}

async function registerPermanentEndpoint() {
  try {
    await fetch(`http://127.0.0.1:${PORT}/host/publish-endpoint`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-host-local-token': getLocalControlToken()
      },
      body: JSON.stringify({
        httpsEndpoint: PERMANENT_HTTPS_URL,
        tags: HOST_TAGS
      })
    });
  } catch {
    registerAIDOnChain({
      aid: HOST_AID,
      httpsEndpoint: PERMANENT_HTTPS_URL,
      agentName: HOST_NAME,
      role: 'host',
      tags: HOST_TAGS
    });
  }
}

async function launchTunnelAndRegister() {
  await ensureHostRunning();
  await registerPermanentEndpoint();

  const ngrokBin = findNgrokBinary();
  console.log(`🌐 正在启动 Ngrok 永久固定 HTTPS 隧道 (${PERMANENT_HTTPS_URL} -> 127.0.0.1:${PORT})...`);

  const proc = spawn(
    ngrokBin,
    ['http', `--domain=${PERMANENT_NGROK_DOMAIN}`, String(PORT), '--log=stdout'],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let printedReady = false;
  const onData = (chunk) => {
    const text = chunk.toString('utf-8');
    if (!printedReady && (text.includes('started tunnel') || text.includes(PERMANENT_NGROK_DOMAIN))) {
      printedReady = true;
      console.log('\n======================================================================');
      console.log(`✅ [永久固定公网 HTTPS 隧道已接通并绑定至链上 AID]`);
      console.log(`   • Host AID       : ${HOST_AID}`);
      console.log(`   • 永久 HTTPS 地址 : ${PERMANENT_HTTPS_URL}`);
      console.log(`   • 名片验证链接   : ${PERMANENT_HTTPS_URL}/a2a/info`);
      console.log(`   • 另一台电脑发现 : node ./client/client_cli.js discover ${HOST_AID}`);
      console.log('======================================================================\n');
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  proc.on('close', (code) => {
    console.log(`⚠️ Ngrok 隧道进程已退出 (code=${code})`);
  });
}

if (require.main === module) {
  launchTunnelAndRegister().catch((err) => {
    console.error('❌ 启动失败:', err.message);
    process.exit(1);
  });
}
