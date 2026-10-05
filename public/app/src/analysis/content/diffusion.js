// Diffusion of words through the network.
//
// For a term, each person's adoption time is their first message using it.
// An adoption is "exposed" if a network neighbour (either direction) used the
// term earlier (within `window` ms if given). The exposed share is compared
// with a time-shuffle null: adoption times are permuted among the same
// adopters, keeping network and adopter set fixed. If observed exposure is no
// higher than shuffled exposure, the term's spread does not follow ties; it
// may have arrived from outside (a meeting, an announcement, the news).

import { corpus, tokenize } from './corpus.js';
import { graphOf } from '../graph.js';
import { createRng } from '../rng.js';
import { isCommonWord } from './stopwords.js';

// A shuffled baseline at or above this share of exposed adopters leaves the
// test little room (see null.ceiling below).
export const CEILING = 0.85;

// opts: { terms: [...], auto = 8 (terms to pick when none given), minAdopters = 5,
//         window (ms), reps = 200, seed = 1, maxAdoptions = 500 }
export function diffusion(ds, net, opts = {}) {
  const C = corpus(ds);
  const ev = ds.events;
  const g = graphOf(net);
  const minAdopters = opts.minAdopters ?? 5;

  // Chronological documents with a time.
  const order = Array.from({ length: C.docs.length }, (_, d) => d).filter(d => Number.isFinite(ev.t[C.docs[d]]) && !ds.nodes.isBot[ev.actor[C.docs[d]]]);
  order.sort((a, b) => ev.t[C.docs[a]] - ev.t[C.docs[b]] || a - b);
  if (!order.length) return { terms: [], meta: { note: 'No dated messages with text.' } };
  const tStart = ev.t[C.docs[order[0]]], tEnd = ev.t[C.docs[order[order.length - 1]]];

  let wanted;
  if (opts.terms && opts.terms.length) {
    wanted = opts.terms.map(t => {
      const tok = tokenize(t, { stopwords: false });
      return tok.length ? C.termIndex.get(tok[0]) ?? -1 : -1;
    });
  } else wanted = null;

  // First use per (term, person).
  const first = new Map(); // term -> Map(person -> t)
  const want = wanted ? new Set(wanted.filter(x => x >= 0)) : null;
  for (const d of order) {
    const i = C.docs[d], a = ev.actor[i], t = ev.t[i];
    for (let p = C.off[d]; p < C.off[d + 1]; p++) {
      const w = C.tok[p];
      if (want && !want.has(w)) continue;
      let m = first.get(w);
      if (!m) { m = new Map(); first.set(w, m); }
      if (!m.has(a)) m.set(a, t);
    }
  }

  let chosen;
  if (wanted) chosen = wanted;
  else {
    // Automatic choice: new words. A candidate is not used at all in the
    // first 10% of the period (everyday vocabulary shows up early), is not a
    // stopword or an everyday English word (isCommonWord: in generated and
    // templated text "started" or "using" can first appear late without
    // being new), and reaches at least minAdopters people. Ranked by the
    // number of people who took it up.
    const cut = tStart + 0.1 * (tEnd - tStart);
    const cands = [];
    for (const [w, m] of first) {
      if (m.size < minAdopters) continue;
      let t0 = Infinity;
      for (const t of m.values()) if (t < t0) t0 = t;
      if (t0 < cut) continue;
      if (/^\d/.test(C.terms[w]) || isCommonWord(C.terms[w])) continue;
      cands.push([w, m.size]);
    }
    cands.sort((a, b) => b[1] - a[1] || a[0] - b[0]);
    chosen = cands.slice(0, opts.auto ?? 8).map(c => c[0]);
  }

  const rng = createRng(opts.seed ?? 1);
  const reps = opts.reps ?? 200;
  const results = [];
  chosen.forEach((w, qi) => {
    const label = wanted ? opts.terms[qi] : C.terms[w];
    const m = w >= 0 ? first.get(w) : null;
    if (!m || !m.size) { results.push({ term: label, adopters: 0, note: 'Term not found in dated messages.' }); return; }
    // Adopters inside the network, by network index.
    const nodes = [], times = [];
    for (const [a, t] of m) { const v = net.index[a]; if (v >= 0) { nodes.push(v); times.push(t); } }
    const tv = new Float64Array(g.n).fill(Infinity);
    nodes.forEach((v, k) => { tv[v] = times[k]; });
    const obs = exposure(g, nodes, tv, opts.window);
    // Time-shuffle null.
    const shuffled = Float64Array.from(times);
    const tmp = new Float64Array(g.n).fill(Infinity);
    const sims = new Float64Array(reps);
    for (let r = 0; r < reps; r++) {
      rng.shuffle(shuffled);
      nodes.forEach((v, k) => { tmp[v] = shuffled[k]; });
      sims[r] = exposure(g, nodes, tmp, opts.window).share;
    }
    let mean = 0;
    for (const x of sims) mean += x;
    mean /= reps;
    let v2 = 0, ge = 0;
    for (const x of sims) { v2 += (x - mean) ** 2; if (x >= obs.share - 1e-12) ge++; }
    const sd = reps > 1 ? Math.sqrt(v2 / (reps - 1)) : 0;
    // Cascade forest from the parent links.
    const depth = new Map();
    const order2 = nodes.map((v, k) => k).sort((a, b) => times[a] - times[b]);
    const size = new Map();
    let roots = 0, maxDepth = 0;
    for (const k of order2) {
      const v = nodes[k], p = obs.parent.get(v);
      const dpt = p === undefined ? 0 : (depth.get(p) ?? 0) + 1;
      depth.set(v, dpt);
      if (dpt > maxDepth) maxDepth = dpt;
      if (p === undefined) { roots++; size.set(v, 1); }
      else { let r = p; while (obs.parent.has(r)) r = obs.parent.get(r); size.set(r, (size.get(r) || 0) + 1); }
    }
    const adoptions = order2.slice(0, opts.maxAdoptions ?? 500).map(k => {
      const v = nodes[k], p = obs.parent.get(v);
      return { node: net.nodeIds[v], label: ds.nodes.labels[net.nodeIds[v]], t: times[k], exposed: p !== undefined, from: p === undefined ? null : net.nodeIds[p], dt: p === undefined ? null : times[k] - tv[p] };
    });
    results.push({
      term: label,
      adopters: nodes.length,
      outsideNetwork: m.size - nodes.length,
      first: Math.min(...times), last: Math.max(...times),
      exposedShare: obs.share, exposed: obs.exposed, eligible: obs.eligible,
      // room: how far above the shuffled baseline any result could go. When
      // most adopters would have an earlier-adopting contact anyway (dense
      // networks, popular terms), even 100% exposure is barely above the
      // null and the test cannot show much either way (N8): ceiling marks
      // a baseline of 85% or more, zMax the z of a 100% exposed share.
      null: { mean, sd, z: sd > 0 ? (obs.share - mean) / sd : NaN, pUpper: (ge + 1) / (reps + 1), reps, room: 1 - mean, zMax: sd > 0 ? (1 - mean) / sd : NaN, ceiling: mean >= CEILING },
      cascade: { roots, maxDepth, largest: Math.max(0, ...size.values()) },
      adoptions,
    });
  });
  // Several words tested at once: some would pass p < 0.05 by chance alone.
  // Holm's step-down correction (controls the chance of any false "follows
  // ties" across the words tested) gives each term null.pAdjusted.
  const tested = results.filter(r => r.null && Number.isFinite(r.null.pUpper));
  const adj = holm(tested.map(r => r.null.pUpper));
  tested.forEach((r, k) => { r.null.pAdjusted = adj[k]; });
  return { terms: results, meta: { window: opts.window ?? null, reps, seed: opts.seed ?? 1, auto: !wanted, neighbours: 'either direction', null: 'adoption times permuted among adopters', correction: 'holm', tested: tested.length } };
}

