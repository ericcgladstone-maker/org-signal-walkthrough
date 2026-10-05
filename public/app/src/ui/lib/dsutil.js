// Small, cheap readers over a Dataset for the UI: labels, attribute choices,
// time extents, histograms and "which construction rules have evidence".
// Anything heavier than a single pass over the event columns belongs in the
// analysis engine, not here.

import { EVENT_TYPES, ROLES, VISIBILITY } from '../../core/model.js';
import { defaultGrouping } from '../../analysis/groups.js';
import { evidenceCounts } from '../../analysis/construct.js';

export const RULES = ['reply', 'mention', 'dm', 'to', 'cc', 'bcc', 'adjacency', 'copresence', 'declared', 'repost', 'like', 'follow', 'reaction'];

export const RULE_TEXT = {
  reply: 'A replies to B',
  mention: 'A mentions B',
  dm: 'A sends B a direct message',
  to: 'A emails B (To)',
  cc: 'A copies B (Cc)',
  bcc: 'A blind-copies B (Bcc)',
  adjacency: 'A posts right after B in the same conversation',
  copresence: 'A and B attend the same meeting or share a small space',
  declared: 'A names B in a survey or hand-built network',
  repost: 'A reposts B',
  like: 'A likes B',
  follow: 'A follows B',
  reaction: 'A reacts to B',
};

// Plain names for the construction rules, for evidence lists and filters.
export const RULE_LABEL = {
  reply: 'Replies',
  mention: 'Mentions',
  dm: 'Direct messages',
  to: 'Emails (To)',
  cc: 'Emails (Cc)',
  bcc: 'Emails (Bcc)',
  adjacency: 'Turn-taking',
  copresence: 'Shared meetings or spaces',
  declared: 'Named ties (survey or drawing)',
  repost: 'Reposts',
  like: 'Likes',
  follow: 'Follows',
  reaction: 'Reactions',
};

export const VISIBILITY_LABEL = { public: 'Public', private: 'Private', direct: 'Direct', group: 'Group', unknown: 'Unknown' };

export function label(ds, i) {
  if (!ds || i == null || i < 0) return '';
  return ds.nodes.labels[i] ?? ds.nodes.keys[i];
}

// Attributes that can colour or group nodes: categorical-ish with few values,
// at least one of them shared by two or more people (so names, emails and
// other per-person labels are not offered as "groups").
const groupableCache = new WeakMap();
export function groupableAttributes(ds) {
  if (!ds) return [];
  if (groupableCache.has(ds)) return groupableCache.get(ds);
  const out = (ds.attributeSchema || []).filter(a => {
    if (!['categorical', 'boolean', 'ordinal'].includes(a.type)) return false;
    const k = a.values?.length ?? 0;
    if (k < 2 || k > 60) return false;
    let withValue = 0;
    for (const at of ds.nodes.attrs) if (at[a.key] !== undefined && at[a.key] !== null && at[a.key] !== '') withValue++;
    return withValue > k;
  });
  groupableCache.set(ds, out);
  return out;
}

// Yes/no fields that record how the data was collected rather than who
// people are (is_phone_number, responded, deactivated): offered last and never
// chosen by default.
export function isBookkeeping(a) {
  if (!a) return false;
  const vals = (a.values || []).map(v => String(v).toLowerCase());
  const yesNo = a.type === 'boolean' || (vals.length > 0 && vals.length <= 2 && vals.every(v => ['true', 'false', 'yes', 'no', '0', '1'].includes(v)));
  return yesNo || /^(is|has)[ _-]?|^responded$|^deactivated$|^deleted$|^bot$/i.test(a.key);
}

// The attribute Network, People and Groups open on (null = the detected
// communities). First choice: a department-, division- or team-like field
// with 2 to 8 values, which the eight hues show without folding. Failing
// that, a 3-15 value one (defaultGrouping), but only when the communities
// are not the coarser grouping. The generator's planted ground truth is never
// the default; it stays one choice away.
export function defaultGroupAttr(ds, { communities = null } = {}) {
  if (!ds) return null;
  const schema = (ds.attributeSchema || []).filter(a => a.key !== 'planted_group');
  const view = { ...ds, attributeSchema: schema };
  const fine = defaultGrouping(view, { minLevels: 2, maxLevels: 8 });
  if (fine) return fine;
  const coarse = defaultGrouping(view);
  if (!coarse) return null;
  const k = schema.find(a => a.key === coarse)?.values?.length ?? Infinity;
  const kc = communities ? (communities.nontrivial ?? communities.count ?? Infinity) : Infinity;
  return kc < k ? null : coarse;
}

// Groupable attributes in the order a reader most likely wants them: the
// default grouping first, then other department-like names with at most 8
// values, the rest of the department-like names, attributes with 3-15
// values, the rest; bookkeeping fields last.
const GROUPISH = /(^|[ _-])(dept|department|team|group|division|unit|office|function|planted)/i;
export function preferredAttributes(ds) {
  const attrs = groupableAttributes(ds);
  const def = defaultGroupAttr(ds);
  const score = (a) => {
    if (isBookkeeping(a)) return 4;
    if (a.key === def) return -1;
    const k = a.values?.length ?? 0;
    if (GROUPISH.test(`${a.key} ${a.label || ''}`)) return k <= 8 ? 0 : 1;
    return k >= 3 && k <= 15 ? 2 : 3;
  };
  return attrs.map((a, i) => ({ a, i, s: score(a) })).sort((x, y) => x.s - y.s || x.i - y.i).map(x => x.a);
}

