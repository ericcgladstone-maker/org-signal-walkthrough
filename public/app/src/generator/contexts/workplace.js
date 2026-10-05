// Workplace context: an organization with divisions (the function each
// department rolls up to) and departments, a reporting tree,
// teams, locations and tenure. True ties come from the hierarchy (manager and
// report), team membership, a department stochastic-block structure with
// location homophily and moderate degree inequality, a few cross-department
// ties, and planted brokers whose bridge ties span departments.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames, makeEmails, orgName, slug, CITIES } from '../names.js';
import { cumulative, drawCum } from '../rng.js';
import { DAY } from '../time.js';
import { DEPT_BASES } from '../vocab.js';

export const schema = [
  { key: 'size', label: 'People', type: 'int', min: 8, max: 50000, default: 120 },
  { key: 'departments', label: 'Departments (0 = automatic)', type: 'int', min: 0, max: 60, default: 0 },
  { key: 'spanOfControl', label: 'Reports per manager', type: 'int', min: 2, max: 15, default: 6 },
  { key: 'locations', label: 'Office locations', type: 'int', min: 1, max: 6, default: 3 },
  { key: 'avgDegree', label: 'Average true ties per person', type: 'number', min: 3, max: 40, default: 12 },
  { key: 'crossShare', label: 'Share of ties outside the department', type: 'number', min: 0, max: 0.5, default: 0.15 },
  { key: 'brokers', label: 'Planted brokers (-1 = automatic)', type: 'int', min: -1, max: 400, default: -1 },
  { key: 'locationHomophily', label: 'Location homophily (0-0.95)', type: 'number', min: 0, max: 0.95, default: 0.6 },
  { key: 'degreeInequality', label: 'Degree inequality (lognormal sigma)', type: 'number', min: 0, max: 1.2, default: 0.55 },
  { key: 'activity', label: 'Interactions per unit tie strength per week', type: 'number', min: 0.05, max: 10, default: 1.2 },
  { key: 'affectGap', label: 'How much more negative private talk is than public (0-0.8)', type: 'number', min: 0, max: 0.8, default: 0.15 },
];

export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));

export const presets = {
  distributed: { label: 'Distributed: many cross-department ties, no single point of failure', params: { crossShare: 0.25, brokers: -1 } },
  'bridge-dependent': { label: 'Bridge-dependent: departments joined by a few brokers; one leaves at 55%', params: { crossShare: 0.02 } },
  siloed: { label: 'Siloed: cross-department traffic collapses at 40%', params: { crossShare: 0.12 } },
  consolidating: { label: 'Consolidating: traffic concentrates on managers from 50%', params: { crossShare: 0.15 } },
  declining: { label: 'Declining: activity falls; one department goes quiet and sours at 50%', params: { crossShare: 0.15 } },
  'reorg-midpoint': { label: 'Reorg at midpoint: whole teams move department at 50%', params: { crossShare: 0.12 } },
};

