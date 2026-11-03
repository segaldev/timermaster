import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as T from '../js/timer.js';
import { formatRemaining, formatDuration } from '../js/format.js';

const S = T.SECOND_MS;
const M = T.MINUTE_MS;
const make = (o = {}) => T.createTimer({ name: 'Tea', hours: 0, minutes: 10, ...o }, 0);

test('validateDuration (h/m/s)', () => {
  assert.equal(T.validateDuration(0, 0, 1), null);
  assert.equal(T.validateDuration(99, 59, 59), null);
  assert.ok(T.validateDuration(0, 0, 0));
  assert.ok(T.validateDuration(0, 60, 0));
  assert.ok(T.validateDuration(0, 0, 60));
  assert.ok(T.validateDuration(100, 0, 0));
  assert.ok(T.validateDuration(1.5, 0, 0));
});

test('createTimer defaults, seconds, validation', () => {
  const t = make({ name: '  ', seconds: 30 });
  assert.equal(t.name, 'Timer');
  assert.equal(t.durationMs, 10 * M + 30 * S);
  assert.deepEqual(T.splitDuration(t.durationMs), { hours: 0, minutes: 10, seconds: 30 });
  assert.equal(t.nudge, false);
  assert.equal(t.cycles, 0);
  assert.throws(() => make({ minutes: 0 }));
});

test('start / pause / resume / reset', () => {
  let t = T.start(make(), 1000);
  assert.equal(T.remainingMs(t, 1000 + 3 * M), 7 * M);
  t = T.pause(t, 1000 + 3 * M);
  assert.equal(T.remainingMs(t, 1e12), 7 * M);
  t = T.start(t, 5e6);
  assert.equal(t.endsAt, 5e6 + 7 * M);
  t = T.reset(t);
  assert.equal(t.remainingMs, 10 * M);
  assert.equal(t.endsAt, null);
});

test('reaching zero: DONE, counted, fires once; restart uses full length', () => {
  const t = T.start(make({ repeat: true }), 0);
  assert.equal(T.collectExpired([t], 10 * M - 1).fired.length, 0);
  const r = T.collectExpired([t], 10 * M);
  assert.equal(r.fired.length, 1);
  assert.equal(r.timers[0].status, T.STATUS.DONE); // alerts first, even with repeat on
  assert.equal(r.timers[0].firedAt, 10 * M);
  assert.equal(r.timers[0].cycles, 1);
  assert.equal(T.collectExpired(r.timers, 20 * M).fired.length, 0);
  assert.equal(T.start(r.timers[0], 20 * M).endsAt, 30 * M);
});

test('afterAlert: repeat restarts (cadence or from now), no repeat waits', () => {
  const done = T.collectExpired([T.start(make({ repeat: true }), 0)], 10 * M).timers[0];
  const cadence = T.afterAlert(done, { keepCadence: true }, 10 * M + 8 * S);
  assert.equal(cadence.status, T.STATUS.RUNNING);
  assert.equal(cadence.endsAt, 20 * M);
  assert.equal(T.afterAlert(done, {}, 15 * M).endsAt, 25 * M);
  // page closed for a long time: skips missed periods
  assert.equal(T.afterAlert(done, { keepCadence: true }, 35 * M).endsAt, 40 * M);
  const once = T.collectExpired([T.start(make(), 0)], 10 * M).timers[0];
  assert.equal(T.afterAlert(once, {}, 11 * M).status, T.STATUS.IDLE);
});

test('snooze: run ends silently, starts over, counts the cycle, clears snooze', () => {
  let t = T.toggleSnooze(T.start(make(), 0));
  assert.equal(t.snoozed, true);
  const r = T.collectExpired([t], 10 * M + 200);
  assert.equal(r.fired.length, 0);
  t = r.timers[0];
  assert.equal(t.status, T.STATUS.RUNNING);
  assert.equal(t.endsAt, 20 * M);
  assert.equal(t.snoozed, false);
  assert.equal(t.cycles, 1);
  assert.equal(T.toggleSnooze(T.toggleSnooze(T.start(make(), 0))).snoozed, false);
  assert.equal(T.toggleSnooze(make()).snoozed, false); // idle: no-op
  assert.equal(T.resetCycles(t).cycles, 0);
  assert.equal(T.reset(t).cycles, 1); // timer reset keeps the count
});

test('update changes fields; duration change restarts running timers', () => {
  let t = T.start(make(), 0);
  t = T.update(t, { name: 'Coffee', soundId: 'bell', nudge: true }, M);
  assert.equal(t.name, 'Coffee');
  assert.equal(t.nudge, true);
  assert.equal(t.endsAt, 10 * M);
  t = T.update(t, { hours: 1, minutes: 0, seconds: 15 }, 2 * M);
  assert.equal(t.status, T.STATUS.RUNNING);
  assert.equal(t.endsAt, 2 * M + 60 * M + 15 * S);
  assert.equal(T.update(make(), { seconds: 45 }).remainingMs, 10 * M + 45 * S);
  assert.throws(() => T.update(make(), { minutes: 0 }));
});

test('formatting', () => {
  assert.equal(formatRemaining(10 * M), '10:00');
  assert.equal(formatRemaining(10 * M - 1500), '9:59');
  assert.equal(formatRemaining(65 * M + 9 * S), '1:05:09');
  assert.equal(formatDuration(90 * M), '1h 30m');
  assert.equal(formatDuration(45 * S), '45s');
  assert.equal(formatDuration(M + 5 * S), '1m 5s');
});

test('mute is a per-timer flag, off by default', () => {
  const t = make();
  assert.equal(t.muted, false);
  const m = T.update(T.start(t, 0), { muted: true }, M);
  assert.equal(m.muted, true);
  assert.equal(m.endsAt, 10 * M); // muting doesn't disturb a running timer
  assert.equal(T.update(m, { muted: false }).muted, false);
});
