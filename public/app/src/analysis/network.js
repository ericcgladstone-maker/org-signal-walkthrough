// Whole-network measures.

import { graphOf, components, strongComponents } from './graph.js';
import { triangles, brandes } from './metrics.js';
import { createRng, sampleWithoutReplacement } from './rng.js';
import { twoModeNetworkMetrics } from './twomode.js';

export function computeNetworkMetrics(net, opts = {}) {
  const g = graphOf(net);
  const { n, directed } = g;
  const m = net.edges.count;
  const progress = opts.onProgress || (() => {});
  const res = { nodes: n, ties: m, directed };

  res.density = n > 1 ? (directed ? m / (n * (n - 1)) : (2 * m) / (n * (n - 1))) : 0;
  res.reciprocity = directed ? overallReciprocity(g) : NaN;

  const t = triangles(g);
  let triSum = 0, triples = 0, cSum = 0, isolates = 0;
  for (let v = 0; v < n; v++) {
    const d = t.deg[v];
    triSum += t.triangles[v]; triples += (d * (d - 1)) / 2; cSum += t.clustering[v];
    if (!d) isolates++;
  }
  res.transitivity = triples ? (triSum) / triples : 0;   // = 3 * triangles / connected triples
  res.avgClustering = n ? cSum / n : 0;                   // networkx: isolates count as 0
  res.isolates = isolates;

  const cc = components(g);
  res.components = cc.count;
  res.largestComponentShare = n ? Math.max(...cc.sizes, 0) / n : 0;
  if (directed) res.strongComponents = strongComponents(g).count;

  // Mean shortest-path length over reachable ordered pairs (unweighted, directed
  // where the network is). Exact up to `pathSampleThreshold` nodes, sampled above.
  progress(0.2, 'path lengths');
  const pl = pathLengths(g, { maxSources: opts.pathSources ?? (n > (opts.pathSampleThreshold ?? 2000) ? 500 : n), seed: opts.seed ?? 1 });
  res.avgPathLength = pl.mean;
  res.diameter = pl.diameter;
  res.pathLengthSampled = pl.sampled;

  // Degree centralization (Freeman) on the symmetrised graph.
  let maxD = 0, sumGap = 0;
  for (let v = 0; v < n; v++) if (t.deg[v] > maxD) maxD = t.deg[v];
  for (let v = 0; v < n; v++) sumGap += maxD - t.deg[v];
  res.degreeCentralization = n > 2 ? sumGap / ((n - 1) * (n - 2)) : 0;

  const strength = new Float64Array(n);
  for (let e = 0; e < m; e++) { strength[net.edges.src[e]] += net.edges.w[e]; strength[net.edges.dst[e]] += net.edges.w[e]; }
  res.strengthGini = gini(strength);
  res.meanDegree = n ? (directed ? m / n : (2 * m) / n) : 0;
  res.degreeAssortativity = degreeAssortativity(g);
  // Two-mode network: density over possible cross-mode ties, bipartite clustering.
  const tm = twoModeNetworkMetrics(net);
  if (tm) Object.assign(res, tm);
  progress(1, 'done');
  return res;
}

export function overallReciprocity(g) {
  if (!g.directed || !g.m) return NaN;
  let both = 0;
  const O = g.out;
  for (let v = 0; v < g.n; v++) {
    for (let p = O.off[v]; p < O.off[v + 1]; p++) {
      const u = O.adj[p];
      if (hasEdge(O, u, v)) both++;
    }
  }
  return both / g.m;
}

export function hasEdge(C, a, b) {
  let lo = C.off[a], hi = C.off[a + 1] - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1, x = C.adj[mid];
    if (x === b) return true;
    if (x < b) lo = mid + 1; else hi = mid - 1;
  }
  return false;
}

export function transitivity(g) {
  const t = triangles(g);
  let tri = 0, triples = 0;
  for (let v = 0; v < g.n; v++) { tri += t.triangles[v]; triples += (t.deg[v] * (t.deg[v] - 1)) / 2; }
  return triples ? tri / triples : 0;
}

// Pearson correlation of degrees across tie ends (networkx
// degree_assortativity_coefficient: undirected uses degree at both ends, each
// tie counted both ways; directed uses source out-degree vs target in-degree).
export function degreeAssortativity(g) {
  const { n } = g;
  if (!g.m) return NaN;
  const outD = new Float64Array(n), inD = new Float64Array(n);
  for (let v = 0; v < n; v++) { outD[v] = g.out.off[v + 1] - g.out.off[v]; inD[v] = g.inn.off[v + 1] - g.inn.off[v]; }
  const xs = [], ys = [];
  for (let v = 0; v < n; v++) for (let p = g.out.off[v]; p < g.out.off[v + 1]; p++) {
    const u = g.out.adj[p];
    if (g.directed) { xs.push(outD[v]); ys.push(inD[u]); } else { xs.push(outD[v]); ys.push(outD[u]); }
  }
  return pearson(xs, ys);
}

export function pearson(xs, ys) {
  const k = xs.length;
  if (!k) return NaN;
  let mx = 0, my = 0;
  for (let i = 0; i < k; i++) { mx += xs[i]; my += ys[i]; }
  mx /= k; my /= k;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < k; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx && syy ? sxy / Math.sqrt(sxx * syy) : NaN;
}

export function gini(arr) {
  const a = Float64Array.from(arr).sort();
  const n = a.length;
  let sum = 0, acc = 0;
  for (let i = 0; i < n; i++) { sum += a[i]; acc += (i + 1) * a[i]; }
  return n && sum ? (2 * acc) / (n * sum) - (n + 1) / n : 0;
}

function pathLengths(g, { maxSources, seed }) {
  const { n } = g, { off, adj } = g.out;
  const sampled = maxSources < n;
  const sources = sampled ? sampleWithoutReplacement(n, maxSources, createRng(seed)) : null;
  const dist = new Int32Array(n).fill(-1), Q = new Int32Array(n);
  let total = 0, pairs = 0, diameter = 0;
  const K = sampled ? maxSources : n;
  for (let k = 0; k < K; k++) {
    const s = sampled ? sources[k] : k;
    let qh = 0, qt = 0;
    dist[s] = 0; Q[qt++] = s;
    while (qh < qt) {
      const v = Q[qh++];
      for (let p = off[v]; p < off[v + 1]; p++) { const u = adj[p]; if (dist[u] < 0) { dist[u] = dist[v] + 1; Q[qt++] = u; } }
    }
    for (let i = 1; i < qt; i++) { const d = dist[Q[i]]; total += d; pairs++; if (d > diameter) diameter = d; }
    for (let i = 0; i < qt; i++) dist[Q[i]] = -1;
  }
  return { mean: pairs ? total / pairs : NaN, diameter, sampled };
}

export { brandes };
