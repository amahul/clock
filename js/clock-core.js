// Pure clock model shared by the visitor page, the admin page and the tests.
//
// A clock state is:
//   {
//     anchor_real_time:  server time (epoch ms) when the admin last changed settings
//     anchor_clock_time: time (epoch ms) the clock showed at that moment
//     speed:             1 = normal, 2 = double, 0.5 = half, 0 = paused, <0 = backwards
//     timezone:          IANA zone name used for display, e.g. "Europe/Amsterdam"
//   }
//
// displayed = anchor_clock_time + (serverNow - anchor_real_time) * speed
//
// Nothing in this file reads the device clock: every function takes serverNow
// explicitly, so callers decide how it is estimated and tests are deterministic.

export const DEFAULT_TIMEZONE = 'Europe/Stockholm';

// Postgres timestamptz text, as returned by the REST API
// ("2026-09-25T12:43:15.3243+00:00") or by Realtime ("2026-09-25 12:43:15.3243+00").
const PG_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/;

// Rewrites Postgres timestamps as strict ISO 8601 with milliseconds, which
// every browser parses: 'T' separator, 3 fraction digits, "+hh:mm" offset.
function normalizeTimestamp(text) {
  const match = PG_TIMESTAMP.exec(text.trim());
  if (!match) return text;
  const [, date, time, fraction = '', zone = 'Z'] = match;
  const ms = fraction.padEnd(3, '0').slice(0, 3);
  let offset = zone;
  if (zone !== 'Z') {
    const digits = zone.slice(1).replace(':', '');
    offset = `${zone[0]}${digits.slice(0, 2)}:${digits.slice(2).padEnd(2, '0')}`;
  }
  return `${date}T${time}.${ms}${offset}`;
}

// Accepts epoch ms, a Date, or a timestamp string (ISO or Postgres format).
export function toMs(value) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`Invalid timestamp: ${value}`);
    return value;
  }
  let ms = NaN;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'string') ms = Date.parse(normalizeTimestamp(value));
  if (Number.isNaN(ms)) throw new TypeError(`Invalid timestamp: ${value}`);
  return ms;
}

// ------------------------------------------------ wall-clock time in a timezone

const partsFormatters = new Map();

function zonedParts(ms, timeZone) {
  let formatter = partsFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    partsFormatters.set(timeZone, formatter);
  }
  const parts = {};
  for (const { type, value } of formatter.formatToParts(ms)) parts[type] = Number(value);
  return parts;
}

