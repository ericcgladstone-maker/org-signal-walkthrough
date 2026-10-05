// recoveryCheck: did an analysis find what the generator planted?
//
//   recoveryCheck(groundTruth, ds, net?, results?) -> report
//   recoveryCheck(groundTruth, ds, results)          (net omitted)
//
// results (all optional; computed elsewhere, e.g. by the analysis engine):
//   membership    Int32Array/array of community ids per network node (with
//                 net) or per dataset node (without)
//   nodeMetrics   { betweenness, degree, ... } arrays indexed the same way
//   affect        per-group mean sentiment: { byGroup: { name: mean } },
//                 [{ group|key|name, mean|compound|score|valence }], or
//                 { groups: [...] }; without it, affect is measured here with VADER
//   shifts        detected change points: [{ t|time|date|start, ... }] or { shifts: [...] } (engine: detectShifts)
//   diffusion     per term adopters: { term: { adopters: [{ node, t }] } },
//                 [{ term, adopters }], { terms: [{ term, adoptions }] } (engine: diffusion)
//                 or { cascades: [...] }; node = dataset index
//
// The report is { summary, rule, checks: [{ id, name, area, planted, recovered,
// metric, value, baseline, verdict, says, brokers? }], details, mapping }.
// verdict is one of 'recovered' | 'partly' | 'missed' | 'not checked', given
// by one stated rule (RULE, J9); `says` is the plain-language reading, with
// technical terms in parentheses. value and baseline are in the same unit.
// Nothing from the analysis engine is imported: the checks are independent so
// they can judge it.

import vader from '../../vendor/vader.js';
import { Rng } from './rng.js';
import { ROLES, EVENT_TYPES, VISIBILITY } from '../core/model.js';

const DAY = 86400000;

// One verdict rule for every check (J9). Scores run from 0 to 1 (1 = what
// was planted, exactly); differences and dates have their own clear cut-off.
export const RULE = 'Recovered: the analysis finds most of what was planted, a score of at least 0.6 where 1 is a perfect match (for a difference: in the planted direction and clear, p < 0.05; for a date: within the tolerance). Partly: some of it, a score of at least 0.25 and at least twice what chance alone gives (for a difference: the right direction but not clear; for a date: within twice the tolerance). Missed: anything less.';
export function scoreVerdict(score, chance = 0) {
  if (score == null || !Number.isFinite(score)) return 'not checked';
  if (score >= 0.6) return 'recovered';
  return score >= 0.25 && score >= 2 * (chance || 0) ? 'partly' : 'missed';
}

export function recoveryCheck(truth, ds, a3, a4) {
  let net = null, results = {};
  if (a3 && (a3.nodeIds || a3.edges)) { net = a3; results = a4 || {}; } else results = a3 || {};
  const map = mapNodes(truth, ds);
  const ctx = { truth, ds, net, results, map, checks: [], details: {} };
  coverage(ctx);
  communities(ctx);
  bridges(ctx);
  betweennessFidelity(ctx);
  affectChecks(ctx);
  shiftChecks(ctx);
  diffusionChecks(ctx);
  surveyChecks(ctx);
  const done = ctx.checks.filter(c => c.verdict !== 'not checked');
  const ok = done.filter(c => c.verdict === 'recovered').length, part = done.filter(c => c.verdict === 'partly').length;
  let bots = 0;
  for (let k = 0; k < ds.nodes.count; k++) if (ds.nodes.isBot?.[k]) bots++;
  return {
    summary: done.length ? `${ok} of ${done.length} planted features recovered, ${part} partly; ${done.length - ok - part} missed.` : 'Nothing to check: no analysis results were given and the dataset holds nothing measurable.',
    rule: RULE,
    checks: ctx.checks,
    details: ctx.details,
    mapping: { matched: map.matched, datasetNodes: ds.nodes.count, truthPeople: truth.people.count, by: map.by, networkPeople: net ? net.n : null, bots },
  };
}

// ---- node mapping -------------------------------------------------------------

