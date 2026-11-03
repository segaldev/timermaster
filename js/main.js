import * as T from './timer.js';
import { localStore } from './store.js';
import { SOUNDS, getSound, playSound, previewSound, unlockAudio } from './sounds.js';
import { formatRemaining, formatDuration, formatClock } from './format.js';

const store = localStore;
const RING_GAP_MS = 1200; // pause between the end of one ring and the next
const RING_CHECK_MS = 250;
const NUDGE_OFF_RINGS = 3; // Nudge off: ring this many times, then restart (repeat) or wait
const STATUS_LABEL = { idle: 'Ready', running: 'Running', paused: 'Paused', done: 'Done' };

// ---- State ------------------------------------------------------------------

let { timers, settings, firstRun } = store.load();
const ringing = new Map(); // timerId -> times rung this alert (UI-only, not persisted)
let pendingDeleteId = null;
let pendingDeleteTimeout = null;

// First visit only: a couple of example reminders so the app isn't empty.
if (firstRun) {
  timers = [
    T.createTimer({ name: 'Drink water', minutes: 45, soundId: 'soft', repeat: true }),
    T.createTimer({ name: 'Stretch break', hours: 1, soundId: 'bell', repeat: true }),
  ];
  store.save({ timers, settings });
}

// "No sound" used to be a sound choice; it is now the per-timer mute switch.
timers = timers.map((t) => (t.soundId === 'none' ? { ...t, soundId: 'chime', muted: true } : t));

settings = { view: 'grid', collapsed: [], zen: true, ...settings };
delete settings.skin; // themes were removed
// Zen became the default: switch it on once for people who already had settings
// saved; after that their own choice sticks.
if (!settings.zenDefaultApplied) settings = { ...settings, zen: true, zenDefaultApplied: true };

const getTimer = (id) => timers.find((t) => t.id === id);
const isCollapsed = (id) => settings.collapsed.includes(id);

function setSettings(changes) {
  settings = { ...settings, ...changes };
  store.save({ timers, settings });
  render();
}

function commit(nextTimers) {
  timers = nextTimers;
  store.save({ timers, settings });
  render();
  scheduleTick();
}

function updateTimer(id, fn) {
  commit(timers.map((t) => (t.id === id ? fn(t) : t)));
}

// ---- DOM refs ---------------------------------------------------------------

const $ = (sel) => document.querySelector(sel);
const list = $('#timer-list');
const empty = $('#empty');
const template = $('#timer-template');
const notifyBtn = $('#notify-btn');
const collapseAllBtn = $('#collapse-all');
const zenBtn = $('#zen-btn');
const cards = new Map(); // timerId -> card element (kept between renders so focus survives)

// ---- Rendering (keyed, in place) --------------------------------------------

