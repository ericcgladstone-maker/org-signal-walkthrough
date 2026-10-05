// Community context (Reddit/Discord-like): topic spaces with core-periphery
// membership. Activity propensity is heavy-tailed; the most active members
// form a core that belongs to several spaces and is densely tied, peripheral
// members sit in one space with few ties. Each space has moderators (core
// members) and an automated moderator bot.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames, makeHandles } from '../names.js';
import { COMMUNITY_SPACES } from '../vocab.js';

export const schema = [
  { key: 'size', label: 'Members', type: 'int', min: 20, max: 50000, default: 500 },
  { key: 'spaces', label: 'Spaces (subreddits or channels)', type: 'int', min: 1, max: 8, default: 4 },
  { key: 'coreShare', label: 'Core share of members', type: 'number', min: 0.01, max: 0.4, default: 0.08 },
  { key: 'moderators', label: 'Moderators per space', type: 'int', min: 0, max: 10, default: 2 },
  { key: 'activity', label: 'Threads per space per day', type: 'number', min: 0.1, max: 200, default: 4 },
  { key: 'affectGap', label: 'Unused for community (kept for a uniform schema)', type: 'number', min: 0, max: 0, default: 0 },
];
export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));
export const presets = {
  'core-periphery': { label: 'Core-periphery: a small active core answers most questions', params: {} },
  'flame-war': { label: 'Flame war: one space turns hostile at 50%', params: {} },
  'core-exodus': { label: 'Core exodus: three core members leave at 50%', params: {} },
};
export const media = ['reddit', 'discord', 'network'];
export const timespanDefaults = { start: '2025-04-07', days: 60 };
export const observations = ['full', 'sample', 'ego', 'authored'];

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : 'core-periphery';
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  applySchemaBounds(schema, params, notes);
  const n = params.size;
  const r = rng.fork('community');
  const S = Math.min(params.spaces, COMMUNITY_SPACES.length);
  const topics = r.sample(COMMUNITY_SPACES, S);
  const names = makePeopleNames(r.fork('names'), n);
  const handles = makeHandles(r.fork('handles'), n);
  const prop = Float64Array.from({ length: n }, () => r.lognormal(0, 1.1));
  const order = [...Array(n).keys()].sort((a, b) => prop[b] - prop[a]);
  const nCore = Math.max(2, Math.round(n * params.coreShare));
  const isCore = new Uint8Array(n);
  for (let k = 0; k < nCore; k++) isCore[order[k]] = 1;
  const home = new Int32Array(n);
  const memberOf = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) {
    home[i] = r.int(S);
    memberOf[i].push(home[i]);
    const extra = isCore[i] ? r.intRange(1, 3) : r.chance(0.2) ? 1 : 0;
    for (const s of r.sample([...Array(S).keys()].filter(x => x !== home[i]), extra)) memberOf[i].push(s);
  }
  const spaceMembers = Array.from({ length: S }, () => []);
  for (let i = 0; i < n; i++) for (const s of memberOf[i]) spaceMembers[s].push(i);

  const ties = new TieTable(n);
  for (let s = 0; s < S; s++) {
    const m = spaceMembers[s];
    const core = m.filter(i => isCore[i]), per = m.filter(i => !isCore[i]);
    // dense core, but each core member keeps a bounded number of core ties in big spaces
    if (core.length <= 80) {
      for (let a = 0; a < core.length; a++) for (let b = a + 1; b < core.length; b++) if (r.chance(0.5)) ties.add(core[a], core[b], { w: round(r.range(1, 3), 2), kind: 'core' });
    } else {
      for (const a of core) for (let k = r.poisson(20); k > 0; k--) { const b = r.pick(core); if (b !== a) ties.add(a, b, { w: round(r.range(1, 3), 2), kind: 'core' }); }
    }
    for (const p of per) {
      for (let k = r.poisson(1.2); k > 0 && core.length; k--) ties.add(p, r.pick(core), { w: round(r.range(0.4, 1.2), 2), kind: 'core-periphery' });
      for (let k = r.poisson(0.5); k > 0 && per.length > 1; k--) { const q = r.pick(per); if (q !== p) ties.add(p, q, { w: 0.4, kind: 'periphery' }); }
    }
  }
  const mods = [];
  const spaces = topics.map((tp, s) => {
    const core = spaceMembers[s].filter(i => isCore[i]).sort((a, b) => prop[b] - prop[a]);
    const m = core.slice(0, Math.min(params.moderators, core.length));
    mods.push(...m);
    return { key: 'space-' + s, name: tp.name, kind: 'subreddit', visibility: 'public', members: spaceMembers[s], group: s, words: tp.words, moderators: m, topicId: tp.id };
  });
  const isMod = new Set(mods);
  const attrs = [];
  for (let i = 0; i < n; i++) attrs.push({ handle: handles[i], home_space: topics[home[i]].name, spaces: memberOf[i].length, role: isMod.has(i) ? 'moderator' : isCore[i] ? 'core' : 'periphery', activity: round(prop[i], 2) });

  const world = {
    context: 'community', preset: presetId, params, notes, span, n,
    domain: 'forum.example',
    people: { label: names.label, first: names.first, last: names.last, handle: handles, attrs, email: handles.map(h => `${h.replace(/\./g, '')}@mail.example`) },
    isBot: new Uint8Array(n), group: home, groups: topics.map(t => ({ name: t.name, kind: 'space', id: t.id })), groupAttr: 'home_space',
    ties, isCore, prop, spaces, memberOf, moderators: mods,
    brokers: [], bridgeTies: [],
    leftAt: new Float64Array(n).fill(Infinity),
    tzOffset: Float32Array.from({ length: n }, () => r.pick([-8, -6, -5, 0, 1, 2, 9])),
    rhythmKind: 'community', events: [], rules: [],
    affect: new AffectPlan(),
    topics: { byGroup: topics.map(t => t.words), bySpace: topics.map(t => ({ space: t.name, words: t.words })) },
    ego: -1,
  };
  const ar = r.fork('affect');
  topics.forEach((t, s) => world.affect.setGroup(s, round(ar.range(0.05, 0.45), 2)));
  const t = Math.round(span.start + 0.5 * (span.end - span.start));
  if (presetId === 'flame-war') {
    world.affect.addRule({ group: 0, from: t, delta: -0.8, label: 'flame war' });
    world.events.push({ type: 'affect-shift', t, group: 0, groupName: topics[0].name, delta: -0.8, description: `r/${topics[0].name} turns hostile` });
  }
  if (presetId === 'core-exodus') {
    for (const p of r.sample(order.slice(0, nCore).filter(i => !isMod.has(i)), 3)) {
      world.leftAt[p] = t;
      for (let ti = 0; ti < ties.count; ti++) if ((ties.a[ti] === p || ties.b[ti] === p) && ties.until[ti] > t) ties.until[ti] = t;
      world.events.push({ type: 'departure', t, person: p, name: names.label[p], description: `Core member ${handles[p]} leaves` });
    }
  }
  return world;
}
