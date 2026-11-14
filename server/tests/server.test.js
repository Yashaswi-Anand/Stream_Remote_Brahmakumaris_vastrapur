'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const { loadConfig } = require('../src/config');
const { FileStore } = require('../src/store/fileStore');
const { createApp } = require('../src/app');
const { hashPassword, verifyPassword, RateLimiter, normalizePairingCode } = require('../src/auth');

const once = (ws, pred = () => true) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), 4000);
    const on = (data, isBinary) => {
      const msg = isBinary ? { binary: data } : JSON.parse(data.toString());
      if (pred(msg)) {
        clearTimeout(t);
        ws.off('message', on);
        resolve(msg);
      }
    };
    ws.on('message', on);
  });

async function startServer(extra = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsr-'));
  const config = loadConfig({ DATA_DIR: dir, SETUP_CODE: 'SETUP-1234', PORT: '0', DB_HOST: '', DOWNLOADS_DIR: path.join(dir, 'downloads'), ...extra });
  config.db = null;
  const store = new FileStore(dir);
  await store.init();
  const app = createApp({ config, store, log: { error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const jar = {};
  const call = async (method, url, body, who = 'owner', headers = {}) => {
    const res = await fetch(base + url, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-ZSR': '1', ...(jar[who] ? { Cookie: jar[who] } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie');
    if (set) jar[who] = set.split(';')[0];
    return { status: res.status, body: await res.json().catch(() => ({})) };
  };
  return { app, store, base, call, jar, close: () => app.close() };
}

test('passwords are hashed with scrypt and verified', async () => {
  const h = await hashPassword('correct horse battery');
  assert.match(h, /^scrypt\$/);
  assert.ok(!h.includes('correct'));
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong password!', h), false);
});

test('rate limiter blocks after repeated failures', () => {
  const rl = new RateLimiter({ max: 3, windowMs: 1000, blockMs: 5000 });
  rl.fail('k', 0);
  rl.fail('k', 1);
  assert.equal(rl.blockedFor('k', 2), 0);
  rl.fail('k', 2);
  assert.ok(rl.blockedFor('k', 3) > 0);
  assert.equal(normalizePairingCode(' k7q2 9mxa '), 'K7Q2-9MXA');
});

test('setup, sign-in, invite, pairing and relay work end to end', async (t) => {
  const s = await startServer();
  t.after(() => s.close());

  // First start: only the setup code creates the owner.
  assert.equal((await s.call('GET', '/api/me')).body.needsSetup, true);
  assert.equal((await s.call('POST', '/api/setup', { code: 'nope', email: 'o@x.com', password: 'longpassword1' })).status, 403);
  const setup = await s.call('POST', '/api/setup', { code: 'SETUP-1234', email: 'Owner@X.com', password: 'longpassword1' });
  assert.equal(setup.status, 200);
  assert.equal(setup.body.user.role, 'owner');
  assert.equal((await s.call('POST', '/api/setup', { code: 'SETUP-1234', email: 'b@x.com', password: 'longpassword1' }, 'other')).status, 409);

  // Writes without the app header (e.g. a cross-site form) are refused.
  assert.equal((await s.call('POST', '/api/devices/pairing-code', null, 'owner', { 'X-ZSR': '' })).status, 403);
  assert.equal((await s.call('POST', '/api/devices/pairing-code', null, 'owner', { Origin: 'https://evil.example' })).status, 403);

  // Invite a client; they set their own password.
  const inv = await s.call('POST', '/api/invites', { email: 'client@x.com', role: 'client' });
  assert.equal(inv.status, 200);
  const token = inv.body.link.split('/invite/')[1];
  assert.equal((await s.call('GET', `/api/invite/${token}`, null, 'client')).body.email, 'client@x.com');
  assert.equal((await s.call('POST', '/api/invite/accept', { token, password: 'short' }, 'client')).status, 400);
  const accepted = await s.call('POST', '/api/invite/accept', { token, password: 'clientpassword' }, 'client');
  assert.equal(accepted.body.user.role, 'client');
  assert.equal((await s.call('GET', `/api/invite/${token}`, null, 'x')).status, 404, 'invite links work once');

  // Clients cannot manage people or PCs.
  assert.equal((await s.call('POST', '/api/devices/pairing-code', null, 'client')).status, 403);
  assert.equal((await s.call('GET', '/api/users', null, 'client')).status, 403);

  // Wrong passwords are counted and then blocked.
  for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/api/login', { email: 'client@x.com', password: 'bad-password' }, 'z')).status, 401);
  assert.equal((await s.call('POST', '/api/login', { email: 'client@x.com', password: 'clientpassword' }, 'z')).status, 429);

  // Pair a PC with a one-time code.
  const { code } = (await s.call('POST', '/api/devices/pairing-code')).body;
  assert.equal((await s.call('POST', '/api/device/pair', { code: 'AAAA-BBBB', name: 'PC' }, 'pc')).status, 403);
  const pair = await s.call('POST', '/api/device/pair', { code: code.toLowerCase().replace('-', ' '), name: 'Stream PC' }, 'pc');
  assert.equal(pair.status, 200);
  assert.ok(pair.body.token.length > 30);
  assert.equal((await s.call('POST', '/api/device/pair', { code, name: 'Again' }, 'pc')).status, 403, 'codes work once');
  const stored = JSON.stringify(s.store.data);
  assert.ok(!stored.includes(pair.body.token), 'device token is stored only as a hash');
  assert.ok(!stored.includes('clientpassword'), 'passwords are stored only as hashes');

  const wsBase = s.base.replace('http', 'ws');

  // The PC connects and authenticates.
  const pc = new WebSocket(`${wsBase}/ws/device`);
  await new Promise((r) => pc.on('open', r));
  pc.send(JSON.stringify({ type: 'auth', token: pair.body.token, version: '2.0.0' }));
  const ok = await once(pc, (m) => m.type === 'auth-ok');
  assert.equal(ok.name, 'Stream PC');

  // A cross-site page cannot open the browser socket, even with the cookie.
  const evil = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: s.jar.client, Origin: 'https://evil.example' } });
  await new Promise((r) => evil.on('error', r));
  const anon = new WebSocket(`${wsBase}/ws`);
  await new Promise((r) => anon.on('error', r));

  // The client's phone connects, sees the PC online and its state.
  const phone = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: s.jar.client, Origin: s.base } });
  const devices = await once(phone, (m) => m.type === 'devices');
  assert.equal(devices.devices[0].online, true);
  phone.send(JSON.stringify({ type: 'select', deviceId: ok.deviceId }));
  await new Promise((r) => setTimeout(r, 100));
  pc.send(JSON.stringify({ type: 'state', state: { workflow: { busy: false } } }));
  assert.deepEqual((await once(phone, (m) => m.type === 'state')).state, { workflow: { busy: false } });

  // Commands are checked, forwarded with who sent them, and the answer comes back.
  phone.send(JSON.stringify({ type: 'command', id: 'c1', action: 'formatDisk' }));
  assert.equal((await once(phone, (m) => m.type === 'result' && m.id === 'c1')).ok, false);
  phone.send(JSON.stringify({ type: 'command', id: 'c2', action: 'setSchedule', args: { time: '25:00', enabled: true } }));
  assert.equal((await once(phone, (m) => m.type === 'result' && m.id === 'c2')).error, 'Invalid values.');
  phone.send(JSON.stringify({ type: 'command', id: 'c3', action: 'setSchedule', args: { time: '05:50', enabled: true, extra: 'x' } }));
  const cmd = await once(pc, (m) => m.type === 'command');
  assert.deepEqual(cmd.args, { time: '05:50', enabled: true });
  assert.equal(cmd.by, 'client@x.com');
  pc.send(JSON.stringify({ type: 'result', id: cmd.id, ok: true }));
  assert.equal((await once(phone, (m) => m.type === 'result' && m.id === 'c3')).ok, true);

  // Screen frames flow only while the phone is watching.
  phone.send(JSON.stringify({ type: 'watch', on: true }));
  assert.equal((await once(pc, (m) => m.type === 'watch')).on, true);
  pc.send(Buffer.from([0xff, 0xd8, 1, 2, 3]));
  const frame = await once(phone, (m) => m.binary);
  assert.equal(frame.binary.length, 5);
  phone.send(JSON.stringify({ type: 'watch', on: false }));
  assert.equal((await once(pc, (m) => m.type === 'watch')).on, false);

  const audit = (await s.call('GET', '/api/audit')).body.entries;
  assert.ok(audit.some((a) => a.actor === 'client@x.com' && a.action === 'Save schedule'));

  // Removing the PC disconnects it; its token no longer works.
  const closed = new Promise((r) => pc.on('close', r));
  assert.equal((await s.call('DELETE', `/api/devices/${ok.deviceId}`)).status, 200);
  await closed;
  const pc2 = new WebSocket(`${wsBase}/ws/device`);
  await new Promise((r) => pc2.on('open', r));
  pc2.send(JSON.stringify({ type: 'auth', token: pair.body.token }));
  assert.equal((await once(pc2, (m) => m.type === 'auth-failed')).type, 'auth-failed');

  phone.close();
  pc2.close();
});

