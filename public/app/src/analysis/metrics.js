// Node-level measures on a Network.
//
// Conventions (also in docs/api/analysis.md, where the UI reads them):
//   - Arrays are indexed by network node (0..n-1); net.nodeIds maps to dataset nodes.
//   - Betweenness is normalised to the share of ordered node pairs whose shortest
//     paths pass through the node: raw / ((n-1)(n-2)), same for directed and
//     undirected networks (this equals networkx normalized=True in both cases).
//   - Weighted path measures use distance = 1 / weight: a stronger tie is a
//     shorter path.
//   - Closeness is harmonic: sum over others of 1/d(other -> node), divided by
//     n-1. Unreachable pairs add 0, so it is defined on disconnected graphs.
//     For directed networks distances run toward the node (networkx convention).
//   - Eigenvector uses the symmetrised weighted graph (w(a,b) + w(b,a)), unit
//     Euclidean norm, power iteration on A + I so bipartite graphs converge.
//   - Clustering and k-core use the symmetrised unweighted graph.
//   - Constraint and effective size follow Burt with mutual weights
//     w(a,b) + w(b,a), exactly as networkx.

import { graphOf, components } from './graph.js';
import { createRng, sampleWithoutReplacement } from './rng.js';
import { TWO_MODE_METRICS, isTwoModeView, twoModeNodeMetrics } from './twomode.js';

export const NODE_METRICS = ['degree', 'inDegree', 'outDegree', 'strength', 'inStrength', 'outStrength',
  'betweenness', 'betweennessWeighted', 'closeness', 'closenessWeighted', 'eigenvector', 'pagerank',
  'clustering', 'coreNumber', 'reciprocity', 'constraint', 'effectiveSize', 'egoDensity'];
const DEFAULT_WHICH = NODE_METRICS;

export function computeNodeMetrics(net, opts = {}) {
  const g = graphOf(net);
  // Two-mode networks also get the two-mode measures (src/analysis/twomode.js);
  // other networks never have them, even when asked.
  const twoMode = isTwoModeView(net);
  const which = new Set(opts.which || (twoMode ? [...DEFAULT_WHICH, ...TWO_MODE_METRICS] : DEFAULT_WHICH));
  const progress = opts.onProgress || (() => {});
  const out = {};
  const meta = {};
  const { n } = g;

  if (['degree', 'inDegree', 'outDegree', 'strength', 'inStrength', 'outStrength'].some(k => which.has(k))) {
    const d = degrees(g);
    for (const k of Object.keys(d)) if (which.has(k)) out[k] = d[k];
  }

  // Path-based measures: one pass per weighting computes betweenness and closeness together.
  const approx = decideApprox(n, opts);
  const passes = [];
  if (which.has('betweenness') || which.has('closeness')) passes.push(false);
  if (which.has('betweennessWeighted') || which.has('closenessWeighted')) passes.push(true);
  passes.forEach((weighted, pi) => {
    const sub = (f, msg) => progress((pi + f) / Math.max(1, passes.length) * 0.85, msg);
    const r = brandes(g, { weighted, pivots: approx.pivots, seed: opts.seed ?? 1, onProgress: sub, wantBetweenness: weighted ? which.has('betweennessWeighted') : which.has('betweenness') });
    if (weighted) { if (which.has('betweennessWeighted')) out.betweennessWeighted = r.betweenness; if (which.has('closenessWeighted')) out.closenessWeighted = r.closeness; }
    else { if (which.has('betweenness')) out.betweenness = r.betweenness; if (which.has('closeness')) out.closeness = r.closeness; }
  });
  if (passes.length) {
    const m = approx.pivots ? { approximate: true, pivots: approx.pivots, method: 'k-pivot sampling (Brandes and Pich 2007), scaled by n/k', seed: opts.seed ?? 1 } : { approximate: false };
    for (const k of ['betweenness', 'betweennessWeighted', 'closeness', 'closenessWeighted']) if (out[k]) meta[k] = m;
  }
  progress(0.86, 'eigenvector and pagerank');
  if (which.has('eigenvector')) { const r = eigenvector(g); out.eigenvector = r.x; meta.eigenvector = { converged: r.converged, iterations: r.iterations, method: r.method, variant: 'symmetrised weighted graph, unit norm' }; }
  if (which.has('pagerank')) { const r = pagerank(g); out.pagerank = r.x; meta.pagerank = { converged: r.converged, iterations: r.iterations, alpha: 0.85 }; }
  progress(0.92, 'local structure');
  if (which.has('clustering') || which.has('egoDensity')) {
    const t = triangles(g);
    if (which.has('clustering')) out.clustering = t.clustering;
    if (which.has('egoDensity')) out.egoDensity = g.directed ? egoDensityDirected(g) : t.clustering.map((c, i) => (t.deg[i] < 2 ? NaN : c));
  }
  if (which.has('coreNumber')) out.coreNumber = coreNumber(g);
  if (which.has('reciprocity')) out.reciprocity = nodeReciprocity(g);
  if (which.has('constraint') || which.has('effectiveSize')) {
    const b = burt(g);
    if (which.has('constraint')) out.constraint = b.constraint;
    if (which.has('effectiveSize')) out.effectiveSize = b.effectiveSize;
  }
  const tmWhich = twoMode ? TWO_MODE_METRICS.filter(k => which.has(k)) : [];
  if (tmWhich.length) {
    progress(0.97, 'two-mode measures');
    Object.assign(out, twoModeNodeMetrics(net, { which: tmWhich, betweenness: out.betweenness, pivots: approx.pivots, seed: opts.seed ?? 1 }));
    if (out.twoModeBetweenness) meta.twoModeBetweenness = { ...(approx.pivots ? { approximate: true, pivots: approx.pivots, seed: opts.seed ?? 1 } : { approximate: false }), normalization: 'Borgatti and Everett (1997), per mode' };
    if (out.twoModeCloseness) meta.twoModeCloseness = { approximate: false, normalization: 'Borgatti and Everett (1997), per mode; networkx reach correction' };
  }
  progress(1, 'done');
  out.meta = meta;
  return out;
}

