// Communities: Louvain (graphology) on the symmetrised weighted graph, seeded,
// with community ids renumbered by first appearance so the same seed always
// yields the same labels. Modularity is recomputed here (Newman 2004, with
// resolution) rather than taken from Louvain so it is defined identically for
// any partition the UI or the null model hands in.

import { UndirectedGraph, louvain } from '../../vendor/graphology.js';
import { graphOf } from './graph.js';
import { createRng } from './rng.js';
import { isTwoModeView, projectNetwork, barberModularity } from './twomode.js';

export function detectCommunities(net, opts = {}) {
  if (isTwoModeView(net) && opts.twoMode !== 'bipartite') return twoModeCommunities(net, opts);
  return louvainCommunities(net, opts);
}

function louvainCommunities(net, { resolution = 1, seed = 1 } = {}) {
  const g = graphOf(net);
  const { n } = g, U = g.und;
  const G = new UndirectedGraph();
  for (let v = 0; v < n; v++) G.addNode(v);
  for (let v = 0; v < n; v++) for (let p = U.off[v]; p < U.off[v + 1]; p++) {
    const u = U.adj[p];
    if (u > v) G.addEdge(v, u, { weight: U.w[p] });
  }
  const membership = new Int32Array(n);
  if (G.size === 0) {
    for (let v = 0; v < n; v++) membership[v] = v;
  } else {
    const res = louvain.detailed(G, { resolution, rng: createRng(seed), getEdgeWeight: 'weight' });
    const remap = new Map();
    for (let v = 0; v < n; v++) {
      const c = res.communities[v];
      if (!remap.has(c)) remap.set(c, remap.size);
      membership[v] = remap.get(c);
    }
  }
  const count = Math.max(-1, ...membership) + 1;
  const sizes = new Int32Array(count);
  for (let v = 0; v < n; v++) sizes[membership[v]]++;
  let nontrivial = 0;
  for (const s of sizes) if (s > 1) nontrivial++;
  return { membership, modularity: modularity(g, membership, resolution), count, nontrivial, sizes: Array.from(sizes), resolution, seed };
}

// Q = sum_c [ W_c / W - resolution * (S_c / 2W)^2 ] on the symmetrised weighted
// graph, W = total tie weight, W_c = weight inside c, S_c = total strength in c.
export function modularity(g, membership, resolution = 1) {
  const { n } = g, U = g.und;
  let W = 0;
  const inside = new Map(), strength = new Map();
  for (let v = 0; v < n; v++) {
    const cv = membership[v];
    for (let p = U.off[v]; p < U.off[v + 1]; p++) {
      const u = U.adj[p], x = U.w[p];
      strength.set(cv, (strength.get(cv) || 0) + x);
      if (u > v) { W += x; if (membership[u] === cv) inside.set(cv, (inside.get(cv) || 0) + x); }
    }
  }
  if (!W) return NaN;
  let Q = 0;
  for (const [c, s] of strength) Q += (inside.get(c) || 0) / W - resolution * (s / (2 * W)) ** 2;
  return Q;
}

// Two-mode network: Louvain runs on the actors' projection (mode 0, weight =
// shared affiliations), the usual practice for affiliation data (Borgatti and
// Halgin 2011); each event then joins the community holding most of its
// members (ties: the lower community id), and events nobody shares stay
// alone. `modularity` is the projection's (Newman), `barberModularity` the
// bipartite modularity (Barber 2007) of the joint partition. With
// opts.twoMode === 'bipartite' Louvain runs on the two-mode ties directly.
function twoModeCommunities(net, { resolution = 1, seed = 1 } = {}) {
  const n = net.n, mode = net.twoMode.mode;
  const { net: proj, members } = projectNetwork(net, 0, 'count');
  const pc = louvainCommunities(proj, { resolution, seed });
  const raw = new Int32Array(n).fill(-1);
  members.forEach((v, i) => { raw[v] = pc.membership[i]; });
  const g = graphOf(net);
  const { off, adj } = g.und;
  let next = pc.count;
  for (let y = 0; y < n; y++) {
    if (mode[y] === 0) continue;
    const tally = new Map();
    for (let p = off[y]; p < off[y + 1]; p++) { const c = raw[adj[p]]; if (c >= 0) tally.set(c, (tally.get(c) || 0) + 1); }
    let best = -1, bestN = 0;
    for (const [c, k] of tally) if (k > bestN || (k === bestN && c < best)) { best = c; bestN = k; }
    raw[y] = best >= 0 ? best : next++;
  }
  // Renumber by first member in network order, as one-mode communities.
  const remap = new Map();
  const membership = new Int32Array(n);
  for (let v = 0; v < n; v++) { if (!remap.has(raw[v])) remap.set(raw[v], remap.size); membership[v] = remap.get(raw[v]); }
  const count = remap.size;
  const sizes = new Int32Array(count);
  for (let v = 0; v < n; v++) sizes[membership[v]]++;
  let nontrivial = 0;
  for (const s of sizes) if (s > 1) nontrivial++;
  return { membership, modularity: pc.modularity, barberModularity: barberModularity(net, membership), count, nontrivial, sizes: Array.from(sizes), resolution, seed,
    method: 'two-mode: Louvain on the mode-0 projection (shared affiliations), mode-1 nodes join their members\' most common community' };
}

export { graphOf };
