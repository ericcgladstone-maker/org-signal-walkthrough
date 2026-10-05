// Perceived networks: cognitive social structures (Krackhardt 1987).
//
// Each informant k reports the whole network as they see it: a binary matrix
// R_k over the same roster. From the stack of reports:
//   LAS (locally aggregated structure): the tie i->j is decided only by the two
//     people involved, informant i (about their own tie) and informant j.
//       union        R_i(i,j) OR  R_j(i,j)
//       intersection R_i(i,j) AND R_j(i,j)
//     A person without their own report contributes nothing (union then rests on
//     the other side; intersection is absent). Those people are listed.
//   Consensus structure: i->j is present when the share of informants reporting
//     it is at least the threshold (0.5 = at least half of the informants).
// Accuracy compares one informant's matrix with a criterion (the consensus, or
// an observed reference network).
//
// Direction. A relation such as friendship is mutual (relation.undirected):
// then a pair {i, j} is one tie, ticking either cell reports it (the builder
// mirrors ticks), and every count, the consensus and accuracy are over
// unordered pairs, so an informant who ticks both cells and one who ticks one
// cell report the same thing (M1). Advice is directed: ordered pairs i != j.
// The analyzed network carries the direction (M2).
//
// Model (plain JSON):
//   { version, name, people: [{ id, label }], relation: { name, question, undirected },
//     informants: [{ id, personId|null, label, ties: { 'i|j': 1 }, mirrored?: { 'j|i': 1 } }] }
// In an undirected relation the ties map holds both 'i|j' and 'j|i';
// mirrored marks the cells ticked only as a mirror (see toggleInformantTie).

import { DatasetBuilder, eventTargets, eventAttrs } from '../core/model.js';
import { tieFieldPlan } from '../analysis/construct.js';
import { uid, slug, normName } from './common.js';
import { pairKey, splitKey, orderedPairs, nameIndex, setTie } from './matrix.js';

// Relations people usually hold together, so a tie needs no direction.
const MUTUAL = /friend|know|social|spend.*time|hang|close|acquaint|kin|famil|partner|sibling|roommate|neighbo|works? with|cowork|colleague|collaborat|married|date/i;
export const isMutualRelation = name => MUTUAL.test(String(name || ''));

export const CSS_RELATIONS = [
  { name: 'Friendship', question: 'Who is friends with whom?', undirected: true },
  { name: 'Advice', question: 'Who goes to whom for advice?', undirected: false },
  { name: 'Knows', question: 'Who knows whom?', undirected: true },
  { name: 'Works with', question: 'Who works closely with whom?', undirected: true },
  { name: 'Trust', question: 'Who trusts whom with a sensitive matter?', undirected: false },
];

export function newCSS() {
  return { version: 1, name: 'Perceived network', people: [], relation: { ...CSS_RELATIONS[0] }, informants: [] };
}

// Mutual unless the relation says otherwise; models saved before the setting
// existed follow the relation's name.
export const undirectedOf = css => (typeof css.relation?.undirected === 'boolean' ? css.relation.undirected : isMutualRelation(css.relation?.name));

export function addInformant(css, personId = null) {
  const p = css.people.find(x => x.id === personId);
  const inf = { id: uid('i'), personId: p ? p.id : null, label: p ? p.label : `Informant ${css.informants.length + 1}`, ties: {} };
  return { ...css, informants: [...css.informants, inf] };
}

// Both directions of every tie (a mutual relation's matrix).
export function symmetrize(ties) {
  const out = { ...ties };
  for (const [k, v] of Object.entries(ties)) { if (!v) continue; const [i, j] = splitKey(k); out[pairKey(j, i)] = out[pairKey(j, i)] || v; }
  return out;
}

// One cell as the matrix sets it; in a mutual relation the mirror goes with it.
export function setReportTie(css, ties, from, to, v) {
  const t = setTie(ties, from, to, v);
  return undirectedOf(css) ? setTie(t, to, from, v) : t;
}

// One informant after a cell is set or cleared, keeping track of which cells
// hold a tick only because their mirror was ticked (inf.mirrored, mutual
// relations). Clearing a cell clears the pair.
export function setInformantTie(css, inf, from, to, v) {
  const ties = setReportTie(css, inf.ties, from, to, v);
  if (!undirectedOf(css)) return { ...inf, ties };
  const mirrored = { ...(inf.mirrored || {}) };
  delete mirrored[pairKey(from, to)];
  if (v) { if (!inf.ties[pairKey(to, from)]) mirrored[pairKey(to, from)] = 1; }
  else delete mirrored[pairKey(to, from)];
  return { ...inf, ties, mirrored };
}