function norm(s) { return String(s ?? '').normalize('NFD').replace(/[̀-ͯ‎‏ ⁨⁩~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase(); }

export function mapNodes(truth, ds) {
  const P = truth.people;
  const byKey = new Map(P.keys.map((k, i) => [String(k).toLowerCase(), i]));
  const byPid = new Map();
  (P.platformIds || []).forEach((p, i) => { for (const v of Object.values(p || {})) if (v != null && v !== '') byPid.set(String(v).toLowerCase(), i); });
  const labelCount = new Map();
  for (const l of P.labels) labelCount.set(norm(l), (labelCount.get(norm(l)) || 0) + 1);
  const byLabel = new Map(P.labels.map((l, i) => [norm(l), i]).filter(([l]) => labelCount.get(l) === 1));
  const toTruth = new Int32Array(ds.nodes.count).fill(-1);
  const by = { key: 0, platformId: 0, label: 0 };
  for (let k = 0; k < ds.nodes.count; k++) {
    const key = String(ds.nodes.keys[k]).toLowerCase();
    let i = byKey.get(key);
    if (i !== undefined) { toTruth[k] = i; by.key++; continue; }
    const tail = key.slice(key.indexOf(':') + 1);
    i = byPid.get(tail) ?? byKey.get(tail);
    if (i === undefined) for (const v of Object.values(ds.nodes.platformIds?.[k] || {})) { i = byPid.get(String(v).toLowerCase()); if (i !== undefined) break; }
    if (i !== undefined) { toTruth[k] = i; by.platformId++; continue; }
    i = byLabel.get(norm(ds.nodes.labels[k]));
    if (i !== undefined) { toTruth[k] = i; by.label++; }
  }
  let matched = 0; for (const x of toTruth) if (x >= 0) matched++;
  return { toTruth, matched, by };
}

// Values per dataset node from an array indexed by network node (net) or dataset node.
function perDsNode(ctx, arr) {
  const { ds, net } = ctx;
  if (!arr) return null;
  if (net && net.nodeIds && arr.length === net.nodeIds.length) {
    const out = new Array(ds.nodes.count).fill(undefined);
    for (let k = 0; k < net.nodeIds.length; k++) out[net.nodeIds[k]] = arr[k];
    return out;
  }
  return Array.from(arr);
}

function add(ctx, c) { ctx.checks.push({ baseline: null, details: undefined, ...c }); }
const r3 = x => (x == null || !Number.isFinite(x) ? null : Math.round(x * 1000) / 1000);
// For the plain-language `says` lines: p-values never read as exactly 0, counts get separators.
const pText = p => (!Number.isFinite(p) ? 'p not available' : p < 0.001 ? 'p < 0.001' : `p = ${r3(p)}`);
const nText = n => (Number.isFinite(n) ? n.toLocaleString('en-US') : String(n));

// ---- 1. tie coverage: how much of the true network the observed data shows ----

// With the network (net), what counts is the network as built with the
// construction settings in use, so the numbers match the Network view (N15,
// N24); without it, every pair with at least one event.
function coverage(ctx) {
  const { truth, ds, map, net } = ctx;
  const T = truth.ties;
  const n = truth.people.count;
  const key = (a, b) => (T.directed ? a * n + b : Math.min(a, b) * n + Math.max(a, b));
  const truePairs = new Set();
  for (let i = 0; i < T.count; i++) truePairs.add(key(T.a[i], T.b[i]));
  const seen = new Set();
  let observedPairs = 0, onTrue = 0;
  const see = (a, b) => {
    if (a < 0 || b < 0 || b === a) return;
    const k = key(a, b);
    if (seen.has(k)) return;
    seen.add(k); observedPairs++;
    if (truePairs.has(k) || (T.directed && truePairs.has(key(b, a)))) onTrue++;
  };
  const fromNet = !!(net?.edges && net.nodeIds);
  if (fromNet) {
    for (let e = 0; e < net.edges.count; e++) see(map.toTruth[net.nodeIds[net.edges.src[e]]], map.toTruth[net.nodeIds[net.edges.dst[e]]]);
  } else {
    const e = ds.events;
    for (let i = 0; i < e.count; i++) {
      const a = map.toTruth[e.actor[i]];
      if (a < 0) continue;
      for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) see(a, map.toTruth[e.tgt[j]]);
    }
  }
  let coveredTrue = 0;
  for (const k of truePairs) if (seen.has(k)) coveredTrue++;
  const cov = truePairs.size ? coveredTrue / truePairs.size : null;
  const prec = observedPairs ? onTrue / observedPairs : null;
  ctx.details.coverage = { trueTies: truePairs.size, observedPairs, observedOnTrueTies: onTrue, trueTiesSeen: coveredTrue, fromNetwork: fromNet };
  const view = truth.observation?.view;
  const where = fromNet ? 'the network as built' : 'the data';
  add(ctx, {
    id: 'tie-coverage', name: 'True ties visible in the data', area: 'observation',
    planted: `${nText(truePairs.size)} true ties (${view} view)`,
    recovered: fromNet ? `${nText(observedPairs)} ties in the network, ${nText(onTrue)} of them true ties` : `${nText(observedPairs)} pairs with at least one event, ${nText(onTrue)} of them true ties`,
    metric: 'share of true ties seen', value: r3(cov), baseline: null,
    verdict: view === 'full' ? scoreVerdict(cov) : 'not checked',
    says: cov == null ? 'No true ties to compare.' : `${pct(cov)} of the true ties are in ${where} (${nText(coveredTrue)} of ${nText(truePairs.size)}); ${prec == null ? 'none' : pct(prec)} of the ${fromNet ? 'network\'s ties' : 'observed pairs'} are true ties.${view !== 'full' ? ` This is a ${view} view, so most of the network is expected to be invisible.` : ''}`,
  });
}

// ---- 2. communities ------------------------------------------------------------

function communities(ctx) {
  const { truth, map, results } = ctx;
  const mem = perDsNode(ctx, results.membership);
  const planted = truth.communities?.membership;
  if (!mem || !planted) {
    add(ctx, { id: 'communities', name: 'Planted groups vs detected communities', area: 'structure', planted: `${truth.communities?.names?.length ?? 0} groups`, recovered: null, metric: 'NMI', value: null, verdict: 'not checked', says: 'No community membership was given.' });
    return;
  }
  const xs = [], ys = [];
  for (let k = 0; k < mem.length; k++) {
    const i = map.toTruth[k];
    if (i < 0 || mem[k] == null || mem[k] < 0 || planted[i] < 0) continue;
    xs.push(planted[i]); ys.push(mem[k]);
  }
  const nmi = NMI(xs, ys), ari = ARI(xs, ys);
  const kFound = new Set(ys).size, kPlanted = new Set(xs).size;
  ctx.details.communities = { nmi, ari, compared: xs.length, found: kFound, planted: kPlanted };
  // Name the groups by what they are (departments, interest communities...),
  // never by the attribute key.
  const kinds = [...new Set((truth.communities.kinds || []).filter(Boolean))];
  const what = kinds.length === 1 ? plural(kinds[0]) : 'groups';
  const how = nmi >= 0.9 ? 'almost exactly match' : nmi >= 0.6 ? 'mostly match' : nmi >= 0.25 ? 'partly match' : 'do not match';
  const extra = foldedValues(ctx);
  add(ctx, {
    id: 'communities', name: `Planted ${what} vs detected communities`, area: 'structure',
    planted: `${kPlanted} planted ${what}${extra ? ` (${extra})` : ''}`, recovered: `${kFound} communities over ${xs.length} people`,
    metric: 'agreement (NMI)', value: r3(nmi), baseline: 0,
    verdict: xs.length < 5 ? 'not checked' : scoreVerdict(nmi),
    says: `The communities found ${how} the planted ${what} (agreement ${r3(nmi)} out of 1; normalized mutual information (NMI) ${r3(nmi)}, adjusted Rand index (ARI) ${r3(ari)}; 0 = unrelated).`,
  });
}

const plural = w => (/[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : /s$/.test(w) ? w : `${w}s`);

// Values of the grouping attribute that are not planted groups (the CEO's
// "Executive" department), with the planted group they are counted in, so
// "7 planted departments" squares with 8 in the Department column (J13).
function foldedValues(ctx) {
  const { truth, ds, map } = ctx;
  const names = truth.communities?.names || [], planted = truth.communities?.membership;
  if (!ds.nodes.attrs || !planted) return '';
  const known = new Set(names.map(String));
  // The visible column the groups were planted from (Department): the one,
  // other than the planted-group column itself, whose values mostly equal
  // each person's planted group.
  let attr = null, best = 0;
  const keys = new Set();
  for (let k = 0; k < Math.min(ds.nodes.count, 500); k++) for (const key of Object.keys(ds.nodes.attrs[k] || {})) keys.add(key);
  for (const key of keys) {
    if (key === truth.communities?.attr || key === 'planted_group') continue;
    let same = 0, n = 0;
    for (let k = 0; k < ds.nodes.count; k++) { const i = map.toTruth[k]; const v = ds.nodes.attrs[k]?.[key]; if (i < 0 || v == null) continue; n++; if (String(v) === String(names[planted[i]])) same++; }
    if (n && same / n > best) { best = same / n; attr = key; }
  }
  if (!attr || best < 0.8) return '';
  const extra = new Map();
  for (let k = 0; k < ds.nodes.count; k++) {
    const v = ds.nodes.attrs[k]?.[attr];
    const i = map.toTruth[k];
    if (v == null || v === '' || known.has(String(v)) || i < 0) continue;
    const e = extra.get(v) || { n: 0, into: new Set() };
    e.n++; if (planted[i] >= 0) e.into.add(names[planted[i]]);
    extra.set(v, e);
  }
  return [...extra].map(([v, e]) => `the ${attr} column also has ${v}: ${e.n} ${e.n === 1 ? 'person' : 'people'}, planted with ${[...e.into].join(' and ') || 'no group'}`).join('; ');
}

// Dense integer codes for arbitrary labels.
function codes(v) { const m = new Map(); return { c: v.map(x => { let k = m.get(x); if (k === undefined) { k = m.size; m.set(x, k); } return k; }), k: m.size }; }

function table(x, y) {
  const X = codes(x), Y = codes(y);
  const n = x.length;
  const cx = new Float64Array(X.k), cy = new Float64Array(Y.k), cxy = new Map();
  for (let i = 0; i < n; i++) {
    cx[X.c[i]]++; cy[Y.c[i]]++;
    const k = X.c[i] * Y.k + Y.c[i];
    cxy.set(k, (cxy.get(k) || 0) + 1);
  }
  return { n, cx, cy, cxy, ky: Y.k };
}

// Normalized mutual information (arithmetic-mean normalization, as sklearn's default).
export function NMI(x, y) {
  if (!x.length) return NaN;
  const { n, cx, cy, cxy, ky } = table(x, y);
  const H = arr => { let h = 0; for (const c of arr) if (c) { const p = c / n; h -= p * Math.log(p); } return h; };
  let I = 0;
  for (const [k, c] of cxy) { const a = Math.floor(k / ky), b = k % ky; I += (c / n) * Math.log((c * n) / (cx[a] * cy[b])); }
  const hx = H(cx), hy = H(cy);
  if (hx === 0 && hy === 0) return 1;
  return hx + hy > 0 ? (2 * I) / (hx + hy) : 0;
}

// Adjusted Rand index.
export function ARI(x, y) {
  if (x.length < 2) return NaN;
  const { n, cx, cy, cxy } = table(x, y);
  const c2 = v => (v * (v - 1)) / 2;
  let sij = 0, sa = 0, sb = 0;
  for (const v of cxy.values()) sij += c2(v);
  for (const v of cx) sa += c2(v);
  for (const v of cy) sb += c2(v);
  const exp = (sa * sb) / c2(n), max = (sa + sb) / 2;
  return max === exp ? 1 : (sij - exp) / (max - exp);
}

// ---- 3. bridges ------------------------------------------------------------------

function bridges(ctx) {
  const { truth, map, results } = ctx;
  const brokers = truth.bridges?.brokers || [];
  const bt = perDsNode(ctx, results.nodeMetrics?.betweenness);
  if (!brokers.length) return;
  if (!bt) {
    add(ctx, { id: 'bridges', name: 'Planted brokers', area: 'structure', planted: `${brokers.length} brokers`, recovered: null, metric: 'precision@k', value: null, verdict: 'not checked', says: 'No betweenness scores were given.' });
    return;
  }
  const set = new Set(brokers);
  const ranked = [];
  for (let k = 0; k < bt.length; k++) if (bt[k] != null && Number.isFinite(bt[k]) && map.toTruth[k] >= 0) ranked.push([bt[k], map.toTruth[k]]);
  ranked.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const k = brokers.length;
  const top = ranked.slice(0, k).map(x => x[1]);
  const top2 = ranked.slice(0, 2 * k).map(x => x[1]);
  const hit = top.filter(i => set.has(i)).length, hit2 = top2.filter(i => set.has(i)).length;
  const p = k ? hit / k : null, base = ranked.length ? k / ranked.length : null;
  const ranks = brokers.map(b => ranked.findIndex(x => x[1] === b) + 1).filter(x => x > 0);
  // Every planted broker by name, with the rank measured here (J5), best first.
  const named = brokers.map(b => ({ name: truth.people.labels[b], key: truth.people.keys?.[b], rank: ranked.findIndex(x => x[1] === b) + 1 || null }))
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  ctx.details.bridges = { k, hitsAtK: hit, hitsAt2K: hit2, brokerRanks: ranks, ranked: ranked.length };
  add(ctx, {
    id: 'bridges', name: 'Planted brokers rank high on betweenness', area: 'structure',
    planted: `${k} brokers`, recovered: `${hit} in the top ${k}, ${hit2} in the top ${2 * k}`,
    metric: `share of the planted brokers in the top ${k} (precision at k)`, value: r3(p), baseline: r3(base),
    verdict: scoreVerdict(p, base),
    brokers: named,
    says: `${hit} of the ${k} planted brokers ${hit === 1 ? 'is' : 'are'} among the ${k} people with the highest betweenness: a share of ${r3(p)}, against ${r3(base)} for ${k} people picked at random. Where each planted broker ranks (of ${ranked.length}): ${named.map(x => `${x.name} ${x.rank ?? 'not in the network'}`).join(', ')}.`,
  });
}

// Does measured betweenness rank people the way the true network does? This
// separates "the measurement is faithful" from "the planted brokers dominate":
// a world can plant brokers that the rest of the structure out-bridges. Uses
// its own Brandes implementation on the true ties, independent of the engine.
function betweennessFidelity(ctx) {
  const { truth, map, results } = ctx;
  const bt = perDsNode(ctx, results.nodeMetrics?.betweenness);
  const T = truth.ties;
  if (!bt || !T?.count) return;
  const n = truth.people.count;
  if (n > 3000) return; // exact Brandes here would be slow; the engine approximates above this anyway
  const adj = Array.from({ length: n }, () => []);
  for (let i = 0; i < T.count; i++) { adj[T.a[i]].push(T.b[i]); adj[T.b[i]].push(T.a[i]); }
  const truthBt = brandes(adj);
  const xs = [], ys = [];
  for (let k = 0; k < bt.length; k++) {
    const t = map.toTruth[k];
    if (t >= 0 && bt[k] != null && Number.isFinite(bt[k])) { xs.push(bt[k]); ys.push(truthBt[t]); }
  }
  if (xs.length < 5) return;
  const rho = spearman(xs.map((x, i) => [x, ys[i]]));
  add(ctx, {
    id: 'betweenness-fidelity', name: 'Measured betweenness matches the true network', area: 'structure',
    planted: 'betweenness on the true ties', recovered: `Spearman rho ${r3(rho)} over ${xs.length} people`,
    metric: 'rank correlation (Spearman)', value: r3(rho), baseline: null,
    verdict: scoreVerdict(rho),
    says: rho >= 0.9 ? `Betweenness measured from the data ranks people almost exactly as the true network does (rank correlation, Spearman rho ${r3(rho)}).`
      : rho >= 0.6 ? `Betweenness measured from the data ranks people broadly as the true network does (rank correlation, Spearman rho ${r3(rho)}), with some people out of place.`
        : `Betweenness measured from the data ranks people differently from the true network (rank correlation, Spearman rho ${r3(rho)}): what the data shows, or the construction settings, distort brokerage.`,
  });
}

function brandes(adj) {
  const n = adj.length, bc = new Float64Array(n);
  const sigma = new Float64Array(n), dist = new Int32Array(n), delta = new Float64Array(n);
  const stack = new Int32Array(n), queue = new Int32Array(n);
  const preds = Array.from({ length: n }, () => []);
  for (let s = 0; s < n; s++) {
    sigma.fill(0); dist.fill(-1); delta.fill(0);
    for (const p of preds) p.length = 0;
    sigma[s] = 1; dist[s] = 0;
    let qh = 0, qt = 0, sp = 0;
    queue[qt++] = s;
    while (qh < qt) {
      const v = queue[qh++]; stack[sp++] = v;
      for (const w of adj[v]) {
        if (dist[w] < 0) { dist[w] = dist[v] + 1; queue[qt++] = w; }
        if (dist[w] === dist[v] + 1) { sigma[w] += sigma[v]; preds[w].push(v); }
      }
    }
    while (sp > 0) {
      const w = stack[--sp];
      for (const v of preds[w]) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) bc[w] += delta[w];
    }
  }
  return bc;
}


// ---- 4. affect --------------------------------------------------------------------

const sia = vader.SentimentIntensityAnalyzer;

function measuredAffect(ctx) {
  if (ctx._affect) return ctx._affect;
  const { ds, map, truth } = ctx;
  const e = ds.events;
  const rows = [];
  const msgType = EVENT_TYPES.indexOf('message');
  const vis = c => (c >= 0 ? VISIBILITY[ds.contexts.visibility[c]] : 'unknown');
  for (let i = 0; i < e.count; i++) {
    if (e.type[i] !== msgType || !e.text[i]) continue;
    const p = map.toTruth[e.actor[i]];
    if (p < 0) continue;
    const g = truth.communities?.membership?.[p] ?? -1;
    rows.push({ p, g, t: e.t[i], s: sia.polarity_scores(e.text[i]).compound, vis: vis(e.context[i]) });
  }
  ctx._affect = rows;
  return rows;
}

function affectChecks(ctx) {
  const { truth, results } = ctx;
  const exps = truth.affect?.expectations || [];
  if (!exps.length) return;
  const given = normalizeAffect(results.affect, truth);
  const rows = measuredAffect(ctx);
  if (!rows.length && !given) {
    for (const x of exps) add(ctx, { id: 'affect-' + x.kind, name: x.description, area: 'content', planted: `difference ${x.plantedDelta}`, recovered: null, metric: 'mean VADER compound', value: null, verdict: 'not checked', says: 'The dataset has no message text (content: none), so affect cannot be measured.' });
    return;
  }
  for (const x of exps) {
    if (x.kind === 'group-difference') {
      let hi, lo, src = 'VADER on the dataset text', test = null;
      if (given && given.has(x.high) && given.has(x.low)) { hi = given.get(x.high); lo = given.get(x.low); src = 'the given affect results'; }
      else { const A = rows.filter(r => r.g === x.high).map(r => r.s), B = rows.filter(r => r.g === x.low).map(r => r.s); hi = mean(A); lo = mean(B); test = welch(A, B); }
      const d = hi - lo;
      const ok = d > 0.03 && (!test || test.p < 0.05);
      add(ctx, { id: 'affect-groups', name: x.description, area: 'content', planted: `valence gap ${x.plantedDelta}`, recovered: `measured gap ${r3(d)}`, metric: 'difference in mean tone (VADER compound)', value: r3(d), baseline: 0,
        verdict: ok ? 'recovered' : d > 0 ? 'partly' : 'missed',
        says: `Measured with ${src}: ${x.highName} ${r3(hi)} vs ${x.lowName} ${r3(lo)}${test ? ` (two-sample test, ${pText(test.p)})` : ''}. The planted direction is ${ok ? 'clearly' : d > 0 ? 'weakly' : 'not'} visible.` });
    } else if (x.kind === 'public-private') {
      const A = rows.filter(r => r.vis === 'public').map(r => r.s), B = rows.filter(r => r.vis !== 'public' && r.vis !== 'unknown').map(r => r.s);
      if (!A.length || !B.length) { add(ctx, { id: 'affect-visibility', name: x.description, area: 'content', planted: `gap ${x.plantedDelta}`, recovered: null, metric: 'public minus private', value: null, verdict: 'not checked', says: 'The observed data has only one of public or private messages.' }); continue; }
      const d = mean(A) - mean(B), test = welch(A, B);
      const same = Math.sign(d) === Math.sign(x.plantedDelta) && test.p < 0.05;
      add(ctx, { id: 'affect-visibility', name: x.description, area: 'content', planted: `public minus private ${x.plantedDelta}`, recovered: `measured ${r3(d)}`, metric: 'tone in public minus private (VADER compound)', value: r3(d), baseline: 0,
        verdict: same ? 'recovered' : Math.sign(d) === Math.sign(x.plantedDelta) ? 'partly' : 'missed',
        says: `Public messages average ${r3(mean(A))}, private ${r3(mean(B))} (two-sample test, ${pText(test.p)}).` });
    } else if (x.kind === 'shift') {
      const who = x.people ? new Set(x.people) : null;
      const sel = rows.filter(r => (who ? who.has(r.p) : r.g === x.group));
      const until = x.until ?? Infinity;
      const before = sel.filter(r => r.t < x.t).map(r => r.s), after = sel.filter(r => r.t >= x.t && r.t < until).map(r => r.s);
      if (before.length < 5 || after.length < 5) { add(ctx, { id: 'affect-shift', name: x.description, area: 'content', planted: `shift ${x.plantedDelta} on ${day(x.t)}`, recovered: null, metric: 'after minus before', value: null, verdict: 'not checked', says: 'Too few messages from the affected people on one side of the shift.' }); continue; }
      const d = mean(after) - mean(before), test = welch(after, before);
      const ok = Math.sign(d) === Math.sign(x.plantedDelta) && test.p < 0.05;
      add(ctx, { id: 'affect-shift', name: `${x.description}${Number.isInteger(x.group) && ctx.truth.communities?.names?.[x.group] ? ` (${ctx.truth.communities.names[x.group]})` : ''}, ${day(x.t)}`, area: 'content', planted: `shift ${x.plantedDelta} on ${day(x.t)}`, recovered: `measured ${r3(d)}`, metric: 'tone after minus before (VADER compound)', value: r3(d), baseline: 0,
        verdict: ok ? 'recovered' : Math.sign(d) === Math.sign(x.plantedDelta) ? 'partly' : 'missed',
        says: `The mean tone (sentiment) of the affected people moves from ${r3(mean(before))} to ${r3(mean(after))} (two-sample test, ${pText(test.p)}).` });
    }
  }
}

function normalizeAffect(a, truth) {
  if (!a || typeof a !== 'object') return null;
  const names = truth.communities?.names || [];
  const idx = new Map(names.map((n, i) => [norm(n), i]));
  const out = new Map();
  const put = (k, v) => { const i = typeof k === 'number' && k < names.length ? k : idx.get(norm(k)); if (i !== undefined && Number.isFinite(v)) out.set(i, v); };
  const val = o => o.mean ?? o.compound ?? o.score ?? o.valence ?? o.value;
  const list = Array.isArray(a) ? a : Array.isArray(a.groups) ? a.groups : null;
  if (list) for (const o of list) put(o.group ?? o.key ?? o.name ?? o.value, val(o));
  else if (a.byGroup) for (const [k, v] of Object.entries(a.byGroup)) put(k, typeof v === 'object' ? val(v) : v);
  return out.size ? out : null;
}

// ---- 5. temporal shifts -------------------------------------------------------------

function shiftChecks(ctx) {
  const { truth, results } = ctx;
  const planted = (truth.events || []).filter(e => ['departure', 'reorg', 'silo', 'quiet', 'consolidation', 'bot-campaign', 'layoff'].includes(e.type) && e.t > truth.timespan.start && e.t < truth.timespan.end);
  if (!planted.length) return;
  const raw = results.shifts?.shifts || results.shifts?.changePoints || results.shifts;
  // The analysis engine reports a shift with `start` (window start, ms) and `window` (an index), so
  // read explicit times first and only parse strings.
  const when = s => {
    if (typeof s === 'number') return s;
    const v = s.t ?? s.time ?? s.date ?? s.at ?? s.start;
    return typeof v === 'number' ? v : Date.parse(v);
  };
  const det = Array.isArray(raw) ? raw.map(when).filter(Number.isFinite) : null;
  const tol = Math.max(7 * DAY, 0.1 * (truth.timespan.end - truth.timespan.start));
  // de-duplicate planted events at the same time (e.g. several departures)
  const uniq = [];
  for (const e of planted) if (!uniq.some(u => Math.abs(u.t - e.t) < DAY && u.type === e.type)) uniq.push(e);
  for (const e of uniq) {
    if (!det) { add(ctx, { id: 'shift-' + e.type, name: `Planted ${e.type} on ${day(e.t)}`, area: 'time', planted: e.description, recovered: null, metric: 'days from nearest detected shift', value: null, verdict: 'not checked', says: 'No detected shifts were given.' }); continue; }
    const near = det.length ? Math.min(...det.map(t => Math.abs(t - e.t))) : Infinity;
    const nd = Math.round(near / DAY), td = Math.round(tol / DAY);
    add(ctx, { id: 'shift-' + e.type, name: `Planted ${e.type} on ${day(e.t)}`, area: 'time', planted: e.description, recovered: Number.isFinite(near) ? `nearest detected shift ${days(nd)} away` : 'no shift detected',
      metric: `days to the nearest detected shift (tolerance ${td})`, value: Number.isFinite(near) ? r3(near / DAY) : null, baseline: null,
      verdict: near <= tol ? 'recovered' : near <= 2 * tol ? 'partly' : 'missed',
      says: near <= tol ? `A shift was detected ${nd ? `within ${days(nd)}` : 'on the day'} of the planted ${e.type} (tolerance ${days(td)}).` : `No detected shift falls within ${days(td)} of the planted ${e.type}.` });
  }
}

// ---- 6. diffusion -----------------------------------------------------------------

function diffusionChecks(ctx) {
  const { truth, ds, map, results } = ctx;
  const cascades = truth.diffusion?.cascades || [];
  if (!cascades.length) return;
  const T = truth.ties, n = truth.people.count;
  const nbrs = Array.from({ length: n }, () => []);
  for (let i = 0; i < T.count; i++) { nbrs[T.a[i]].push(T.b[i]); nbrs[T.b[i]].push(T.a[i]); }
  const given = normalizeDiffusion(results.diffusion);
  const e = ds.events;
  for (const c of cascades) {
    // observed first use per person from the dataset text (independent of any analysis)
    const re = new RegExp(`\\b${c.term}\\b`, 'i');
    const first = new Map();
    for (let i = 0; i < e.count; i++) {
      const tx = e.text[i];
      if (!tx || !re.test(tx)) continue;
      const p = map.toTruth[e.actor[i]];
      if (p < 0) continue;
      if (!(first.get(p) <= e.t[i])) first.set(p, e.t[i]);
    }
    const planted = new Map(c.adopters.map(a => [a.node, a.t]));
    let detected = first;
    let src = 'term use in the dataset text';
    if (given && given.has(c.term)) {
      detected = new Map();
      for (const a of given.get(c.term)) { const p = map.toTruth[a.node] ?? -1; if (p >= 0) detected.set(p, a.t); }
      src = 'the given diffusion results';
    }
    if (!detected.size) {
      add(ctx, { id: 'diffusion-' + c.term, name: `Spread of "${c.term}"`, area: 'diffusion', planted: `${c.adopters.length} adopters, first user ${truth.people.labels[c.seed]}`, recovered: 'no users found', metric: 'adopter recall', value: 0, verdict: ctx.ds.events.text.some(Boolean) ? 'missed' : 'not checked', says: ctx.ds.events.text.some(Boolean) ? 'Nobody in the observed data uses the term.' : 'The dataset has no text.' });
      continue;
    }
    let tp = 0;
    for (const p of detected.keys()) if (planted.has(p)) tp++;
    // recall against the people who actually wrote the term somewhere (not every adopter writes)
    const writers = new Set((c.users || []).map(u => u.node));
    let tpW = 0; for (const p of detected.keys()) if (writers.has(p)) tpW++;
    const recall = tpW / Math.max(1, writers.size);
    const precision = tp / detected.size;
    // Spread along ties: share of later users who have a true neighbour that used the term earlier,
    // against the same share when first-use times are shuffled among the users.
    const order = [...detected].sort((a, b) => a[1] - b[1]);
    const tieShare = ord => {
      let ok = 0, tot = 0;
      const when = new Map(ord);
      for (let k = 1; k < ord.length; k++) { tot++; const [p, t] = ord[k]; if (nbrs[p].some(q => when.has(q) && when.get(q) < t)) ok++; }
      return tot ? ok / tot : NaN;
    };
    const obsShare = tieShare(order);
    const rng = new Rng('diffusion-null:' + c.term);
    let nullSum = 0, reps = 0;
    const people = order.map(x => x[0]), times = order.map(x => x[1]);
    for (let k = 0; k < 100; k++) { const sh = rng.shuffle(times.slice()); const o = people.map((p, j) => [p, sh[j]]).sort((a, b) => a[1] - b[1]); const s = tieShare(o); if (Number.isFinite(s)) { nullSum += s; reps++; } }
    const nullShare = reps ? nullSum / reps : NaN;
    const seedRank = order.findIndex(x => x[0] === c.seed);
    const seedFirst = seedRank === 0;
    const seedEarly = seedRank >= 0 && seedRank < Math.max(2, Math.ceil(order.length * 0.05));
    const rho = spearman([...detected].filter(([p]) => planted.has(p)).map(([p, t]) => [planted.get(p), t]));
    ctx.details['diffusion:' + c.term] = { planted: planted.size, writers: c.users?.length ?? null, detected: detected.size, truePositives: tp, tieShare: obsShare, nullTieShare: nullShare, seedFirst, spearman: rho };
    const along = obsShare > nullShare + 0.05;
    if (detected.size < 3) {
      add(ctx, { id: 'diffusion-' + c.term, name: `Spread of "${c.term}"`, area: 'diffusion', planted: `${planted.size} adopters, first user ${truth.people.labels[c.seed]}`, recovered: `${detected.size} users found`, metric: 'users found', value: detected.size, verdict: 'not checked', says: 'Too few people use the term in the observed data to judge how it spread.' });
      continue;
    }
    // Little room: when shuffled timing already gives nearly every later user
    // an earlier-using neighbor, the comparison cannot show much (N8).
    const ceiling = nullShare >= 0.85;
    add(ctx, {
      id: 'diffusion-' + c.term, name: `Spread of "${c.term}" along true ties`, area: 'diffusion',
      planted: `${planted.size} adopters, first user ${truth.people.labels[c.seed]}`, recovered: `${detected.size} users found (${src}), ${tp} of them planted adopters`,
      metric: 'share of later users with an earlier-using true neighbor', value: r3(obsShare), baseline: r3(nullShare),
      verdict: precision >= 0.6 && along && seedEarly ? 'recovered' : precision >= 0.25 && (along || seedEarly) ? 'partly' : 'missed',
      says: `${seedFirst ? 'The planted first user is the first user found' : seedEarly ? `The planted first user is user number ${seedRank + 1} found` : 'The planted first user is not among the first users found'}; ${pct(obsShare)} of later users had an earlier user among their true ties, against ${pct(nullShare)} when the times are shuffled. ${pct(precision)} of the users found are planted adopters (precision), and they include ${pct(recall)} of the people who wrote the term (recall)${Number.isFinite(rho) ? `; adoption order matches with rank correlation ${r3(rho)}` : ''}. This check uses the true ties, which the Diffusion view cannot see: it uses the ties in the data, so the two can disagree.${ceiling ? ` Shuffled timing already reaches ${pct(nullShare)}, so there is little room to show spread along ties either way.` : ''}`,
    });
  }
}

function normalizeDiffusion(d) {
  if (!d) return null;
  const out = new Map();
  if (typeof d !== 'object') return null;
  // Engine shape: { terms: [{ term, adopters: <count>, adoptions: [{ node, t }] }] }.
  const list = Array.isArray(d) ? d : Array.isArray(d.terms) ? d.terms : Array.isArray(d.cascades) ? d.cascades : null;
  const adopt = a => (Array.isArray(a) ? a : []).map(x => ({ node: x.node ?? x.id ?? x.index, t: x.t ?? x.time ?? x.firstUse }));
  const pick = v => (Array.isArray(v.adoptions) ? v.adoptions : Array.isArray(v.adopters) ? v.adopters : Array.isArray(v.users) ? v.users : Array.isArray(v) ? v : []);
  if (list) for (const c of list) out.set(c.term, adopt(pick(c)));
  else for (const [term, v] of Object.entries(d)) if (v && typeof v === 'object') out.set(term, adopt(pick(v)));
  return out.size ? out : null;
}

// ---- 7. surveys: reported vs true ties ------------------------------------------

function surveyChecks(ctx) {
  const { truth, ds, map } = ctx;
  const rec = truth.recall;
  if (!rec) return;
  const T = truth.ties, n = truth.people.count;
  const N = truth.params?.size ?? n;
  const has = new Set();
  for (let i = 0; i < T.count; i++) { has.add(T.a[i] * n + T.b[i]); has.add(T.b[i] * n + T.a[i]); }
  const strong = new Set();
  for (let i = 0; i < T.count; i++) if (T.w[i] >= 2) { strong.add(T.a[i] * n + T.b[i]); strong.add(T.b[i] * n + T.a[i]); }
  const e = ds.events;
  const decl = EVENT_TYPES.indexOf('declared');
  const declRole = ROLES.indexOf('declared');
  // A nomination is made in the respondent's own interview (or the roster survey);
  // other declared ties in an interview are the respondent's perception of alter-alter ties.
  const ownKey = new Map();
  ds.contexts.keys.forEach((k, c) => { const m = /interview-(\d+)$/.exec(k); if (m) ownKey.set(c, +m[1]); });
  const isNomination = (i, a) => !ownKey.has(e.context[i]) || ownKey.get(e.context[i]) === a;
  if (rec.variant === 'perceived') {
    // per informant: context = one informant's report
    const byCtx = new Map();
    for (let i = 0; i < e.count; i++) {
      if (e.type[i] !== decl) continue;
      const a = map.toTruth[e.actor[i]];
      for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) {
        if (e.role[j] !== declRole) continue;
        const b = map.toTruth[e.tgt[j]];
        if (a < 0 || b < 0) continue;
        if (!byCtx.has(e.context[i])) byCtx.set(e.context[i], new Set());
        byCtx.get(e.context[i]).add(Math.min(a, b) * n + Math.max(a, b));
      }
    }
    let trueRoster = 0;
    for (let i = 0; i < T.count; i++) if (T.a[i] < N && T.b[i] < N) trueRoster++;
    const accs = [];
    for (const [, set] of byCtx) { let hit = 0; for (const k of set) if (has.has(k)) hit++; accs.push({ recall: hit / Math.max(1, trueRoster), precision: hit / Math.max(1, set.size) }); }
    // consensus (locally aggregated would need self-reports; use majority of informants)
    const votes = new Map();
    for (const [, set] of byCtx) for (const k of set) votes.set(k, (votes.get(k) || 0) + 1);
    const need = Math.ceil(byCtx.size / 2);
    let cHit = 0, cAll = 0;
    for (const [k, v] of votes) if (v >= need) { cAll++; if (has.has(k)) cHit++; }
    const consRecall = cHit / Math.max(1, trueRoster), consPrec = cHit / Math.max(1, cAll);
    ctx.details.survey = { variant: 'perceived', informants: accs, consensus: { recall: consRecall, precision: consPrec } };
    add(ctx, { id: 'survey-perceived', name: 'Perceived networks vs true network', area: 'survey', planted: `${trueRoster} true roster ties, ${byCtx.size} informants`,
      recovered: `informant recall ${r3(mean(accs.map(a => a.recall)))}, precision ${r3(mean(accs.map(a => a.precision)))}; majority consensus recall ${r3(consRecall)}, precision ${r3(consPrec)}`,
      metric: 'consensus recall', value: r3(consRecall), baseline: r3(mean(accs.map(a => a.recall))),
      verdict: consRecall >= 0.5 && consPrec >= 0.7 ? 'recovered' : consPrec >= 0.5 ? 'partly' : 'missed',
      says: `Single informants see ${pct(mean(accs.map(a => a.recall)))} of true ties on average; agreeing informants (majority) see ${pct(consRecall)} with ${pct(consPrec)} of their reported ties real.` });
    return;
  }
  // ego interviews and roster: nominations by respondents
  let tpS = 0, tpW = 0, fp = 0, outside = 0, total = 0;
  const respondents = new Set();
  for (let i = 0; i < e.count; i++) {
    if (e.type[i] !== decl) continue;
    const a = map.toTruth[e.actor[i]];
    if (a < 0 || a >= N || !isNomination(i, a)) continue;
    for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) {
      const b = map.toTruth[e.tgt[j]];
      if (b < 0) { outside++; total++; continue; }
      if (a === b || !isNomination(i, a)) continue;
      respondents.add(a);
      total++;
      const k = a * n + b;
      if (b >= N) { outside++; continue; }
      if (has.has(k)) { if (strong.has(k)) tpS++; else tpW++; } else fp++;
    }
  }
  let trueS = 0, trueW = 0;
  for (const a of respondents) for (let i = 0; i < T.count; i++) {
    const x = T.a[i], y = T.b[i];
    if ((x === a && y < N) || (y === a && x < N)) { if (T.w[i] >= 2) trueS++; else trueW++; }
  }
  const recS = trueS ? tpS / trueS : null, recW = trueW ? tpW / trueW : null;
  const prec = total ? (tpS + tpW) / Math.max(1, total - outside) : null;
  ctx.details.survey = { variant: rec.variant, respondents: respondents.size, recallStrong: recS, recallWeak: recW, precision: prec, falsePositives: fp, outsideRoster: outside, planted: rec.stats };
  add(ctx, { id: 'survey-recall', name: 'Reported ties vs true ties', area: 'survey', planted: `forget weak ${rec.params.forgetWeak}, strong ${rec.params.forgetStrong}, max names ${rec.params.maxNames || 'none'}`,
    recovered: `recall strong ${r3(recS)}, weak ${r3(recW)}; precision ${r3(prec)}; ${outside} names outside the roster`,
    metric: 'recall strong minus weak', value: recS != null && recW != null ? r3(recS - recW) : null, baseline: 0,
    verdict: recS != null && recW != null && recS > recW ? 'recovered' : 'partly',
    says: `Respondents reported ${pct(recS)} of their strong ties and ${pct(recW)} of their weak ties; ${pct(prec)} of named roster people are true ties. Weak ties are under-reported, as planted.` });
}