function render() {
  empty.hidden = timers.length > 0;
  list.classList.toggle('list-view', settings.view === 'list');
  document.querySelectorAll('button[data-view]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.view === settings.view)));
  const anyOpen = timers.some((t) => !isCollapsed(t.id));
  collapseAllBtn.textContent = anyOpen ? 'Hide settings' : 'Show settings';
  collapseAllBtn.hidden = timers.length === 0 || settings.zen;
  list.classList.toggle('zen', settings.zen);
  document.body.classList.toggle('zen-mode', settings.zen);
  zenBtn.setAttribute('aria-checked', String(settings.zen));

  const ids = new Set(timers.map((t) => t.id));
  for (const [id, el] of cards) {
    if (!ids.has(id)) { el.remove(); cards.delete(id); }
  }
  timers.forEach((timer, i) => {
    let card = cards.get(timer.id);
    if (!card) { card = buildCard(timer); cards.set(timer.id, card); }
    if (list.children[i] !== card) list.insertBefore(card, list.children[i] ?? null);
    syncCard(card, timer);
  });
  updateSummary();
  updateTitle();
  refreshHint(); // a button under the pointer may have changed (Start -> Pause)
}

function buildCard(timer) {
  const card = template.content.firstElementChild.cloneNode(true);
  card.dataset.id = timer.id;
  card.querySelector('[data-field="sound"]').append(...SOUNDS.map((s) => new Option(s.name, s.id)));
  card.querySelectorAll('[data-field]').forEach((el) => { el.id = `${el.dataset.field}-${timer.id}`; });
  return card;
}

/** Don't overwrite a field the user is typing in. */
function setValue(el, value) {
  if (document.activeElement !== el && el.value !== String(value)) el.value = value;
}

const field = (card, name) => card.querySelector(`[data-field="${name}"]`);
const pad2 = (n) => String(n).padStart(2, '0');

function syncCard(card, timer) {
  const running = timer.status === T.STATUS.RUNNING;
  const active = running || timer.status === T.STATUS.PAUSED;
  card.dataset.status = timer.status;
  card.classList.toggle('ringing', ringing.has(timer.id));
  card.classList.toggle('snoozed', Boolean(timer.snoozed));
  card.querySelector('.status').textContent = timer.snoozed && active ? 'Snoozed' : STATUS_LABEL[timer.status];

  setValue(field(card, 'name'), timer.name);
  card.querySelector('.drag-handle').ariaLabel = `Move ${timer.name} (drag, or use arrow keys)`;
  field(card, 'name').readOnly = settings.zen;
  field(card, 'name').tabIndex = settings.zen ? -1 : 0;
  card.title = settings.zen && timer.status === T.STATUS.DONE ? 'Click to dismiss' : '';
  const { hours, minutes, seconds } = T.splitDuration(timer.durationMs);
  setValue(field(card, 'hours'), hours);
  setValue(field(card, 'minutes'), pad2(minutes));
  setValue(field(card, 'seconds'), pad2(seconds));
  setValue(field(card, 'sound'), getSound(timer.soundId).id); // old names map to their replacement
  const mute = card.querySelector('[data-action="toggle-mute"]');
  mute.setAttribute('aria-pressed', String(Boolean(timer.muted)));
  mute.title = mute.ariaLabel = timer.muted ? 'Unmute this timer' : 'Mute this timer';
  card.querySelector('[data-action="toggle-repeat"]').setAttribute('aria-checked', String(timer.repeat));
  card.querySelector('[data-action="toggle-nudge"]').setAttribute('aria-checked', String(Boolean(timer.nudge)));

  const snooze = card.querySelector('[data-action="snooze"]');
  snooze.hidden = !running;
  snooze.setAttribute('aria-pressed', String(Boolean(timer.snoozed)));
  snooze.querySelector('.label').textContent = timer.snoozed ? 'Snoozed' : 'Snooze';

  const cycles = timer.cycles ?? 0;
  card.querySelector('.cycles-count').textContent = `${cycles} cycle${cycles === 1 ? '' : 's'}`;
  card.querySelector('[data-action="reset-cycles"]').disabled = cycles === 0;

  const primary = card.querySelector('[data-role="primary"]');
  const secondary = card.querySelector('[data-role="secondary"]');
  const restart = timer.status === T.STATUS.DONE;
  const [pLabel, pAction, sLabel, sAction] = {
    idle: ['Start', 'start', null, null],
    running: ['Pause', 'pause', 'Reset', 'reset'],
    paused: ['Resume', 'start', 'Reset', 'reset'],
    done: ['Restart', 'start', 'Dismiss', 'dismiss'],
  }[timer.status];
  primary.textContent = pLabel;
  primary.dataset.action = pAction;
  primary.dataset.hint = ACTION_HINT[restart ? 'restart' : timer.status === T.STATUS.PAUSED ? 'resume' : pAction];
  secondary.hidden = !sLabel;
  if (sLabel) { secondary.textContent = sLabel; secondary.dataset.action = sAction; secondary.dataset.hint = ACTION_HINT[sAction]; }

  const collapsed = isCollapsed(timer.id);
  card.querySelector('[data-role="panel"]').hidden = collapsed;
  card.querySelector('[data-action="toggle-panel"]').setAttribute('aria-expanded', String(!collapsed));

  const confirming = pendingDeleteId === timer.id;
  card.querySelector('[data-action="delete"]').hidden = confirming;
  card.querySelector('.confirm').hidden = !confirming;

  updateCardTime(card, timer);
}

const ACTION_HINT = {
  start: 'Start counting down',
  resume: 'Continue from where it was paused',
  pause: 'Pause; resume later from the same time',
  reset: 'Stop and go back to the full length',
  dismiss: 'Stop the alert. With Repeat on, the next cycle starts now; otherwise back to Ready',
};
ACTION_HINT.restart = 'Start a new run from the full length';

function updateCardTime(card, timer, now = Date.now()) {
  const left = T.remainingMs(timer, now);
  card.querySelector('.timer-remaining').textContent = timer.status === T.STATUS.DONE ? "Time's up" : formatRemaining(left);
  card.querySelector('.progress-bar').style.width = `${Math.max(0, 1 - left / timer.durationMs) * 100}%`;
  const when = card.querySelector('.when');
  if (timer.status === T.STATUS.RUNNING) {
    when.textContent = timer.snoozed ? `Silent at ${formatClock(timer.endsAt)}, then starts over` : `Ends ${formatClock(timer.endsAt)}`;
  } else if (timer.status === T.STATUS.PAUSED) when.textContent = 'On hold';
  else if (timer.status === T.STATUS.DONE) {
    const waiting = !ringing.has(timer.id);
    when.textContent = `Finished ${formatClock(timer.firedAt ?? timer.updatedAt)}${waiting ? ' · waiting for you' : ''}`;
  } else when.textContent = 'Not started';
}

function updateSummary() {
  if ($('#summary').dataset.hinting) return; // a hint is showing there right now
  const running = timers.filter((t) => t.status === T.STATUS.RUNNING).length;
  const done = timers.filter((t) => t.status === T.STATUS.DONE).length;
  const parts = [`${timers.length} timer${timers.length === 1 ? '' : 's'}`];
  if (running) parts.push(`${running} running`);
  if (done) parts.push(`${done} done`);
  $('#summary').textContent = parts.join(' · ');
}

function updateTitle(now = Date.now()) {
  const ringingTimer = timers.find((t) => ringing.has(t.id));
  if (ringingTimer) {
    document.title = `⏰ ${ringingTimer.name} — Multi Timer`;
    return;
  }
  const next = timers
    .filter((t) => t.status === T.STATUS.RUNNING)
    .sort((a, b) => a.endsAt - b.endsAt)[0];
  document.title = next ? `${formatRemaining(T.remainingMs(next, now))} ${next.name} — Multi Timer` : 'Multi Timer';
}

// ---- Ticking & alarms -------------------------------------------------------

function tick() {
  const now = Date.now();
  const { timers: next, fired } = T.collectExpired(timers, now);
  if (next.some((t, i) => t !== timers[i])) {
    fired.forEach(fire);
    commit(next); // includes snoozed timers that silently started over
    return;
  }
  for (const timer of timers) {
    const card = cards.get(timer.id);
    if (card) updateCardTime(card, timer, now);
  }
  updateTitle(now);
}

// Wake up exactly when the next displayed second changes (or a timer ends),
// instead of polling. Nothing is scheduled when no timer is running.
let tickTimer = null;
function scheduleTick() {
  clearTimeout(tickTimer);
  const now = Date.now();
  const running = timers.filter((t) => t.status === T.STATUS.RUNNING);
  if (!running.length) return;
  const delay = Math.min(...running.map((t) => (t.endsAt - now) % 1000 || 1000));
  tickTimer = setTimeout(() => { tick(); scheduleTick(); }, delay + 5);
}

/** Muted timers still flash and notify, they just make no sound. */
function alertSound(timer) {
  if (!timer.muted) playSound(timer.soundId);
}

function fire(timer) {
  alertSound(timer);
  notify(timer);
  ringing.set(timer.id, 1);
  lastRing.set(timer.id, Date.now());
}

// Nudge on: keep ringing until dismissed.
// Nudge off: ring 3 times, then restart on the original cadence (repeat on) or wait (repeat off).
// Rings are spaced by the sound's own length, so a long singing bowl isn't cut
// short and a short beep doesn't wait around.
const lastRing = new Map(); // timerId -> when it last rang
function ringAgain() {
  const now = Date.now();
  for (const [id, count] of ringing) {
    const timer = getTimer(id);
    if (!timer || timer.status !== T.STATUS.DONE) { ringing.delete(id); continue; }
    const spacing = Math.max(2500, getSound(timer.soundId).seconds * 1000 + RING_GAP_MS);
    if (now - (lastRing.get(id) ?? 0) < spacing) continue;
    if (timer.nudge || count < NUDGE_OFF_RINGS) {
      alertSound(timer);
      ringing.set(id, count + 1);
      lastRing.set(id, now);
      continue;
    }
    ringing.delete(id);
    if (timer.repeat) updateTimer(id, (t) => T.afterAlert(t, { keepCadence: true }));
    else render();
  }
}

// ---- Notifications (optional; useful when the tab is in the background) -----

function notify(timer) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(`⏰ ${timer.name}`, { body: `${formatDuration(timer.durationMs)} timer is done`, tag: timer.id });
    n.onclick = () => { window.focus(); n.close(); };
  } catch { /* some browsers only allow notifications from a service worker */ }
}

