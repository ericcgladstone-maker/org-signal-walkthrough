// Paste ties: one tie per line of text -> Dataset.
//
// Accepted line forms (whitespace around separators is optional unless noted):
//   A - B      A -- B      A, B        A<TAB>B         undirected
//   A -> B     A <- B                                  directed (arrow points at the target)
//   A <-> B                                            two directed ties
//   A, B, 3    A<TAB>B<TAB>2.5   A -> B, 3   A - B 3   with a numeric weight
//   "Smith, Ann", "Lee, Bo", 2                          quoted names may contain commas
//   # comment, and blank lines, are ignored.
// Dash separators need surrounding spaces ("Mary-Kate - Bo"), so hyphenated
// names survive. Weights must be finite and positive.

import { DatasetBuilder } from '../core/model.js';
import { slug } from './common.js';

const ARROWS = [
  { re: /\s*<->\s*/, kind: 'both' },
  { re: /\s*->\s*/, kind: 'fwd' },
  { re: /\s*<-\s*/, kind: 'back' },
  { re: /\s+--?\s+/, kind: 'undirected' },
];

// Split a comma or tab separated line, honouring double quotes.
function splitDelimited(line, delim) {
  const out = [];
  let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++; } else q = !q;
    } else if (c === delim && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return { cells: out.map(s => s.trim()), unbalanced: q };
}

function unquote(s) {
  const t = s.trim();
  return t.length >= 2 && t[0] === '"' && t.at(-1) === '"' ? t.slice(1, -1).replace(/""/g, '"').trim() : t;
}

function parseWeight(s) {
  if (s === undefined || s === '') return { weight: 1 };
  const n = Number(s.trim());
  if (!Number.isFinite(n)) return { error: `Weight "${s.trim()}" is not a number.` };
  if (n <= 0) return { error: `Weight ${n} must be greater than zero.` };
  return { weight: n };
}

// Parse one non-empty, non-comment line. Returns { ties: [...] } or { error }.
export function parseLine(raw) {
  const line = raw.trim();
  // Arrow / dash forms. A trailing weight may follow after a comma, tab or space.
  for (const { re, kind } of ARROWS) {
    const m = line.match(re);
    if (!m) continue;
    const left = line.slice(0, m.index);
    let right = line.slice(m.index + m[0].length);
    let wTxt;
    const wm = right.match(/^(.*?)(?:\s*[,\t]\s*|\s+)(-?[\d.]+(?:e-?\d+)?)\s*$/i);
    if (wm && wm[1].trim()) { right = wm[1]; wTxt = wm[2]; }
    else {
      const extra = right.match(/^(.*?)\s*[,\t]\s*(\S.*)$/);
      if (extra && !/^"/.test(right.trim())) { right = extra[1]; wTxt = extra[2]; }
    }
    const a = unquote(left), b = unquote(right);
    if (!a || !b) return { error: 'A tie needs a name on both sides.' };
    const w = parseWeight(wTxt);
    if (w.error) return { error: w.error };
    if (kind === 'fwd') return { ties: [{ from: a, to: b, directed: true, weight: w.weight }] };
    if (kind === 'back') return { ties: [{ from: b, to: a, directed: true, weight: w.weight }] };
    if (kind === 'both') return { ties: [{ from: a, to: b, directed: true, weight: w.weight }, { from: b, to: a, directed: true, weight: w.weight }] };
    return { ties: [{ from: a, to: b, directed: false, weight: w.weight }] };
  }
  // Delimited forms: tab wins if present (spreadsheet paste), else comma, else semicolon.
  const delim = line.includes('\t') ? '\t' : line.includes(',') ? ',' : line.includes(';') ? ';' : null;
  if (!delim) return { error: 'Could not find two names. Separate them with " - ", " -> ", a comma or a tab.' };
  const { cells, unbalanced } = splitDelimited(line, delim);
  if (unbalanced) return { error: 'A quotation mark is not closed.' };
  const nonEmpty = cells.filter(c => c !== '');
  if (cells.length < 2 || !cells[0] || !cells[1]) return { error: 'A tie needs a name on both sides.' };
  if (nonEmpty.length > 3 || cells.length > 3) return { error: `Expected two names and an optional weight, found ${cells.length} fields.` };
  const w = parseWeight(cells[2]);
  if (w.error) return { error: w.error };
  return { ties: [{ from: cells[0], to: cells[1], directed: false, weight: w.weight }] };
}

// Parse a whole paste. Each tie remembers its 1-based line number so the
// preview can point at it. Self-ties are kept out and reported, since an
// analysis would drop them anyway.
export function parseTies(text) {
  const ties = [], errors = [], lines = [];
  const lineList = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  lineList.forEach((raw, i) => {
    const n = i + 1;
    const t = raw.trim();
    if (!t || t.startsWith('#')) { lines.push({ n, raw, kind: t ? 'comment' : 'blank' }); return; }
    const r = parseLine(t);
    if (r.error) { errors.push({ line: n, message: r.error }); lines.push({ n, raw, kind: 'error', message: r.error }); return; }
    const self = r.ties.find(x => x.from === x.to);
    if (self) {
      const message = `"${self.from}" is tied to themselves; self-ties are left out.`;
      errors.push({ line: n, message }); lines.push({ n, raw, kind: 'error', message }); return;
    }
    for (const tie of r.ties) ties.push({ ...tie, line: n });
    lines.push({ n, raw, kind: 'tie', ties: r.ties });
  });
  const nodes = [...new Set(ties.flatMap(t => [t.from, t.to]))];
  return { ties, errors, nodes, lines, directed: ties.some(t => t.directed) };
}

// Parsed ties -> Dataset. Repeated lines for the same pair stay as separate
// declared events; the network's weighting rule decides how they add up.
export function toDataset(parsed, { name = 'Pasted ties' } = {}) {
  if (!parsed.ties.length) throw new Error('There are no ties to analyze yet.');
  const b = new DatasetBuilder({ name });
  b.beginSource({ format: 'paste', family: 'custom', medium: 'text', view: 'full', context: 'custom', directed: parsed.directed, fileNames: [] });
  const keyOf = new Map();
  const used = new Set();
  for (const label of parsed.nodes) {
    let k = 'paste:' + slug(label);
    while (used.has(k)) k += '_';
    used.add(k); keyOf.set(label, k);
    b.node(k, { label });
  }
  const ctx = b.context('paste:ties', { name: 'Pasted ties', kind: 'canvas', visibility: 'unknown', medium: 'text' });
  for (const t of parsed.ties) {
    // Undirected ties are one event; with directed=false the analysis symmetrises.
    b.event({ type: 'declared', actor: b.nodeIndex(keyOf.get(t.from)), targets: [[b.nodeIndex(keyOf.get(t.to)), 'declared']], context: ctx, weight: t.weight });
    b.stat('ties');
  }
  b.stat('lines', parsed.lines.length);
  if (parsed.errors.length) b.warn('paste-unread-lines', 'Lines that could not be read as a tie and were left out', parsed.errors.length);
  return b.build();
}
