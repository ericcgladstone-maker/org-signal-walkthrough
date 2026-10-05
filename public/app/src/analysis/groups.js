// Group structure for a node attribute, and ego-network measures.
//
// Nodes without a value for the attribute are left out of every group
// statistic (and counted in `coverage`) rather than lumped into a "missing"
// group, which would otherwise look like a real, oddly well-connected team.

import { graphOf } from './graph.js';
import { burt } from './metrics.js';
import { pearson } from './network.js';

// Attribute values per network node: { codes Int32Array (-1 = missing), values[], numeric Float64Array|null }.
export function attrCodes(net, ds, attrKey) {
  const n = net.n;
  const codes = new Int32Array(n).fill(-1);
  const values = [], index = new Map();
  const schema = (ds.attributeSchema || []).find(s => s.key === attrKey);
  const isNumeric = schema ? schema.type === 'numeric' || schema.type === 'ordinal' : false;
  const numeric = isNumeric ? new Float64Array(n).fill(NaN) : null;
  for (let v = 0; v < n; v++) {
    const raw = ds.nodes.attrs[net.nodeIds[v]]?.[attrKey];
    if (raw === undefined || raw === null || raw === '') continue;
    const key = String(raw);
    let c = index.get(key);
    if (c === undefined) { c = values.length; index.set(key, c); values.push(key); }
    codes[v] = c;
    if (numeric) numeric[v] = Number(raw);
  }
  // Stable value order: sorted, so group tables look the same run to run.
  const order = values.map((v, i) => i).sort((a, b) => (isNumeric ? Number(values[a]) - Number(values[b]) : values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0));
  const rank = new Int32Array(values.length);
  order.forEach((old, i) => { rank[old] = i; });
  for (let v = 0; v < n; v++) if (codes[v] >= 0) codes[v] = rank[codes[v]];
  return { codes, values: order.map(i => values[i]), numeric, type: schema?.type ?? 'categorical' };
}

// ---- which attribute to group by ---------------------------------------------------

// Bookkeeping fields: flags an importer or form adds about the record rather
// than the person's place in a group (Responded, Is phone number, Is saved
// contact, Deleted, Admin). They split a network into "has the flag" and
// "doesn't", which is never the comparison anyone came for, so the views
// hide them from grouping menus.
const FLAG_PREFIX = [/^(is|has|was)[_\s-]/i, /^(is|has|was)[A-Z]/];
const BOOKKEEPING_RE = /^(responded|response|completed|finished|consent|deleted|deactivated|admin|owner|bot|is_?bot|verified|invited|invitation|kind|ego|tz|tz_?offset|time_?zone|timezone)$/i;
export function isBookkeepingAttr(a) {
  if (!a) return true;
  if (a.type === 'boolean') return true;
  const label = String(a.label || '').replace(/\s+/g, '_');
  return [a.key, label].some(x => BOOKKEEPING_RE.test(x) || FLAG_PREFIX.some(re => re.test(x)));
}

// Names that say "this is the group someone belongs to", best first.
const GROUP_NAMES = [/^(dept|department)s?$/i, /^(team|squad)s?$/i, /^(group|groups|drawn_?group)$/i, /^(division|unit|org_?unit|section|function|cohort|class|homeroom)$/i,
  /(^|[_\s-])(dept|department)([_\s-]|$)/i, /(^|[_\s-])(team|group|division|unit)([_\s-]|$)/i];

// The attribute a Groups-style view should open on: one with 3 to 15 values
// named like a department, team or group and known for at least half the
// people. Anything else (a 33-value job title, an employer known for one
// person in five, a Responded flag) is a worse default than the communities
// detected in the network, so null means "use communities".
// schema entries: { key, label, type, values[], coverage }.
export function defaultGrouping(ds, { minLevels = 3, maxLevels = 15, minCoverage = 0.5 } = {}) {
  // Groups someone drew by hand are the point of the drawing, even two of them.
  const drawn = (ds.meta?.sources || []).some(s => s.format === 'draw')
    && (ds.attributeSchema || []).find(a => a.key === 'group' && (a.values?.length ?? 0) >= 2);
  if (drawn) return 'group';
  const cands = (ds.attributeSchema || []).filter(a => ['categorical', 'ordinal'].includes(a.type) && !isBookkeepingAttr(a)
    && (a.values?.length ?? 0) >= minLevels && (a.values?.length ?? 0) <= maxLevels && (a.coverage ?? 1) >= minCoverage);
  let best = null, bestRank = Infinity;
  for (const a of cands) {
    const r = GROUP_NAMES.findIndex(re => re.test(a.key) || re.test(String(a.label || '')));
    if (r < 0) continue;
    if (r < bestRank || (r === bestRank && (a.coverage ?? 1) > (best.coverage ?? 1))) { best = a; bestRank = r; }
  }
  return best ? best.key : null;
}

