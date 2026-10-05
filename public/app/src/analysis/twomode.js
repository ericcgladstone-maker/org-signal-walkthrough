// Two-mode (affiliation) measures.
//
// A two-mode network (net.twoMode.view === 'two-mode', built by buildNetwork
// from data marked by twoModeOf) has two kinds of node, actors (mode 0) and
// events (mode 1), and ties only between the kinds. One-mode formulas mislead
// there: nobody can have more than (size of the other mode) ties, every path
// alternates modes, and there are no triangles. These are the standard
// corrections (Borgatti and Everett 1997; Borgatti and Halgin 2011), written to
// match networkx.algorithms.bipartite exactly (tools/accuracy/checks/twomode.mjs):
//
//   twoModeDegree       degree / (number of nodes of the other mode)
//   twoModeBetweenness  unnormalised betweenness (unordered pairs) / the most a
//                       node of that mode can have given both mode sizes
//   twoModeCloseness    (m + 2(n - 1)) / (sum of distances) for a node of a
//                       mode with n nodes, the other having m, times the share
//                       of the network it can reach, (reach - 1) / (N - 1)
//   twoModeClustering   Latapy, Magnien and Del Vecchio (2008), "dot" mode:
//                       mean over nodes two steps away of |N(u) and N(v)| /
//                       |N(u) or N(v)|
//   twoModeDensity      ties / (n0 x n1)
//   robinsAlexander     4 x four-cycles / three-paths (Robins and Alexander 2004)
//
// All are unweighted (as networkx): an affiliation is there or not.

import { graphOf } from './graph.js';
import { brandes } from './metrics.js';
import { networkFromEdges } from './construct.js';

export const TWO_MODE_METRICS = ['twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering'];

export const isTwoModeView = (net) => !!net?.twoMode && net.twoMode.view === 'two-mode' && !!net.twoMode.mode;

// Largest unnormalised betweenness a node of a mode with `n` nodes can have
// when the other mode has `m` (Borgatti and Everett 1997, as networkx).
export function twoModeBetweennessMax(n, m) {
  if (!(m > 0) || !(n > 0)) return NaN;
  const s = Math.floor((n - 1) / m), t = (n - 1) - s * m;
  return ((m * m) * ((s + 1) ** 2) + m * (s + 1) * (2 * t - s - 1) - t * (2 * s - t + 3)) / 2;
}

// opts: { which (subset of TWO_MODE_METRICS), betweenness (one-mode normalised
// betweenness already computed, reused), pivots, seed, onProgress }
export function twoModeNodeMetrics(net, opts = {}) {
  if (!isTwoModeView(net)) return {};
  const which = new Set(opts.which || TWO_MODE_METRICS);
  const g = graphOf(net);
  const { n } = g, { off, adj } = g.und;
  const mode = net.twoMode.mode;
  const cnt = [0, 0];
  for (let v = 0; v < n; v++) cnt[mode[v]]++;
  const other = (v) => cnt[1 - mode[v]];
  const out = {};
  if (which.has('twoModeDegree')) {
    const d = new Float64Array(n);
    for (let v = 0; v < n; v++) d[v] = other(v) ? (off[v + 1] - off[v]) / other(v) : NaN;
    out.twoModeDegree = d;
  }
  if (which.has('twoModeBetweenness')) {
    let bc = opts.betweenness;
    if (!bc) bc = brandes(g, { weighted: false, pivots: opts.pivots || 0, seed: opts.seed ?? 1, onProgress: opts.onProgress || (() => {}) }).betweenness;
    // Back to networkx's unnormalised undirected count (each unordered pair once).
    const pairs = n > 2 ? ((n - 1) * (n - 2)) / 2 : 0;
    const max = [twoModeBetweennessMax(cnt[0], cnt[1]), twoModeBetweennessMax(cnt[1], cnt[0])];
    const b = new Float64Array(n);
    for (let v = 0; v < n; v++) {
      const mx = max[mode[v]];
      b[v] = mx > 0 ? (bc[v] * pairs) / mx : NaN;
    }
    out.twoModeBetweenness = b;
  }
  if (which.has('twoModeCloseness')) out.twoModeCloseness = twoModeCloseness(g, mode, cnt);
  if (which.has('twoModeClustering')) out.twoModeClustering = latapyClustering(g);
  return out;
}