export const media = ['slack', 'email', 'calendar', 'network'];
export const timespanDefaults = { start: '2025-01-06', days: 90 };

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : (spec.structure ? (notes.push(`unknown preset "${spec.structure}"; using distributed`), 'distributed') : 'distributed');
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  applySchemaBounds(schema, params, notes);
  const n = params.size;
  // Realistic combinations: departments of at least ~6 people, brokers a small minority.
  let D = params.departments || Math.round(Math.max(3, Math.min(40, Math.sqrt(n) / 1.6)));
  if (D > Math.floor(n / 6)) { const d2 = Math.max(2, Math.floor(n / 6)); if (params.departments) notes.push(`departments reduced from ${D} to ${d2} so each has at least 6 people`); D = d2; }
  params.departments = D;
  const L = Math.min(params.locations, Math.max(1, Math.floor(n / 8)), CITIES.length);
  if (L !== params.locations) notes.push(`locations reduced to ${L}`);
  params.locations = L;
  let B = params.brokers >= 0 ? params.brokers : Math.max(2, Math.round(D * (presetId === 'bridge-dependent' ? 1 : 0.5)));
  B = Math.min(B, Math.max(1, Math.floor(n / 10)));
  params.brokers = B;
  if (params.avgDegree > n / 2) { notes.push('avgDegree reduced to half the organization size'); params.avgDegree = Math.max(2, Math.floor(n / 2)); }

  const r = rng.fork('workplace');
  const names = makePeopleNames(r.fork('names'), n);
  const org = orgName(r.fork('org'));
  const domain = `${slug(org.split(' ')[0])}.example`;
  const emails = makeEmails(names.first, names.last, domain);
  const locs = CITIES.slice(0, L);

  // Departments: names from bases, uneven sizes.
  const deptNames = [];
  const used = new Set();
  for (let d = 0; d < D; d++) {
    const base = DEPT_BASES[d % DEPT_BASES.length];
    let name = base.name;
    if (d >= DEPT_BASES.length) name = `${base.name} ${['Americas', 'EMEA', 'APAC', 'North', 'South', 'Platform', 'Growth'][Math.floor(d / DEPT_BASES.length) - 1] || Math.floor(d / DEPT_BASES.length)}`;
    while (used.has(name)) name += ' II';
    used.add(name);
    deptNames.push({ name, base: base.id, division: base.division });
  }
  const dw = Array.from({ length: D }, () => r.lognormal(0, 0.35));
  const dwSum = dw.reduce((a, b) => a + b, 0);
  // person 0 is the CEO (group of department 0's leadership, recorded as its own attribute)
  const dept = new Int32Array(n);
  const counts = dw.map(w => Math.max(3, Math.floor(((n - 1) * w) / dwSum)));
  let tot = counts.reduce((a, b) => a + b, 0);
  while (tot > n - 1) { const i = counts.indexOf(Math.max(...counts)); counts[i]--; tot--; }
  while (tot < n - 1) { counts[r.int(D)]++; tot++; }
  let p = 1;
  const members = Array.from({ length: D }, () => []);
  for (let d = 0; d < D; d++) for (let k = 0; k < counts[d]; k++) { dept[p] = d; members[d].push(p); p++; }
  dept[0] = 0; // CEO sits with the first department for community purposes

  // Hierarchy: CEO -> department heads -> span-of-control tree within each department.
  const manager = new Int32Array(n).fill(-1);
  const depth = new Int32Array(n);
  const reports = Array.from({ length: n }, () => []);
  for (let d = 0; d < D; d++) {
    const m = members[d];
    const head = m[0];
    manager[head] = 0; depth[head] = 1; reports[0].push(head);
    const queue = [head];
    let qi = 0;
    for (let k = 1; k < m.length; k++) {
      const span = Math.max(2, Math.round(params.spanOfControl * r.range(0.7, 1.3)));
      while (reports[queue[qi]].length >= span) qi++;
      const boss = queue[qi];
      manager[m[k]] = boss; depth[m[k]] = depth[boss] + 1; reports[boss].push(m[k]);
      queue.push(m[k]);
    }
  }
  const maxDepth = Math.max(...depth);

  // Locations: each department has a home office.
  const deptLoc = Array.from({ length: D }, (_, d) => d % L);
  const loc = new Int32Array(n);
  for (let i = 0; i < n; i++) loc[i] = r.chance(0.65) ? deptLoc[dept[i]] : r.int(L);
  loc[0] = 0;

  // Attributes.
  const attrs = [];
  const titleFor = (i) => {
    const base = DEPT_BASES.find(b => b.id === deptNames[dept[i]].base);
    if (i === 0) return 'Chief Executive Officer';
    const isMgr = reports[i].length > 0;
    if (depth[i] === 1) return `VP, ${deptNames[dept[i]].name}`;
    if (isMgr) return depth[i] === 2 ? `Director, ${base.role}` : `${base.role} Manager`;
    const lvl = maxDepth - depth[i];
    return `${lvl >= 2 ? 'Senior ' : lvl === 0 ? 'Associate ' : ''}${base.role}`;
  };
  const tr = r.fork('tenure');
  for (let i = 0; i < n; i++) {
    const mgr = reports[i].length > 0;
    const tenure = round(Math.min(30, tr.lognormal(mgr ? 1.4 : 0.8, 0.7)), 1);
    attrs.push({
      division: i === 0 ? 'Executive' : deptNames[dept[i]].division,
      department: i === 0 ? 'Executive' : deptNames[dept[i]].name,
      title: titleFor(i),
      level: depth[i] + 1, // 1 = top of the tree
      location: locs[loc[i]].name,
      tz: locs[loc[i]].tz,
      tenure_years: tenure,
      start_date: new Date(span.start - tenure * 365.25 * DAY).toISOString().slice(0, 10),
      is_manager: mgr,
    });
  }
  // team = manager's reports (a team is identified by its manager)
  for (let i = 1; i < n; i++) attrs[i].team = `${deptNames[dept[i]].name} / ${names.label[manager[i]]}`;

  // ---- true ties
  const ties = new TieTable(n);
  const prop = Float64Array.from({ length: n }, () => r.lognormal(0, params.degreeInequality));
  for (let i = 1; i < n; i++) ties.add(i, manager[i], { w: 3, kind: 'hierarchy' });
  for (let d = 0; d < D; d++) { // leadership team: CEO and heads
    const h = members[d][0];
    // In a bridge-dependent org the heads rarely talk directly, so the planted
    // brokers, not the leadership team, carry cross-department traffic.
    const pLead = presetId === 'bridge-dependent' ? 0.1 : D > 12 ? 0.25 : 0.6;
    for (let e = d + 1; e < D; e++) if (r.chance(pLead)) ties.add(h, members[e][0], { w: 1.2, kind: 'leadership' });
  }
  for (let i = 0; i < n; i++) { // teammates (same manager)
    const rep = reports[i];
    const pTeam = rep.length <= 8 ? 0.65 : 6 / rep.length;
    for (let a = 0; a < rep.length; a++) for (let b = a + 1; b < rep.length; b++) if (r.chance(pTeam)) ties.add(rep[a], rep[b], { w: 2, kind: 'team' });
  }
  const deptCum = members.map(m => cumulative(m.map(i => prop[i])));
  const allCum = cumulative(Array.from(prop));
  const h = params.locationHomophily;
  const pickIn = (d, i) => {
    for (let t = 0; t < 8; t++) {
      const j = members[d][drawCum(deptCum[d], r)];
      if (j !== i && (loc[j] === loc[i] || r.chance(1 - h))) return j;
    }
    return members[d][r.int(members[d].length)];
  };
  const pickOut = (i) => {
    for (let t = 0; t < 12; t++) {
      const j = drawCum(allCum, r);
      if (j !== i && dept[j] !== dept[i] && (loc[j] === loc[i] || r.chance(1 - h))) return j;
    }
    return -1;
  };
  const meanProp = Array.from(prop).reduce((a, b) => a + b, 0) / n;
  for (let i = 1; i < n; i++) {
    const target = Math.max(1, Math.round((params.avgDegree / 2) * (prop[i] / meanProp)));
    const nOut = r.poisson(target * params.crossShare);
    const nIn = Math.max(0, target - nOut - 1);
    for (let k = 0; k < nIn; k++) {
      const j = pickIn(dept[i], i);
      if (j !== i && j > 0) ties.add(i, j, { w: round(r.range(0.6, 1.8), 2), kind: 'peer' });
    }
    for (let k = 0; k < nOut; k++) {
      const j = pickOut(i);
      if (j > 0) ties.add(i, j, { w: round(r.range(0.4, 1), 2), kind: 'cross' });
    }
  }
  // Planted brokers: mid-level people with bridge ties into 2-3 other departments.
  const brokerCands = [];
  for (let i = 1; i < n; i++) if (depth[i] >= 2 && depth[i] <= Math.max(2, maxDepth - 1)) brokerCands.push(i);
  const brokers = r.sample(brokerCands.length ? brokerCands : Array.from({ length: n - 1 }, (_, k) => k + 1), B);
  const bridgeTies = [];
  for (const bk of brokers) {
    const strong = presetId === 'bridge-dependent';
    const others = r.sample([...Array(D).keys()].filter(d => d !== dept[bk]), Math.min(D - 1, strong ? r.intRange(3, 4) : r.intRange(2, 3)));
    for (const d of others) {
      const k = Math.min(members[d].length, strong ? r.intRange(4, 7) : r.intRange(2, 4));
      for (const j of r.sample(members[d], k)) {
        const ti = ties.add(bk, j, { w: 1.3, kind: 'bridge' });
        if (ti >= 0 && ties.kindOf(ti) === 'bridge') bridgeTies.push(ti);
      }
    }
  }

  const world = {
    context: 'workplace', preset: presetId, params, notes, span, n,
    orgName: org, domain,
    people: { label: names.label, first: names.first, last: names.last, attrs, email: emails },
    isBot: new Uint8Array(n),
    group: dept, groups: deptNames.map(d => ({ name: d.name, kind: 'department', base: d.base, division: d.division })),
    groupAttr: 'department',
    ties, brokers, bridgeTies,
    hierarchy: { manager, depth, root: 0, managerAfter: null },
    reports,
    leftAt: new Float64Array(n).fill(Infinity),
    tzOffset: Float32Array.from({ length: n }, (_, i) => locs[loc[i]].offset),
    rhythmKind: 'work',
    events: [], rules: [], personRules: [],
    affect: new AffectPlan(),
    members, locs,
    topics: { byGroup: deptNames.map(d => DEPT_BASES.find(b => b.id === d.base).words) },
    ego: -1,
  };

  // Planted affect: department climates differ. They are drawn from the seed
  // alone (their own fork, before the preset), so every structure with the
  // same seed plants the same climate per department. The planted gap in
  // ground truth is message-weighted, so it moves a little with the public
  // and private mix of each structure (0.55 vs 0.549 at seed 7), and the
  // measured mean tone per department, over thousands of messages drawn
  // from the same climates with the same content stream (also seeded by the
  // seed alone), can agree to the third decimal across structures (the
  // recovery check reads Engineering 0.386, Design -0.012 for both siloed and
  // bridge-dependent at seed 7) even though the messages themselves differ.
  const ar = r.fork('affect');
  for (let d = 0; d < D; d++) world.affect.setGroup(d, round(ar.range(-0.15, 0.5), 2));
  if (params.affectGap > 0) world.affect.addRule({ visibility: 'private', delta: -params.affectGap, label: 'private talk is more negative than public talk' });

  applyPreset(world, presetId, r.fork('preset'));
  buildSpaces(world, r.fork('spaces'));
  return world;
}