function refreshNotifyButton() {
  notifyBtn.hidden = !('Notification' in window) || Notification.permission !== 'default';
}

notifyBtn.addEventListener('click', async () => {
  try { await Notification.requestPermission(); } catch { /* blocked in some embeds */ }
  refreshNotifyButton();
});

// ---- Editing on the card ----------------------------------------------------

function setTotalSeconds(id, total) {
  if (!Number.isFinite(total) || total < 1 || total > T.MAX_TOTAL_SECONDS) {
    render(); // reject: put the fields back to the current value
    return;
  }
  ringing.delete(id);
  updateTimer(id, (t) => T.update(t, { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 }));
}

const UNIT_SECONDS = { hours: 3600, minutes: 60, seconds: 1 };

/** Seconds currently typed in a card's h/m/s fields (may not be saved yet). */
function typedSeconds(card) {
  const [h, m, s] = ['hours', 'minutes', 'seconds'].map((f) => Number(field(card, f).value || 0));
  if (![h, m, s].every((n) => Number.isInteger(n) && n >= 0)) return NaN;
  return h * 3600 + m * 60 + s; // e.g. 90 seconds becomes 1m 30s
}

// The length is saved when focus leaves the whole h/m/s chip, so you can type
// "0 m" then "30 s" without the in-between 0:00:00 being rejected.
list.addEventListener('focusout', (e) => {
  if (!e.target.matches(LENGTH_FIELDS)) return;
  const chip = e.target.closest('.length-chip');
  if (chip.contains(e.relatedTarget)) return;
  const id = cardOf(chip);
  const total = typedSeconds(cards.get(id));
  if (total === Math.round(getTimer(id).durationMs / 1000)) { render(); return; }
  setTotalSeconds(id, total);
});

