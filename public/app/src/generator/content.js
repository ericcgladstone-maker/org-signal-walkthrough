// Synthetic text with planted topics, affect and diffusion.
//
// Text is template-and-slot generation per register (workplace, casual chat,
// public posts, community threads, professional messages). What a message
// says depends on who writes it and when:
//   topic    words come from the writer's planted community vocabulary (or the
//            space's topic), so topic models can recover the communities;
//   affect   the planted valence for (writer, time, public/private) sets the
//            chance of a clearly positive or negative phrase (VADER-scored);
//   terms    once someone has adopted a planted seed term (see
//            plantCascades), their later messages use it some of the time.
// content: 'none' skips text entirely; 'light' writes one short sentence;
// 'full' writes one to three sentences with emoji, links and hashtags.

import * as V from './vocab.js';

const TERM_WORK = ['Have you tried {t} for this?', 'We could use {t} here.', 'Ran it through {t} again.', 'Started using {t} for the {w}.', 'Ask me about {t}.'];
const TERM_CASUAL = ['have you tried {t}', 'doing {t} again lol', 'ok {t} is my new thing', '{t} later?'];
const TERM_POST = ['#{t}', 'Trying {t} today #{t}', '{t} is everywhere now', 'Ask me about {t}'];

export function makeContent(world, spec, rng) {
  const level = spec.content === 'none' || spec.content === 'full' ? spec.content : 'light';
  const r = rng.fork('content');
  const adoptedAt = world.diffusion?.adoptedAt || new Map();
  const projects = (world.spaces || []).filter(s => s.project).map(s => s.project[0].toUpperCase() + s.project.slice(1));
  const used = new Set();
  const termRate = level === 'full' ? 0.2 : 0.15;

  const fill = (tpl, ctx) => tpl.replace(/\{(\w+)\}/g, (_, k) => {
    switch (k) {
      case 'w': return ctx.word;
      case 'p': return ctx.project || (projects.length ? projects[r.int(projects.length)] : 'the launch');
      case 'd': return r.pick(V.DAYS);
      case 'tw': return r.pick(V.TIMEWORDS);
      case 'e': return r.pick(V.EVENTS);
      case 'thing': return r.pick(V.THINGS);
      case 'food': return r.pick(V.FOODS);
      case 'c': return ctx.company || 'the new place';
      case 'f': return ctx.first || 'there';
      case 'r': return ctx.role || 'analyst';
      case 'ev': return r.pick(V.PRO_EVENTS);
      case 't': return ctx.term;
      case 'link': return link(ctx);
      default: return '';
    }
  });

  function link(ctx) {
    if (ctx.style.startsWith('work')) return `https://docs.${world.domain || 'corp.example'}/d/${r.hex(10)}`;
    return `https://news.example/${ctx.word ? ctx.word.toLowerCase().replace(/[^a-z0-9]+/g, '-') : 'story'}-${r.hex(6)}`;
  }

  const reorgT = world.events?.find(e => e.type === 'reorg')?.t ?? Infinity;
  function words(actor, t, space) {
    if (space && space.words) return space.words;
    const g = world.groupAfter && t >= reorgT ? world.groupAfter[actor] : world.group?.[actor];
    return world.topics?.byGroup?.[g] || world.topics?.general || ['the plan'];
  }

  // One message. opts: { actor, t, style, visibility: 'public'|'private', space, reply, ctx }
  // Returns { text, valence, terms, topic }.
  function message(opts) {
    const { actor, t, style } = opts;
    let valence = actor >= 0 && world.affect ? world.affect.valence(world, actor, t, opts.visibility === 'public' ? 'public' : 'private') : 0;
    if (opts.delta) valence = clamp(valence + opts.delta, -0.95, 0.95);
    if (level === 'none') return { text: null, valence, terms: null, topic: -1 };
    const ws = words(actor, t, opts.space);
    const word = r.pick(ws);
    const ctx = { style, word, project: opts.space?.project ? opts.space.project[0].toUpperCase() + opts.space.project.slice(1) : null, company: opts.company, first: opts.first, role: opts.role, term: null };
    const reg = REGISTERS[style] || REGISTERS.work;
    const pPos = clamp(0.3 + 0.6 * valence, 0.02, 0.92), pNeg = clamp(0.2 - 0.6 * valence, 0.02, 0.92);
    const u = r.next();
    const affect = u < pPos ? reg.pos : u < pPos + pNeg ? reg.neg : null;
    const parts = [];
    const core = fill(r.pick(opts.reply ? reg.reply : reg.core), ctx);
    if (level === 'light') {
      if (affect && r.chance(0.5)) parts.push(r.pick(affect));
      else { parts.push(core); if (affect) parts.push(r.pick(affect)); }
    } else {
      parts.push(core);
      if (affect) parts.push(r.pick(affect));
      if (!opts.reply && r.chance(0.3)) parts.push(fill(r.pick(reg.core), { ...ctx, word: r.pick(ws) }));
    }
    let terms = null;
    const adopted = actor >= 0 ? adoptedAt.get(actor) : null;
    // The first message after adopting a term almost always uses it (that is
    // what makes adoption observable); later messages use it some of the time.
    if (adopted) for (const [term, ta] of adopted) {
      if (ta > t) continue;
      const k = actor + ':' + term;
      if (used.has(k) ? r.chance(termRate) : r.chance(0.9)) { used.add(k); (terms ||= []).push(term); parts.push(fill(r.pick(reg.term), { ...ctx, term })); }
    }
    if (reg.emoji && r.chance(level === 'full' ? 0.45 : 0.25)) parts.push(r.pick(V.EMOJI));
    if (reg.tags && opts.tags && r.chance(0.35)) parts.push('#' + r.pick(opts.tags));
    // Chat runs clauses together loosely; other registers are already sentences.
    let text = reg.lower ? parts.reduce((s, p, i) => (i ? s + (/^\p{Extended_Pictographic}/u.test(p) ? ' ' : r.pick([' ', ', ', '! ', '. '])) + p : p), '') : parts.join(' ');
    if (reg.lower && r.chance(0.6)) text = text.toLowerCase();
    return { text, valence, terms, topic: world.group?.[actor] ?? -1 };
  }

  function subject(actor, t, space) {
    if (level === 'none') return null;
    const w = r.pick(words(actor, t, space));
    const cap = w[0].toUpperCase() + w.slice(1);
    return r.pick([`${cap}`, `${cap} for ${space?.project || 'next week'}`, `Question about the ${w}`, `Update: ${w}`, `${cap} review`, `Notes on the ${w}`]);
  }

  function reaction(valence) {
    const u = r.next();
    if (u < 0.25 + 0.5 * Math.max(0, valence)) return r.pick(V.REACTIONS_POS);
    if (u > 0.92 + 0.07 * valence) return r.pick(V.REACTIONS_NEG);
    return r.pick(V.REACTIONS_NEU);
  }

  return { level, message, subject, reaction, words };
}

