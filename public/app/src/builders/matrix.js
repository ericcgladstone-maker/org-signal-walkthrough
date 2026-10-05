// Directed tie maps keyed 'from|to' (person ids), shared by the roster and
// perceived-network builders. A map holds only present ties; absence = 0.

import { parseCSV } from '../importers/tabular.js';
import { normName } from './common.js';

export const pairKey = (from, to) => `${from}|${to}`;
export const splitKey = k => { const i = k.indexOf('|'); return [k.slice(0, i), k.slice(i + 1)]; };

// Every ordered pair of distinct people, in roster order.
export function* orderedPairs(people) {
  for (const a of people) for (const b of people) if (a.id !== b.id) yield [a.id, b.id];
}

export function setTie(map, from, to, value) {
  const k = pairKey(from, to);
  const next = { ...map };
  if (value === 0 || value === null || value === undefined || value === false || Number.isNaN(value)) delete next[k];
  else next[k] = value === true ? 1 : value;
  return next;
}

// Label -> person id lookup, tolerant of case, spacing and accents.
export function nameIndex(people) {
  const m = new Map();
  for (const p of people) m.set(normName(p.label), p.id);
  return m;
}

// Square adjacency matrix CSV: first row ",name1,name2,...", then
// "name,0,1,...". Names are matched to the roster; unknown names reported.
// Values: numbers as given, blank/0 absent; any other non-empty text = 1.
export function parseAdjacencyCSV(text, people) {
  const { rows } = parseCSV(text);
  if (rows.length < 2) return { ties: {}, unknown: [], error: 'The matrix needs a header row of names and at least one row.' };
  const idx = nameIndex(people);
  const cols = rows[0].slice(1).map(n => idx.get(normName(n)) ?? null);
  const unknown = new Set(rows[0].slice(1).filter((n, i) => n && cols[i] === null));
  const ties = {};
  for (const r of rows.slice(1)) {
    const from = idx.get(normName(r[0]));
    if (!from) { if (r[0]) unknown.add(r[0]); continue; }
    r.slice(1).forEach((cell, j) => {
      const to = cols[j];
      if (!to || to === from) return;
      const v = cellValue(cell);
      if (v) ties[pairKey(from, to)] = v;
    });
  }
  return { ties, unknown: [...unknown] };
}

// A survey cell -> tie value (0 = no tie). labels maps answer text to a number
// for valued scales ("Very close" -> 5).
export function cellValue(cell, labels = null) {
  const s = String(cell ?? '').trim();
  if (!s) return 0;
  if (labels) { const v = labels.get(normName(s)); if (v !== undefined) return v; }
  if (/^(no|false|0|n|none|not selected)$/i.test(s)) return 0;
  const n = Number(s);
  if (Number.isFinite(n)) return n > 0 ? n : 0;
  // A leading number in a label such as "4 - Close" counts as the value.
  const lead = s.match(/^(\d+(?:\.\d+)?)\b/);
  if (lead) return Number(lead[1]);
  return 1; // "Yes", "x", a checked checkbox's column label, ...
}

export function adjacencyCSV(people, ties) {
  const esc = s => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const lines = [',' + people.map(p => esc(p.label)).join(',')];
  for (const a of people) lines.push(esc(a.label) + ',' + people.map(b => (a.id === b.id ? '' : (ties[pairKey(a.id, b.id)] ?? 0))).join(','));
  return lines.join('\r\n') + '\r\n';
}