// Holm-Bonferroni adjusted p-values, in the input order.
export function holm(ps) {
  const m = ps.length;
  const idx = ps.map((p, i) => i).sort((a, b) => ps[a] - ps[b] || a - b);
  const out = new Array(m);
  let run = 0;
  idx.forEach((i, k) => { run = Math.max(run, Math.min(1, (m - k) * ps[i])); out[i] = run; });
  return out;
}

// Share of adopters (excluding the earliest) with an earlier-adopting neighbour.
// parent = the neighbour who adopted most recently before them.
function exposure(g, nodes, tv, window) {
  const U = g.und;
  let exposed = 0, eligible = 0;
  let tMin = Infinity;
  for (const v of nodes) if (tv[v] < tMin) tMin = tv[v];
  const parent = new Map();
  for (const v of nodes) {
    const t = tv[v];
    if (t === tMin) continue;
    eligible++;
    let best = -1, bt = -Infinity;
    for (let p = U.off[v]; p < U.off[v + 1]; p++) {
      const u = U.adj[p], tu = tv[u];
      if (tu < t && (window == null || t - tu <= window) && tu > bt) { bt = tu; best = u; }
    }
    if (best >= 0) { exposed++; parent.set(v, best); }
  }
  return { share: eligible ? exposed / eligible : NaN, exposed, eligible, parent };
}
