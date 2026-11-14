'use strict';

/** Default configuration. Anything missing or invalid in config.json falls back to these values. */
function createDefaultConfig(version = '1.0.0') {
  return {
    app: {
      version,
      launchOnWindowsStartup: false,
      logRetention: 300,
      // Last "wake from hibernate/sleep" test: result is '' | 'pending' | 'passed' | 'failed'.
      wakeTest: { scheduledFor: '', startedAt: '', wokeAt: '', result: '', detail: '' },
      // The power-on time the user set in BIOS (local "HH:MM"), used to confirm an automatic power-on happened.
      biosPowerOn: { time: '', repeat: 'daily', lastVerifiedAt: '' },
    },
    zoom: {
      executablePath: '',
      meetingName: '',
      meetingLink: '',
      lastKnownStatus: 'disconnected',
      labelOverrides: {},
    },
    streaming: {
      defaultMode: 'live',
      // Start Stream steps: open Zoom and the configured meeting when none is open; go live on YouTube.
      openMeetingIfNeeded: true,
      goLiveOnYouTube: true,
      imageFolderPath: '',
      selectedImagePath: '',
      shareSound: true,
      shareComputerAudio: true,
      endMeetingAfterStream: false,
      autoClickGoLive: true,
      // Google account clicked in the account chooser when YouTube asks which account to use.
      youtubeAccountEmail: 'bkmvastrapur@gmail.com',
      liveConfirmTimeoutMinutes: 5,
    },
    schedule: {
      enabled: false,
      date: '',
      // Default stream start time for new installs (no date, so nothing is scheduled until saved).
      time: '05:50',
      timeZone: 'Asia/Kolkata',
      repeat: 'once',
      selectedDays: [],
      streamingMode: 'live',
      autoStart: true,
      requireConfirmation: false,
      savedAt: '',
      lastExecutedOccurrence: '',
      lastMissedOccurrence: '',
    },
    // Remote control website: the address this PC is paired with. The device token is not stored here;
    // it is kept encrypted by Windows in a separate file.
    remote: {
      enabled: true,
      serverUrl: '',
      deviceId: '',
      deviceName: '',
    },
    updates: {
      latestVersion: '',
      releaseManifestUrl: '',
      lastCheckedAt: '',
      releaseNotes: '',
      downloadUrl: '',
    },
    logs: [],
  };
}

const MODES = ['live', 'zoom_and_youtube'];
const REPEATS = ['once', 'daily', 'selected_days'];
const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LOG_LEVELS = ['info', 'success', 'warn', 'error'];

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v, d) => (typeof v === 'string' ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);
const int = (v, d, min, max) => (Number.isInteger(v) && v >= min && v <= max ? v : d);

