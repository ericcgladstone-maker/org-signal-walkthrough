// Slack workspace and Enterprise Grid exports (docs/formats/slack.md).
//
// Layout: metadata files (users.json / org_users.json, channels.json,
// groups.json, dms.json, mpims.json) at the root and, for Grid, again under
// teams/<workspace>/. Each conversation is a folder of YYYY-MM-DD.json day
// files, each a JSON array of message objects.
//
// Rules from the spec that this file is built around:
// - Conversation type comes ONLY from which metadata file lists the folder
//   (channels -> public, groups -> private, dms -> direct, mpims -> group).
//   Never from the folder name or the C/G/D id prefix.
// - Time comes ONLY from `ts`. Day-file names are bucketed in some local zone,
//   not UTC, so they are never used.
// - User ids may start with U or W; the prefix means nothing.

const DAY_FILE = /^(?:(teams\/[^/]+)\/)?([^/]+)\/(\d{4}-\d{2}-\d{2})\.json$/i;
const META = ['channels', 'groups', 'dms', 'mpims'];
// Root files a real export carries that hold no messages or people
// (docs/formats/slack.md section 2). They are claimed, so they do not end up
// "unclaimed" next to the export, but never read.
const AUX_FILE = /^(?:teams\/[^/]+\/)?(integration_logs|canvases|file_conversations|huddle_transcripts|lists|content_flags)\.json$/i;
const VIS = { channels: 'public', groups: 'private', dms: 'direct', mpims: 'group' };
const KIND = { channels: 'channel', groups: 'channel', dms: 'dm', mpims: 'group_dm' };

// <@U123>, <@W123|name> (old pipe form). Ids are not fixed length.
const MENTION_RE = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
const BROADCAST_RE = /<!(here|channel|everyone)(?:\|[^>]*)?>/g;
const SUBTEAM_RE = /<!subteam\^([A-Z0-9]+)(?:\|[^>]*)?>/g;

const SKIP_SUBTYPES = new Set(['channel_topic', 'channel_purpose', 'channel_name', 'channel_archive', 'channel_unarchive',
  'group_topic', 'group_purpose', 'group_name', 'group_archive', 'group_unarchive', 'pinned_item', 'unpinned_item',
  'bot_add', 'bot_remove', 'tombstone', 'reminder_add', 'channel_posting_permissions', 'channel_convert_to_private',
  'channel_convert_to_public']);
const JOIN = new Set(['channel_join', 'group_join']);
const LEAVE = new Set(['channel_leave', 'group_leave']);

function aborted(signal) {
  if (signal?.aborted) { const e = new Error('Import cancelled'); e.name = 'AbortError'; throw e; }
}

// Map of workspace root ('' or 'teams/<ws>/') -> { meta file name -> entry }.
function scanRoots(fs) {
  const roots = new Map();
  for (const e of fs.entries) {
    const m = /^((?:teams\/[^/]+\/)?)(users|org_users|channels|groups|dms|mpims)\.json$/i.exec(e.rel);
    if (!m) continue;
    if (!roots.has(m[1])) roots.set(m[1], {});
    roots.get(m[1])[m[2].toLowerCase()] = e;
  }
  return roots;
}

async function detect(fs) {
  const roots = scanRoots(fs);
  const top = roots.get('');
  const hasUsers = top && (top.users || top.org_users);
  const hasConv = top && META.some(k => top[k]);
  const dayFiles = fs.entries.filter(e => DAY_FILE.test(e.rel) && !/^FC:/i.test(DAY_FILE.exec(e.rel)[2]));
  if (!hasUsers || !hasConv || !dayFiles.length) {
    // Partial matches still deserve a hint for the user.
    if (dayFiles.length && (hasUsers || hasConv)) return { score: 0.3, reason: 'Looks like part of a Slack export (metadata files missing)', files: [] };
    return { score: 0, reason: '' };
  }
  const files = [...dayFiles.map(e => e.rel)];
  for (const r of roots.values()) for (const e of Object.values(r)) files.push(e.rel);
  for (const e of fs.entries) if (AUX_FILE.test(e.rel)) files.push(e.rel);
  const grid = !!top.org_users || [...roots.keys()].some(k => k && roots.get(k).users);
  return { score: 0.95, reason: grid ? 'Slack Enterprise Grid export' : 'Slack workspace export', files };
}

