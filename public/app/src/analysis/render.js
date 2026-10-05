// Node and edge arrays for the WebGL renderer, with an optional ForceAtlas2
// layout. Positions are deterministic: the starting layout comes from a seeded
// RNG (or from earlier positions of the same people, so rebuilding the network
// with different rules moves the picture as little as possible), and
// ForceAtlas2 runs a fixed number of iterations.

import { Graph, forceAtlas2 } from '../../vendor/graphology.js';
import { graphOf } from './graph.js';
import { createRng } from './rng.js';

// opts: { maxNodes = 3000, maxEdges = 30000, layout = true, iterations = 150, seed = 1,
//         previous: Map(datasetNode -> [x, y]), labels: ds.nodes.labels,
//         arrange: 'force' | 'columns' | 'rows' (two-mode networks: each mode in
//                  its own column or row, ordered to reduce crossings) }
// Two-mode networks add nodes.mode (0 / 1 per render node) and modeLabels.
// Returns { directed, nodes: { count, ids, netIndex, strength, labels, x, y },
//   edges: { count, src, dst (render indices), w, layerMask, byRule }, truncated,
//   and flat aliases nodeIds, x, y, src, dst, w, byRule, layerMask }.
export function graphForRender(net, opts = {}) {
  const g = graphOf(net);
  const { n } = g;
  const maxNodes = opts.maxNodes ?? 3000, maxEdges = opts.maxEdges ?? 30000;
  // Keep the strongest people when the network is larger than the renderer budget.
  const strength = new Float64Array(n);
  for (let e = 0; e < net.edges.count; e++) { strength[net.edges.src[e]] += net.edges.w[e]; strength[net.edges.dst[e]] += net.edges.w[e]; }
  let keep = Array.from({ length: n }, (_, i) => i);
  if (n > maxNodes) keep = keep.sort((a, b) => strength[b] - strength[a] || a - b).slice(0, maxNodes).sort((a, b) => a - b);
  const pos = new Int32Array(n).fill(-1);
  keep.forEach((v, i) => { pos[v] = i; });
  let edges = [];
  for (let e = 0; e < net.edges.count; e++) {
    const a = pos[net.edges.src[e]], b = pos[net.edges.dst[e]];
    if (a >= 0 && b >= 0) edges.push(e);
  }
  const edgeTotal = edges.length;
  if (edges.length > maxEdges) edges = edges.sort((x, y) => net.edges.w[y] - net.edges.w[x] || x - y).slice(0, maxEdges).sort((x, y) => x - y);
  const K = keep.length;
  const out = {
    directed: net.directed,
    nodes: {
      count: K,
      ids: Int32Array.from(keep, v => net.nodeIds[v]),
      netIndex: Int32Array.from(keep),
      strength: Float32Array.from(keep, v => strength[v]),
      labels: opts.labels ? keep.map(v => opts.labels[net.nodeIds[v]]) : null,
      x: null, y: null,
    },
    edges: {
      count: edges.length,
      src: Int32Array.from(edges, e => pos[net.edges.src[e]]),
      dst: Int32Array.from(edges, e => pos[net.edges.dst[e]]),
      w: Float32Array.from(edges, e => net.edges.w[e]),
    },
    truncated: { nodes: n - K, edges: edgeTotal - edges.length },
  };
  // Per-edge evidence for colouring by rule or layer.
  out.edges.layerMask = Uint8Array.from(edges, e => net.edges.layerMask[e]);
  out.edges.byRule = Object.fromEntries(Object.entries(net.edges.byRule || {}).map(([r, a]) => [r, Float32Array.from(edges, e => a[e])]));
  if (net.twoMode?.mode) {
    out.nodes.mode = Uint8Array.from(keep, v => net.twoMode.mode[v]);
    out.modeLabels = net.twoMode.labels;
    out.twoModeView = net.twoMode.view;
  }
  const arrange = out.nodes.mode && out.twoModeView === 'two-mode' && (opts.arrange === 'columns' || opts.arrange === 'rows') ? opts.arrange : null;
  if (arrange && opts.layout !== false) {
    const xy = twoModeLayout(out, arrange);
    out.nodes.x = xy.x; out.nodes.y = xy.y;
  } else if (opts.layout !== false) {
    const xy = layout(out, opts);
    out.nodes.x = xy.x; out.nodes.y = xy.y;
  }
  // Flat aliases (same arrays, no copy) for renderers that want parallel
  // arrays at the top level (src/ui/services/engine.js normaliseRender).
  Object.assign(out, { nodeIds: out.nodes.ids, x: out.nodes.x, y: out.nodes.y, src: out.edges.src, dst: out.edges.dst, w: out.edges.w, byRule: out.edges.byRule, layerMask: out.edges.layerMask });
  return out;
}

