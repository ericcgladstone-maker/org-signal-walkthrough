// Discord importer (spec: docs/formats/discord.md).
//
// Two unrelated sources share the name, so one importer branches:
//   (a) the official Data Package: only messages the ego SENT, across every
//       channel and DM. View 'authored'. Located by structure
//       (`<folder>/c?<snowflake>/channel.json`), never by folder name, because
//       folder casing, the 'c' prefix and the account folder name (localised,
//       e.g. 'Compte/') all vary between package generations.
//   (b) DiscordChatExporter (DCE) files: every message of one channel, with
//       authors, mentions, replies and reactors. View 'chat'. JSON is the full
//       format; CSV gives sender and time only; HTML is detected and refused.
//
// Snowflakes exceed 2^53. The package writes message `ID` as a bare JSON
// number, so every JSON read goes through lib/json.js, which quotes 16+ digit
// integer literals before parsing. Ids are handled as strings throughout.

import { peek } from '../core/fileset.js';
import { parseJSON, streamJSON } from './lib/json.js';
import { parseCSV } from './lib/csv.js';
import { snowflakeMs, DISCORD_EPOCH } from './lib/time.js';

const NS = 'discord';
const CHANNEL_RE = /(^|\/)c?(\d{15,20})\/channel\.json$/i;
const DCE_CSV_HEADER = 'AuthorID,Author,Date,Content,Attachments,Reactions';

// Discord API channel-type enum. 2022 packages write the number, 2025 packages
// the name; both map to the name.
const CHANNEL_TYPES = {
  0: 'GUILD_TEXT', 1: 'DM', 2: 'GUILD_VOICE', 3: 'GROUP_DM', 4: 'GUILD_CATEGORY', 5: 'GUILD_ANNOUNCEMENT',
  10: 'ANNOUNCEMENT_THREAD', 11: 'PUBLIC_THREAD', 12: 'PRIVATE_THREAD', 13: 'GUILD_STAGE_VOICE', 15: 'GUILD_FORUM', 16: 'GUILD_MEDIA',
};

export function channelTypeName(t) {
  if (t === null || t === undefined || t === '') return 'UNKNOWN';
  if (typeof t === 'number' || /^\d+$/.test(String(t))) return CHANNEL_TYPES[Number(t)] ?? `TYPE_${t}`;
  return String(t).toUpperCase();
}

// Context kind and visibility for a package channel type. Guild channel
// audiences are unknown to the package; 'public' means "visible within the
// guild", private threads are 'private'.
function packageContextShape(type) {
  switch (type) {
    case 'DM': return { kind: 'dm', visibility: 'direct' };
    case 'GROUP_DM': return { kind: 'group_dm', visibility: 'group' };
    case 'PRIVATE_THREAD': return { kind: 'thread', visibility: 'private' };
    case 'PUBLIC_THREAD': case 'ANNOUNCEMENT_THREAD': return { kind: 'thread', visibility: 'public' };
    case 'UNKNOWN': return { kind: 'channel', visibility: 'unknown' };
    default: return { kind: 'channel', visibility: type.startsWith('GUILD_') ? 'public' : 'unknown' };
  }
}

// DCE ChannelKind names.
function dceContextShape(type) {
  switch (type) {
    case 'DirectTextChat': return { kind: 'dm', visibility: 'direct' };
    case 'DirectGroupTextChat': return { kind: 'group_dm', visibility: 'group' };
    case 'GuildPrivateThread': return { kind: 'thread', visibility: 'private' };
    case 'GuildPublicThread': case 'GuildNewsThread': return { kind: 'thread', visibility: 'public' };
    default: return { kind: 'channel', visibility: /^Guild/.test(type || '') ? 'public' : 'unknown' };
  }
}

