// Online public context: accounts on an X/Bluesky/Mastodon-like platform.
// The true network is a directed follow graph grown by preferential
// attachment with community homophily (interest and political communities),
// so follower counts are heavy-tailed and emerge from the process. Reciprocity
// is low (a small follow-back chance). Bot accounts are young, follow each
// other densely, have few followers and amplify a handful of accounts.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames, makeHandles, CITIES } from '../names.js';
import { ONLINE_COMMUNITIES } from '../vocab.js';
import { DAY } from '../time.js';

export const schema = [
  { key: 'size', label: 'Accounts', type: 'int', min: 20, max: 50000, default: 400 },
  { key: 'communities', label: 'Communities', type: 'int', min: 2, max: 8, default: 4 },
  { key: 'meanFollows', label: 'Average accounts followed', type: 'number', min: 3, max: 300, default: 30 },
  { key: 'homophily', label: 'Community homophily of follows (0-0.98)', type: 'number', min: 0, max: 0.98, default: 0.75 },
  { key: 'followBack', label: 'Follow-back chance (reciprocity)', type: 'number', min: 0, max: 0.6, default: 0.1 },
  { key: 'botShare', label: 'Share of bot accounts', type: 'number', min: 0, max: 0.3, default: 0.02 },
  { key: 'hubs', label: 'Planted influencer hubs', type: 'int', min: 0, max: 50, default: 0 },
  { key: 'activity', label: 'Posts per account per week (median)', type: 'number', min: 0.1, max: 30, default: 1.5 },
  { key: 'affectGap', label: 'How much more negative public posts are than DMs (0-0.8)', type: 'number', min: 0, max: 0.8, default: 0.25 },
];
export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));

