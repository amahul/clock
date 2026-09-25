// Admin page: log in with Supabase Auth and change the clock through the
// SECURITY DEFINER functions in supabase/setup.sql.
import { SUPABASE_JS_URL, SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';
import {
  DEFAULT_TIMEZONE,
  displayedTime,
  parseState,
  describeSpeed,
  estimateOffset,
  toMs,
  zonedDateTimeToMs,
  msToZonedDateTime,
} from './clock-core.js';

// Speeds the slider steps through; any other value can be typed in.
const SPEED_STOPS = [-60, -10, -5, -2, -1, -0.5, 0, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
const SLIDER_DEBOUNCE_MS = 400;
const OFFSET_SAMPLES = 3;

// Supabase Auth only knows emails, so a plain username "anna" logs in as
// "anna@clock.local". Create such users in the dashboard with Auto Confirm.
const USERNAME_DOMAIN = 'clock.local';
const toLoginEmail = (name) => (name.includes('@') ? name : `${name}@${USERNAME_DOMAIN}`).toLowerCase();

const $ = (id) => document.getElementById(id);
const els = {
  loading: $('loading'),
  login: $('login'),
  loginForm: $('login-form'),
  loginEmail: $('login-email'),
  loginPassword: $('login-password'),
  session: $('session'),
  sessionEmail: $('session-email'),
  logout: $('logout'),
  notAdmin: $('not-admin'),
  controls: $('controls'),
  currentState: $('current-state'),
  presets: document.querySelectorAll('[data-speed]'),
  slider: $('speed-slider'),
  sliderValue: $('speed-slider-value'),
  speedForm: $('speed-form'),
  speedInput: $('speed-input'),
  timeForm: $('time-form'),
  timeInput: $('time-input'),
  timezoneSelect: $('timezone-select'),
  timeRevert: $('time-revert'),
  reset: $('reset'),
  message: $('message'),
};

let db = null;
let state = null;
let serverOffsetMs = 0;
let timeEdited = false;   // true once the admin types in the datetime field

const serverNow = () => Date.now() + serverOffsetMs;
const speedText = (speed) => describeSpeed(speed) ?? 'Normal speed (1×)';

// ------------------------------------------------------------------- messages

let messageTimer = null;

function showMessage(text, kind = 'info') {
  clearTimeout(messageTimer);
  els.message.textContent = text;
  els.message.className = `message message-${kind}`;
  els.message.hidden = false;
  if (kind !== 'pending') {
    messageTimer = setTimeout(() => { els.message.hidden = true; }, kind === 'error' ? 10_000 : 4_000);
  }
}

function isNetworkError(error) {
  return !navigator.onLine
    || error?.name === 'AuthRetryableFetchError'
    || /failed to fetch|networkerror|load failed|fetch failed/i.test(error?.message ?? '');
}

async function describeError(error) {
  if (isNetworkError(error)) {
    return 'Network problem: could not reach Supabase. Check your connection and try again.';
  }
  const { data } = await db.auth.getSession();  // local check, no network
  if (!data.session) return 'You are not logged in. Log in and try again.';
  if (error?.code === '42501') return 'This account is not an admin, so it cannot change the clock.';
  if (error?.code === 'PGRST301' || error?.code === 'PGRST303' || /jwt/i.test(error?.message ?? '')) {
    return 'Your session has expired. Log out and log in again.';
  }
  if (error?.code === '22023') return error.message;  // validation message from set_clock
  return `Something went wrong: ${error?.message ?? error}`;
}

// ------------------------------------------------------------ calling Supabase

// Changes run one at a time, in order, so quick clicks are never lost or reordered.
let queue = Promise.resolve();

function changeClock(fn, args, successText, resetTimeForm = true) {
  queue = queue.then(async () => {
    showMessage('Saving…', 'pending');
    try {
      const { data, error } = await db.rpc(fn, args);
      if (error) throw error;
      applyState(data, resetTimeForm);
      showMessage(successText, 'success');
      return true;
    } catch (error) {
      console.warn(`${fn} failed:`, error);
      showMessage(await describeError(error), 'error');
      return false;
    }
  });
  return queue;
}

async function loadState() {
  const { data, error } = await db
    .from('clock_state')
    .select('anchor_real_time, anchor_clock_time, speed, timezone')
    .eq('id', 1)
    .single();
  if (error) {
    showMessage(await describeError(error), 'error');
    return;
  }
  applyState(data);
}

async function measureOffset() {
  const samples = [];
  for (let i = 0; i < OFFSET_SAMPLES; i++) {
    const requestStart = Date.now();
    const { data, error } = await db.rpc('get_server_time');
    const responseEnd = Date.now();
    if (error) break;
    samples.push({ requestStart, responseEnd, serverTime: toMs(data) });
  }
  const result = estimateOffset(samples);
  if (result) serverOffsetMs = result.offset;
}

// -------------------------------------------------------------------- session

let shownUserId;          // undefined until the first auth event
let viewGeneration = 0;   // ignores slow is_admin answers for an old session

function showOnly(...visible) {
  for (const el of [els.loading, els.login, els.notAdmin, els.controls]) {
    el.hidden = !visible.includes(el);
  }
}

async function showSession(session) {
  const userId = session?.user?.id ?? null;
  if (userId === shownUserId) return;  // e.g. a token refresh for the same user
  shownUserId = userId;
  const generation = ++viewGeneration;

  els.session.hidden = !session;
  if (!session) {
    state = null;
    showOnly(els.login);
    return;
  }
  els.sessionEmail.textContent = session.user.email;
  els.loading.textContent = 'Checking admin rights…';
  showOnly(els.loading);

  const { data: isAdmin, error } = await db.rpc('is_admin');
  if (generation !== viewGeneration) return;
  if (error) {
    els.loading.textContent = `${await describeError(error)} Reload the page to try again.`;
    return;
  }
  if (!isAdmin) {
    showOnly(els.notAdmin);
    return;
  }
  showOnly(els.controls);
  await Promise.all([loadState(), measureOffset()]);
}

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = els.loginForm.querySelector('[type="submit"]');
  submit.disabled = true;
  const { error } = await db.auth.signInWithPassword({
    email: toLoginEmail(els.loginEmail.value.trim()),
    password: els.loginPassword.value,
  });
  submit.disabled = false;
  if (error) {
    console.warn('Login failed:', error);
    showMessage(
      isNetworkError(error) ? await describeError(error)
        : /invalid login credentials/i.test(error.message) ? 'Wrong username or password.'
        : `Could not log in: ${error.message}`,
      'error',
    );
    return;
  }
  els.loginPassword.value = '';
  els.message.hidden = true;
});