function layout(r, opts) {
  const rng = createRng(opts.seed ?? 1);
  const prev = opts.previous || null;
  const G = new Graph({ type: 'undirected', multi: false, allowSelfLoops: false });
  const K = r.nodes.count;
  const R = Math.sqrt(K) * 10;
  for (let i = 0; i < K; i++) {
    const p = prev?.get(r.nodes.ids[i]);
    G.addNode(i, p ? { x: p[0], y: p[1] } : { x: (rng() - 0.5) * R, y: (rng() - 0.5) * R });
  }
  for (let e = 0; e < r.edges.count; e++) {
    const a = r.edges.src[e], b = r.edges.dst[e];
    if (G.hasEdge(a, b)) G.updateEdgeAttribute(a, b, 'weight', w => w + r.edges.w[e]);
    else G.addEdge(a, b, { weight: r.edges.w[e] });
  }
  if (r.edges.count) {
    const settings = { ...forceAtlas2.inferSettings(G), barnesHutOptimize: K > 1000, edgeWeightInfluence: 1 };
    forceAtlas2.assign(G, { iterations: opts.iterations ?? 150, settings, getEdgeWeight: 'weight' });
  }
  const x = new Float32Array(K), y = new Float32Array(K);
  G.forEachNode((key, a) => { x[+key] = a.x; y[+key] = a.y; });
  return { x, y };
}

// Two columns (or rows): mode 0 on one side, mode 1 on the other. The order
// within each side comes from a few barycenter sweeps (Sugiyama-style), which
// pulls each node toward the average position of its ties so lines cross
// less. Deterministic: starting order is network order, ties keep it.
function twoModeLayout(r, arrange) {
  const K = r.nodes.count, mode = r.nodes.mode;
  const nb = Array.from({ length: K }, () => []);
  for (let e = 0; e < r.edges.count; e++) { nb[r.edges.src[e]].push(r.edges.dst[e]); nb[r.edges.dst[e]].push(r.edges.src[e]); }
  const sides = [[], []];
  for (let i = 0; i < K; i++) sides[mode[i]].push(i);
  const pos = new Float64Array(K);
  const place = (side) => side.forEach((v, k) => { pos[v] = side.length > 1 ? k / (side.length - 1) : 0.5; });
  place(sides[0]); place(sides[1]);
  for (let sweep = 0; sweep < 8; sweep++) {
    const side = sides[sweep % 2 === 0 ? 1 : 0];
    const bary = new Map(side.map(v => [v, nb[v].length ? nb[v].reduce((s, u) => s + pos[u], 0) / nb[v].length : pos[v]]));
    side.sort((a, b) => bary.get(a) - bary.get(b) || pos[a] - pos[b] || a - b);
    place(side);
  }
  // Spread: about 12 units between neighbours on the longer side, and the
  // two sides 0.6 x that length apart (at least 60) so labels fit.
  const len = Math.max(1, Math.max(sides[0].length, sides[1].length) - 1) * 12;
  const gap = Math.max(60, len * 0.6);
  const x = new Float32Array(K), y = new Float32Array(K);
  for (let i = 0; i < K; i++) {
    const along = (pos[i] - 0.5) * len, across = mode[i] === 0 ? -gap / 2 : gap / 2;
    if (arrange === 'columns') { x[i] = across; y[i] = -along; } else { x[i] = along; y[i] = -across; }
  }
  return { x, y };
}
