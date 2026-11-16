'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { listSongs, youtubeVideoId, pickRandomSong, songTitle } = require('../src/services/music/musicService');
const { normalizeConfig } = require('../src/services/config/schema');

test('YouTube links are recognised; other links are not', () => {
  const id = 'dQw4w9WgXcQ';
  for (const u of [`https://www.youtube.com/watch?v=${id}`, `https://youtu.be/${id}`, `https://m.youtube.com/watch?v=${id}&t=10`, `https://music.youtube.com/watch?v=${id}`, `https://www.youtube.com/shorts/${id}`, `https://youtube.com/live/${id}`]) {
    assert.equal(youtubeVideoId(u), id, u);
  }
  for (const u of ['', 'not a link', `https://evil.example/watch?v=${id}`, 'https://www.youtube.com/watch?v=short', 'javascript:alert(1)', `ftp://youtu.be/${id}`]) {
    assert.equal(youtubeVideoId(u), '', u);
  }
});

test('only real audio files are listed as songs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsa-music-'));
  fs.writeFileSync(path.join(dir, 'a.mp3'), Buffer.from('ID3\u0003\u0000\u0000\u0000\u0000\u0000\u0000', 'latin1'));
  fs.writeFileSync(path.join(dir, 'b.wav'), Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt ')]));
  fs.writeFileSync(path.join(dir, 'fake.mp3'), 'hello');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const r = listSongs(dir);
  assert.deepEqual(r.songs.map((s) => path.basename(s)), ['a.mp3', 'b.wav']);
  assert.equal(r.skipped, 1);
  assert.equal(listSongs(path.join(dir, 'missing')).error, 'The music folder no longer exists.');
  assert.equal(songTitle(path.join(dir, 'Om Shanti.mp3')), 'Om Shanti');
  assert.notEqual(pickRandomSong(r.songs, r.songs[0]), r.songs[0]);
});

test('Start Stream steps are all on by default; invalid music settings are reset', () => {
  const s = normalizeConfig({}, '2.5.0').streaming;
  assert.equal(s.openMeetingIfNeeded && s.goLiveOnYouTube && s.shareImageOnStart && s.disableAnnotationOnStart && s.playMusicOnStart, true);
  const bad = normalizeConfig({ streaming: { musicSource: 'spotify', musicYoutubeUrl: 'https://evil.example/x', playMusicOnStart: 'yes' } }, '2.5.0').streaming;
  assert.equal(bad.musicSource, 'folder');
  assert.equal(bad.musicYoutubeUrl, '');
  assert.equal(bad.playMusicOnStart, true);
});