// Like Date.UTC, but years 0-99 are not mapped to 1900-1999.
function utcFromFields(year, month, day, hour, minute, second, millisecond = 0) {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

// Offset of the timezone from UTC at the given instant, in ms (+1 h = 3600000).
function zoneOffsetMs(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  return utcFromFields(p.year, p.month, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}

const WALL_TIME = /^(\d{4,})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?$/;

// Converts a wall-clock time as given by <input type="datetime-local">
// ("2026-09-25T14:30" or "2026-09-25T14:30:15") in the given timezone to
// epoch ms. Times skipped by a DST change are moved forward by the gap;
// ambiguous times (clocks turned back) resolve to the later occurrence.
export function zonedDateTimeToMs(text, timeZone) {
  const match = WALL_TIME.exec(text);
  if (!match) throw new TypeError(`Invalid date and time: ${text}`);
  const [year, month, day, hour, minute, second] = match.slice(1, 7).map((v) => Number(v ?? 0));
  const millisecond = Number((match[7] ?? '').padEnd(3, '0'));
  const local = utcFromFields(year, month, day, hour, minute, second, millisecond);

  const firstOffset = zoneOffsetMs(local, timeZone);
  let ms = local - firstOffset;
  const secondOffset = zoneOffsetMs(ms, timeZone);
  if (secondOffset !== firstOffset) ms = local - secondOffset;
  return ms;
}

// The inverse: epoch ms to "YYYY-MM-DDTHH:MM:SS" wall-clock time in the timezone.
export function msToZonedDateTime(ms, timeZone) {
  const p = zonedParts(ms, timeZone);
  const pad = (n, width = 2) => String(n).padStart(width, '0');
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

// ------------------------------------------------------------- server offset

// Estimates serverTime - deviceTime from round-trip samples of
// { requestStart, responseEnd, serverTime } (device times in epoch ms).
// The sample with the shortest round trip is the most precise; the server is
// assumed to have read its clock halfway through the round trip.
// Returns { offset, roundTrip }, or null when there are no samples.
export function estimateOffset(samples) {
  let best = null;
  for (const sample of samples) {
    const roundTrip = sample.responseEnd - sample.requestStart;
    if (roundTrip < 0) continue;  // device clock jumped mid-request
    if (best === null || roundTrip < best.roundTrip) {
      best = { roundTrip, serverTime: toMs(sample.serverTime), requestStart: sample.requestStart };
    }
  }
  if (best === null) return null;
  return {
    offset: best.serverTime - (best.requestStart + best.roundTrip / 2),
    roundTrip: best.roundTrip,
  };
}

function assertSpeed(speed) {
  if (typeof speed !== 'number' || !Number.isFinite(speed)) {
    throw new TypeError(`Invalid speed: ${speed}`);
  }
}

// Validates untrusted state (e.g. fetched JSON) and returns a normalized copy
// with epoch-ms timestamps. Throws TypeError if anything is missing or invalid.
export function parseState(raw) {
  if (raw === null || typeof raw !== 'object') {
    throw new TypeError('Clock state must be an object');
  }
  assertSpeed(raw.speed);
  if (typeof raw.timezone !== 'string' || raw.timezone === '') {
    throw new TypeError(`Invalid timezone: ${raw.timezone}`);
  }
  return {
    anchor_real_time: toMs(raw.anchor_real_time),
    anchor_clock_time: toMs(raw.anchor_clock_time),
    speed: raw.speed,
    timezone: raw.timezone,
  };
}

// Short human label for a non-normal speed, or null at normal speed.
export function describeSpeed(speed) {
  if (speed === 1) return null;
  if (speed === 0) return 'Paused';
  if (speed === -1) return 'Running backwards';
  if (speed < 0) return `${-speed}× speed backwards`;
  return `${speed}× speed`;
}

// Returns the time the clock shows at serverNow, in epoch ms.
export function displayedTime(state, serverNow) {
  const anchorReal = toMs(state.anchor_real_time);
  const anchorClock = toMs(state.anchor_clock_time);
  return anchorClock + (toMs(serverNow) - anchorReal) * state.speed;
}

// A clock that shows real time at normal speed.
export function createRealTimeState(serverNow, timezone = DEFAULT_TIMEZONE) {
  const now = toMs(serverNow);
  return {
    anchor_real_time: now,
    anchor_clock_time: now,
    speed: 1,
    timezone,
  };
}

// Admin sets the clock to a specific time; speed and timezone are kept.
export function setTime(state, clockTime, serverNow) {
  return {
    ...state,
    anchor_real_time: toMs(serverNow),
    anchor_clock_time: toMs(clockTime),
  };
}

// Admin changes the speed. Re-anchors at the currently displayed time so the
// clock continues from where it is instead of jumping.
export function setSpeed(state, speed, serverNow) {
  assertSpeed(speed);
  const now = toMs(serverNow);
  return {
    ...state,
    anchor_real_time: now,
    anchor_clock_time: displayedTime(state, now),
    speed,
  };
}

// Admin changes the display timezone. The instant shown does not change.
export function setTimezone(state, timezone) {
  return { ...state, timezone };
}

// Admin resets to real time at normal speed; the timezone is kept.
export function resetToRealTime(state, serverNow) {
  return createRealTimeState(serverNow, state.timezone);
}
