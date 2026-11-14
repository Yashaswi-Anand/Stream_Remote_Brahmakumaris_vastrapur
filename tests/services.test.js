'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { zonedToUtc, nextOccurrence, latestOccurrence, validateSchedule, formatOffset } = require('../src/services/scheduler/scheduleMath');
const { buildTaskXml } = require('../src/services/scheduler/windowsTask');
const { normalizeConfig, createDefaultConfig } = require('../src/services/config/schema');
const { ConfigStore } = require('../src/services/config/configStore');
const { toZoomUri, meetingButtonPattern } = require('../src/services/zoom/zoomService');
const { getLabels } = require('../src/services/zoom/labels');
const { listImages, pickRandom, isInsideFolder } = require('../src/services/images/imageService');
const { compareVersions, fetchManifest } = require('../src/services/updates/updateService');

const base = { enabled: true, timeZone: 'Asia/Kolkata', streamingMode: 'live', selectedDays: [] };

test('zonedToUtc converts wall time in a zone to UTC', () => {
  assert.equal(new Date(zonedToUtc('2026-10-28', '09:00', 'Asia/Kolkata')).toISOString(), '2026-10-28T03:30:00.000Z');
  // New York is on EDT (UTC-4) before 1 Nov 2026 and EST (UTC-5) after.
  assert.equal(new Date(zonedToUtc('2026-10-30', '09:00', 'America/New_York')).toISOString(), '2026-10-30T13:00:00.000Z');
  assert.equal(new Date(zonedToUtc('2026-11-02', '09:00', 'America/New_York')).toISOString(), '2026-11-02T14:00:00.000Z');
  assert.equal(formatOffset('Asia/Kolkata', Date.UTC(2026, 0, 1)), '+05:30');
});

test('once schedule: next run, then none after it passes', () => {
  const s = { ...base, repeat: 'once', date: '2026-10-28', time: '09:00' };
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.equal(new Date(nextOccurrence(s, now)).toISOString(), '2026-10-28T03:30:00.000Z');
  assert.equal(nextOccurrence(s, Date.parse('2026-10-28T03:31:00Z')), null);
});

test('daily schedule rolls to the next day', () => {
  const s = { ...base, repeat: 'daily', date: '2026-10-01', time: '09:00' };
  const now = Date.parse('2026-10-27T04:00:00Z'); // 09:30 IST
  assert.equal(new Date(nextOccurrence(s, now)).toISOString(), '2026-10-28T03:30:00.000Z');
  assert.equal(new Date(latestOccurrence(s, now)).toISOString(), '2026-10-27T03:30:00.000Z');
});

test('daily schedule does not run before its start date', () => {
  const s = { ...base, repeat: 'daily', date: '2026-11-05', time: '09:00' };
  assert.equal(new Date(nextOccurrence(s, Date.parse('2026-10-27T00:00:00Z'))).toISOString(), '2026-11-05T03:30:00.000Z');
});

test('selected days pick the next matching weekday', () => {
  // 27 Oct 2026 is a Tuesday.
  const s = { ...base, repeat: 'selected_days', selectedDays: ['fri', 'mon'], date: '2026-10-01', time: '18:15' };
  assert.equal(new Date(nextOccurrence(s, Date.parse('2026-10-27T00:00:00Z'))).toISOString(), '2026-10-30T12:45:00.000Z');
});

test('validateSchedule rejects past, missing and malformed values', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  assert.deepEqual(validateSchedule({ ...base, repeat: 'once', date: '2026-10-28', time: '09:00' }, now), []);
  assert.match(validateSchedule({ ...base, repeat: 'once', date: '2026-10-20', time: '09:00' }, now).join(), /past/);
  assert.match(validateSchedule({ ...base, repeat: 'once', date: '', time: '25:00' }, now).join(), /date.*time/);
  assert.match(validateSchedule({ ...base, repeat: 'selected_days', date: '2026-10-28', time: '09:00' }, now).join(), /day/);
  assert.match(validateSchedule({ ...base, repeat: 'once', date: '2026-10-28', time: '09:00', timeZone: 'Mars/Base' }, now).join(), /time zone/);
});

test('task XML contains the trigger, wake and single-instance settings', () => {
  const xml = buildTaskXml({ ...base, repeat: 'selected_days', selectedDays: ['mon', 'wed'], date: '2026-10-01', time: '09:00' }, 'C:\\App\\Zoom Stream Automation.exe', '--scheduled-start', Date.parse('2026-10-27T00:00:00Z'));
  assert.match(xml, /<ScheduleByWeek>/);
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<MultipleInstancesPolicy>IgnoreNew<\/MultipleInstancesPolicy>/);
  assert.match(xml, /<Command>C:\\App\\Zoom Stream Automation.exe<\/Command>/);
  const once = buildTaskXml({ ...base, repeat: 'once', date: '2026-10-28', time: '09:00' }, 'a.exe', '"x" --scheduled-start');
  assert.match(once, /<TimeTrigger>/);
  assert.match(once, /&quot;x&quot;/);
});

