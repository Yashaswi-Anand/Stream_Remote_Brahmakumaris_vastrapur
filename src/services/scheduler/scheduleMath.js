'use strict';

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/** Offset (ms) of `timeZone` from UTC at the given instant. */
function tzOffsetMs(timeZone, instantMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instantMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instantMs / 1000) * 1000;
}

/** UTC instant for a wall-clock date ("YYYY-MM-DD") and time ("HH:MM") in a time zone. */
function zonedToUtc(date, time, timeZone) {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  let result = guess - tzOffsetMs(timeZone, guess);
  // Second pass corrects for a DST transition between the guess and the result.
  result = guess - tzOffsetMs(timeZone, result);
  return result;
}

/** Calendar date ("YYYY-MM-DD") and weekday of an instant in a time zone. */
function zonedDate(instantMs, timeZone) {
  const shifted = new Date(instantMs + tzOffsetMs(timeZone, instantMs));
  const date = shifted.toISOString().slice(0, 10);
  return { date, weekday: DAY_KEYS[shifted.getUTCDay()] };
}

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** "+05:30"-style offset of a time zone at an instant. */
function formatOffset(timeZone, instantMs) {
  const mins = Math.round(tzOffsetMs(timeZone, instantMs) / 60000);
  const sign = mins >= 0 ? '+' : '-';
  const abs = Math.abs(mins);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

/** Returns a list of validation errors for a schedule (empty when valid). */
function validateSchedule(s, nowMs = Date.now()) {
  const errors = [];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.date || '') || Number.isNaN(Date.parse(`${s.date}T00:00:00Z`))) errors.push('Choose a valid start date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s.time || '')) errors.push('Choose a valid start time.');
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: s.timeZone });
  } catch {
    errors.push('Choose a valid time zone.');
  }
  if (!['once', 'daily', 'selected_days'].includes(s.repeat)) errors.push('Choose a repeat option.');
  if (s.repeat === 'selected_days' && !(s.selectedDays || []).length) errors.push('Select at least one day.');
  if (!['live', 'zoom_and_youtube'].includes(s.streamingMode)) errors.push('Choose a streaming mode.');
  if (!errors.length && s.repeat === 'once' && zonedToUtc(s.date, s.time, s.timeZone) <= nowMs) {
    errors.push('The scheduled time is in the past.');
  }
  return errors;
}

/** True when an occurrence falls on a day the schedule runs. */
function runsOnDay(s, date, weekday) {
  if (date < s.date) return false;
  if (s.repeat === 'once') return date === s.date;
  if (s.repeat === 'daily') return true;
  return (s.selectedDays || []).includes(weekday);
}

/** Occurrence instants (UTC ms) in [fromMs, toMs], scanning calendar days in the schedule's zone. */
function occurrencesBetween(s, fromMs, toMs) {
  if (!s.date || !s.time) return [];
  const out = [];
  let day = zonedDate(fromMs, s.timeZone).date;
  day = addDays(day, -1);
  for (let i = 0; i < 400; i++) {
    const at = zonedToUtc(day, s.time, s.timeZone);
    if (at > toMs) break;
    const weekday = DAY_KEYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
    if (at >= fromMs && runsOnDay(s, day, weekday)) out.push(at);
    if (s.repeat === 'once' && day >= s.date) break;
    day = addDays(day, 1);
  }
  return out;
}

/** Next occurrence strictly after `nowMs`, or null when the schedule has no future run. */
function nextOccurrence(s, nowMs = Date.now()) {
  if (!s.date || !s.time) return null;
  const start = Math.max(nowMs + 1, zonedToUtc(s.date, '00:00', s.timeZone) - 86400000);
  const found = occurrencesBetween(s, start, start + 9 * 86400000);
  return found.length ? found[0] : null;
}

/** Most recent occurrence at or before `nowMs` within the last `windowMs`, or null. */
function latestOccurrence(s, nowMs = Date.now(), windowMs = 8 * 86400000) {
  const found = occurrencesBetween(s, nowMs - windowMs, nowMs);
  return found.length ? found[found.length - 1] : null;
}

module.exports = { DAY_KEYS, tzOffsetMs, zonedToUtc, zonedDate, formatOffset, validateSchedule, nextOccurrence, latestOccurrence, occurrencesBetween, addDays };
