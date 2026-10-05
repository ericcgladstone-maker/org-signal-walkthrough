// Lexicon sentiment (VADER, Hutto and Gilbert 2014) per message, aggregated.
//
// VADER is approximate: built for English social-media text, it misses sarcasm,
// domain jargon ("kill the build") and other languages. Results always carry
// coverage and a likely-non-English count so the UI can say how much to trust
// them, and the unit of comparison is a group of messages, never one message.

import vaderModule from '../../../vendor/vader.js';
import { unitResolver, cleanText } from './corpus.js';

const SIA = vaderModule.SentimentIntensityAnalyzer;
const cache = new WeakMap();

export const AFFECT_NOTE = 'Lexicon-based sentiment (VADER) is approximate: it reads word lists, not meaning. It misses sarcasm, jargon and non-English text. Compare averages over many messages; do not read single messages.';

// Per-message scores, cached per dataset. Float32Arrays indexed by event; NaN
// where the event is not a message with text.
export function scoreMessages(ds, { onProgress, maxMessages = Infinity } = {}) {
  let c = cache.get(ds);
  if (c && c.maxMessages >= maxMessages) return c;
  const ev = ds.events, E = ev.count;
  const compound = new Float32Array(E).fill(NaN), pos = new Float32Array(E).fill(NaN), neg = new Float32Array(E).fill(NaN), neu = new Float32Array(E).fill(NaN);
  let messages = 0, withText = 0, scored = 0, nonEnglish = 0, quoted = 0;
  const textIdx = [];
  for (let i = 0; i < E; i++) {
    if (ev.type[i] !== 0) continue;
    messages++;
    if (ev.text?.[i] && String(ev.text[i]).trim()) { withText++; textIdx.push(i); }
  }
  // Deterministic thinning if a cap is set: every k-th message.
  const stride = textIdx.length > maxMessages ? textIdx.length / maxMessages : 1;
  const step = Math.max(1, Math.floor(textIdx.length / 100));
  let next = 0;
  for (let k = 0; k < textIdx.length; k++) {
    if (stride > 1) { if (k < next) continue; next += stride; }
    const i = textIdx[k];
    // Score only what the sender wrote: quoted replies carry someone else's tone.
    const cl = cleanText(ev.text[i]);
    if (cl.quoted) quoted++;
    const text = cl.text.trim() ? cl.text : String(ev.text[i]);
    if (likelyNonEnglish(text)) nonEnglish++;
    const s = SIA.polarity_scores(text.length > 5000 ? text.slice(0, 5000) : text);
    compound[i] = s.compound; pos[i] = s.pos; neg[i] = s.neg; neu[i] = s.neu;
    scored++;
    if (onProgress && k % step === 0) onProgress(k / textIdx.length, `sentiment ${k}/${textIdx.length}`);
  }
  c = { compound, pos, neg, neu, coverage: { messages, withText, scored, likelyNonEnglish: nonEnglish, quotedRemoved: quoted, sampled: stride > 1 }, maxMessages };
  cache.set(ds, c);
  return c;
}

// Share of letters outside basic Latin; above 30% the text is probably not
// English and VADER's lexicon will mostly miss it.
export function likelyNonEnglish(text) {
  let letters = 0, other = 0;
  for (const ch of text) {
    if (/\p{L}/u.test(ch)) { letters++; if (!/[A-Za-z]/.test(ch)) other++; }
  }
  return letters >= 4 && other / letters > 0.3;
}

// opts: { by: 'overall'|'node'|'group'|'context'|'visibility'|'window' or an array of them,
//         attr (for group), window ('day'|'week'|'month'|ms), minMessages = 1, maxMessages }
export function affect(ds, opts = {}) {
  const sc = scoreMessages(ds, { onProgress: opts.onProgress, maxMessages: opts.maxMessages ?? Infinity });
  const bys = [].concat(opts.by || 'overall');
  const res = { coverage: sc.coverage, note: AFFECT_NOTE, thresholds: { positive: 0.05, negative: -0.05 }, by: {} };
  for (const by of bys) res.by[by] = aggregate(ds, sc, by, opts);
  if (bys.length === 1) res.groups = res.by[bys[0]];
  if (opts.perMessage) res.perMessage = sc.compound;
  return res;
}

function aggregate(ds, sc, by, opts) {
  const U = unitResolver(ds, by, opts);
  const acc = new Map();
  const ev = ds.events;
  for (let i = 0; i < ev.count; i++) {
    const c = sc.compound[i];
    if (Number.isNaN(c)) continue;
    if (opts.excludeBots !== false && ds.nodes.isBot[ev.actor[i]]) continue;
    const k = U.of(i);
    if (k === null || k === undefined) continue;
    let a = acc.get(k);
    if (!a) { a = { n: 0, sum: 0, sq: 0, pos: 0, neg: 0, neu: 0, posN: 0, negN: 0 }; acc.set(k, a); }
    a.n++; a.sum += c; a.sq += c * c; a.pos += sc.pos[i]; a.neg += sc.neg[i]; a.neu += sc.neu[i];
    if (c >= 0.05) a.posN++; else if (c <= -0.05) a.negN++;
  }
  const minN = opts.minMessages ?? 1;
  const rows = [];
  for (const [k, a] of acc) {
    if (a.n < minN) continue;
    const mean = a.sum / a.n;
    const sd = a.n > 1 ? Math.sqrt(Math.max(0, (a.sq - a.n * mean * mean) / (a.n - 1))) : NaN;
    rows.push({ key: k, label: U.label(k), n: a.n, mean, sd, se: a.n > 1 ? sd / Math.sqrt(a.n) : NaN, pos: a.pos / a.n, neg: a.neg / a.n, neu: a.neu / a.n, posShare: a.posN / a.n, negShare: a.negN / a.n });
  }
  rows.sort((p, q) => (by === 'window' ? p.key - q.key : q.n - p.n));
  return rows;
}
