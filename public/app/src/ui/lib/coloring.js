// What the people are colored by, shared by the Network map and the People
// swatches (L6, N21): one choice, one assignment of colors, so Sales is the
// same hue in both views. The choice lives here (not in either view) and is
// reset per dataset to the default grouping.

import { sequentialScale, tokens } from './palette.js';
import { NO_COMMUNITY } from './communities.js';
import { groupColoring } from './grouping.js';
import { orderedValues, defaultGroupAttr, isBookkeeping, preferredAttributes } from './dsutil.js';
import { fmtAttr, humanize } from './format.js';

let choice = { ds: null, value: null };

// The same default as Groups (defaultGroupAttr): a coarse department-like
// attribute, else the communities.
export function defaultColor(ds, communities, attrs, net = null) {
  // Two-mode view: which kind of node each one is comes first.
  if (net?.twoMode?.view === 'two-mode' && net.twoMode.mode) return 'mode';
  const key = defaultGroupAttr(ds, { communities });
  if (key && attrs.some(a => a.key === key)) return `attr:${key}`;
  if (communities) return 'community';
  const plain = attrs.filter(x => !isBookkeeping(x));
  const a = plain.find(x => (x.values?.length ?? 0) <= 8) || plain[0];
  return a ? `attr:${a.key}` : 'none';
}

// net (optional): the current network, so a two-mode view starts colored by
// mode and a choice of 'mode' falls back once the view has one mode only.
export function getColorBy(ds, communities, attrs, net = null) {
  const modeGone = choice.value === 'mode' && !(net?.twoMode?.view === 'two-mode' && net.twoMode.mode);
  const modeNew = net?.twoMode?.view === 'two-mode' && choice.view !== 'two-mode';
  if (choice.ds !== ds || choice.value == null || modeGone || modeNew) choice = { ds, value: defaultColor(ds, communities, attrs, net) };
  choice.view = net?.twoMode?.view ?? null;
  return choice.value;
}

export function setColorBy(ds, value) { choice = { ...choice, ds, value }; }

// Coloring over network indices (0..net.n-1).
//   { kind: 'cat' | 'seq' | 'none', gc, of(v), key(v), title, community, scale, metric }
// label(k) names a measure for the sequential case.
export function nodeColoring({ ds, net, communities, colorBy, attrs = [], nodeMetrics = null, label = k => k }) {
  const t = tokens();
  const dsOf = v => (net.nodeIds ? net.nodeIds[v] : v);
  if (colorBy === 'mode' && net?.twoMode?.mode) {
    // Two-mode networks: the two kinds of node (women and events), named.
    const tm = net.twoMode;
    const counts = [0, 0];
    for (let v = 0; v < net.n; v++) counts[tm.mode[v]]++;
    const gc = groupColoring([0, 1].map(m => ({ value: String(m), label: tm.labels[m], count: counts[m] })));
    const key = v => String(tm.mode[v]);
    return { kind: 'cat', mode: true, gc, of: v => gc.color(key(v)), key, title: 'Kind of node (two-mode)', short: 'kind of node', labels: tm.labels };
  }
  if (colorBy === 'community' && communities?.membership) {
    const gc = communityColoring(ds, net, communities);
    const sizes = communitySizes(communities);
    const key = v => (sizes[communities.membership[v]] <= 1 ? '' : String(communities.membership[v]));
    return { kind: 'cat', community: true, gc, of: v => gc.color(key(v)), key, title: 'Community (found by Louvain)', short: 'community' };
  }
  if (colorBy?.startsWith('attr:')) {
    const key = colorBy.slice(5);
    const ov = orderedValues(ds, key);
    const a = attrs.find(x => x.key === key);
    // Color order comes from the whole dataset (so colors never shift); the
    // counts shown are the people actually in this network, so an excluded
    // bot or filtered-out person is not listed as "Not recorded".
    const inNet = new Map();
    let missing = 0;
    for (let v = 0; v < net.n; v++) {
      const x = ds.nodes.attrs[dsOf(v)]?.[key];
      if (x == null || x === '') missing++; else inNet.set(String(x), (inNet.get(String(x)) || 0) + 1);
    }
    const gc = groupColoring(ov.map(o => ({ value: o.value, label: fmtAttr(key, o.value), count: inNet.get(String(o.value)) || 0 })), { missing });
    const keyOf = v => { const x = ds.nodes.attrs[dsOf(v)]?.[key]; return x == null || x === '' ? '' : String(x); };
    const title = a?.label || humanize(key);
    return { kind: 'cat', gc, of: v => gc.color(keyOf(v)), key: keyOf, title, short: title.toLowerCase() };
  }
  if (colorBy?.startsWith('metric:')) {
    const m = colorBy.slice(7);
    const arr = nodeMetrics?.[m];
    if (!arr) return { kind: 'none', of: () => t.node, title: null };
    const fin = Array.from(arr).filter(Number.isFinite);
    const sc = sequentialScale(Math.min(...fin), Math.max(...fin));
    return { kind: 'seq', of: v => sc(arr[v]), scale: sc, title: label(m), short: label(m).toLowerCase(), metric: m };
  }
  return { kind: 'none', of: () => t.node, title: null };
}

