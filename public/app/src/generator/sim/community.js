// Community media. Reddit: topic threads (submissions) with comment trees;
// commenters are drawn by activity and by ties to the person they answer, so
// reply networks recover the core. Discord: channel conversations in bursts,
// with reply references, mentions and reactions from tied members.

import { MIN } from './core.js';
import { HOUR, DAY } from '../time.js';
import { cumulative, drawCum } from '../rng.js';

function samplers(world, ctx) {
  const cum = ctx.spaces.map(s => (s.members ? cumulative(s.members.map(i => world.prop[i])) : null));
  const memberSet = ctx.spaces.map(s => new Set(s.members));
  const adj = world.ties.adjacency().out;
  const byProp = (si) => ctx.spaces[si].members[drawCum(cum[si], ctx.r)];
  const tiedTo = (si, p) => {
    const deg = adj.off[p + 1] - adj.off[p];
    for (let k = 0; k < 4 && deg; k++) { const q = adj.nbr[adj.off[p] + ctx.r.int(deg)]; if (memberSet[si].has(q)) return q; }
    return -1;
  };
  return { byProp, tiedTo };
}

export function simReddit(world, ctx) {
  const { r, rhythm } = ctx;
  const { span } = world;
  const days = (span.end - span.start) / DAY;
  const S = samplers(world, ctx);
  ctx.bots.push({ name: 'AutoModerator', label: 'AutoModerator' });
  const alive = (i, t) => world.leftAt[i] > t;
  ctx.spaces.forEach((s, si) => {
    if (s.kind !== 'subreddit') return;
    const thread = (author, t, opts = {}) => {
      const title = ctx.content.message({ actor: author, t, style: 'community', visibility: 'public', space: s }).text;
      const sub = ctx.msg({ t, actor: author, space: si, style: 'community', parent: -1, subject: title, meta: { submission: true, stickied: !!opts.stickied, score: r.poisson(8) } });
      if (r.chance(0.15)) ctx.emit({ kind: 'message', t: t + 20000, actor: -1, space: si, parent: sub, root: sub, replyTo: author, text: ctx.content.level === 'none' ? null : 'Thanks for posting. Please check the wiki and the weekly thread before asking common questions. I am a bot.', meta: { distinguished: 'moderator', score: 1 }, vis: 'public' });
      const comments = [{ id: sub, author, t }];
      const nC = r.poisson(2 + 6 * Math.min(3, world.prop[author]));
      let tt = t;
      for (let k = 0; k < nC; k++) {
        tt += Math.round(r.exp(1.5) * HOUR) + MIN;
        if (tt >= span.end) break;
        const parent = comments.length === 1 || r.chance(0.45) ? comments[0] : comments[1 + r.int(comments.length - 1)];
        let who = r.chance(0.55) ? S.tiedTo(si, parent.author) : -1;
        if (who < 0) who = S.byProp(si);
        if (who === parent.author && comments.length > 1) who = S.byProp(si);
        if (!alive(who, tt)) continue;
        const id = ctx.msg({ t: tt, actor: who, space: si, replyTo: parent.author, parent: parent.id, root: sub, style: 'community', meta: { score: r.poisson(3) - 1 } });
        comments.push({ id, author: who, t: tt });
      }
    };
    const nT = r.poisson(world.params.activity * days * Math.min(1, 0.3 + s.members.length / 200));
    for (let k = 0; k < nT; k++) {
      const a = S.byProp(si);
      const t = rhythm.sample(r, span.start, Math.min(span.end, world.leftAt[a]), world.tzOffset[a]);
      if (Number.isFinite(t)) thread(a, t);
    }
    // weekly stickied thread by a moderator
    if (s.moderators?.length) for (let t = span.start + 9 * HOUR; t < span.end; t += 7 * DAY) thread(s.moderators[0], t, { stickied: true });
  });
}

export function simDiscord(world, ctx) {
  const { r, rhythm } = ctx;
  const { span } = world;
  const days = (span.end - span.start) / DAY;
  ctx.spaces.forEach(s => { if (s.kind === 'subreddit') { s.kind = 'server_channel'; s.name = s.name.replace(/_/g, '-'); } });
  ctx.server = { name: 'Hobby Commons', id: null };
  const S = samplers(world, ctx);
  ctx.bots.push({ name: 'cogsworth', label: 'Cogsworth' });
  const alive = (i, t) => world.leftAt[i] > t;
  ctx.spaces.forEach((s, si) => {
    if (s.kind !== 'server_channel') return;
    const bursts = r.poisson(world.params.activity * days * Math.min(1, 0.3 + s.members.length / 200));
    for (let k = 0; k < bursts; k++) {
      let who = S.byProp(si);
      let t = rhythm.sample(r, span.start, Math.min(span.end, world.leftAt[who]), world.tzOffset[who]);
      if (!Number.isFinite(t)) continue;
      let prev = null;
      for (let m = 2 + r.poisson(5); m > 0 && t < span.end; m--) {
        if (!alive(who, t)) break;
        const rec = { t, actor: who, space: si, style: 'community', parent: -1 };
        if (prev && prev.author !== who && r.chance(0.35)) { rec.parent = prev.id; rec.replyTo = prev.author; }
        if (prev && prev.author !== who && r.chance(0.1)) rec.mentions = [prev.author];
        const id = ctx.msg(rec);
        // reactions from tied members
        if (r.chance(0.2)) for (let j = 1 + r.poisson(0.7); j > 0; j--) {
          const q = S.tiedTo(si, who);
          if (q >= 0 && q !== who && alive(q, t)) ctx.emit({ kind: 'reaction', t: t + Math.round(r.exp(10) * MIN), actor: q, space: si, replyTo: who, parent: id, emoji: ctx.content.reaction(world.affect.valence(world, q, t, 'public')) });
        }
        prev = { id, author: who };
        t += Math.round(r.exp(3) * MIN) + 5000;
        const q = r.chance(0.6) ? S.tiedTo(si, who) : -1;
        who = q >= 0 ? q : S.byProp(si);
      }
    }
  });
  // New members join the server during the span; the bot welcomes them in the first channel.
  const first = ctx.spaces.findIndex(s => s.kind === 'server_channel');
  if (first >= 0) for (let k = r.poisson(Math.max(1, world.n * 0.02)); k > 0; k--) {
    const p = r.int(world.n);
    const t = span.start + Math.round(r.next() * (span.end - span.start));
    ctx.emit({ kind: 'join', t, actor: p, space: first });
    if (r.chance(0.8)) ctx.emit({ kind: 'message', t: t + 2000, actor: -1, space: first, mentions: [p], text: ctx.content.level === 'none' ? null : `Welcome to the server, say hi and grab a role in the roles channel.`, vis: 'public' });
  }
}