// ↑/↓ keys and the scroll wheel nudge a length field (Shift: 5 minutes / 10 seconds).
function stepField(input, direction, shift) {
  const id = cardOf(input);
  const card = cards.get(id);
  const unit = input.dataset.field;
  const size = shift ? { hours: 1, minutes: 5, seconds: 10 }[unit] : 1;
  const current = typedSeconds(card);
  const total = (Number.isNaN(current) ? Math.round(getTimer(id).durationMs / 1000) : current) + direction * size * UNIT_SECONDS[unit];
  if (total < 1 || total > T.MAX_TOTAL_SECONDS) return;
  setTotalSeconds(id, total);
  const parts = T.splitDuration(getTimer(id).durationMs);
  for (const f of ['hours', 'minutes', 'seconds']) field(card, f).value = f === 'hours' ? parts.hours : pad2(parts[f]); // focused fields aren't refreshed by render()
}

function cardOf(el) {
  const card = el.closest('.timer-card');
  return card ? card.dataset.id : null;
}

function addTimer() {
  // Zen hides the controls, so step out of it to set up the new timer.
  if (settings.zen) settings = { ...settings, zen: false };
  const timer = T.createTimer({ name: 'New timer', minutes: 10 });
  commit([...timers, timer]);
  const input = field(cards.get(timer.id), 'name');
  input.focus();
  input.select();
}

