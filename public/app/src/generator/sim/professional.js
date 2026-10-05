// LinkedIn-like activity: connections (declared ties with their connection
// date, including those formed during the span), sparse direct messages
// concentrated around job changes, and recruiter InMail to non-connections.

import { driveTies, MIN } from './core.js';
import { DAY, HOUR } from '../time.js';

export function simLinkedIn(world, ctx) {
  const { r } = ctx;
  const { span, ties, n } = world;
  // Every connection is a declared tie; the time is when it was made (or the span start if earlier).
  for (let ti = 0; ti < ties.count; ti++) {
    const t = ties.from[ti];
    if (t >= span.end) continue; // not formed yet
    ctx.emit({ kind: 'declared', t: Number.isFinite(t) ? t : span.start, actor: ties.a[ti], to: [ties.b[ti]], weight: 1, meta: { connectedOn: t, tieKind: ties.kindOf(ti) } });
  }
  const careers = world.people.careers;
  const company = i => world.employers[careers[i].jobs[careers[i].jobs.length - 1].employer].name;
  const convo = (a, b, t, opts = {}) => {
    const sp = ctx.dmSpace([a, b], { kind: 'dm', visibility: 'direct' });
    let tt = t, who = a;
    const len = opts.len ?? 1 + r.poisson(0.8);
    for (let k = 0; k < len && tt < span.end; k++) {
      const other = who === a ? b : a;
      ctx.msg({ t: tt, actor: who, space: sp, to: [other], style: 'pro', parent: -1, company: opts.company ?? company(other), first: world.people.first[other], role: careers[who].jobs.at(-1).title, subject: k === 0 ? opts.subject : undefined });
      tt += Math.round(r.exp(20) * HOUR) + 5 * MIN;
      who = other;
    }
  };
  // Ordinary messages between stronger connections.
  driveTies(world, ctx, world.params.activity / 52, (ti, a, b, t) => {
    if (ties.w[ti] < 0.9) return;
    convo(r.chance(0.5) ? a : b, r.chance(0.5) ? b : a, t);
  }, { filter: ti => ties.w[ti] >= 0.9 });
  // Congratulations after job changes.
  for (const e of world.events) {
    if (e.type !== 'job-change') continue;
    const nb = ties.neighbors(e.person).filter(j => ties.from[ties.find(e.person, j)] < e.t);
    for (const j of r.sample(nb, Math.min(nb.length, r.poisson(0.15 * nb.length + 1)))) {
      const t = e.t + Math.round(r.exp(5) * DAY) + HOUR;
      if (t < span.end) convo(j, e.person, t, { len: r.chance(0.6) ? 2 : 1, company: e.to });
    }
  }
  // Recruiters write to people they are not connected to (InMail).
  for (let i = 0; i < n; i++) {
    if (!world.isRecruiter[i]) continue;
    for (let k = r.poisson(n * 0.05); k > 0; k--) {
      const j = r.int(n);
      if (j === i) continue;
      const t = ctx.rhythm.sample(r, span.start, span.end, 0);
      convo(i, j, t, { len: r.chance(0.3) ? 2 : 1, subject: 'Opportunity at ' + company(i) });
    }
  }
}
