// Sound engine. Every sound is synthesized with the Web Audio API — no audio
// files, no licences to track. Each sound is a small "instrument" built from
// the overtones of the real thing (bells, bowls, wooden bars), run through a
// shared room reverb so it sounds less like a computer beep.
//
// To add a sound: add an entry to SOUNDS with { id, name, seconds, play(c, out) },
// where `c` is an AudioContext (or OfflineAudioContext) and `out` the node to
// connect to. `seconds` is roughly how long it rings, used to space repeats.

let ctx = null;
let chain = null; // { input } per context

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio() {
  const c = audio();
  if (c.state === 'suspended') c.resume();
}

// ---- Shared output: dry + reverb, through a gentle limiter ------------------

function impulseResponse(c, seconds = 2.4, decay = 3.2) {
  const length = Math.floor(c.sampleRate * seconds);
  const ir = c.createBuffer(2, length, c.sampleRate);
  let seed = 7; // fixed seed: the room sounds the same every time
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let ch = 0; ch < 2; ch++) {
    const data = ir.getChannelData(ch);
    for (let i = 0; i < length; i++) data[i] = rand() * Math.pow(1 - i / length, decay);
  }
  return ir;
}

function outputChain(c) {
  const limiter = c.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 6;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  limiter.connect(c.destination);

  const input = c.createGain();
  const dry = c.createGain();
  dry.gain.value = 0.85;
  const wet = c.createGain();
  wet.gain.value = 0.28;
  const reverb = c.createConvolver();
  reverb.buffer = impulseResponse(c);
  input.connect(dry).connect(limiter);
  input.connect(reverb).connect(wet).connect(limiter);
  return { input };
}

// ---- Building blocks ---------------------------------------------------------

/** One decaying sine partial: the basic unit of bells, bowls and bars. */
function partial(c, out, { freq, at = 0, decay = 1, gain = 0.2, attack = 0.004, type = 'sine', detune = 0 }) {
  const t0 = c.currentTime + at;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  osc.detune.value = detune;
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + attack);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  osc.connect(amp).connect(out);
  osc.start(t0);
  osc.stop(t0 + attack + decay + 0.05);
}

