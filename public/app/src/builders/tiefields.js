// Tie fields: optional qualities recorded on a tie beyond "present" and its
// value (tie type, strength, frequency, how long, notes). Shared by the
// roster builder, the ego interview and shared surveys.
//
// A field definition is plain JSON:
//   { key, label, type, options?, max?, ordered?, multiple? }
//   type 'choice'  one of `options` (strings); multiple: true allows several.
//                  ordered: true means the options run from low to high, so
//                  the analysis can use the position as a weight.
//          'scale' a whole number 1..max
//          'number' any number (years known, hours a week)
//          'text'  free text (notes)
// Values are stored per tie as { [key]: value } and written to the Dataset as
// event attributes (events.attrs, see src/core/model.js); each source lists
// its definitions in source.tieFields so labels and option order survive.
//
// Every field is optional: a blank value is simply absent.

import { uid } from './common.js';
import { varName } from './ego.js';

export const TIE_FIELD_TYPES = [
  { id: 'choice', label: 'Choice' },
  { id: 'scale', label: 'Scale 1 to N' },
  { id: 'number', label: 'Number' },
  { id: 'text', label: 'Text' },
];

export const TIE_FIELD_PRESETS = [
  { id: 'tie_type', key: 'tie_type', label: 'Type of tie', type: 'choice', multiple: true,
    options: ['Advice', 'Collaboration', 'Information', 'Friendship', 'Support', 'Other'] },
  { id: 'strength', key: 'strength', label: 'Strength', type: 'scale', max: 5 },
  { id: 'closeness', key: 'closeness', label: 'Closeness', type: 'scale', max: 5 },
  { id: 'frequency', key: 'frequency', label: 'How often', type: 'choice', ordered: true,
    options: ['Less than monthly', 'Monthly', 'Weekly', 'Daily'] },
  { id: 'duration', key: 'years_known', label: 'Years known', type: 'number' },
  { id: 'notes', key: 'notes', label: 'Notes', type: 'text' },
];

export function makeTieField(preset = {}, taken = []) {
  const p = TIE_FIELD_PRESETS.find(x => x.id === preset.preset) || {};
  const f = { ...structuredClone(p), ...preset };
  delete f.preset; delete f.id;
  f.id = uid('f');
  f.type = TIE_FIELD_TYPES.some(t => t.id === f.type) ? f.type : 'text';
  f.label = String(f.label || 'Custom field');
  const base = varName(f.key || f.label);
  let key = base;
  for (let i = 2; taken.includes(key) || RESERVED.has(key); i++) key = `${base}_${i}`;
  f.key = key;
  if (f.type === 'choice') f.options = (f.options || []).map(String).filter(Boolean);
  else { delete f.options; delete f.ordered; delete f.multiple; }
  if (f.type === 'scale') f.max = Math.max(2, Math.min(10, Math.floor(Number(f.max) || 5)));
  else delete f.max;
  return f;
}

// Field keys the builders write themselves.
const RESERVED = new Set(['relation', 'report', 'perceived_by', 'respondent']);

export function updateTieField(f, patch) {
  const next = { ...f, ...patch };
  if (patch.type && patch.type !== f.type) return makeTieField({ ...next, key: f.key }, []);
  if (next.type === 'scale') next.max = Math.max(2, Math.min(10, Math.floor(Number(next.max) || 5)));
  if (next.type === 'choice') next.options = (next.options || []).map(s => String(s).trim()).filter(Boolean);
  return next;
}

// One typed value from what was entered; undefined for blank or invalid.
export function coerceTieValue(f, raw) {
  if (raw === undefined || raw === null) return undefined;
  if (Array.isArray(raw)) {
    const list = raw.map(x => String(x).trim()).filter(x => x && (!f.options?.length || f.options.includes(x)));
    if (!list.length) return undefined;
    return f.multiple ? list : list[0];
  }
  const s = String(raw).trim();
  if (s === '') return undefined;
  switch (f.type) {
    case 'scale': { const n = Math.round(Number(s)); return Number.isFinite(n) && n >= 1 && n <= (f.max || 5) ? n : undefined; }
    case 'number': { const n = Number(s); return Number.isFinite(n) ? n : undefined; }
    case 'choice': {
      if (!f.options?.length) return s;
      const hit = f.options.find(o => o.toLowerCase() === s.toLowerCase());
      return hit === undefined ? undefined : f.multiple ? [hit] : hit;
    }
    default: return s.slice(0, 2000);
  }
}

// { key: raw } -> { key: typed } with blanks dropped; null when empty.
export function cleanTieValues(fields, values) {
  if (!values || !fields?.length) return null;
  let out = null;
  for (const f of fields) {
    const v = coerceTieValue(f, values[f.key]);
    if (v !== undefined) (out ||= {})[f.key] = v;
  }
  return out;
}

// Definitions as the Dataset declares them (source.tieFields).
export function declareTieFields(fields) {
  return (fields || []).map(f => {
    const d = { key: f.key, label: f.label, type: f.type };
    if (f.options) d.options = [...f.options];
    if (f.ordered) d.ordered = true;
    if (f.multiple) d.multiple = true;
    if (f.max) d.max = f.max;
    return d;
  });
}

// Union of several field lists by key (first definition wins).
export function unionTieFields(...lists) {
  const out = [];
  for (const l of lists) for (const f of l || []) if (!out.some(x => x.key === f.key)) out.push(f);
  return out;
}

// Short text for a value list: "Advice, Friendship; strength 4".
export function describeTieValues(fields, values) {
  if (!values) return '';
  return (fields || []).filter(f => values[f.key] !== undefined).map(f => {
    const v = values[f.key];
    const t = Array.isArray(v) ? v.join(', ') : String(v);
    return f.type === 'text' ? `${f.label}: ${t.length > 40 ? t.slice(0, 38) + '...' : t}` : `${f.label} ${t}`;
  }).join('; ');
}

// Combine two people's reports of the same field on one undirected tie.
// Numbers follow the merge rule (larger for union, smaller for reciprocated
// only, matching how the tie value is combined); choices keep every value
// either person gave; text keeps both, distinct.
export function combineTieValues(fields, a, b, rule = 'union') {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  const out = { ...a };
  for (const f of fields || []) {
    const x = a[f.key], y = b[f.key];
    if (y === undefined) continue;
    if (x === undefined) { out[f.key] = y; continue; }
    if (f.type === 'scale' || f.type === 'number') out[f.key] = rule === 'intersection' ? Math.min(x, y) : Math.max(x, y);
    else if (f.type === 'choice') {
      const set = [...new Set([...(Array.isArray(x) ? x : [x]), ...(Array.isArray(y) ? y : [y])])];
      out[f.key] = set.length === 1 ? set[0] : set;
    } else out[f.key] = x === y ? x : `${x} / ${y}`;
  }
  return out;
}