function decideApprox(n, opts) {
  const threshold = opts.approxThreshold ?? 3000;
  const use = opts.approx === true || (opts.approx !== false && n > threshold);
  if (!use) return { pivots: 0 };
  const k = Math.min(n, opts.pivots ?? Math.max(256, Math.round(Math.sqrt(n) * 10)));
  return { pivots: k >= n ? 0 : k };
}

// ---- degree and strength --------------------------------------------------------------

export function degrees(g) {
  const { n } = g;
  const outDegree = new Float64Array(n), inDegree = new Float64Array(n), outStrength = new Float64Array(n), inStrength = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    outDegree[v] = g.out.off[v + 1] - g.out.off[v];
    inDegree[v] = g.inn.off[v + 1] - g.inn.off[v];
    let so = 0, si = 0;
    for (let p = g.out.off[v]; p < g.out.off[v + 1]; p++) so += g.out.w[p];
    for (let p = g.inn.off[v]; p < g.inn.off[v + 1]; p++) si += g.inn.w[p];
    outStrength[v] = so; inStrength[v] = si;
  }
  if (!g.directed) return { degree: outDegree, inDegree: outDegree, outDegree, strength: outStrength, inStrength: outStrength, outStrength };
  // Directed degree = in + out (networkx convention); a reciprocated tie counts twice.
  const degree = new Float64Array(n), strength = new Float64Array(n);
  for (let v = 0; v < n; v++) { degree[v] = inDegree[v] + outDegree[v]; strength[v] = inStrength[v] + outStrength[v]; }
  return { degree, inDegree, outDegree, strength, inStrength, outStrength };
}

// ---- Brandes betweenness and harmonic closeness ----------------------------------------

