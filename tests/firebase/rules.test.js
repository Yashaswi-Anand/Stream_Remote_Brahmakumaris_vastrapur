'use strict';

/* Security rules of the Stream Remote database, checked against the Firebase emulators. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { fb, ADMIN, SETUP_CODE, SERVER_TIME, reset, newUser, denied } = require('./helpers');

const T = SERVER_TIME;
const token32 = () => crypto.randomBytes(24).toString('base64url');

test('owner claim, invites, pairing, commands and removal follow the rules', async () => {
  await reset();

  // ---- Owner claim -----------------------------------------------------------------------------
  const owner = await newUser('Owner@Test.local');
  assert.equal(await fb.db('GET', 'owner/uid', undefined, null), null, 'anyone can see that no owner exists yet');
  await denied(fb.db('PATCH', '', { owner: { uid: owner.uid, code: 'WRONG-CODE-0000' }, [`users/${owner.uid}`]: { email: owner.email, role: 'owner', createdAt: T } }, owner.token));
  await denied(fb.db('PUT', `users/${owner.uid}`, { email: owner.email, role: 'owner', createdAt: T }, owner.token)); // no claim
  await fb.db('PATCH', '', { owner: { uid: owner.uid, code: SETUP_CODE }, [`users/${owner.uid}`]: { email: owner.email, role: 'owner', createdAt: T } }, owner.token);
  assert.equal(await fb.db('GET', 'owner/uid', undefined, null), owner.uid);
  await denied(fb.db('GET', 'owner/code', undefined, owner.token)); // the setup code is never readable
  await denied(fb.db('GET', 'secrets', undefined, owner.token));

  const intruder = await newUser();
  await denied(fb.db('PATCH', '', { owner: { uid: intruder.uid, code: SETUP_CODE }, [`users/${intruder.uid}`]: { email: intruder.email, role: 'owner', createdAt: T } }, intruder.token));
  await denied(fb.db('PUT', `users/${intruder.uid}`, { email: intruder.email, role: 'client', createdAt: T }, intruder.token));
  await denied(fb.db('GET', 'pcs', undefined, intruder.token));
  await denied(fb.db('GET', 'users', undefined, intruder.token));

  // ---- Invites ---------------------------------------------------------------------------------
  const inviteToken = token32();
  const invite = { email: 'client@test.local', role: 'client', createdBy: owner.uid, createdAt: T, expiresAt: Date.now() + 7 * 86400000 };
  await denied(fb.db('PUT', `invites/${token32()}`, invite, intruder.token));
  await denied(fb.db('PUT', `invites/${inviteToken}`, { ...invite, expiresAt: Date.now() + 30 * 86400000 }, owner.token)); // too long
  await fb.db('PUT', `invites/${inviteToken}`, invite, owner.token);
  assert.equal((await fb.db('GET', `invites/${inviteToken}`, undefined, null)).email, 'client@test.local', 'the link token opens the invite');
  await denied(fb.db('GET', 'invites', undefined, intruder.token)); // but nobody can list invites

  const accept = (u, extra = {}) =>
    fb.db('PATCH', '', { [`users/${u.uid}`]: { email: u.email, role: 'client', createdAt: T, invite: inviteToken, ...extra }, [`invites/${inviteToken}/usedBy`]: u.uid }, u.token);
  await denied(accept(intruder)); // different email
  const client = await newUser('client@test.local');
  await denied(fb.db('PATCH', '', { [`users/${client.uid}`]: { email: client.email, role: 'owner', createdAt: T, invite: inviteToken }, [`invites/${inviteToken}/usedBy`]: client.uid }, client.token)); // other role
  await accept(client);
  const again = await newUser('client@test.local'.replace('@', '+2@'));
  await denied(fb.db('PATCH', '', { [`users/${again.uid}`]: { email: again.email, role: 'client', createdAt: T, invite: inviteToken }, [`invites/${inviteToken}/usedBy`]: again.uid }, again.token)); // used
  await denied(fb.db('GET', 'users', undefined, client.token));
  await denied(fb.db('GET', 'audit', undefined, client.token));
  await denied(fb.db('PUT', `users/${owner.uid}/role`, 'client', client.token));
  await denied(fb.db('PUT', `users/${client.uid}/role`, 'owner', client.token)); // no self-promotion
  await denied(fb.db('PUT', `pairing/ABCD-2345`, { createdBy: client.uid, expiresAt: Date.now() + 60000 }, client.token));

  // ---- Pairing a PC ----------------------------------------------------------------------------
  const code = 'ABCD-2345';
  await fb.db('PUT', `pairing/${code}`, { createdBy: owner.uid, expiresAt: Date.now() + 10 * 60000 }, owner.token);
  const pc = await fb.signUpAnonymous();
  const pcId = crypto.randomUUID();
  const pair = (who, id, c) => fb.db('PATCH', '', { [`pcs/${id}`]: { name: 'STREAM-PC', uid: who.uid, pairedAt: T, code: c }, [`pairing/${c}/usedBy`]: id }, who.idToken);
  await denied(pair(pc, pcId, 'WXYZ-2345')); // unknown code
  await pair(pc, pcId, code);
  const pc2 = await fb.signUpAnonymous();
  await denied(pair(pc2, crypto.randomUUID(), code)); // code already used
  // An expired code is refused.
  await fb.db('PUT', 'pairing/EXPD-2345', { createdBy: owner.uid, expiresAt: Date.now() - 1000 }, ADMIN);
  await denied(pair(pc2, crypto.randomUUID(), 'EXPD-2345'));

  // The PC writes its own data; nobody else can.
  await fb.db('PUT', `presence/${pcId}`, { online: true, lastSeen: T, version: '2.1.0' }, pc.idToken);
  await fb.db('PUT', `state/${pcId}`, { app: { version: '2.1.0' } }, pc.idToken);
  await fb.db('PUT', `preview/${pcId}`, { name: 'a.jpg', dataUrl: 'data:image/jpeg;base64,AAAA' }, pc.idToken);
  await denied(fb.db('PUT', `preview/${pcId}`, { name: 'a.jpg', dataUrl: 'javascript:alert(1)' }, pc.idToken));
  await denied(fb.db('PUT', `presence/${pcId}`, { online: true, lastSeen: T }, pc2.idToken));
  await denied(fb.db('PUT', `state/${pcId}`, { hacked: true }, client.token));
  assert.equal((await fb.db('GET', `pcs/${pcId}`, undefined, client.token)).name, 'STREAM-PC');
  await denied(fb.db('GET', `pcs/${pcId}`, undefined, pc2.idToken));

  // The owner or the PC itself can rename a paired PC, and only its name.
  await fb.db('PUT', `pcs/${pcId}/name`, 'Upjao', owner.token);
  assert.equal(await fb.db('GET', `pcs/${pcId}/name`, undefined, pc.idToken), 'Upjao', 'the PC sees its new name');
  await denied(fb.db('PUT', `pcs/${pcId}/name`, 'Hacked', client.token));
  await fb.db('PUT', `pcs/${pcId}/name`, 'Hall PC', pc.idToken); // the PC renames itself from the desktop app
  await denied(fb.db('PUT', `pcs/${pcId}/name`, 'Hacked', pc2.idToken));
  await denied(fb.db('PUT', `pcs/${pcId}/name`, '   ', owner.token));
  await denied(fb.db('PUT', `pcs/${pcId}/name`, 'x'.repeat(61), owner.token));
  await denied(fb.db('PUT', `pcs/${pcId}/uid`, owner.uid, owner.token));
  await denied(fb.db('PUT', `pcs/${crypto.randomUUID()}/name`, 'Ghost', owner.token)); // no such PC
  await fb.db('PUT', `pcs/${pcId}/name`, 'STREAM-PC', owner.token);

  // ---- Commands --------------------------------------------------------------------------------
  const cmd = (who, body) => fb.db('PUT', `commands/${pcId}/${crypto.randomUUID()}`, { uid: who.uid, by: who.email, at: T, ...body }, who.token);
  await cmd(client, { action: 'startStream' });
  await cmd(client, { action: 'setSchedule', args: { time: '05:50', enabled: true } });
  await cmd(client, { action: 'selectImage', args: { name: 'b.jpg' } });
  await denied(cmd(client, { action: 'formatDisk' }));
  await denied(cmd(client, { action: 'setSchedule', args: { time: '25:00', enabled: true } }));
  await denied(cmd(client, { action: 'startStream', args: { mode: 'x' } }));
  await denied(fb.db('PUT', `commands/${pcId}/x1`, { action: 'startStream', uid: client.uid, by: 'owner@test.local', at: T }, client.token)); // spoofed name
  await denied(cmd(intruder, { action: 'startStream' }));
  await denied(fb.db('GET', `commands/${pcId}`, undefined, client.token)); // only the PC reads commands
  const queued = await fb.db('GET', `commands/${pcId}`, undefined, pc.idToken);
  assert.equal(Object.keys(queued).length, 3);
  for (const id of Object.keys(queued)) {
    await fb.db('PUT', `results/${pcId}/${id}`, { ok: true, at: T }, pc.idToken);
    await fb.db('DELETE', `commands/${pcId}/${id}`, undefined, pc.idToken);
  }
  assert.equal(Object.keys(await fb.db('GET', `results/${pcId}`, undefined, client.token)).length, 3);
  await denied(fb.db('PUT', `results/${pcId}/fake`, { ok: true, at: T }, client.token));

  // ---- Live screen and audit -------------------------------------------------------------------
  await fb.db('PUT', `watch/${pcId}/${client.uid}`, T, client.token);
  await denied(fb.db('PUT', `watch/${pcId}/${owner.uid}`, T, client.token));
  assert.ok(await fb.db('GET', `watch/${pcId}`, undefined, pc.idToken));
  await fb.db('PUT', `frames/${pcId}`, { at: T, jpeg: 'AAAA' }, pc.idToken);
  await denied(fb.db('PUT', `frames/${pcId}`, { at: T, jpeg: 'AAAA' }, client.token));
  await fb.db('POST', 'audit', { at: T, actor: client.email, action: 'Start Stream', detail: 'STREAM-PC' }, client.token);
  await denied(fb.db('POST', 'audit', { at: T, actor: owner.email, action: 'Start Stream' }, client.token));
  assert.equal(Object.keys(await fb.db('GET', 'audit', undefined, owner.token)).length, 1);

  // ---- Removing a person and a PC ----------------------------------------------------------------
  await fb.db('DELETE', `users/${client.uid}`, undefined, owner.token);
  await denied(fb.db('GET', 'pcs', undefined, client.token));
  await denied(cmd(client, { action: 'startStream' }));
  await denied(fb.db('DELETE', `users/${owner.uid}`, undefined, owner.token)); // the owner cannot remove themself

  const removal = {};
  for (const node of ['pcs', 'presence', 'state', 'preview', 'frames', 'watch', 'commands', 'results']) removal[`${node}/${pcId}`] = null;
  await denied(fb.db('PATCH', '', removal, pc2.idToken)); // another PC cannot remove it
  assert.equal((await fb.db('GET', `pcs/${pcId}`, undefined, pc.idToken)).uid, pc.uid, 'a PC can check that it is still paired');
  await fb.db('PATCH', '', removal, owner.token);
  await denied(fb.db('PUT', `presence/${pcId}`, { online: true, lastSeen: T }, pc.idToken));
  await denied(fb.db('GET', `pcs/${pcId}`, undefined, pc.idToken)); // removed: the PC sees it is no longer paired

  // A PC can unpair itself.
  await fb.db('PUT', 'pairing/QRST-2345', { createdBy: owner.uid, expiresAt: Date.now() + 60000 }, owner.token);
  const pc3 = await fb.signUpAnonymous();
  const pc3Id = crypto.randomUUID();
  await pair(pc3, pc3Id, 'QRST-2345');
  const self = {};
  for (const node of ['pcs', 'presence', 'state', 'preview', 'frames', 'watch', 'commands', 'results']) self[`${node}/${pc3Id}`] = null;
  await fb.db('PATCH', '', self, pc3.idToken);
  assert.equal(await fb.db('GET', `pcs/${pc3Id}`, undefined, owner.token), null);
});
