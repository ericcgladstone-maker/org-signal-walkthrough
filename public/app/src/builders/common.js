// Shared helpers for the hand builders (draw, ego, roster, perceived, paste).
//
// Pure functions only: everything in src/builders/ runs in Node for tests and
// never touches the DOM. The UI in src/ui/build/ wraps these.

// Stable short id. crypto.randomUUID exists in Node 24 and every browser we
// target; ids only need to be unique within one drawing or session.
export function uid(prefix = '') {
  const u = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : String(Math.random()).slice(2) + Date.now().toString(36);
  return prefix + u.replace(/-/g, '').slice(0, 10);
}

export function uuid() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  // Fallback only for very old runtimes; not cryptographically meaningful.
  const h = () => Math.floor(Math.random() * 16).toString(16);
  return 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, h);
}

// Deterministic PRNG (mulberry32) so layouts and tests are reproducible.
export function rng(seed = 1) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Slug for namespaced node keys and context keys. Keeps it readable; callers
// add a uniqueness suffix when two labels slug the same.
export function slug(s) {
  return String(s ?? '').trim().toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'x';
}

// Name normalisation for dedupe (case, whitespace, accents).
export function normName(s) {
  return String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

// RFC 4180 CSV writer. Cells that start with = + - @ or a tab are prefixed
// with ' — the same formula-injection guard Network Canvas applies, so files
// we write open safely in spreadsheet software. Negative numbers are numbers,
// not formulas, so they are left alone.
export function csvCell(v) {
  if (v === null || v === undefined || (typeof v === 'number' && Number.isNaN(v))) return '';
  let s = typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
  if (typeof v !== 'number' && /^[=+\-@\t]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(rows) {
  return rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

// Parse a value typed into a field of a given type. Returns undefined for blank
// (so DatasetBuilder skips it rather than storing '').
export function coerce(value, type) {
  if (value === undefined || value === null) return undefined;
  const s = String(value).trim();
  if (s === '') return undefined;
  switch (type) {
    case 'number': case 'ordinal': case 'scale': {
      const n = Number(s);
      return Number.isFinite(n) ? n : undefined;
    }
    case 'boolean': return /^(true|yes|1|y)$/i.test(s);
    default: return s;
  }
}

export const ATTR_TYPES = ['text', 'number', 'categorical', 'ordinal', 'boolean', 'date'];

// Simple unique-label helper: 'Ann', 'Ann (2)', ...
export function uniqueLabel(label, taken) {
  if (!taken.has(label)) return label;
  let i = 2;
  while (taken.has(`${label} (${i})`)) i++;
  return `${label} (${i})`;
}