// Classic closeness with the bipartite minimum distance sum in the numerator
// and networkx's reach correction for disconnected networks.
function twoModeCloseness(g, mode, cnt) {
  const { n } = g, { off, adj } = g.und;
  const out = new Float64Array(n);
  const dist = new Int32Array(n).fill(-1);
  const Q = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    let qh = 0, qt = 0, tot = 0;
    dist[s] = 0; Q[qt++] = s;
    while (qh < qt) {
      const v = Q[qh++];
      tot += dist[v];
      for (let p = off[v]; p < off[v + 1]; p++) { const u = adj[p]; if (dist[u] < 0) { dist[u] = dist[v] + 1; Q[qt++] = u; } }
    }
    const reach = qt;
    for (let k = 0; k < qt; k++) dist[Q[k]] = -1;
    if (tot > 0 && n > 1) {
      const own = cnt[mode[s]], oth = cnt[1 - mode[s]];
      out[s] = ((oth + 2 * (own - 1)) / tot) * ((reach - 1) / (n - 1));
    } else out[s] = 0;
  }
  return out;
}

// Latapy et al. (2008) pairwise clustering, "dot" mode (networkx
// bipartite.clustering default). 0 for nodes with nobody two steps away.
export function latapyClustering(g) {
  const { n } = g, { off, adj } = g.und;
  const out = new Float64Array(n);
  const common = new Int32Array(n);
  const touched = [];
  for (let v = 0; v < n; v++) {
    touched.length = 0;
    for (let p = off[v]; p < off[v + 1]; p++) {
      const y = adj[p];
      for (let q = off[y]; q < off[y + 1]; q++) {
        const u = adj[q];
        if (u === v) continue;
        if (!common[u]) touched.push(u);
        common[u]++;
      }
    }
    if (!touched.length) continue;
    const dv = off[v + 1] - off[v];
    touched.sort((a, b) => a - b);
    let c = 0;
    for (const u of touched) {
      const du = off[u + 1] - off[u], k = common[u];
      c += k / (du + dv - k);
      common[u] = 0;
    }
    out[v] = c / touched.length;
  }
  return out;
}

// Whole-network two-mode measures.
//   { twoModeDensity, robinsAlexander, twoModeAvgClustering, twoModeAvgClusteringByMode: [c0, c1],
//     modeCounts: [n0, n1], modeLabels, fourCycles, threePaths }
export function twoModeNetworkMetrics(net) {
  if (!isTwoModeView(net)) return null;
  const g = graphOf(net);
  const { n } = g, { off, adj } = g.und;
  const mode = net.twoMode.mode;
  const cnt = [0, 0];
  for (let v = 0; v < n; v++) cnt[mode[v]]++;
  const m = g.directed ? g.und.m : g.m;
  const res = { modeCounts: cnt, modeLabels: net.twoMode.labels };
  res.twoModeDensity = m === 0 ? 0 : m / (cnt[0] * cnt[1]);
  // Three-paths: every tie (u, v) is the middle of (deg u - 1)(deg v - 1).
  let L3 = 0;
  for (let v = 0; v < n; v++) for (let p = off[v]; p < off[v + 1]; p++) {
    const u = adj[p];
    if (u > v) L3 += (off[v + 1] - off[v] - 1) * (off[u + 1] - off[u] - 1);
  }
  // Four-cycles: each has exactly one pair of opposite mode-0 nodes, so
  // C4 = sum over mode-0 pairs of C(shared, 2).
  let C4 = 0;
  const common = new Int32Array(n);
  const touched = [];
  for (let v = 0; v < n; v++) {
    if (mode[v] !== 0) continue;
    touched.length = 0;
    for (let p = off[v]; p < off[v + 1]; p++) {
      const y = adj[p];
      for (let q = off[y]; q < off[y + 1]; q++) { const u = adj[q]; if (u <= v) continue; if (!common[u]) touched.push(u); common[u]++; }
    }
    for (const u of touched) { const k = common[u]; C4 += (k * (k - 1)) / 2; common[u] = 0; }
  }
  res.fourCycles = C4;
  res.threePaths = L3;
  res.robinsAlexander = n < 4 || m < 3 || L3 === 0 ? 0 : (4 * C4) / L3;
  const c = latapyClustering(g);
  let sum = 0;
  const byMode = [0, 0];
  for (let v = 0; v < n; v++) { sum += c[v]; byMode[mode[v]] += c[v]; }
  res.twoModeAvgClustering = n ? sum / n : 0;
  res.twoModeAvgClusteringByMode = [cnt[0] ? byMode[0] / cnt[0] : NaN, cnt[1] ? byMode[1] / cnt[1] : NaN];
  return res;
}