// A click (or Space) on a cell. In a mutual relation a click on a cell that
// is ticked only as the mirror of the cell the informant ticked keeps the
// tie: the student who ticks both cells of a friendship ends with it ticked,
// not cleared. That click confirms the cell, so a further click clears the
// pair, as does a click on the cell first ticked, Delete or 0.
export function toggleInformantTie(css, inf, from, to) {
  const k = pairKey(from, to);
  if (!inf.ties[k]) return setInformantTie(css, inf, from, to, 1);
  if (undirectedOf(css) && inf.mirrored?.[k]) {
    const mirrored = { ...inf.mirrored };
    delete mirrored[k];
    return { ...inf, mirrored };
  }
  return setInformantTie(css, inf, from, to, 0);
}

// Cells a symmetrized matrix gained, as a mirrored map.
function mirrorsAdded(before, after) {
  const m = {};
  for (const k of Object.keys(after)) if (!before[k]) m[k] = 1;
  return m;
}

// Switch direction. Turning mutual on mirrors every informant's ticks (a pair
// either of them ticked becomes one tie); turning it off keeps the matrices.
export function setUndirected(css, on) {
  const informants = on ? css.informants.map(i => { const ties = symmetrize(i.ties); return { ...i, ties, mirrored: { ...(i.mirrored || {}), ...mirrorsAdded(i.ties, ties) } }; }) : css.informants;
  return { ...css, relation: { ...css.relation, undirected: !!on }, informants };
}

const has = (ties, i, j) => !!ties[pairKey(i, j)];
const reports = (und, ties, i, j) => has(ties, i, j) || (und && has(ties, j, i));

// The pairs every count runs over: ordered pairs, or each unordered pair once
// (first person in roster order first).
function* pairsOf(css, und = undirectedOf(css)) {
  if (!und) { yield* orderedPairs(css.people); return; }
  const P = css.people;
  for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) yield [P[a].id, P[b].id];
}

// Share of informants reporting each pair: Map('i|j' -> share).
export function agreement(css) {
  const n = css.informants.length;
  const und = undirectedOf(css);
  const out = new Map();
  if (!n) return out;
  for (const [i, j] of pairsOf(css, und)) {
    let c = 0;
    for (const inf of css.informants) if (reports(und, inf.ties, i, j)) c++;
    out.set(pairKey(i, j), c / n);
  }
  return out;
}

// In a mutual relation both cells of a consensus tie are set, like an
// informant's own matrix, so it compares and displays the same way.
export function consensus(css, threshold = 0.5, { without = null } = {}) {
  const src = without ? { ...css, informants: css.informants.filter(i => i.id !== without) } : css;
  const ties = {};
  // A tiny epsilon keeps 0.5 * 2 / 4 style shares from falling under the
  // threshold through floating-point error.
  for (const [k, p] of agreement(src)) if (p > 0 && p >= threshold - 1e-12) ties[k] = 1;
  return undirectedOf(css) ? symmetrize(ties) : ties;
}

export function las(css, rule = 'union') {
  const und = undirectedOf(css);
  const own = new Map();
  for (const inf of css.informants) if (inf.personId) own.set(inf.personId, inf.ties);
  const ties = {};
  for (const [i, j] of pairsOf(css, und)) {
    const a = own.has(i) ? reports(und, own.get(i), i, j) : null;
    const b = own.has(j) ? reports(und, own.get(j), i, j) : null;
    const on = rule === 'intersection' ? a === true && b === true : a === true || b === true;
    if (on) ties[pairKey(i, j)] = 1;
  }
  const missing = css.people.filter(p => !own.has(p.id)).map(p => p.label);
  return Object.defineProperty(und ? symmetrize(ties) : ties, 'missing', { value: missing, enumerable: false });
}

// Signal-detection counts of a perceived matrix against a criterion matrix,
// over ordered pairs i != j, or unordered pairs when undirected.
export function accuracy(perceived, criterion, people, { undirected = false } = {}) {
  let hits = 0, misses = 0, falseAlarms = 0, correctRejections = 0;
  for (const [i, j] of pairsOf({ people }, undirected)) {
    const p = reports(undirected, perceived, i, j), c = reports(undirected, criterion, i, j);
    if (p && c) hits++; else if (c) misses++; else if (p) falseAlarms++; else correctRejections++;
  }
  const div = (a, b) => (b ? a / b : NaN);
  return {
    hits, misses, falseAlarms, correctRejections,
    hitRate: div(hits, hits + misses),
    falseAlarmRate: div(falseAlarms, falseAlarms + correctRejections),
    jaccard: div(hits, hits + misses + falseAlarms),
  };
}

