// Compressed sparse row (CSR) adjacency for the algorithms.
//
// A Network stores its ties as an edge list (src, dst, w). Every algorithm
// instead wants "the neighbours of v" fast, so we build three CSR views once
// per network and cache them:
//
//   out  successors with weight   (undirected: every neighbour, both directions)
//   inn  predecessors with weight (undirected: same arrays as out)
//   und  the symmetrised graph: an undirected tie wherever either direction
//        exists, weight = w(a->b) + w(b->a) for directed networks, w for
//        undirected ones; dirs = how many directions exist (1 or 2).
//
// Symmetrised views are what clustering, k-cores, eigenvector, Burt's
// measures and Louvain use (see docs/api/analysis.md for why each choice).

const cache = new WeakMap();

// Graph from a Network (cached) or from raw arrays (null-model replicates).
export function graphOf(net) {
  let g = cache.get(net);
  if (!g) {
    g = makeGraph(net.n, net.edges.src, net.edges.dst, net.edges.w, net.directed, net.edges.count);
    cache.set(net, g);
  }
  return g;
}

export function makeGraph(n, src, dst, w, directed, m = src.length) {
  const out = directed ? csr(n, src, dst, w, m, false, false) : csr(n, src, dst, w, m, true, false);
  const inn = directed ? csr(n, dst, src, w, m, false, false) : out;
  const und = directed ? symmetrise(n, src, dst, w, m) : { ...out, dirs: null };
  return { n, m, directed, out, inn, und, src, dst, w };
}

// Counting-sort CSR. both=true writes each edge in both directions.
function csr(n, src, dst, w, m, both, _unused) {
  const off = new Int32Array(n + 1);
  for (let e = 0; e < m; e++) { off[src[e] + 1]++; if (both) off[dst[e] + 1]++; }
  for (let i = 0; i < n; i++) off[i + 1] += off[i];
  const len = off[n];
  const adj = new Int32Array(len), wt = new Float64Array(len), eid = new Int32Array(len);
  const pos = off.slice(0, n);
  for (let e = 0; e < m; e++) {
    const a = src[e], b = dst[e], x = w ? w[e] : 1;
    let p = pos[a]++; adj[p] = b; wt[p] = x; eid[p] = e;
    if (both) { p = pos[b]++; adj[p] = a; wt[p] = x; eid[p] = e; }
  }
  sortRows(off, adj, wt, eid, n);
  return { off, adj, w: wt, eid };
}

// Rows sorted by neighbour index: needed for merge-style intersections and so
// that iteration order (and therefore every floating-point sum) is canonical.
function sortRows(off, adj, wt, eid, n) {
  for (let v = 0; v < n; v++) {
    const a = off[v], b = off[v + 1];
    if (b - a < 2) continue;
    let sorted = true;
    for (let p = a + 1; p < b; p++) if (adj[p - 1] > adj[p]) { sorted = false; break; }
    if (sorted) continue;
    const idx = [];
    for (let p = a; p < b; p++) idx.push(p);
    idx.sort((x, y) => adj[x] - adj[y]);
    const A = idx.map(p => adj[p]), W = idx.map(p => wt[p]), E = idx.map(p => eid[p]);
    for (let k = 0; k < A.length; k++) { adj[a + k] = A[k]; wt[a + k] = W[k]; eid[a + k] = E[k]; }
  }
}

function symmetrise(n, src, dst, w, m) {
  // Merge a->b and b->a into one undirected tie.
  const key = new Map();
  const ua = [], ub = [], uw = [], ud = [];
  for (let e = 0; e < m; e++) {
    const a = src[e], b = dst[e];
    const lo = a < b ? a : b, hi = a < b ? b : a;
    const k = lo * n + hi;
    const x = w ? w[e] : 1;
    const i = key.get(k);
    if (i === undefined) { key.set(k, ua.length); ua.push(lo); ub.push(hi); uw.push(x); ud.push(1); }
    else { uw[i] += x; ud[i]++; }
  }
  const M = ua.length;
  const g = csr(n, Int32Array.from(ua), Int32Array.from(ub), Float64Array.from(uw), M, true, false);
  const dirs = new Uint8Array(g.adj.length);
  for (let p = 0; p < g.adj.length; p++) dirs[p] = ud[g.eid[p]];
  return { ...g, dirs, m: M };
}

// Number of undirected ties (each counted once).
export function undEdgeCount(g) { return g.directed ? g.und.m : g.m; }

// Weakly connected components on the symmetrised graph.
export function components(g) {
  const { n } = g, { off, adj } = g.und;
  const comp = new Int32Array(n).fill(-1);
  const sizes = [];
  const stack = new Int32Array(n);
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0) continue;
    const c = sizes.length;
    let top = 0, size = 0;
    stack[top++] = s; comp[s] = c;
    while (top) {
      const v = stack[--top]; size++;
      for (let p = off[v]; p < off[v + 1]; p++) {
        const u = adj[p];
        if (comp[u] < 0) { comp[u] = c; stack[top++] = u; }
      }
    }
    sizes.push(size);
  }
  return { comp, sizes, count: sizes.length };
}

// Strongly connected components (iterative Tarjan) for directed graphs.
export function strongComponents(g) {
  const { n } = g, { off, adj } = g.out;
  const index = new Int32Array(n).fill(-1), low = new Int32Array(n), onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [], call = [], it = new Int32Array(n);
  let idx = 0, count = 0;
  for (let s = 0; s < n; s++) {
    if (index[s] >= 0) continue;
    call.push(s); index[s] = low[s] = idx++; stack.push(s); onStack[s] = 1; it[s] = off[s];
    while (call.length) {
      const v = call[call.length - 1];
      if (it[v] < off[v + 1]) {
        const u = adj[it[v]++];
        if (index[u] < 0) { index[u] = low[u] = idx++; stack.push(u); onStack[u] = 1; it[u] = off[u]; call.push(u); }
        else if (onStack[u] && index[u] < low[v]) low[v] = index[u];
      } else {
        call.pop();
        if (call.length) { const p = call[call.length - 1]; if (low[v] < low[p]) low[p] = low[v]; }
        if (low[v] === index[v]) {
          let u;
          do { u = stack.pop(); onStack[u] = 0; comp[u] = count; } while (u !== v);
          count++;
        }
      }
    }
  }
  return { comp, count };
}