export function groupMetrics(net, ds, attrKey, { maxGroups = 60 } = {}) {
  const A = attrCodes(net, ds, attrKey);
  const g = graphOf(net);
  const { n } = g;
  const k = A.values.length;
  let known = 0;
  for (let v = 0; v < n; v++) if (A.codes[v] >= 0) known++;
  const res = { attr: attrKey, type: A.type, coverage: n ? known / n : 0, nodesWithValue: known, values: A.values };
  if (A.numeric) res.numericAssortativity = numericAssortativity(g, A.numeric);
  if (!k) return { ...res, groups: [], mixing: null, assortativity: NaN, eiIndex: NaN };
  if (k > maxGroups) res.note = `Attribute has ${k} distinct values; group tables are shown only for ${maxGroups} or fewer.`;

  const size = new Float64Array(k);
  for (let v = 0; v < n; v++) if (A.codes[v] >= 0) size[A.codes[v]]++;
  const counts = Array.from({ length: k }, () => new Float64Array(k));
  const weights = Array.from({ length: k }, () => new Float64Array(k));
  const { src, dst, w } = net.edges;
  let I = 0, E = 0, Iw = 0, Ew = 0;
  for (let e = 0; e < net.edges.count; e++) {
    const a = A.codes[src[e]], b = A.codes[dst[e]];
    if (a < 0 || b < 0) continue;
    counts[a][b]++; weights[a][b] += w[e];
    if (!g.directed && a !== b) { counts[b][a]++; weights[b][a] += w[e]; }
    if (a === b) { I++; Iw += w[e]; } else { E++; Ew += w[e]; }
  }
  // Possible ties for density: within n_g(n_g-1) [/2 undirected]; between n_g n_h.
  const possible = (a, b) => (a === b ? (g.directed ? size[a] * (size[a] - 1) : (size[a] * (size[a] - 1)) / 2) : size[a] * size[b]);
  const density = counts.map((row, a) => Array.from(row, (c, b) => (possible(a, b) ? c / possible(a, b) : NaN)));
  const groups = [];
  for (let a = 0; a < k; a++) {
    let ext = 0, extW = 0;
    for (let b = 0; b < k; b++) if (b !== a) {
      ext += counts[a][b] + (g.directed ? counts[b][a] : 0);
      extW += weights[a][b] + (g.directed ? weights[b][a] : 0);
    }
    const internal = counts[a][a], internalW = weights[a][a];
    let outside = 0;
    for (let b = 0; b < k; b++) if (b !== a) outside += size[b];
    const betweenPossible = size[a] * outside * (g.directed ? 2 : 1);
    groups.push({
      value: A.values[a], size: size[a],
      internalTies: internal, externalTies: ext,
      internalWeight: internalW, externalWeight: extW,
      density: density[a][a],
      externalDensity: betweenPossible ? ext / betweenPossible : NaN,
      eiIndex: internal + ext ? (ext - internal) / (ext + internal) : NaN,
    });
  }
  return {
    ...res,
    groups,
    mixing: { values: A.values, counts: counts.map(r => Array.from(r)), weights: weights.map(r => Array.from(r)), density },
    assortativity: mixingAssortativity(edgeMixing(g, A.codes, k, false)),
    assortativityWeighted: mixingAssortativity(edgeMixing(g, A.codes, k, true)),
    eiIndex: I + E ? (E - I) / (E + I) : NaN,
    eiIndexWeighted: Iw + Ew ? (Ew - Iw) / (Ew + Iw) : NaN,
    withinTies: I, betweenTies: E,
  };
}

// Mixing matrix over tie ends: undirected ties counted in both directions, as
// networkx attribute_mixing_matrix does.
export function edgeMixing(g, codes, k, weighted) {
  const M = Array.from({ length: k }, () => new Float64Array(k));
  const O = g.out;
  for (let v = 0; v < g.n; v++) {
    const a = codes[v];
    if (a < 0) continue;
    for (let p = O.off[v]; p < O.off[v + 1]; p++) {
      const b = codes[O.adj[p]];
      if (b < 0) continue;
      M[a][b] += weighted ? O.w[p] : 1;
    }
  }
  return M;
}

