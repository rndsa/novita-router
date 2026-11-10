import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = parseInt(process.env.PORT || '8181', 10);
const CONFIG_FILE = path.join(__dirname, 'keys.json');
const SECURITY_FILE = path.join(__dirname, 'security.json');
const MANAGED_KEYS_FILE = path.join(__dirname, 'managed_keys.json');

let managedKeys = [];
function loadManagedKeys() {
  if (fs.existsSync(MANAGED_KEYS_FILE)) {
    try {
      managedKeys = JSON.parse(fs.readFileSync(MANAGED_KEYS_FILE, 'utf-8'));
    } catch (e) {
      managedKeys = [];
    }
  }
}
function saveManagedKeys() {
  try {
    fs.writeFileSync(MANAGED_KEYS_FILE, JSON.stringify(managedKeys, null, 2));
  } catch (e) {}
}
loadManagedKeys();

let cachedModels = null;
let cachedModelsTime = 0;

async function fetchUpstreamModels() {
  if (cachedModels && (Date.now() - cachedModelsTime < 600000)) {
    return cachedModels;
  }
  const healthyKey = getNextHealthyKey();
  if (!healthyKey) return [];
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.novita.ai',
      port: 443,
      path: '/openai/v1/models',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${healthyKey.raw}`,
        'User-Agent': 'curl/8.5.0'
      },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const list = (json.data || []).map(m => m.id);
          cachedModels = list;
          cachedModelsTime = Date.now();
          resolve(list);
        } catch (e) {
          resolve(cachedModels || []);
        }
      });
    });
    req.on('error', () => resolve(cachedModels || []));
    req.end();
  });
}
const PUBLIC_DIR = path.join(__dirname, 'public');

const AUTH_USER = process.env.ROUTER_USER || 'admin';
let AUTH_PASS = process.env.ROUTER_PASS || 'change-this-password';

// Security Configuration
let securityConfig = {
  ipAllowlist: {
    enabled: false,
    allowed: ['127.0.0.1', '::1']
  },
  rateLimit: {
    enabled: true,
    maxPerMinute: 60
  },
  apiProtection: {
    requireToken: false,
    customToken: process.env.API_TOKEN || 'change-this-api-token'
  },
  adminPassword: process.env.ROUTER_PASS || 'change-this-password'
};

function loadSecurityConfig() {
  if (fs.existsSync(SECURITY_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(SECURITY_FILE, 'utf-8'));
      securityConfig = { ...securityConfig, ...data };
      if (securityConfig.adminPassword) {
        AUTH_PASS = securityConfig.adminPassword;
      }
    } catch (e) {
      console.error('[SECURITY] Failed to parse security.json:', e.message);
    }
  } else {
    saveSecurityConfig();
  }
}

function saveSecurityConfig() {
  try {
    fs.writeFileSync(SECURITY_FILE, JSON.stringify(securityConfig, null, 2));
    if (securityConfig.adminPassword) {
      AUTH_PASS = securityConfig.adminPassword;
    }
  } catch (e) {
    console.error('[SECURITY] Could not save security.json:', e.message);
  }
}

loadSecurityConfig();

// In-Memory Rate Limiting Tracker
const rateLimitStore = new Map(); // ip -> { count: number, resetAt: number }

function checkRateLimit(ip) {
  if (!securityConfig.rateLimit || !securityConfig.rateLimit.enabled) return true;
  const now = Date.now();
  const max = securityConfig.rateLimit.maxPerMinute || 60;
  
  const record = rateLimitStore.get(ip);
  if (!record || record.resetAt <= now) {
    rateLimitStore.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }

  if (record.count >= max) {
    return false;
  }

  record.count++;
  return true;
}

// Client IP Resolver (supports Cloudflare Tunnel & direct socket)
function getClientIp(req) {
  const cfIp = req.headers['cf-connecting-ip'];
  if (cfIp) return cfIp.trim();

  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const first = xff.split(',')[0].trim();
    if (first) return first;
  }

  const remote = req.socket.remoteAddress || '';
  if (remote.startsWith('::ffff:')) return remote.slice(7);
  return remote;
}

function isIpAllowed(ip) {
  if (!securityConfig.ipAllowlist || !securityConfig.ipAllowlist.enabled) return true;
  const list = securityConfig.ipAllowlist.allowed || [];
  
  // Always allow loopback for local diagnostic healthchecks
  if (ip === '127.0.0.1' || ip === '::1' || ip === 'localhost') return true;

  return list.some(allowedIp => {
    const clean = allowedIp.trim();
    if (!clean) return false;
    if (clean === '*') return true;
    if (clean === ip) return true;
    // Prefix / Subnet match (e.g. 192.168.1.)
    if (clean.endsWith('*') && ip.startsWith(clean.slice(0, -1))) return true;
    return false;
  });
}

// Telemetry counters
const telemetry = {
  totalRequests: 0,
  successfulRequests: 0,
  failedRequests: 0,
  failoverEvents: 0,
  blockedRequests: 0,
  startTime: Date.now()
};

// Key pool storage
let keyPool = [];

function loadKeys() {
  let keys = [];
  if (process.env.NOVITA_KEYS) {
    keys = process.env.NOVITA_KEYS.split(',').map(k => k.trim()).filter(Boolean);
  } else if (fs.existsSync(CONFIG_FILE)) {
    try {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
      if (Array.isArray(data)) keys = data;
      else if (Array.isArray(data.keys)) keys = data.keys;
    } catch (e) {
      console.error('[CONFIG] Failed to parse keys.json:', e.message);
    }
  }

  if (keys.length === 0) {
    console.warn('[CONFIG] No API keys configured in keys.json or NOVITA_KEYS env.');
  }

  keyPool = keys.map(k => {
    const existing = keyPool.find(p => p.raw === k);
    return existing || {
      raw: k,
      email: 'syncing...',
      balanceUSD: 0,
      voucherUSD: 0,
      status: 'ACTIVE',
      lastUsed: 0,
      failCount: 0,
      cooldownUntil: 0
    };
  });

  saveKeys();
}

function saveKeys() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(keyPool.map(k => k.raw), null, 2));
  } catch (e) {
    console.error('[CONFIG] Could not save keys.json:', e.message);
  }
}

// Check key balance & validity with Novita API
async function syncKeyInfo(keyItem) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.novita.ai',
      port: 443,
      path: '/openapi/v1/user/info',
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${keyItem.raw}`,
        'Content-Type': 'application/json',
        'User-Agent': 'curl/8.5.0'
      },
      timeout: 10000
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          try {
            const json = JSON.parse(data);
            keyItem.email = json.email || json.username || 'unknown';
            const bal = parseInt(json.balance || '0', 10) / 10000;
            const vouch = parseInt(json.voucher || '0', 10) / 10000;
            keyItem.balanceUSD = bal;
            keyItem.voucherUSD = vouch;
            
            if (bal > 0 || vouch > 0 || json.isBalanceEnough) {
              keyItem.status = 'ACTIVE';
            } else {
              keyItem.status = 'EXHAUSTED';
            }
          } catch (err) {
            keyItem.status = 'ACTIVE';
          }
        } else if (res.statusCode === 401 || res.statusCode === 403) {
          keyItem.status = 'INVALID';
        }
        resolve(keyItem);
      });
    });

    req.on('error', (e) => {
      resolve(keyItem);
    });

    req.on('timeout', () => {
      req.destroy();
      resolve(keyItem);
    });

    req.end();
  });
}

