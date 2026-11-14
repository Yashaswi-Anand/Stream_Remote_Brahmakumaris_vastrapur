'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RemoteClient, remoteState, normalizeServerUrl } = require('../src/main/remote');
const { createActions } = require('../src/main/actions');
const { normalizeConfig, createDefaultConfig } = require('../src/services/config/schema');

// The website server lives in server/ with its own packages.
const WebSocket = require('../server/node_modules/ws');
const { loadConfig } = require('../server/src/config');
const { FileStore } = require('../server/src/store/fileStore');
const { createApp } = require('../server/src/app');

const until = async (fn, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timed out');
};

function memoryStore(config = createDefaultConfig('2.0.0')) {
  let data = normalizeConfig(config, '2.0.0');
  return { get: () => data, update: (fn) => (fn(data), (data = normalizeConfig(data, '2.0.0'))) };
}
const quietLogger = { info() {}, warn() {}, error() {}, success() {} };

test('server address is normalized and plain http is only allowed on the local network', () => {
  assert.equal(normalizeServerUrl('stream.example.com/'), 'https://stream.example.com');
  assert.equal(normalizeServerUrl('http://192.168.1.5:8787/admin'), 'http://192.168.1.5:8787');
  assert.equal(normalizeServerUrl('http://localhost:8787'), 'http://localhost:8787');
  assert.throws(() => normalizeServerUrl('http://stream.example.com'), /https/);
  assert.throws(() => normalizeServerUrl('https://user:pw@example.com'), /not valid/);
  assert.throws(() => normalizeServerUrl(''), /address/);
});

test('remote config keeps only the address and ids, never a token', () => {
  const c = normalizeConfig({ remote: { serverUrl: 'javascript:alert(1)', deviceId: 'x', token: 'secret', enabled: false } }, '2.0.0');
  assert.equal(c.remote.serverUrl, '');
  assert.equal(c.remote.enabled, false);
  assert.equal('token' in c.remote, false);
});

test('remoteState sends no paths or settings, only what the website shows', () => {
  const full = {
    app: { version: '2.0.0', configPath: 'C:\\secret\\config.json' },
    zoom: { status: 'connected', inMeeting: true, sharingDetected: false },
    workflow: { busy: false, action: null, message: '', error: null, waitingForUser: false, steps: [{ id: 'a', label: 'A', status: 'done', detail: '' }], stream: { live: false }, share: { type: null } },
    images: { count: 2, selectedName: 'a.jpg', selectedPath: 'C:\\pics\\a.jpg', previewUrl: 'zsa-img://x', names: ['a.jpg', 'b.jpg'], error: null },
    schedule: { enabled: true, time: '05:50', info: { nextRun: '2026-11-07T00:20:00Z', configured: true } },
    settings: { meetingLink: '91234567890', youtubeAccountEmail: 'x@y.com', zoomPath: 'C:\\Zoom.exe' },
    logs: [{ ts: '2026-11-06T00:00:00Z', level: 'info', source: 'x', message: 'hello' }],
  };
  const s = remoteState(full);
  const json = JSON.stringify(s);
  assert.ok(!json.includes('C:\\'), 'no file paths');
  assert.ok(!json.includes('x@y.com'), 'no settings');
  assert.equal(s.meetingId, '91234567890');
  assert.deepEqual(s.images.names, ['a.jpg', 'b.jpg']);
  assert.equal(s.schedule.nextRun, '2026-11-07T00:20:00Z');
});

test('shared actions: daily schedule from the website saves like the Edit Time dialog', async () => {
  const saved = [];
  const ctx = {
    store: memoryStore(),
    logger: quietLogger,
    images: { list: [path.join('C:', 'pics', 'a.jpg'), path.join('C:', 'pics', 'b.jpg')] },
    workflow: { state: { busy: false, stream: { live: false } }, patch() {} },
    scheduler: { save: async (s) => (saved.push(s), { ok: true, errors: [] }) },
  };
  const actions = createActions({ ctx, refreshImages: () => {} });
  await actions.saveDailySchedule({ time: '05:50', enabled: true });
  assert.equal(saved[0].repeat, 'daily');
  assert.equal(saved[0].time, '05:50');
  assert.equal(saved[0].autoStart, true);
  await assert.rejects(() => actions.saveDailySchedule({ time: '5:50', enabled: true }), /Invalid/);
  actions.selectImageByName('b.jpg');
  assert.equal(path.basename(ctx.store.get().streaming.selectedImagePath), 'b.jpg');
  assert.throws(() => actions.selectImageByName('..\\..\\secret.jpg'), /no longer/);
  ctx.workflow.state.busy = true;
  assert.throws(() => actions.shareImage(), /already running/);
});