export function numericAttributes(ds) {
  if (!ds) return [];
  return (ds.attributeSchema || []).filter(a => a.type === 'numeric' || a.type === 'ordinal');
}

// Values of a categorical attribute ordered by size over the whole dataset,
// then by name. This order is what fixes colour assignment.
export function orderedValues(ds, key) {
  const counts = new Map();
  for (const a of ds.nodes.attrs) {
    const v = a[key];
    if (v === undefined || v === null || v === '') continue;
    counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([v, n]) => ({ value: v, count: n }));
}

export function timeExtent(ds) {
  let lo = Infinity, hi = -Infinity;
  const t = ds?.events?.t;
  if (!t) return [NaN, NaN];
  for (let i = 0; i < t.length; i++) { const x = t[i]; if (x === x) { if (x < lo) lo = x; if (x > hi) hi = x; } }
  return lo === Infinity ? [NaN, NaN] : [lo, hi];
}

export function sourceStats(ds) {
  const n = ds.meta.sources.length;
  const out = Array.from({ length: n }, () => ({ lo: Infinity, hi: -Infinity, events: 0, undated: 0, text: 0, actors: new Set() }));
  const { t, source, actor, text } = ds.events;
  for (let i = 0; i < ds.events.count; i++) {
    const s = out[source[i]];
    if (!s) continue;
    s.events++;
    s.actors.add(actor[i]);
    const x = t[i];
    if (x === x) { if (x < s.lo) s.lo = x; if (x > s.hi) s.hi = x; } else s.undated++;
    if (text[i]) s.text++;
  }
  return out.map(s => ({ ...s, actors: s.actors.size, lo: s.lo === Infinity ? NaN : s.lo, hi: s.hi === -Infinity ? NaN : s.hi }));
}

// Counts of events per bin across [lo, hi]. Returns { lo, hi, bins: Int32Array, step }.
export function activityHistogram(ds, nbins = 60) {
  const [lo, hi] = timeExtent(ds);
  const bins = new Int32Array(nbins);
  if (!Number.isFinite(lo) || hi <= lo) return { lo, hi, bins, step: 0 };
  const step = (hi - lo) / nbins;
  const t = ds.events.t;
  for (let i = 0; i < t.length; i++) {
    const x = t[i];
    if (x === x) bins[Math.min(nbins - 1, Math.floor((x - lo) / step))]++;
  }
  return { lo, hi, bins, step };
}

export function hasText(ds) {
  const tx = ds?.events?.text;
  if (!tx) return false;
  let n = 0;
  for (let i = 0; i < tx.length; i++) if (tx[i]) { if (++n >= 5) return true; }
  return false;
}

export function textCoverage(ds) {
  const tx = ds.events.text;
  let n = 0, m = 0;
  for (let i = 0; i < tx.length; i++) if (EVENT_TYPES[ds.events.type[i]] === 'message') { m++; if (tx[i]) n++; }
  return m ? n / m : 0;
}

// How many pieces of evidence each construction rule has in the data: the
// engine's own count (src/analysis/construct.js evidenceCounts, the numbers
// defaultSettings records), so the import review and Construction settings
// state the same counts, and both match what the network is built from.
export function ruleEvidence(ds) {
  if (!ds) return Object.fromEntries(RULES.map(r => [r, 0]));
  return evidenceCounts(ds);
}

// Messages in shared conversations, the sequence turn-taking would be read
// from. The engine derives turn-taking only for some data (evidenceCounts);
// when it does not, the drawer says so instead of "no source records this".
export function sequencedMessages(ds) {
  if (!ds) return 0;
  const e = ds.events;
  let n = 0;
  for (let i = 0; i < e.count; i++) if (EVENT_TYPES[e.type[i]] === 'message' && e.context[i] >= 0) n++;
  return n;
}

export function visibilityPresent(ds) {
  const seen = new Set();
  for (let c = 0; c < ds.contexts.count; c++) seen.add(VISIBILITY[ds.contexts.visibility[c]]);
  return VISIBILITY.filter(v => seen.has(v));
}

export function mediaPresent(ds) {
  const seen = new Set(ds.contexts.medium.filter(Boolean));
  for (const s of ds.meta.sources) if (s.medium) seen.add(s.medium);
  return [...seen];
}

export function botCount(ds) {
  let n = 0;
  for (let i = 0; i < ds.nodes.count; i++) n += ds.nodes.isBot[i];
  return n;
}

// What a source's view lets you conclude. Shown in the import report beside
// the counts so nobody reads an ego export as an organisation chart.
export const VIEW_TEXT = {
  full: {
    name: 'Full network',
    can: 'Whole-network structure for the bounded group: centrality, brokerage, communities and group mixing.',
    cannot: 'Ties that happened outside this system or this group, and anyone who never used it.',
  },
  ego: {
    name: 'Ego network',
    can: 'Who this person interacts with, how often, and how their contacts cluster.',
    cannot: 'Ties among other people that the owner did not see, so whole-network measures (betweenness, communities across the organization) are not meaningful.',
  },
  chat: {
    name: 'Single conversation',
    can: 'The structure of communication within this one conversation, and how it changes over time.',
    cannot: 'Anything about relationships outside this conversation.',
  },
  sample: {
    name: 'Sample',
    can: 'Patterns that hold within the sample, with the sampling frame stated.',
    cannot: 'Exact positions in the full population; centrality ranks are sample-dependent.',
  },
  authored: {
    name: 'Authored only',
    can: 'What one account wrote and whom it addressed.',
    cannot: 'Replies or activity by anyone else, so ties are one-sided by construction.',
  },
};
