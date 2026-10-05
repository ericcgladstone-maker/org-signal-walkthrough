// Workplace media: Slack-like chat, email and calendar meetings, each driven
// by the same true ties and planted events.

import { driveTies, sharedSpaces, MIN } from './core.js';
import { spacesByPerson } from '../contexts/common.js';
import { DAY, WEEK, HOUR } from '../time.js';

// ---- Slack-like chat ---------------------------------------------------------

export function simSlack(world, ctx) {
  const { r } = ctx;
  const spaces = ctx.spaces;
  const byPerson = spacesByPerson(world.n, spaces);
  const recent = new Map(); // `${space}:${author}` -> [{ id, t, author }]
  const general = spaces.findIndex(s => s.key === 'general');
  const random = spaces.findIndex(s => s.key === 'random');
  const ties = world.ties;
  const adj = ties.adjacency().out;
  const reorg = world.events.find(e => e.type === 'reorg');

  const remember = (space, author, id, t) => {
    const k = space + ':' + author;
    let a = recent.get(k);
    if (!a) recent.set(k, (a = []));
    a.push({ id, t, author });
    if (a.length > 6) a.shift();
  };
  const findRoot = (space, author, t) => {
    const a = recent.get(space + ':' + author);
    if (!a) return null;
    for (let i = a.length - 1; i >= 0; i--) if (a[i].t < t && t - a[i].t < 36 * HOUR) return a[i];
    return null;
  };
  const commonNeighbor = (a, b) => {
    for (let p = adj.off[a]; p < adj.off[a + 1]; p++) {
      const c = adj.nbr[p];
      if (c !== b && ties.has(b, c) && world.leftAt[c] === Infinity) return c;
    }
    return -1;
  };
  const alive = (i, t) => world.leftAt[i] > t;

  const dmExchange = (a, b, t) => {
    const sp = ctx.dmSpace([a, b], { kind: 'dm', visibility: 'direct' });
    let who = a, tt = t;
    const k = 1 + r.poisson(1.2);
    for (let j = 0; j < k && tt < world.span.end; j++) {
      const other = who === a ? b : a;
      if (!alive(who, tt)) break;
      ctx.msg({ t: tt, actor: who, space: sp, to: [other], style: 'work', parent: -1 });
      tt += Math.round(r.exp(7) * MIN) + 5000;
      if (r.chance(0.75)) who = other;
    }
  };

  const groupDm = (a, b, c, t) => {
    const sp = ctx.dmSpace([a, b, c], { kind: 'group_dm', visibility: 'group' });
    const mem = [a, b, c];
    let tt = t;
    for (let j = 0; j < 2 + r.poisson(1); j++) {
      const who = j === 0 ? a : r.pick(mem);
      if (!alive(who, tt)) break;
      ctx.msg({ t: tt, actor: who, space: sp, to: mem.filter(x => x !== who), style: 'work', parent: -1 });
      tt += Math.round(r.exp(5) * MIN) + 3000;
    }
  };

  const thread = (a, b, t, sp) => {
    let root = findRoot(sp, a, t);
    if (!root) {
      const mentions = r.chance(0.25) ? [b] : undefined;
      const id = ctx.msg({ t, actor: a, space: sp, mentions, style: 'work', parent: -1 });
      root = { id, t, author: a };
      remember(sp, a, id, t);
    }
    if (r.chance(0.8)) {
      const t2 = Math.max(t, root.t) + Math.round(r.exp(25) * MIN) + 10000;
      if (t2 < world.span.end && alive(b, t2)) {
        ctx.msg({ t: t2, actor: b, space: sp, replyTo: a, parent: root.id, root: root.id, style: 'work' });
        if (r.chance(0.35)) {
          const t3 = t2 + Math.round(r.exp(15) * MIN) + 10000;
          if (t3 < world.span.end && alive(a, t3)) ctx.msg({ t: t3, actor: a, space: sp, replyTo: a, mentions: r.chance(0.5) ? [b] : undefined, parent: root.id, root: root.id, style: 'work' });
        }
      }
    } else {
      react(b, root, sp, t);
    }
  };

  const react = (who, msg, sp, t) => {
    const t2 = Math.max(t, msg.t) + Math.round(r.exp(30) * MIN) + 5000;
    if (t2 >= world.span.end || !alive(who, t2)) return;
    const v = world.affect.valence(world, who, t2, spaces[sp].visibility === 'public' ? 'public' : 'private');
    ctx.emit({ kind: 'reaction', t: t2, actor: who, space: sp, replyTo: msg.author, parent: msg.id, emoji: ctx.content.reaction(v) });
  };

  driveTies(world, ctx, world.params.activity, (ti, a0, b0, t) => {
    const kind = ties.kindOf(ti);
    let a = a0, b = b0;
    if (r.chance(0.5)) { a = b0; b = a0; }
    let shared = sharedSpaces(byPerson, spaces, a, b);
    if (reorg && t >= reorg.t) shared = shared.filter(s => spaces[s].members.includes(a) && stillMember(world, spaces[s], a, t) && stillMember(world, spaces[s], b, t));
    const pDM = kind === 'hierarchy' ? 0.45 : kind === 'cross' || kind === 'bridge' ? 0.5 : 0.3;
    const u = r.next();
    if (!shared.length || u < pDM) {
      if (r.chance(0.06)) { const c = commonNeighbor(a, b); if (c >= 0) return groupDm(a, b, c, t); }
      return dmExchange(a, b, t);
    }
    const sp = shared[r.chance(0.7) ? 0 : r.int(shared.length)];
    if (u < pDM + 0.45) return thread(a, b, t, sp);
    if (u < pDM + 0.6) {
      const id = ctx.msg({ t, actor: a, space: sp, mentions: [b], style: 'work', parent: -1 });
      remember(sp, a, id, t);
      return;
    }
    const root = findRoot(sp, a, t);
    if (root) return react(b, root, sp, t);
    return thread(a, b, t, sp);
  });

  // Broadcasts: department heads post weekly updates; the CEO posts to #general.
  const { span } = world;
  spaces.forEach((s, si) => {
    if (s.group == null || s.team != null) return;
    const head = world.members[s.group][0];
    for (let wk = span.start; wk < span.end; wk += WEEK) {
      const t = ctx.rhythm.sample(r, wk, Math.min(span.end, wk + WEEK), world.tzOffset[head]);
      if (!alive(head, t)) continue;
      const id = ctx.msg({ t, actor: head, space: si, style: 'work', parent: -1 });
      const cand = s.members.filter(m => m !== head && ties.has(m, head));
      for (const m of r.sample(cand, r.poisson(2))) react(m, { id, t, author: head }, si, t);
    }
  });
  if (general >= 0) {
    for (let t0 = span.start; t0 < span.end; t0 += 2 * WEEK) {
      const t = ctx.rhythm.sample(r, t0, Math.min(span.end, t0 + 2 * WEEK), world.tzOffset[0]);
      const id = ctx.msg({ t, actor: 0, space: general, style: 'work', parent: -1 });
      const nbrs = world.ties.neighbors(0);
      for (const m of r.sample(nbrs, Math.min(nbrs.length, 3 + r.poisson(3)))) react(m, { id, t, author: 0 }, general, t);
    }
  }
  if (random >= 0) {
    const posts = r.poisson(0.04 * world.n * (span.end - span.start) / WEEK);
    for (let k = 0; k < posts; k++) {
      const a = r.int(world.n);
      const t = ctx.rhythm.sample(r, span.start, Math.min(span.end, world.leftAt[a]), world.tzOffset[a]);
      if (!Number.isFinite(t)) continue;
      const id = ctx.msg({ t, actor: a, space: random, style: 'work-social', parent: -1 });
      const nb = world.ties.neighbors(a);
      for (const m of r.sample(nb, Math.min(nb.length, r.poisson(1.5)))) {
        if (r.chance(0.5)) react(m, { id, t, author: a }, random, t);
        else { const t2 = t + Math.round(r.exp(20) * MIN) + 5000; if (t2 < span.end && alive(m, t2)) ctx.msg({ t: t2, actor: m, space: random, replyTo: a, parent: id, root: id, style: 'work-social' }); }
      }
    }
  }

  // Membership changes from planted events.
  for (const e of world.events) {
    if (e.type === 'departure') {
      for (const si of byPerson[e.person]) ctx.emit({ kind: 'leave', t: e.t + 60000, actor: e.person, space: si });
      if (general >= 0) ctx.emit({ kind: 'leave', t: e.t + 60000, actor: e.person, space: general });
    }
    if (e.type === 'reorg') {
      for (const m of e.moved) {
        const old = spaces.findIndex(s => s.key === 'dept-' + m.from);
        const neu = spaces.findIndex(s => s.key === 'dept-' + m.to);
        if (old >= 0) ctx.emit({ kind: 'leave', t: e.t + 3600000, actor: m.person, space: old });
        if (neu >= 0) { ctx.emit({ kind: 'join', t: e.t + 3600000 + 1000, actor: m.person, space: neu }); spaces[neu].joinedLater = (spaces[neu].joinedLater || []).concat(m.person); }
        if (old >= 0) spaces[old].leftLater = (spaces[old].leftLater || []).concat(m.person);
      }
    }
  }

  // A deploy bot in the engineering channel, as real workspaces have.
  const eng = spaces.findIndex(s => s.key === 'dept-0' && world.groups[0].base === 'eng');
  if (eng >= 0) {
    ctx.bots.push({ name: 'deploybot', label: 'Deploy Bot' });
    let k = 1;
    for (let d = span.start; d < span.end; d += DAY) {
      const dow = new Date(d).getUTCDay();
      if (dow === 0 || dow === 6) continue;
      for (let j = r.poisson(1.5); j > 0; j--) {
        const t = d + Math.round((14 + r.next() * 8) * HOUR);
        if (t < span.end) ctx.emit({ kind: 'message', t, actor: -1, space: eng, text: `Deploy #${k++} to production ${r.chance(0.92) ? 'succeeded' : 'failed'}`, vis: 'public' });
      }
    }
  }
}

