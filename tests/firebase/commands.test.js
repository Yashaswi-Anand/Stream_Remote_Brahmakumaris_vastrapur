'use strict';

/* Rules for the Start Stream checklist and music commands. */

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { fb, SETUP_CODE, SERVER_TIME, reset, newUser, denied } = require('./helpers');

const T = SERVER_TIME;

test('checklist and music commands are accepted only with valid values', async () => {
  await reset();
  const owner = await newUser('owner2@test.local');
  await fb.db('PATCH', '', { owner: { uid: owner.uid, code: SETUP_CODE }, [`users/${owner.uid}`]: { email: owner.email, role: 'owner', createdAt: T } }, owner.token);
  await fb.db('PUT', 'pairing/KLMN-2345', { createdBy: owner.uid, expiresAt: Date.now() + 60000 }, owner.token);
  const pc = await fb.signUpAnonymous();
  const pcId = crypto.randomUUID();
  await fb.db('PATCH', '', { [`pcs/${pcId}`]: { name: 'PC', uid: pc.uid, pairedAt: T, code: 'KLMN-2345' }, ['pairing/KLMN-2345/usedBy']: pcId }, pc.idToken);

  const cmd = (body) => fb.db('PUT', `commands/${pcId}/${crypto.randomUUID()}`, { uid: owner.uid, by: owner.email, at: T, ...body }, owner.token);

  // Start Stream checklist
  await cmd({ action: 'setStartSteps', args: { youtube: false, music: true } });
  await denied(cmd({ action: 'setStartSteps' }));
  await denied(cmd({ action: 'setStartSteps', args: { youtube: 'no' } }));
  await denied(cmd({ action: 'setStartSteps', args: { format: true } }));

  // Music
  await cmd({ action: 'playMusic' });
  await cmd({ action: 'stopMusic' });
  await cmd({ action: 'nextSong' });
  await cmd({ action: 'selectSong', args: { name: 'Om Shanti.mp3' } });
  await denied(cmd({ action: 'selectSong' }));
  await cmd({ action: 'setMusicSource', args: { source: 'youtube' } });
  await denied(cmd({ action: 'setMusicSource', args: { source: 'spotify' } }));
  await cmd({ action: 'setMusicYoutube', args: { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' } });
  await cmd({ action: 'setMusicYoutube', args: { url: 'https://youtu.be/dQw4w9WgXcQ' } });
  await cmd({ action: 'setMusicYoutube', args: { url: '' } });
  await denied(cmd({ action: 'setMusicYoutube', args: { url: 'https://evil.example/watch?v=dQw4w9WgXcQ' } }));
  await denied(cmd({ action: 'playMusic', args: { url: 'https://youtu.be/dQw4w9WgXcQ' } }));
  await denied(cmd({ action: 'selectImage', args: { name: 'a.jpg', extra: 1 } }));

  const queued = await fb.db('GET', `commands/${pcId}`, undefined, pc.idToken);
  assert.equal(Object.keys(queued).length, 9);
});