const LENGTH_FIELDS = '[data-field="hours"], [data-field="minutes"], [data-field="seconds"]';

list.addEventListener('input', (e) => {
  const id = cardOf(e.target);
  if (id && e.target.dataset.field === 'name') updateTimer(id, (t) => T.update(t, { name: e.target.value }));
});

list.addEventListener('change', (e) => {
  const id = cardOf(e.target);
  if (!id) return;
  const card = cards.get(id);
  switch (e.target.dataset.field) {
    case 'name':
      render(); // show the cleaned-up name (e.g. "Timer" if left empty)
      break;
    case 'sound':
      updateTimer(id, (t) => T.update(t, { soundId: e.target.value }));
      previewSound(e.target.value);
      break;
  }
});

list.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input')) { e.target.blur(); return; }
  if (!e.target.matches(LENGTH_FIELDS) || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  stepField(e.target, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey);
});

list.addEventListener('wheel', (e) => {
  const input = e.target.closest(LENGTH_FIELDS);
  if (!input || e.deltaY === 0) return;
  e.preventDefault();
  stepField(input, e.deltaY < 0 ? 1 : -1, e.shiftKey);
}, { passive: false });

list.addEventListener('focusin', (e) => {
  if (e.target.matches(LENGTH_FIELDS)) e.target.select();
});

list.addEventListener('click', (e) => {
  // Zen mode: the mute icon and cycle reset still work; clicking a finished timer dismisses it.
  if (settings.zen) {
    if (justDragged || e.target.closest('.drag-handle')) return; // dragging to reorder isn't a click to dismiss
    const id = cardOf(e.target);
    if (id && e.target.closest('[data-action="toggle-mute"]')) {
      updateTimer(id, (t) => T.update(t, { muted: !t.muted }));
      return;
    }
    if (id && e.target.closest('[data-action="reset-cycles"]')) {
      updateTimer(id, (t) => T.resetCycles(t));
      return;
    }
    if (id && getTimer(id)?.status === T.STATUS.DONE) {
      ringing.delete(id);
      updateTimer(id, (t) => T.afterAlert(t));
    }
    return;
  }
  const button = e.target.closest('button[data-action]');
  if (!button) return;
  const id = cardOf(button);
  if (!id || !getTimer(id)) return;

  switch (button.dataset.action) {
    case 'snooze':
      updateTimer(id, (t) => T.toggleSnooze(t));
      break;
    case 'reset-cycles':
      updateTimer(id, (t) => T.resetCycles(t));
      break;
    case 'toggle-panel':
      setSettings({
        collapsed: isCollapsed(id) ? settings.collapsed.filter((x) => x !== id) : [...settings.collapsed, id],
      });
      break;
    case 'toggle-mute':
      updateTimer(id, (t) => T.update(t, { muted: !t.muted }));
      break;
    case 'toggle-repeat':
      updateTimer(id, (t) => T.update(t, { repeat: !t.repeat }));
      break;
    case 'toggle-nudge':
      updateTimer(id, (t) => T.update(t, { nudge: !t.nudge }));
      break;
    case 'start':
      ringing.delete(id);
      updateTimer(id, (t) => T.start(t));
      break;
    case 'pause':
      updateTimer(id, (t) => T.pause(t));
      break;
    case 'reset':
      ringing.delete(id);
      updateTimer(id, (t) => T.reset(t));
      break;
    case 'dismiss': // repeat on: next cycle starts now; repeat off: back to ready
      ringing.delete(id);
      updateTimer(id, (t) => T.afterAlert(t));
      break;
    case 'delete':
      pendingDeleteId = id;
      clearTimeout(pendingDeleteTimeout);
      pendingDeleteTimeout = setTimeout(() => { pendingDeleteId = null; render(); }, 5000);
      render();
      break;
    case 'confirm-delete':
      pendingDeleteId = null;
      ringing.delete(id);
      settings.collapsed = settings.collapsed.filter((x) => x !== id);
      commit(timers.filter((t) => t.id !== id));
      break;
    case 'cancel-delete':
      pendingDeleteId = null;
      render();
      break;
  }
});