els.logout.addEventListener('click', async () => {
  const { error } = await db.auth.signOut();
  if (error) showMessage(`Could not log out: ${await describeError(error)}`, 'error');
});

// ------------------------------------------------------------------- controls

function nearestStopIndex(speed) {
  let best = 0;
  for (let i = 1; i < SPEED_STOPS.length; i++) {
    if (Math.abs(SPEED_STOPS[i] - speed) < Math.abs(SPEED_STOPS[best] - speed)) best = i;
  }
  return best;
}

function setSliderLabel(speed) {
  els.sliderValue.textContent = `${speed}×`;
}

function ensureTimezoneOption(timezone) {
  if (![...els.timezoneSelect.options].some((option) => option.value === timezone)) {
    els.timezoneSelect.add(new Option(timezone, timezone), 0);
  }
}

function fillTimezones() {
  let zones = [];
  try {
    zones = Intl.supportedValuesOf('timeZone');
  } catch {
    // Older browsers: the current zone can still be kept or typed via SQL.
  }
  for (const zone of [...new Set([...zones, 'UTC', DEFAULT_TIMEZONE])].sort()) {
    els.timezoneSelect.add(new Option(zone, zone));
  }
}

// resetTimeForm: discard unsaved edits in the time/timezone form. False after
// speed changes, so a half-typed time survives clicking a speed preset.
function applyState(raw, resetTimeForm = true) {
  state = parseState(raw);
  const { speed, timezone } = state;

  els.currentState.textContent = `Now: ${speedText(speed)} · ${timezone}`;
  for (const button of els.presets) {
    button.setAttribute('aria-pressed', String(Number(button.dataset.speed) === speed));
  }
  els.slider.value = String(nearestStopIndex(speed));
  setSliderLabel(speed);
  if (document.activeElement !== els.speedInput) els.speedInput.value = String(speed);

  ensureTimezoneOption(timezone);
  if (resetTimeForm) {
    els.timezoneSelect.value = timezone;
    timeEdited = false;
  }
  updateTimeInput();
}

