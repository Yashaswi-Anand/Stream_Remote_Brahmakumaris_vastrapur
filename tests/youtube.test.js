'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { findProfile, openInProfile, STUDIO_URL_RE } = require('../src/services/youtube/browserProfile');
const { YouTubeLiveService } = require('../src/services/youtube/youtubeLive');
const { normalizeConfig } = require('../src/services/config/schema');

const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files', 'ProgramFiles(x86)': 'C:\\Program Files (x86)' };
const chromeExe = path.join('C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe');
const chromeState = path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'User Data', 'Local State');
const STUDIO = 'https://studio.youtube.com/channel/UCMQvoyWj_X4k0SismvF-giw/livestreaming';

test('finds the Chrome profile signed in as the YouTube account (case-insensitive)', () => {
  const files = {
    [chromeExe]: '',
    [chromeState]: JSON.stringify({ profile: { info_cache: { 'Profile 4': { user_name: 'someone@gmail.com', name: 'Work' }, 'Profile 28': { user_name: 'BKMVastrapur@gmail.com', name: 'BK Vastrapur' } } } }),
  };
  const io = { env, exists: (f) => f in files, read: (f) => files[f] };
  assert.deepEqual(findProfile('bkmvastrapur@gmail.com', io), { browser: 'Chrome', exe: chromeExe, profileDir: 'Profile 28', profileName: 'BK Vastrapur' });
  assert.equal(findProfile('nobody@gmail.com', io), null);
  assert.equal(findProfile('', io), null);
  assert.equal(findProfile('bkmvastrapur@gmail.com', { env, exists: () => false, read: () => '' }), null);
});

test('only YouTube Studio live links are accepted', () => {
  assert.ok(STUDIO_URL_RE.test(STUDIO));
  for (const bad of ['http://studio.youtube.com/channel/UCMQvoyWj_X4k0SismvF-giw/livestreaming', 'https://evil.example/channel/UCMQvoyWj_X4k0SismvF-giw/livestreaming', 'https://studio.youtube.com/channel/x/livestreaming', `${STUDIO}?x=1`]) {
    assert.equal(STUDIO_URL_RE.test(bad), false, bad);
    assert.throws(() => openInProfile({ exe: 'x', profileDir: 'P' }, bad), /not valid/);
  }
  assert.equal(normalizeConfig({ streaming: { youtubeStudioUrl: 'https://evil.example/x' } }, '2.4.0').streaming.youtubeStudioUrl, STUDIO);
  assert.equal(normalizeConfig({ streaming: { youtubeStudioUrl: '' } }, '2.4.0').streaming.youtubeStudioUrl, '');
});

test('Studio opens in the signed-in profile before Zoom starts the YouTube stream', async () => {
  const order = [];
  const zoom = {
    isLive: async () => order.includes('zoom:live-on-youtube'),
    startYouTubeLive: async () => order.push('zoom:live-on-youtube'),
  };
  const profiles = {
    findProfile: (email) => (email === 'bkmvastrapur@gmail.com' ? { browser: 'Chrome', exe: 'chrome.exe', profileDir: 'Profile 28', profileName: 'BK Vastrapur' } : null),
    openInProfile: (p, url) => order.push(`open:${p.profileDir}:${url}`),
  };
  const logs = [];
  const yt = new YouTubeLiveService({ zoom, logger: { info: (s, m) => logs.push(m), warn: (s, m) => logs.push(m) }, profiles });
  // Skip the 5 s page-load wait in the test.
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    const res = await yt.start({}, { accountEmail: 'bkmvastrapur@gmail.com', studioUrl: STUDIO, timeoutMinutes: 1, isCancelled: () => false, isManuallyConfirmed: () => false });
    assert.equal(res.verified, true);
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepEqual(order, [`open:Profile 28:${STUDIO}`, 'zoom:live-on-youtube']);
  assert.ok(logs.some((m) => /Chrome profile "BK Vastrapur".*already signed in/.test(m)));

  // No matching profile: falls back to the default browser, with a warning.
  order.length = 0;
  logs.length = 0;
  const yt2 = new YouTubeLiveService({ zoom: { ...zoom, isLive: async () => order.includes('zoom:live-on-youtube') }, logger: { info: () => {}, warn: (s, m) => logs.push(m) }, profiles });
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    await yt2.start({}, { accountEmail: 'other@gmail.com', studioUrl: STUDIO, timeoutMinutes: 1, isCancelled: () => false, isManuallyConfirmed: () => false });
  } finally {
    global.setTimeout = realSetTimeout;
  }
  assert.deepEqual(order, ['zoom:live-on-youtube']);
  assert.ok(logs.some((m) => /No Chrome or Edge profile is signed in as other@gmail.com/.test(m)));
});

