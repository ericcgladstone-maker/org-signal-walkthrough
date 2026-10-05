// Two-mode (affiliation) networks in the analysis views: the words, options
// and per-mode readings the drawer, Network and People share. The engine
// side is src/analysis/twomode.js; the network's `twoMode` comes from
// engine.build() (src/ui/services/engine.js):
//   { view: 'two-mode' | 'mode0' | 'mode1', labels: [l0, l1], mode (per
//     network node, 0 / 1), counts, basis, projection, minShared, ... }
// Pure module (no DOM), tested in test/ui-core/twomode.test.js.

import { standouts } from './measures.js';

export const MODE_ATTR = 'bipartite';
export const TWO_MODE_KEYS = ['twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering'];

// The network's twoMode, or null for one-mode data.
export const twoModeOfNet = (net) => (net?.twoMode && Array.isArray(net.twoMode.labels) ? net.twoMode : null);
// True on the two-mode view itself (both kinds of node, ties only across).
export const isTwoModeView = (net) => twoModeOfNet(net)?.view === 'two-mode' && !!net.twoMode.mode;

const lower = s => String(s || '').toLowerCase();

// The construction choices, in words with the data's own mode names.
export function viewOptions(labels) {
  const [a, b] = labels;
  return [
    { value: 'two-mode', label: `${a} and ${lower(b)} (two-mode)`, desc: `Both kinds of node; each tie joins one of the ${lower(a)} to one of the ${lower(b)}.` },
    { value: 'mode0', label: `${a} tied by shared ${lower(b)}`, desc: `A one-mode projection: only the ${lower(a)}, tied when they share ${lower(b)}.` },
    { value: 'mode1', label: `${b} tied by shared ${lower(a)}`, desc: `A one-mode projection: only the ${lower(b)}, tied when they share ${lower(a)}.` },
  ];
}

export function projectionOptions(labels, basis = 0) {
  const via = lower(labels[1 - basis]);
  return [
    { value: 'count', label: `Number shared (default)`, desc: `Tie weight = how many ${via} the two share (Breiger 1974).` },
    { value: 'newman', label: 'Newman: 1 / (size - 1) each', desc: `Each shared one adds 1 / (its size - 1), so being together in a large one counts less than in a small one (Newman 2001).` },
    { value: 'binary', label: 'Present or absent', desc: 'Every tie weighs 1, however much the two share.' },
  ];
}

// What a projected tie means, for the Network header and the drawer.
// tm: net.twoMode (or settings.twoMode with labels added).
export function projectionSentence(tm) {
  if (!tm || !(tm.basis === 0 || tm.basis === 1)) return null;
  const me = lower(tm.labels[tm.basis]), via = lower(tm.labels[1 - tm.basis]);
  const k = Math.max(1, tm.minShared || 1);
  const share = k === 1 ? 'at least one of the' : `at least ${k} of the`;
  const weight = tm.projection === 'newman' ? `each shared one adds 1 / (its size - 1), so large ${via} tie people weakly (Newman)`
    : tm.projection === 'binary' ? 'every tie weighs 1'
    : `the number of ${via} they share`;
  return `Projection: two ${me} are tied when they share ${share} ${via}; tie weight = ${weight}.`;
}

// The Network intro: counts of each mode on the two-mode view.
export function twoModeIntro(tm, n, edges) {
  if (!tm) return null;
  const [a, b] = tm.labels;
  if (tm.view === 'two-mode') return `${tm.counts[0]} ${lower(a)} and ${tm.counts[1]} ${lower(b)}, ${edges} ${edges === 1 ? 'tie' : 'ties'} (each joins one of the ${lower(a)} to one of the ${lower(b)}).`;
  const me = lower(tm.labels[tm.basis]);
  return `${n} ${me} and ${edges} ${edges === 1 ? 'tie' : 'ties'} between them.`;
}

// "Who stands out" separately within each mode: two-mode values are
// normalized per mode, so each mode is ranked among its own kind.
// Returns [{ mode, label, rows }] with rows as standouts() gives them.
export function perModeStandouts(metrics, mode, keys = ['twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness'], opts = {}) {
  if (!metrics || !mode) return [];
  const out = [];
  for (const m of [0, 1]) {
    const masked = {};
    for (const k of keys) {
      const arr = metrics[k];
      if (!arr) continue;
      const a = new Float64Array(arr.length);
      for (let v = 0; v < arr.length; v++) a[v] = mode[v] === m ? arr[v] : NaN;
      masked[k] = a;
    }
    out.push({ mode: m, rows: standouts(masked, keys.filter(k => masked[k]), opts) });
  }
  return out;
}

// The standout question per two-mode measure, with the mode names.
export function standoutWords(key, labels, m) {
  const other = lower(labels[1 - m]);
  if (key === 'twoModeDegree') return `Tied to the largest share of the ${other}`;
  if (key === 'twoModeBetweenness') return 'Most often on the route between others';
  if (key === 'twoModeCloseness') return 'Closest to everyone';
  return key;
}

// Network layouts on offer: force for every network; columns and rows for
// the two-mode view. Default: columns up to 150 nodes (the classic picture
// of an affiliation network), force above.
export function layoutOptions(net, { drawn = false } = {}) {
  const opts = [];
  if (drawn) opts.push({ value: 'drawn', label: 'As drawn' });
  opts.push({ value: 'force', label: 'Force-directed' });
  if (isTwoModeView(net)) {
    const [a, b] = net.twoMode.labels;
    opts.push({ value: 'columns', label: `Two columns (${lower(a)} | ${lower(b)})` });
    opts.push({ value: 'rows', label: 'Two rows' });
  }
  return opts;
}
export function defaultLayout(net, { drawn = false } = {}) {
  if (drawn) return 'drawn';
  return isTwoModeView(net) && net.n <= 150 ? 'columns' : 'force';
}
// The engine's graphForRender `arrange` for a layout choice.
export const arrangeFor = (layout) => (layout === 'columns' || layout === 'rows' ? layout : null);

// The node attribute that carries the mode is shown as the Mode column and
// the mode coloring, not as an attribute with values 0 and 1.
export const withoutModeAttr = (attrs) => (attrs || []).filter(a => a.key !== MODE_ATTR);

// Mode of each network node in words.
export function modeLabelOf(net, v) {
  const tm = twoModeOfNet(net);
  if (!tm?.mode) return null;
  return tm.labels[tm.mode[v]] ?? null;
}
