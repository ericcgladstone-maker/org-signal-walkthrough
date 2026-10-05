// Ground truth: everything planted, before observation, in a structured-
// cloneable object (plain objects, arrays and typed arrays only).
//
// While records stream past, an accumulator tallies the planted valence of
// every message by group, visibility and period (before/after each planted
// event), so ground truth can say what affect differences an analysis should
// find in the text, not just what the plan intended.

import { round } from './contexts/common.js';

export function makeTruthAccumulator(world) {
  const cuts = [...new Set(world.events.filter(e => e.t > world.span.start && e.t < world.span.end).map(e => e.t))].sort((a, b) => a - b);
  const periods = [world.span.start, ...cuts, world.span.end];
  const G = world.groups.length;
  const P = periods.length - 1;
  const sum = new Float64Array((G + 1) * 2 * P), cnt = new Float64Array((G + 1) * 2 * P);
  const termUse = new Map(); // term -> Map(person -> first use t)
  let messages = 0, withText = 0;
  const periodOf = t => { let k = 0; while (k + 1 < P && t >= periods[k + 1]) k++; return k; };
  return {
    periods,
    add(rec) {
      if (rec.kind !== 'message' || rec.actor < 0) return;
      messages++;
      if (rec.text) withText++;
      if (rec.valence !== undefined) {
        const g = world.group ? world.group[rec.actor] : -1;
        const gi = g >= 0 && g < G ? g : G;
        const vi = rec.vis === 'public' ? 0 : 1;
        const k = (gi * 2 + vi) * P + periodOf(rec.t);
        sum[k] += rec.valence; cnt[k]++;
      }
      if (rec.terms) for (const term of rec.terms) {
        let m = termUse.get(term);
        if (!m) termUse.set(term, (m = new Map()));
        const prev = m.get(rec.actor);
        if (prev === undefined || rec.t < prev) m.set(rec.actor, rec.t);
      }
    },
    summary() {
      const cells = [];
      for (let gi = 0; gi <= G; gi++) for (let vi = 0; vi < 2; vi++) for (let p = 0; p < P; p++) {
        const k = (gi * 2 + vi) * P + p;
        if (cnt[k]) cells.push({ group: gi < G ? gi : -1, groupName: gi < G ? world.groups[gi].name : null, visibility: vi ? 'private' : 'public', period: p, from: periods[p], until: periods[p + 1], messages: cnt[k], meanValence: round(sum[k] / cnt[k]) });
      }
      return { periods, cells, messages, withText };
    },
    termUse,
  };
}

export function buildGroundTruth({ world, spec, ident, obs, ctx, acc, rhythm, keptEvents }) {
  const n = world.n;
  const names = world.groups.map(g => g.name);
  const affectSummary = acc.summary();
  const truth = {
    version: 1,
    spec: jsonSafe(spec),
    context: world.context, medium: spec.medium, preset: world.preset, params: world.params, notes: world.notes,
    timespan: { start: world.span.start, end: world.span.end },
    people: {
      count: n, keys: ident.key.slice(), labels: world.people.label.slice(), attrs: world.people.attrs,
      isBot: Uint8Array.from(world.isBot), leftAt: Float64Array.from(world.leftAt, x => (x === Infinity ? NaN : x)),
      platformIds: ident.platformIds,
    },
    communities: { attr: world.groupAttr || 'group', membership: Int32Array.from(world.group), names, kinds: world.groups.map(g => g.kind) },
    ties: { ...world.ties.freeze(), note: 'Endpoints are person indices; from/until NaN = whole timespan.' },
    hierarchy: world.hierarchy ? { root: world.hierarchy.root, manager: Int32Array.from(world.hierarchy.manager), managerAfter: world.hierarchy.managerAfter ? Int32Array.from(world.hierarchy.managerAfter) : null } : null,
    bridges: {
      brokers: (world.brokers || []).slice(),
      brokerKeys: (world.brokers || []).map(i => ident.key[i]),
      ties: (world.bridgeTies || []).map(ti => [world.ties.a[ti], world.ties.b[ti]]),
    },
    events: world.events.map(e => ({ ...e, personKey: e.person != null ? ident.key[e.person] : undefined })),
    affect: { plan: world.affect ? world.affect.toJSON(names) : null, observed: affectSummary, expectations: affectExpectations(world, affectSummary) },
    topics: world.topics ? { byGroup: (world.topics.byGroup || []).map((w, g) => ({ group: g, name: names[g], words: w })), bySpace: world.topics.bySpace || null } : null,
    diffusion: world.diffusion ? diffusionTruth(world, ident, acc) : null,
    recall: world.recall || null,
    rhythm: { kind: rhythm.kind, bursts: rhythm.burstDays },
    observation: {
      view: obs.view, ego: obs.ego, egoKey: obs.ego >= 0 ? ident.key[obs.ego] : null, egoLabel: obs.ego >= 0 ? world.people.label[obs.ego] : null,
      chat: obs.chat, rate: obs.view === 'sample' ? obs.rate : null, sampled: obs.sampled || null,
      keptEvents, totalRecords: ctx.count,
    },
    counts: { people: n, ties: world.ties.count, records: ctx.count, byKind: ctx.stats.byKind, spaces: ctx.spaces.length },
    spaces: ctx.spaces.length <= 5000 ? ctx.spaces.map(s => ({ key: s.key, name: s.name, kind: s.kind, visibility: s.visibility, size: s.members.length, group: s.group ?? null })) : null,
  };
  return truth;
}

