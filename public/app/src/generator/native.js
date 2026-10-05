// What a native export can show, as records for the dataset sink.
//
// With output 'native' the generator's `dataset` is meant to be what the
// written export contains, so that importing the files gives the same
// network (docs/api/generator.md). The simulated records hold more than any
// real export does: an X archive has only the owner's own posts, likes and
// follow lists; a mailbox never shows Bcc on received copies; Slack and
// DiscordChatExporter list reactors without a time; a WhatsApp text export
// has no reply links. Each function below turns the sorted simulation
// records into the records the export can show, following the medium's
// writer and docs/formats/<format>.md. Records are copied, never changed,
// because ground truth and the writers read the originals.
//
// nativeView(medium, env) -> { records, hooks }
//   env = { world, ctx, records, ident, obs, spec, native }
//   native = what the writer reported about values it drew (bot ids,
//            invitation times, follow lists, frequent contacts)
//   hooks  = options read by makeDatasetSink (botKey, visibility, isBot)
// nativeAllNodes(medium, world) -> the sink's allNodes for a native export
// Records marked `selected` were chosen here and bypass the observation filter.

import { EMOJI } from './writers/discord.js';
import { involves } from './observe.js';

const DAY = 86400000;

export function nativeView(medium, env) {
  const f = VIEWS[medium];
  const out = f ? f(env) : { records: env.records };
  out.hooks ||= {};
  if (env.native.botKeys && !out.hooks.botKey) out.hooks.botKey = k => env.native.botKeys[k];
  return out;
}

// Nodes created up front for a full view, unless the export lists only the
// accounts that appear in it.
export function nativeAllNodes(medium, world) {
  if (medium === 'reddit' || medium === 'discord') return 0; // dumps and DCE files name only active accounts
  if (medium === 'survey' && world.recall?.variant === 'roster-matrix') return world.rosterSize; // the roster columns
  return undefined;
}

// Reactions listed on the message with no time of their own: one per
// (message, reactor, emoji as the export names it), dated at the message.
function reactionsAtMessage(records, emojiKey = e => e) {
  const msgT = new Map();
  const seen = new Set();
  const out = [];
  for (const rec of records) {
    if (rec.kind === 'message') { msgT.set(rec.id, rec.t); out.push(rec); continue; }
    if (rec.kind !== 'reaction') { out.push(rec); continue; }
    if (!msgT.has(rec.parent)) continue; // the writer attaches reactions to written messages only
    const k = rec.parent + '|' + rec.actor + '|' + emojiKey(rec.emoji);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...rec, t: msgT.get(rec.parent) });
  }
  return out;
}