// ---- Reordering: drag the corner handle, or focus it and use the arrow keys ----

const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

/** Moves a timer to a new position in memory. Returns false if nothing changed. */
function moveTimer(id, toIndex) {
  const from = timers.findIndex((t) => t.id === id);
  if (from < 0 || toIndex < 0 || toIndex >= timers.length || from === toIndex) return false;
  const next = [...timers];
  const [moved] = next.splice(from, 1);
  next.splice(toIndex, 0, moved);
  timers = next;
  return true;
}

/** FLIP animation: cards slide from their old spot to their new one. */
function animateReorder(mutate) {
  const before = new Map([...cards].map(([id, el]) => [id, el.getBoundingClientRect()]));
  const changed = mutate();
  if (!changed || reduceMotion.matches) return changed;
  for (const [id, el] of cards) {
    const a = before.get(id);
    if (!a) continue;
    const b = el.getBoundingClientRect();
    const dx = a.left - b.left;
    const dy = a.top - b.top;
    if (dx || dy) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }
  return changed;
}

let drag = null; // { id, card, pointerId, lockUntil }

list.addEventListener('pointerdown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle || e.button !== 0) return;
  e.preventDefault();
  const card = handle.closest('.timer-card');
  drag = { id: card.dataset.id, card, pointerId: e.pointerId, lockUntil: 0 };
  card.classList.add('dragging');
  document.body.classList.add('is-dragging');
});

// Listen on window: moving the card in the DOM can drop pointer capture.
window.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  // Scroll the page when dragging near the top or bottom edge.
  const edge = 70;
  if (e.clientY < edge) window.scrollBy(0, -12);
  else if (e.clientY > innerHeight - edge) window.scrollBy(0, 12);
  if (performance.now() < drag.lockUntil) return; // let the last move finish animating
  const over = document.elementFromPoint(e.clientX, e.clientY)?.closest('.timer-card');
  if (!over || over === drag.card || !list.contains(over)) return;
  // Only swap once the pointer is well into the card it's over (about a third of
  // the way toward its far side), so two cards don't flip back and forth.
  const o = over.getBoundingClientRect();
  const d = drag.card.getBoundingClientRect();
  const [ox, oy] = [o.left + o.width / 2, o.top + o.height / 2];
  const [vx, vy] = [ox - (d.left + d.width / 2), oy - (d.top + d.height / 2)];
  if ((e.clientX - ox) * vx + (e.clientY - oy) * vy < -0.2 * (vx * vx + vy * vy)) return;
  const to = timers.findIndex((t) => t.id === over.dataset.id);
  if (animateReorder(() => moveTimer(drag.id, to) && (render(), true))) drag.lockUntil = performance.now() + 150;
});

