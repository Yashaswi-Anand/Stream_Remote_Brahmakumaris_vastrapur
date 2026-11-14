export const MODE_LABELS = {
  live: 'Live Streaming',
  zoom_and_youtube: 'Start Zoom and YouTube Streaming',
};

export const MODE_HINTS = {
  live: 'Uses the open meeting; opens Zoom and your meeting first if needed.',
  zoom_and_youtube: 'Opens Zoom and starts your meeting (by name) if needed, then streams.',
};

export const DAYS = [
  ['mon', 'Mon'],
  ['tue', 'Tue'],
  ['wed', 'Wed'],
  ['thu', 'Thu'],
  ['fri', 'Fri'],
  ['sat', 'Sat'],
  ['sun', 'Sun'],
];

export function formatDateTime(iso, timeZone) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

export function formatTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function relativeFromNow(iso) {
  const diff = new Date(iso).getTime() - Date.now();
  const mins = Math.round(diff / 60000);
  if (Math.abs(mins) < 1) return 'now';
  const abs = Math.abs(mins);
  const text = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.floor(abs / 60)} h ${abs % 60} min` : `${Math.floor(abs / 1440)} d ${Math.floor((abs % 1440) / 60)} h`;
  return diff > 0 ? `in ${text}` : `${text} ago`;
}

export function timeZones() {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    return ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York', 'America/Los_Angeles'];
  }
}

export function localTimeZone() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

export const ZOOM_STATUS = {
  connected: ['success', 'Connected'],
  disconnected: ['warning', 'Disconnected'],
  not_installed: ['danger', 'Not Installed'],
  unknown: ['neutral', 'Checking…'],
};

export function isNewer(a, b) {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/** Default stream start time for a new schedule, and the BIOS power-on time 5 minutes before it. */
export const DEFAULT_STREAM_TIME = '05:50';
export const DEFAULT_POWER_ON_TIME = '05:45';

/** Meeting ID from what the user typed: digits, or the ID inside a zoom.us invite link. */
export function meetingIdFrom(value) {
  const v = String(value || '').trim();
  const digits = v.replace(/[\s-]/g, '');
  if (/^\d{9,12}$/.test(digits)) return digits;
  const m = v.match(/zoom(?:gov)?\.(?:us|com)\/(?:j|s|w|wc\/join)\/(\d{9,12})/i);
  return m ? m[1] : '';
}

/** "91234567890" → "912 3456 7890". */
export function formatMeetingId(id) {
  const d = String(id || '');
  if (d.length === 11) return `${d.slice(0, 3)} ${d.slice(3, 7)} ${d.slice(7)}`;
  if (d.length === 10 || d.length === 9) return `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return d;
}