test('desktop connector pairs with the website, answers commands and sends frames only while watched', async (t) => {
  // Website server with an owner account and a client signed in.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsr-'));
  const config = loadConfig({ DATA_DIR: dir, SETUP_CODE: 'CODE-0000' });
  config.db = null;
  const sstore = new FileStore(dir);
  await sstore.init();
  const app = createApp({ config, store: sstore, log: { error() {} } });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  let cookie = '';
  const call = async (method, url, body) => {
    const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'X-ZSR': '1', Cookie: cookie }, body: body ? JSON.stringify(body) : undefined });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return res.json();
  };
  await call('POST', '/api/setup', { code: 'CODE-0000', email: 'owner@x.com', password: 'ownerpassword' });
  const { code } = await call('POST', '/api/devices/pairing-code');

  // Desktop side with fakes for the parts that need Electron.
  let token = '';
  const ran = [];
  let frames = 0;
  const appState = { busy: false };
  const client = new RemoteClient({
    store: memoryStore(),
    logger: quietLogger,
    tokenStore: { read: () => token, write: (v) => (token = v), clear: () => (token = '') },
    appVersion: '2.0.0',
    defaultName: 'TEST-PC',
    getState: () => ({ workflow: { busy: appState.busy }, images: { selectedName: 'a.jpg' } }),
    runCommand: async (action, args, by) => {
      ran.push({ action, args, by });
      if (action === 'shareImage') throw new Error('No meeting is open.');
      return { ok: true };
    },
    captureFrame: async () => (frames++, Buffer.from([0xff, 0xd8, 0xff])),
    makePreview: async () => 'data:image/jpeg;base64,AAAA',
  });
  t.after(async () => {
    client.stop();
    await app.close();
  });

  await assert.rejects(() => client.pair(base, 'WRNG-CODE'), /Wrong or expired/);
  const paired = await client.pair(base, code);
  assert.equal(paired.deviceName, 'TEST-PC');
  assert.ok(token.length > 30);
  assert.equal(client.store.get().remote.deviceId.length, 36);
  await until(() => client.status.connection === 'connected');

  // The phone sees the PC and its state, and the preview.
  const phone = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers: { Cookie: cookie, Origin: base } });
  const inbox = [];
  phone.on('message', (d, bin) => inbox.push(bin ? { binary: d } : JSON.parse(d.toString())));
  const devices = await until(() => inbox.find((m) => m.type === 'devices' && m.devices.length));
  assert.equal(devices.devices[0].online, true);
  phone.send(JSON.stringify({ type: 'select', deviceId: devices.devices[0].id }));
  await until(() => inbox.find((m) => m.type === 'state'));
  assert.equal((await until(() => inbox.find((m) => m.type === 'preview'))).dataUrl, 'data:image/jpeg;base64,AAAA');

  // State changes reach the phone.
  appState.busy = true;
  client.stateChanged();
  await until(() => inbox.find((m) => m.type === 'state' && m.state.workflow.busy === true));

  // Commands run on the PC; failures come back with the PC's message.
  phone.send(JSON.stringify({ type: 'command', id: 'k1', action: 'startStream' }));
  assert.equal((await until(() => inbox.find((m) => m.id === 'k1'))).ok, true);
  assert.deepEqual(ran[0], { action: 'startStream', args: {}, by: 'owner@x.com' });
  phone.send(JSON.stringify({ type: 'command', id: 'k2', action: 'shareImage' }));
  assert.equal((await until(() => inbox.find((m) => m.id === 'k2'))).error, 'No meeting is open.');

  // No frames until someone watches; frames stop when they stop watching.
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(frames, 0);
  phone.send(JSON.stringify({ type: 'watch', on: true }));
  await until(() => inbox.find((m) => m.binary));
  assert.equal(client.status.watching, true);
  phone.send(JSON.stringify({ type: 'watch', on: false }));
  await until(() => client.status.watching === false);
  const after = frames;
  await new Promise((r) => setTimeout(r, 1700));
  assert.equal(frames, after);

  // Turning remote control off disconnects; on reconnects.
  client.setEnabled(false);
  await until(() => inbox.some((m) => m.type === 'devices' && m.devices[0] && !m.devices[0].online));
  client.setEnabled(true);
  await until(() => client.status.connection === 'connected');

  // Removing the PC on the website stops it for good.
  await call('DELETE', `/api/devices/${devices.devices[0].id}`);
  await until(() => client.status.connection === 'error');
  assert.match(client.status.error, /removed|Pair/);
  phone.close();
});
