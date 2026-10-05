// Survey context: a bounded roster (a class or a team) with true friendship
// ties, from which survey answers are simulated with realistic error:
//   recall      respondents forget weak ties more than strong ones; a roster
//               (recognition) format forgets less than free recall;
//   fixed choice a cap on names drops the weakest named ties;
//   false positives  some named people are not true ties (often friends of friends);
//   boundary    free recall names people outside the roster (true ties the
//               roster does not cover);
//   non-response some respondents do not answer;
//   perception  in cognitive social structure designs, several informants
//               report the whole network; accuracy falls with social distance
//               and errors lean toward closing triads within one's own group.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames } from '../names.js';

export const schema = [
  { key: 'size', label: 'Roster size', type: 'int', min: 6, max: 400, default: 30 },
  { key: 'groups', label: 'Friend groups', type: 'int', min: 1, max: 12, default: 3 },
  { key: 'variant', label: 'Design', type: 'enum', values: ['ego-interview', 'roster-matrix', 'perceived'], default: 'roster-matrix' },
  { key: 'maxNames', label: 'Maximum names (0 = unlimited)', type: 'int', min: 0, max: 30, default: 5 },
  { key: 'forgetWeak', label: 'Chance a weak tie is forgotten', type: 'number', min: 0, max: 0.95, default: 0.4 },
  { key: 'forgetStrong', label: 'Chance a strong tie is forgotten', type: 'number', min: 0, max: 0.6, default: 0.08 },
  { key: 'falsePositive', label: 'False names per respondent (mean)', type: 'number', min: 0, max: 3, default: 0.3 },
  { key: 'boundary', label: 'Chance a respondent names someone outside the roster', type: 'number', min: 0, max: 0.9, default: 0.25 },
  { key: 'nonResponse', label: 'Non-response rate', type: 'number', min: 0, max: 0.6, default: 0.1 },
  { key: 'informants', label: 'Informants (perceived design)', type: 'int', min: 1, max: 60, default: 5 },
  { key: 'withinGroupTie', label: 'Chance of a tie within a friend group', type: 'number', min: 0.05, max: 0.95, default: 0.45 },
  { key: 'crossGroupTie', label: 'Chance of a tie across groups', type: 'number', min: 0, max: 0.3, default: 0.04 },
];
export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));
export const presets = {
  classroom: { label: 'Classroom: three friend groups, roster matrix', params: {} },
  'team-interviews': { label: 'Team interviews: free-recall name generator, Network Canvas export', params: { variant: 'ego-interview', maxNames: 0, size: 18, groups: 2 } },
  'perceived-network': { label: 'Perceived network: five informants report everyone (cognitive social structure)', params: { variant: 'perceived', size: 21 } },
};
export const media = ['survey', 'network'];
export const timespanDefaults = { start: '2025-09-15', days: 14 };
export const observations = ['full'];

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : 'classroom';
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  if (spec.variant) params.variant = spec.variant;
  applySchemaBounds(schema, params, notes);
  const r = rng.fork('survey');
  const N = params.size;
  const G = Math.min(params.groups, Math.max(1, Math.floor(N / 4)));
  if (G !== params.groups) notes.push(`groups reduced to ${G}`);
  params.groups = G;
  if (params.variant === 'perceived' && params.informants > N) params.informants = N;

  // Roster people first; boundary (outside) alters are appended later.
  const names = makePeopleNames(r.fork('names'), N + 60);
  const group = [], attrs = [];
  for (let i = 0; i < N; i++) {
    group.push(i % G);
    attrs.push({ roster: true, gender: r.chance(0.5) ? 'F' : 'M', age: r.intRange(14, 16), friend_group: `Group ${'ABCDEFGHIJKL'[i % G]}` });
  }
  const tiesList = [];
  for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
    const same = group[a] === group[b];
    let p = same ? params.withinGroupTie : params.crossGroupTie;
    if (attrs[a].gender === attrs[b].gender) p *= 1.3;
    if (r.chance(Math.min(0.95, p))) tiesList.push([a, b, same && r.chance(0.55) ? 2 : 1]);
  }
  // Outside alters: true ties beyond the roster boundary.
  const outside = [];
  for (let i = 0; i < N; i++) for (let k = r.poisson(params.boundary * 1.5); k > 0; k--) {
    const o = N + outside.length;
    if (o >= names.label.length) break;
    outside.push(o);
    group.push(-1);
    attrs.push({ roster: false, gender: r.chance(0.5) ? 'F' : 'M', friend_group: 'outside roster', knows: names.label[i] });
    tiesList.push([i, o, r.chance(0.4) ? 2 : 1]);
  }
  const n = N + outside.length;
  const ties = new TieTable(n);
  for (const [a, b, w] of tiesList) ties.add(a, b, { w, kind: b >= N ? 'outside' : w === 2 ? 'strong' : 'weak' });

  const world = {
    context: 'survey', preset: presetId, params, notes, span, n, rosterSize: N,
    domain: 'school.example',
    people: { label: names.label.slice(0, n), first: names.first.slice(0, n), last: names.last.slice(0, n), attrs, email: [] },
    isBot: new Uint8Array(n), group: Int32Array.from(group),
    groups: Array.from({ length: G }, (_, g) => ({ name: `Group ${'ABCDEFGHIJKL'[g]}`, kind: 'friend group' })),
    groupAttr: 'friend_group',
    ties, brokers: [], bridgeTies: [],
    leftAt: new Float64Array(n).fill(Infinity), tzOffset: new Float32Array(n),
    rhythmKind: 'flat', events: [], rules: [], affect: new AffectPlan(), topics: {}, spaces: [], ego: -1,
  };
  world.recall = simulateReports(world, params, r.fork('reports'));
  return world;
}

