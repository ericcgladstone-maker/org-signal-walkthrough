// Personal context: one ego and their circle. Alters sit in closeness layers
// (support clique ~5, sympathy group ~15, affinity group ~50, active network
// ~150, cumulative), have a relationship type and a how-met story, and belong
// to clusters (family, work, school, hobby ...) that are dense inside: the
// family cluster densest. Group chats are cliques drawn from clusters.

import { TieTable, AffectPlan, mergeParams, applySchemaBounds, round } from './common.js';
import { makePeopleNames, makeEmails } from '../names.js';

export const schema = [
  { key: 'size', label: 'People including the ego', type: 'int', min: 8, max: 2000, default: 151 },
  { key: 'layers', label: 'Cumulative layer sizes', type: 'text', default: '5,15,50,150' },
  { key: 'familySize', label: 'Family members', type: 'int', min: 2, max: 60, default: 12 },
  { key: 'groupChats', label: 'Group chats', type: 'int', min: 0, max: 20, default: 6 },
  { key: 'activity', label: 'Messages per week with the closest layer', type: 'number', min: 0.2, max: 60, default: 8 },
  { key: 'affectGap', label: 'How much warmer one-to-one chat is than group chat (0-0.6)', type: 'number', min: 0, max: 0.6, default: 0.1 },
];
export const defaults = Object.fromEntries(schema.map(p => [p.key, p.default]));
export const presets = {
  'close-knit': { label: 'Close-knit: stable layers, warm family chat', params: {} },
  'drifting-apart': { label: 'Drifting apart: the school-friends cluster goes quiet at 50%', params: {} },
  'group-conflict': { label: 'Group conflict: the hobby group chat turns sour at 50%', params: {} },
};
export const media = ['whatsapp', 'telegram', 'imessage', 'network'];
export const timespanDefaults = { start: '2025-02-03', days: 120 };
export const observations = ['ego', 'chat', 'full'];

const CLUSTERS = [
  { id: 'family', name: 'Family', density: 0.85, how: 'family', rel: 'family' },
  { id: 'work', name: 'Work', density: 0.45, how: 'work', rel: 'coworker' },
  { id: 'school', name: 'School friends', density: 0.5, how: 'school', rel: 'friend' },
  { id: 'uni', name: 'University friends', density: 0.45, how: 'university', rel: 'friend' },
  { id: 'hobby', name: 'Climbing club', density: 0.4, how: 'hobby club', rel: 'friend' },
  { id: 'hood', name: 'Neighbors', density: 0.35, how: 'neighborhood', rel: 'neighbor' },
  { id: 'other', name: 'Other', density: 0.03, how: 'friend of a friend', rel: 'acquaintance' },
];
const CHAT_NAMES = { family: ['Family', 'Cousins'], work: ['Lunch crew', 'Team offsite'], school: ['Old school crew'], uni: ['Flat 12 forever'], hobby: ['Climbing Tuesdays'], hood: ['Maple Street neighbors'], other: ['Trip planning'] };

