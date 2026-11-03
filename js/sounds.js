// Sound registry. Sounds are synthesized with the Web Audio API, so there are
// no audio files to ship. To add a sound, add an entry to SOUNDS. Later, a
// sound could also be backed by an audio file (e.g. { id, name, url }).

let ctx = null;

function audio() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  return ctx;
}

/** Browsers only allow audio after a user gesture; call this from one. */
export function unlockAudio() {
  const c = audio();
  if (c.state === 'suspended') c.resume();
}

function tone(c, { freq, start = 0, duration = 0.3, type = 'sine', gain = 0.3, glideTo = null }) {
  const t0 = c.currentTime + start;
  const osc = c.createOscillator();
  const amp = c.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, t0 + duration);
  amp.gain.setValueAtTime(0.0001, t0);
  amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  amp.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(amp).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

export const SOUNDS = [
  {
    id: 'chime',
    name: 'Chime',
    play: (c) => [523.25, 659.25, 783.99].forEach((f, i) => tone(c, { freq: f, start: i * 0.18, duration: 0.6 })),
  },
  {
    id: 'bell',
    name: 'Bell',
    play: (c) => {
      tone(c, { freq: 880, duration: 1.6, gain: 0.3 });
      tone(c, { freq: 1760, duration: 1.0, gain: 0.08 });
      tone(c, { freq: 2640, duration: 0.6, gain: 0.04 });
    },
  },
  {
    id: 'beep',
    name: 'Beep',
    play: (c) => [0, 0.25, 0.5].forEach((s) => tone(c, { freq: 1000, start: s, duration: 0.15, type: 'square', gain: 0.12 })),
  },
  {
    id: 'digital',
    name: 'Digital alarm',
    play: (c) => {
      for (let i = 0; i < 4; i++) {
        tone(c, { freq: 1400, start: i * 0.2, duration: 0.08, type: 'square', gain: 0.1 });
        tone(c, { freq: 1400, start: i * 0.2 + 0.1, duration: 0.08, type: 'square', gain: 0.1 });
      }
    },
  },
  {
    id: 'soft',
    name: 'Soft drop',
    play: (c) => {
      tone(c, { freq: 660, glideTo: 440, duration: 0.5, gain: 0.25 });
      tone(c, { freq: 550, glideTo: 370, start: 0.35, duration: 0.6, gain: 0.2 });
    },
  },
];

export const DEFAULT_SOUND_ID = 'chime';

export function getSound(id) {
  return SOUNDS.find((s) => s.id === id) ?? SOUNDS[0];
}

export function playSound(id) {
  try {
    const c = audio();
    if (c.state === 'suspended') c.resume();
    getSound(id).play(c);
  } catch (err) {
    console.warn('Could not play sound:', err);
  }
}
