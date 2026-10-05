// Small derivations over the engine's node metrics that the Network and
// People views share: distinct contacts, ranks that admit ties, and the
// labels a measure takes on a directed network.

import { gloss } from '../services/glossary.js';
import { fmtInt, columnFormat } from './format.js';

// Distinct people tied to each person, in either direction.
//
// The engine's degree on a directed network is in + out (networkx), so a
// two-way tie counts twice. Node reciprocity is 2|in AND out| / (in + out),
// which gives the overlap exactly: contacts = degree - reciprocity * degree / 2.
// On an undirected network degree already counts each neighbor once.
export function contactsOf(node, directed) {
  const deg = node?.degree;
  if (!deg) return null;
  const out = new Float64Array(deg.length);
  const rec = node.reciprocity;
  for (let v = 0; v < deg.length; v++) {
    const d = deg[v];
    if (!Number.isFinite(d)) { out[v] = NaN; continue; }
    const r = directed && rec && Number.isFinite(rec[v]) ? rec[v] : 0;
    out[v] = Math.round(d - (r * d) / 2);
  }
  return out;
}

// The node metric map with `contacts` added in front, computed once per
// metrics object.
const withCache = new WeakMap();
export function withContacts(node, directed) {
  if (!node) return node;
  const hit = withCache.get(node);
  if (hit && hit.directed === directed) return hit.value;
  const contacts = contactsOf(node, directed);
  const value = contacts ? { contacts, ...node } : node;
  withCache.set(node, { directed, value });
  return value;
}

// Measure label for display (decision 4: never a bare "Degree"). On an
// undirected network degree is the number of contacts, so both read
// "Contacts (degree)"; on a directed one degree is ties in plus ties out,
// which is not a head count, and says so. Closeness and betweenness carry
// the variant the engine computes.
export function metricLabel(key, directed) {
  if (key === 'contacts') return directed ? 'Contacts' : 'Contacts (degree)';
  if (key === 'degree') return directed ? 'Total ties (in + out)' : 'Contacts (degree)';
  if (key === 'closeness') return 'Closeness (harmonic)';
  if (key === 'betweenness') return 'Betweenness (normalized)';
  return gloss(key).label;
}

// The measures worth listing for this network: on an undirected network
// degree is the same column as contacts, so it is left out.
export function distinctMeasures(keys, directed) {
  return directed ? keys : keys.filter(k => k !== 'degree');
}

// Pairs a betweenness value is a share of: (n-1)(n-2) ordered pairs on a
// directed network, half that on an undirected one. raw = value * pairs.
export function betweennessPairs(n, directed) {
  if (!(n > 2)) return 0;
  return directed ? (n - 1) * (n - 2) : ((n - 1) * (n - 2)) / 2;
}

// How each measure is computed, in plain words, with the numbers of this
// network where they help (A2: hand values against the app's). Shown under
// the measure's meaning in tooltips and the profile. Null when the glossary
// meaning says enough.
export function measureNote(key, { n = 0, directed = false, twoMode = null } = {}) {
  const tm = twoMode?.labels ? twoMode : null;
  const [a, b] = tm ? tm.labels.map(x => String(x).toLowerCase()) : ['actors', 'events'];
  const cnt = tm?.counts;
  if (key === 'twoModeDegree') return `Ties divided by the number of nodes of the other kind: for one of the ${a}, the share of the ${cnt ? `${cnt[1]} ` : ''}${b} tied to them; for one of the ${b}, the share of the ${cnt ? `${cnt[0]} ` : ''}${a}.`;
  if (key === 'twoModeBetweenness') return `Shortest routes through this node (each pair once), divided by the most a node of its kind can have given how many ${a} and ${b} there are (Borgatti and Everett 1997). 1 = the most possible for its kind.`;
  if (key === 'twoModeCloseness') return `The fewest total steps possible for its kind (1 to each node of the other kind, 2 to each of its own) divided by its actual total; scaled down by the share it can reach when the network is in pieces. 1 = as close as possible.`;
  if (key === 'twoModeClustering') return `For each node two steps away (same kind), the overlap of their ties: shared / either (Latapy et al. 2008); averaged. 0 = shares nothing with anyone, 1 = identical ties.`;
  if (key === 'closeness') {
    return 'Harmonic closeness: for each other person take 1 / (steps to reach them), add these up and divide by n - 1. A neighbor counts 1, two steps 1/2, three steps 1/3, someone unreachable 0. '
      + 'The textbook closeness is (n - 1) / (sum of steps); it gives lower numbers (the end of a 6-person path: 0.333 textbook, 0.457 harmonic) and breaks when someone cannot be reached.';
  }
  if (key === 'betweenness') {
    const pairs = betweennessPairs(n, directed);
    return `Normalized: the share of ${directed ? 'ordered ' : ''}pairs of other people whose shortest routes pass through this person (split evenly when there are several shortest routes), from 0 to 1. `
      + (pairs ? `The raw count is this value times ${fmtInt(pairs)}, the number of such pairs here (${directed ? '(n - 1)(n - 2)' : '(n - 1)(n - 2) / 2'} with n = ${fmtInt(n)}).` : '');
  }
  if (key === 'contacts' || (key === 'degree' && !directed)) {
    return directed ? 'Distinct people tied to this person in either direction; a two-way tie counts once. Total ties (in + out) counts it twice.' : 'Degree: the number of people tied to this person.';
  }
  if (key === 'degree') return 'Ties in plus ties out, so a two-way tie counts twice. Contacts counts each person once.';
  return null;
}

