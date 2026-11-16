'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { RemoteClient, remoteState, normalizeServerUrl, normalizePairingCode } = require('../src/main/remote');
const { createActions } = require('../src/main/actions');
const { normalizeConfig, createDefaultConfig } = require('../src/services/config/schema');

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

test('pairing codes are normalized and command events are merged like the database', () => {
  assert.equal(normalizePairingCode(' k7q2 9mxa '), 'K7Q2-9MXA');
  let m = RemoteClient.applyEvent({}, 'put', { path: '/', data: { a: { action: 'x' }, b: { action: 'y' } } });
  m = RemoteClient.applyEvent(m, 'put', { path: '/a', data: null });
  m = RemoteClient.applyEvent(m, 'put', { path: '/c', data: { action: 'z' } });
  m = RemoteClient.applyEvent(m, 'patch', { path: '/', data: { d: 1 } });
  assert.deepEqual(m, { b: { action: 'y' }, c: { action: 'z' }, d: 1 });
  assert.deepEqual(RemoteClient.applyEvent(m, 'put', { path: '/', data: null }), {});
});