async function syncAllKeys() {
  for (const k of keyPool) {
    await syncKeyInfo(k);
  }
}

function getNextHealthyKey(excludedKeys = new Set()) {
  const now = Date.now();
  const eligible = keyPool.filter(k => {
    if (excludedKeys.has(k.raw)) return false;
    if (k.status === 'INVALID' || k.status === 'EXHAUSTED') return false;
    if (k.cooldownUntil > now) return false;
    return true;
  });

  if (eligible.length === 0) return null;

  eligible.sort((a, b) => a.lastUsed - b.lastUsed);
  return eligible[0];
}

function reportKeyError(keyItem, statusCode) {
  keyItem.failCount++;
  if (statusCode === 429) {
    keyItem.cooldownUntil = Date.now() + 60000;
  } else if (statusCode === 401 || statusCode === 403) {
    keyItem.status = 'INVALID';
  } else if (statusCode === 402) {
    keyItem.status = 'EXHAUSTED';
  }
}

function reportKeySuccess(keyItem) {
  keyItem.lastUsed = Date.now();
  keyItem.failCount = 0;
}

function checkAuth(req, url) {
  // Query param
  const queryAuth = url.searchParams.get('auth') || url.searchParams.get('pass');
  if (queryAuth === AUTH_PASS) return true;

  // Cookie
  const cookies = req.headers.cookie || '';
  if (cookies.includes(`novita_auth=${AUTH_PASS}`)) return true;

  // Header
  const authHeader = req.headers['authorization'] || '';
  if (authHeader.startsWith('Basic ')) {
    const b64 = authHeader.slice(6).trim();
    try {
      const decoded = Buffer.from(b64, 'base64').toString('utf-8');
      const [u, ...p] = decoded.split(':');
      if (u === AUTH_USER && p.join(':') === AUTH_PASS) return true;
    } catch (e) {}
  } else if (authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7).trim();
    if (token === AUTH_PASS) return true;
    // Check managed router API keys
    const mKey = managedKeys.find(k => k.key === token);
    if (mKey) {
      mKey.lastUsed = Date.now();
      mKey.requests = (mKey.requests || 0) + 1;
      saveManagedKeys();
      return true;
    }
    // Also accept customBearerToken if configured
    if (securityConfig.apiProtection?.requireToken && token === securityConfig.apiProtection?.customToken) {
      return true;
    }
  }

  return false;
}

