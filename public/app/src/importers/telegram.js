// Telegram Desktop JSON export (result.json), full or single-chat.
// Spec: docs/formats/telegram.md (structure read from tdesktop's
// export_output_json.cpp).
//
// result.json can be several GB, so it is walked with streamJSON: only one
// message object exists at a time, plus small per-chat tables (message id ->
// sender, display name -> user id) that replies and service messages need.

import { streamJSON } from './lib/json.js';
import { peek } from '../core/fileset.js';
import { UploadError } from '../core/upload.js';
import { nameKey } from './lib/text.js';

const NS = 'telegram';

// chat.type -> how we treat it (spec section 2.2).
const CHAT_TYPES = {
  personal_chat: 'direct', bot_chat: 'bot', saved_messages: 'exclude', replies: 'exclude', verification_codes: 'exclude',
  private_group: 'group', private_supergroup: 'group', public_supergroup: 'group',
  private_channel: 'channel', public_channel: 'channel',
};

// Chat sections inside a full export. left_chats are channels/supergroups the ego left.
const SECTIONS = ['chats', 'left_chats'];

const PATTERNS = [
  'personal_information',
  'contacts.list.*',
  'frequent_contacts.list.*',
  ...SECTIONS.flatMap(s => [`${s}.list.*.name`, `${s}.list.*.type`, `${s}.list.*.id`, `${s}.list.*.messages.*`]),
  // Single-chat export: the chat object is the root.
  'name', 'type', 'id', 'messages.*',
];

// `from_id` / `actor_id` look like "user123", "channel123", "chat123". Keep the
// prefix in the key: a bare chat.id can collide across kinds (spec section 5).
const peerKey = id => `${NS}:${String(id)}`;
const userKey = id => `${NS}:user${String(id)}`;

function resultEntry(fs) {
  return fs.first(/(^|\/)result\.json$/i);
}

// Telegram Desktop's HTML export (the exporter's default format): messages.html,
// messages2.html, ... per chat, plus css/, js/, images/ and, for a full export,
// export_results.html and lists/. Recognised so the person is told to export
// again as JSON rather than that nothing matched.
const HTML_PAGE_RE = /(?:^|\/)(messages\d*|export_results)\.html$/i;
async function htmlExport(fs) {
  const pages = fs.entries.filter(e => HTML_PAGE_RE.test(e.rel));
  for (const p of pages.slice(0, 5)) {
    const head = await peek(p, 4096);
    if (/class="page_wrap"|class="history"|<title>Exported Data<\/title>/.test(head)) return pages;
  }
  return null;
}

const JSON_STEPS = 'In Telegram Desktop: for one chat, open it, then the menu (three dots) > Export chat history; for everything, Settings > Advanced > Export Telegram data. Set Format to "Machine-readable JSON" and load the result.json it writes (or the whole export folder)';

