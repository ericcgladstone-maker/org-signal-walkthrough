// Interaction simulation scaffolding shared by every medium.
//
// A simulator turns a world (people, true ties, spaces, planted events) into
// interaction records. Records are medium-neutral but carry what each export
// format needs:
//
//   { id, kind, t, actor, space, to, cc, bcc, mentions, audience, replyTo,
//     parent, root, text, subject, emoji, valence, terms, meta }
//
//   kind      message | reaction | like | repost | follow | join | leave |
//             meeting | declared
//   actor     person index; bots that are not people use negative indices
//             (-1 - botIndex) and are listed in sim.bots
//   space     index into sim.spaces (channels, DMs, email threads, chats,
//             meeting series, subreddits ...) or -1
//   to/cc/bcc direct addressees (DM partner, email recipients)
//   audience  everyone a group message reaches (group chat members)
//   replyTo   author of the message this one answers; parent its record id
//
// Records are handed to ctx.emit as they are made, so dataset output can
// stream millions of them without holding them all.

import { WEEK } from '../time.js';

export function makeCtx(world, { rng, rhythm, content, sink, spaces }) {
  const ctx = {
    world, r: rng, rhythm, content,
    spaces: spaces || (world.spaces || []).map(s => ({ ...s })),
    bots: [],
    series: [],
    nextId: 0,
    count: 0,
    stats: { byKind: {} },
    _dm: new Map(),
    emit(rec) {
      rec.id = ctx.nextId++;
      ctx.count++;
      ctx.stats.byKind[rec.kind] = (ctx.stats.byKind[rec.kind] || 0) + 1;
      sink(rec, ctx);
      return rec.id;
    },
    // A message with content filled from the planted topic/affect/diffusion state.
    msg(m) {
      const space = m.space >= 0 ? ctx.spaces[m.space] : null;
      const vis = m.visibility || (space && space.visibility === 'public' ? 'public' : 'private');
      if (!m.noText) {
        const c = content.message({ actor: m.actor, t: m.t, style: m.style || 'work', visibility: vis, space, reply: m.parent >= 0, delta: m.delta, company: m.company, first: m.first, role: m.role, tags: m.tags });
        m.text = m.text ?? c.text; m.valence = c.valence; m.terms = c.terms;
      }
      m.kind = m.kind || 'message';
      m.vis = vis;
      return ctx.emit(m);
    },
    // Lazily created direct-message space for an unordered pair (or set) of people.
    dmSpace(members, { kind = 'dm', visibility = 'direct', name, extra } = {}) {
      const sorted = members.slice().sort((a, b) => a - b);
      const key = kind + ':' + sorted.join(',');
      let i = ctx._dm.get(key);
      if (i === undefined) {
        i = ctx.spaces.length;
        ctx.spaces.push({ key: `${kind}-${i}`, name: name || null, kind, visibility, members: sorted, dynamic: true, ...extra });
        ctx._dm.set(key, i);
      }
      return i;
    },
    addSpace(s) { ctx.spaces.push(s); return ctx.spaces.length - 1; },
  };
  return ctx;
}

// Rate multiplier for tie ti at time t from the world's planted rules.
export function ruleMatches(world) {
  const rules = world.rules || [];
  const n = world.ties.count;
  return rules.map(rule => {
    const m = new Uint8Array(n);
    for (let ti = 0; ti < n; ti++) m[ti] = rule.match(ti) ? 1 : 0;
    return m;
  });
}

export function tieMult(world, matches, ti, t) {
  let m = 1;
  const rules = world.rules;
  for (let k = 0; k < rules.length; k++) {
    if (!matches[k][ti]) continue;
    const rule = rules[k];
    if (t < rule.from || t >= rule.until) continue;
    m *= typeof rule.mult === 'function' ? rule.mult(t) : rule.mult;
  }
  return m;
}

// Walk every true tie and draw its interactions over its active window:
// Poisson count at ratePerWeek * strength, times from the rhythm, thinned by
// the planted rate rules. onInteraction(ti, a, b, t) decides what form the
// interaction takes in the medium.
export function driveTies(world, ctx, ratePerWeek, onInteraction, { filter, offsetOf } = {}) {
  const { ties, span } = world;
  const r = ctx.r;
  const matches = ruleMatches(world);
  const rules = world.rules || [];
  for (let ti = 0; ti < ties.count; ti++) {
    if (filter && !filter(ti)) continue;
    const a = ties.a[ti], b = ties.b[ti];
    const from = Math.max(span.start, ties.from[ti]);
    const until = Math.min(span.end, ties.until[ti], world.leftAt ? world.leftAt[a] : Infinity, world.leftAt ? world.leftAt[b] : Infinity);
    if (!(until > from)) continue;
    let maxMult = 1;
    for (let k = 0; k < rules.length; k++) if (matches[k][ti] && typeof rules[k].mult === 'number' && rules[k].mult > 1) maxMult *= rules[k].mult;
    const lam = ratePerWeek * ties.w[ti] * ((until - from) / WEEK) * maxMult;
    const cnt = r.poisson(lam);
    for (let j = 0; j < cnt; j++) {
      const t = ctx.rhythm.sample(r, from, until, offsetOf ? offsetOf(a) : (world.tzOffset ? world.tzOffset[a] : 0));
      if (!Number.isFinite(t)) continue;
      if (rules.length) {
        const m = tieMult(world, matches, ti, t);
        if (r.next() * maxMult > m) continue;
      }
      onInteraction(ti, a, b, t);
    }
  }
}

// Shared non-everyone spaces of two people, smallest first.
export function sharedSpaces(byPerson, spaces, a, b) {
  const A = byPerson[a], B = byPerson[b];
  if (!A || !B) return [];
  const out = [];
  for (const s of A) if (B.includes(s)) out.push(s);
  return out.sort((x, y) => spaces[x].members.length - spaces[y].members.length);
}

export const MIN = 60000;
