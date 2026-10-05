// API key handling for the optional LLM layer.
//
// Keys live in memory by default. "Remember on this device" writes them to
// localStorage, which is the only persistence a static, server-less app has;
// the UI must say plainly that anyone with access to this browser profile can
// read a remembered key. Storage access is wrapped in try/catch because it
// throws in private windows, sandboxed iframes and Node (where it does not
// exist at all), and a missing store must never break the app.
//
// Keys are never logged. Every error message that leaves this layer goes
// through redact(), which removes any key we have seen plus anything shaped
// like a provider key, so a key cannot leak into a toast, a report or a bug
// report even if a provider echoes it back.

const PREFIX = 'orgsignal.llm.key.';

// Every key handed to this module or to a provider adapter this session.
// Kept so redact() can remove exact matches, including ones that do not look
// like any known key format.
const seen = new Set();

export function rememberForRedaction(key) {
  if (typeof key === 'string' && key.length >= 8) seen.add(key);
}

// Patterns for provider keys, so keys never registered here are still caught.
// Anthropic: sk-ant-...; OpenAI: sk-... / sk-proj-...; Google: AIza... (39 chars).
const KEY_PATTERNS = [
  /sk-ant-[A-Za-z0-9_\-]{8,}/g,
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_\-]{16,}/g,
  /AIza[0-9A-Za-z_\-]{30,}/g,
];

export function redact(text) {
  if (text == null) return text;
  let s = String(text);
  for (const k of seen) if (k) s = s.split(k).join('[redacted key]');
  for (const re of KEY_PATTERNS) s = s.replace(re, '[redacted key]');
  // Query-string keys (Gemini accepts ?key=...).
  s = s.replace(/([?&]key=)[^&\s"']+/g, '$1[redacted key]');
  return s;
}

// For display: first few and last four characters only.
export function maskKey(key) {
  if (!key) return '';
  const k = String(key);
  if (k.length <= 10) return '****';
  return `${k.slice(0, k.startsWith('sk-ant-') ? 7 : 3)}...${k.slice(-4)}`;
}

function defaultStorage() {
  try {
    // globalThis.localStorage is undefined in Node and workers.
    const ls = globalThis.localStorage;
    if (!ls) return null;
    const probe = PREFIX + '__probe';
    ls.setItem(probe, '1');
    ls.removeItem(probe);
    return ls;
  } catch {
    return null;
  }
}

// createKeyStore({ storage }) -> { get, set, forget, isRemembered, canRemember, providers }
// storage is injectable for tests (anything with getItem/setItem/removeItem).
export function createKeyStore({ storage } = {}) {
  const mem = new Map();
  const store = storage === undefined ? defaultStorage() : storage;

  function readStored(provider) {
    if (!store) return null;
    try { return store.getItem(PREFIX + provider); } catch { return null; }
  }

  return {
    canRemember: () => !!store,

    get(provider) {
      if (mem.has(provider)) return mem.get(provider);
      const k = readStored(provider);
      if (k) { mem.set(provider, k); rememberForRedaction(k); }
      return k || null;
    },

    // remember: true writes to device storage; false removes any stored copy so
    // unticking "remember" really forgets.
    set(provider, key, { remember = false } = {}) {
      const k = typeof key === 'string' ? key.trim() : '';
      if (!k) return this.forget(provider);
      mem.set(provider, k);
      rememberForRedaction(k);
      if (store) {
        try {
          if (remember) store.setItem(PREFIX + provider, k);
          else store.removeItem(PREFIX + provider);
        } catch { /* storage full or blocked: the in-memory key still works */ }
      }
      return true;
    },

    forget(provider) {
      mem.delete(provider);
      if (store) { try { store.removeItem(PREFIX + provider); } catch { /* ignore */ } }
      return false;
    },

    isRemembered(provider) { return !!readStored(provider); },

    providers() { return [...mem.keys()]; },
  };
}
