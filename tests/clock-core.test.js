// Run with: node tests/clock-core.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toMs,
  displayedTime,
  createRealTimeState,
  setTime,
  setSpeed,
  setTimezone,
  resetToRealTime,
  parseState,
  describeSpeed,
  estimateOffset,
  zonedDateTimeToMs,
  msToZonedDateTime,
} from '../js/clock-core.js';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0); // 2026-01-01 12:00:00 UTC
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

test('normal speed follows server time', () => {
  const state = createRealTimeState(T0, 'Europe/Amsterdam');
  assert.equal(displayedTime(state, T0), T0);
  assert.equal(displayedTime(state, T0 + 5 * MIN), T0 + 5 * MIN);
  assert.equal(state.timezone, 'Europe/Amsterdam');
});

test('setTime anchors the clock at the chosen time and keeps ticking', () => {
  const target = Date.UTC(1999, 11, 31, 23, 59, 0);
  const state = setTime(createRealTimeState(T0), target, T0 + HOUR);
  assert.equal(displayedTime(state, T0 + HOUR), target);
  assert.equal(displayedTime(state, T0 + HOUR + 30 * SEC), target + 30 * SEC);
});

test('setTime keeps the current speed', () => {
  const fast = setSpeed(createRealTimeState(T0), 3, T0);
  const state = setTime(fast, T0, T0 + MIN);
  assert.equal(state.speed, 3);
  assert.equal(displayedTime(state, T0 + 2 * MIN), T0 + 3 * MIN);
});

test('speed changes do not make the clock jump', () => {
  let state = createRealTimeState(T0);
  const changeAt = T0 + 10 * MIN;

  const before = displayedTime(state, changeAt);
  state = setSpeed(state, 2, changeAt);
  assert.equal(displayedTime(state, changeAt), before);
  assert.equal(displayedTime(state, changeAt + MIN), before + 2 * MIN);

  // A second change, while already running at double speed.
  const changeAt2 = changeAt + 5 * MIN;
  const before2 = displayedTime(state, changeAt2);
  state = setSpeed(state, 0.5, changeAt2);
  assert.equal(displayedTime(state, changeAt2), before2);
  assert.equal(displayedTime(state, changeAt2 + MIN), before2 + 30 * SEC);
});

test('speed 0 pauses the clock', () => {
  const pauseAt = T0 + 7 * MIN;
  const paused = setSpeed(createRealTimeState(T0), 0, pauseAt);
  assert.equal(displayedTime(paused, pauseAt), T0 + 7 * MIN);
  assert.equal(displayedTime(paused, pauseAt + HOUR), T0 + 7 * MIN);

  // Resuming continues from the paused time.
  const resumeAt = pauseAt + HOUR;
  const resumed = setSpeed(paused, 1, resumeAt);
  assert.equal(displayedTime(resumed, resumeAt + MIN), T0 + 8 * MIN);
});

test('negative speed runs backwards', () => {
  const state = setSpeed(createRealTimeState(T0), -1, T0);
  assert.equal(displayedTime(state, T0 + MIN), T0 - MIN);

  const fastBack = setSpeed(state, -4, T0 + MIN);
  assert.equal(displayedTime(fastBack, T0 + MIN), T0 - MIN);
  assert.equal(displayedTime(fastBack, T0 + 2 * MIN), T0 - 5 * MIN);
});

test('resetToRealTime restores real time and normal speed, keeps timezone', () => {
  let state = createRealTimeState(T0, 'Asia/Tokyo');
  state = setSpeed(state, -3, T0 + MIN);
  state = setTime(state, 0, T0 + 2 * MIN);

  const resetAt = T0 + 3 * MIN;
  state = resetToRealTime(state, resetAt);
  assert.equal(state.speed, 1);
  assert.equal(state.timezone, 'Asia/Tokyo');
  assert.equal(displayedTime(state, resetAt), resetAt);
  assert.equal(displayedTime(state, resetAt + HOUR), resetAt + HOUR);
});

test('setTimezone changes only the timezone', () => {
  const state = setSpeed(createRealTimeState(T0), 2, T0 + MIN);
  const moved = setTimezone(state, 'America/New_York');
  assert.equal(moved.timezone, 'America/New_York');
  assert.equal(displayedTime(moved, T0 + 5 * MIN), displayedTime(state, T0 + 5 * MIN));
});

test('accepts ISO strings and Dates as stored by Supabase', () => {
  const state = {
    anchor_real_time: '2026-01-01T12:00:00.000Z',
    anchor_clock_time: new Date('2026-01-01T08:00:00+00:00'),
    speed: 2,
    timezone: 'UTC',
  };
  assert.equal(displayedTime(state, '2026-01-01T12:01:00Z'), Date.UTC(2026, 0, 1, 8, 2));
  assert.equal(toMs(new Date(T0)), T0);
});

test('state functions do not mutate their input', () => {
  const state = Object.freeze(createRealTimeState(T0));
  setSpeed(state, 2, T0 + MIN);
  setTime(state, 0, T0 + MIN);
  resetToRealTime(state, T0 + MIN);
  assert.equal(state.speed, 1);
});

test('parses Postgres timestamps from the REST API and Realtime', () => {
  const expected = Date.UTC(2026, 8, 25, 12, 43, 15, 324);
  assert.equal(toMs('2026-09-25T12:43:15.3243+00:00'), expected);  // REST
  assert.equal(toMs('2026-09-25 12:43:15.3243+00'), expected);      // Realtime
  assert.equal(toMs('2026-09-25 14:43:15.324999+02'), expected);    // truncates, never rounds
  assert.equal(toMs('2026-09-25T12:43:15.3+00:00'), expected - 24);
  assert.equal(toMs('2026-09-25 12:43:15+00'), expected - 324);
  assert.equal(toMs('2026-09-25 18:13:15.324+05:30'), expected);
  assert.equal(toMs('2026-09-25T12:43:15.324Z'), expected);
});