function isValidTimeZone(tz) {
  if (typeof tz !== 'string' || !tz) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Merges a parsed (possibly partial or malformed) config object onto defaults,
 * keeping only known keys with valid types.
 */
const BIOS_REPEATS = ['daily', 'weekdays', 'selected_days', 'once'];

function normalizeBiosPowerOn(b) {
  const v = isObj(b) ? b : {};
  return {
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(v.time) ? v.time : '',
    repeat: oneOf(v.repeat, BIOS_REPEATS, 'daily'),
    lastVerifiedAt: str(v.lastVerifiedAt, ''),
  };
}

function normalizeWakeTest(w) {
  const v = isObj(w) ? w : {};
  return {
    scheduledFor: str(v.scheduledFor, ''),
    startedAt: str(v.startedAt, ''),
    wokeAt: str(v.wokeAt, ''),
    result: oneOf(v.result, ['', 'pending', 'passed', 'failed'], ''),
    detail: str(v.detail, '').slice(0, 1000),
  };
}

function normalizeConfig(raw, version) {
  const d = createDefaultConfig(version);
  const r = isObj(raw) ? raw : {};
  const app = isObj(r.app) ? r.app : {};
  const zoom = isObj(r.zoom) ? r.zoom : {};
  const s = isObj(r.streaming) ? r.streaming : {};
  const sc = isObj(r.schedule) ? r.schedule : {};
  const up = isObj(r.updates) ? r.updates : {};
  const rm = isObj(r.remote) ? r.remote : {};

  const logRetention = int(app.logRetention, d.app.logRetention, 20, 5000);
  const logs = Array.isArray(r.logs)
    ? r.logs
        .filter((l) => isObj(l) && typeof l.message === 'string' && typeof l.ts === 'string')
        .map((l) => ({
          ts: l.ts,
          level: oneOf(l.level, LOG_LEVELS, 'info'),
          source: str(l.source, 'app'),
          message: l.message.slice(0, 2000),
        }))
        .slice(-logRetention)
    : [];

  return {
    app: {
      version: d.app.version,
      launchOnWindowsStartup: bool(app.launchOnWindowsStartup, d.app.launchOnWindowsStartup),
      logRetention,
      wakeTest: normalizeWakeTest(app.wakeTest),
      biosPowerOn: normalizeBiosPowerOn(app.biosPowerOn),
    },
    zoom: {
      executablePath: str(zoom.executablePath, ''),
      meetingName: str(zoom.meetingName, '').slice(0, 200),
      meetingLink: str(zoom.meetingLink, ''),
      lastKnownStatus: str(zoom.lastKnownStatus, d.zoom.lastKnownStatus),
      labelOverrides: isObj(zoom.labelOverrides) ? zoom.labelOverrides : {},
    },
    streaming: {
      defaultMode: oneOf(s.defaultMode, MODES, d.streaming.defaultMode),
      openMeetingIfNeeded: bool(s.openMeetingIfNeeded, d.streaming.openMeetingIfNeeded),
      youtubeAccountEmail: typeof s.youtubeAccountEmail === 'string' ? s.youtubeAccountEmail.trim().slice(0, 254) : d.streaming.youtubeAccountEmail,
      goLiveOnYouTube: bool(s.goLiveOnYouTube, d.streaming.goLiveOnYouTube),
      imageFolderPath: str(s.imageFolderPath, ''),
      selectedImagePath: str(s.selectedImagePath, ''),
      shareSound: bool(s.shareSound, d.streaming.shareSound),
      shareComputerAudio: bool(s.shareComputerAudio, d.streaming.shareComputerAudio),
      endMeetingAfterStream: bool(s.endMeetingAfterStream, d.streaming.endMeetingAfterStream),
      autoClickGoLive: bool(s.autoClickGoLive, d.streaming.autoClickGoLive),
      liveConfirmTimeoutMinutes: int(s.liveConfirmTimeoutMinutes, d.streaming.liveConfirmTimeoutMinutes, 1, 30),
    },
    schedule: {
      enabled: bool(sc.enabled, false),
      date: /^\d{4}-\d{2}-\d{2}$/.test(sc.date) ? sc.date : '',
      time: /^\d{2}:\d{2}$/.test(sc.time) ? sc.time : d.schedule.time,
      timeZone: isValidTimeZone(sc.timeZone) ? sc.timeZone : d.schedule.timeZone,
      repeat: oneOf(sc.repeat, REPEATS, 'once'),
      selectedDays: Array.isArray(sc.selectedDays) ? [...new Set(sc.selectedDays.filter((x) => DAYS.includes(x)))] : [],
      streamingMode: oneOf(sc.streamingMode, MODES, 'live'),
      autoStart: bool(sc.autoStart, true),
      requireConfirmation: bool(sc.requireConfirmation, false),
      savedAt: str(sc.savedAt, ''),
      lastExecutedOccurrence: str(sc.lastExecutedOccurrence, ''),
      lastMissedOccurrence: str(sc.lastMissedOccurrence, ''),
    },
    remote: {
      enabled: bool(rm.enabled, true),
      serverUrl: typeof rm.serverUrl === 'string' && /^https?:\/\/[^\s]+$/i.test(rm.serverUrl) ? rm.serverUrl.slice(0, 300) : '',
      deviceId: str(rm.deviceId, '').slice(0, 64),
      deviceName: str(rm.deviceName, '').slice(0, 100),
    },
    updates: {
      latestVersion: str(up.latestVersion, ''),
      releaseManifestUrl: str(up.releaseManifestUrl, ''),
      lastCheckedAt: str(up.lastCheckedAt, ''),
      releaseNotes: str(up.releaseNotes, ''),
      downloadUrl: str(up.downloadUrl, ''),
    },
    logs,
  };
}

module.exports = {
  BIOS_REPEATS, createDefaultConfig, normalizeConfig, isValidTimeZone, MODES, REPEATS, DAYS, LOG_LEVELS };