function stillMember(world, space, p, t) {
  if (space.group == null) return true;
  const after = world.groupAfter;
  return !after || space.group === after[p] || world.group[p] === space.group;
}

// ---- Email ---------------------------------------------------------------------

export function simEmail(world, ctx) {
  const { r } = ctx;
  const ties = world.ties;
  const adj = ties.adjacency().out;
  const alive = (i, t) => world.leftAt[i] > t;
  // Mailing lists: one per department plus all-staff.
  const lists = [];
  world.members.forEach((m, d) => {
    const local = world.spaces.find(s => s.key === 'dept-' + d)?.name || 'dept' + d;
    lists.push(ctx.addSpace({ key: 'list-' + d, name: `${local}@${world.domain}`, kind: 'list', visibility: 'group', members: m.slice(), group: d, list: true, address: `${local}@${world.domain}` }));
  });
  const all = ctx.addSpace({ key: 'list-all', name: `all@${world.domain}`, kind: 'list', visibility: 'group', members: Array.from({ length: world.n }, (_, i) => i), list: true, address: `all@${world.domain}` });

  const pickCc = (a, b) => {
    const out = [];
    if (r.chance(0.2) && world.hierarchy.manager[a] >= 0 && world.hierarchy.manager[a] !== b) out.push(world.hierarchy.manager[a]);
    if (r.chance(0.2)) {
      for (let p = adj.off[a], tries = 0; p < adj.off[a + 1] && tries < 6; p++, tries++) {
        const c = adj.nbr[p + r.int(adj.off[a + 1] - p)];
        if (c !== b && !out.includes(c) && ties.has(b, c)) { out.push(c); break; }
      }
    }
    return out;
  };

  driveTies(world, ctx, world.params.activity * 0.45, (ti, a0, b0, t) => {
    const [a, b] = r.chance(0.5) ? [a0, b0] : [b0, a0];
    const cc = pickCc(a, b);
    const bcc = r.chance(0.03) && world.hierarchy.manager[a] >= 0 && world.hierarchy.manager[a] !== b && !cc.includes(world.hierarchy.manager[a]) ? [world.hierarchy.manager[a]] : undefined;
    const sp = ctx.addSpace({ key: 'thread-' + ctx.spaces.length, kind: 'email_thread', visibility: cc.length ? 'group' : 'direct', members: [a, b, ...cc] });
    const subject = ctx.content.subject(a, t, null);
    ctx.spaces[sp].subject = subject;
    let prev = ctx.msg({ t, actor: a, space: sp, to: [b], cc: cc.length ? cc : undefined, bcc, subject, style: 'work', parent: -1 });
    let tt = t, from = a, to = b, root = prev;
    for (const p of [0.55, 0.3, 0.2]) {
      if (!r.chance(p)) break;
      tt += Math.round(r.exp(3) * HOUR) + 5 * MIN;
      if (tt >= world.span.end || !alive(to, tt)) break;
      [from, to] = [to, from];
      prev = ctx.msg({ t: tt, actor: from, space: sp, to: [to], cc: cc.length ? cc.filter(c => c !== from) : undefined, subject: subject ? 'Re: ' + subject : null, replyTo: to, parent: prev, root, style: 'work' });
    }
  });

  const { span } = world;
  lists.forEach((li, d) => {
    const head = world.members[d][0];
    for (let wk = span.start; wk < span.end; wk += WEEK) {
      const t = ctx.rhythm.sample(r, wk, Math.min(span.end, wk + WEEK), world.tzOffset[head]);
      if (!alive(head, t)) continue;
      ctx.msg({ t, actor: head, space: li, list: true, subject: `${world.groups[d].name} weekly update`, style: 'work', parent: -1, visibility: 'public' });
    }
  });
  for (let t0 = span.start; t0 < span.end; t0 += 4 * WEEK) {
    const t = ctx.rhythm.sample(r, t0, Math.min(span.end, t0 + 4 * WEEK), world.tzOffset[0]);
    ctx.msg({ t, actor: 0, space: all, list: true, subject: `All hands notes`, style: 'work', parent: -1, visibility: 'public' });
  }
}