// Ties an informant reports: pairs (unordered when mutual).
export function reportedCount(css, ties) {
  const und = undirectedOf(css);
  let c = 0;
  for (const [i, j] of pairsOf(css, und)) if (reports(und, ties, i, j)) c++;
  return c;
}

// Each informant against the consensus (which includes their own report, so
// it flatters everyone and is circular: kept for reference, not shown as the
// score), against the consensus of the other informants only (leave-one-out;
// with two informants, the other one's report), and against a reference.
export function perInformantAccuracy(css, { threshold = 0.5, reference = null } = {}) {
  const undirected = undirectedOf(css);
  const cons = consensus(css, threshold);
  return css.informants.map(inf => ({
    id: inf.id, label: inf.label, personId: inf.personId,
    reported: reportedCount(css, inf.ties),
    vsConsensus: accuracy(inf.ties, cons, css.people, { undirected }),
    vsOthers: css.informants.length >= 2 ? accuracy(inf.ties, consensus(css, threshold, { without: inf.id }), css.people, { undirected }) : null,
    vsReference: reference ? accuracy(inf.ties, reference, css.people, { undirected }) : null,
  }));
}

// Who perceives best: the highest Jaccard against the criterion, with ties
// at two decimals named together (M14). key: 'vsConsensus' | 'vsReference' | 'vsOthers'.
export function bestPerceiver(rows, key = 'vsConsensus') {
  const ok = rows.filter(r => r[key] && Number.isFinite(r[key].jaccard));
  if (!ok.length) return null;
  const top = Math.max(...ok.map(r => r[key].jaccard));
  const best = ok.filter(r => Math.round(r[key].jaccard * 100) === Math.round(top * 100));
  return { labels: best.map(r => r.label), jaccard: top, tied: best.length > 1 };
}

// How each informant filled in the matrix, for a directed relation: the share
// of their ticked ties that are ticked in both directions. When some
// informants tick both cells for every pair and others one cell, their
// matrices mean different things and the comparison is unfair (M1).
export function symmetryCheck(css) {
  const rows = css.informants.map(inf => {
    let ties = 0, both = 0;
    for (const k of Object.keys(inf.ties)) { if (!inf.ties[k]) continue; ties++; const [i, j] = splitKey(k); if (inf.ties[pairKey(j, i)]) both++; }
    return { id: inf.id, label: inf.label, ties, share: ties ? both / ties : NaN };
  });
  if (undirectedOf(css)) return { rows, twoWay: [], oneWay: [], mixed: false, allTwoWay: false };
  // Mixed: the shares of two-way ticks differ by at least 0.3 between
  // informants; they are split at the midpoint of the range. allTwoWay: every
  // informant ticked (almost) every tie both ways, so the relation is
  // probably mutual.
  const judged = rows.filter(r => r.ties >= 3);
  const lo = Math.min(...judged.map(r => r.share)), hi = Math.max(...judged.map(r => r.share));
  const mixed = judged.length > 1 && hi - lo >= 0.3;
  const mid = (lo + hi) / 2;
  const twoWay = mixed ? judged.filter(r => r.share > mid).map(r => r.label) : [];
  const oneWay = mixed ? judged.filter(r => r.share <= mid).map(r => r.label) : [];
  return { rows, twoWay, oneWay, mixed, allTwoWay: judged.length > 1 && lo >= 0.9 };
}

// Pairs informants disagree about most. With share p reporting the tie, the
// disagreement is 4 p (1 - p): 1 at an even split, 0 when everyone agrees.
export function disagreement(css, { limit = 20 } = {}) {
  const label = new Map(css.people.map(p => [p.id, p.label]));
  const rows = [];
  for (const [k, p] of agreement(css)) {
    if (p <= 0 || p >= 1) continue;
    const [i, j] = splitKey(k);
    rows.push({ from: i, to: j, fromLabel: label.get(i), toLabel: label.get(j), share: p, score: 4 * p * (1 - p) });
  }
  rows.sort((a, b) => b.score - a.score || a.fromLabel.localeCompare(b.fromLabel) || a.toLabel.localeCompare(b.toLabel));
  return rows.slice(0, limit);
}

