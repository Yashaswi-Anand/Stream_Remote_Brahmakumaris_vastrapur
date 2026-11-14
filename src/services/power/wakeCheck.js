'use strict';

const { execFile } = require('child_process');

// powercfg GUIDs: Sleep subgroup and "Allow wake timers".
const SUB_SLEEP = '238C9FA8-0AAD-41ED-83F4-97BE242C8F20';
const RTC_WAKE = 'BD3B718A-0680-4D9D-8AB2-E1D2B4AC806D';
const NEVER_LOCK = 0xffffffff;

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout: 15000 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

/** Reads "Allow wake timers" from `powercfg /q`: { ac, dc } as 'enabled' | 'important' | 'disabled' | null. */
function parseWakeTimers(text) {
  const names = { 0: 'disabled', 1: 'enabled', 2: 'important' };
  const read = (kind) => {
    const m = String(text).match(new RegExp(`Current ${kind} Power Setting Index:\\s*0x([0-9a-f]+)`, 'i'));
    return m ? names[parseInt(m[1], 16)] || null : null;
  };
  return { ac: read('AC'), dc: read('DC') };
}

/** Reads the available sleep states from `powercfg /a`. */
function parseSleepStates(text) {
  const available = String(text).split(/not available/i)[0];
  return {
    modernStandby: /S0 Low Power Idle/i.test(available),
    s3: /Standby \(S3\)/i.test(available),
    hibernate: /Hibernate/i.test(available),
  };
}

/** Reads `reg query "HKCU\Control Panel\Desktop" /v DelayLockInterval` (seconds; 0xFFFFFFFF = never). */
function parseDelayLock(text) {
  const m = String(text).match(/DelayLockInterval\s+REG_DWORD\s+0x([0-9a-f]+)/i);
  return m ? parseInt(m[1], 16) : null;
}

/**
 * Builds the checklist shown under the schedule. Each item: { id, ok: true | false | null, label, detail }.
 * ok = null means "could not be determined" or "informational".
 */
function buildChecklist({ wake, states, delayLock, onBattery, task, bios, wakeTest }) {
  const items = [];
  const timers = (v) => (v === 'enabled' ? 'on' : v === 'important' ? 'important timers only' : v === 'disabled' ? 'off' : 'unknown');
  items.push({
    id: 'task',
    ok: task ? true : false,
    label: 'Windows scheduled task',
    detail: task ? 'Registered with "Wake the computer to run this task".' : 'Not registered: save a schedule with Edit Time.',
  });
  items.push({
    id: 'wakeAc',
    ok: wake.ac === null ? null : wake.ac === 'enabled',
    label: 'Wake timers when plugged in',
    detail: wake.ac === 'enabled' ? 'On.' : `Currently ${timers(wake.ac)}. Turn on: Control Panel → Power Options → Change plan settings → Change advanced power settings → Sleep → Allow wake timers → Plugged in: Enable.`,
  });
  items.push({
    id: 'wakeDc',
    ok: wake.dc === null ? null : wake.dc === 'enabled',
    label: 'Wake timers on battery',
    detail: wake.dc === 'enabled' ? 'On.' : `Currently ${timers(wake.dc)}. Keep the laptop plugged in, or set Allow wake timers → On battery: Enable.`,
  });
  if (onBattery !== null && onBattery !== undefined) {
    items.push({ id: 'power', ok: !onBattery, label: 'Power source now', detail: onBattery ? 'On battery. Plug in before leaving the laptop for a scheduled stream.' : 'Plugged in.' });
  }
  let lockOk = null;
  let lockDetail = 'Could not read the setting.';
  if (delayLock !== null) {
    lockOk = delayLock === NEVER_LOCK;
    lockDetail = lockOk
      ? 'Windows does not ask for sign-in after sleep, so the app can control Zoom after waking.'
      : `Windows asks for sign-in ${delayLock === 0 ? 'every time' : `after ${Math.round(delayLock / 60)} minutes away`}; on a locked screen the app cannot click in Zoom. Settings → Accounts → Sign-in options → "If you've been away…" → Never (a security trade-off).`;
  }
  items.push({ id: 'signin', ok: lockOk, label: 'No sign-in required after sleep', detail: lockDetail });
  items.push({
    id: 'sleep',
    ok: null,
    label: 'Sleep type',
    detail: states.modernStandby
      ? 'Modern Standby: use Start → Power → Sleep (not Shut down) and leave the lid open; closing the lid can put it back to sleep.'
      : states.s3
        ? 'Classic sleep (S3): use Start → Power → Sleep (not Shut down).'
        : 'Sleep may not be available; check Power Options.',
  });
  items.push({
    id: 'hibernate',
    ok: !!states.hibernate,
    label: 'Hibernate (power off, wake by timer)',
    detail: states.hibernate
      ? 'Available. Hibernate uses no power like Shut down, but Windows can power the PC on for the scheduled task if the firmware supports it. Prove it with "Test wake".'
      : 'Not available. Turn it on (admin Command Prompt: powercfg /hibernate on).',
  });
  if (bios) items.push({ id: 'bios', ok: bios.ok, label: 'BIOS power-on schedule', detail: bios.detail });
  if (wakeTest) {
    const map = {
      passed: [true, 'Passed'],
      failed: [false, 'Failed'],
      pending: [null, `Waiting for the PC to wake at ${wakeTest.scheduledFor ? new Date(wakeTest.scheduledFor).toLocaleTimeString() : 'the test time'}`],
      '': [null, 'Not run yet. Use "Test wake" to check this PC really powers on by itself'],
    };
    const [ok, head] = map[wakeTest.result] || map[''];
    items.push({ id: 'wakeTest', ok, label: 'Wake test', detail: `${head}.${wakeTest.detail && wakeTest.result !== '' ? ` ${wakeTest.detail}` : ''}` });
  }
  items.push({
    id: 'shutdown',
    ok: null,
    label: 'From shut down',
    detail: 'Software cannot power on a shut-down PC. Only a BIOS/UEFI "power on at a set time" (RTC wake) option can, if your PC has one.',
  });
  return items;
}

async function checkWakeReadiness({ onBattery = null, task = null, bios = null, wakeTest = null } = {}) {
  const [q, a, reg] = await Promise.all([
    run('powercfg.exe', ['/q', 'SCHEME_CURRENT', SUB_SLEEP, RTC_WAKE]).catch(() => ''),
    run('powercfg.exe', ['/a']).catch(() => ''),
    run('reg.exe', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'DelayLockInterval']).catch(() => ''),
  ]);
  return {
    checkedAt: new Date().toISOString(),
    items: buildChecklist({ wake: parseWakeTimers(q), states: parseSleepStates(a), delayLock: parseDelayLock(reg), onBattery, task, bios, wakeTest }),
  };
}

module.exports = { checkWakeReadiness, parseWakeTimers, parseSleepStates, parseDelayLock, buildChecklist };