// Shortest paths from each source (all, or `pivots` sampled ones). Ties in
// weighted distances are detected with a relative tolerance so that two paths
// of equal length are both counted even if their float sums differ in the
// last bit (networkx compares exactly).
export function brandes(g, { weighted = false, pivots = 0, seed = 1, onProgress = () => {}, wantBetweenness = true } = {}) {
  const { n } = g;
  const { off, adj, w } = g.out;
  const inOff = g.inn.off, inAdj = g.inn.adj, inW = g.inn.w;
  const bc = new Float64Array(n), harm = new Float64Array(n);
  const sigma = new Float64Array(n), delta = new Float64Array(n);
  const S = new Int32Array(n);
  let sources;
  if (pivots && pivots < n) sources = sampleWithoutReplacement(n, pivots, createRng(seed));
  else { sources = new Int32Array(n); for (let i = 0; i < n; i++) sources[i] = i; }
  const K = sources.length;
  const step = Math.max(1, Math.floor(K / 100));

  if (!weighted) {
    const dist = new Int32Array(n).fill(-1);
    const Q = new Int32Array(n);
    for (let si = 0; si < K; si++) {
      const s = sources[si];
      let qh = 0, qt = 0, top = 0;
      dist[s] = 0; sigma[s] = 1; Q[qt++] = s;
      while (qh < qt) {
        const v = Q[qh++]; S[top++] = v;
        const dv = dist[v] + 1, sv = sigma[v];
        for (let p = off[v]; p < off[v + 1]; p++) {
          const u = adj[p];
          if (dist[u] < 0) { dist[u] = dv; Q[qt++] = u; sigma[u] = sv; }
          else if (dist[u] === dv) sigma[u] += sv;
        }
      }
      for (let k = 1; k < top; k++) harm[S[k]] += 1 / dist[S[k]];
      if (wantBetweenness) {
        for (let k = top - 1; k > 0; k--) {
          const x = S[k], dx = dist[x] - 1, coef = (1 + delta[x]) / sigma[x];
          for (let p = inOff[x]; p < inOff[x + 1]; p++) {
            const v = inAdj[p];
            if (dist[v] === dx) delta[v] += sigma[v] * coef;
          }
          bc[x] += delta[x];
        }
      }
      for (let k = 0; k < top; k++) { const v = S[k]; dist[v] = -1; sigma[v] = 0; delta[v] = 0; }
      if (si % step === 0) onProgress(si / K, `shortest paths ${si}/${K}`);
    }
  } else {
    const dist = new Float64Array(n).fill(Infinity);
    const heap = new IndexedHeap(n, dist);
    const done = new Uint8Array(n);
    // Purely relative, so multiplying every weight by a constant cannot change
    // which paths tie: with max(1, |x|) here the tolerance was absolute below
    // distance 1, and with heavy ties (distance ~1e-6) genuinely different
    // paths counted as equal (tools/accuracy campaign, 2026-10-03).
    const tol = (x) => 1e-10 * Math.abs(x);
    for (let si = 0; si < K; si++) {
      const s = sources[si];
      let top = 0;
      dist[s] = 0; sigma[s] = 1; heap.push(s);
      while (heap.size) {
        const v = heap.pop();
        done[v] = 1; S[top++] = v;
        const dv = dist[v], sv = sigma[v];
        for (let p = off[v]; p < off[v + 1]; p++) {
          const u = adj[p];
          if (done[u]) continue;
          const nd = dv + 1 / w[p];
          const du = dist[u];
          if (du === Infinity) { dist[u] = nd; sigma[u] = sv; heap.push(u); }
          else if (nd < du - tol(du)) { dist[u] = nd; sigma[u] = sv; heap.decrease(u); }
          else if (Math.abs(nd - du) <= tol(du)) sigma[u] += sv;
        }
      }
      for (let k = 1; k < top; k++) harm[S[k]] += 1 / dist[S[k]];
      if (wantBetweenness) {
        for (let k = top - 1; k > 0; k--) {
          const x = S[k], dx = dist[x], coef = (1 + delta[x]) / sigma[x];
          for (let p = inOff[x]; p < inOff[x + 1]; p++) {
            const v = inAdj[p];
            if (!done[v] || v === x) continue;
            if (Math.abs(dist[v] + 1 / inW[p] - dx) <= tol(dx) && dist[v] < dx) delta[v] += sigma[v] * coef;
          }
          bc[x] += delta[x];
        }
      }
      for (let k = 0; k < top; k++) { const v = S[k]; dist[v] = Infinity; sigma[v] = 0; delta[v] = 0; done[v] = 0; }
      if (si % step === 0) onProgress(si / K, `weighted shortest paths ${si}/${K}`);
    }
  }
  onProgress(1, 'shortest paths done');
  const scaleK = K < n ? n / K : 1;
  const bScale = n > 2 ? scaleK / ((n - 1) * (n - 2)) : 0;
  const cScale = n > 1 ? scaleK / (n - 1) : 0;
  for (let i = 0; i < n; i++) { bc[i] *= bScale; harm[i] *= cScale; }
  return { betweenness: wantBetweenness ? bc : null, closeness: harm, sources: K };
}