async function readJSON(entry, builder, what) {
  try { return JSON.parse(await entry.text()); }
  catch (e) { builder.warn('slack-bad-json', `A Slack file could not be read as JSON and was skipped (${what}).`); return null; }
}

// Slack mrkdwn -> readable text. Entities first, then HTML unescape (Slack
// escapes only & < > in text).
function decodeText(text, nameOf) {
  if (!text) return '';
  return String(text)
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]*))?>/g, (m, id, n) => '@' + (nameOf(id) || n || id))
    .replace(/<#([CGD][A-Z0-9]+)(?:\|([^>]*))?>/g, (m, id, n) => '#' + (n || id))
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (m, n) => n || '@group')
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, '@$1')
    .replace(/<(https?:[^>|]+|mailto:[^>|]+)\|([^>]*)>/g, '$2')
    .replace(/<(https?:[^>|]+|mailto:[^>|]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function blockUserIds(blocks, out) {
  if (!Array.isArray(blocks)) return;
  const walk = (x) => {
    if (!x || typeof x !== 'object') return;
    if (Array.isArray(x)) { for (const y of x) walk(y); return; }
    if (x.type === 'user' && typeof x.user_id === 'string') out.add(x.user_id);
    if (x.elements) walk(x.elements);
  };
  walk(blocks);
}

const tsMs = ts => { const f = parseFloat(ts); return Number.isFinite(f) ? Math.round(f * 1000) : NaN; };

async function importSlack(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const roots = scanRoots(fs);
  const top = roots.get('') || {};
  const grid = !!top.org_users || [...roots.keys()].some(k => k && roots.get(k).users);

  // ---- metadata -------------------------------------------------------------
  const meta = new Map(); // root -> { users[], conv: { kind -> [] } }
  for (const [root, files] of roots) {
    const m = { users: [], conv: {} };
    for (const k of ['org_users', 'users']) if (files[k]) {
      const arr = await readJSON(files[k], builder, `${root}${k}.json`);
      if (Array.isArray(arr)) m.users.push(...arr);
    }
    for (const k of META) if (files[k]) {
      const arr = await readJSON(files[k], builder, `${root}${k}.json`);
      m.conv[k] = Array.isArray(arr) ? arr : [];
    }
    meta.set(root, m);
  }
  const anyNonPublic = [...meta.values()].some(m => ['groups', 'dms', 'mpims'].some(k => m.conv[k]?.length));
  const variant = grid ? 'grid' : anyNonPublic ? 'full' : 'public-only';

  const fileNames = fs.entries.filter(e => DAY_FILE.test(e.rel) || /(users|org_users|channels|groups|dms|mpims)\.json$/i.test(e.rel)).map(e => e.rel);
  builder.beginSource({ format: 'slack', family: 'workplace', medium: 'slack', view: 'full', context: 'workplace', tz: 'UTC',
    fileNames, egoKey: null, variant, directed: true });
  if (variant === 'public-only') builder.warn('slack-public-only', 'This export holds public channels only. Private channels, DMs and group DMs are not in it, so ties formed there are invisible.');

  // ---- users -> nodes ----------------------------------------------------
  const users = new Map();
  for (const m of meta.values()) for (const u of m.users) {
    if (!u || typeof u.id !== 'string') continue;
    // Grid: the same user appears in several users.json files; merge, keeping the first non-empty values.
    users.set(u.id, { ...u, ...(users.get(u.id) || {}), profile: { ...(u.profile || {}), ...(users.get(u.id)?.profile || {}) } });
  }
  const labelOf = (u) => u.real_name || u.profile?.real_name || u.profile?.display_name || u.name || u.id;
  const nameOf = (id) => { const u = users.get(id); return u ? (u.profile?.display_name || u.name || labelOf(u)) : null; };
  const userIdx = new Map();
  function userNode(id, snapshot) {
    let i = userIdx.get(id);
    if (i !== undefined) return i;
    const u = users.get(id);
    if (u) {
      const p = u.profile || {};
      const attrs = {
        name: labelOf(u), handle: u.name, title: p.title, tz: u.tz, tz_offset: u.tz_offset, team_id: u.team_id,
        email: p.email ? String(p.email).toLowerCase() : undefined,
        // users.json `deleted` = deactivated account (docs/formats/slack.md). Shared name
        // across importers: attrs.deactivated, which the report and views badge.
        deactivated: u.deleted ? true : undefined,
        guest: u.is_ultra_restricted ? 'single-channel' : u.is_restricted ? 'multi-channel' : undefined,
        admin: u.is_admin || u.is_owner ? true : undefined,
        workspaces: u.enterprise_user?.teams?.length ? u.enterprise_user.teams.join(';') : undefined,
      };
      i = builder.node('slack:' + id, { label: labelOf(u), attrs, isBot: !!(u.is_bot || u.is_app_user || id === 'USLACKBOT'), platformIds: { slack: id } });
    } else {
      // Slack Connect partners and some deleted users are missing from users.json
      // [UNVERIFIED]; the per-message user_profile snapshot is the fallback.
      const label = snapshot?.real_name || snapshot?.display_name || snapshot?.name || id;
      i = builder.node('slack:' + id, { label, attrs: { name: label, team_id: snapshot?.team, external: snapshot ? true : undefined }, isBot: id === 'USLACKBOT', platformIds: { slack: id } });
      builder.warn('slack-user-missing', 'Some message authors are not listed in users.json (often Slack Connect partners or removed users); their names come from the messages themselves.');
    }
    userIdx.set(id, i);
    return i;
  }
  for (const id of users.keys()) userNode(id);
  // Bot users list their bot id in profile.bot_id (spec section 3). A
  // bot_message carrying only bot_id belongs to that user, not to a second node.
  const botUser = new Map();
  for (const [id, u] of users) if (u.profile?.bot_id && !botUser.has(u.profile.bot_id)) botUser.set(u.profile.bot_id, id);

  // ---- conversations ------------------------------------------------------
  // folder key: root + folder name -> conversation descriptor
  const convByFolder = new Map();
  for (const [root, m] of meta) {
    for (const kind of META) for (const c of m.conv[kind] || []) {
      if (!c || !c.id) continue;
      const folder = kind === 'dms' ? c.id : (c.name || c.id);
      convByFolder.set(root + folder, { id: c.id, name: kind === 'dms' ? null : c.name, kind, members: Array.isArray(c.members) ? c.members : [] });
    }
  }
  // Grid: a conversation can sit at the root while being listed only inside a
  // workspace folder (and vice versa); fall back to a lookup across all roots.
  const convAnyRoot = new Map();
  for (const [k, v] of convByFolder) { const f = k.replace(/^teams\/[^/]+\//, ''); if (!convAnyRoot.has(f)) convAnyRoot.set(f, v); }

  const byFolder = new Map();
  for (const e of fs.entries) {
    const m = DAY_FILE.exec(e.rel);
    if (!m) continue;
    const root = m[1] ? m[1] + '/' : '';
    if (/^FC:/i.test(m[2])) { builder.stat('canvas-folders-skipped'); continue; } // canvas comment threads
    // A bare teams/<x>/ path with a date name is a nested workspace file only if x has metadata.
    const fk = root + m[2];
    if (!byFolder.has(fk)) byFolder.set(fk, { root, folder: m[2], files: [] });
    byFolder.get(fk).files.push(e);
  }

  const seen = new Set(); // conversationId + ts
  const ctxCache = new Map();
  function convContext(conv, folder) {
    if (ctxCache.has(conv.id)) return ctxCache.get(conv.id);
    const members = conv.members.map(id => userNode(id));
    const name = conv.kind === 'dms'
      ? 'DM: ' + conv.members.map(id => builder.nodes.labels[userNode(id)]).join(' & ')
      : conv.kind === 'mpims' ? 'Group DM: ' + conv.members.map(id => builder.nodes.labels[userNode(id)]).join(', ')
      : conv.kind ? '#' + (conv.name || folder) : folder;
    const ci = builder.context('slack:' + conv.id, {
      name, kind: conv.kind ? KIND[conv.kind] : 'channel', visibility: conv.kind ? VIS[conv.kind] : 'unknown', medium: 'slack',
      members: members.length ? members : undefined,
    });
    ctxCache.set(conv.id, ci);
    return ci;
  }

  const totalFiles = [...byFolder.values()].reduce((s, f) => s + f.files.length, 0) || 1;
  let done = 0;
  let unknownFolders = 0;

  for (const { root, folder, files } of byFolder.values()) {
    aborted(signal);
    let conv = convByFolder.get(root + folder) || convAnyRoot.get(folder);
    if (!conv) {
      // Not listed in any metadata file: we cannot know its type, so say so
      // instead of guessing from the name or id prefix.
      unknownFolders++;
      conv = { id: (root ? root.slice(6, -1) + '/' : '') + folder, name: folder, kind: null, members: [] };
    }
    const ci = convContext(conv, folder);

    // Read every day file of the conversation, then sort by ts: replies sit in
    // the file of the day they were posted, not with their parent.
    const msgs = [];
    for (const e of files) {
      const arr = await readJSON(e, builder, e.rel);
      done++;
      if (done % 50 === 0) progress(done / totalFiles, `Slack: ${done} of ${totalFiles} day files`);
      if (!Array.isArray(arr)) continue;
      for (const m of arr) if (m && typeof m === 'object') msgs.push(m);
    }
    msgs.sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    // Thread roots in this conversation (ts -> author), for exports without parent_user_id.
    const rootAuthor = new Map();
    for (const m of msgs) {
      if (m.user && m.ts) rootAuthor.set(m.ts, m.user);
      // Legacy `replies[]` on parents also tells us who authored the replies; not needed for targets.
    }

    const dmPartners = (conv.kind === 'dms' || conv.kind === 'mpims') ? conv.members : null;

    for (const m of msgs) {
      if (m.type && m.type !== 'message') { builder.stat('non-message-records'); continue; }
      const sub = m.subtype || null;
      if (sub === 'message_changed' || sub === 'message_deleted') {
        // Edit/delete notices duplicate the original message; never count them as new messages.
        builder.stat('edit-delete-records-skipped');
        continue;
      }
      const dedupeKey = conv.id + '|' + m.ts;
      if (!m.ts) { builder.warn('slack-missing-ts', 'Messages without a timestamp were skipped.'); continue; }
      if (seen.has(dedupeKey)) { builder.stat('duplicates-skipped'); continue; }
      seen.add(dedupeKey);
      const t = tsMs(m.ts);
      const key = `slack:${conv.id}:${m.ts}`;

      if (SKIP_SUBTYPES.has(sub)) { builder.stat('metadata-events-skipped'); continue; }

      if (JOIN.has(sub) || LEAVE.has(sub)) {
        if (!m.user) continue;
        builder.event({ type: JOIN.has(sub) ? 'join' : 'leave', t, actor: userNode(m.user, m.user_profile), context: ci, key });
        builder.stat(JOIN.has(sub) ? 'joins' : 'leaves');
        continue;
      }

      if (sub === 'huddle_thread' && m.room) {
        const ppl = [...new Set(m.room.participants?.length ? m.room.participants : (m.room.participant_history || []))];
        const starter = m.room.created_by || ppl[0] || m.user;
        if (starter && ppl.length) {
          const a = userNode(starter);
          const start = Number(m.room.date_start);
          builder.event({ type: 'copresence', t: start > 0 ? start * 1000 : t, actor: a, context: ci, key,
            targets: ppl.filter(p => p !== starter).map(p => [userNode(p), 'attendee']) });
          builder.stat('huddles');
        }
        continue;
      }

      // Sender. bot_message often has no `user`; it is attributed to a bot node.
      let actorId = m.user || (m.bot_id ? botUser.get(m.bot_id) : undefined);
      if (sub === 'file_comment' && m.comment?.user) actorId = m.comment.user; // legacy: author is in comment.user
      let actor;
      const isBotMsg = sub === 'bot_message' || !!m.bot_id;
      if (actorId) {
        actor = userNode(actorId, m.user_profile);
        if (sub === 'bot_message') builder.node('slack:' + actorId, { isBot: true });
      } else if (m.bot_id) {
        actor = builder.node('slack:bot:' + m.bot_id, { label: m.username || m.bot_profile?.name || m.bot_id, isBot: true, platformIds: { slack: m.bot_id } });
      } else {
        builder.warn('slack-no-sender', 'Messages with no user or bot id were skipped.');
        continue;
      }
      // A human's message posted through an app also carries bot_id; only count it as a bot post when the sender is a bot.
      if (isBotMsg && builder.nodes.isBot[actor]) builder.stat('bot-messages');

      const targets = [];
      const used = new Set();
      // One target per person, except that in a group DM a mention or reply is
      // kept beside the 'dm' role: it singles someone out of the roster. In a
      // 1:1 DM it would only repeat the dm tie (spec: "mentions inside DMs are redundant").
      const add = (id, role) => {
        if (!id || id === actorId || used.has(id + ' ' + role)) return;
        if (used.has(id) && conv.kind !== 'mpims') return;
        used.add(id); used.add(id + ' ' + role); targets.push([userNode(id), role]);
      };

      // DMs and group DMs: everyone else in the fixed roster is the addressee.
      if (dmPartners) for (const id of dmPartners) add(id, 'dm');

      // Reply target: the thread root's author, even when the root is not in the data.
      let parentKey = null;
      if (m.thread_ts && m.thread_ts !== m.ts) {
        parentKey = `slack:${conv.id}:${m.thread_ts}`;
        const pa = m.parent_user_id || rootAuthor.get(m.thread_ts);
        if (pa) add(pa, 'reply');
        else builder.warn('slack-reply-author-unknown', 'Some thread replies name neither their parent author nor a parent present in the export; no reply tie was drawn for them.');
        builder.stat('thread-replies');
      }

      // Mentions from text, attachments and Block Kit user elements.
      const ids = new Set();
      const scan = (s) => { if (typeof s !== 'string') return; for (const x of s.matchAll(MENTION_RE)) ids.add(x[1]); };
      scan(m.text);
      if (Array.isArray(m.attachments)) for (const a of m.attachments) { scan(a?.text); scan(a?.pretext); }
      blockUserIds(m.blocks, ids);
      for (const id of ids) add(id, 'mention');
      if (typeof m.text === 'string') {
        const b = m.text.match(BROADCAST_RE); if (b) builder.stat('broadcast-mentions', b.length);
        const g = m.text.match(SUBTEAM_RE);
        if (g) { builder.stat('usergroup-mentions', g.length); builder.warn('slack-usergroup-mentions', 'User-group mentions (@team handles) cannot be expanded to people: group membership is not in the export.', g.length); }
      }

      let text = m.text;
      if (sub === 'file_comment' && m.comment?.comment) text = m.comment.comment;
      builder.event({ type: 'message', t, actor, targets, context: ci, key, parentKey, text: decodeText(text, nameOf) || null });
      builder.stat('messages');
      if (sub === 'thread_broadcast' || m.reply_broadcast) builder.stat('thread-broadcasts');

      // Reactions: no timestamp of their own in exports, so they take the message's time.
      if (Array.isArray(m.reactions)) for (const r of m.reactions) {
        const rs = Array.isArray(r?.users) ? r.users : [];
        for (const uid of rs) {
          builder.event({ type: 'reaction', t, actor: userNode(uid), targets: [[actor, 'subject']], context: ci, parentKey: key, weight: 1, text: r.name ? ':' + r.name + ':' : null });
          builder.stat('reactions');
        }
        if (Number(r?.count) > rs.length) builder.warn('slack-reactions-truncated', 'Some reaction counts are larger than the list of reacting users Slack exported; only the listed reactors are included.', Number(r.count) - rs.length);
      }
    }
  }
  if (unknownFolders) builder.warn('slack-unknown-conversation', 'Some conversation folders are not listed in channels/groups/dms/mpims.json, so whether they are public or private is unknown.', unknownFolders);
  progress(1, 'Slack: done');
}

export default {
  id: 'slack',
  label: 'Slack export',
  family: 'workplace',
  detect,
  options: [],
  import: importSlack,
};
