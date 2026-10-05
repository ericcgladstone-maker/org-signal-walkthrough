// Public posting platforms (X, Bluesky, Mastodon): posts in news-driven
// bursts, replies, mentions, reposts and likes from followers, DMs between
// mutual follows, and timestamped follows for ties formed inside the span.
// Bots post around the clock, mostly repost, and after a planted campaign
// starts they swarm the amplified accounts.

import { MIN } from './core.js';
import { HOUR, WEEK } from '../time.js';

export function simSocial(world, ctx) {
  const { r, rhythm } = ctx;
  const { span, ties, n, isBot } = world;
  const adj = ties.adjacency();
  const weeks = (span.end - span.start) / WEEK;
  const alive = (i, t) => world.leftAt[i] > t;
  const camp = g => world.groups[g]?.political || null;
  const tagsOf = i => world.groups[world.group[i]]?.tags;
  const campaign = world.botCampaign;
  const recentPosts = Array.from({ length: n }, () => []); // per author [{id,t}] for bot targeting

  const followersOf = i => { const o = []; for (let p = adj.in.off[i]; p < adj.in.off[i + 1]; p++) o.push(adj.in.nbr[p]); return o; };
  const followingOf = i => { const o = []; for (let p = adj.out.off[i]; p < adj.out.off[i + 1]; p++) o.push(adj.out.nbr[p]); return o; };

  const engage = (author, postId, t0) => {
    const fol = adj.in.off[author + 1] - adj.in.off[author];
    if (!fol) return;
    const s = Math.sqrt(fol);
    const pick = () => adj.in.nbr[adj.in.off[author] + r.int(fol)];
    const nLike = r.poisson(0.35 * s), nRep = r.poisson(0.06 * s), nRt = r.poisson(0.08 * s);
    for (let k = 0; k < nLike; k++) {
      const u = pick(); const t = t0 + Math.round(r.exp(3) * HOUR);
      if (t < span.end && alive(u, t) && !isBot[u]) ctx.emit({ kind: 'like', t, actor: u, replyTo: author, parent: postId });
    }
    for (let k = 0; k < nRt; k++) {
      const u = pick(); const t = t0 + Math.round(r.exp(4) * HOUR);
      if (t < span.end && alive(u, t)) ctx.emit({ kind: 'repost', t, actor: u, replyTo: author, parent: postId, vis: 'public' });
    }
    for (let k = 0; k < nRep; k++) {
      const u = pick(); const t = t0 + Math.round(r.exp(2) * HOUR) + MIN;
      if (t >= span.end || !alive(u, t) || isBot[u]) continue;
      reply(u, author, postId, t);
    }
  };

  const reply = (u, author, postId, t) => {
    const cu = camp(world.group[u]), ca = camp(world.group[author]);
    const hostile = world.crossCampDelta && cu && ca && cu !== ca;
    const id = ctx.msg({ t, actor: u, replyTo: author, mentions: [author], parent: postId, root: postId, space: -1, style: 'post', visibility: 'public', tags: tagsOf(u), delta: hostile ? world.crossCampDelta : 0 });
    // the author answers back sometimes
    if (r.chance(0.25)) {
      const t2 = t + Math.round(r.exp(1.5) * HOUR) + MIN;
      if (t2 < span.end && alive(author, t2)) ctx.msg({ t: t2, actor: author, replyTo: u, mentions: [u], parent: id, root: postId, space: -1, style: 'post', visibility: 'public', delta: hostile ? world.crossCampDelta : 0 });
    }
  };

  for (let i = 0; i < n; i++) {
    const bot = isBot[i] === 1;
    const rate = bot ? world.params.activity * 6 : world.params.activity * world.prop[i];
    const cnt = r.poisson(rate * weeks);
    const following = followingOf(i);
    for (let k = 0; k < cnt; k++) {
      const t = rhythm.sample(r, span.start, Math.min(span.end, world.leftAt[i]), world.tzOffset[i], bot);
      if (!Number.isFinite(t)) continue;
      if (bot) {
        // bots mostly repost; during a campaign they target the amplified accounts
        const inCampaign = campaign && t >= campaign.from;
        const target = inCampaign && r.chance(0.8) ? r.pick(campaign.targets) : following.length ? r.pick(following) : -1;
        const tp = target >= 0 ? recentPosts[target] : null;
        if (tp && tp.length && r.chance(0.75)) {
          const p = tp[tp.length - 1 - r.int(Math.min(tp.length, 5))];
          if (r.chance(0.8)) ctx.emit({ kind: 'repost', t: Math.max(t, p.t + 30000), actor: i, replyTo: target, parent: p.id, vis: 'public' });
          else ctx.msg({ t: Math.max(t, p.t + 30000), actor: i, replyTo: target, mentions: [target], parent: p.id, root: p.id, space: -1, style: 'bot', visibility: 'public', tags: tagsOf(target) });
          continue;
        }
        ctx.msg({ t, actor: i, space: -1, style: 'bot', visibility: 'public', tags: tagsOf(i) });
        continue;
      }
      const mentions = following.length && r.chance(0.12) ? [r.pick(following)] : undefined;
      const id = ctx.msg({ t, actor: i, space: -1, mentions, style: 'post', visibility: 'public', tags: tagsOf(i) });
      recentPosts[i].push({ id, t });
      if (recentPosts[i].length > 20) recentPosts[i].shift();
      engage(i, id, t);
    }
  }

  // DMs between mutual follows.
  for (let ti = 0; ti < ties.count; ti++) {
    const a = ties.a[ti], b = ties.b[ti];
    if (a > b || isBot[a] || isBot[b] || !ties.has(b, a)) continue;
    const k = r.poisson(0.15 * weeks);
    for (let j = 0; j < k; j++) {
      let t = rhythm.sample(r, span.start, Math.min(span.end, world.leftAt[a], world.leftAt[b]), world.tzOffset[a]);
      if (!Number.isFinite(t)) continue;
      const sp = ctx.dmSpace([a, b], { kind: 'dm', visibility: 'direct' });
      let who = r.chance(0.5) ? a : b;
      for (let m = 1 + r.poisson(1.5); m > 0 && t < span.end; m--) {
        ctx.msg({ t, actor: who, space: sp, to: [who === a ? b : a], style: 'post', visibility: 'private', parent: -1 });
        t += Math.round(r.exp(10) * MIN) + 10000;
        if (r.chance(0.7)) who = who === a ? b : a;
      }
    }
  }

  // Follows formed during the span become timestamped follow events.
  for (let ti = 0; ti < ties.count; ti++) {
    const f = ties.from[ti];
    if (f >= span.start && f < span.end) ctx.emit({ kind: 'follow', t: f, actor: ties.a[ti], to: [ties.b[ti]] });
  }
}
