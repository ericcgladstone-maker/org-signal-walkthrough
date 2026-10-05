// Topics: latent Dirichlet allocation fitted by collapsed Gibbs sampling
// (Griffiths and Steyvers 2004), seeded, in plain typed arrays.
//
// Short messages carry little topic signal each; pool: 'author-day' joins one
// person's messages from the same UTC day into one document, which usually
// gives cleaner topics in chat data. Results are approximate and vary with k
// and seed; the UI should show them as exploratory.

import { corpus, unitResolver } from './corpus.js';
import { createRng } from '../rng.js';

// opts: { k = 10, seed = 1, iterations = 150, alpha = 0.1, beta = 0.01,
//         pool = 'none'|'author-day', minTokens = 3, minDf, maxDfShare = 0.25,
//         maxVocab = 5000, maxDocs = 150000, topTerms = 10, attr, window, onProgress }
export function topics(ds, opts = {}) {
  const K = opts.k ?? 10;
  const iters = opts.iterations ?? 150;
  const alpha = opts.alpha ?? 0.1, beta = opts.beta ?? 0.01;
  const rng = createRng(opts.seed ?? 1);
  const progress = opts.onProgress || (() => {});
  const C = corpus(ds);
  const ev = ds.events;

  // 1. Documents (optionally pooled), skipping bots.
  let groups = [];
  if (opts.pool === 'author-day') {
    const map = new Map();
    for (let d = 0; d < C.docs.length; d++) {
      const i = C.docs[d];
      if (ds.nodes.isBot[ev.actor[i]] || !Number.isFinite(ev.t[i])) continue;
      const key = ev.actor[i] * 1e6 + Math.floor(ev.t[i] / 86400000);
      if (!map.has(key)) { map.set(key, []); }
      map.get(key).push(d);
    }
    groups = [...map.values()];
  } else {
    for (let d = 0; d < C.docs.length; d++) if (!ds.nodes.isBot[ev.actor[C.docs[d]]]) groups.push([d]);
  }
  const maxDocs = opts.maxDocs ?? 150000;
  let sampled = false;
  if (groups.length > maxDocs) {
    const stride = groups.length / maxDocs;
    groups = Array.from({ length: maxDocs }, (_, j) => groups[Math.floor(j * stride)]);
    sampled = true;
  }

  // 2. Vocabulary by document frequency over the chosen documents.
  const D0 = groups.length;
  const df = new Int32Array(C.terms.length);
  const mark = new Int32Array(C.terms.length).fill(-1);
  groups.forEach((g, j) => { for (const d of g) for (let p = C.off[d]; p < C.off[d + 1]; p++) { const t = C.tok[p]; if (mark[t] !== j) { mark[t] = j; df[t]++; } } });
  const minDf = opts.minDf ?? Math.max(2, Math.floor(D0 * 0.0005));
  const maxDf = (opts.maxDfShare ?? 0.25) * D0;
  let vocab = [];
  for (let t = 0; t < df.length; t++) if (df[t] >= minDf && df[t] <= maxDf) vocab.push(t);
  vocab.sort((a, b) => df[b] - df[a] || a - b);
  vocab = vocab.slice(0, opts.maxVocab ?? 5000);
  const V = vocab.length;
  const vid = new Int32Array(C.terms.length).fill(-1);
  vocab.forEach((t, i) => { vid[t] = i; });

  // 3. Flatten tokens of documents with enough in-vocabulary words.
  const minTokens = opts.minTokens ?? 3;
  const docEvents = [], words = [], docOff = [0];
  for (const g of groups) {
    const start = words.length;
    for (const d of g) for (let p = C.off[d]; p < C.off[d + 1]; p++) { const w = vid[C.tok[p]]; if (w >= 0) words.push(w); }
    if (words.length - start < minTokens) { words.length = start; continue; }
    docEvents.push(C.docs[g[0]]);
    docOff.push(words.length);
  }
  const D = docEvents.length, Ntok = words.length;
  if (!D || !V || K < 2) return { topics: [], meta: { documents: D, vocabulary: V, note: 'Not enough text for topics.' } };
  const W = Int32Array.from(words), off = Int32Array.from(docOff);
  const docOf = new Int32Array(Ntok);
  for (let d = 0; d < D; d++) for (let p = off[d]; p < off[d + 1]; p++) docOf[p] = d;

  // 4. Gibbs sampling.
  const z = new Uint16Array(Ntok);
  const ndk = new Int32Array(D * K), nwk = new Int32Array(V * K), nk = new Int32Array(K);
  for (let p = 0; p < Ntok; p++) { const k = rng.int(K); z[p] = k; ndk[docOf[p] * K + k]++; nwk[W[p] * K + k]++; nk[k]++; }
  const cum = new Float64Array(K);
  const Vb = V * beta;
  for (let it = 0; it < iters; it++) {
    for (let p = 0; p < Ntok; p++) {
      const w = W[p], d = docOf[p], dk = d * K, wk = w * K;
      let k = z[p];
      ndk[dk + k]--; nwk[wk + k]--; nk[k]--;
      let s = 0;
      for (let j = 0; j < K; j++) { s += (ndk[dk + j] + alpha) * (nwk[wk + j] + beta) / (nk[j] + Vb); cum[j] = s; }
      const u = rng() * s;
      k = 0;
      while (cum[k] < u) k++;
      z[p] = k; ndk[dk + k]++; nwk[wk + k]++; nk[k]++;
    }
    progress((it + 1) / iters, `topics: iteration ${it + 1}/${iters}`);
  }

  // 5. Topic-word and document-topic estimates.
  const topN = opts.topTerms ?? 10;
  const totalW = new Float64Array(V);
  for (let w = 0; w < V; w++) for (let k = 0; k < K; k++) totalW[w] += nwk[w * K + k];
  const out = [];
  for (let k = 0; k < K; k++) {
    const phi = (w) => (nwk[w * K + k] + beta) / (nk[k] + Vb);
    const ids = Array.from({ length: V }, (_, w) => w);
    const byPhi = [...ids].sort((a, b) => phi(b) - phi(a)).slice(0, topN);
    // Relevance (Sievert and Shirley 2014, lambda 0.6): favours words specific to this topic.
    const pw = (w) => (totalW[w] + beta) / (Ntok + Vb);
    const rel = (w) => 0.6 * Math.log(phi(w)) + 0.4 * Math.log(phi(w) / pw(w));
    const byRel = [...ids].sort((a, b) => rel(b) - rel(a)).slice(0, topN);
    out.push({ id: k, share: nk[k] / Ntok, terms: byPhi.map(w => ({ term: C.terms[vocab[w]], weight: phi(w) })), distinctive: byRel.map(w => C.terms[vocab[w]]) });
  }
  const theta = new Float32Array(D * K);
  for (let d = 0; d < D; d++) {
    const len = off[d + 1] - off[d];
    for (let k = 0; k < K; k++) theta[d * K + k] = (ndk[d * K + k] + alpha) / (len + K * alpha);
  }
  const agg = (by) => {
    const U = unitResolver(ds, by, opts);
    const acc = new Map();
    for (let d = 0; d < D; d++) {
      const key = U.of(docEvents[d]);
      if (key === null || key === undefined) continue;
      let a = acc.get(key);
      if (!a) { a = { n: 0, s: new Float64Array(K) }; acc.set(key, a); }
      a.n++;
      for (let k = 0; k < K; k++) a.s[k] += theta[d * K + k];
    }
    return [...acc].map(([key, a]) => ({ key, label: U.label(key), n: a.n, shares: Array.from(a.s, x => x / a.n) }))
      .sort((p, q) => (by === 'window' ? p.key - q.key : q.n - p.n));
  };
  const res = {
    topics: out,
    byNode: agg('node'),
    meta: { cleaning: C.cleaning, k: K, seed: opts.seed ?? 1, iterations: iters, alpha, beta, documents: D, tokens: Ntok, vocabulary: V, pool: opts.pool || 'none', sampled,
      note: 'Topics are exploratory: they change with k, seed and pooling. Name them from their words, and check a few messages before relying on one.' },
  };
  if (opts.attr) res.byGroup = agg('group');
  if (opts.window || opts.byWindow) res.byWindow = agg('window');
  return res;
}
