'use strict';

/* The desktop app's RemoteClient against the Firebase emulators: pairing, state, commands, live screen,
 * turning remote control off, and removal on the website. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { RemoteClient } = require('../../src/main/remote');
const { normalizeConfig, createDefaultConfig } = require('../../src/services/config/schema');
const { fb, SETUP_CODE, SERVER_TIME, reset, newUser } = require('./helpers');

const T = SERVER_TIME;
const SITE = 'http://127.0.0.1:5555';

const until = async (fn, ms = 8000, what = 'condition') => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
};

function memoryStore() {
  let data = normalizeConfig(createDefaultConfig('2.1.0'), '2.1.0');
  return { get: () => data, update: (f) => (f(data), (data = normalizeConfig(data, '2.1.0'))) };
}

// The website's config.json without Firebase settings = local emulators; everything else goes to the network.
const fetchImpl = (url, opts) => {
  if (String(url) === `${SITE}/config.json`) return Promise.resolve(new Response(JSON.stringify({ firebase: { apiKey: '' } }), { headers: { 'Content-Type': 'application/json' } }));
  return fetch(url, opts);
};

test('desktop app pairs, publishes state, runs commands and streams the screen only while watched', async (t) => {
  await reset();
  const owner = await newUser('owner@test.local');
  await fb.db('PATCH', '', { owner: { uid: owner.uid, code: SETUP_CODE }, [`users/${owner.uid}`]: { email: owner.email, role: 'owner', createdAt: T } }, owner.token);

  let secret = '';
  const ran = [];
  let frames = 0;
  const logs = [];
  const app = { busy: false };
  const client = new RemoteClient({
    store: memoryStore(),
    logger: { info: (s, m) => logs.push(m), warn: (s, m) => logs.push(m), error() {}, success: (s, m) => logs.push(m) },
    tokenStore: { read: () => secret, write: (v) => (secret = v), clear: () => (secret = '') },
    appVersion: '2.1.0',
    defaultName: 'TEST-PC',
    fetchImpl,
    getState: () => ({ workflow: { busy: app.busy }, images: { selectedName: 'a.jpg', names: ['a.jpg', 'b.jpg'] } }),
    runCommand: async (action, args, by) => {
      ran.push({ action, args, by });
      if (action === 'shareImage') throw new Error('No meeting is open.');
      return { ok: true };
    },
    captureFrame: async () => (frames++, Buffer.from([0xff, 0xd8, 0xff, 0xd9])),
    makePreview: async () => 'data:image/jpeg;base64,AAAA',
  });
  t.after(() => client.stop());

  // Pairing: a wrong code is refused; the owner's code works once.
  await assert.rejects(() => client.pair(SITE, 'WXYZ-2345'), /Wrong or expired code/);
  const code = 'MNPQ-2345';
  await fb.db('PUT', `pairing/${code}`, { createdBy: owner.uid, expiresAt: Date.now() + 10 * 60000 }, owner.token);
  const paired = await client.pair(SITE, code.toLowerCase().replace('-', ' '));
  assert.equal(paired.deviceName, 'TEST-PC');
  assert.ok(JSON.parse(secret).refreshToken, 'the refresh token goes to the encrypted token store');
  assert.equal(JSON.stringify(client.store.get()).includes(JSON.parse(secret).refreshToken), false, 'and never into the settings');
  const pcId = client.store.get().remote.deviceId;
  await until(() => client.status.connection === 'connected', 8000, 'connected');

  // The website sees the PC online, with its state and preview.
  const presence = await fb.db('GET', `presence/${pcId}`, undefined, owner.token);
  assert.equal(presence.online, true);
  assert.equal(presence.version, '2.1.0');
  await until(async () => (await fb.db('GET', `state/${pcId}`, undefined, owner.token))?.images?.selectedName === 'a.jpg', 8000, 'state');
  assert.equal((await fb.db('GET', `preview/${pcId}`, undefined, owner.token)).dataUrl, 'data:image/jpeg;base64,AAAA');
  app.busy = true;
  client.stateChanged();
  await until(async () => (await fb.db('GET', `state/${pcId}`, undefined, owner.token))?.workflow?.busy === true, 8000, 'state change');

  // Commands run on the PC; failures come back with the PC's own message.
  const send = async (action, args) => {
    const id = crypto.randomUUID();
    await fb.db('PUT', `commands/${pcId}/${id}`, { action, ...(args ? { args } : {}), uid: owner.uid, by: owner.email, at: T }, owner.token);
    return until(() => fb.db('GET', `results/${pcId}/${id}`, undefined, owner.token), 8000, `result of ${action}`);
  };
  assert.equal((await send('startStream')).ok, true);
  assert.deepEqual(ran[0], { action: 'startStream', args: {}, by: 'owner@test.local' });
  const failed = await send('shareImage');
  assert.equal(failed.ok, false);
  assert.equal(failed.error, 'No meeting is open.');
  assert.equal((await send('setSchedule', { time: '05:50', enabled: true })).ok, true);
  assert.deepEqual(ran[2].args, { time: '05:50', enabled: true });
  assert.equal(await fb.db('GET', `commands/${pcId}`, undefined, client.session.idToken), null, 'handled commands are removed');

  // No frames until someone watches; they stop when nobody does.
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(frames, 0);
  await fb.db('PUT', `watch/${pcId}/${owner.uid}`, T, owner.token);
  await until(async () => (await fb.db('GET', `frames/${pcId}`, undefined, owner.token))?.jpeg === '/9j/2Q==', 8000, 'a frame');
  assert.equal(client.status.watching, true);
  await fb.db('DELETE', `watch/${pcId}/${owner.uid}`, undefined, owner.token);
  await until(() => client.status.watching === false, 8000, 'watching to stop');
  const after = frames;
  await new Promise((r) => setTimeout(r, 2500));
  assert.equal(frames, after);

  // Turning remote control off marks the PC offline; on reconnects.
  client.setEnabled(false);
  await until(async () => (await fb.db('GET', `presence/${pcId}`, undefined, owner.token)).online === false, 8000, 'offline');
  client.setEnabled(true);
  await until(() => client.status.connection === 'connected', 8000, 'reconnected');

  // Removing the PC on the website stops it for good.
  const gone = {};
  for (const n of ['pcs', 'presence', 'state', 'preview', 'frames', 'watch', 'commands', 'results']) gone[`${n}/${pcId}`] = null;
  await fb.db('PATCH', '', gone, owner.token);
  await until(() => client.status.connection === 'error', 15000, 'removal to be noticed');
  assert.match(client.status.error, /removed/);
});