// Keeps the datetime field showing the clock's current time until the admin
// starts editing it.
function updateTimeInput() {
  if (!state || timeEdited || document.activeElement === els.timeInput) return;
  const shown = displayedTime(state, serverNow());
  els.timeInput.value = msToZonedDateTime(shown, els.timezoneSelect.value);
}

function applySpeed(speed) {
  if (!Number.isFinite(speed)) {
    showMessage('Enter a speed as a number, e.g. 2, 0.5 or -1.', 'error');
    return;
  }
  changeClock('set_clock_speed', { new_speed: speed }, `Speed set: ${speedText(speed)}.`, false);
}

for (const button of els.presets) {
  button.addEventListener('click', () => applySpeed(Number(button.dataset.speed)));
}

// Applies once the slider has been still briefly, so dragging sends one change.
let sliderTimer = null;
els.slider.addEventListener('input', () => {
  const speed = SPEED_STOPS[Number(els.slider.value)];
  setSliderLabel(speed);
  clearTimeout(sliderTimer);
  sliderTimer = setTimeout(() => applySpeed(speed), SLIDER_DEBOUNCE_MS);
});

els.speedForm.addEventListener('submit', (event) => {
  event.preventDefault();
  applySpeed(els.speedInput.value.trim() === '' ? NaN : Number(els.speedInput.value));
});

els.timeInput.addEventListener('input', () => { timeEdited = true; });
els.timezoneSelect.addEventListener('change', updateTimeInput);

els.timeRevert.addEventListener('click', () => {
  if (!state) return;
  els.timezoneSelect.value = state.timezone;
  timeEdited = false;
  updateTimeInput();
});

els.timeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state) return;
  const timezone = els.timezoneSelect.value;
  let newClockTime = null;  // null: the server keeps the current time, no jump

  if (timeEdited) {
    if (!els.timeInput.value) {
      showMessage('Enter a date and time, or click "Undo changes".', 'error');
      return;
    }
    try {
      newClockTime = new Date(zonedDateTimeToMs(els.timeInput.value, timezone)).toISOString();
    } catch {
      showMessage('That date and time is not valid.', 'error');
      return;
    }
  }
  const newTimezone = timezone !== state.timezone ? timezone : null;
  if (newClockTime === null && newTimezone === null) {
    showMessage('Nothing to save: change the date and time or the timezone first.');
    return;
  }

  await changeClock(
    'set_clock',
    { new_clock_time: newClockTime, new_speed: null, new_timezone: newTimezone },
    newClockTime ? `Time set to ${els.timeInput.value.replace('T', ' ')} (${timezone}).` : `Timezone set to ${timezone}.`,
  );
});

els.reset.addEventListener('click', () => {
  changeClock('reset_clock', {}, 'Reset to real time at normal speed.');
});

// ---------------------------------------------------------------------- start

async function start() {
  els.slider.max = String(SPEED_STOPS.length - 1);
  fillTimezones();

  try {
    const { createClient } = await import(SUPABASE_JS_URL);
    db = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  } catch (error) {
    console.error(error);
    els.loading.textContent = 'Could not load Supabase. Check your connection and reload the page.';
    return;
  }

  // Fires immediately with the stored session, then on every login/logout.
  // supabase-js can deadlock if Supabase is called inside this callback, so defer.
  db.auth.onAuthStateChange((_event, session) => {
    setTimeout(() => showSession(session), 0);
  });

  setInterval(updateTimeInput, 250);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state) {
      loadState();
      measureOffset();
    }
  });
}

start();
