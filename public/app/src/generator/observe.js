// Observation: what slice of the simulated interactions an export would show.
//
//   full      everything (an admin export of a bounded group)
//   ego       only interactions involving one person (sent, received,
//             mentioned, attended, reacted to)
//   authored  only what one person did
//   chat      one conversation
//   sample    interactions by a random share of people (research datasets)

const VIEWS = ['full', 'ego', 'authored', 'chat', 'sample'];

export function resolvePerson(world, ident, v) {
  if (v == null || v === 'auto') return -1;
  if (typeof v === 'number') return v >= 0 && v < world.n ? v : -1;
  const s = String(v).toLowerCase();
  for (let i = 0; i < world.n; i++) {
    if (world.people.label[i].toLowerCase() === s || ident.key[i].toLowerCase() === s) return i;
    if (world.people.email?.[i]?.toLowerCase() === s || world.people.handle?.[i]?.toLowerCase() === s) return i;
  }
  return -1;
}

export function normalizeObservation(spec, world, ident, rng, { forcedView } = {}) {
  let o = spec.observation;
  if (typeof o === 'string') o = { view: o };
  o = { view: 'full', ...(o || {}) };
  if (forcedView) o.view = forcedView;
  if (!VIEWS.includes(o.view)) o.view = 'full';
  const out = { view: o.view, ego: -1, chat: o.chat ?? null, rate: o.rate ?? 0.3, chatWith: -1 };
  if (o.view === 'ego' || o.view === 'authored' || o.view === 'chat') {
    out.ego = resolvePerson(world, ident, o.ego);
    if (out.ego < 0) out.ego = defaultEgo(world, rng);
    if (o.chatWith != null) out.chatWith = resolvePerson(world, ident, o.chatWith);
  }
  if (o.view === 'sample') {
    const r = rng.fork('sample');
    out.sampled = new Uint8Array(world.n);
    for (let i = 0; i < world.n; i++) out.sampled[i] = r.chance(out.rate) ? 1 : 0;
  }
  return out;
}

// A sensible ego when none is named: the planted ego (personal), else a
// broker, else a well-connected non-bot person near the median of the top half.
export function defaultEgo(world, rng) {
  if (world.ego >= 0) return world.ego;
  if (world.brokers?.length) return world.brokers[0];
  const deg = [];
  for (let i = 0; i < world.n; i++) if (!world.isBot[i] && world.leftAt[i] === Infinity) deg.push([world.ties.degree(i) + (world.ties.directed ? world.ties.degree(i, 'in') : 0), i]);
  deg.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  return deg.length ? deg[Math.floor(deg.length * 0.15)][1] : 0;
}

export function involves(rec, p) {
  if (rec.actor === p || rec.replyTo === p) return true;
  for (const f of ['to', 'cc', 'bcc', 'mentions', 'attendees', 'audience']) { const a = rec[f]; if (a && a.includes(p)) return true; }
  return false;
}

// keep(rec, ctx) for a normalized observation.
export function makeFilter(obs) {
  const chatCache = new Map();
  switch (obs.view) {
    case 'full': return () => true;
    case 'authored': return rec => rec.actor === obs.ego;
    case 'ego': return (rec, ctx) => {
      if (involves(rec, obs.ego)) return true;
      // group spaces the ego belongs to (group chats, channels the ego reads) are visible in an ego export
      // only for formats whose ego export includes whole conversations; sims mark those spaces egoVisible.
      const s = rec.space >= 0 ? ctx.spaces[rec.space] : null;
      // mailing-list mail reaches every list member; group spaces marked egoVisible show whole conversations
      return !!(s && (s.egoVisible || s.list || s.kind === 'group_chat') && s.members.includes(obs.ego));
    };
    case 'sample': return rec => rec.actor >= 0 && obs.sampled[rec.actor] === 1;
    case 'chat': return (rec, ctx) => {
      if (!(rec.space >= 0)) return false;
      let k = chatCache.get(rec.space);
      if (k === undefined) { k = matchChat(obs, ctx.spaces[rec.space]); chatCache.set(rec.space, k); }
      return k;
    };
    default: return () => true;
  }
}

function matchChat(obs, s) {
  if (obs.chat != null) return s.key === obs.chat || s.name === obs.chat;
  if (obs.chatWith >= 0) return (s.kind === 'dm' || s.kind === 'chat') && s.members.includes(obs.ego) && s.members.includes(obs.chatWith) && s.members.length === 2;
  return !!s.defaultChat;
}