// Forward request to Novita upstream with automated retry / failover
function forwardRequest(req, res, targetPath, bodyBuffer) {
  telemetry.totalRequests++;
  const attemptedKeys = new Set();

  function attempt() {
    const keyItem = getNextHealthyKey(attemptedKeys);
    if (!keyItem) {
      telemetry.failedRequests++;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: {
          message: 'All Novita API keys in router pool are exhausted or in cooldown.',
          type: 'router_pool_exhausted',
          pool_size: keyPool.length
        }
      }));
      return;
    }

    attemptedKeys.add(keyItem.raw);

    const headers = {
      ...req.headers,
      'host': 'api.novita.ai',
      'authorization': `Bearer ${keyItem.raw}`,
      'user-agent': 'curl/8.5.0'
    };
    delete headers['content-length'];
    if (bodyBuffer) {
      headers['content-length'] = Buffer.byteLength(bodyBuffer);
    }

    const options = {
      hostname: 'api.novita.ai',
      port: 443,
      path: targetPath,
      method: req.method,
      headers: headers,
      timeout: 120000
    };

    const upstreamReq = https.request(options, (upstreamRes) => {
      const statusCode = upstreamRes.statusCode;

      if ((statusCode === 429 || statusCode === 402 || statusCode === 401) && attemptedKeys.size < keyPool.length) {
        telemetry.failoverEvents++;
        reportKeyError(keyItem, statusCode);
        upstreamRes.resume();
        attempt();
        return;
      }

      reportKeySuccess(keyItem);
      telemetry.successfulRequests++;

      const respHeaders = { ...upstreamRes.headers };
      res.writeHead(statusCode, respHeaders);
      upstreamRes.pipe(res);
    });

    upstreamReq.on('error', (err) => {
      if (attemptedKeys.size < keyPool.length) {
        telemetry.failoverEvents++;
        reportKeyError(keyItem, 502);
        attempt();
      } else {
        telemetry.failedRequests++;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: err.message, type: 'upstream_error' } }));
      }
    });

    upstreamReq.on('timeout', () => {
      upstreamReq.destroy();
      if (attemptedKeys.size < keyPool.length) {
        telemetry.failoverEvents++;
        reportKeyError(keyItem, 504);
        attempt();
      } else {
        telemetry.failedRequests++;
        res.writeHead(504, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Upstream gateway timeout', type: 'timeout' } }));
      }
    });

    if (bodyBuffer && bodyBuffer.length > 0) {
      upstreamReq.write(bodyBuffer);
    }
    upstreamReq.end();
  }

  attempt();
}