test('normalizeConfig recovers defaults from garbage and keeps valid values', () => {
  assert.deepEqual(normalizeConfig(null, '1.0.0'), createDefaultConfig('1.0.0'));
  const c = normalizeConfig({ streaming: { shareSound: false, defaultMode: 'nope' }, schedule: { selectedDays: ['mon', 'xyz', 'mon'], timeZone: 'Bad/Zone' }, logs: [{ ts: 'x', message: 'ok' }, 5] }, '1.0.0');
  assert.equal(c.streaming.shareSound, false);
  assert.equal(c.streaming.defaultMode, 'live');
  assert.deepEqual(c.schedule.selectedDays, ['mon']);
  assert.equal(c.schedule.timeZone, 'Asia/Kolkata');
  assert.equal(c.logs.length, 1);
});

test('ConfigStore backs up a corrupted file and restores defaults', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsa-cfg-'));
  fs.writeFileSync(path.join(dir, 'config.json'), '{ not json');
  const store = new ConfigStore(dir, '1.0.0');
  store.load();
  assert.ok(store.recoveryNote);
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('config.corrupt-')));
  store.update((c) => (c.zoom.meetingLink = '123456789'));
  store.saveNow();
  const again = new ConfigStore(dir, '1.0.0');
  assert.equal(again.load().zoom.meetingLink, '123456789');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('toZoomUri converts links and IDs, rejects other hosts', () => {
  assert.equal(toZoomUri('https://us02web.zoom.us/j/1234567890?pwd=abc123'), 'zoommtg://us02web.zoom.us/join?action=join&confno=1234567890&pwd=abc123');
  assert.equal(toZoomUri('123 456 7890'), 'zoommtg://zoom.us/join?action=join&confno=1234567890');
  assert.equal(toZoomUri('https://evil.example.com/j/1234567890'), null);
  assert.equal(toZoomUri(''), null);
});

test('label overrides accept only known keys with valid regexes', () => {
  const l = getLabels({ moreButton: ['^Mehr$'], bogus: ['x'], stopShare: ['('] });
  assert.deepEqual(l.moreButton, ['^Mehr$']);
  assert.equal(l.bogus, undefined);
  assert.notDeepEqual(l.stopShare, ['(']);
});

