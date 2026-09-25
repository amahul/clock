// Visitor page: shows the clock, kept in sync with Supabase.
import { SUPABASE_JS_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import {
  DEFAULT_TIMEZONE,
  displayedTime,
  parseState,
  estimateOffset,
  toMs,
} from './clock-core.js';

const POLL_INTERVAL_MS = 30_000;         // while Realtime is down
const OFFSET_INTERVAL_MS = 5 * 60_000;   // re-measure the server offset
const OFFSET_SAMPLES = 5;
const RETRY_MIN_MS = 2_000;              // backoff while Supabase is unreachable
const RETRY_MAX_MS = 30_000;
const FIRST_PAINT_TIMEOUT_MS = 3_000;    // show real time if nothing answers by then
const VIEW_STORAGE_KEY = 'clock-view';

// Shown when Supabase has never been reached: real time at normal speed.
const REAL_TIME = { anchor_real_time: 0, anchor_clock_time: 0, speed: 1, timezone: DEFAULT_TIMEZONE };

let serverOffsetMs = 0;       // serverTime - Date.now(), see measureOffset()
let state = null;             // last state received from Supabase
let online = false;           // did the last request to Supabase succeed?
let ready = false;            // false: show placeholders instead of a guess

function serverNow() {
  return Date.now() + serverOffsetMs;
}

const backoff = (failures) => Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** Math.max(0, failures - 1));

// ------------------------------------------------------------ Supabase client

let clientPromise = null;
let importAttempts = 0;

// supabase-js is imported lazily so the clock still renders when the CDN is down.
function getClient() {
  if (!clientPromise) {
    // A failed module import may be cached by the browser; vary the URL on retries.
    const url = importAttempts++ === 0 ? SUPABASE_JS_URL : `${SUPABASE_JS_URL}?retry=${importAttempts}`;
    clientPromise = import(url)
      .then(({ createClient }) => createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      }))
      .catch((error) => {
        clientPromise = null;
        throw error;
      });
  }
  return clientPromise;
}

// ---------------------------------------------------------------- clock state

// An unknown timezone would make Intl throw on every frame, so fall back.
function withValidTimezone(next) {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: next.timezone });
    return next;
  } catch {
    console.warn(`Unknown timezone "${next.timezone}", using ${DEFAULT_TIMEZONE}`);
    return { ...next, timezone: DEFAULT_TIMEZONE };
  }
}

function applyState(raw) {
  const next = withValidTimezone(parseState(raw));
  // Anchors are the server's now() at each change, so they only move forward.
  // This drops a slow poll response that arrives after a newer Realtime update.
  if (state && next.anchor_real_time < state.anchor_real_time) return;
  state = next;
  ready = true;
}

function setOnline(value) {
  online = value;
  ready = true;
}

async function loadState() {
  const db = await getClient();
  const { data, error } = await db
    .from('clock_state')
    .select('anchor_real_time, anchor_clock_time, speed, timezone')
    .eq('id', 1)
    .single();
  if (error) throw error;
  applyState(data);
}

// Polls while Realtime is down, and retries with backoff while offline.
let syncTimer = null;
let syncFailures = 0;
let realtimeConnected = false;

function scheduleSync(delay) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(runSync, delay);
}

async function runSync() {
  clearTimeout(syncTimer);
  try {
    await loadState();
    syncFailures = 0;
    setOnline(true);
  } catch (error) {
    console.warn('Could not load clock state:', error);
    syncFailures++;
    setOnline(false);
  }
  if (syncFailures > 0) scheduleSync(backoff(syncFailures));
  else if (!realtimeConnected) scheduleSync(POLL_INTERVAL_MS);
  // Otherwise Realtime delivers changes and no polling is needed.
}

// ------------------------------------------------------------------- Realtime

let channel = null;
let channelGeneration = 0;   // callbacks from replaced channels are ignored
let realtimeFailures = 0;
let resubscribeTimer = null;

async function subscribe() {
  clearTimeout(resubscribeTimer);
  const db = await getClient();
  const generation = ++channelGeneration;

  channel = db
    .channel(`clock-state-${generation}`)
    .on(
      'postgres_changes',
      { event: '*', schema: 'public', table: 'clock_state', filter: 'id=eq.1' },
      (payload) => {
        if (generation !== channelGeneration || payload.eventType === 'DELETE') return;
        try {
          applyState(payload.new);
          setOnline(true);
        } catch (error) {
          console.warn('Unexpected Realtime payload, reloading:', error);
          runSync();
        }
      },
    )
    .subscribe((status) => {
      if (generation !== channelGeneration) return;
      if (status === 'SUBSCRIBED') {
        realtimeConnected = true;
        realtimeFailures = 0;
        runSync();  // catch up on anything missed while disconnected
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn(`Realtime ${status}; polling until it reconnects`);
        const wasConnected = realtimeConnected;
        realtimeConnected = false;
        if (wasConnected) runSync();  // start polling now
        resubscribeLater();
      }
    });
}

function resubscribeLater() {
  channelGeneration++;  // invalidate the current channel's callbacks
  const old = channel;
  channel = null;
  if (old) getClient().then((db) => db.removeChannel(old)).catch(() => {});

  realtimeFailures++;
  clearTimeout(resubscribeTimer);
  resubscribeTimer = setTimeout(() => {
    subscribe().catch(resubscribeLater);
  }, backoff(realtimeFailures));
}