/** A fake browser page for the Studio steps: which texts are on screen, and what each click does. */
function fakeStudio({ listDate }) {
  const page = { view: 'control-room', live: false, clicks: [] };
  const texts = () =>
    page.view === 'control-room' ? ['Manage', 'Stream'] : page.view === 'manage' ? ['Manage', listDate] : page.view === 'stream' ? ['Go live', 'Manage'] : [];
  const match = (patterns) => texts().find((t) => patterns.some((p) => new RegExp(p, 'i').test(t)));
  const zoom = {
    isLive: async () => page.live,
    startYouTubeLive: async () => {},
    clickGoLiveInBrowser: async () => false,
    uia: { call: async (cmd) => (cmd === 'windows' ? { windows: [{ hwnd: 1, title: 'Live streaming - YouTube Studio', rect: [0, 0, 1200, 800] }] } : {}) },
    findText: async ({ patterns }) => ({ found: !!match(patterns) }),
    clickText: async ({ patterns }) => {
      const t = match(patterns);
      if (!t) return { clicked: false, seen: texts() };
      page.clicks.push(t);
      if (t === 'Manage') page.view = 'manage';
      else if (t === listDate) page.view = 'stream';
      else if (t === 'Go live') page.live = true;
      return { clicked: true, text: t };
    },
  };
  return { page, zoom };
}

const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

test("YouTube Studio: opens Manage, selects only today's stream and clicks Go live", async () => {
  const realSetTimeout = global.setTimeout;
  global.setTimeout = (fn) => realSetTimeout(fn, 0);
  try {
    const { page, zoom } = fakeStudio({ listDate: fmt(new Date()) });
    const profiles = { findProfile: () => ({ browser: 'Chrome', exe: 'c', profileDir: 'P', profileName: 'BK' }), openInProfile: () => {} };
    const yt = new YouTubeLiveService({ zoom, logger: { info() {}, warn() {} }, profiles });
    const res = await yt.start({}, { accountEmail: 'bkmvastrapur@gmail.com', studioUrl: STUDIO, timeoutMinutes: 1, isCancelled: () => false, isManuallyConfirmed: () => false });
    assert.equal(res.verified, true);
    assert.deepEqual(page.clicks, ['Manage', fmt(new Date()), 'Go live']);

    // Only tomorrow's stream is scheduled: it is never selected.
    const tomorrow = new Date(Date.now() + 86400000);
    const t2 = fakeStudio({ listDate: fmt(tomorrow) });
    const yt2 = new YouTubeLiveService({ zoom: t2.zoom, logger: { info() {}, warn() {} }, profiles });
    await assert.rejects(
      () => yt2.start({}, { accountEmail: 'bkmvastrapur@gmail.com', studioUrl: STUDIO, timeoutMinutes: 0.002, isCancelled: () => false, isManuallyConfirmed: () => false }),
      /No YouTube stream scheduled for today/,
    );
    assert.equal(t2.page.clicks.includes(fmt(tomorrow)), false);
    assert.equal(t2.page.live, false);
  } finally {
    global.setTimeout = realSetTimeout;
  }
});

test("Zoom's new More menu: the Livestream tile that starts YouTube directly counts as started", async () => {
  const { ZoomService } = require('../src/services/zoom/zoomService');
  const make = (menuHasSub) => {
    const z = Object.create(ZoomService.prototype);
    z.logger = { info() {}, warn() {} };
    Object.defineProperty(z, 'labels', {
      value: { moreButton: ['^More$'], liveOnYouTube: ['^Live on YouTube$'], liveStreamMenu: ['^Livestream$'], stopLiveStream: ['^Stop [Ll]ivestream$'] },
    });
    let windows = [{ hwnd: 1 }];
    z.getWindows = async () => windows;
    z.clickToolbar = async () => ({ clicked: true });
    z.waitNewWindow = async () => {
      if (windows.length === 1) {
        windows = [...windows, { hwnd: 2 }]; // the More menu opens
        return { hwnd: 2 };
      }
      return menuHasSub ? { hwnd: 3 } : null; // after "Livestream": a submenu, or (new Zoom) nothing
    };
    z.uia = { call: async () => ({}) };
    z.clickText = async ({ hwnd, patterns }) => {
      const text = hwnd === 2 ? 'Livestream' : hwnd === 3 ? 'Live on YouTube' : '';
      return patterns.some((p) => new RegExp(p).test(text)) ? { clicked: true, text } : { clicked: false, seen: [text] };
    };
    return z;
  };
  const direct = await make(false).startYouTubeLive({ hwnd: 1 });
  assert.equal(direct.clicked, true);
  assert.equal(direct.direct, true);
  const viaSub = await make(true).startYouTubeLive({ hwnd: 1 });
  assert.equal(viaSub.text, 'Live on YouTube');
  // Stopping never treats a bare "Livestream" click as done.
  assert.equal(await make(false).stopYouTubeLive({ hwnd: 1 }), false);
});