let justDragged = false; // the click that follows a drag isn't a real click
function endDrag(e) {
  if (!drag || e.pointerId !== drag.pointerId) return;
  justDragged = true;
  setTimeout(() => { justDragged = false; }, 0);
  drag.card.classList.remove('dragging');
  document.body.classList.remove('is-dragging');
  drag = null;
  store.save({ timers, settings });
}
window.addEventListener('pointerup', endDrag);
window.addEventListener('pointercancel', endDrag);

list.addEventListener('keydown', (e) => {
  const handle = e.target.closest('.drag-handle');
  if (!handle) return;
  const delta = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 }[e.key];
  if (!delta) return;
  e.preventDefault();
  const id = cardOf(handle);
  const from = timers.findIndex((t) => t.id === id);
  animateReorder(() => moveTimer(id, from + delta) && (commit(timers), true));
  handle.focus(); // moving the card in the DOM can drop focus
});

// ---- Hints: a subtle line explaining whatever control you point at ------------
// Cards show it in their own hint line; header controls borrow the summary line.

function hintTargetFor(el) {
  const card = el.closest('.timer-card');
  return card ? card.querySelector('.hint') : $('#summary');
}

let hinted = null;
function showHint(el) {
  if (hinted === el) return;
  clearHint();
  const target = hintTargetFor(el);
  target.dataset.hinting = 'true';
  if (target.id === 'summary') target.dataset.text = target.textContent;
  target.textContent = el.dataset.hint;
  hinted = el;
}
function clearHint() {
  if (!hinted) return;
  const target = hintTargetFor(hinted);
  delete target.dataset.hinting;
  target.textContent = target.id === 'summary' ? target.dataset.text ?? '' : '';
  hinted = null;
  if (target.id === 'summary') updateSummary();
}
function refreshHint() {
  if (!hinted) return;
  if (!hinted.isConnected || hinted.hidden) { clearHint(); return; }
  hintTargetFor(hinted).textContent = hinted.dataset.hint;
}
for (const type of ['pointerover', 'focusin']) {
  document.addEventListener(type, (e) => {
    const el = e.target.closest?.('[data-hint]');
    if (el && !drag) showHint(el);
    else if (type === 'pointerover' && hinted && !hinted.contains(e.target) && document.activeElement !== hinted) clearHint();
  });
}
document.addEventListener('focusout', (e) => { if (hinted && e.target === hinted) clearHint(); });

$('#new-btn').addEventListener('click', addTimer);

document.querySelectorAll('button[data-view]').forEach((b) =>
  b.addEventListener('click', () => setSettings({ view: b.dataset.view })));

zenBtn.addEventListener('click', () => setSettings({ zen: !settings.zen }));

collapseAllBtn.addEventListener('click', () => {
  const anyOpen = timers.some((t) => !isCollapsed(t.id));
  setSettings({ collapsed: anyOpen ? timers.map((t) => t.id) : [] });
});

// ---- Global wiring ----------------------------------------------------------

// Audio can only start after a user gesture.
document.addEventListener('pointerdown', unlockAudio, { once: true });
document.addEventListener('keydown', unlockAudio, { once: true });

document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'n' && !settings.zen && !e.metaKey && !e.ctrlKey && !e.altKey
      && !['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) {
    e.preventDefault();
    addTimer();
  }
});

// Catch up immediately when the tab becomes visible again (background tabs are throttled).
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); scheduleTick(); } });

// On load: catch up on timers that finished while the page was closed.
// Nudge on -> ring (once the browser allows sound); nudge off + repeat -> carry on
// with the next cycle; nudge off, no repeat -> wait for you.
{
  const { timers: next } = T.collectExpired(timers);
  timers = next.map((t) => {
    if (t.status !== T.STATUS.DONE) return t;
    if (t.nudge) { ringing.set(t.id, 1); return t; }
    return t.repeat ? T.afterAlert(t, { keepCadence: true }) : t;
  });
  store.save({ timers, settings });
}

refreshNotifyButton();
render();
scheduleTick();
setInterval(ringAgain, RING_CHECK_MS);
