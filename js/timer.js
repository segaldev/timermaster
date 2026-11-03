// Pure timer model. No DOM, no storage — easy to test and reuse on a server later.
//
// Timing is based on absolute timestamps (`endsAt`), not on counting ticks, so
// timers stay accurate when the tab is throttled in the background or the page
// is reloaded.
//
// What happens when a timer hits zero:
//   - snoozed run  -> no alert; silently starts over from the beginning
//   - otherwise    -> status DONE (alerting). The UI rings:
//       nudge on   -> until dismissed
//       nudge off  -> 3 times, then `afterAlert`: restart (repeat on) or wait (repeat off)

export const STATUS = Object.freeze({
  IDLE: 'idle',
  RUNNING: 'running',
  PAUSED: 'paused',
  DONE: 'done',
});

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const MAX_HOURS = 99; // Hours, minutes, seconds; no days (for now).
export const MAX_TOTAL_SECONDS = MAX_HOURS * 3600 + 59 * 60 + 59;

export function toDurationMs(hours, minutes, seconds = 0) {
  return (Number(hours) || 0) * HOUR_MS + (Number(minutes) || 0) * MINUTE_MS + (Number(seconds) || 0) * SECOND_MS;
}

export function splitDuration(ms) {
  const total = Math.round(ms / SECOND_MS);
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}

/** Returns an error message, or null if the duration is valid. */
export function validateDuration(hours, minutes, seconds = 0) {
  const [h, m, s] = [hours, minutes, seconds].map(Number);
  if (![h, m, s].every(Number.isInteger)) return 'Hours, minutes and seconds must be whole numbers.';
  if (h < 0 || h > MAX_HOURS) return `Hours must be between 0 and ${MAX_HOURS}.`;
  if (m < 0 || m > 59) return 'Minutes must be between 0 and 59.';
  if (s < 0 || s > 59) return 'Seconds must be between 0 and 59.';
  if (h === 0 && m === 0 && s === 0) return 'Duration must be at least 1 second.';
  return null;
}

export function createTimer(
  { name, hours = 0, minutes = 0, seconds = 0, soundId = 'chime', repeat = false, nudge = false, muted = false, presetId = null },
  now = Date.now(),
) {
  const error = validateDuration(hours, minutes, seconds);
  if (error) throw new Error(error);
  const durationMs = toDurationMs(hours, minutes, seconds);
  return {
    id: crypto.randomUUID(),
    name: (name ?? '').trim() || 'Timer',
    durationMs,
    soundId,
    repeat: Boolean(repeat),
    nudge: Boolean(nudge),
    muted: Boolean(muted), // silenced: alerts flash but make no sound
    presetId, // reserved for future preset timers (water, stretch, ...)
    status: STATUS.IDLE,
    remainingMs: durationMs,
    endsAt: null,
    snoozed: false,
    firedAt: null,
    cycles: 0, // times it has reached zero
    createdAt: now,
    updatedAt: now,
  };
}

export function remainingMs(timer, now = Date.now()) {
  if (timer.status === STATUS.RUNNING) return Math.max(0, timer.endsAt - now);
  return timer.remainingMs;
}

function freshRun(timer, endsAt, now) {
  return { ...timer, status: STATUS.RUNNING, endsAt, remainingMs: timer.durationMs, snoozed: false, firedAt: null, updatedAt: now };
}

export function start(timer, now = Date.now()) {
  if (timer.status === STATUS.RUNNING) return timer;
  if (timer.status === STATUS.DONE) return freshRun(timer, now + timer.durationMs, now);
  return { ...timer, status: STATUS.RUNNING, endsAt: now + timer.remainingMs, updatedAt: now };
}

export function pause(timer, now = Date.now()) {
  if (timer.status !== STATUS.RUNNING) return timer;
  return { ...timer, status: STATUS.PAUSED, remainingMs: remainingMs(timer, now), endsAt: null, updatedAt: now };
}