// Serve interactive login screen for browsers
function renderLoginPage(res, errorMsg = '') {
  const html = `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Novita Router Access</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:opsz,wght@9..40,400;500;600&family=JetBrains+Mono:wght@400;500&family=Space+Grotesk:wght@600;700&display=swap" rel="stylesheet">
  <script src="https://cdn.tailwindcss.com"></script>
  <style>
    body { font-family: 'DM Sans', system-ui, sans-serif; background-color: #090a0f; color: #ffffff; }
    h1 { font-family: 'Space Grotesk', sans-serif; }
  </style>
</head>
<body class="min-h-screen flex items-center justify-center p-4">
  <div class="w-full max-w-sm border-2 border-[#3f475d] bg-[#13151f] p-5 shadow-[4px_4px_0px_0px_#000000]">
    <div class="flex items-center gap-2 mb-4">
      <span class="w-8 h-8 border-2 border-white bg-white text-black font-mono font-bold text-xs flex items-center justify-center shadow-[1px_1px_0px_0px_#000000]">
        NR
      </span>
      <div>
        <h1 class="font-bold text-white text-sm uppercase">Novita Router</h1>
        <p class="text-[11px] text-[#9ca3af] font-mono">Private Gateway</p>
      </div>
    </div>

    ${errorMsg ? `<div class="mb-3 p-2 border-2 border-red-500 bg-red-950/40 text-red-400 text-xs font-mono">${errorMsg}</div>` : ''}

    <form id="login-form" method="POST" action="/login" class="space-y-3">
      <div>
        <label class="block text-xs font-mono text-[#9ca3af] mb-1 uppercase">Password Akses</label>
        <input id="input-password" type="password" name="password" required autofocus placeholder="Masukkan password" class="w-full px-3 py-2 border-2 border-[#3f475d] bg-[#0c0d14] text-xs font-mono text-white focus:outline-none focus:border-white">
      </div>
      <button type="submit" class="w-full py-2 px-3 border-2 border-white bg-white text-black text-xs font-bold font-mono uppercase shadow-[2px_2px_0px_0px_#000000] active:translate-x-[1px] active:translate-y-[1px]">
        Masuk
      </button>
    </form>
    <script>
      (function() {
        const urlParams = new URLSearchParams(window.location.search);
        let qPass = urlParams.get('pass') || urlParams.get('auth');
        if (qPass && window.location.hash) {
          qPass += window.location.hash;
        }
        if (qPass && !document.querySelector('.border-red-500')) {
          document.getElementById('input-password').value = qPass;
          document.getElementById('login-form').submit();
        }
      })();
    </script>

    <div class="mt-4 pt-3 border-t-2 border-[#3f475d] text-center">
      <span class="text-xs text-[#6b7280] font-mono">by ren</span>
    </div>
  </div>
</body>
</html>`;
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const clientIp = getClientIp(req);
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // 1. IP ALLOWLIST CHECK (Protects all routes except when disabled)
  if (!isIpAllowed(clientIp)) {
    telemetry.blockedRequests++;
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: `Akses Ditolak: IP Anda (${clientIp}) tidak terdaftar dalam allowlist.`,
        type: 'ip_forbidden',
        clientIp: clientIp
      }
    }));
    return;
  }

  // 2. RATE LIMIT CHECK
  if (!checkRateLimit(clientIp)) {
    telemetry.blockedRequests++;
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: {
        message: 'Rate limit terlampaui. Throttling aktif.',
        type: 'rate_limit_exceeded',
        clientIp: clientIp
      }
    }));
    return;
  }

  // Handle Form Login POST
  if (pathname === '/login' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const params = new URLSearchParams(body);
      const pass = params.get('password') || '';
      if (pass === AUTH_PASS) {
        res.writeHead(302, {
          'Set-Cookie': `novita_auth=${AUTH_PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
          'Location': '/'
        });
        res.end();
      } else {
        renderLoginPage(res, 'Password salah. Coba lagi.');
      }
    });
    return;
  }

  // Handle Logout
  if (pathname === '/logout') {
    res.writeHead(302, {
      'Set-Cookie': `novita_auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`,
      'Location': '/'
    });
    res.end();
    return;
  }

  // Check Auth
  const isAuthed = checkAuth(req, url);

  if (!isAuthed) {
    const accept = req.headers.accept || '';
    if (accept.includes('application/json') || pathname.startsWith('/v1/') || pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unauthorized. Provide valid password or Bearer token.', type: 'auth_error' } }));
      return;
    }
    renderLoginPage(res);
    return;
  }

  // If query auth used, refresh cookie
  const queryAuth = url.searchParams.get('auth') || url.searchParams.get('pass');
  if (queryAuth === AUTH_PASS) {
    res.setHeader('Set-Cookie', `novita_auth=${AUTH_PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`);
  }

  // 1. DASHBOARD UI
  if (pathname === '/' || pathname === '/index.html' || pathname === '/dashboard') {
    const indexPath = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(indexPath).pipe(res);
      return;
    }
  }

  // 1.5. PM DASHBOARD UI
  if (pathname === '/pm' || pathname === '/pm.html') {
    const pmPath = path.join(PUBLIC_DIR, 'pm.html');
    if (fs.existsSync(pmPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      fs.createReadStream(pmPath).pipe(res);
      return;
    }
  }

  // 2.1 API: Models Catalog
  if (pathname === '/api/models') {
    fetchUpstreamModels().then(models => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ total: models.length, models: models }));
    }).catch(err => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    });
    return;
  }

  // 2.2 API: Managed Router API Keys (GET, POST create, POST revoke)
  if (pathname === '/api/managed-keys') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ keys: managedKeys }));
    return;
  }

  if (pathname === '/api/managed-keys/create' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body || '{}');
        const crypto = await import('node:crypto');
        const rawHex = crypto.randomBytes(12).toString('hex');
        const fullKey = `nr_live_${rawHex}`;
        const newKey = {
          id: `key_${Date.now()}`,
          name: (json.name || 'API Client').trim() || 'API Client',
          key: fullKey,
          keyMasked: `nr_live_${rawHex.slice(0, 4)}...${rawHex.slice(-4)}`,
          createdAt: Date.now(),
          lastUsed: 0,
          requests: 0
        };
        managedKeys.unshift(newKey);
        saveManagedKeys();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, key: fullKey, item: newKey }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  if (pathname === '/api/managed-keys/revoke' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const json = JSON.parse(body || '{}');
        const id = json.id;
        const initLen = managedKeys.length;
        managedKeys = managedKeys.filter(k => k.id !== id);
        if (managedKeys.length === initLen) throw new Error('Key tidak ditemukan');
        saveManagedKeys();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, remaining: managedKeys.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 2. API: Get Status & Telemetry
  if (pathname === '/api/status' || pathname === '/v1/router/status' || pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const now = Date.now();
    res.end(JSON.stringify({
      status: 'healthy',
      telemetry: {
        ...telemetry,
        uptimeSeconds: Math.floor((now - telemetry.startTime) / 1000)
      },
      pool: {
        total: keyPool.length,
        active: keyPool.filter(k => k.status === 'ACTIVE' && k.cooldownUntil <= now).length,
        coolingDown: keyPool.filter(k => k.cooldownUntil > now).length,
        totalBalanceUSD: keyPool.reduce((acc, k) => acc + (k.balanceUSD || 0), 0),
        keys: keyPool.map(k => ({
          keyMasked: k.raw.slice(0, 8) + '...' + k.raw.slice(-4),
          email: k.email,
          balanceUSD: k.balanceUSD,
          voucherUSD: k.voucherUSD,
          status: k.status,
          coolingDown: k.cooldownUntil > now,
          failCount: k.failCount
        }))
      }
    }, null, 2));
    return;
  }

  // 2.5 API: Security Config (GET & POST)
  if (pathname === '/api/security') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        config: securityConfig,
        currentIp: clientIp
      }));
      return;
    }

    if (req.method === 'POST') {
      let body = '';
      req.on('data', c => body += c);
      req.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.ipAllowlist) {
            securityConfig.ipAllowlist.enabled = Boolean(json.ipAllowlist.enabled);
            if (Array.isArray(json.ipAllowlist.allowed)) {
              securityConfig.ipAllowlist.allowed = json.ipAllowlist.allowed.map(s => String(s).trim()).filter(Boolean);
            }
          }
          if (json.rateLimit) {
            securityConfig.rateLimit.enabled = Boolean(json.rateLimit.enabled);
            const max = parseInt(json.rateLimit.maxPerMinute, 10);
            if (!isNaN(max) && max > 0) securityConfig.rateLimit.maxPerMinute = max;
          }
          if (json.apiProtection) {
            securityConfig.apiProtection.requireToken = Boolean(json.apiProtection.requireToken);
            if (json.apiProtection.customToken) {
              securityConfig.apiProtection.customToken = String(json.apiProtection.customToken).trim();
            }
          }
          if (json.adminPassword && String(json.adminPassword).trim()) {
            securityConfig.adminPassword = String(json.adminPassword).trim();
          }

          saveSecurityConfig();

          const cookieVal = `novita_auth=${AUTH_PASS}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`;
          res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': cookieVal
          });
          res.end(JSON.stringify({ success: true, config: securityConfig, currentIp: clientIp, newPassword: AUTH_PASS }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: e.message }));
        }
      });
      return;
    }
  }

  // 3. API: Add Key
  if (pathname === '/api/keys/add' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        const json = JSON.parse(body);
        const newKey = (json.key || '').trim();
        if (!newKey) throw new Error('Key cannot be empty');
        if (keyPool.some(k => k.raw === newKey)) throw new Error('Key already exists in pool');

        const item = {
          raw: newKey,
          email: 'validating...',
          balanceUSD: 0,
          voucherUSD: 0,
          status: 'ACTIVE',
          lastUsed: 0,
          failCount: 0,
          cooldownUntil: 0
        };

        await syncKeyInfo(item);
        if (item.status === 'INVALID') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'API key is invalid according to Novita API.' }));
          return;
        }

        keyPool.push(item);
        saveKeys();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, item: {
          keyMasked: item.raw.slice(0, 8) + '...' + item.raw.slice(-4),
          email: item.email,
          balanceUSD: item.balanceUSD,
          status: item.status
        }}));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 4. API: Delete Key
  if (pathname === '/api/keys/delete' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        const masked = json.keyMasked;
        const initialLen = keyPool.length;
        keyPool = keyPool.filter(k => (k.raw.slice(0, 8) + '...' + k.raw.slice(-4)) !== masked);
        if (keyPool.length === initialLen) {
          throw new Error('Key not found');
        }
        saveKeys();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, remaining: keyPool.length }));
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 5. API: Run Python Code in Novita Sandbox Cloud
  if (pathname === '/api/sandbox/run' && req.method === 'POST') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const json = JSON.parse(body);
        const code = json.code || '';
        if (!code.trim()) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Code cannot be empty' }));
          return;
        }

        const healthyKey = getNextHealthyKey();
        if (!healthyKey) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No active Novita API key available in pool' }));
          return;
        }

        const runnerScript = path.join(__dirname, 'run_sandbox.py');
        const child = spawn('python3', [runnerScript, healthyKey.raw]);

        let childOut = '';
        let childErr = '';

        child.stdout.on('data', d => childOut += d);
        child.stderr.on('data', d => childErr += d);

        child.stdin.write(code);
        child.stdin.end();

        child.on('close', (exitCode) => {
          try {
            const parsed = JSON.parse(childOut);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              ...parsed,
              keyUsed: healthyKey.raw.slice(0, 8) + '...' + healthyKey.raw.slice(-4),
              exitCode: exitCode
            }));
          } catch (err) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
              success: false,
              rawOutput: childOut,
              rawError: childErr || err.message
            }));
          }
        });
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // 6. OpenAI Proxy Endpoints with optional Custom Bearer Protection
  if (pathname.startsWith('/v1/chat/completions') || pathname.startsWith('/openai/v1/chat/completions')) {
    // Check if custom Bearer token is enforced
    if (securityConfig.apiProtection?.requireToken) {
      const authHeader = req.headers['authorization'] || '';
      const token = authHeader.replace(/^Bearer\s+/i, '').trim();
      if (token !== securityConfig.apiProtection.customToken && token !== AUTH_PASS) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: 'Invalid API token. Set Authorization: Bearer <your_custom_token>.',
            type: 'invalid_api_key'
          }
        }));
        return;
      }
    }

    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      forwardRequest(req, res, '/openai/v1/chat/completions', bodyBuffer);
    });
    return;
  }

  if (pathname.startsWith('/v1/models') || pathname.startsWith('/openai/v1/models')) {
    forwardRequest(req, res, '/openai/v1/models', null);
    return;
  }

  if (pathname.startsWith('/v1/embeddings') || pathname.startsWith('/openai/v1/embeddings')) {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const bodyBuffer = Buffer.concat(chunks);
      forwardRequest(req, res, '/openai/v1/embeddings', bodyBuffer);
    });
    return;
  }

  // 404
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: `Route ${pathname} not found`, type: 'invalid_request_error' } }));
});

// Initialization
loadKeys();
syncAllKeys();
setInterval(syncAllKeys, 120000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[NOVITA ROUTER] Running on http://0.0.0.0:${PORT}`);
});
