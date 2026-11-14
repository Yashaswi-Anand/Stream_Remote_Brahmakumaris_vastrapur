'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { Relay } = require('./relay');
const { hashPassword, verifyPassword, passwordProblem, newToken, tokenHash, newPairingCode, normalizePairingCode, RateLimiter } = require('./auth');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const COOKIE = 'zsr_sid';
const ROLES = ['owner', 'client'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVITE_DAYS = 7;
const PAIRING_MS = 10 * 60000;
// Only these installer names are listed or served from the downloads folder.
const INSTALLER_RE = /^Zoom-Stream-Automation-(Setup|Portable)-(\d+)\.(\d+)\.(\d+)\.exe$/;

const compareVersions = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/** The newest Setup and Portable installer in `dir` (by version number), or an empty list. */
function latestInstallers(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const best = {};
  for (const name of names) {
    const m = name.match(INSTALLER_RE);
    if (!m) continue;
    const ver = [Number(m[2]), Number(m[3]), Number(m[4])];
    const cur = best[m[1]];
    if (cur && compareVersions(cur.ver, ver) >= 0) continue;
    let stat;
    try {
      stat = fs.statSync(path.join(dir, name));
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    best[m[1]] = { kind: m[1].toLowerCase(), name, ver, version: ver.join('.'), size: stat.size, updatedAt: stat.mtime.toISOString() };
  }
  return ['Setup', 'Portable'].filter((k) => best[k]).map((k) => {
    const { ver, ...f } = best[k];
    return f;
  });
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json',
  '.ico': 'image/x-icon',
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function readJson(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new HttpError(413, 'Request too large.'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try {
        const v = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        resolve(v && typeof v === 'object' && !Array.isArray(v) ? v : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON.'));
      }
    });
    req.on('error', reject);
  });
}

/** Builds the website server: static pages, JSON API and the WebSocket relay. */
function createApp({ config, store, log = console }) {
  const loginLimiter = new RateLimiter({ max: 5, windowMs: 15 * 60000, blockMs: 15 * 60000 });
  const pairLimiter = new RateLimiter({ max: 10, windowMs: 15 * 60000, blockMs: 30 * 60000 });
  const setupLimiter = new RateLimiter({ max: 5, windowMs: 15 * 60000, blockMs: 30 * 60000 });
  const pairingCodes = new Map(); // code → { expiresAt, createdBy }
  let setupCode = config.setupCode;

  const isHttps = (req) => !!req.socket.encrypted || (config.trustProxy && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https');
  const clientIp = (req) => (config.trustProxy && String(req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || req.socket.remoteAddress || '';

  /** Same-site check for browser requests: the Origin (when sent) must be this site. */
  function isAllowedOrigin(req) {
    const origin = req.headers.origin;
    if (!origin) return true;
    try {
      const host = req.headers['x-forwarded-host'] && config.trustProxy ? req.headers['x-forwarded-host'] : req.headers.host;
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  async function resolveSession(req) {
    const token = parseCookies(req.headers.cookie)[COOKIE];
    if (!token) return null;
    const hash = tokenHash(token);
    const s = await store.findSession(hash);
    if (!s || s.expiresAt <= new Date().toISOString()) return null;
    const user = await store.findUserById(s.userId);
    if (!user) return null;
    return { hash, user: { id: user.id, email: user.email, role: user.role } };
  }

  const relay = new Relay({ store, resolveSession, isAllowedOrigin });

  function setSessionCookie(req, res, token, maxAgeSec) {
    const secure = isHttps(req) || config.requireHttps ? '; Secure' : '';
    res.setHeader('Set-Cookie', `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${secure}`);
  }

  async function startSession(req, res, user) {
    const token = newToken();
    const maxAge = config.sessionDays * 86400;
    await store.createSession({ tokenHash: tokenHash(token), userId: user.id, expiresAt: new Date(Date.now() + maxAge * 1000).toISOString() });
    setSessionCookie(req, res, token, maxAge);
  }

  const securityHeaders = (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    if (isHttps(req)) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };

  function serveStatic(req, res, pathname) {
    let rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    let file = path.resolve(PUBLIC_DIR, rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return json(res, 404, { error: 'Not found.' });
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      if (path.extname(rel)) return json(res, 404, { error: 'Not found.' });
      file = path.join(PUBLIC_DIR, 'index.html'); // Single-page app routes.
    }
    const ext = path.extname(file);
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' || path.basename(file) === 'sw.js' ? 'no-cache' : 'public, max-age=300',
    });
    fs.createReadStream(file).pipe(res);
  }

  // ---- API routes ------------------------------------------------------------------------------

  const routes = [];
  // `raw` routes write the response themselves (file downloads) instead of returning JSON.
  const route = (method, pattern, opts, fn) => routes.push({ method, pattern, auth: opts.auth || 'none', raw: !!opts.raw, fn });

  route('GET', /^\/api\/health$/, {}, async () => ({ ok: true }));

  route('GET', /^\/api\/me$/, {}, async ({ session }) => {
    const needsSetup = (await store.countUsers()) === 0;
    return { user: session?.user || null, needsSetup };
  });

  // First start: create the owner account with the setup code (only while no account exists).
  route('POST', /^\/api\/setup$/, {}, async ({ req, res, body }) => {
    const ip = clientIp(req);
    if (setupLimiter.blockedFor(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    if ((await store.countUsers()) > 0) throw new HttpError(409, 'Setup is already done. Sign in instead.');
    const given = Buffer.from(String(body.code || '').trim());
    const want = Buffer.from(setupCode);
    if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) {
      setupLimiter.fail(ip);
      throw new HttpError(403, 'Wrong setup code.');
    }
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const user = await store.createUser({ email, role: 'owner', passwordHash: await hashPassword(body.password) });
    await store.addAudit({ actor: email, action: 'Owner account created' });
    await startSession(req, res, user);
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  route('POST', /^\/api\/login$/, {}, async ({ req, res, body }) => {
    const email = String(body.email || '').trim().toLowerCase();
    const key = `${clientIp(req)}|${email}`;
    const wait = loginLimiter.blockedFor(key);
    if (wait) throw new HttpError(429, `Too many failed sign-ins. Try again in ${Math.ceil(wait / 60000)} minute(s).`);
    const user = await store.findUserByEmail(email);
    const ok = user ? await verifyPassword(String(body.password || ''), user.passwordHash) : await verifyPassword('x', 'scrypt$16384$8$1$AAAA$AAAA').then(() => false);
    if (!ok) {
      loginLimiter.fail(key);
      throw new HttpError(401, 'Wrong email or password.');
    }
    loginLimiter.reset(key);
    await startSession(req, res, user);
    await store.addAudit({ actor: user.email, action: 'Signed in' });
    return { user: { id: user.id, email: user.email, role: user.role } };
  });

  route('POST', /^\/api\/logout$/, { auth: 'user' }, async ({ req, res, session }) => {
    await store.deleteSession(session.hash);
    setSessionCookie(req, res, '', 0);
    return { ok: true };
  });

  route('POST', /^\/api\/password$/, { auth: 'user' }, async ({ body, session }) => {
    const user = await store.findUserById(session.user.id);
    if (!(await verifyPassword(String(body.current || ''), user.passwordHash))) throw new HttpError(403, 'Current password is wrong.');
    const problem = passwordProblem(body.next);
    if (problem) throw new HttpError(400, problem);
    await store.updateUser(user.id, { passwordHash: await hashPassword(body.next) });
    await store.addAudit({ actor: user.email, action: 'Changed password' });
    return { ok: true };
  });

  // Invites: the owner creates a one-time link; the invited person sets their own password.
  route('GET', /^\/api\/invite\/([\w-]{20,100})$/, {}, async ({ match }) => {
    const inv = await store.findInvite(tokenHash(match[1]));
    if (!inv || inv.expiresAt <= new Date().toISOString()) throw new HttpError(404, 'This invite link is invalid or has expired. Ask the owner for a new one.');
    return { email: inv.email, role: inv.role };
  });

  route('POST', /^\/api\/invite\/accept$/, {}, async ({ req, res, body }) => {
    const inv = await store.findInvite(tokenHash(String(body.token || '')));
    if (!inv || inv.expiresAt <= new Date().toISOString()) throw new HttpError(404, 'This invite link is invalid or has expired.');
    const problem = passwordProblem(body.password);
    if (problem) throw new HttpError(400, problem);
    const passwordHash = await hashPassword(body.password);
    let user = await store.findUserByEmail(inv.email);
    if (user) await store.updateUser(user.id, { passwordHash, role: inv.role });
    else user = await store.createUser({ email: inv.email, role: inv.role, passwordHash });
    await store.deleteInvite(inv.id);
    await store.addAudit({ actor: inv.email, action: 'Accepted invite', detail: inv.role });
    await startSession(req, res, user);
    return { user: { id: user.id, email: user.email, role: inv.role } };
  });

  route('GET', /^\/api\/users$/, { auth: 'owner' }, async () => ({ users: await store.listUsers(), invites: await store.listInvites() }));

  route('POST', /^\/api\/invites$/, { auth: 'owner' }, async ({ req, body, session }) => {
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw new HttpError(400, 'Enter a valid email address.');
    const role = ROLES.includes(body.role) ? body.role : 'client';
    const token = newToken();
    await store.createInvite({ email, role, tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + INVITE_DAYS * 86400000).toISOString(), createdBy: session.user.email });
    await store.addAudit({ actor: session.user.email, action: 'Invited user', detail: `${email} (${role})` });
    const base = config.publicUrl || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
    return { link: `${base}/invite/${token}`, expiresInDays: INVITE_DAYS };
  });

  route('DELETE', /^\/api\/invites\/([\w-]{36})$/, { auth: 'owner' }, async ({ match, session }) => {
    await store.deleteInvite(match[1]);
    await store.addAudit({ actor: session.user.email, action: 'Cancelled invite' });
    return { ok: true };
  });

  route('DELETE', /^\/api\/users\/([\w-]{36})$/, { auth: 'owner' }, async ({ match, session }) => {
    if (match[1] === session.user.id) throw new HttpError(400, 'You cannot remove your own account.');
    const u = await store.findUserById(match[1]);
    if (!u) throw new HttpError(404, 'User not found.');
    await store.deleteUser(u.id);
    relay.dropUser(u.id);
    await store.addAudit({ actor: session.user.email, action: 'Removed user', detail: u.email });
    return { ok: true };
  });

  // PCs: the owner creates a short code; the desktop app exchanges it for its own device token.
  route('GET', /^\/api\/devices$/, { auth: 'user' }, async () => ({ devices: await relay.devicesList() }));

  route('POST', /^\/api\/devices\/pairing-code$/, { auth: 'owner' }, async ({ session }) => {
    const code = newPairingCode();
    const expiresAt = Date.now() + PAIRING_MS;
    pairingCodes.set(code, { expiresAt, createdBy: session.user.email });
    await store.addAudit({ actor: session.user.email, action: 'Created PC pairing code' });
    return { code, expiresAt: new Date(expiresAt).toISOString() };
  });

  route('DELETE', /^\/api\/devices\/([\w-]{36})$/, { auth: 'owner' }, async ({ match, session }) => {
    await store.deleteDevice(match[1]);
    relay.dropDevice(match[1]);
    relay.broadcastDevices();
    await store.addAudit({ actor: session.user.email, action: 'Removed PC' });
    return { ok: true };
  });

  route('POST', /^\/api\/device\/pair$/, { kind: 'device' }, async ({ req, body }) => {
    const ip = clientIp(req);
    if (pairLimiter.blockedFor(ip)) throw new HttpError(429, 'Too many attempts. Try again later.');
    const code = normalizePairingCode(body.code);
    const entry = pairingCodes.get(code);
    if (!entry || entry.expiresAt < Date.now()) {
      pairLimiter.fail(ip);
      throw new HttpError(403, 'Wrong or expired pairing code. Create a new code on the website.');
    }
    pairingCodes.delete(code);
    const name = String(body.name || 'PC').trim().slice(0, 100) || 'PC';
    const token = newToken();
    const device = await store.createDevice({ name, tokenHash: tokenHash(token), createdBy: entry.createdBy });
    await store.addAudit({ actor: entry.createdBy, action: 'Paired PC', detail: name });
    relay.broadcastDevices();
    return { deviceId: device.id, name: device.name, token };
  });

  route('GET', /^\/api\/audit$/, { auth: 'owner' }, async () => ({ entries: await store.listAudit(200) }));

  // ---- Desktop app download (signed-in people only) ---------------------------------------------

  route('GET', /^\/api\/downloads$/, { auth: 'user' }, async () => {
    const files = latestInstallers(config.downloadsDir);
    return { version: files[0]?.version || '', files: files.map((f) => ({ ...f, url: `/api/downloads/${f.name}` })) };
  });

  route('GET', /^\/api\/downloads\/([\w.-]{1,120})$/, { auth: 'user', raw: true }, async ({ res, match, session }) => {
    // Serve only a file the listing offers right now (no other names, no paths).
    const file = latestInstallers(config.downloadsDir).find((f) => f.name === match[1]);
    if (!file) throw new HttpError(404, 'That download is no longer available. Reload the page.');
    await store.addAudit({ actor: session.user.email, action: 'Downloaded the desktop app', detail: file.name });
    res.writeHead(200, {
      'Content-Type': 'application/vnd.microsoft.portable-executable',
      'Content-Length': file.size,
      'Content-Disposition': `attachment; filename="${file.name}"`,
      'Cache-Control': 'private, no-store',
    });
    const stream = fs.createReadStream(path.join(config.downloadsDir, file.name));
    stream.on('error', () => res.destroy());
    stream.pipe(res);
  });

  // ---- Request handling ------------------------------------------------------------------------

  async function handle(req, res) {
    securityHeaders(req, res);
    const url = new URL(req.url, 'http://x');
    if (config.requireHttps && !isHttps(req)) {
      res.writeHead(308, { Location: `https://${req.headers.host}${req.url}` });
      return res.end();
    }
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'Method not allowed.' });
      return serveStatic(req, res, url.pathname);
    }
    const r = routes.find((x) => x.method === req.method && x.pattern.test(url.pathname));
    if (!r) return json(res, 404, { error: 'Not found.' });
    try {
      // Browser writes must come from this site and carry the app's header (blocks cross-site form posts).
      if (req.method !== 'GET' && !url.pathname.startsWith('/api/device/')) {
        if (!isAllowedOrigin(req) || req.headers['x-zsr'] !== '1') throw new HttpError(403, 'Request blocked.');
      }
      const session = await resolveSession(req);
      if (r.auth !== 'none' && !session) throw new HttpError(401, 'Please sign in.');
      if (r.auth === 'owner' && session.user.role !== 'owner') throw new HttpError(403, 'Only the owner can do this.');
      const body = req.method === 'POST' ? await readJson(req) : {};
      const result = await r.fn({ req, res, body, session, match: url.pathname.match(r.pattern) });
      if (!r.raw) json(res, 200, result);
    } catch (err) {
      if (res.headersSent) return res.destroy();
      if (!(err instanceof HttpError)) log.error(`[api] ${req.method} ${url.pathname}: ${err.stack || err.message}`);
      json(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Server error.' });
    }
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) json(res, 500, { error: 'Server error.' });
    });
  });
  server.on('upgrade', (req, socket, head) => {
    relay.handleUpgrade(req, socket, head).catch(() => socket.destroy());
  });

  const cleanup = setInterval(() => {
    store.deleteExpired().catch(() => {});
    for (const [code, e] of pairingCodes) if (e.expiresAt < Date.now()) pairingCodes.delete(code);
  }, 60 * 60000);

  async function ensureSetupCode() {
    if ((await store.countUsers()) > 0) return null;
    if (!setupCode) setupCode = newPairingCode();
    return setupCode;
  }

  return {
    server,
    relay,
    ensureSetupCode,
    close: async () => {
      clearInterval(cleanup);
      relay.close();
      await new Promise((r) => server.close(r));
    },
  };
}

module.exports = { createApp };