test('estimateOffset uses the sample with the shortest round trip', () => {
  // Device clock is 2 s behind the server.
  const samples = [
    { requestStart: T0, responseEnd: T0 + 300, serverTime: T0 + 2000 + 250 },
    { requestStart: T0 + 400, responseEnd: T0 + 440, serverTime: new Date(T0 + 2000 + 420).toISOString() },
    { requestStart: T0 + 500, responseEnd: T0 + 700, serverTime: T0 + 2000 + 520 },
  ];
  const { offset, roundTrip } = estimateOffset(samples);
  assert.equal(roundTrip, 40);
  assert.equal(offset, 2000);
});

test('estimateOffset ignores negative round trips and handles no samples', () => {
  assert.equal(estimateOffset([]), null);
  assert.equal(estimateOffset([{ requestStart: T0, responseEnd: T0 - 5, serverTime: T0 }]), null);
});

test('zonedDateTimeToMs reads wall-clock time in the given timezone', () => {
  assert.equal(zonedDateTimeToMs('2026-01-15T12:00', 'Europe/Stockholm'), Date.UTC(2026, 0, 15, 11));
  assert.equal(zonedDateTimeToMs('2026-07-01T12:00:30', 'Europe/Stockholm'), Date.UTC(2026, 6, 1, 10, 0, 30));
  assert.equal(zonedDateTimeToMs('2026-07-01T12:00', 'Asia/Kolkata'), Date.UTC(2026, 6, 1, 6, 30));
  assert.equal(zonedDateTimeToMs('2026-07-01T12:00:00.250', 'UTC'), Date.UTC(2026, 6, 1, 12, 0, 0, 250));
  assert.equal(zonedDateTimeToMs('0050-06-01T00:00', 'UTC'), new Date('0050-06-01T00:00:00Z').getTime());
});

test('zonedDateTimeToMs handles DST changes', () => {
  // Stockholm skips 02:00-03:00 on 2026-03-29: 02:30 becomes 03:30 CEST.
  assert.equal(zonedDateTimeToMs('2026-03-29T02:30', 'Europe/Stockholm'), Date.UTC(2026, 2, 29, 1, 30));
  // 02:30 happens twice on 2026-10-25: the later one (CET) is used.
  assert.equal(zonedDateTimeToMs('2026-10-25T02:30', 'Europe/Stockholm'), Date.UTC(2026, 9, 25, 1, 30));
});

test('zonedDateTimeToMs rejects malformed input', () => {
  assert.throws(() => zonedDateTimeToMs('', 'UTC'), TypeError);
  assert.throws(() => zonedDateTimeToMs('2026-01-15 12:00', 'UTC'), TypeError);
});

test('msToZonedDateTime formats for datetime-local inputs and round-trips', () => {
  const ms = Date.UTC(2026, 6, 1, 10, 0, 30);
  assert.equal(msToZonedDateTime(ms, 'Europe/Stockholm'), '2026-07-01T12:00:30');
  assert.equal(msToZonedDateTime(ms, 'America/New_York'), '2026-07-01T06:00:30');
  assert.equal(msToZonedDateTime(Date.UTC(2026, 0, 1, 0, 0, 0), 'UTC'), '2026-01-01T00:00:00');
  for (const zone of ['Europe/Stockholm', 'Asia/Kolkata', 'Pacific/Auckland', 'UTC']) {
    assert.equal(zonedDateTimeToMs(msToZonedDateTime(ms, zone), zone), ms);
  }
});

test('parseState normalizes valid JSON state', () => {
  const state = parseState({
    anchor_real_time: '2026-01-01T12:00:00Z',
    anchor_clock_time: '2026-01-01T08:00:00Z',
    speed: 0.5,
    timezone: 'Europe/Amsterdam',
    extra: 'ignored',
  });
  assert.deepEqual(state, {
    anchor_real_time: T0,
    anchor_clock_time: T0 - 4 * HOUR,
    speed: 0.5,
    timezone: 'Europe/Amsterdam',
  });
});

test('parseState rejects malformed state', () => {
  const valid = { anchor_real_time: T0, anchor_clock_time: T0, speed: 1, timezone: 'UTC' };
  assert.throws(() => parseState(null), TypeError);
  assert.throws(() => parseState('{}'), TypeError);
  assert.throws(() => parseState({ ...valid, speed: '1' }), TypeError);
  assert.throws(() => parseState({ ...valid, timezone: '' }), TypeError);
  assert.throws(() => parseState({ ...valid, anchor_real_time: 'soon' }), TypeError);
  assert.throws(() => parseState({ ...valid, anchor_clock_time: undefined }), TypeError);
});

test('describeSpeed labels non-normal speeds', () => {
  assert.equal(describeSpeed(1), null);
  assert.equal(describeSpeed(0), 'Paused');
  assert.equal(describeSpeed(2), '2× speed');
  assert.equal(describeSpeed(0.5), '0.5× speed');
  assert.equal(describeSpeed(-1), 'Running backwards');
  assert.equal(describeSpeed(-3), '3× speed backwards');
});

test('rejects invalid input', () => {
  const state = createRealTimeState(T0);
  assert.throws(() => setSpeed(state, NaN, T0), TypeError);
  assert.throws(() => setSpeed(state, '2', T0), TypeError);
  assert.throws(() => setTime(state, 'not a date', T0), TypeError);
});