test('static files are served with security headers and no path escape', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const res = await fetch(`${s.base}/`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal((await fetch(`${s.base}/invite/abcdefghijklmnopqrstuvwxyz`)).status, 200);
  assert.equal((await fetch(`${s.base}/..%2Fpackage.json`)).status, 404);
  assert.equal((await fetch(`${s.base}/api/users`)).status, 401);
});

test('download page offers only the newest installers, to signed-in people', async (t) => {
  const s = await startServer();
  t.after(() => s.close());
  const dir = path.join(path.dirname(s.store.file), 'downloads');
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, body] of [
    ['Zoom-Stream-Automation-Setup-1.9.0.exe', 'old'],
    ['Zoom-Stream-Automation-Setup-2.0.0.exe', 'new setup'],
    ['Zoom-Stream-Automation-Setup-1.10.0.exe', 'older than 2'],
    ['Zoom-Stream-Automation-Portable-2.0.0.exe', 'portable'],
    ['notes.txt', 'not offered'],
  ]) fs.writeFileSync(path.join(dir, name), body);

  // Not signed in: nothing listed or served.
  assert.equal((await s.call('GET', '/api/downloads', null, 'nobody')).status, 401);
  assert.equal((await fetch(`${s.base}/api/downloads/Zoom-Stream-Automation-Setup-2.0.0.exe`)).status, 401);

  await s.call('POST', '/api/setup', { code: 'SETUP-1234', email: 'o@x.com', password: 'longpassword1' });
  const list = await s.call('GET', '/api/downloads');
  assert.equal(list.status, 200);
  assert.equal(list.body.version, '2.0.0');
  assert.deepEqual(list.body.files.map((f) => f.name), ['Zoom-Stream-Automation-Setup-2.0.0.exe', 'Zoom-Stream-Automation-Portable-2.0.0.exe']);
  assert.equal(list.body.files[0].size, 'new setup'.length);

  const get = (name) => fetch(`${s.base}/api/downloads/${name}`, { headers: { Cookie: s.jar.owner } });
  const res = await get('Zoom-Stream-Automation-Setup-2.0.0.exe');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="Zoom-Stream-Automation-Setup-2.0.0.exe"/);
  assert.equal(await res.text(), 'new setup');
  // Older versions, other files and path tricks are refused.
  for (const name of ['Zoom-Stream-Automation-Setup-1.9.0.exe', 'notes.txt', '..%2F.env', '..%5Cdb.json']) assert.equal((await get(name)).status, 404, name);
  const audit = await s.call('GET', '/api/audit');
  assert.ok(audit.body.entries.some((e) => e.action === 'Downloaded the desktop app' && e.detail === 'Zoom-Stream-Automation-Setup-2.0.0.exe'));
});