// Turn true ties into what respondents say.
function simulateReports(world, params, r) {
  const N = world.rosterSize, ties = world.ties;
  const adj = ties.adjacency().out;
  const nbrs = i => { const o = []; for (let p = adj.off[i]; p < adj.off[i + 1]; p++) o.push([adj.nbr[p], ties.w[adj.tie[p]]]); return o; };
  const recognition = params.variant === 'roster-matrix';
  const forgetW = params.forgetWeak * (recognition ? 0.4 : 1), forgetS = params.forgetStrong * (recognition ? 0.5 : 1);
  const respondents = [];
  const stats = { truePositive: 0, falseNegative: 0, falsePositive: 0, boundaryNamed: 0, cappedOut: 0, nonResponse: 0, byStrength: { strong: { true: 0, named: 0 }, weak: { true: 0, named: 0 } } };
  const out = { variant: params.variant, params: { ...params }, respondents, stats, perceived: null };
  if (params.variant === 'perceived') {
    out.perceived = perceive(world, params, r);
    return out;
  }
  for (let i = 0; i < N; i++) {
    if (r.chance(params.nonResponse)) { respondents.push({ person: i, responded: false, named: [] }); stats.nonResponse++; continue; }
    const named = [];
    for (const [j, w] of nbrs(i)) {
      const outsideAlter = j >= N;
      if (outsideAlter && recognition) continue; // a roster cannot list outsiders
      const strong = w >= 2;
      if (!outsideAlter) stats.byStrength[strong ? 'strong' : 'weak'].true++;
      const forgot = r.chance(strong ? forgetS : forgetW);
      if (!forgot) { named.push({ alter: j, truth: true, strength: w, closeness: strong ? r.intRange(4, 5) : r.intRange(2, 4) }); if (!outsideAlter) stats.byStrength[strong ? 'strong' : 'weak'].named++; }
    }
    // false positives: mostly friends of friends in the roster
    for (let k = r.poisson(params.falsePositive); k > 0; k--) {
      const fof = nbrs(i).flatMap(([j]) => (j < N ? nbrs(j).map(x => x[0]) : [])).filter(x => x !== i && x < N && !ties.has(i, x));
      const pool = fof.length && r.chance(0.7) ? fof : Array.from({ length: N }, (_, x) => x).filter(x => x !== i && !ties.has(i, x));
      if (!pool.length) break;
      const j = r.pick(pool);
      if (!named.some(x => x.alter === j)) named.push({ alter: j, truth: false, strength: 0, closeness: r.intRange(1, 3) });
    }
    // fixed choice: keep the closest names
    named.sort((a, b) => b.closeness - a.closeness || a.alter - b.alter);
    let capped = [];
    if (params.maxNames > 0 && named.length > params.maxNames) capped = named.splice(params.maxNames);
    for (const x of named) { if (x.truth) { if (x.alter >= N) stats.boundaryNamed++; else stats.truePositive++; } else stats.falsePositive++; }
    stats.cappedOut += capped.length;
    // alter-alter ties as the respondent perceives them (ego interviews only)
    let alterTies = null;
    if (params.variant === 'ego-interview') {
      alterTies = [];
      for (let a = 0; a < named.length; a++) for (let b = a + 1; b < named.length; b++) {
        const x = named[a].alter, y = named[b].alter;
        const real = ties.has(x, y);
        if (real ? r.chance(0.8) : r.chance(world.group[x] >= 0 && world.group[x] === world.group[y] ? 0.12 : 0.03)) alterTies.push({ a: x, b: y, truth: real });
      }
    }
    respondents.push({ person: i, responded: true, named, cappedOut: capped.map(x => x.alter), alterTies });
  }
  for (const s of ['strong', 'weak']) { const b = stats.byStrength[s]; b.recall = b.true ? round(b.named / b.true) : null; }
  let trueRoster = 0;
  for (let ti = 0; ti < ties.count; ti++) if (ties.b[ti] < N) trueRoster++;
  stats.trueRosterTies = trueRoster;
  return out;
}

// Cognitive social structure: each informant reports every tie they believe exists.
function perceive(world, params, r) {
  const N = world.rosterSize, ties = world.ties;
  const inf = r.sample([...Array(N).keys()], params.informants).sort((a, b) => a - b);
  const reports = [];
  for (const k of inf) {
    const mine = new Set(ties.neighbors(k).filter(x => x < N));
    const report = [];
    let hits = 0, misses = 0, fp = 0;
    for (let a = 0; a < N; a++) for (let b = a + 1; b < N; b++) {
      const real = ties.has(a, b);
      const involved = a === k || b === k;
      const near = (mine.has(a) ? 1 : 0) + (mine.has(b) ? 1 : 0);
      const sameGroup = world.group[a] === world.group[k] && world.group[b] === world.group[k];
      let p;
      if (real) p = involved ? 0.92 : near === 2 ? 0.78 : near === 1 ? 0.55 : sameGroup ? 0.45 : 0.25;
      else {
        const common = [...mine].some(c => ties.has(c, a) && ties.has(c, b)) || (mine.has(a) && mine.has(b));
        p = involved ? 0.01 : common ? 0.12 : sameGroup ? 0.05 : 0.004;
      }
      if (r.chance(p)) { report.push([a, b, real]); if (real) hits++; else fp++; } else if (real) misses++;
    }
    reports.push({ informant: k, ties: report, hits, misses, falsePositives: fp, recall: round(hits / Math.max(1, hits + misses)), precision: round(hits / Math.max(1, hits + fp)) });
  }
  return { informants: inf, reports };
}