function diffusionTruth(world, ident, acc) {
  return {
    cascades: world.diffusion.cascades.map(c => {
      const used = acc.termUse.get(c.term) || new Map();
      return {
        term: c.term, seed: c.seed, seedKey: ident.key[c.seed], t0: c.t0,
        adopters: c.adopters.map(a => ({ node: a.node, key: ident.key[a.node], t: a.t, from: a.from })),
        // who actually wrote the term, and when first: what text analysis can see
        users: [...used].map(([node, t]) => ({ node, key: ident.key[node], firstUse: t })).sort((a, b) => a.firstUse - b.firstUse),
      };
    }),
    params: world.diffusion.params,
  };
}

// Plain statements of what an analysis should find in the affect of the text.
function affectExpectations(world, summary) {
  const out = [];
  const byGroup = new Map();
  for (const c of summary.cells) {
    if (c.group < 0) continue;
    const g = byGroup.get(c.group) || { s: 0, n: 0 };
    g.s += c.meanValence * c.messages; g.n += c.messages; byGroup.set(c.group, g);
  }
  const groups = [...byGroup].filter(([, g]) => g.n >= 20).map(([gi, g]) => ({ group: gi, name: world.groups[gi].name, mean: g.s / g.n, n: g.n })).sort((a, b) => b.mean - a.mean);
  if (groups.length >= 2) {
    const hi = groups[0], lo = groups[groups.length - 1];
    out.push({ kind: 'group-difference', high: hi.group, highName: hi.name, low: lo.group, lowName: lo.name, plantedDelta: round(hi.mean - lo.mean), description: `${hi.name} writes more positively than ${lo.name}` });
  }
  let pub = { s: 0, n: 0 }, priv = { s: 0, n: 0 };
  for (const c of summary.cells) { const x = c.visibility === 'public' ? pub : priv; x.s += c.meanValence * c.messages; x.n += c.messages; }
  if (pub.n >= 20 && priv.n >= 20) {
    const d = pub.s / pub.n - priv.s / priv.n;
    if (Math.abs(d) >= 0.1) out.push({ kind: 'public-private', plantedDelta: round(d), description: d > 0 ? 'Public messages are more positive than private ones' : 'Private messages are more positive than public ones' });
  }
  for (const e of world.events) {
    if (e.type !== 'affect-shift') continue;
    out.push({ kind: 'shift', t: e.t, group: e.group ?? null, groupName: e.groupName ?? null, people: e.people ?? null, plantedDelta: e.delta, description: e.description });
  }
  return out;
}

function jsonSafe(spec) {
  const out = {};
  for (const [k, v] of Object.entries(spec)) if (typeof v !== 'function') out[k] = v;
  return out;
}