// Binary min-heap keyed by an external distance array, with decrease-key.
class IndexedHeap {
  constructor(n, key) { this.h = new Int32Array(n); this.pos = new Int32Array(n).fill(-1); this.size = 0; this.key = key; }
  push(v) { const i = this.size++; this.h[i] = v; this.pos[v] = i; this.up(i); }
  decrease(v) { this.up(this.pos[v]); }
  pop() {
    const h = this.h, top = h[0];
    this.pos[top] = -1;
    const last = h[--this.size];
    if (this.size > 0) { h[0] = last; this.pos[last] = 0; this.down(0); }
    return top;
  }
  less(a, b) { const ka = this.key[a], kb = this.key[b]; return ka < kb || (ka === kb && a < b); }
  up(i) {
    const h = this.h, pos = this.pos, v = h[i];
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(v, h[p])) break;
      h[i] = h[p]; pos[h[i]] = i; i = p;
    }
    h[i] = v; pos[v] = i;
  }
  down(i) {
    const h = this.h, pos = this.pos, v = h[i], n = this.size;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && this.less(h[c + 1], h[c])) c++;
      if (!this.less(h[c], v)) break;
      h[i] = h[c]; pos[h[i]] = i; i = c;
    }
    h[i] = v; pos[v] = i;
  }
}

// ---- eigenvector and pagerank ----------------------------------------------------------

// Power iteration on A + I converges like ((lambda2 + 1) / (lambda1 + 1))^k.
// When two separate heavy ties (or two similar components) give nearly equal
// leading eigenvalues that ratio is 0.997-0.9999 and 1,000 iterations leave
// errors up to 1e-2 (tools/accuracy campaign, 2026-10-03). Then a restarted
// Lanczos run from the power iterate finishes the job: the iterate's direction
// inside the leading eigenspace is that of the uniform start (every component
// there grows at the same rate), so the limit is the same vector networkx's
// power iteration would reach, only reached in far fewer steps.
export function eigenvector(g, { tol = 1e-12, maxIter = 1000 } = {}) {
  const { n } = g, { off, adj, w } = g.und;
  let x = new Float64Array(n).fill(n ? 1 / n : 0);
  if (!g.m) return { x: new Float64Array(n), converged: true, iterations: 0, method: 'power' };
  let y = new Float64Array(n);
  for (let it = 1; it <= maxIter; it++) {
    for (let v = 0; v < n; v++) {
      let s = x[v];
      for (let p = off[v]; p < off[v + 1]; p++) s += x[adj[p]] * w[p];
      y[v] = s;
    }
    let norm = 0;
    for (let v = 0; v < n; v++) norm += y[v] * y[v];
    norm = Math.sqrt(norm) || 1;
    let err = 0;
    for (let v = 0; v < n; v++) { y[v] /= norm; err += Math.abs(y[v] - x[v]); }
    const t = x; x = y; y = t;
    if (err < n * tol) return { x: zeroIsolates(x, off, n), converged: true, iterations: it, method: 'power' };
  }
  const L = lanczosTop(g.und, n, x);
  return { x: zeroIsolates(L.x, off, n), converged: L.converged, iterations: maxIter + L.iterations, method: 'power, then Lanczos' };
}