// Measures on a 0-1 scale (or close to it): always three decimals.
export const UNIT_MEASURES = new Set(['betweenness', 'betweennessWeighted', 'closeness', 'closenessWeighted', 'pagerank', 'eigenvector', 'clustering', 'reciprocity', 'constraint', 'egoDensity', 'twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering']);

export function measureFormat(key, values) {
  return columnFormat(values, UNIT_MEASURES.has(key) ? { digits: 3 } : {});
}

// People in rank order whose values cannot be told apart at the precision
// shown. order: network indices sorted high to low; fmt: the column format.
// Returns [{ from, to, text }] with 0-based positions in `order` for every
// run of two or more equal displayed values.
export function displayTies(order, values, fmt) {
  const out = [];
  let i = 0;
  while (i < order.length) {
    const t = fmt(values[order[i]]);
    let j = i + 1;
    while (j < order.length && fmt(values[order[j]]) === t) j++;
    if (j - i > 1 && t !== '–') out.push({ from: i, to: j - 1, text: t });
    i = j;
  }
  return out;
}

// "Who stands out": for each measure, the people at the top at displayed
// precision and the next value down. node: metric map (network order).
export function standouts(node, keys, { fmtFor = (k, arr) => measureFormat(k, arr), limit = 3 } = {}) {
  const out = [];
  for (const k of keys) {
    const arr = node?.[k];
    if (!arr) continue;
    const fmt = fmtFor(k, arr);
    const order = Array.from(arr.keys()).filter(v => Number.isFinite(arr[v])).sort((a, b) => arr[b] - arr[a] || a - b);
    if (!order.length) continue;
    const topText = fmt(arr[order[0]]);
    let j = 0;
    while (j < order.length && fmt(arr[order[j]]) === topText) j++;
    if (j === order.length && order.length > 1) { out.push({ key: k, top: [], value: topText, allSame: true }); continue; }
    out.push({ key: k, top: order.slice(0, Math.min(j, limit)), tied: j, value: topText, next: j < order.length ? { v: order[j], value: fmt(arr[order[j]]) } : null });
  }
  return out;
}

// Competition rank (1 = highest) with ties made visible.
// Returns { rank, last, n, tied } where rank..last is the span of positions
// people with this value share, or null when the value is undefined.
export function rankInfo(arr, v) {
  const x = arr?.[v];
  if (!Number.isFinite(x)) return null;
  let above = 0, same = 0, n = 0;
  for (let j = 0; j < arr.length; j++) {
    const y = arr[j];
    if (!Number.isFinite(y)) continue;
    n++;
    if (y > x) above++; else if (y === x) same++;
  }
  return { rank: above + 1, last: above + same, n, tied: same - 1 };
}

export function fmtRank(info) {
  if (!info) return 'not defined for this person';
  const { rank, last, n, tied } = info;
  if (tied <= 0) return `rank ${fmtInt(rank)} of ${fmtInt(n)}`;
  if (tied + 1 === n) return `same value for all ${fmtInt(n)} people`;
  return `rank ${fmtInt(rank)} to ${fmtInt(last)} of ${fmtInt(n)} (shared by ${fmtInt(tied + 1)} people)`;
}

// Measures the engine can resample for rank intervals.
export const RESAMPLABLE = ['degree', 'strength', 'betweenness', 'closeness', 'pagerank', 'eigenvector', 'constraint'];

// Node keys that are generated ids rather than something the user knows
// (a drawn node's "draw:n987846954f"); views show the key only otherwise.
export function displayKey(key) {
  const k = String(key ?? '');
  if (/^(draw|alter|ego|roster|paste|cs):/i.test(k)) return null;
  return k;
}

// Departed or deactivated accounts, as importers record them.
export function isDeactivated(ds, i) {
  const a = ds?.nodes?.attrs?.[i];
  return !!(a && (a.deactivated === true || a.deactivated === 'true'));
}

// Monthly values for one person. Months the data covers only in part (the
// first and last month of an export) are dropped: a month that is 9% covered
// shows a fall to zero that never happened. The value label is the latest
// month with a value.
export function sparkSeries(data, i, keys = ['degree', 'strength', 'betweenness']) {
  const keep = (data.windows || []).map((w, k) => ({ w, k })).filter(({ w }) => !(Number.isFinite(w.coverage) && w.coverage < 0.5));
  const metrics = keys.filter(m => data.node?.[m]).map(m => {
    const values = keep.map(({ w, k }) => ({ x: w.start, y: data.node[m][k]?.[i] ?? NaN }));
    const last = [...values].reverse().find(p => Number.isFinite(p.y)) || null;
    return { key: m, values, last };
  }).filter(m => m.values.some(p => Number.isFinite(p.y)));
  return { windows: keep.map(x => x.w), metrics };
}
