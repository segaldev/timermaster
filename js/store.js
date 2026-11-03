// Persistence layer. Everything that touches storage goes through this object,
// so it can later be swapped for an API-backed store (accounts) with the same
// load/save shape.

const KEY = 'multi-timer';
const VERSION = 1;

export const localStore = {
  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return { timers: [], settings: {}, firstRun: true };
      const data = JSON.parse(raw);
      return migrate(data);
    } catch (err) {
      console.warn('Could not load saved timers:', err);
      return { timers: [], settings: {} };
    }
  },

  save({ timers, settings }) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: VERSION, timers, settings }));
    } catch (err) {
      console.warn('Could not save timers:', err);
    }
  },
};

function migrate(data) {
  // Future schema changes go here, keyed on data.version.
  return {
    timers: Array.isArray(data.timers) ? data.timers : [],
    settings: data.settings ?? {},
  };
}