// ---- communities in the attribute's colors (M5) -----------------------------------

function communitySizes(communities) {
  const k = communities.count ?? 0;
  return communities.sizes || Array.from({ length: k }, (_, i) => communities.membership.filter(m => m === i).length);
}

// Communities are numbered by Louvain, a numbering unrelated to any
// attribute, so by number alone Community 1 can take the hue a department or
// faction has when the map is colored by that attribute, with the opposite
// meaning (green for John A.'s community and for Mr. Hi's faction, M5).
// Instead each community whose members are mostly one value of an attribute
// takes that value's hue, largest community first, one community per value;
// the rest take hues no value uses. The attribute is the groupable one (2 to
// 8 values, not bookkeeping) under which most people sit in a community
// colored like their own value; ties go to the default grouping, then the
// order Groups lists attributes in. With no such match within the eight
// hues, communities keep the colors of their numbers. Same function for
// Network, People and Groups; gc.alignedTo names the attribute.
function matchCommunities(ds, net, communities, list, sizes, attr, t) {
  const values = orderedValues(ds, attr);
  if (values.length > 8) return null;
  const valueHue = new Map(values.map((o, i) => [o.value, t.cat[i]]));
  const tally = new Map(list.map(c => [c, new Map()]));
  for (let v = 0; v < net.n; v++) {
    const m = tally.get(communities.membership[v]);
    const x = ds.nodes.attrs[net.nodeIds ? net.nodeIds[v] : v]?.[attr];
    if (!m || x == null || x === '') continue;
    m.set(String(x), (m.get(String(x)) || 0) + 1);
  }
  const color = new Map(), claimed = new Set();
  let covered = 0;
  for (const c of [...list].sort((a, b) => sizes[b] - sizes[a] || a - b)) {
    let best = null, bn = 0;
    for (const [x, k] of tally.get(c)) if (k > bn || (k === bn && best != null && x < best)) { best = x; bn = k; }
    if (best != null && bn * 2 > sizes[c] && valueHue.has(best) && !claimed.has(best)) { claimed.add(best); color.set(c, valueHue.get(best)); covered += bn; }
  }
  if (!color.size) return null;
  const used = new Set(valueHue.values());
  const spare = t.cat.filter(h => !used.has(h));
  const rest = list.filter(c => !color.has(c));
  if (rest.length > spare.length) return null;
  rest.forEach((c, i) => color.set(c, spare[i]));
  return { color, covered };
}

export function communityColoring(ds, net, communities) {
  const t = tokens();
  const sizes = communitySizes(communities);
  const list = sizes.map((_, c) => c).filter(c => sizes[c] > 1);
  const missing = sizes.filter(x => x <= 1).reduce((a, x) => a + x, 0);
  let best = null;
  if (ds && net && !net.twoMode && list.length <= 8) {
    const def = defaultGroupAttr(ds);
    const cands = preferredAttributes(ds).filter(a => !isBookkeeping(a) && a.key !== 'planted_group' && (a.values?.length ?? 0) >= 2 && (a.values?.length ?? 0) <= 8);
    cands.sort((a, b) => (b.key === def) - (a.key === def));
    for (const a of cands) {
      const m = matchCommunities(ds, net, communities, list, sizes, a.key, t);
      if (m && (!best || m.covered > best.m.covered)) best = { a, m };
    }
  }
  const gc = groupColoring(list.map(c => ({ value: String(c), label: `Community ${c + 1}`, count: sizes[c], color: best?.m.color.get(c) })), { missing });
  gc.missingLabel = NO_COMMUNITY;
  gc.alignedTo = best ? best.a.key : null;
  gc.alignedLabel = best ? (best.a.label || humanize(best.a.key)).toLowerCase() : null;
  return gc;
}