// A person without ties has eigenvector centrality 0 exactly; the iteration
// only shrinks them geometrically (1e-13 after convergence on a small graph),
// which would rank them above people in other small components.
function zeroIsolates(x, off, n) {
  for (let v = 0; v < n; v++) if (off[v + 1] === off[v]) x[v] = 0;
  return x;
}

// Leading eigenvector of the symmetric matrix in CSR `C` by Lanczos with full
// reorthogonalisation, restarted from the best Ritz vector. Converged when
// the residual ||A y - theta y|| is below 1e-13 theta (the vector error is
// residual / gap, so this is as good as float64 allows for any gap the power
// iteration could not close).
function lanczosTop(C, n, start, { maxBasis = 120, restarts = 40 } = {}) {
  const { off, adj, w } = C;
  const mul = (v, out) => {
    for (let i = 0; i < n; i++) { let s = 0; for (let p = off[i]; p < off[i + 1]; p++) s += v[adj[p]] * w[p]; out[i] = s; }
    return out;
  };
  const dot = (a, b) => { let s = 0; for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
  let y = Float64Array.from(start);
  let iterations = 0, converged = false;
  const k = Math.min(maxBasis, n);
  const Av = new Float64Array(n);
  for (let r = 0; r < restarts && !converged; r++) {
    const Q = [];
    const alpha = [], beta = [];
    let q = Float64Array.from(y);
    let nq = Math.sqrt(dot(q, q)) || 1;
    for (let i = 0; i < n; i++) q[i] /= nq;
    for (let j = 0; j < k; j++) {
      Q.push(q);
      const wv = mul(q, new Float64Array(n));
      iterations++;
      const a = dot(q, wv);
      alpha.push(a);
      // Full reorthogonalisation, twice ("twice is enough"), keeps the basis
      // orthogonal so no spurious copies of the top eigenvalue appear.
      for (let pass = 0; pass < 2; pass++) for (const qi of Q) { const c = dot(qi, wv); for (let i = 0; i < n; i++) wv[i] -= c * qi[i]; }
      const b = Math.sqrt(dot(wv, wv));
      if (j === k - 1 || b < 1e-14 * Math.max(1, Math.abs(a))) break;
      beta.push(b);
      for (let i = 0; i < n; i++) wv[i] /= b;
      q = wv;
    }
    const m = alpha.length;
    const T = Array.from({ length: m }, (_, i) => { const row = new Float64Array(m); row[i] = alpha[i]; if (i > 0) row[i - 1] = beta[i - 1]; if (i < m - 1) row[i + 1] = beta[i]; return row; });
    const { value, vector } = jacobiTop(T);
    y = new Float64Array(n);
    for (let j = 0; j < m; j++) { const s = vector[j], qj = Q[j]; for (let i = 0; i < n; i++) y[i] += s * qj[i]; }
    const ny = Math.sqrt(dot(y, y)) || 1;
    for (let i = 0; i < n; i++) y[i] /= ny;
    mul(y, Av);
    let res = 0;
    for (let i = 0; i < n; i++) res += (Av[i] - value * y[i]) ** 2;
    converged = Math.sqrt(res) <= 1e-13 * Math.max(1, Math.abs(value));
  }
  // The Perron vector is non-negative; fix the arbitrary sign and clear
  // rounding noise on nodes outside the leading components.
  let s = 0;
  for (let i = 0; i < n; i++) s += y[i];
  for (let i = 0; i < n; i++) y[i] = s < 0 ? -y[i] : y[i];
  for (let i = 0; i < n; i++) if (y[i] < 0) y[i] = Math.abs(y[i]);
  return { x: y, converged, iterations };
}

// Largest eigenpair of a small dense symmetric matrix (cyclic Jacobi).
function jacobiTop(A0) {
  const m = A0.length;
  const A = A0.map(r => Float64Array.from(r));
  const V = Array.from({ length: m }, (_, i) => { const r = new Float64Array(m); r[i] = 1; return r; });
  for (let sweep = 0; sweep < 100; sweep++) {
    let off = 0;
    for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) off += A[p][q] * A[p][q];
    if (off < 1e-30) break;
    for (let p = 0; p < m; p++) for (let q = p + 1; q < m; q++) {
      if (Math.abs(A[p][q]) < 1e-300) continue;
      const theta = (A[q][q] - A[p][p]) / (2 * A[p][q]);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < m; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
      for (let k = 0; k < m; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < m; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0;
  for (let i = 1; i < m; i++) if (A[i][i] > A[best][best]) best = i;
  return { value: A[best][best], vector: Float64Array.from(V, r => r[best]) };
}

// PageRank with uniform teleport and uniform redistribution of dangling mass
// (networkx defaults), weighted by tie weight, alpha 0.85.
export function pagerank(g, { alpha = 0.85, tol = 1e-12, maxIter = 1000 } = {}) {
  const { n } = g, { off, adj, w } = g.out;
  if (!n) return { x: new Float64Array(0), converged: true, iterations: 0 };
  const outW = new Float64Array(n);
  for (let v = 0; v < n; v++) { let s = 0; for (let p = off[v]; p < off[v + 1]; p++) s += w[p]; outW[v] = s; }
  let x = new Float64Array(n).fill(1 / n), y = new Float64Array(n);
  for (let it = 1; it <= maxIter; it++) {
    let dangling = 0;
    for (let v = 0; v < n; v++) if (outW[v] === 0) dangling += x[v];
    const base = (alpha * dangling + (1 - alpha)) / n;
    y.fill(base);
    for (let v = 0; v < n; v++) {
      if (outW[v] === 0) continue;
      const share = alpha * x[v] / outW[v];
      for (let p = off[v]; p < off[v + 1]; p++) y[adj[p]] += share * w[p];
    }
    let err = 0;
    for (let v = 0; v < n; v++) err += Math.abs(y[v] - x[v]);
    const t = x; x = y; y = t;
    if (err < n * tol) return { x, converged: true, iterations: it };
  }
  return { x, converged: false, iterations: maxIter };
}

// ---- local structure -----------------------------------------------------------------

// Triangles per node on the symmetrised unweighted graph.
export function triangles(g) {
  const { n } = g, { off, adj } = g.und;
  const mark = new Int32Array(n).fill(-1);
  const tri = new Float64Array(n), clustering = new Float64Array(n), deg = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const d = off[v + 1] - off[v];
    deg[v] = d;
    if (d < 2) continue;
    for (let p = off[v]; p < off[v + 1]; p++) mark[adj[p]] = v;
    let t = 0;
    for (let p = off[v]; p < off[v + 1]; p++) {
      const u = adj[p];
      for (let q = off[u]; q < off[u + 1]; q++) if (mark[adj[q]] === v) t++;
    }
    tri[v] = t / 2;
    clustering[v] = t / (d * (d - 1));
  }
  return { triangles: tri, clustering, deg };
}

// Directed ego density: directed ties among the alters / k(k-1).
function egoDensityDirected(g) {
  const { n } = g, U = g.und, O = g.out;
  const mark = new Int32Array(n).fill(-1);
  const res = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    const k = U.off[v + 1] - U.off[v];
    if (k < 2) { res[v] = NaN; continue; }
    for (let p = U.off[v]; p < U.off[v + 1]; p++) mark[U.adj[p]] = v;
    let t = 0;
    for (let p = U.off[v]; p < U.off[v + 1]; p++) {
      const a = U.adj[p];
      for (let q = O.off[a]; q < O.off[a + 1]; q++) if (mark[O.adj[q]] === v) t++;
    }
    res[v] = t / (k * (k - 1));
  }
  return res;
}

// Batagelj-Zaversnik O(m) k-core decomposition on the symmetrised graph.
export function coreNumber(g) {
  const { n } = g, { off, adj } = g.und;
  const deg = new Int32Array(n);
  let maxD = 0;
  for (let v = 0; v < n; v++) { deg[v] = off[v + 1] - off[v]; if (deg[v] > maxD) maxD = deg[v]; }
  const bin = new Int32Array(maxD + 1);
  for (let v = 0; v < n; v++) bin[deg[v]]++;
  let start = 0;
  for (let d = 0; d <= maxD; d++) { const c = bin[d]; bin[d] = start; start += c; }
  const pos = new Int32Array(n), vert = new Int32Array(n);
  for (let v = 0; v < n; v++) { pos[v] = bin[deg[v]]; vert[pos[v]] = v; bin[deg[v]]++; }
  for (let d = maxD; d > 0; d--) bin[d] = bin[d - 1];
  bin[0] = 0;
  for (let i = 0; i < n; i++) {
    const v = vert[i];
    for (let p = off[v]; p < off[v + 1]; p++) {
      const u = adj[p];
      if (deg[u] > deg[v]) {
        const du = deg[u], pu = pos[u], pw = bin[du], w = vert[pw];
        if (u !== w) { pos[u] = pw; vert[pu] = w; pos[w] = pu; vert[pw] = u; }
        bin[du]++; deg[u]--;
      }
    }
  }
  return Float64Array.from(deg);
}

// Share of a node's ties that are reciprocated: 2 * |in & out| / (|in| + |out|)
// (networkx). NaN for undirected networks and for isolates.
export function nodeReciprocity(g) {
  const { n } = g;
  const r = new Float64Array(n).fill(NaN);
  if (!g.directed) return r;
  const O = g.out, I = g.inn;
  for (let v = 0; v < n; v++) {
    let a = O.off[v], b = I.off[v];
    const ae = O.off[v + 1], be = I.off[v + 1];
    const tot = (ae - a) + (be - b);
    if (!tot) continue;
    let both = 0;
    while (a < ae && b < be) {
      if (O.adj[a] === I.adj[b]) { both++; a++; b++; } else if (O.adj[a] < I.adj[b]) a++; else b++;
    }
    r[v] = (2 * both) / tot;
  }
  return r;
}

// Burt's constraint and effective size with mutual weights, matching networkx
// constraint(G, weight=) and effective_size(G, weight=).
export function burt(g, nodes = null) {
  const { n } = g, { off, adj, w } = g.und;
  const tot = new Float64Array(n), maxw = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    let s = 0, m = 0;
    for (let p = off[v]; p < off[v + 1]; p++) { s += w[p]; if (w[p] > m) m = w[p]; }
    tot[v] = s; maxw[v] = m;
  }
  const constraint = new Float64Array(n).fill(NaN), effectiveSize = new Float64Array(n).fill(NaN);
  const pv = new Float64Array(n);
  const list = nodes || null;
  const count = list ? list.length : n;
  for (let k = 0; k < count; k++) {
    const v = list ? list[k] : k;
    if (off[v + 1] === off[v]) continue;
    for (let p = off[v]; p < off[v + 1]; p++) pv[adj[p]] = w[p] / tot[v];
    let c = 0, es = 0;
    for (let p = off[v]; p < off[v + 1]; p++) {
      const j = adj[p];
      let indirect = 0, red = 0;
      for (let q = off[j]; q < off[j + 1]; q++) {
        const x = adj[q];
        if (x === v || pv[x] === 0) continue;
        indirect += pv[x] * (w[q] / tot[x]);
        red += pv[x] * (w[q] / maxw[j]);
      }
      const lc = pv[j] + indirect;
      c += lc * lc;
      es += 1 - red;
    }
    constraint[v] = c; effectiveSize[v] = es;
    for (let p = off[v]; p < off[v + 1]; p++) pv[adj[p]] = 0;
  }
  return { constraint, effectiveSize };
}

export { components };