function applyPreset(world, presetId, r) {
  const { span, ties, n } = world;
  const at = f => Math.round(span.start + f * (span.end - span.start));
  const D = world.groups.length;
  if (presetId === 'bridge-dependent' && world.brokers.length) {
    // The broker with the most bridge ties leaves.
    const count = new Map();
    for (const ti of world.bridgeTies) { const b = world.brokers.includes(ties.a[ti]) ? ties.a[ti] : ties.b[ti]; count.set(b, (count.get(b) || 0) + 1); }
    const who = [...count].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0]?.[0] ?? world.brokers[0];
    departure(world, who, at(0.55));
  } else if (presetId === 'siloed') {
    const t = at(0.4);
    world.rules.push({ from: t, until: Infinity, mult: 0.12, match: ti => world.group[ties.a[ti]] !== world.group[ties.b[ti]] && ties.kindOf(ti) !== 'hierarchy', label: 'cross-department ties go quiet' });
    world.events.push({ type: 'silo', t, description: 'Cross-department interaction drops to about 12% of its earlier rate', mult: 0.12 });
  } else if (presetId === 'consolidating') {
    const t = at(0.5);
    const mgr = i => world.reports[i].length > 0;
    world.rules.push({ from: t, until: Infinity, mult: 1.8, match: ti => mgr(ties.a[ti]) || mgr(ties.b[ti]), label: 'ties to managers intensify' });
    world.rules.push({ from: t, until: Infinity, mult: 0.4, match: ti => !mgr(ties.a[ti]) && !mgr(ties.b[ti]), label: 'peer ties fade' });
    world.events.push({ type: 'consolidation', t, description: 'Traffic concentrates on managers; peer-to-peer ties fade to 40%' });
  } else if (presetId === 'declining') {
    const t = at(0.5);
    const len = span.end - span.start;
    world.rules.push({ from: span.start, until: Infinity, mult: tt => 1 - 0.55 * Math.max(0, Math.min(1, (tt - span.start) / len)), match: () => true, label: 'overall activity declines linearly to 45%' });
    // the quiet department: the largest non-executive one
    let g = 0;
    for (let d = 0; d < D; d++) if (world.members[d].length > world.members[g].length) g = d;
    world.rules.push({ from: t, until: Infinity, mult: 0.15, match: ti => world.group[ties.a[ti]] === g || world.group[ties.b[ti]] === g, label: `${world.groups[g].name} goes quiet` });
    world.events.push({ type: 'quiet', t, group: g, groupName: world.groups[g].name, description: `${world.groups[g].name} activity drops to 15%`, mult: 0.15 });
    world.affect.addRule({ group: g, from: t, delta: -0.65, label: `${world.groups[g].name} sours` });
    world.events.push({ type: 'affect-shift', t, group: g, groupName: world.groups[g].name, delta: -0.65, description: `${world.groups[g].name} talk turns negative` });
    world.events.push({ type: 'decline', t: span.start, description: 'All activity declines linearly to 45% by the end' });
  } else if (presetId === 'reorg-midpoint' && D >= 2) {
    const t = at(0.5);
    // Move whole teams (a manager below the head plus reports) into another department.
    const managerAfter = world.hierarchy.manager.slice();
    const moved = [];
    const groupAfter = world.group.slice();
    const cands = [];
    for (let i = 1; i < n; i++) if (world.hierarchy.depth[i] === 2 && world.reports[i].length > 0) cands.push(i);
    const k = Math.max(1, Math.round(cands.length * 0.2));
    for (const lead of r.sample(cands, k)) {
      const from = world.group[lead];
      let to = r.int(D); if (to === from) to = (to + 1) % D;
      const team = [lead, ...collectSubtree(world.reports, lead)];
      managerAfter[lead] = world.members[to][0];
      for (const p of team) { groupAfter[p] = to; moved.push({ person: p, from, to }); }
    }
    // Old department ties of moved people (other than inside the moved team or to the old manager) end; new ones start.
    const movedSet = new Map(moved.map(m => [m.person, m]));
    for (let ti = 0; ti < ties.count; ti++) {
      const a = ties.a[ti], b = ties.b[ti];
      const ma = movedSet.get(a), mb = movedSet.get(b);
      if (!ma && !mb) continue;
      if (ma && mb && ma.to === mb.to) continue; // moved together
      if (ties.kindOf(ti) === 'bridge') continue;
      if (r.chance(0.8)) ties.until[ti] = t; // most old ties end, a few persist as cross ties
    }
    const rr = r.fork('newties');
    for (const m of moved) {
      const pool = world.members[m.to];
      for (let k2 = 0; k2 < 4; k2++) ties.add(m.person, pool[rr.int(pool.length)], { w: round(rr.range(0.8, 1.6), 2), kind: 'reorg-new', from: t });
    }
    for (const m of moved) if (managerAfter[m.person] !== world.hierarchy.manager[m.person]) ties.add(m.person, managerAfter[m.person], { w: 3, kind: 'hierarchy-new', from: t });
    world.hierarchy.managerAfter = managerAfter;
    world.groupAfter = groupAfter;
    world.events.push({ type: 'reorg', t, moved: moved.map(m => ({ person: m.person, from: m.from, to: m.to })), description: `${moved.length} people in ${k} teams move department; most of their old department ties end` });
    // Moved people are briefly more negative (one rule per person keeps the plan simple to evaluate).
    for (const m of moved) world.affect.addRule({ person: m.person, from: t, until: t + 21 * DAY, delta: -0.3, label: 'moved by reorg' });
    world.events.push({ type: 'affect-shift', t, people: moved.map(m => m.person), delta: -0.3, until: t + 21 * DAY, description: 'People moved by the reorg are more negative for three weeks' });
  }
}