/** Short filtered noise burst: hammer strikes, mallet contact, clicks. */
function noiseHit(c, out, { at = 0, duration = 0.02, gain = 0.2, freq = 3000, q = 1 }) {
  const t0 = c.currentTime + at;
  const length = Math.max(1, Math.floor(c.sampleRate * duration));
  const buffer = c.createBuffer(1, length, c.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
  const src = c.createBufferSource();
  src.buffer = buffer;
  const filter = c.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = freq;
  filter.Q.value = q;
  const amp = c.createGain();
  amp.gain.value = gain;
  src.connect(filter).connect(amp).connect(out);
  src.start(t0);
}

/** A struck metal bar or small bell: fundamental plus inharmonic overtones. */
function tine(c, out, freq, at, { gain = 0.22, decay = 1.6, ratios = [1, 2.756, 5.404, 8.933], bright = 1 } = {}) {
  ratios.forEach((r, i) => {
    partial(c, out, { freq: freq * r, at, gain: (gain / (i + 1) ** (1.4 / bright)), decay: decay / (1 + i * 0.9) });
  });
}

// Overtones of a tuned church bell, relative to the strike note (Rayleigh's
// classic bell partials: hum, prime, tierce, quint, nominal, and upper partials).
const BELL = [
  [0.5, 0.35, 4.2],   // hum
  [1.0, 0.30, 3.2],   // prime
  [1.183, 0.24, 2.6], // tierce (minor third: the bell's "sad" colour)
  [1.506, 0.12, 2.0], // quint
  [2.0, 0.26, 2.4],   // nominal
  [2.514, 0.10, 1.4],
  [2.662, 0.08, 1.2],
  [3.011, 0.07, 1.0],
  [4.166, 0.05, 0.7],
  [5.433, 0.03, 0.5],
];

function churchBell(c, out, freq, at) {
  noiseHit(c, out, { at, duration: 0.03, gain: 0.25, freq: freq * 6, q: 0.7 });
  for (const [r, g, d] of BELL) partial(c, out, { freq: freq * r, at, gain: g * 0.55, decay: d, attack: 0.002 });
}

// ---- The sounds ---------------------------------------------------------------

export const SOUNDS = [
  {
    id: 'chime',
    name: 'Chime',
    seconds: 2.2,
    play: (c, out) => [1046.5, 1318.5, 1568].forEach((f, i) =>
      tine(c, out, f, i * 0.16, { gain: 0.2, decay: 1.8, ratios: [1, 2.76, 5.4] })),
  },
  {
    id: 'bell',
    name: 'Church bell',
    seconds: 4.5,
    play: (c, out) => [0, 1.15, 2.3].forEach((at) => churchBell(c, out, 330, at)),
  },
  {
    id: 'bowl',
    name: 'Singing bowl',
    seconds: 4.5,
    play: (c, out) => {
      const f = 220;
      // Mallet strike, then a long, slowly beating ring (two slightly detuned
      // copies of each partial pulse against each other, like a real bowl).
      noiseHit(c, out, { duration: 0.04, gain: 0.12, freq: 1800, q: 0.8 });
      for (const [r, g, d] of [[1, 0.28, 6], [2.71, 0.14, 4.5], [5.15, 0.06, 3], [8.43, 0.025, 2]]) {
        partial(c, out, { freq: f * r, gain: g, decay: d, attack: 0.01, detune: -4 });
        partial(c, out, { freq: f * r, gain: g * 0.8, decay: d * 0.95, attack: 0.01, detune: 4 });
      }
    },
  },
  {
    id: 'marimba',
    name: 'Marimba',
    seconds: 2.4,
    play: (c, out) => {
      // Tuned wooden bars: strong fundamental, the 4th harmonic the bar is cut
      // for, a quick high "knock", and a short decay.
      const notes = [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5];
      const times = [0, 0.13, 0.26, 0.42, 0.62, 0.78];
      notes.forEach((f, i) => {
        const at = times[i];
        noiseHit(c, out, { at, duration: 0.012, gain: 0.08, freq: f * 3, q: 2 });
        partial(c, out, { freq: f, at, gain: 0.34, decay: 0.9, attack: 0.003 });
        partial(c, out, { freq: f * 4, at, gain: 0.07, decay: 0.25, attack: 0.002 });
        partial(c, out, { freq: f * 9.9, at, gain: 0.025, decay: 0.08, attack: 0.001 });
      });
    },
  },
  {
    id: 'windchimes',
    name: 'Wind chimes',
    seconds: 3.6,
    play: (c, out) => {
      // Pentatonic tubes struck in a loose, breezy cascade (fixed pattern, so
      // it sounds the same every time).
      const tubes = [1174.7, 1318.5, 1568, 1760, 2093, 2349.3];
      const pattern = [[0, 2], [0.18, 4], [0.31, 1], [0.55, 5], [0.7, 3], [0.98, 0], [1.12, 4], [1.4, 2], [1.75, 5], [2.05, 1]];
      for (const [at, n] of pattern) {
        tine(c, out, tubes[n], at, { gain: 0.15 - at * 0.03, decay: 2.4, ratios: [1, 2.76, 5.4, 8.93], bright: 1.3 });
      }
    },
  },
  {
    id: 'kitchen',
    name: 'Kitchen timer',
    seconds: 1.8,
    play: (c, out) => {
      // The wind-up timer's release click, then the hammer on a small bell.
      noiseHit(c, out, { duration: 0.015, gain: 0.35, freq: 2500, q: 3 });
      noiseHit(c, out, { at: 0.05, duration: 0.01, gain: 0.2, freq: 1800, q: 3 });
      const at = 0.09;
      noiseHit(c, out, { at, duration: 0.008, gain: 0.3, freq: 7000, q: 1 });
      for (const [r, g, d] of [[1, 0.3, 2.2], [2.32, 0.14, 1.4], [4.25, 0.08, 0.8], [6.63, 0.04, 0.5]]) {
        partial(c, out, { freq: 1720 * r, at, gain: g, decay: d, attack: 0.002 });
      }
    },
  },
  {
    id: 'alarmclock',
    name: 'Alarm clock',
    seconds: 2.6,
    play: (c, out) => {
      // An old double-bell alarm clock: the hammer rattles between two bells
      // about 28 times a second, in two bursts.
      const bells = [2100, 2520];
      for (const [start, end] of [[0, 0.75], [1.0, 1.75]]) {
        for (let t = start, i = 0; t < end; t += 1 / 28, i++) {
          const f = bells[i % 2];
          noiseHit(c, out, { at: t, duration: 0.006, gain: 0.12, freq: f * 2, q: 1 });
          for (const [r, g, d] of [[1, 0.17, 0.22], [2.4, 0.065, 0.12], [3.9, 0.03, 0.07]]) {
            partial(c, out, { freq: f * r, at: t, gain: g, decay: d, attack: 0.001 });
          }
        }
      }
    },
  },
  {
    id: 'digital',
    name: 'Digital alarm',
    seconds: 1.4,
    play: (c, out) => {
      for (let i = 0; i < 4; i++) {
        for (const dt of [0, 0.1]) partial(c, out, { freq: 1400, at: i * 0.25 + dt, gain: 0.4, decay: 0.07, attack: 0.002, type: 'square' });
      }
    },
  },
];

// Sounds that were renamed or replaced keep working for existing timers.
const ALIASES = { soft: 'bowl', beep: 'kitchen' };

export const DEFAULT_SOUND_ID = 'chime';

export function getSound(id) {
  const key = ALIASES[id] ?? id;
  return SOUNDS.find((s) => s.id === key) ?? SOUNDS[0];
}

/** Plays a sound. Returns the voice (a gain node) so it can be faded out. */
export function playSound(id) {
  try {
    const c = audio();
    if (c.state === 'suspended') c.resume();
    if (!chain) chain = outputChain(c);
    const voice = c.createGain();
    voice.connect(chain.input);
    getSound(id).play(c, voice);
    return voice;
  } catch (err) {
    console.warn('Could not play sound:', err);
    return null;
  }
}

let previewVoice = null;
/** Plays a sound for choosing it; cuts off the previous preview first. */
export function previewSound(id) {
  if (previewVoice) {
    const v = previewVoice;
    const t = v.context.currentTime;
    v.gain.cancelScheduledValues(t);
    v.gain.setValueAtTime(v.gain.value, t);
    v.gain.linearRampToValueAtTime(0, t + 0.08);
    setTimeout(() => v.disconnect(), 150);
  }
  previewVoice = playSound(id);
}

/** Renders a sound offline (for tests and level checks). Returns an AudioBuffer. */
export async function renderSound(id, sampleRate = 44100) {
  const seconds = getSound(id).seconds + 2.5;
  const c = new OfflineAudioContext(2, Math.ceil(sampleRate * seconds), sampleRate);
  const { input } = outputChain(c);
  getSound(id).play(c, input);
  return c.startRendering();
}