export function reset(timer, now = Date.now()) {
  return {
    ...timer,
    status: STATUS.IDLE,
    remainingMs: timer.durationMs,
    endsAt: null,
    snoozed: false,
    firedAt: null,
    updatedAt: now,
  };
}

/** Snooze: this run finishes silently and starts over. Toggle again to cancel. */
export function toggleSnooze(timer, now = Date.now()) {
  if (timer.status !== STATUS.RUNNING && timer.status !== STATUS.PAUSED) return timer;
  return { ...timer, snoozed: !timer.snoozed, updatedAt: now };
}

/**
 * Apply edits. Changing the duration resets an idle/paused/done timer to the
 * new duration, and restarts a running timer with the new duration.
 */
export function update(timer, changes, now = Date.now()) {
  let next = { ...timer, updatedAt: now };
  if (changes.name !== undefined) next.name = changes.name.trim() || 'Timer';
  if (changes.soundId !== undefined) next.soundId = changes.soundId;
  if (changes.repeat !== undefined) next.repeat = Boolean(changes.repeat);
  if (changes.nudge !== undefined) next.nudge = Boolean(changes.nudge);
  if (changes.muted !== undefined) next.muted = Boolean(changes.muted);

  if (changes.hours !== undefined || changes.minutes !== undefined || changes.seconds !== undefined) {
    const current = splitDuration(timer.durationMs);
    const hours = changes.hours ?? current.hours;
    const minutes = changes.minutes ?? current.minutes;
    const seconds = changes.seconds ?? current.seconds;
    const error = validateDuration(hours, minutes, seconds);
    if (error) throw new Error(error);
    const durationMs = toDurationMs(hours, minutes, seconds);
    if (durationMs !== timer.durationMs) {
      const wasRunning = timer.status === STATUS.RUNNING;
      next = reset({ ...next, durationMs }, now);
      if (wasRunning) next = start(next, now);
    }
  }
  return next;
}

/** Next end time on the original cadence, skipping periods missed while the page was closed. */
function nextCycleEnd(from, durationMs, now) {
  let endsAt = from + durationMs;
  if (endsAt <= now) endsAt += Math.ceil((now - endsAt + 1) / durationMs) * durationMs;
  return endsAt;
}

/** Called when a running timer reaches zero. */
export function complete(timer, now = Date.now()) {
  const counted = { ...timer, cycles: (timer.cycles ?? 0) + 1 };
  if (timer.snoozed) return freshRun(counted, nextCycleEnd(timer.endsAt, timer.durationMs, now), now);
  return { ...counted, status: STATUS.DONE, remainingMs: 0, endsAt: null, firedAt: timer.endsAt, updatedAt: now };
}

export function resetCycles(timer, now = Date.now()) {
  return { ...timer, cycles: 0, updatedAt: now };
}

/**
 * After the alert has finished (nudge off: 3 rings) or was dismissed.
 * Repeat on: start the next cycle (on the original cadence when `keepCadence`,
 * otherwise from now). Repeat off: back to ready.
 */
export function afterAlert(timer, { keepCadence = false } = {}, now = Date.now()) {
  if (timer.status !== STATUS.DONE) return timer;
  if (!timer.repeat) return reset(timer, now);
  const endsAt = keepCadence && timer.firedAt != null ? nextCycleEnd(timer.firedAt, timer.durationMs, now) : now + timer.durationMs;
  return freshRun(timer, endsAt, now);
}

/**
 * Finds running timers that have hit zero. Returns the new list plus the ones
 * that should alert (snoozed runs restart silently and are not included).
 */
export function collectExpired(timers, now = Date.now()) {
  const fired = [];
  const next = timers.map((t) => {
    if (t.status === STATUS.RUNNING && t.endsAt <= now) {
      const done = complete(t, now);
      if (done.status === STATUS.DONE) fired.push(done);
      return done;
    }
    return t;
  });
  return { timers: next, fired };
}
