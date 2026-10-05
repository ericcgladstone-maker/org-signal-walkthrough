// Loads the real modules other owners write, lazily and defensively.
//
// The UI must keep working while the import pipeline, analysis engine, LLM
// layer and exporters are still landing, and must never fall back to fake
// data silently. So: with ?mock in the URL every service uses
// services/mock.js; without it, each service imports its real module and,
// if the module is missing or fails to load, reports itself unavailable and
// the view says so plainly.

const cache = new Map();

export const MOCK = (() => {
  try { return new URLSearchParams(location.search).has('mock'); } catch { return false; }
})();

export function mockSize() {
  try { return Number(new URLSearchParams(location.search).get('n')) || 96; } catch { return 96; }
}

// Paths are relative to this file. Returns the module namespace or null.
export async function tryImport(path) {
  if (cache.has(path)) return cache.get(path);
  const p = import(path).then(m => m, err => {
    console.info(`[org-signal] optional module ${path} not loaded: ${err.message}`);
    return null;
  });
  cache.set(path, p);
  return p;
}

// First function found under any of the given names (contract names first,
// then likely aliases), bound to its owner.
export function pickFn(obj, names) {
  if (!obj) return null;
  for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj);
  if (obj.default && typeof obj.default === 'object') return pickFn(obj.default, names);
  return null;
}