export function build(spec, rng, span) {
  const notes = [];
  const presetId = presets[spec.structure] ? spec.structure : 'close-knit';
  const params = mergeParams(schema, defaults, spec, presets[presetId]);
  if (spec.size != null) params.size = spec.size;
  applySchemaBounds(schema, params, notes);
  const n = params.size;
  const r = rng.fork('personal');
  let layers = String(params.layers).split(',').map(Number).filter(x => x > 0).sort((a, b) => a - b);
  if (layers.length < 2) layers = [5, 15, 50, 150];
  // Scale layer sizes to the circle (n - 1 alters), keeping the ~3x ratios.
  const scale = (n - 1) / layers[layers.length - 1];
  const cum = layers.map(x => Math.max(1, Math.round(x * scale)));
  cum[cum.length - 1] = n - 1;
  for (let k = 1; k < cum.length; k++) if (cum[k] <= cum[k - 1]) cum[k] = Math.min(n - 1, cum[k - 1] + 1);
  const fam = Math.min(params.familySize, Math.floor((n - 1) * 0.4));
  if (fam !== params.familySize) notes.push(`familySize reduced to ${fam}`);

  const names = makePeopleNames(r.fork('names'), n);
  // Family members share a surname with the ego more often than not.
  const layer = new Int8Array(n), cluster = new Int32Array(n), rel = [], how = [];
  layer[0] = 0; cluster[0] = -1;
  // Assign clusters: family first, then others by weight.
  const cw = [0, 0.18, 0.14, 0.12, 0.12, 0.1, 0.34];
  const order = [];
  for (let i = 1; i < n; i++) order.push(i);
  for (let k = 0; k < order.length; k++) cluster[order[k]] = k < fam ? 0 : r.pickWeighted([1, 2, 3, 4, 5, 6], cw.slice(1));
  // Layers: inner layers favour family and close friends.
  const closeness = order.map(i => [r.next() * (cluster[i] === 0 ? 0.45 : cluster[i] === 6 ? 1.6 : cluster[i] === 5 ? 1.3 : 1), i]).sort((a, b) => a[0] - b[0]);
  closeness.forEach(([, i], k) => { let L = 0; while (L < cum.length - 1 && k >= cum[L]) L++; layer[i] = L + 1; });
  for (let i = 1; i < n; i++) {
    const c = CLUSTERS[cluster[i]];
    rel.push(c.rel); how.push(c.how);
    if (cluster[i] === 0 && r.chance(0.6)) { names.label[i] = `${names.first[i]} ${names.last[0]}`; names.last[i] = names.last[0]; }
  }
  // keep labels unique after surname sharing
  const seen = new Set([names.label[0]]);
  for (let i = 1; i < n; i++) { while (seen.has(names.label[i])) names.label[i] = `${names.first[i]} ${'ABCDEFGHJK'[r.int(10)]}. ${names.last[i]}`; seen.add(names.label[i]); }

  const ties = new TieTable(n);
  const layerW = [0, 6, 3, 1, 0.25, 0.1];
  for (let i = 1; i < n; i++) ties.add(0, i, { w: layerW[layer[i]] ?? 0.1, kind: 'ego-' + CLUSTERS[cluster[i]].id });
  const members = CLUSTERS.map(() => []);
  for (let i = 1; i < n; i++) members[cluster[i]].push(i);
  for (let c = 0; c < CLUSTERS.length; c++) {
    const m = members[c];
    for (let a = 0; a < m.length; a++) for (let b = a + 1; b < m.length; b++) {
      const inner = layer[m[a]] <= 2 && layer[m[b]] <= 2 ? 0.15 : 0;
      if (r.chance(Math.min(0.95, CLUSTERS[c].density + inner))) ties.add(m[a], m[b], { w: round(r.range(0.5, 2), 2), kind: CLUSTERS[c].id });
    }
  }
  // Sparse cross-cluster ties; inner-layer people know each other more (partner knows friends).
  for (let i = 1; i < n; i++) for (let k = r.poisson(layer[i] <= 2 ? 1.5 : 0.3); k > 0; k--) {
    const j = 1 + r.int(n - 1);
    if (cluster[j] !== cluster[i]) ties.add(i, j, { w: 0.5, kind: 'cross' });
  }

  const attrs = [{ relationship: 'self', layer: 0, cluster: 'Ego', how_met: '' }];
  for (let i = 1; i < n; i++) attrs.push({ relationship: rel[i - 1], how_met: how[i - 1], layer: layer[i], layer_name: ['', 'support clique', 'sympathy group', 'affinity group', 'active network', 'outer'][layer[i]] || 'outer', cluster: CLUSTERS[cluster[i]].name });

  // Group chats: one per cluster (family first), cliques of mostly inner members.
  const spaces = [];
  const unsaved = {};
  const order2 = [0, 1, 2, 4, 3, 5, 6];
  for (let k = 0; k < Math.min(params.groupChats, 12); k++) {
    const c = order2[k % order2.length];
    const pool = members[c].filter(i => layer[i] <= 4);
    if (pool.length < 2) continue;
    const take = Math.min(pool.length, Math.max(3, Math.round(pool.length * r.range(0.5, 0.9))));
    const mem = r.sample(pool.sort((a, b) => layer[a] - layer[b]).slice(0, Math.max(take, 3)), take);
    // non-family chats pick up a friend-of-friend or two the ego never saved
    if (c !== 0) for (const x of r.sample(members[6].filter(i => layer[i] >= 3), r.poisson(0.8))) { mem.push(x); unsaved[x] = r.chance(0.5) ? 'push' : 'phone'; for (const y of mem) if (y !== x && r.chance(0.5)) ties.add(x, y, { w: 0.4, kind: 'group-acquaintance' }); }
    const nm = CHAT_NAMES[CLUSTERS[c].id][Math.floor(k / order2.length) % CHAT_NAMES[CLUSTERS[c].id].length];
    const all = [0, ...mem.sort((a, b) => a - b)];
    for (let a = 0; a < all.length; a++) for (let b = a + 1; b < all.length; b++) if (!ties.has(all[a], all[b]) && r.chance(0.6)) ties.add(all[a], all[b], { w: 0.4, kind: 'group-chat' });
    spaces.push({ key: 'group-' + k, name: nm, kind: 'group_chat', visibility: 'group', members: all, cluster: c, group: c, defaultChat: k === 0, created: span.start - r.intRange(30, 900) * 86400000, creator: r.chance(0.4) ? 0 : mem[0] });
  }

  const world = {
    context: 'personal', preset: presetId, params, notes, span, n,
    domain: 'mail.example',
    people: { label: names.label, first: names.first, last: names.last, attrs, email: makeEmails(names.first, names.last, 'mail.example') },
    isBot: new Uint8Array(n), group: cluster, groups: CLUSTERS.map(c => ({ name: c.name, kind: 'cluster', id: c.id })),
    groupAttr: 'cluster',
    layer, layerSizes: cum, ties, brokers: [], bridgeTies: [],
    leftAt: new Float64Array(n).fill(Infinity),
    tzOffset: new Float32Array(n),
    rhythmKind: 'personal', events: [], rules: [],
    affect: new AffectPlan(), spaces, unsaved, ego: 0,
    topics: { byGroup: [['the birthday', 'Sunday lunch', 'grandma', 'the holidays'], ['the deadline', 'Friday drinks', 'the new manager'], ['the reunion', 'old photos'], ['the flat', 'the reunion'], ['the crag', 'new shoes', 'bouldering'], ['the bins', 'the street party', 'parking'], ['the trip', 'tickets']] },
  };
  world.group[0] = -1;
  const ar = r.fork('affect');
  world.affect.setGroup(0, 0.5);
  for (let c = 1; c < CLUSTERS.length; c++) world.affect.setGroup(c, round(ar.range(0.1, 0.4), 2));
  world.affect.setGroup(-1, 0.3);
  if (params.affectGap > 0) world.affect.addRule({ visibility: 'private', delta: params.affectGap, label: 'one-to-one chat is warmer than group chat' });

  const t = Math.round(span.start + 0.5 * (span.end - span.start));
  if (presetId === 'drifting-apart') {
    world.rules.push({ from: t, until: Infinity, mult: 0.15, match: ti => cluster[ties.a[ti]] === 2 || cluster[ties.b[ti]] === 2, label: 'school friends drift apart' });
    world.events.push({ type: 'quiet', t, group: 2, groupName: CLUSTERS[2].name, mult: 0.15, description: 'The school-friends cluster goes quiet' });
  }
  if (presetId === 'group-conflict') {
    world.affect.addRule({ group: 4, from: t, delta: -0.75, label: 'conflict in the climbing club' });
    world.events.push({ type: 'affect-shift', t, group: 4, groupName: CLUSTERS[4].name, delta: -0.75, description: 'A falling-out sours the climbing club chat' });
  }
  return world;
}
