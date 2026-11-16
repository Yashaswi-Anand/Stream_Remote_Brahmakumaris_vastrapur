'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fetchManifest, isReleaseAsset, fromGithubRelease, DEFAULT_UPDATE_SOURCE, RELEASE_REPO } = require('../src/services/updates/updateService');

const asset = (name, size = 100) => ({ name, size, browser_download_url: `https://github.com/${RELEASE_REPO}/releases/download/v2.2.0/${name}` });
const release = {
  tag_name: 'v2.2.0',
  body: 'What changed',
  published_at: '2026-11-16T10:00:00Z',
  assets: [asset('Zoom-Stream-Automation-Setup-2.2.0.exe', 122), asset('Zoom-Stream-Automation-Portable-2.2.0.exe', 111), asset('notes.txt')],
};
const respond = (status, body) => async () => ({ ok: status < 400, status, json: async () => body });

test('the latest GitHub release gives the Setup exe (or Portable for the portable build)', async () => {
  const m = await fetchManifest(DEFAULT_UPDATE_SOURCE, respond(200, release));
  assert.equal(m.version, '2.2.0');
  assert.match(m.downloadUrl, /Setup-2\.2\.0\.exe$/);
  assert.equal(m.downloadSize, 122);
  assert.equal(m.releaseNotes, 'What changed');
  const p = await fetchManifest(DEFAULT_UPDATE_SOURCE, respond(200, release), 1000, { portable: true });
  assert.match(p.downloadUrl, /Portable-2\.2\.0\.exe$/);
});

test('no release yet, wrong files and foreign links are handled', async () => {
  await assert.rejects(() => fetchManifest(DEFAULT_UPDATE_SOURCE, respond(404, {})), /No release has been published yet/);
  // Files of another version or from another site are never offered.
  const odd = fromGithubRelease({ tag_name: 'v2.2.0', assets: [asset('Zoom-Stream-Automation-Setup-2.1.0.exe'), { name: 'Zoom-Stream-Automation-Setup-2.2.0.exe', browser_download_url: 'https://evil.example/Zoom-Stream-Automation-Setup-2.2.0.exe' }] });
  assert.equal(odd.downloadUrl, '');
  assert.equal(isReleaseAsset(`https://github.com/${RELEASE_REPO}/releases/download/v2.2.0/Zoom-Stream-Automation-Setup-2.2.0.exe`), true);
  assert.equal(isReleaseAsset('https://github.com/someone/else/releases/download/v1/Zoom-Stream-Automation-Setup-2.2.0.exe'), false);
  assert.equal(isReleaseAsset(`http://github.com/${RELEASE_REPO}/releases/download/v2.2.0/Zoom-Stream-Automation-Setup-2.2.0.exe`), false);
  assert.throws(() => fromGithubRelease({ tag_name: 'latest' }), /version tag/);
});

test('a plain JSON manifest still works', async () => {
  const m = await fetchManifest('https://example.com/latest.json', respond(200, { version: '3.0.0', downloadUrl: 'https://example.com/x.exe' }));
  assert.equal(m.version, '3.0.0');
});