// ---- small stats ---------------------------------------------------------------

function mean(a) { if (!a.length) return NaN; let s = 0; for (const x of a) s += x; return s / a.length; }
function variance(a, m) { let s = 0; for (const x of a) s += (x - m) ** 2; return a.length > 1 ? s / (a.length - 1) : 0; }
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; }
function pct(x) { return x == null || !Number.isFinite(x) ? 'n/a' : `${Math.round(x * 100)}%`; }
// "24 Feb 2025", as every view writes dates.
function day(t) { return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); }
const days = n => `${n} ${n === 1 ? 'day' : 'days'}`;

// Welch t-test with a normal approximation to the p-value (fine for the sample sizes here).
export function welch(A, B) {
  const ma = mean(A), mb = mean(B);
  const va = variance(A, ma), vb = variance(B, mb);
  const se = Math.sqrt(va / Math.max(1, A.length) + vb / Math.max(1, B.length));
  if (!(se > 0)) return { t: 0, p: 1 };
  const t = (ma - mb) / se;
  return { t, p: 2 * (1 - phi(Math.abs(t))) };
}
function phi(x) { // standard normal CDF (Abramowitz-Stegun 26.2.17)
  const t = 1 / (1 + 0.2316419 * x);
  const d = 0.3989423 * Math.exp(-x * x / 2);
  return 1 - d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
}
// Spearman's rho with average ranks for ties (betweenness has many exact zeros,
// so arbitrary tie-breaking would bias it).
function spearman(pairs) {
  if (pairs.length < 3) return NaN;
  const rank = vals => {
    const idx = vals.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
    const r = new Array(vals.length);
    for (let i = 0; i < idx.length;) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(pairs.map(p => p[0])), rb = rank(pairs.map(p => p[1]));
  const ma = mean(ra), mb = mean(rb);
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2; }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}
