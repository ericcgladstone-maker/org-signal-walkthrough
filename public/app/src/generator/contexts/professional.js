// Professional (LinkedIn-like) context. People have a school and graduation
// cohort, an industry and an employer history. Undirected connections cluster
// by shared employers (overlapping stints) and school cohorts, plus many weak
// ties within an industry (events, conferences) and a few recruiters who
// connect to lots of people. Job changes inside the timespan are planted
// events; new coworker connections follow them.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames, makeEmails, ORG_A, ORG_B, ORG_SUFFIX, SCHOOLS, INDUSTRIES, CITIES } from '../names.js';
import { DAY } from '../time.js';

const YEAR = 365.25 * DAY;
const ROLES = ['Analyst', 'Engineer', 'Designer', 'Consultant', 'Product Manager', 'Account Manager', 'Researcher', 'Operations Lead', 'Data Scientist', 'Marketing Manager'];

export const schema = [
  { key: 'size', label: 'People', type: 'int', min: 20, max: 50000, default: 300 },
  { key: 'employers', label: 'Employers', type: 'int', min: 3, max: 400, default: 14 },
  { key: 'schools', label: 'Schools', type: 'int', min: 1, max: 11, default: 6 },
  { key: 'industries', label: 'Industries', type: 'int', min: 1, max: 10, default: 3 },
  { key: 'jobChangeRate', label: 'Job changes per person per year', type: 'number', min: 0.02, max: 1, default: 0.22 },
  { key: 'coworkerTie', label: 'Chance overlapping coworkers connect', type: 'number', min: 0.02, max: 0.9, default: 0.3 },
  { key: 'cohortTie', label: 'Chance school cohort-mates connect', type: 'number', min: 0, max: 0.9, default: 0.25 },
  { key: 'weakTies', label: 'Weak industry ties per person', type: 'number', min: 0, max: 50, default: 6 },
  { key: 'recruiters', label: 'Recruiters', type: 'int', min: 0, max: 100, default: 3 },
  { key: 'activity', label: 'Messages per strong connection per year', type: 'number', min: 0, max: 20, default: 0.4 },
];
export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));
export const presets = {
  'cohort-clusters': { label: 'Cohort clusters: employers and school cohorts shape the network', params: {} },
  'job-hopping': { label: 'Job hopping: frequent moves blur employer clusters', params: { jobChangeRate: 0.5 } },
  'layoff-wave': { label: 'Layoff wave: one employer sheds a third of its staff at 50%', params: {} },
};
export const media = ['linkedin', 'network'];
export const timespanDefaults = { start: '2025-01-01', days: 365 };
export const observations = ['ego', 'full', 'sample'];

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : 'cohort-clusters';
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  applySchemaBounds(schema, params, notes);
  const n = params.size;
  if (params.employers > n / 5) { params.employers = Math.max(3, Math.floor(n / 5)); notes.push('employers reduced so each has at least ~5 people'); }
  const r = rng.fork('professional');
  const names = makePeopleNames(r.fork('names'), n);
  const inds = INDUSTRIES.slice(0, params.industries);
  const used = new Set();
  const employers = [];
  for (let e = 0; e < params.employers; e++) {
    let nm; do { nm = `${r.pick(ORG_A)}${r.pick(ORG_B)} ${r.pick(ORG_SUFFIX)}`; } while (used.has(nm));
    used.add(nm);
    employers.push({ name: nm, industry: e % inds.length, size: r.lognormal(0, 0.8) });
  }
  const byInd = inds.map((_, k) => employers.map((e, i) => [e, i]).filter(([e]) => e.industry === k).map(([, i]) => i));
  const schools = SCHOOLS.slice(0, params.schools);
  const now = span.end;

  const pickEmployer = (ind, avoid) => {
    const pool = r.chance(0.85) ? byInd[ind] : employers.map((_, i) => i);
    for (let k = 0; k < 10; k++) {
      const e = r.pickWeighted(pool, pool.map(i => employers[i].size));
      if (e !== avoid) return e;
    }
    return pool[0];
  };

  // Careers
  const people = [];
  const isRecruiter = new Uint8Array(n);
  for (const i of r.sample([...Array(n).keys()], Math.min(params.recruiters, Math.floor(n / 20)))) isRecruiter[i] = 1;
  for (let i = 0; i < n; i++) {
    const age = r.intRange(23, 58);
    const grad = new Date(now).getUTCFullYear() - (age - 22);
    const school = r.int(schools.length);
    const ind = r.int(inds.length);
    const jobs = [];
    let t = Date.UTC(grad, 5 + r.int(4), 1 + r.int(28));
    let emp = pickEmployer(ind, -1);
    let level = 0;
    while (t < now) {
      const dur = r.exp(1 / Math.max(0.05, params.jobChangeRate)) * YEAR;
      const end = t + Math.max(0.4 * YEAR, dur);
      jobs.push({ employer: emp, start: t, end: end >= now ? null : end, title: isRecruiter[i] ? 'Talent Partner' : titleAt(r, level), level });
      if (end >= now) break;
      t = end + r.int(60) * DAY;
      emp = pickEmployer(ind, emp);
      level = Math.min(4, level + (r.chance(0.6) ? 1 : 0));
    }
    people.push({ school, grad, ind, jobs, city: r.pick(CITIES).name });
  }
  const current = p => p.jobs[p.jobs.length - 1];

  const ties = new TieTable(n);
  const linkedinEpoch = Date.UTC(2004, 0, 1);
  // Coworkers: overlapping stints at the same employer.
  const stints = employers.map(() => []);
  people.forEach((p, i) => p.jobs.forEach(j => stints[j.employer].push({ i, s: j.start, e: j.end ?? now })));
  for (const list of stints) {
    list.sort((a, b) => a.s - b.s);
    // Small employers: every overlapping pair is a candidate. Large ones: each
    // stint draws a bounded number of candidates, so cost stays linear.
    const small = list.length <= 150;
    for (let x = 0; x < list.length; x++) {
      const cands = small ? list.slice(x + 1) : Array.from({ length: 40 }, () => list[r.int(list.length)]);
      for (const y of cands) {
        if (list[x].i === y.i) continue;
        const s = Math.max(list[x].s, y.s), overlap = Math.min(list[x].e, y.e) - s;
        if (overlap < 30 * DAY) continue;
        const p = params.coworkerTie * Math.min(1, overlap / YEAR) * (small ? 1 : 0.5);
        if (r.chance(p)) ties.add(list[x].i, y.i, { w: round(1 + Math.min(2, overlap / YEAR), 2), kind: 'coworker', from: Math.max(linkedinEpoch, s + r.next() * Math.min(overlap, YEAR)) });
      }
    }
  }
  // School cohorts.
  const cohorts = new Map();
  people.forEach((p, i) => { const k = p.school * 10000 + p.grad; if (!cohorts.has(k)) cohorts.set(k, []); cohorts.get(k).push(i); });
  for (const [k, m] of cohorts) {
    const near = [...(cohorts.get(k - 1) || []), ...m];
    for (const a of m) for (const b of near) if (a < b && r.chance(params.cohortTie * (m.length > 60 ? 60 / m.length : 1))) {
      ties.add(a, b, { w: 1, kind: 'cohort', from: Math.max(linkedinEpoch, Date.UTC(people[a].grad, 4, 1) + r.next() * YEAR) });
    }
  }
  // Weak industry ties and recruiters.
  const byIndPeople = inds.map((_, k) => people.map((p, i) => [p, i]).filter(([p]) => p.ind === k).map(([, i]) => i));
  for (let i = 0; i < n; i++) {
    const pool = byIndPeople[people[i].ind];
    for (let k = r.poisson(params.weakTies / 2); k > 0; k--) {
      const j = r.chance(0.8) ? pool[r.int(pool.length)] : r.int(n);
      ties.add(i, j, { w: 0.3, kind: 'weak', from: Math.max(linkedinEpoch, now - r.next() * 8 * YEAR) });
    }
  }
  for (let i = 0; i < n; i++) if (isRecruiter[i]) for (const j of r.sample([...Array(n).keys()], Math.min(n - 1, Math.round(n * 0.25)))) ties.add(i, j, { w: 0.2, kind: 'recruiter', from: now - r.next() * 4 * YEAR });

  // Planted job changes inside the span (from careers), and the layoff wave.
  const events = [];
  people.forEach((p, i) => p.jobs.forEach((j, k) => { if (k > 0 && j.start >= span.start && j.start < span.end) events.push({ type: 'job-change', t: j.start, person: i, from: employers[p.jobs[k - 1].employer].name, to: employers[j.employer].name, description: `${names.label[i]} moves to ${employers[j.employer].name}` }); }));
  if (presetId === 'layoff-wave') {
    const t = Math.round(span.start + 0.5 * (span.end - span.start));
    const big = employers.map((e, i) => [people.filter(p => current(p).employer === i).length, i]).sort((a, b) => b[0] - a[0])[0][1];
    const staff = people.map((p, i) => [p, i]).filter(([p]) => current(p).employer === big && current(p).start < t).map(([, i]) => i);
    const laid = r.sample(staff, Math.round(staff.length / 3));
    for (const i of laid) {
      const p = people[i];
      const cur = current(p);
      cur.end = t;
      const ne = pickEmployer(p.ind, big);
      p.jobs.push({ employer: ne, start: t + r.intRange(20, 90) * DAY, end: null, title: cur.title, level: cur.level });
      events.push({ type: 'job-change', t: p.jobs[p.jobs.length - 1].start, person: i, from: employers[big].name, to: employers[ne].name, layoff: true, description: `${names.label[i]} is laid off and joins ${employers[ne].name}` });
    }
    events.push({ type: 'layoff', t, employer: employers[big].name, people: laid, description: `${employers[big].name} lays off ${laid.length} people` });
  }
  events.sort((a, b) => a.t - b.t);
  // New coworkers connect after a job change.
  for (const e of events) if (e.type === 'job-change') {
    const emp = current(people[e.person]).employer;
    const mates = people.map((p, i) => [p, i]).filter(([p, i]) => i !== e.person && current(p).employer === emp).map(([, i]) => i);
    for (const j of r.sample(mates, Math.min(mates.length, r.intRange(2, 6)))) ties.add(e.person, j, { w: 1.5, kind: 'new-coworker', from: e.t + r.int(60) * DAY });
  }

  const attrs = people.map((p, i) => {
    const c = current(p);
    return {
      company: employers[c.employer].name, position: c.title, industry: inds[p.ind], school: schools[p.school], graduation_year: p.grad,
      location: p.city, is_recruiter: !!isRecruiter[i], jobs: p.jobs.length,
    };
  });
  const group = Int32Array.from(people, p => current(p).employer);
  const world = {
    context: 'professional', preset: presetId, params, notes, span, n,
    domain: 'mail.example',
    people: { label: names.label, first: names.first, last: names.last, attrs, email: makeEmails(names.first, names.last, 'mail.example'), careers: people },
    isBot: new Uint8Array(n), group,
    groups: employers.map(e => ({ name: e.name, kind: 'current employer', industry: inds[e.industry] })),
    groupAttr: 'company',
    employers, schools, industries: inds,
    ties, brokers: [], bridgeTies: [],
    leftAt: new Float64Array(n).fill(Infinity),
    tzOffset: new Float32Array(n),
    rhythmKind: 'work', events, rules: [],
    affect: new AffectPlan(),
    topics: { byGroup: employers.map(e => [`${inds[e.industry].toLowerCase()} hiring`, 'the product launch', `${e.name.split(' ')[0]} culture`, 'remote work', 'the team offsite']) },
    isRecruiter, ego: -1,
  };
  world.affect.defaultValence = 0.35;
  return world;
}

const AREAS = ['Analytics', 'Engineering', 'Design', 'Consulting', 'Product', 'Accounts', 'Research', 'Operations', 'Data Science', 'Marketing'];
function titleAt(r, level) {
  const k = r.int(ROLES.length);
  if (level === 4) return `Head of ${AREAS[k]}`;
  return ['Junior ', '', 'Senior ', 'Lead '][level] + ROLES[k];
}