test('image listing filters by extension and real image signature', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zsa-img-'));
  fs.writeFileSync(path.join(dir, 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]));
  fs.writeFileSync(path.join(dir, 'b.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]));
  fs.writeFileSync(path.join(dir, 'fake.png'), 'not an image');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
  const res = listImages(dir);
  assert.equal(res.images.length, 2);
  assert.equal(res.skipped, 1);
  assert.notEqual(pickRandom(res.images, res.images[0]), res.images[0]);
  assert.ok(isInsideFolder(res.images[0], dir));
  assert.ok(!isInsideFolder(path.join(dir, '..', 'x.png'), dir));
  assert.match(listImages(path.join(dir, 'missing')).error, /no longer exists/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('version comparison and manifest validation', async () => {
  assert.equal(compareVersions('1.2.10', '1.2.9'), 1);
  assert.equal(compareVersions('v1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('1.0.0', '1.1.0'), -1);
  const ok = await fetchManifest('https://x.test/m.json', async () => ({ ok: true, json: async () => ({ version: '1.1.0', downloadUrl: 'http://insecure' }) }));
  assert.equal(ok.version, '1.1.0');
  assert.equal(ok.downloadUrl, '');
  await assert.rejects(fetchManifest('http://x.test/m.json', async () => ({})), /https/);
  await assert.rejects(fetchManifest('https://x.test/m.json', async () => ({ ok: false, status: 404 })), /404/);
});

test('meeting name pattern matches Zoom Start/Join buttons only', () => {
  const re = new RegExp(meetingButtonPattern("Yash's Zoom Meeting"), 'i');
  assert.ok(re.test("Start Yash's Zoom Meeting"));
  assert.ok(re.test('Join Yash’s Zoom Meeting'));
  assert.ok(re.test("Start  Yash's  Zoom Meeting"));
  assert.ok(!re.test("Open Chat Yash's Zoom Meeting"));
  assert.ok(!re.test("More options for Yash's Zoom Meeting"));
  assert.ok(!re.test("Start Yash's Zoom Meeting 2"));
  const special = new RegExp(meetingButtonPattern('Q&A (weekly) $1.50?'), 'i');
  assert.ok(special.test('Start Q&A (weekly) $1.50?'));
});

test('meeting name is stored, trimmed to 200 chars, and defaults to empty', () => {
  assert.equal(createDefaultConfig().zoom.meetingName, '');
  const c = normalizeConfig({ zoom: { meetingName: 'x'.repeat(300) } }, '1.1.0');
  assert.equal(c.zoom.meetingName.length, 200);
});

test('wake readiness parses powercfg / registry output', () => {
  const { parseWakeTimers, parseSleepStates, parseDelayLock, buildChecklist } = require('../src/services/power/wakeCheck');
  assert.deepEqual(parseWakeTimers('Current AC Power Setting Index: 0x00000001\n    Current DC Power Setting Index: 0x00000000'), { ac: 'enabled', dc: 'disabled' });
  const states = parseSleepStates('The following sleep states are available on this system:\n    Standby (S0 Low Power Idle) Network Connected\n    Hibernate\nThe following sleep states are not available on this system:\n    Standby (S3)');
  assert.deepEqual(states, { modernStandby: true, s3: false, hibernate: true });
  assert.equal(parseDelayLock('    DelayLockInterval    REG_DWORD    0x384'), 900);
  assert.equal(parseDelayLock('ERROR: not found'), null);
  const items = buildChecklist({ wake: { ac: 'enabled', dc: 'disabled' }, states, delayLock: 0xffffffff, onBattery: false, task: { status: 'Ready' } });
  const byId = Object.fromEntries(items.map((i) => [i.id, i.ok]));
  assert.deepEqual(byId, { task: true, wakeAc: true, wakeDc: false, power: true, signin: true, sleep: null, hibernate: true, shutdown: null });
});

test('power helpers: last wake summary and BIOS advice', () => {
  const { parseLastWake, describeBios } = require('../src/services/power/powerActions');
  assert.equal(parseLastWake('Wake History Count - 1\nWake History [0]\n  Wake Source Count - 0').count, 0);
  const timer = parseLastWake('Wake Source Count - 1\n  Wake Source [0]\n    Type: Wake Timer\n    Owner Supplied Reason: Windows will execute \'ZoomStreamAutomation-WakeTest\' scheduled task');
  assert.equal(timer.count, 1);
  assert.match(timer.summary, /Wake Timer/);
  assert.equal(describeBios({ maker: 'LENOVO', model: '83ER', family: 'IdeaPad Slim 3 15IAH8', lenovo: false, dell: false, hp: false, wakeSettings: [] }).ok, false);
  assert.equal(describeBios({ maker: 'LENOVO', model: '20XX', family: 'ThinkPad', lenovo: true, wakeSettings: ['WakeUpOnAlarm,Disable'] }).ok, true);
  assert.equal(describeBios(null).ok, null);
});

test('wake test state is normalized', () => {
  const c = normalizeConfig({ app: { wakeTest: { result: 'bogus', scheduledFor: 5 } } }, '1.3.0');
  assert.deepEqual(c.app.wakeTest, { scheduledFor: '', startedAt: '', wokeAt: '', result: '', detail: '' });
});

test('BIOS power-on confirmation matches boots within 5 minutes of the set time', () => {
  const { matchesPowerOnTime } = require('../src/services/power/powerActions');
  const at = (h, m, s = 0) => new Date(2026, 9, 28, h, m, s).toISOString();
  assert.equal(matchesPowerOnTime(at(5, 40, 30), '05:40').matched, true);
  assert.equal(matchesPowerOnTime(at(5, 44, 0), '05:40').matched, true);
  assert.equal(matchesPowerOnTime(at(5, 47, 0), '05:40').matched, false);
  assert.equal(matchesPowerOnTime(at(13, 54, 0), '05:40').matched, false);
  assert.equal(matchesPowerOnTime(at(5, 40), '').matched, false);
  assert.equal(matchesPowerOnTime('', '05:40').matched, false);
});

test('BIOS guide is detected from the PC it runs on', async () => {
  const { pathToFileURL } = require('url');
  const { detectGuide } = await import(pathToFileURL(path.join(__dirname, '../src/renderer/biosGuides.mjs')).href);
  const id = (info) => detectGuide(info).id;
  assert.equal(id({ maker: 'LENOVO', model: '83ER', family: 'IdeaPad Slim 3 15IAH8', pcType: 2 }), 'lenovo_consumer');
  assert.equal(id({ maker: 'LENOVO', model: '20XW', family: 'ThinkPad E14 Gen 2', pcType: 2 }), 'lenovo_think');
  assert.equal(id({ maker: 'LENOVO', model: '11T0', family: 'ThinkCentre M70q', pcType: 1 }), 'lenovo_think');
  assert.equal(id({ maker: 'Dell Inc.', model: 'Latitude 5420', pcType: 2 }), 'dell');
  assert.equal(id({ maker: 'HP', model: 'HP EliteBook 840 G8', pcType: 2 }), 'hp');
  assert.equal(id({ maker: 'Hewlett-Packard', model: 'HP ProDesk 400', pcType: 1 }), 'hp');
  assert.equal(id({ maker: 'Acer', model: 'Aspire A515', pcType: 2 }), 'acer');
  // Self-built desktops: the maker is a placeholder, the motherboard decides.
  assert.equal(id({ maker: 'To Be Filled By O.E.M.', boardMaker: 'Micro-Star International Co., Ltd.', boardProduct: 'B550M PRO', pcType: 1 }), 'msi_board');
  assert.equal(id({ maker: 'System manufacturer', boardMaker: 'ASUSTeK COMPUTER INC.', boardProduct: 'PRIME B660M-A', pcType: 1 }), 'asus_board');
  assert.equal(id({ maker: 'Gigabyte Technology Co., Ltd.', boardMaker: 'Gigabyte Technology Co., Ltd.', pcType: 1 }), 'gigabyte_board');
  assert.equal(id({ maker: 'To Be Filled By O.E.M.', boardMaker: 'ASRock', pcType: 1 }), 'asrock_board');
  // Brand laptops without a guide, and unreadable data.
  assert.equal(id({ maker: 'ASUSTeK COMPUTER INC.', model: 'VivoBook', pcType: 2 }), 'generic');
  assert.equal(id({ maker: 'Microsoft Corporation', model: 'Surface Laptop 5', pcType: 2 }), 'generic');
  assert.equal(id({ error: 'x' }), 'generic');
  assert.match(detectGuide({ maker: 'To Be Filled By O.E.M.', boardMaker: 'Micro-Star International Co., Ltd.', boardProduct: 'B550M PRO', pcType: 1 }).reason, /MSI motherboard detected \(B550M PRO\)/);
});

test('new schedules default to a 05:50 stream start, without scheduling anything', () => {
  const d = createDefaultConfig('1.4.2');
  assert.equal(d.schedule.time, '05:50');
  assert.equal(d.schedule.date, '');
  assert.equal(d.schedule.enabled, false);
  assert.equal(normalizeConfig({ schedule: { time: 'bad' } }, '1.4.2').schedule.time, '05:50');
  assert.equal(normalizeConfig({ schedule: { time: '07:15' } }, '1.4.2').schedule.time, '07:15');
});

test('Start Stream switches default to on and keep saved values', () => {
  const d = createDefaultConfig('1.5.0');
  assert.equal(d.streaming.openMeetingIfNeeded, true);
  assert.equal(d.streaming.goLiveOnYouTube, true);
  const c = normalizeConfig({ streaming: { goLiveOnYouTube: false, openMeetingIfNeeded: 'yes' } }, '1.5.0');
  assert.equal(c.streaming.goLiveOnYouTube, false);
  assert.equal(c.streaming.openMeetingIfNeeded, true);
});

test("YouTube: only today's stream date matches", () => {
  const { todayPatterns } = require('../src/services/youtube/youtubeLive');
  const today = new Date(2026, 10, 2); // 2 Nov 2026
  const res = todayPatterns(today).map((p) => new RegExp(p, 'i'));
  const hit = (text) => res.some((r) => r.test(text));
  for (const t of ['Nov 2, 2026, 5:50 AM', 'Scheduled for Nov 2, 2026', '2 Nov 2026', 'November 2, 2026', '02/11/2026', '11/02/2026', 'Today, 5:50 AM', 'Today 05:50']) {
    assert.ok(hit(t), `should match: ${t}`);
  }
  for (const t of ['Nov 3, 2026', 'Nov 1, 2026', '3 Nov 2026', 'Nov 22, 2026', '12 Nov 2026', 'Nov 2, 2025', '03/11/2026', "Today's views", 'Tomorrow, 5:50 AM']) {
    assert.ok(!hit(t), `should not match: ${t}`);
  }
});

test('YouTube account email defaults and is validated', () => {
  assert.equal(createDefaultConfig('1.8.0').streaming.youtubeAccountEmail, 'bkmvastrapur@gmail.com');
  assert.equal(normalizeConfig({ streaming: { youtubeAccountEmail: '  other@gmail.com ' } }, '1.8.0').streaming.youtubeAccountEmail, 'other@gmail.com');
});