const REGISTERS = {
  work: { core: V.WORK_CORE, reply: V.WORK_REPLY, pos: V.WORK_POS, neg: V.WORK_NEG, term: TERM_WORK },
  'work-social': { core: V.WORK_SOCIAL, reply: V.WORK_REPLY, pos: V.WORK_POS, neg: V.WORK_NEG, term: TERM_WORK, emoji: true },
  casual: { core: V.CASUAL_CORE, reply: V.CASUAL_CORE, pos: V.CASUAL_POS, neg: V.CASUAL_NEG, term: TERM_CASUAL, emoji: true, lower: true },
  post: { core: V.POST_CORE, reply: V.POST_REPLY, pos: V.POST_POS, neg: V.POST_NEG, term: TERM_POST, tags: true },
  bot: { core: V.BOT_POSTS, reply: V.BOT_POSTS, pos: V.POST_POS, neg: V.POST_NEG, term: TERM_POST, tags: true },
  community: { core: V.COMM_CORE, reply: V.COMM_REPLY, pos: V.COMM_POS, neg: V.COMM_NEG, term: TERM_POST, emoji: true },
  pro: { core: V.PRO_CORE, reply: V.PRO_REPLY, pos: V.WORK_POS, neg: V.WORK_NEG, term: TERM_WORK },
};

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