// A loaded Dataset as a reference network over the roster: any event from
// actor to a target becomes a directed binary tie, matched by name.
// A network built from perceived reports (format 'css', such as this study's
// own consensus after "Analyze this network") is not a reference: scoring the
// informants against it would be circular. It comes back as { fromStudy }.
export function referenceFromDataset(ds, people, { tieFields = null } = {}) {
  if (!ds) return null;
  const srcs = ds.meta?.sources || [];
  if (srcs.length && srcs.every(s => s.format === 'css')) return { ties: {}, matched: 0, fromStudy: true };
  const idx = nameIndex(people);
  const byNode = new Array(ds.nodes.count);
  for (let n = 0; n < ds.nodes.count; n++) byNode[n] = idx.get(normName(ds.nodes.labels[n])) ?? null;
  const matched = byNode.filter(Boolean).length;
  if (!matched) return { ties: {}, matched: 0 };
  // The active tie-field filters (Construction settings) apply, so a dataset
  // with several relations is a reference for the one being analyzed.
  const plan = tieFieldPlan(ds, tieFields);
  const filtered = !!plan?.filters.length;
  const ties = {};
  for (let e = 0; e < ds.events.count; e++) {
    const a = byNode[ds.events.actor[e]];
    if (!a) continue;
    if (filtered && !plan.pass(e, eventAttrs(ds, e))) continue;
    for (const [t] of eventTargets(ds, e)) { const b = byNode[t]; if (b && b !== a) ties[pairKey(a, b)] = 1; }
  }
  // Whether the dataset holds more than one relation (a tie field 'relation'
  // with several values), so the UI can say when none is chosen.
  const rel = new Set();
  for (let e = 0; e < ds.events.count && rel.size < 2; e++) { const r = eventAttrs(ds, e)?.relation; if (r !== undefined) rel.add(String(r)); }
  return { ties, matched, filters: filtered ? tieFields.filters : [], multiRelation: rel.size > 1 };
}

// views: 'consensus' | 'las-union' | 'las-intersection' | informant id
export function viewTies(css, view, { threshold = 0.5 } = {}) {
  if (view === 'consensus') return consensus(css, threshold);
  if (view === 'las-union') return las(css, 'union');
  if (view === 'las-intersection') return las(css, 'intersection');
  const t = css.informants.find(i => i.id === view)?.ties ?? {};
  return undirectedOf(css) ? symmetrize(t) : t;
}

export function viewLabel(css, view, threshold = 0.5) {
  if (view === 'consensus') return `Consensus (at least ${Math.round(threshold * 100)}% of informants)`;
  if (view === 'las-union') return 'Each tie judged by its two people, either says yes (LAS union)';
  if (view === 'las-intersection') return 'Each tie judged by its two people, both say yes (LAS intersection)';
  const inf = css.informants.find(i => i.id === view);
  return inf ? `As seen by ${inf.label}` : view;
}

export function toDataset(css, { view = 'consensus', threshold = 0.5 } = {}) {
  if (!css.people.length) throw new Error('The roster is empty.');
  if (!css.informants.length) throw new Error('Add at least one informant.');
  const und = undirectedOf(css);
  const ties = viewTies(css, view, { threshold });
  const b = new DatasetBuilder({ name: `${css.name || 'Perceived network'}: ${viewLabel(css, view, threshold)}` });
  b.beginSource({ format: 'css', family: 'survey', medium: 'survey', view: 'full', context: 'survey', directed: !und,
    fileNames: [], cssView: view, threshold: view === 'consensus' ? threshold : null, informants: css.informants.length, relation: css.relation?.name || null });
  const keyOf = new Map(), used = new Set();
  const agree = agreement(css);
  for (const p of css.people) {
    let k = 'cs:' + slug(p.label);
    while (used.has(k)) k += '_';
    used.add(k); keyOf.set(p.id, k);
    b.node(k, { label: p.label, attrs: { informant: css.informants.some(i => i.personId === p.id) } });
  }
  const ctx = b.context('cs:' + slug(css.relation?.name || 'relation'), { name: css.relation?.name || 'Relation', kind: 'survey', visibility: 'private', medium: 'survey' });
  const order = new Map(css.people.map((p, i) => [p.id, i]));
  for (const k of Object.keys(ties)) {
    const [i, j] = splitKey(k);
    if (!keyOf.has(i) || !keyOf.has(j)) continue;
    // A mutual tie is one undirected event, written once.
    if (und && order.get(i) > order.get(j)) continue;
    // In the consensus view the weight is the share of informants who reported
    // the tie, so the network carries how strongly it was agreed on.
    const weight = view === 'consensus' ? agree.get(k) || 1 : 1;
    b.event({ type: 'declared', actor: b.nodeIndex(keyOf.get(i)), targets: [[b.nodeIndex(keyOf.get(j)), 'declared']], context: ctx, weight });
    b.stat('ties');
  }
  if (view === 'consensus') {
    b.warn('css-consensus-weight', `Each tie's weight is the share of the ${css.informants.length} informants who reported it (0.75 = three in four). A person's strength adds up these shares over their ties.`);
    b.source.warnings[b.source.warnings.length - 1].severity = 'info';
  }
  if (view.startsWith('las')) { const miss = ties.missing?.length; if (miss) b.warn('css-missing-self-report', 'People without their own report; their ties rest on the other person only', miss); }
  return b.build();
}
