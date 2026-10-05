// Personal messaging (WhatsApp, Telegram, iMessage): one-to-one chats along
// true ties in short turn-taking sessions, and group chats where a session
// is a run of turns, each next speaker more likely someone tied to the last.
// Evenings and weekends dominate. Group membership changes (an add, a leave)
// happen partway through, and some messages are media, edits or deletions,
// as real exports show them.

import { driveTies, MIN } from './core.js';
import { WEEK } from '../time.js';

export function simChats(world, ctx) {
  const { r, rhythm } = ctx;
  const { span, ties } = world;
  const weeks = (span.end - span.start) / WEEK;
  const decorate = rec => {
    const u = r.next();
    if (u < 0.06) rec.meta = { media: r.pick(['image', 'image', 'video', 'audio', 'sticker', 'GIF']) };
    else if (u < 0.07) rec.meta = { deleted: true };
    else if (u < 0.09) rec.meta = { edited: true };
    return rec;
  };

  // One-to-one sessions along every true tie.
  driveTies(world, ctx, world.params.activity / 30, (ti, a0, b0, t) => {
    const [a, b] = r.chance(0.5) ? [a0, b0] : [b0, a0];
    const sp = ctx.dmSpace([a, b], { kind: 'chat', visibility: 'direct' });
    let who = a, tt = t;
    for (let k = 2 + r.poisson(2.5); k > 0 && tt < span.end; k--) {
      const other = who === a ? b : a;
      const rec = decorate({ t: tt, actor: who, space: sp, to: [other], style: 'casual', parent: -1 });
      if (rec.meta?.media || rec.meta?.deleted) rec.noText = true;
      ctx.msg(rec);
      tt += Math.round(r.exp(2.5) * MIN) + 3000;
      if (r.chance(0.7)) who = other;
    }
  }, { offsetOf: () => 0 });

  // Group chats.
  const quiet = world.events.filter(e => e.type === 'quiet');
  ctx.spaces.forEach((s, si) => {
    if (s.kind !== 'group_chat') return;
    s.joinedAt = new Map(s.members.map(m => [m, -Infinity]));
    s.leftAt = new Map();
    // Membership changes: someone is added at ~30%, someone leaves at ~70%.
    const clusterPool = world.people.attrs.map((a, i) => i).filter(i => i > 0 && world.group[i] === s.group && !s.members.includes(i));
    if (clusterPool.length && r.chance(0.7)) {
      const p = r.pick(clusterPool);
      const t = Math.round(span.start + (0.25 + 0.1 * r.next()) * (span.end - span.start));
      const by = r.chance(0.5) ? 0 : s.members[1 + r.int(s.members.length - 1)];
      s.members.push(p); s.joinedAt.set(p, t);
      ctx.emit({ kind: 'join', t, actor: p, space: si, meta: { by } });
    }
    if (s.members.length > 4 && r.chance(0.5)) {
      const p = s.members[1 + r.int(s.members.length - 1)];
      const t = Math.round(span.start + (0.65 + 0.1 * r.next()) * (span.end - span.start));
      if (!(s.joinedAt.get(p) > t)) { s.leftAt.set(p, t); ctx.emit({ kind: 'leave', t, actor: p, space: si }); }
    }
    const present = (p, t) => s.joinedAt.get(p) <= t && !(s.leftAt.get(p) <= t);
    const rate = (s.group === 0 ? 3 : 1.5) * (s.members.length > 12 ? 1.5 : 1);
    const sessions = r.poisson(rate * weeks);
    for (let k = 0; k < sessions; k++) {
      let t = rhythm.sample(r, span.start, span.end, 0);
      if (!Number.isFinite(t)) continue;
      const q = quiet.find(e => e.group === s.group && t >= e.t);
      if (q && !r.chance(q.mult)) continue;
      const here = s.members.filter(p => present(p, t));
      if (here.length < 2) continue;
      let who = r.chance(0.3) && here.includes(0) ? 0 : r.pick(here);
      let prevId = -1, prevWho = -1;
      for (let m = 3 + r.poisson(4); m > 0 && t < span.end; m--) {
        const audience = here.filter(p => p !== who);
        const rec = decorate({ t, actor: who, space: si, audience, style: 'casual', parent: -1 });
        if (prevId >= 0 && prevWho !== who && r.chance(0.25)) { rec.parent = prevId; rec.replyTo = prevWho; }
        if (r.chance(0.04) && audience.length) rec.mentions = [r.pick(audience)];
        if (rec.meta?.media || rec.meta?.deleted) rec.noText = true;
        prevId = ctx.msg(rec); prevWho = who;
        t += Math.round(r.exp(4) * MIN) + 5000;
        // next speaker: tied to the current one more often
        const cands = here.filter(p => p !== who);
        const w = cands.map(p => (ties.has(p, who) ? 3 * ties.w[ties.find(p, who)] : 0.4) * (p === 0 ? 1.5 : 1));
        who = r.pickWeighted(cands, w);
      }
    }
  });
}