// Timestamps seen in the wild:
//   package JSON  "2023-12-11 02:01:09"                 no zone: the spec says treat as UTC
//   package CSV   "2022-08-02 00:59:59.753000+00:00"    microseconds, offset
//   DCE JSON      "2026-09-01T14:02:11.512+00:00"       exporter's local offset
//   DCE CSV       "2026-09-01T14:02:11.5120000+02:00"   .NET round-trip "o" (7 digits)
// Parsed explicitly rather than trusting Date.parse leniency with these shapes.
export function parseDiscordTime(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const ms = m[7] ? +m[7].slice(0, 3).padEnd(3, '0') : 0;
  let t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
  if (m[8] && m[8].toUpperCase() !== 'Z') {
    const z = m[8].replace(':', '');
    t -= (z[0] === '-' ? -1 : 1) * (+z.slice(1, 3) * 60 + +z.slice(3, 5)) * 60000;
  }
  return t;
}

// User mentions in message text: <@id> and the legacy nickname form <@!id>.
// Role (<@&id>) and channel (<#id>) mentions are not people and are skipped.
export function textMentions(text) {
  const out = [];
  if (typeof text !== 'string') return out;
  for (const m of text.matchAll(/<@!?(\d{15,20})>/g)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

// "Direct Message with nova_fox#0" -> { username: 'nova_fox', discriminator: '0' }
function parseDmLabel(label) {
  const m = /^Direct Message with (.+?)(?:#(\d{1,4}))?$/.exec(String(label ?? ''));
  return m ? { username: m[1], discriminator: m[2] ?? null } : null;
}

function displayTag(username, discriminator) {
  return discriminator && !/^0+$/.test(discriminator) ? `${username}#${discriminator}` : username;
}

// ---- detection ---------------------------------------------------------------

function packageRoots(fs) {
  const roots = new Map(); // messages root rel prefix -> [{ dir, id, channelEntry }]
  for (const e of fs.entries) {
    const m = CHANNEL_RE.exec(e.rel);
    if (!m) continue;
    const dir = e.rel.slice(0, e.rel.length - 'channel.json'.length);
    const parent = dir.replace(/[^/]+\/$/, '');
    if (!roots.has(parent)) roots.set(parent, []);
    roots.get(parent).push({ dir, id: m[2], channelEntry: e });
  }
  return roots;
}

async function sniffDce(e) {
  const head = await peek(e, 4096);
  if (/\.json$/i.test(e.rel)) {
    const hasGuild = /"guild"\s*:\s*\{/.test(head), hasChannel = /"channel"\s*:\s*\{/.test(head);
    if (hasGuild && hasChannel && /"messages"\s*:\s*\[/.test(head)) return 'json';
    if (hasGuild && hasChannel && /"exportedAt"\s*:/.test(head)) return 'json';
    return null;
  }
  if (/\.csv$/i.test(e.rel)) return head.replace(/^﻿/, '').startsWith(`"AuthorID","Author"`) || head.replace(/^﻿/, '').startsWith(DCE_CSV_HEADER) ? 'csv' : null;
  if (/\.html?$/i.test(e.rel)) return head.includes('chatlog__') ? 'html' : null;
  return null;
}

async function detect(fs) {
  const roots = packageRoots(fs);
  if (roots.size) {
    for (const [root, chans] of roots) {
      if (fs.get(root + 'index.json')) return { score: 0.95, reason: `Discord data package (${chans.length} channel folders with index.json)` };
    }
    return { score: 0.8, reason: 'Discord data package layout (channel folders with channel.json)' };
  }
  // detect() must stay cheap: a Slack export holds thousands of JSON files.
  // DiscordChatExporter names files "<Guild> - <Channel> [<id>].<ext>", so
  // those are sniffed first, then a bounded sample of the rest.
  const cands = fs.entries.filter(e => /\.(json|csv|html?)$/i.test(e.rel));
  const named = cands.filter(e => /\[\d{6,}\]\.(json|csv|html?)$/i.test(e.rel));
  for (const e of [...named.slice(0, 20), ...cands.filter(e => !named.includes(e)).slice(0, 20)]) {
    if (await sniffDce(e)) return { score: 0.95, reason: 'DiscordChatExporter export' };
  }
  return { score: 0, reason: '' };
}

// ---- official data package -----------------------------------------------------

async function readJSONEntry(e) { return parseJSON(await e.text()); }

function findUserJson(fs, roots) {
  // Account folder name is localised; user.json sits one level below the
  // package root (the parent of the messages root). Pick the shallowest.
  const pkgRoots = [...roots.keys()].map(r => r.replace(/[^/]+\/$/, ''));
  const cands = fs.entries.filter(e => /(^|\/)user\.json$/i.test(e.rel) && !/(^|\/)activity\//i.test(e.rel)
    && pkgRoots.some(p => e.rel.startsWith(p) && e.rel.slice(p.length).split('/').length === 2));
  cands.sort((a, b) => a.rel.length - b.rel.length);
  return cands[0] ?? null;
}

async function importPackage(fs, roots, { builder, options, progress, signal }) {
  const userEntry = findUserJson(fs, roots);
  let user = null;
  if (userEntry) {
    try {
      const u = await readJSONEntry(userEntry);
      // Keep only identity fields; user.json also holds email, IPs and payments.
      user = { id: u.id != null ? String(u.id) : null, username: u.username, discriminator: u.discriminator != null ? String(u.discriminator) : null,
        globalName: u.global_name ?? u.display_name ?? null, relationships: Array.isArray(u.relationships) ? u.relationships : [] };
    } catch { user = null; }
  }

  const chanList = [...roots.values()].flat();
  // Without user.json the ego is the id common to every DM's recipients.
  let egoId = user?.id ?? null;
  const channels = [];
  let unreadable = 0;
  for (const c of chanList) {
    let ch = {};
    try { ch = await readJSONEntry(c.channelEntry); } catch { unreadable++; }
    channels.push({ ...c, ch });
  }
  if (!egoId) {
    let common = null;
    for (const { ch } of channels) {
      if (!Array.isArray(ch.recipients) || channelTypeName(ch.type) !== 'DM') continue;
      const ids = ch.recipients.map(String).filter(x => /^\d+$/.test(x));
      common = common ? common.filter(x => ids.includes(x)) : ids;
    }
    if (common && common.length === 1) egoId = common[0];
  }

  const fileNames = [...new Set([...roots.keys()].map(r => r || '(root)'))];
  builder.beginSource({ format: 'discord', family: 'community', medium: 'discord', view: 'authored', context: 'community', tz: 'UTC',
    fileNames: fs.names?.length ? fs.names : fileNames, egoKey: egoId ? `${NS}:${egoId}` : null, variant: 'package' });
  builder.warn('outgoing-only', 'Discord data packages contain only messages you sent. Incoming messages, replies and other people\'s interactions are not included, so treat this as your outgoing activity, not a network.', 1);
  if (unreadable) builder.warn('bad-channel-json', 'Some channel.json files could not be parsed; those channels are imported with unknown type.', unreadable);
  if (!userEntry || !user) builder.warn('no-user-json', 'Account/user.json was not found or could not be read; the account owner was inferred from DM recipients.', 1);
  if (!egoId) {
    builder.warn('ego-unknown', 'Could not tell which account exported this package (no user.json and no DM recipients to infer it from). Messages are attributed to a placeholder "you" node.', 1);
  }
  const egoKey = egoId ? `${NS}:${egoId}` : `${NS}:ego`;
  const ego = builder.node(egoKey, { label: user ? (user.globalName || displayTag(user.username, user.discriminator)) : 'You', platformIds: egoId ? { discord: egoId, username: user?.username } : undefined });

  // Names for alters from relationships (friends, blocked, pending).
  const byUsername = new Map();
  const relLabel = new Map();
  for (const r of user?.relationships ?? []) {
    const u = r?.user; if (!u?.id) continue;
    const id = String(u.id);
    const label = u.global_name || displayTag(u.username, u.discriminator != null ? String(u.discriminator) : null);
    relLabel.set(id, { label, username: u.username });
    if (u.username) byUsername.set(`${u.username}#${u.discriminator ?? ''}`.toLowerCase(), id), byUsername.set(String(u.username).toLowerCase(), id);
  }
  const alter = (id, label) => {
    const rl = relLabel.get(id);
    return builder.node(`${NS}:${id}`, { label: rl?.label ?? label, platformIds: { discord: id, ...(rl?.username ? { username: rl.username } : {}) } });
  };

  // Friendships (relationship type 1) as declared ties, per spec "optional".
  if (options?.friends ?? true) {
    for (const r of user?.relationships ?? []) {
      if (Number(r?.type) !== 1 || !r.user?.id) continue;
      const a = alter(String(r.user.id));
      builder.event({ type: 'declared', t: NaN, actor: ego, targets: [[a, 'declared']], key: `${NS}:friend:${egoId}:${r.user.id}` });
      builder.stat('friends');
    }
  }

  let done = 0;
  const indexes = new Map(); // messages root -> index.json content (channel id -> label)
  for (const { dir, id: folderId, ch } of channels) {
    signal?.throwIfAborted();
    const root = dir.replace(/[^/]+\/$/, '');
    if (!indexes.has(root)) {
      const ie = fs.get(root + 'index.json');
      let idx = null;
      try { idx = ie ? await readJSONEntry(ie) : null; } catch { builder.warn('bad-index-json', 'Messages/index.json could not be parsed; channel names fall back to channel.json.', 1); }
      indexes.set(root, idx);
    }
    const index = indexes.get(root);
    const chId = ch.id != null ? String(ch.id) : folderId;
    const type = channelTypeName(ch.type);
    const label = index && typeof index[chId] === 'string' && index[chId] !== 'None' ? index[chId] : null;
    const shape = packageContextShape(type);

    // DM partner(s).
    let others = [];
    if (Array.isArray(ch.recipients)) {
      const ids = ch.recipients.map(String);
      if (ids.includes('Deleted User')) builder.warn('deleted-user', 'Some DM recipients are listed as "Deleted User" and have no id; they are left out.', 1);
      others = ids.filter(x => /^\d+$/.test(x) && x !== egoId);
    }
    if (type === 'DM' && !others.length) {
      const dm = parseDmLabel(label);
      const hit = dm && (byUsername.get(`${dm.username}#${dm.discriminator ?? ''}`.toLowerCase()) ?? byUsername.get(dm.username.toLowerCase()));
      if (hit) others = [hit];
      else builder.warn('dm-partner-unknown', 'A DM channel has no recipients list and its partner could not be matched to a known user; its messages carry no DM target.', 1);
    }
    const otherNodes = others.map(o => {
      const dm = type === 'DM' ? parseDmLabel(label) : null;
      return alter(o, dm ? displayTag(dm.username, dm.discriminator) : undefined);
    });

    let name = label;
    if (!name) {
      if (ch.name && ch.guild?.name) name = `${ch.name} in ${ch.guild.name}`;
      else if (ch.name) name = ch.name;
      else if (type === 'GROUP_DM') name = 'Group DM';
      else name = `Channel ${chId}`;
    }
    const ctx = builder.context(`${NS}:${shape.kind}:${chId}`, { name, kind: shape.kind, visibility: shape.visibility, medium: 'discord',
      members: shape.kind === 'dm' || shape.kind === 'group_dm' ? [ego, ...otherNodes] : undefined });
    builder.stat('channels');

    const add = (idRaw, tsRaw, contents) => {
      const id = idRaw != null ? String(idRaw) : null;
      let t = parseDiscordTime(tsRaw);
      if (Number.isNaN(t) && id && /^\d+$/.test(id)) { t = snowflakeMs(id, DISCORD_EPOCH); builder.warn('time-from-id', 'Some messages had no readable timestamp; their time was derived from the message id.', 1); }
      const targets = [];
      if (shape.kind === 'dm') for (const o of otherNodes) targets.push([o, 'dm']);
      for (const mid of textMentions(contents)) {
        const n = alter(mid);
        if (!targets.some(([x]) => x === n)) targets.push([n, 'mention']);
      }
      builder.event({ type: 'message', t, actor: ego, targets, context: ctx, key: id ? `${NS}:msg:${id}` : null, text: contents || null });
      builder.stat('messages');
    };

    const jsonEntry = fs.get(dir + 'messages.json');
    const csvEntry = jsonEntry ? null : fs.get(dir + 'messages.csv');
    if (jsonEntry) {
      for await (const { value: m } of streamJSON(jsonEntry.stream(), ['*'])) add(m.ID ?? m.id, m.Timestamp ?? m.timestamp, m.Contents ?? m.contents);
    } else if (csvEntry) {
      const { rows } = parseCSV(await csvEntry.text());
      for (const r of rows) add(r.ID, r.Timestamp, r.Contents);
    } else {
      builder.warn('no-messages-file', 'A channel folder has neither messages.json nor messages.csv.', 1);
    }
    done++;
    if (done % 50 === 0) progress?.(done / channels.length, `Discord channels ${done}/${channels.length}`);
  }
  progress?.(1, 'Discord package read');
}

// ---- DiscordChatExporter ----------------------------------------------------------

const MESSAGE_KINDS = new Set(['Default', 'Reply', 'ThreadStarterMessage']);

function userNode(builder, u) {
  if (!u?.id) return -1;
  const id = String(u.id);
  const roles = Array.isArray(u.roles) ? u.roles.map(r => r?.name).filter(Boolean).join(', ') : undefined;
  return builder.node(`${NS}:${id}`, {
    label: u.nickname || u.name || undefined,
    attrs: { name: u.name, nickname: u.nickname, roles: roles || undefined },
    isBot: !!u.isBot,
    platformIds: { discord: id, ...(u.name ? { username: u.name } : {}) },
  });
}

async function importDceJson(e, { builder, progress, signal }) {
  builder.beginSource({ format: 'discord', family: 'community', medium: 'discord', view: 'chat', context: 'community', tz: 'UTC', fileNames: [e.rel], variant: 'dce-json' });
  let guild = null, channel = null, ctx = -1, shape = null;
  const authorOf = new Map(); // message id -> author node
  const pending = []; // DM messages wait for the participant set
  const offsets = new Set();
  let count = 0;

  const ensureContext = () => {
    if (ctx >= 0) return;
    shape = dceContextShape(channel?.type);
    const chId = channel?.id != null ? String(channel.id) : e.rel;
    let name = channel?.name || chId;
    if (shape.kind === 'channel' || shape.kind === 'thread') name = guild?.name && guild.id !== '0' ? `${name} in ${guild.name}` : name;
    ctx = builder.context(`${NS}:${shape.kind}:${chId}`, { name, kind: shape.kind, visibility: shape.visibility, medium: 'discord' });
  };

  const emit = (m, author, t, otherDm) => {
    const targets = [];
    const isReply = m.type === 'Reply' && m.reference?.messageId && (m.reference.type ?? 'Default') === 'Default';
    let parentKey = null;
    if (isReply) {
      const pid = String(m.reference.messageId);
      parentKey = `${NS}:msg:${pid}`;
      const pa = authorOf.get(pid);
      if (pa !== undefined) targets.push([pa, 'reply']);
      else builder.warn('reply-parent-outside-export', 'Some replies point to messages outside this export (other channel or date range); their reply target is unknown.', 1);
    }
    if (otherDm !== undefined && otherDm >= 0 && otherDm !== author) targets.push([otherDm, 'dm']);
    // Slash-command responses: the bot is the author, interaction.user the human it answers.
    if (m.interaction?.user) { const h = userNode(builder, m.interaction.user); if (h >= 0) targets.push([h, 'reply']); }
    // A reply with ping also lists the parent author in mentions; dedupe.
    for (const u of m.mentions ?? []) {
      const n = userNode(builder, u);
      if (n >= 0 && !targets.some(([x]) => x === n)) targets.push([n, 'mention']);
    }
    builder.event({ type: 'message', t, actor: author, targets, context: ctx, key: `${NS}:msg:${m.id}`, parentKey, text: m.content || null });
    builder.stat('messages');
    for (const r of m.reactions ?? []) {
      const users = Array.isArray(r.users) ? r.users : [];
      if (users.length < (Number(r.count) || 0)) builder.warn('reactors-incomplete', 'Some reactions list fewer reacting users than their count (older DiscordChatExporter versions omit reactors); only listed reactors become reaction events.', (Number(r.count) || 0) - users.length);
      for (const u of users) {
        const n = userNode(builder, u);
        if (n < 0) continue;
        builder.event({ type: 'reaction', t, actor: n, targets: [[author, 'subject']], context: ctx, parentKey: `${NS}:msg:${m.id}`, text: r.emoji?.name ?? null });
        builder.stat('reactions');
        builder.warn('reaction-time-approximate', 'Reaction times are not in the export; reactions use the time of the message reacted to.', 1);
      }
    }
  };

  for await (const { pattern, value } of streamJSON(e.stream(), ['guild', 'channel', 'messages.*'])) {
    if (pattern === 'guild') { guild = { ...value, id: value?.id != null ? String(value.id) : null }; continue; }
    if (pattern === 'channel') { channel = value; continue; }
    signal?.throwIfAborted();
    ensureContext();
    const m = value;
    m.id = String(m.id);
    const author = userNode(builder, m.author);
    if (author < 0) { builder.warn('no-author', 'Messages without an author id were skipped.', 1); continue; }
    authorOf.set(m.id, author);
    const t = parseDiscordTime(m.timestamp);
    const off = /([+-]\d{2}:?\d{2}|Z)$/i.exec(String(m.timestamp ?? ''));
    if (off) offsets.add(off[1].toUpperCase() === 'Z' ? '+00:00' : off[1]);
    count++;
    const kind = String(m.type ?? 'Default');
    if (kind === 'GuildMemberJoin' || kind === 'RecipientAdd' || kind === 'RecipientRemove') {
      // RecipientAdd/Remove name the actor only; who was added or removed is
      // not a documented field, so record the author's own join/leave (approximate).
      const type = kind === 'RecipientRemove' ? 'leave' : 'join';
      builder.event({ type, t, actor: author, context: ctx, key: `${NS}:msg:${m.id}` });
      builder.stat(type === 'join' ? 'joins' : 'leaves');
      continue;
    }
    if (!MESSAGE_KINDS.has(kind)) { builder.warn('system-messages-skipped', 'System messages (calls, pins, renames, thread notices, poll results) were skipped.', 1); continue; }
    if (shape.kind === 'dm') pending.push([m, author, t]);
    else emit(m, author, t);
  }
  ensureContext();
  if (pending.length) {
    const people = [...new Set(pending.map(p => p[1]))];
    if (people.length > 2) builder.warn('dm-many-authors', 'A direct-message export has more than two authors; DM targets were left out.', 1);
    if (people.length === 1) builder.warn('dm-partner-unknown', 'Only one person wrote in this direct-message export, so the partner\'s id is unknown; messages carry no DM target.', 1);
    builder.context(builder.contexts.keys[ctx], { members: people });
    for (const [m, author, t] of pending) {
      const other = people.length === 2 ? people.find(p => p !== author) : undefined;
      emit(m, author, t, other);
    }
  }
  if (offsets.size && [...offsets].some(o => o !== '+00:00')) {
    builder.warn('exporter-local-time', `Timestamps carry the exporter's local UTC offset (${[...offsets].join(', ')}); instants are exact, but time-of-day patterns reflect that zone.`, 1);
  }
  if (!count && !channel) builder.warn('empty-export', 'No channel or messages were found in this DiscordChatExporter file.', 1);
}

async function importDceCsv(e, { builder }) {
  builder.beginSource({ format: 'discord', family: 'community', medium: 'discord', view: 'chat', context: 'community', tz: 'UTC', fileNames: [e.rel], variant: 'dce-csv' });
  builder.warn('dce-csv-limited', 'DiscordChatExporter CSV holds sender and time only: no message ids, mentions, replies or reactors. Export as JSON for a full network.', 1);
  const base = e.rel.split('/').pop();
  const idm = /\[(\d{15,20})\](?: \[part \d+\])?\.csv$/i.exec(base);
  const isDm = /^Direct Messages - /i.test(base);
  const shape = isDm ? { kind: 'dm', visibility: 'direct' } : { kind: 'channel', visibility: 'unknown' };
  const ctx = builder.context(`${NS}:${shape.kind}:${idm ? idm[1] : base}`, { name: base.replace(/\.csv$/i, ''), kind: shape.kind, visibility: shape.visibility, medium: 'discord' });
  const { rows } = parseCSV(await e.text());
  const parsed = [];
  for (const r of rows) {
    const id = String(r.AuthorID ?? '').trim();
    if (!/^\d+$/.test(id)) { builder.warn('no-author', 'Rows without an author id were skipped.', 1); continue; }
    const tag = String(r.Author ?? '');
    const m = /^(.*)#(\d{4})$/.exec(tag);
    const n = builder.node(`${NS}:${id}`, { label: m ? displayTag(m[1], m[2]) : tag || undefined, platformIds: { discord: id, username: m ? m[1] : tag } });
    parsed.push([n, parseDiscordTime(r.Date), r.Content]);
  }
  const people = [...new Set(parsed.map(p => p[0]))];
  if (isDm) builder.context(builder.contexts.keys[ctx], { members: people });
  for (const [n, t, text] of parsed) {
    const targets = isDm && people.length === 2 ? [[people.find(p => p !== n), 'dm']] : [];
    builder.event({ type: 'message', t, actor: n, targets, context: ctx, text: text || null });
    builder.stat('messages');
  }
}

async function importFn(fs, ctx) {
  const roots = packageRoots(fs);
  if (roots.size) return importPackage(fs, roots, ctx);
  const files = [];
  for (const e of fs.entries) {
    if (!/\.(json|csv|html?)$/i.test(e.rel)) continue;
    const kind = await sniffDce(e);
    if (kind) files.push([e, kind]);
  }
  let i = 0;
  for (const [e, kind] of files) {
    ctx.signal?.throwIfAborted();
    if (kind === 'json') await importDceJson(e, ctx);
    else if (kind === 'csv') await importDceCsv(e, ctx);
    else {
      ctx.builder.beginSource({ format: 'discord', family: 'community', medium: 'discord', view: 'chat', context: 'community', tz: 'UTC', fileNames: [e.rel], variant: 'dce-html' });
      ctx.builder.warn('dce-html-unsupported', 'DiscordChatExporter HTML is not imported (display-formatted times cannot be read reliably). Re-export the channel as JSON.', 1);
    }
    ctx.progress?.(++i / files.length, `Discord file ${i}/${files.length}`);
  }
  if (!files.length) {
    ctx.builder.beginSource({ format: 'discord', family: 'community', medium: 'discord', view: 'chat', context: 'community', tz: 'UTC', fileNames: fs.names ?? [] });
    ctx.builder.warn('nothing-found', 'No Discord data package or DiscordChatExporter file was found.', 1);
  }
}

export default {
  id: 'discord',
  label: 'Discord (data package or DiscordChatExporter)',
  family: 'community',
  detect,
  options: [
    { key: 'friends', label: 'Include friend list as declared ties (data package)', type: 'boolean', default: true },
  ],
  import: importFn,
};