// Barber's (2007) bipartite modularity of a partition of the two-mode network:
//   Q_B = sum_c [ W_c / W - (K_c / W)(D_c / W) ]
// W = number of ties, W_c = ties inside c, K_c and D_c = total degree of the
// mode-0 and mode-1 nodes in c. Only cross-mode ties can exist, so the
// expected number between i and j is k_i d_j / W. Unweighted, like every
// two-mode measure here: an affiliation is there or not.
export function barberModularity(net, membership) {
  if (!isTwoModeView(net)) return NaN;
  const { src, dst, count } = net.edges;
  const mode = net.twoMode.mode;
  let W = 0;
  const inside = new Map(), K = new Map(), D = new Map();
  for (let e = 0; e < count; e++) {
    const a = src[e], b = dst[e], x = 1;
    W += x;
    const ca = membership[a], cb = membership[b];
    if (ca === cb) inside.set(ca, (inside.get(ca) || 0) + x);
    for (const [v, c] of [[a, ca], [b, cb]]) { const M = mode[v] === 0 ? K : D; M.set(c, (M.get(c) || 0) + x); }
  }
  if (!W) return NaN;
  let Q = 0;
  const cs = new Set([...K.keys(), ...D.keys()]);
  for (const c of cs) Q += (inside.get(c) || 0) / W - ((K.get(c) || 0) / W) * ((D.get(c) || 0) / W);
  return Q;
}

// One-mode projection of a two-mode network onto mode `basis` (network
// indices), as a Network over those nodes: weight = shared count, Newman
// 1 / (k - 1) per shared node, or 1. Used by community detection; the
// construction-level projection (settings.twoMode.view) is buildNetwork's.
export function projectNetwork(net, basis = 0, how = 'count') {
  const g = graphOf(net);
  const { n } = g, { off, adj } = g.und;
  const mode = net.twoMode.mode;
  const members = [];
  for (let v = 0; v < n; v++) if (mode[v] === basis) members.push(v);
  const local = new Int32Array(n).fill(-1);
  members.forEach((v, i) => { local[v] = i; });
  const edges = [];
  for (let y = 0; y < n; y++) {
    if (mode[y] === basis) continue;
    const k = off[y + 1] - off[y];
    if (k < 2) continue;
    const wt = how === 'newman' ? 1 / (k - 1) : 1;
    for (let p = off[y]; p < off[y + 1]; p++) for (let q = p + 1; q < off[y + 1]; q++) edges.push([local[adj[p]], local[adj[q]], wt]);
  }
  const proj = networkFromEdges(members.length, edges, { directed: false, nodeIds: members });
  if (how === 'binary') proj.edges.w.fill(1);
  return { net: proj, members };
}