// Newman (2003) categorical assortativity: (tr e - sum a_i b_i) / (1 - sum a_i b_i).
export function mixingAssortativity(M) {
  const k = M.length;
  let tot = 0;
  for (const r of M) for (const x of r) tot += x;
  if (!tot) return NaN;
  let tr = 0, ab = 0;
  const a = new Float64Array(k), b = new Float64Array(k);
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) { const x = M[i][j] / tot; a[i] += x; b[j] += x; if (i === j) tr += x; }
  for (let i = 0; i < k; i++) ab += a[i] * b[i];
  return ab === 1 ? NaN : (tr - ab) / (1 - ab);
}

// Pearson correlation of a numeric attribute across tie ends (networkx numeric_assortativity_coefficient).
export function numericAssortativity(g, x) {
  const xs = [], ys = [];
  const O = g.out;
  for (let v = 0; v < g.n; v++) {
    if (!Number.isFinite(x[v])) continue;
    for (let p = O.off[v]; p < O.off[v + 1]; p++) {
      const u = O.adj[p];
      if (Number.isFinite(x[u])) { xs.push(x[v]); ys.push(x[u]); }
    }
  }
  return pearson(xs, ys);
}

// E-I index over ties whose ends both have a value (Krackhardt and Stern 1988).
export function eiIndex(g, codes) {
  let I = 0, E = 0;
  for (let e = 0; e < g.m; e++) {
    const a = codes[g.src[e]], b = codes[g.dst[e]];
    if (a < 0 || b < 0) continue;
    if (a === b) I++; else E++;
  }
  return I + E ? (E - I) / (E + I) : NaN;
}

// ---- ego ------------------------------------------------------------------------

// node: dataset node index. opts.ds + opts.attr add diversity and homophily.
export function egoMetrics(net, node, { ds = null, attr = null } = {}) {
  const v = net.index[node];
  if (v === undefined || v < 0) return { node, inNetwork: false };
  const g = graphOf(net), U = g.und;
  const alters = Array.from(U.adj.subarray(U.off[v], U.off[v + 1]));
  const size = alters.length;
  const mark = new Set(alters);
  let ties = 0;
  const C = g.directed ? g.out : U;
  for (const a of alters) for (let p = C.off[a]; p < C.off[a + 1]; p++) if (mark.has(C.adj[p])) ties++;
  if (!g.directed) ties /= 2;
  const possible = g.directed ? size * (size - 1) : (size * (size - 1)) / 2;
  const b = burt(g, [v]);
  let strength = 0;
  for (let p = U.off[v]; p < U.off[v + 1]; p++) strength += U.w[p];
  const res = {
    node, inNetwork: true, size, strength,
    tiesAmongAlters: ties,
    density: possible ? ties / possible : NaN,
    effectiveSize: b.effectiveSize[v],
    efficiency: size ? b.effectiveSize[v] / size : NaN,
    constraint: b.constraint[v],
    alters: alters.map(a => net.nodeIds[a]),
  };
  if (ds && attr) {
    const A = attrCodes(net, ds, attr);
    const counts = new Map();
    let known = 0, same = 0, sameW = 0, totW = 0;
    const egoVal = A.codes[v];
    for (let p = U.off[v]; p < U.off[v + 1]; p++) {
      const c = A.codes[U.adj[p]];
      if (c < 0) continue;
      known++;
      counts.set(c, (counts.get(c) || 0) + 1);
      totW += U.w[p];
      if (c === egoVal) { same++; sameW += U.w[p]; }
    }
    let blau = 1;
    for (const c of counts.values()) blau -= (c / known) ** 2;
    const K = A.values.length;
    res.attr = attr;
    res.altersWithValue = known;
    res.diversity = known ? blau : NaN;                                  // Blau index
    res.diversityNormalized = known && K > 1 ? blau / (1 - 1 / K) : NaN; // index of qualitative variation
    res.egoValue = egoVal >= 0 ? A.values[egoVal] : null;
    res.homophily = egoVal >= 0 && known ? same / known : NaN;           // share of alters like ego
    res.homophilyWeighted = egoVal >= 0 && totW ? sameW / totW : NaN;
    res.egoEI = egoVal >= 0 && known ? (known - 2 * same) / known : NaN; // (E - I) / (E + I)
    res.composition = [...counts].map(([c, x]) => ({ value: A.values[c], count: x })).sort((p, q) => q.count - p.count);
  }
  return res;
}