const VIEWS = {
  // Slack: reactions are `reactions[{ name, users }]` on the message (spec
  // section 3), no time; bots are keyed by their users.json id.
  slack: ({ records }) => ({ records: reactionsAtMessage(records) }),

  // Mailbox (Takeout): the writer's mailbox selection; Bcc only on the
  // owner's own sent copies ("Not recoverable: Bcc on received copies");
  // a reply tie only when the parent is in the mailbox (spec section 5);
  // thread visibility by the spec's size rule over the copies present.
  email: ({ records, ctx, obs }) => {
    const ego = obs.ego;
    const inBox = rec => {
      if (rec.kind !== 'message' || rec.actor < 0) return false;
      const s = rec.space >= 0 ? ctx.spaces[rec.space] : null;
      if (s && s.list) return rec.actor === ego || s.members.includes(ego);
      return involves(rec, ego);
    };
    const kept = new Set();
    const vis = new Map();
    const rank = { unknown: 0, direct: 1, group: 2 };
    const out = [];
    for (const rec of records) {
      if (!inBox(rec)) continue;
      kept.add(rec.id);
      const s = rec.space >= 0 ? ctx.spaces[rec.space] : null;
      const r = { ...rec, selected: true };
      if (rec.actor !== ego) delete r.bcc;
      if (!(rec.parent >= 0 && kept.has(rec.parent))) r.replyTo = -1;
      if (!(s && s.list)) {
        const recips = new Set([...(r.to || []), ...(r.cc || []), ...(r.bcc || [])].filter(p => p !== rec.actor));
        const v = recips.size > 1 ? 'group' : recips.size === 1 ? 'direct' : 'unknown';
        if (rec.space >= 0 && rank[v] > rank[vis.get(rec.space) ?? 'unknown']) vis.set(rec.space, v);
      } else vis.set(rec.space, 'group');
      out.push(r);
    }
    return { records: out, hooks: { visibility: si => vis.get(si) } };
  },

  // X archive (docs/formats/x-archive.md): tweets.js holds the owner's posts,
  // replies and retweets (no one else's); like.js the owner's likes with no
  // time and, here, no author (expandedUrl is /i/web/status/<id>); follower.js
  // and following.js a snapshot of ids with no dates; direct-messages.js both
  // sides of the owner's DMs. Replies, likes, reposts and follows by others
  // are not in the archive.
  x: ({ records, ctx, obs, native }) => {
    const ego = obs.ego;
    const byId = new Map(records.map(r => [r.id, r]));
    const isTweet = r => r && r.kind === 'message' && !(r.space >= 0);
    const own = r => isTweet(r) && r.actor === ego;
    // Thread root as the importer finds it: up the owner's own reply chain,
    // stopping at the first tweet that is not the owner's.
    const rootOf = r => {
      let cur = r;
      for (let k = 0; k < 1000 && cur.parent >= 0 && byId.has(cur.parent); k++) {
        cur = byId.get(cur.parent);
        if (!own(cur)) break;
      }
      return cur.id;
    };
    const out = [];
    for (const rec of records) {
      if (own(rec)) {
        const reply = rec.replyTo >= 0 && isTweet(byId.get(rec.parent)) ? rec.replyTo : -1;
        const root = rootOf(rec);
        out.push({
          ...rec, replyTo: reply, to: undefined, cc: undefined, audience: undefined,
          mentions: (rec.mentions || []).filter(p => p >= 0 && p !== reply),
          nativeCtx: { key: 'thread:e' + root, name: 'X thread', kind: 'thread', visibility: 'public' },
        });
      } else if (rec.actor === ego && rec.kind === 'repost' && byId.has(rec.parent)) {
        out.push({ ...rec, replyTo: byId.get(rec.parent).actor, parent: -1, space: -1 });
      } else if (rec.actor === ego && rec.kind === 'like' && isTweet(byId.get(rec.parent))) {
        out.push({ ...rec, t: NaN, replyTo: -1, parent: -1, space: -1 });
      } else if (rec.kind === 'message' && rec.space >= 0) {
        const s = ctx.spaces[rec.space];
        if (s.kind === 'dm' && s.members.includes(ego)) out.push(rec);
      }
    }
    for (const b of native.following || []) out.push({ id: -1, kind: 'follow', t: NaN, actor: ego, to: [b], space: -1, parent: -1 });
    for (const a of native.followers || []) out.push({ id: -1, kind: 'follow', t: NaN, actor: a, to: [ego], space: -1, parent: -1 });
    // The archive does not say which accounts are automated.
    return { records: out, hooks: { isBot: () => false } };
  },

  // LinkedIn (docs/formats/linkedin.md section 3): Connections.csv is the
  // owner's star with a date only ("Connected On", read as UTC midnight) and
  // no direction; Invitations.csv adds inviter -> invitee ties for recent
  // requests (minute resolution); messages.csv the owner's conversations.
  linkedin: ({ records, ctx, obs, native }) => {
    const ego = obs.ego;
    const out = [];
    for (const rec of records) {
      if (rec.kind !== 'message' || !(rec.space >= 0)) continue;
      const s = ctx.spaces[rec.space];
      if (s.kind === 'dm' && s.members.includes(ego)) out.push(rec);
    }
    for (const c of native.connections || []) out.push({ id: -1, kind: 'declared', t: Math.floor(c.t / DAY) * DAY, actor: ego, to: [c.other], space: -1, parent: -1 });
    for (const v of native.invitations || []) out.push({ id: -1, kind: 'declared', t: Math.floor(v.t / 60000) * 60000, actor: v.from, to: [v.to], space: -1, parent: -1 });
    return { records: out };
  },

  // WhatsApp text export (docs/formats/whatsapp.md): no reply links and no
  // audience list, so group messages carry only the @mentions written in the
  // text; media and deletion placeholders carry no text and so no mentions.
  whatsapp: ({ records, ctx }) => ({
    records: records.map(rec => {
      if (rec.kind !== 'message') return rec;
      const s = rec.space >= 0 ? ctx.spaces[rec.space] : null;
      const blank = rec.meta?.media || rec.meta?.deleted;
      const group = s && s.kind === 'group_chat';
      // A 1:1 export links a mention only to the two people in the chat.
      const inChat = p => group || !s || s.members.includes(p);
      return {
        ...rec, audience: undefined, replyTo: group ? -1 : rec.replyTo,
        mentions: blank ? [] : (rec.mentions || []).filter(p => p >= 0 && p !== rec.actor && inChat(p)),
      };
    }),
  }),

  // Telegram Desktop JSON (docs/formats/telegram.md): deleted messages are not
  // exported; reply_to_message_id only points at a message present in the
  // same chat; no audience list; invite_members names the inviter, which the
  // importer keeps as the join's subject; frequent_contacts are declared ties
  // weighted by Telegram's rating.
  telegram: ({ records, ctx, obs, native }) => {
    const written = new Set();
    const out = [];
    for (const rec of records) {
      if (rec.kind === 'message') {
        if (rec.meta?.deleted) continue;
        const s = rec.space >= 0 ? ctx.spaces[rec.space] : null;
        const parentOk = rec.parent >= 0 && written.has(rec.parent);
        written.add(rec.id);
        out.push({
          ...rec, audience: undefined,
          replyTo: s && s.kind === 'group_chat' ? (parentOk ? rec.replyTo : -1) : rec.replyTo,
          parent: parentOk ? rec.parent : -1,
          mentions: (rec.mentions || []).filter(p => p >= 0 && p !== rec.actor),
        });
      } else if (rec.kind === 'join' && rec.meta?.by >= 0) out.push({ ...rec, subjects: [rec.meta.by] });
      else out.push(rec);
    }
    if (obs.view !== 'chat') for (const f of native.frequent || []) out.push({ id: -1, kind: 'declared', t: NaN, actor: obs.ego, to: [f.person], weight: f.rating, space: -1, parent: -1 });
    return { records: out };
  },

  // DiscordChatExporter JSON (docs/formats/discord.md b): reactors listed per
  // emoji with no time; a reply references a message in the same file; a
  // reply with ping also lists the parent author in mentions, which the
  // importer folds into the reply.
  discord: ({ records }) => {
    const written = new Set();
    const out = [];
    for (const rec of reactionsAtMessage(records, discordGlyph)) {
      if (rec.kind === 'message') {
        const parentOk = rec.parent >= 0 && written.has(rec.parent);
        written.add(rec.id);
        const reply = parentOk ? rec.replyTo : -1;
        out.push({ ...rec, replyTo: reply, parent: parentOk ? rec.parent : -1, mentions: (rec.mentions || []).filter(p => p >= 0 && p !== reply) });
      } else out.push(rec);
    }
    return { records: out };
  },

  // GraphML (network-files.md section 1): an edge has a first_contact only
  // when the tie began inside the span; ties present all along carry no time.
  // Bot status is only an ordinary node attribute (is_bot), not a flag.
  network: ({ records, world }) => ({
    records: records.map(rec => (rec.kind === 'declared' && rec.t === world.span.start ? { ...rec, t: NaN } : rec)),
    hooks: { isBot: () => false },
  }),

  // Pushshift / Arctic Shift dumps (reddit.md b): a comment's reply target
  // comes from its parent_id, so it is known only when the parent is in the
  // data; a sample holds only what sampled authors wrote. Bots (AutoModerator)
  // are keyed by user name like everyone else.
  reddit: ({ records, ctx, obs }) => {
    const sample = obs.view === 'sample';
    const written = new Set(); // every post the dump would hold without sampling
    const inData = new Set();  // what this export holds
    const out = [];
    for (const rec of records) {
      if (rec.kind !== 'message') { out.push(rec); continue; }
      const isSub = !!rec.meta?.submission;
      if (!isSub && !written.has(rec.parent)) continue; // the writer never writes a comment outside a written thread
      written.add(rec.id);
      if (sample && !(rec.actor >= 0 && obs.sampled?.[rec.actor] === 1)) continue;
      inData.add(rec.id);
      out.push({ ...rec, selected: true, replyTo: isSub || inData.has(rec.parent) ? rec.replyTo : -1 });
    }
    return { records: out, hooks: { botKey: k => 'reddit:' + String(ctx.bots[k]?.name || 'AutoModerator').toLowerCase() } };
  },
};

// The Discord writer maps reaction names to unicode glyphs, unknown names to
// the thumbs-up, so two names can become one reaction.
const discordGlyph = e => (EMOJI[e] ? e : '+1');
