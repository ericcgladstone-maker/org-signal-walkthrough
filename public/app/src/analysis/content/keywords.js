// Distinctive words per unit (person, group, context, time window) by TF-IDF.
//
// Each unit's messages are pooled into one document. tf = share of the unit's
// tokens; idf = ln((1 + U) / (1 + df)) + 1 over units (smooth idf, as in
// scikit-learn), so a word every unit uses scores low everywhere.

import { corpus, unitResolver } from './corpus.js';

// opts: { by = 'node', attr, window, k = 10, minCount = 2, minTokens = 20, maxUnits = 300, excludeBots = true }
export function keywords(ds, opts = {}) {
  const by = opts.by || 'node';
  const C = corpus(ds);
  const U = unitResolver(ds, by, opts);
  const k = opts.k ?? 10, minCount = opts.minCount ?? 2, minTokens = opts.minTokens ?? 20;
  const units = new Map();          // key -> Map(term -> count)
  const totals = new Map();
  const overall = new Float64Array(C.terms.length);
  // Messages using each term, over the same messages as `overall` (C.df
  // counts every message, bots included).
  const overallDocs = new Float64Array(C.terms.length);
  const lastDoc = new Int32Array(C.terms.length).fill(-1);
  for (let d = 0; d < C.docs.length; d++) {
    const i = C.docs[d];
    if (opts.excludeBots !== false && ds.nodes.isBot[ds.events.actor[i]]) continue;
    const key = U.of(i);
    if (key === null || key === undefined) continue;
    let m = units.get(key);
    if (!m) { m = new Map(); units.set(key, m); totals.set(key, 0); }
    for (let p = C.off[d]; p < C.off[d + 1]; p++) {
      const t = C.tok[p];
      m.set(t, (m.get(t) || 0) + 1); overall[t]++;
      if (lastDoc[t] !== d) { lastDoc[t] = d; overallDocs[t]++; }
    }
    totals.set(key, totals.get(key) + (C.off[d + 1] - C.off[d]));
  }
  let keys = [...units.keys()].filter(x => totals.get(x) >= minTokens);
  keys.sort((a, b) => totals.get(b) - totals.get(a));
  const truncated = keys.length > (opts.maxUnits ?? 300);
  // idf is computed over all qualifying units, even those not returned.
  const df = new Map();
  for (const key of keys) for (const t of units.get(key).keys()) df.set(t, (df.get(t) || 0) + 1);
  const N = keys.length;
  keys = keys.slice(0, opts.maxUnits ?? 300);
  const rows = keys.map(key => {
    const m = units.get(key), tot = totals.get(key);
    const scored = [];
    for (const [t, c] of m) {
      if (c < minCount) continue;
      const idf = Math.log((1 + N) / (1 + df.get(t))) + 1;
      scored.push({ term: C.terms[t], count: c, tfidf: (c / tot) * idf });
    }
    scored.sort((a, b) => b.tfidf - a.tfidf || b.count - a.count || (a.term < b.term ? -1 : 1));
    return { key, label: U.label(key), tokens: tot, terms: scored.slice(0, k) };
  });
  const top = Array.from(overall.keys()).filter(t => overall[t] > 0).sort((a, b) => overall[b] - overall[a]).slice(0, opts.overallK ?? 30)
    .map(t => ({ term: C.terms[t], count: overall[t], messages: overallDocs[t] }));
  return { by, units: rows, overall: top, meta: { cleaning: C.cleaning, documents: C.docs.length, vocabulary: C.terms.length, units: N, truncated, method: 'TF-IDF over pooled unit documents, smooth idf' } };
}