// -------------------------------------------------------------- server offset

let offsetTimer = null;
let offsetFailures = 0;

async function measureOffset() {
  clearTimeout(offsetTimer);
  try {
    const db = await getClient();
    const samples = [];
    for (let i = 0; i < OFFSET_SAMPLES; i++) {
      const requestStart = Date.now();
      const { data, error } = await db.rpc('get_server_time');
      const responseEnd = Date.now();
      if (error) break;
      samples.push({ requestStart, responseEnd, serverTime: toMs(data) });
    }
    const result = estimateOffset(samples);
    if (result === null) throw new Error('No server time samples');
    serverOffsetMs = result.offset;
    offsetFailures = 0;
  } catch (error) {
    console.warn('Could not measure server time offset:', error);
    offsetFailures++;
  }
  clearTimeout(offsetTimer);  // a concurrent run may have set one meanwhile
  offsetTimer = setTimeout(measureOffset,offsetFailures > 0 ? backoff(offsetFailures) : OFFSET_INTERVAL_MS);
}

// ------------------------------------------------------------------ rendering

const clockEl = document.querySelector('.clock');
const digitalEl = document.getElementById('digital-time');
const dateEl = document.getElementById('clock-date');
const offlineEl = document.getElementById('clock-offline');
const hourHand = document.getElementById('hand-hour');
const minuteHand = document.getElementById('hand-minute');
const secondHand = document.getElementById('hand-second');
const toggleEl = document.getElementById('view-toggle');

let formatters = null;

function getFormatters(timezone) {
  if (formatters?.timezone !== timezone) {
    formatters = {
      timezone,
      parts: new Intl.DateTimeFormat('en-GB', {
        timeZone: timezone, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      }),
      date: new Intl.DateTimeFormat(undefined, {
        timeZone: timezone, weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      }),
    };
  }
  return formatters;
}

// Wall-clock hour, minute and second of an instant in the given timezone.
function wallClock(ms, timezone) {
  const out = {};
  for (const { type, value } of getFormatters(timezone).parts.formatToParts(ms)) {
    if (type === 'hour' || type === 'minute' || type === 'second') out[type] = Number(value);
  }
  return out;
}

const pad = (n) => String(n).padStart(2, '0');

// Only touch the DOM when something actually changes.
function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

function rotate(el, degrees) {
  el.setAttribute('transform', `rotate(${degrees.toFixed(2)})`);
}

function render() {
  requestAnimationFrame(render);
  if (!ready) return;

  const current = state ?? REAL_TIME;
  const shownMs = displayedTime(current, serverNow());
  const { hour, minute, second } = wallClock(shownMs, current.timezone);

  if (clockEl.dataset.view === 'analog') {
    // The sub-second fraction keeps the hands moving smoothly at any speed.
    const s = second + (((shownMs % 1000) + 1000) % 1000) / 1000;
    const m = minute + s / 60;
    const h = (hour % 12) + m / 60;
    rotate(secondHand, s * 6);
    rotate(minuteHand, m * 6);
    rotate(hourHand, h * 30);
  } else {
    setText(digitalEl, `${pad(hour)}:${pad(minute)}:${pad(second)}`);
  }
  setText(dateEl, getFormatters(current.timezone).date.format(shownMs));

  offlineEl.hidden = online;
  if (!online) setText(offlineEl, state ? 'Offline · last known settings' : 'Offline · showing real time');
}

function drawTicks() {
  const ticks = document.getElementById('analog-ticks');
  const svgNs = 'http://www.w3.org/2000/svg';
  for (let i = 0; i < 60; i++) {
    const isHour = i % 5 === 0;
    const line = document.createElementNS(svgNs, 'line');
    line.setAttribute('class', isHour ? 'tick tick-hour' : 'tick');
    line.setAttribute('x1', '0');
    line.setAttribute('x2', '0');
    line.setAttribute('y1', '-88');
    line.setAttribute('y2', isHour ? '-78' : '-84');
    line.setAttribute('transform', `rotate(${i * 6})`);
    ticks.append(line);
  }
}

// ---------------------------------------------------------------- view toggle

function readSavedView() {
  try {
    return localStorage.getItem(VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function setView(view) {
  clockEl.dataset.view = view;
  const other = view === 'digital' ? 'analog' : 'digital';
  toggleEl.textContent = other === 'analog' ? 'Analog' : 'Digital';
  toggleEl.setAttribute('aria-label', `Switch to ${other} clock`);
  try {
    localStorage.setItem(VIEW_STORAGE_KEY, view);
  } catch {
    // Storage unavailable (private mode etc.); the toggle still works.
  }
}

toggleEl.addEventListener('click', () => {
  setView(clockEl.dataset.view === 'digital' ? 'analog' : 'digital');
});

// ---------------------------------------------------------------------- start

drawTicks();
setView(readSavedView() === 'analog' ? 'analog' : 'digital');
requestAnimationFrame(render);
setTimeout(() => { ready = true; }, FIRST_PAINT_TIMEOUT_MS);

// Give the offset a head start so the first painted time is already
// corrected, but don't let a slow measurement hold up loading the state.
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
Promise.race([measureOffset(), delay(1_500)]).finally(() => {
  runSync();
  subscribe().catch(resubscribeLater);
});

// Phones suspend background tabs and drop sockets; catch up when back.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    runSync();
    measureOffset();
  }
});
window.addEventListener('online', () => runSync());