function collectSubtree(reports, i) {
  const out = [];
  const stack = [...reports[i]];
  while (stack.length) { const x = stack.pop(); out.push(x); stack.push(...reports[x]); }
  return out;
}

export function departure(world, who, t) {
  world.leftAt[who] = t;
  const { ties } = world;
  for (let ti = 0; ti < ties.count; ti++) if ((ties.a[ti] === who || ties.b[ti] === who) && ties.until[ti] > t) ties.until[ti] = t;
  world.events.push({ type: 'departure', t, person: who, name: world.people.label[who], wasBroker: world.brokers.includes(who), description: `${world.people.label[who]} leaves; all their ties end` });
}

// Slack channels, mailing lists and recurring meeting groups all start from
// the same spaces: company-wide, department, team, project and leadership.
function buildSpaces(world, r) {
  const { n, members, groups, reports, people } = world;
  const all = Array.from({ length: n }, (_, i) => i);
  const spaces = [];
  spaces.push({ key: 'general', name: 'general', kind: 'channel', visibility: 'public', members: all, everyone: true, purpose: 'Company-wide announcements and work-based matters' });
  spaces.push({ key: 'random', name: 'random', kind: 'channel', visibility: 'public', members: all, everyone: true, purpose: 'Non-work banter and water cooler conversation', social: true });
  members.forEach((m, d) => spaces.push({ key: 'dept-' + d, name: slug(groups[d].name), kind: 'channel', visibility: 'public', members: m.slice(), group: d, purpose: `${groups[d].name} team channel` }));
  const leads = [0, ...members.map(m => m[0])];
  spaces.push({ key: 'leads', name: 'leadership', kind: 'channel', visibility: 'private', members: leads, purpose: 'Leadership team' });
  for (let i = 1; i < n; i++) {
    if (reports[i].length >= 3 && world.hierarchy.depth[i] >= 1) {
      const d = world.group[i];
      const nm = `${slug(groups[d].name)}-${slug(people.last[i])}-team`;
      spaces.push({ key: 'team-' + i, name: nm, kind: 'channel', visibility: r.chance(0.4) ? 'private' : 'public', members: [i, ...reports[i]], group: d, team: i, purpose: `Team of ${people.label[i]}` });
    }
  }
  const D = groups.length;
  const nProj = Math.max(2, Math.round(D * 0.7));
  const codenames = ['apollo', 'kestrel', 'basalt', 'meridian', 'tidepool', 'lantern', 'fjord', 'quartz', 'juniper', 'sextant', 'mistral', 'orchard', 'harbor', 'cobalt', 'saffron', 'atlas', 'ember', 'nimbus', 'pinion', 'vesper'];
  for (let k = 0; k < nProj; k++) {
    const ds = r.sample([...Array(D).keys()], Math.min(D, r.intRange(2, 3)));
    const mem = new Set();
    for (const d of ds) for (const p of r.sample(members[d], Math.min(members[d].length, r.intRange(2, 6)))) mem.add(p);
    for (const b of world.brokers) if (ds.includes(world.group[b]) && r.chance(0.6)) mem.add(b);
    const nm = `proj-${codenames[k % codenames.length]}${k >= codenames.length ? '-' + Math.floor(k / codenames.length) : ''}`;
    spaces.push({ key: 'proj-' + k, name: nm, kind: 'channel', visibility: r.chance(0.25) ? 'private' : 'public', members: [...mem].sort((a, b) => a - b), groups: ds, project: nm.slice(5), purpose: `Cross-team project ${nm.slice(5)}` });
  }
  world.spaces = spaces;
}