async function detect(fs) {
  const e = resultEntry(fs);
  if (!e) {
    const html = await htmlExport(fs);
    return html ? { score: 0.8, reason: 'Telegram Desktop export in HTML format (needs a JSON export)', files: fs.entries.map(x => x.rel) } : { score: 0 };
  }
  const head = await peek(e, 8192);
  const unixtime = /"date_unixtime"\s*:\s*"\d+"/.test(head);
  if (/"chats"\s*:\s*\{/.test(head) || (/"personal_information"\s*:/.test(head) && /"about"\s*:/.test(head))) {
    return { score: 0.95, reason: 'Telegram Desktop full export (result.json with chats/personal_information)' };
  }
  const typeM = /^\s*\{\s*(?:"name"\s*:\s*"(?:[^"\\]|\\.)*"\s*,\s*)?"type"\s*:\s*"([a-z_]+)"/.exec(head);
  if (typeM && CHAT_TYPES[typeM[1]] && /"messages"\s*:\s*\[/.test(head)) {
    return { score: 0.95, reason: `Telegram Desktop single-chat export (${typeM[1]})` };
  }
  if (unixtime && /"messages"\s*:\s*\[/.test(head)) return { score: 0.7, reason: 'result.json with Telegram-style messages' };
  return { score: 0 };
}

// text_entities is always an array of {type, text}; `text` may be a string or a
// mixed array. Prefer entities (spec 2.3).
function flattenText(m) {
  if (Array.isArray(m.text_entities)) return m.text_entities.map(e => (e && typeof e.text === 'string' ? e.text : '')).join('');
  if (typeof m.text === 'string') return m.text;
  if (Array.isArray(m.text)) return m.text.map(x => (typeof x === 'string' ? x : x?.text ?? '')).join('');
  return '';
}

// rich_message replaces text in recent tdesktop builds; its shape is not
// documented, so collect any string `text` fields defensively.
function richText(v, out = [], depth = 0) {
  if (depth > 20 || out.length > 200) return out;
  if (Array.isArray(v)) for (const x of v) richText(x, out, depth + 1);
  else if (v && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      if (k === 'text' && typeof x === 'string') out.push(x);
      else richText(x, out, depth + 1);
    }
  }
  return out;
}

function timeOf(o) {
  const s = o?.date_unixtime;
  if (s === undefined || s === null || s === '') return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

async function importTelegram(fs, { builder, options = {}, progress, signal } = {}) {
  const e = resultEntry(fs);
  if (!e) {
    const html = await htmlExport(fs);
    if (html) throw new UploadError('telegram-html-format', `This Telegram export is in HTML format (${html.length} page${html.length === 1 ? '' : 's'} such as ${html[0].rel.split('/').pop()}), which cannot be read: the pages hold formatted text without user ids. Export again as JSON. ${JSON_STEPS}.`);
    throw new UploadError('telegram-no-result', `No result.json was found. ${JSON_STEPS}.`);
  }
  if (!e.size) throw new UploadError('empty-upload', `${e.rel.split('/').pop()} is empty (0 bytes). Telegram writes result.json at the end of the export, so the export probably did not finish. Export again: ${JSON_STEPS}.`);
  const includeChannels = options.includeChannels ?? false;
  const includeBotChats = options.includeBotChats ?? false;

  let started = false;
  let single = false;
  let egoKey = null;
  let ego = -1;
  let egoUsername = null;
  const globalNames = new Map(); // nameKey -> user key (from contacts and personal info)

  function start(isSingle) {
    if (started) return;
    started = true;
    single = isSingle;
    builder.beginSource({
      format: 'telegram', family: 'personal', medium: 'telegram', view: isSingle ? 'chat' : 'ego', context: 'personal',
      tz: 'UTC', fileNames: [e.rel], egoKey,
    });
  }

  function personNode(key, label, extra = {}) {
    return builder.node(key, { label: label || undefined, platformIds: { telegram: key.slice(NS.length + 1) }, ...extra });
  }

  // ---- per-chat state ----
  let chat = null; // { section, idx, name, type, id, msgs: [] buffered until type known, ... }

  function newChat(section, idx) {
    return {
      section, idx, name: undefined, type: undefined, id: undefined,
      buffered: [], ctx: -1, kind: null, skip: false, otherKey: null,
      senderOf: new Map(), // message id -> node index
      names: new Map(),   // nameKey -> node key (seen in this chat)
      members: new Set(),
      pending: [],        // membership events whose names resolve at chat end
      reactionsPartial: 0,
    };
  }

  function setupChat(c) {
    const kind = CHAT_TYPES[c.type];
    if (!kind) { builder.warn('unknown-chat-type', `Chats of an unknown type were imported as groups (type "${c.type}").`); }
    const k = kind || 'group';
    if (k === 'exclude') { c.skip = true; builder.stat('chats-excluded'); return; }
    if (k === 'channel' && !includeChannels) {
      c.skip = true;
      builder.warn('channels-excluded', 'Broadcast channels were skipped (one-to-many, not conversation). Turn on "Include channels" to import them.');
      return;
    }
    if (k === 'bot' && !includeBotChats) {
      c.skip = true;
      builder.warn('bot-chats-excluded', 'Chats with bots were skipped. Turn on "Include bot chats" to import them.');
      return;
    }
    const id = String(c.id ?? `${c.section}-${c.idx}`);
    if (k === 'direct' || k === 'bot') {
      c.kind = 'dm';
      // In a personal chat the chat id is the other user's bare id (spec section 3).
      c.otherKey = userKey(id);
      personNode(c.otherKey, c.name, k === 'bot' ? { isBot: true } : {});
      c.ctx = builder.context(`${NS}:dm:${id}`, { name: c.name || id, kind: 'dm', visibility: 'direct' });
    } else if (k === 'channel') {
      c.kind = 'channel';
      c.ctx = builder.context(`${NS}:channel:${id}`, { name: c.name || id, kind: 'channel', visibility: c.type === 'public_channel' ? 'public' : 'private' });
    } else {
      c.kind = 'group_dm';
      c.ctx = builder.context(`${NS}:group_dm:${id}`, { name: c.name || id, kind: 'group_dm', visibility: 'group' });
    }
    builder.stat('chats');
    if (c.section === 'left_chats') builder.stat('left-chats');
  }

  function resolveName(c, name) {
    const k = nameKey(name);
    if (!k) return -1;
    if (egoKey && c.egoName && k === c.egoName) return ego;
    const key = c.names.get(k) || globalNames.get(k);
    if (key) return builder.node(key);
    builder.warn('identity-by-name', 'Some group members appear only by display name in service messages (no Telegram id); they were keyed by name and may duplicate a person.');
    return builder.node(`${NS}:name:${k}`, { label: name });
  }

  function sender(c, idField, nameField) {
    const fid = idField;
    if (fid === undefined || fid === null || fid === '') return -1;
    const key = peerKey(fid);
    const label = nameField ?? (nameField === null ? 'Deleted account' : undefined);
    // A null display name marks a deleted account (docs/formats/telegram.md).
    const i = personNode(key, label, nameField === null ? { attrs: { deactivated: true } } : {});
    if (nameField) c.names.set(nameKey(nameField), key);
    c.members.add(i);
    return i;
  }

  function msgKey(c, id) { return `${NS}:msg:${c.section}:${c.id ?? c.idx}:${id}`; }

  function handleMessage(c, m) {
    if (!m || typeof m !== 'object') return;
    const t = timeOf(m);
    if (m.type === 'unsupported') { builder.stat('unsupported-messages'); return; }
    if (m.type === 'service') return handleService(c, m, t);
    if (m.type !== 'message' && m.type !== undefined) { builder.stat('other-message-types'); return; }
    const actor = sender(c, m.from_id, m.from);
    if (actor < 0) { builder.warn('no-sender', 'Messages without a sender id (from_id) were skipped.'); return; }
    if (Number.isNaN(t)) builder.warn('no-unixtime', 'Messages without date_unixtime have unknown time (the local "date" field is not used: it has no time zone).');
    builder.stat('messages');

    let text = flattenText(m);
    if (!text && m.rich_message) {
      text = richText(m.rich_message).join('\n');
      builder.warn('rich-message', 'Some messages use the newer rich_message layout, which is undocumented; their text was extracted on a best-effort basis.');
    }

    const targets = [];
    if (c.kind === 'dm') {
      const other = c.otherKey && peerKey(m.from_id) === c.otherKey ? (ego >= 0 ? ego : -1) : builder.node(c.otherKey);
      if (other >= 0) targets.push([other, 'dm']);
      else builder.warn('dm-ego-unknown', 'Messages from the other person in a direct chat have no recipient because the exporting account is unknown (single-chat export where you never wrote).');
    }
    let parentKey = null;
    if (m.reply_to_message_id !== undefined && m.reply_to_message_id !== null) {
      if (m.reply_to_peer_id) {
        builder.warn('cross-chat-reply', 'Replies to messages in another chat cannot be linked to their parent.');
      } else {
        parentKey = msgKey(c, m.reply_to_message_id);
        const p = c.senderOf.get(String(m.reply_to_message_id));
        if (p !== undefined) targets.push([p, 'reply']);
      }
    }
    if (Array.isArray(m.text_entities)) {
      for (const ent of m.text_entities) {
        if (!ent) continue;
        if (ent.type === 'mention_name' && ent.user_id !== undefined) {
          targets.push([personNode(userKey(ent.user_id), (ent.text || '').trim() || undefined), 'mention']);
          builder.stat('mentions');
        } else if (ent.type === 'mention' && typeof ent.text === 'string') {
          const u = ent.text.replace(/^@/, '').toLowerCase();
          if (!u) continue;
          builder.stat('mentions');
          if (egoUsername && u === egoUsername && ego >= 0) { targets.push([ego, 'mention']); continue; }
          builder.warn('mention-by-username', '@username mentions carry no Telegram id; they are separate nodes keyed by username and may duplicate a person known by id.');
          targets.push([builder.node(`${NS}:username:${u}`, { label: '@' + u, platformIds: { username: u } }), 'mention']);
        }
      }
    }
    if (m.forwarded_from_id) builder.stat('forwarded');
    const key = msgKey(c, m.id);
    builder.event({ type: 'message', t, actor, targets, context: c.ctx, key, parentKey, text: text || null });
    if (m.id !== undefined) c.senderOf.set(String(m.id), actor);

    if (Array.isArray(m.reactions)) {
      for (const r of m.reactions) {
        const recent = Array.isArray(r?.recent) ? r.recent : [];
        if ((r?.count ?? 0) > recent.length) c.reactionsPartial++;
        const label = r?.emoji ?? r?.document_id ?? r?.type ?? null;
        for (const rr of recent) {
          const ra = sender(c, rr?.from_id, rr?.from);
          if (ra < 0) continue;
          // recent[] has only a local `date` in the spec; use date_unixtime if the
          // writer provides it (not confirmed), else the time is unknown.
          const rt = timeOf(rr);
          if (Number.isNaN(rt)) builder.warn('reaction-time-unknown', 'Reaction times are exported only as local time without a zone, so they were left undated.');
          builder.event({ type: 'reaction', t: rt, actor: ra, targets: [[actor, 'subject']], context: c.ctx, parentKey: key, text: label });
          builder.stat('reactions');
        }
      }
    }
  }

  function handleService(c, m, t) {
    builder.stat('service-messages');
    const actor = sender(c, m.actor_id, m.actor);
    const a = m.action;
    const names = Array.isArray(m.members) ? m.members : [];
    switch (a) {
      case 'create_group':
      case 'invite_members':
        for (const n of names) c.pending.push({ type: 'join', name: n, by: actor, t });
        break;
      case 'remove_members':
        for (const n of names) c.pending.push({ type: 'leave', name: n, by: actor, t });
        break;
      case 'join_group_by_link':
        if (actor >= 0) c.pending.push({ type: 'join', self: actor, byName: m.inviter, t });
        break;
      case 'join_group_by_request':
      case 'join_group_via_community':
        if (actor >= 0) c.pending.push({ type: 'join', self: actor, t });
        break;
      case 'migrate_to_supergroup':
      case 'migrate_from_group':
        builder.warn('group-migrated', 'A basic group was migrated to a supergroup; Telegram gives the two different chat ids, so they appear as two contexts.');
        break;
      case 'phone_call':
      case 'conference_call':
      case 'group_call': {
        if (actor < 0) break;
        if (m.discard_reason === 'missed' || m.discard_reason === 'busy') { builder.stat('missed-calls'); break; }
        const targets = [];
        if (c.kind === 'dm') {
          const other = peerKey(m.actor_id) === c.otherKey ? ego : builder.node(c.otherKey);
          if (other >= 0) targets.push([other, 'attendee']);
        }
        builder.event({ type: 'copresence', t, actor, targets, context: c.ctx, text: null });
        builder.stat('calls');
        break;
      }
      default:
        builder.stat('service-other');
    }
  }

  function finishChat(c) {
    if (!c) return;
    if (c.type === undefined && c.buffered.length) {
      // No type at all: treat as a group so nothing is silently lost.
      builder.warn('chat-without-type', 'A chat had no type field and was imported as a group.');
    }
    if (c.ctx < 0 && !c.skip && (c.buffered.length || c.type !== undefined)) { start(single); setupChat(c); }
    for (const m of c.buffered) if (!c.skip) handleMessage(c, m);
    c.buffered = [];
    if (c.skip) return;
    for (const p of c.pending) {
      let who = p.self ?? resolveName(c, p.name);
      if (who < 0) continue;
      const by = p.byName ? resolveName(c, p.byName) : p.by;
      const targets = by >= 0 && by !== who ? [[by, 'subject']] : [];
      builder.event({ type: p.type, t: p.t, actor: who, targets, context: c.ctx });
      builder.stat(p.type === 'join' ? 'joins' : 'leaves');
      if (p.type === 'join') c.members.add(who);
    }
    if (c.reactionsPartial) builder.warn('reactions-partial', 'Telegram exports only the most recent reactors per reaction, so some reactions have no reactor.', c.reactionsPartial);
    if (c.ctx >= 0) builder.context(builder.contexts.keys[c.ctx], { members: [...c.members] });
  }

  let n = 0;
  const total = e.size || 1;
  let readApprox = 0;
  for await (const { path, pattern, value } of streamJSON(e.stream(), PATTERNS)) {
    if ((++n & 1023) === 0) { signal?.throwIfAborted(); readApprox += 1024 * 400; progress?.(Math.min(0.99, readApprox / total), 'Reading Telegram messages'); }
    const p0 = path[0];
    if (pattern === 'personal_information') {
      const pi = value || {};
      if (pi.user_id !== undefined) {
        egoKey = userKey(pi.user_id);
        start(false);
        builder.source.egoKey = egoKey;
        const label = [pi.first_name, pi.last_name].filter(Boolean).join(' ') || undefined;
        egoUsername = typeof pi.username === 'string' ? pi.username.replace(/^@/, '').toLowerCase() || null : null;
        ego = personNode(egoKey, label, { attrs: { telegram_ego: true }, platformIds: { telegram: `user${pi.user_id}`, ...(egoUsername ? { username: egoUsername } : {}), ...(pi.phone_number ? { phone: pi.phone_number } : {}) } });
        if (label) globalNames.set(nameKey(label), egoKey);
      }
      continue;
    }
    if (pattern === 'contacts.list.*') {
      start(false);
      const ct = value || {};
      if (ct.user_id === undefined || ct.user_id === null || ct.user_id === 0) { builder.stat('contacts-without-id'); continue; }
      const label = [ct.first_name, ct.last_name].filter(Boolean).join(' ') || undefined;
      const k = userKey(ct.user_id);
      builder.node(k, { label, attrs: { telegram_contact: true }, platformIds: { telegram: `user${ct.user_id}`, ...(ct.phone_number ? { phone: ct.phone_number } : {}) } });
      if (label) globalNames.set(nameKey(label), k);
      builder.stat('contacts');
      continue;
    }
    if (pattern === 'frequent_contacts.list.*') {
      start(false);
      const tp = value || {};
      if (tp.type !== 'user' || tp.id === undefined) { builder.stat('frequent-contacts-non-user'); continue; }
      if (tp.category === 'inline_bots') { builder.stat('frequent-contacts-bots'); continue; }
      const k = userKey(tp.id);
      const rating = Number(tp.rating);
      const i = builder.node(k, { label: tp.name || undefined, attrs: { [`telegram_top_${tp.category || 'people'}_rating`]: Number.isFinite(rating) ? rating : undefined }, platformIds: { telegram: `user${tp.id}` } });
      if (tp.name) globalNames.set(nameKey(tp.name), k);
      if (ego < 0) { builder.warn('frequent-contacts-no-ego', 'Frequent contacts were found but the export has no personal_information, so they could not be tied to you.'); continue; }
      builder.event({ type: 'declared', t: NaN, actor: ego, targets: [[i, 'declared']], key: `${NS}:top:${tp.category || 'people'}:${tp.id}`, weight: Number.isFinite(rating) && rating > 0 ? rating : 1, text: null });
      builder.stat('frequent-contacts');
      builder.warn('telegram-rating-weight', "Frequent-contact ties are weighted by Telegram's own top-peer rating, an undocumented score Telegram computes; it is not a count of interactions and has no time.");
      continue;
    }
    // Chat content: full export (section.list.N.x) or single chat (root x).
    let section, idx, field;
    if (SECTIONS.includes(p0) && path[1] === 'list') { section = p0; idx = path[2]; field = path[3]; start(false); }
    else { section = 'chat'; idx = 0; field = path[0]; start(true); }
    if (!chat || chat.section !== section || chat.idx !== idx) { finishChat(chat); chat = newChat(section, idx); if (egoKey) chat.egoName = nameKey(builder.nodes.labels[ego]); }
    if (field === 'messages') {
      if (chat.ctx < 0 && !chat.skip) {
        if (chat.type === undefined) { chat.buffered.push(value); continue; }
        setupChat(chat);
      }
      if (chat.skip) continue;
      handleMessage(chat, value);
      // In a single-chat personal export the ego is whoever is not the other party.
      if (single && ego < 0 && chat.kind === 'dm' && value?.from_id && peerKey(value.from_id) !== chat.otherKey && value.type === 'message') {
        egoKey = peerKey(value.from_id);
        ego = builder.node(egoKey);
        builder.source.egoKey = egoKey;
      }
    } else if (field === 'name' || field === 'type' || field === 'id') {
      chat[field] = value;
    }
  }
  finishChat(chat);
  if (!started) throw new Error('result.json contained no Telegram chats, contacts or personal information.');
  progress?.(1, 'Telegram import done');
}

export default {
  id: 'telegram',
  label: 'Telegram Desktop export (result.json)',
  family: 'personal',
  detect,
  options: [
    { key: 'includeChannels', label: 'Include broadcast channels', type: 'boolean', default: false },
    { key: 'includeBotChats', label: 'Include bot chats', type: 'boolean', default: false },
  ],
  import: importTelegram,
};

export { flattenText, detect };