export const presets = {
  'interest-communities': { label: 'Interest communities: topical clusters, moderate homophily', params: {} },
  polarized: { label: 'Polarized: two political camps, hostile cross-camp replies, a news shock at 50%', params: { homophily: 0.92, communities: 4 } },
  'influencer-hub': { label: 'Influencer hubs: a few accounts gather most follows; the biggest leaves at 60%', params: { hubs: 4, homophily: 0.6 } },
  'bot-amplified': { label: 'Bot-amplified: a bot network starts boosting three accounts at 40%', params: { botShare: 0.12 } },
};
export const media = ['x', 'bluesky', 'mastodon', 'network'];
export const timespanDefaults = { start: '2025-03-03', days: 60 };
export const observations = ['ego', 'authored', 'sample', 'full'];

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : 'interest-communities';
  if (spec.structure && !presets[spec.structure]) notes.push(`unknown preset "${spec.structure}"; using interest-communities`);
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  applySchemaBounds(schema, params, notes);
  const n = params.size;
  if (params.meanFollows > n / 3) { params.meanFollows = Math.max(3, Math.floor(n / 3)); notes.push('meanFollows reduced to a third of the population'); }
  const r = rng.fork('online');
  const polar = presetId === 'polarized';

  // Communities
  let comms = ONLINE_COMMUNITIES.filter(c => !c.political);
  comms = r.sample(comms, Math.min(comms.length, params.communities - (polar ? 2 : 0)));
  if (polar) comms = [ONLINE_COMMUNITIES[0], ONLINE_COMMUNITIES[1], ...comms];
  const K = comms.length;
  const cw = comms.map(c => (c.political ? 1.6 : 1) * r.range(0.6, 1.4));
  const isBot = new Uint8Array(n);
  const nb = Math.round(n * params.botShare);
  // Bots are recent accounts (indices are in order of account creation).
  const late = []; for (let i = Math.floor(n * 0.6); i < n; i++) late.push(i);
  for (const i of r.sample(late, nb)) isBot[i] = 1;
  const group = new Int32Array(n);
  for (let i = 0; i < n; i++) group[i] = r.pickWeighted([...Array(K).keys()], cw);

  const names = makePeopleNames(r.fork('names'), n);
  const handles = makeHandles(r.fork('handles'), n, { bots: isBot });

  // Follow graph by preferential attachment with community urns.
  const ties = new TieTable(n, { directed: true });
  const urn = [], curn = Array.from({ length: K }, () => []);
  const hubs = new Set();
  const nh = Math.min(params.hubs, Math.floor(n / 20));
  const humanIdx = []; for (let i = 0; i < n; i++) if (!isBot[i]) humanIdx.push(i);
  for (const h of r.sample(humanIdx.filter(i => i < n / 3), nh)) hubs.add(h);
  const prop = Float64Array.from({ length: n }, (_, i) => (isBot[i] ? 0.2 : r.lognormal(0, 0.8)));
  const span0 = span.start;
  const ageDays = Int32Array.from({ length: n }, (_, i) => Math.max(5, Math.round(4000 * Math.pow(1 - i / n, 1.3) + r.range(-30, 30))));
  for (let i = 0; i < n; i++) {
    // the newcomer follows m accounts that already exist (or, early on, anyone)
    if (i > 0) {
      const m = isBot[i] ? 0 : Math.max(1, Math.min(i, Math.round(r.lognormal(Math.log(params.meanFollows) - 0.3, 0.75))));
      const g = group[i];
      for (let k = 0, tries = 0; k < m && tries < m * 6; tries++) {
        const pool = r.chance(params.homophily) && curn[g].length ? curn[g] : urn;
        if (!pool.length) break;
        const j = pool[r.int(pool.length)];
        if (j === i || isBot[j] || ties.has(i, j)) continue;
        // polarized camps avoid following each other
        if (polar && comms[group[j]].political && comms[g].political && group[j] !== g && r.chance(0.85)) continue;
        ties.add(i, j, { w: 1, kind: 'follow', from: followTime(r, span, ageDays[i]) });
        urn.push(j); curn[group[j]].push(j);
        k++;
      }
    }
    const copies = isBot[i] ? 0 : 1 + (hubs.has(i) ? Math.round(n / 25) : 0) + Math.round(prop[i]);
    for (let c = 0; c < copies; c++) { urn.push(i); curn[group[i]].push(i); }
  }
  // Late arrivals also attract follows from older accounts (otherwise the newest accounts would have none).
  for (let i = 0; i < n; i++) {
    if (isBot[i]) continue;
    const extra = r.poisson(params.meanFollows * 0.15);
    for (let k = 0; k < extra; k++) {
      const pool = r.chance(params.homophily) ? curn[group[i]] : urn;
      const j = pool[r.int(pool.length)];
      if (j !== i && !isBot[j] && j > i) ties.add(i, j, { w: 1, kind: 'follow', from: followTime(r, span, ageDays[j]) });
    }
  }
  // Follow-backs (reciprocity), less likely toward hubs.
  const m0 = ties.count;
  for (let ti = 0; ti < m0; ti++) {
    const a = ties.a[ti], b = ties.b[ti];
    const p = params.followBack * (group[a] === group[b] ? 1.4 : 0.6) * (hubs.has(b) ? 0.1 : 1);
    if (r.chance(p)) ties.add(b, a, { w: 1, kind: 'follow-back', from: Math.max(ties.from[ti], -Infinity) });
  }
  // Bot network: bots follow each other densely and follow the amplified accounts.
  const bots = []; for (let i = 0; i < n; i++) if (isBot[i]) bots.push(i);
  const amplified = bots.length ? r.sample(humanIdx.filter(i => !hubs.has(i)), Math.min(3, humanIdx.length)) : [];
  for (const b of bots) {
    for (const c of r.sample(bots, Math.min(bots.length, 10 + r.int(20)))) if (c !== b) ties.add(b, c, { w: 1, kind: 'bot-follow', from: span0 - r.int(60) * DAY });
    for (const a of amplified) ties.add(b, a, { w: 1, kind: 'bot-follow', from: span0 - r.int(60) * DAY });
    for (const j of r.sample(humanIdx, Math.min(humanIdx.length, r.intRange(20, 60)))) ties.add(b, j, { w: 0.3, kind: 'bot-follow', from: span0 - r.int(60) * DAY });
    // a few humans follow bots back
    for (const j of r.sample(humanIdx, r.poisson(1.5))) ties.add(j, b, { w: 0.3, kind: 'follow', from: span0 - r.int(30) * DAY });
  }
  // Mutual follows are stronger interaction channels.
  for (let ti = 0; ti < ties.count; ti++) if (ties.has(ties.b[ti], ties.a[ti]) && ties.w[ti] >= 1) ties.w[ti] = 2;

  const adj = ties.adjacency();
  const attrs = [];
  for (let i = 0; i < n; i++) {
    const c = comms[group[i]];
    attrs.push({
      community: c.name,
      handle: handles[i],
      bio: isBot[i] ? `${r.pick(c.words)} | news | follow for updates` : `${r.pick(['Into', 'Writing about', 'Mostly', 'Talking'])} ${r.sample(c.words, 2).join(' and ')}. ${r.chance(0.5) ? '#' + r.pick(c.tags) : ''}`.trim(),
      account_age_days: isBot[i] ? r.intRange(5, 90) : ageDays[i],
      followers: adj.in.off[i + 1] - adj.in.off[i],
      following: adj.out.off[i + 1] - adj.out.off[i],
      location: r.chance(0.6) ? r.pick(CITIES).name : '',
      is_bot: !!isBot[i],
      is_hub: hubs.has(i),
    });
  }

  const world = {
    context: 'online', preset: presetId, params, notes, span, n,
    domain: 'social.example',
    people: { label: names.label, first: names.first, last: names.last, handle: handles, attrs, email: handles.map(h => `${h.replace(/\./g, '')}@mail.example`) },
    isBot, group, groups: comms.map(c => ({ name: c.name, kind: c.political ? 'political community' : 'interest community', id: c.id, tags: c.tags, political: c.political || null })),
    groupAttr: 'community',
    ties, hubs: [...hubs], amplified, bots,
    brokers: [], bridgeTies: [],
    leftAt: new Float64Array(n).fill(Infinity),
    tzOffset: Float32Array.from({ length: n }, () => r.pick([-8, -5, -5, 0, 1, 1, 8])),
    rhythmKind: 'online',
    events: [], rules: [],
    affect: new AffectPlan(),
    topics: { byGroup: comms.map(c => c.words) },
    prop, ego: -1,
  };
  const ar = r.fork('affect');
  comms.forEach((c, g) => world.affect.setGroup(g, c.political ? round(ar.range(-0.25, 0.05), 2) : round(ar.range(0.05, 0.45), 2)));
  if (params.affectGap > 0) world.affect.addRule({ visibility: 'public', delta: -params.affectGap, label: 'public posts are more negative than DMs' });

  const at = f => Math.round(span.start + f * (span.end - span.start));
  if (polar) {
    const t = at(0.5);
    for (let g = 0; g < K; g++) if (comms[g].political) world.affect.addRule({ group: g, from: t, delta: -0.35, label: 'news shock' });
    world.events.push({ type: 'affect-shift', t, groups: [0, 1], group: 0, groupName: comms[0].name, delta: -0.35, description: 'A news shock makes both political camps more negative' });
    world.events.push({ type: 'affect-shift', t, group: 1, groupName: comms[1].name, delta: -0.35, description: 'A news shock makes both political camps more negative' });
    world.crossCampDelta = -0.45;
  }
  if (presetId === 'influencer-hub' && hubs.size) {
    let top = -1, best = -1;
    for (const h of hubs) { const d = adj.in.off[h + 1] - adj.in.off[h]; if (d > best) { best = d; top = h; } }
    const t = at(0.6);
    world.leftAt[top] = t;
    for (let ti = 0; ti < ties.count; ti++) if ((ties.a[ti] === top || ties.b[ti] === top) && ties.until[ti] > t) ties.until[ti] = t;
    world.events.push({ type: 'departure', t, person: top, name: names.label[top], description: `The biggest hub (${best} followers) leaves the platform` });
  }
  if (presetId === 'bot-amplified') {
    const t = at(0.4);
    world.botCampaign = { from: t, targets: amplified };
    world.events.push({ type: 'bot-campaign', t, targets: amplified, bots: bots.length, description: `${bots.length} bots start reposting and replying to ${amplified.length} accounts` });
  }
  return world;
}

// Most follows predate the timespan; recent accounts' follows fall inside it.
function followTime(r, span, ageDays) {
  const created = span.start - ageDays * DAY;
  const t = created + r.next() * (span.end - created);
  return t < span.start ? -Infinity : Math.round(t);
}