// ---- Calendar ------------------------------------------------------------------

// Recurring series (team weekly, manager 1:1s, project and leadership syncs)
// plus ad-hoc meetings from ties. A series is split when a planted departure
// or reorg changes who attends, which is how calendar tools record it too.
export function simCalendar(world, ctx) {
  const { r } = ctx;
  const { span } = world;
  const alive = (i, t) => world.leftAt[i] > t;
  const changeTimes = world.events.filter(e => e.type === 'departure' || e.type === 'reorg').map(e => e.t).sort((a, b) => a - b);

  const addSeries = ({ organizer, attendees, title, intervalWeeks = 1, hour = 10, durMin = 30, dow }) => {
    attendees = attendees.filter(x => x !== organizer);
    if (!attendees.length) return;
    const off = world.tzOffset[organizer];
    dow = dow ?? r.intRange(2, 4);
    // first occurrence on or after span.start, at local hour
    let first = span.start + ((dow - new Date(span.start).getUTCDay() + 7) % 7) * DAY + Math.round((hour - off) * HOUR);
    if (first < span.start) first += WEEK;
    const bounds = [span.start, ...changeTimes.filter(t => t > first), span.end];
    for (let k = 0; k + 1 < bounds.length; k++) {
      const segStart = bounds[k], segEnd = bounds[k + 1];
      if (!alive(organizer, segStart)) return;
      const att = attendees.filter(x => alive(x, segStart) && stillWithManager(world, organizer, x, segStart));
      if (!att.length) continue;
      const partstat = {};
      for (const x of att) { const u = r.next(); partstat[x] = u < 0.04 ? 'DECLINED' : u < 0.12 ? 'TENTATIVE' : u < 0.16 ? 'NEEDS-ACTION' : 'ACCEPTED'; }
      partstat[organizer] = 'ACCEPTED';
      const occ = [];
      for (let t = first; t < segEnd; t += intervalWeeks * WEEK) if (t >= segStart) occ.push(t);
      if (!occ.length) continue;
      const series = { uid: `${r.hex(20)}@calendar.${world.domain}`, organizer, attendees: att, title, durMin, intervalWeeks, dtstart: occ[0], until: occ[occ.length - 1], partstat, exdates: [], overrides: [], tzOffset: off };
      // An exception or two: a skipped week and a moved occurrence.
      if (occ.length > 3 && r.chance(0.5)) series.exdates.push(occ[1 + r.int(occ.length - 2)]);
      if (occ.length > 4 && r.chance(0.4)) {
        const o = occ[1 + r.int(occ.length - 2)];
        if (!series.exdates.includes(o)) series.overrides.push({ recurrenceId: o, start: o + DAY + HOUR, title: title + ' (moved)' });
      }
      const si = ctx.series.push(series) - 1;
      const sp = ctx.addSpace({ key: 'series-' + si, name: title, kind: 'meeting', visibility: att.length > 1 ? 'group' : 'direct', members: [organizer, ...att], series: si });
      series.space = sp;
      for (const o of occ) {
        if (series.exdates.includes(o)) continue;
        const ov = series.overrides.find(x => x.recurrenceId === o);
        const start = ov ? ov.start : o;
        const present = att.filter(x => partstat[x] !== 'DECLINED' && alive(x, start));
        if (!present.length) continue; // nobody else attends: no co-presence (the .ics still lists the occurrence)
        ctx.emit({ kind: 'meeting', t: start, actor: organizer, space: sp, attendees: att, present, text: ctx.content.level === 'none' ? null : (ov ? ov.title : title), meta: { series: si, durMin, recurrenceId: o, partstat } });
      }
      first = occ[occ.length - 1] + intervalWeeks * WEEK;
    }
  };

  for (let i = 0; i < world.n; i++) {
    const rep = world.reports[i];
    if (rep.length >= 2) addSeries({ organizer: i, attendees: rep, title: `${world.people.last[i]} team weekly`, hour: r.pick([9.5, 10, 11, 14]), durMin: 30 });
    if (rep.length && rep.length <= 8) for (const x of rep) addSeries({ organizer: i, attendees: [x], title: `1:1 ${world.people.first[i]} / ${world.people.first[x]}`, intervalWeeks: 2, hour: r.pick([9, 13, 15, 16]), durMin: 25 });
  }
  world.spaces.forEach(s => {
    if (s.project) addSeries({ organizer: s.members[0], attendees: s.members.slice(0, 12), title: `${s.project[0].toUpperCase() + s.project.slice(1)} sync`, hour: r.pick([11, 15]), durMin: 45 });
  });
  const leads = world.spaces.find(s => s.key === 'leads');
  if (leads) addSeries({ organizer: 0, attendees: leads.members, title: 'Leadership weekly', dow: 1, hour: 9, durMin: 60 });

  // Ad-hoc meetings from ties.
  const ties = world.ties;
  driveTies(world, ctx, world.params.activity * 0.12, (ti, a0, b0, t) => {
    const [a, b] = r.chance(0.5) ? [a0, b0] : [b0, a0];
    const att = [b];
    const nb = ties.neighbors(a).filter(c => c !== b && ties.has(b, c) && alive(c, t));
    for (const c of r.sample(nb, Math.min(nb.length, r.poisson(0.8)))) att.push(c);
    const start = Math.floor(t / (30 * MIN)) * 30 * MIN;
    const title = ctx.content.subject(a, t, null) || 'Meeting';
    const partstat = { [a]: 'ACCEPTED' };
    for (const x of att) partstat[x] = r.chance(0.07) ? 'DECLINED' : r.chance(0.1) ? 'TENTATIVE' : 'ACCEPTED';
    const series = { uid: `${r.hex(20)}@calendar.${world.domain}`, organizer: a, attendees: att, title, durMin: r.pick([30, 30, 45, 60]), dtstart: start, single: true, partstat, exdates: [], overrides: [], tzOffset: world.tzOffset[a] };
    const si = ctx.series.push(series) - 1;
    const sp = ctx.addSpace({ key: 'series-' + si, name: title, kind: 'meeting', visibility: att.length > 1 ? 'group' : 'direct', members: [a, ...att], series: si });
    series.space = sp;
    const present = att.filter(x => partstat[x] !== 'DECLINED');
    if (!present.length) return; // everyone declined: no co-presence (the .ics still lists the meeting), as for series
    ctx.emit({ kind: 'meeting', t: start, actor: a, space: sp, attendees: att, present, text: ctx.content.level === 'none' ? null : title, meta: { series: si, durMin: series.durMin, partstat } });
  });
}

function stillWithManager(world, organizer, x, t) {
  const re = world.events.find(e => e.type === 'reorg');
  if (!re || t < re.t || !world.hierarchy.managerAfter) return true;
  // After a reorg a moved person leaves their old manager's team meetings.
  const before = world.hierarchy.manager[x], after = world.hierarchy.managerAfter[x];
  if (before === organizer && after !== organizer) return false;
  if (world.groupAfter && world.group[x] !== world.groupAfter[x] && world.group[organizer] === world.group[x]) return false;
  return true;
}
