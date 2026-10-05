// X / Twitter personal data archive (docs/formats/x-archive.md).
//
// One person's view: their tweets (replies, mentions, retweets, quotes), likes,
// following/follower id lists and DMs. Every data/*.js file is a JS assignment
// of a JSON array; manifest.js (window.__THAR_CONFIG) lists every part file and
// is the primary index. Ids are strings throughout (snowflakes exceed 2^53).

import { peek } from '../core/fileset.js';
import { VIEWS } from '../core/model.js';
import { parseYTD, streamJSON } from './lib/json.js';
import { decodeEntities } from './lib/text.js';
import { twitterDateMs, isoMs } from './lib/time.js';
import { RT_RE, statusUrl, idStr, handleKey } from './lib/x-common.js';

const YTD_RE = /^\s*window\.YTD\.([A-Za-z0-9_]+)\.part(\d+)\s*=/;
const THAR_RE = /^\s*window\.__THAR_CONFIG\s*=/;

// manifest dataTypes keys are camelCase (directMessagesGroup); YTD globals are
// snake_case (direct_messages_group). Compare in one normal form.
const norm = s => String(s).replace(/[_-]/g, '').toLowerCase();

function manifestEntry(fs) {
  return fs.first(/(^|\/)data\/manifest\.js$/i) || fs.first(/(^|\/)manifest\.js$/i);
}

async function detect(fs) {
  const m = manifestEntry(fs);
  if (m && THAR_RE.test(await peek(m, 256))) return { score: 0.98, reason: 'X archive manifest.js (window.__THAR_CONFIG)' };
  for (const e of fs.find(/\.js$/i).slice(0, 200)) {
    if (/(^|\/)assets\//i.test(e.rel)) continue;
    const head = await peek(e, 256);
    const r = YTD_RE.exec(head);
    if (r) return { score: 0.9, reason: `X archive data file (window.YTD.${r[1]})` };
  }
  return { score: 0 };
}

// Strip the `window.YTD.x.partN =` prefix from a text stream so the rest can be
// walked as JSON without holding the whole file in one string.
function dropAssignment() {
  let found = false;
  return new TransformStream({
    transform(chunk, c) {
      if (found) { c.enqueue(chunk); return; }
      const i = chunk.indexOf('=');
      if (i >= 0) { found = true; c.enqueue(chunk.slice(i + 1)); }
    },
  });
}

async function* ytdItems(entry) {
  const s = entry.stream().pipeThrough(new TextDecoderStream()).pipeThrough(dropAssignment());
  for await (const { value } of streamJSON(s, ['*'])) yield value;
}

// Build the type -> [entries] index: from manifest.js when present (the spec's
// rule: read dataTypes.<type>.files[], don't glob), else by sniffing each .js.
async function buildIndex(fs, builder) {
  const index = new Map();
  const add = (type, part, entry) => {
    const k = norm(type);
    if (!index.has(k)) index.set(k, []);
    index.get(k).push({ part, entry });
  };
  const m = manifestEntry(fs);
  let manifest = null;
  if (m) {
    try { manifest = parseYTD(await m.text()); } catch { builder.warn('bad-manifest', 'manifest.js could not be parsed; data files were found by scanning instead.'); }
  }
  if (manifest?.dataTypes) {
    // fileName is relative to the archive root, which is the folder above data/.
    const root = m.rel.replace(/data\/manifest\.js$/i, '').replace(/manifest\.js$/i, '');
    for (const [type, info] of Object.entries(manifest.dataTypes)) {
      for (const [i, f] of (info?.files || []).entries()) {
        const fileName = String(f.fileName || '');
        const part = Number(/\.part(\d+)$/.exec(f.globalName || '')?.[1] ?? i);
        const entry = fs.get(root + fileName) || fs.get(fileName) || fs.first(new RegExp('(^|/)' + fileName.split('/').pop().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
        if (entry) add(type, part, entry);
        else if (Number(f.count ?? 1) > 0) builder.warn('missing-part', `A data file listed in manifest.js is not in the upload (e.g. ${fileName}). Upload the whole archive zip.`);
      }
    }
  } else {
    for (const e of fs.find(/\.js$/i)) {
      if (/(^|\/)assets\//i.test(e.rel) || /_media\//i.test(e.rel)) continue;
      const r = YTD_RE.exec(await peek(e, 256));
      if (r) add(r[1], Number(r[2]), e);
    }
  }
  for (const list of index.values()) list.sort((a, b) => a.part - b.part);
  return { index, manifest };
}

const unwrap = (obj, key) => (obj && typeof obj === 'object' && key in obj ? obj[key] : obj);

async function importArchive(fs, { builder, progress, signal }) {
  const fileNames = [];
  // Begin first so index-building warnings land on this source; egoKey is
  // filled in once account.js has been read.
  builder.beginSource({ format: 'x-archive', family: 'online', medium: 'x', view: VIEWS.EGO, context: 'online', tz: 'UTC', fileNames, egoKey: null });
  const { index, manifest } = await buildIndex(fs, builder);
  const filesOf = (...types) => types.flatMap(t => index.get(norm(t)) || []).map(x => { fileNames.push(x.entry.rel); return x.entry; });

  // ---- ego -----------------------------------------------------------------
  let account = null;
  for (const e of filesOf('account')) for await (const it of ytdItems(e)) account = account || unwrap(it, 'account');
  let profile = null;
  for (const e of filesOf('profile')) for await (const it of ytdItems(e)) profile = profile || unwrap(it, 'profile');
  const egoId = idStr(account?.accountId) ?? idStr(manifest?.userInfo?.accountId);
  const egoHandle = account?.username ?? manifest?.userInfo?.userName;
  const egoName = account?.accountDisplayName ?? manifest?.userInfo?.displayName;
  const egoKey = egoId ? 'x:' + egoId : 'x:ego';

  builder.source.egoKey = egoKey;
  if (!egoId) builder.warn('ego-unknown', 'Neither account.js nor manifest.js gave the account id; the archive owner is shown as "Archive owner".');
  // account.email is PII and deliberately not read (spec: drop on import).
  const ego = builder.node(egoKey, {
    label: egoName || (egoHandle ? '@' + egoHandle : 'Archive owner'),
    attrs: { location: profile?.description?.location, accountCreated: account?.createdAt },
    platformIds: egoId ? { x: egoId, ...(egoHandle ? { handle: egoHandle } : {}) } : undefined,
  });

  // Display names seen anywhere in tweets (pass 1), so the first node creation
  // already gets the best label (the builder only replaces default labels).
  const nameOf = new Map();
  const person = (id, { handle, name } = {}) => builder.node('x:' + id, {
    label: name || nameOf.get(id) || (handle ? '@' + handle : undefined),
    platformIds: { x: id, ...(handle ? { handle } : {}) },
  });
  const handleToId = new Map(); // lowercased handle -> id
  if (egoId && egoHandle) handleToId.set(egoHandle.toLowerCase(), egoId);
  const byHandle = handle => {
    const id = handleToId.get(handle.toLowerCase());
    if (id) return person(id); // keep the handle spelling from the tweet entities, not from a URL
    builder.warn('handle-only-node', 'Some accounts are known only by @handle (no id in the archive); they may duplicate an id-keyed node of the same person.');
    return builder.node(handleKey(handle), { label: '@' + handle, platformIds: { handle } });
  };

  // ---- tweets: pass 1 (handle map, reply chains, own ids) -----------------
  const tweetFiles = filesOf('tweets', 'tweet');
  const parentOf = new Map();
  const own = new Set();
  let total = 0;
  for (const e of tweetFiles) {
    for await (const it of ytdItems(e)) {
      signal?.throwIfAborted();
      const tw = unwrap(it, 'tweet'); // some 2019-2022 archives lack the wrapper
      const id = idStr(tw.id_str ?? tw.id);
      if (!id) continue;
      own.add(id); total++;
      const p = idStr(tw.in_reply_to_status_id_str ?? tw.in_reply_to_status_id);
      if (p) parentOf.set(id, p);
      for (const m of tw.entities?.user_mentions || []) {
        const mid = idStr(m.id_str ?? m.id);
        if (mid && m.screen_name) handleToId.set(m.screen_name.toLowerCase(), mid);
        if (mid && m.name && !nameOf.has(mid)) nameOf.set(mid, m.name);
      }
      const ru = idStr(tw.in_reply_to_user_id_str ?? tw.in_reply_to_user_id);
      if (ru && tw.in_reply_to_screen_name) handleToId.set(tw.in_reply_to_screen_name.toLowerCase(), ru);
    }
  }
  progress?.(0.2, 'Indexed tweets');

  // note-tweet.js: long-form bodies. The real sample has no tweetId (spec:
  // linking is UNVERIFIED), so match on created time (to the second) plus the
  // truncated full_text being a prefix of the note text.
  const notesBySec = new Map();
  for (const e of filesOf('noteTweet')) {
    for await (const it of ytdItems(e)) {
      const n = unwrap(it, 'noteTweet');
      const t = isoMs(n?.createdAt);
      const text = n?.core?.text;
      if (!Number.isFinite(t) || !text) continue;
      const sec = Math.floor(t / 1000);
      if (!notesBySec.has(sec)) notesBySec.set(sec, []);
      notesBySec.get(sec).push(text);
    }
  }

  const rootCache = new Map();
  const rootOf = id => {
    if (rootCache.has(id)) return rootCache.get(id);
    let cur = id;
    const seen = new Set([id]);
    while (parentOf.has(cur)) {
      const p = parentOf.get(cur);
      if (seen.has(p)) break;
      seen.add(p);
      cur = p;
      if (!own.has(p)) break; // parent is someone else's tweet: it is the root we can know
    }
    rootCache.set(id, cur);
    return cur;
  };

  // ---- tweets: pass 2 (events) ----------------------------------------------
  let done = 0;
  for (const e of tweetFiles) {
    for await (const it of ytdItems(e)) {
      signal?.throwIfAborted();
      const tw = unwrap(it, 'tweet');
      const id = idStr(tw.id_str ?? tw.id);
      if (!id) { builder.warn('tweet-without-id', 'Tweets without an id were skipped.'); continue; }
      const t = twitterDateMs(tw.created_at);
      if (!Number.isFinite(t)) builder.warn('bad-time', 'Some tweets had an unreadable created_at; their time is unknown.');
      let text = decodeEntities(tw.full_text ?? tw.text ?? '');
      builder.stat('tweets');
      if (++done % 2000 === 0) progress?.(0.2 + 0.5 * done / Math.max(total, 1), `Tweets ${done}/${total}`);

      const rt = RT_RE.exec(text);
      if (rt) {
        // Retweet: no retweeted_status in the archive. The original author's id
        // is user_mentions[0] when it matches the RT handle.
        const m0 = (tw.entities?.user_mentions || [])[0];
        const m0id = idStr(m0?.id_str ?? m0?.id);
        const subj = m0id && m0?.screen_name?.toLowerCase() === rt[1].toLowerCase()
          ? person(m0id, { handle: m0.screen_name, name: m0.name }) : byHandle(rt[1]);
        builder.event({ type: 'repost', t, actor: ego, targets: [[subj, 'subject']], key: 'x:tweet:' + id, text });
        builder.stat('retweets');
        continue;
      }

      if (tw.truncated || /…\s*(https:\/\/t\.co\/\w+)?\s*$/.test(text)) {
        const cands = notesBySec.get(Math.floor(t / 1000));
        if (cands) {
          const head = text.replace(/\s*https:\/\/t\.co\/\w+\s*$/, '').replace(/…$/, '').slice(0, 40);
          const hit = cands.find(n => n.startsWith(head));
          if (hit) { text = hit; builder.stat('note-tweets-linked'); }
        }
      }

      const targets = [];
      const replyUser = idStr(tw.in_reply_to_user_id_str ?? tw.in_reply_to_user_id);
      const replyStatus = idStr(tw.in_reply_to_status_id_str ?? tw.in_reply_to_status_id);
      let replyNode = -1;
      if (replyUser) {
        replyNode = person(replyUser, { handle: tw.in_reply_to_screen_name });
        targets.push([replyNode, 'reply']);
        builder.stat('replies');
      }
      // Mentions. Skip the reply prefix X prepends automatically: mentions that
      // start before display_text_range[0], and a mention of the reply target
      // itself (spec section 4: avoid double counting the reply target).
      const visibleFrom = Number(tw.display_text_range?.[0] ?? 0);
      for (const m of tw.entities?.user_mentions || []) {
        const mid = idStr(m.id_str ?? m.id);
        if (!mid) { builder.warn('unresolved-mention', 'Mentions with id "-1" (account unresolvable) were skipped.'); continue; }
        if (Number(m.indices?.[0] ?? 0) < visibleFrom) continue;
        const n = person(mid, { handle: m.screen_name, name: m.name });
        if (n === replyNode) continue;
        targets.push([n, 'mention']);
        builder.stat('mentions');
      }
      const ctxKey = 'x:thread:' + rootOf(id);
      const ctx = builder.context(ctxKey, { name: 'X thread ' + rootOf(id), kind: 'thread', visibility: 'public', medium: 'x' });
      builder.event({ type: 'message', t, actor: ego, targets, context: ctx, key: 'x:tweet:' + id, parentKey: replyStatus ? 'x:tweet:' + replyStatus : null, text });

      // Quote: a status URL in urls[]. Recorded as a repost-type event on the
      // quoted author (the model has no separate quote type).
      for (const u of tw.entities?.urls || []) {
        const q = statusUrl(u.expanded_url);
        if (!q || q.id === id) continue;
        const subj = byHandle(q.handle);
        builder.event({ type: 'repost', t, actor: ego, targets: [[subj, 'subject']], key: 'x:quote:' + id, text: null });
        builder.stat('quotes');
        break;
      }
    }
  }
  progress?.(0.7, 'Tweets done');

  for (const e of filesOf('twitterCircleTweet')) {
    let n = 0;
    for await (const _ of ytdItems(e)) n++; // eslint-disable-line no-unused-vars
    if (n) builder.warn('circle-tweets-skipped', 'Twitter Circle tweets (restricted audience) were not imported.', n);
  }
  if ((index.get(norm('protectedHistory')) || []).length) {
    let n = 0;
    for (const e of filesOf('protectedHistory')) for await (const _ of ytdItems(e)) n++; // eslint-disable-line no-unused-vars
    if (n) builder.warn('protected-account', 'The account was protected at some point (protected-history.js); some tweets reached followers only although they are marked public here.');
  }

  // ---- likes (undated, author unknown) ---------------------------------------
  let likes = 0;
  for (const e of filesOf('like')) {
    for await (const it of ytdItems(e)) {
      signal?.throwIfAborted();
      const l = unwrap(it, 'like');
      const tid = idStr(l?.tweetId);
      if (!tid) continue;
      // Author is not in like.js; resolvable only if expandedUrl carries a handle.
      const q = statusUrl(l.expandedUrl);
      const targets = q ? [[byHandle(q.handle), 'subject']] : [];
      if (!q) builder.warn('like-author-unknown', 'like.js does not say who wrote a liked tweet; these likes have no target account and form no ties.');
      builder.event({ type: 'like', t: NaN, actor: ego, targets, key: 'x:like:' + tid, text: l.fullText ? decodeEntities(l.fullText) : null });
      likes++;
    }
  }
  if (likes) { builder.stat('likes', likes); builder.warn('undated-likes', 'X does not record when a like happened; likes have unknown time and are left out of time windows.', likes); }

  // ---- follows (ids only, undated) -------------------------------------------
  let follows = 0;
  for (const e of filesOf('following')) for await (const it of ytdItems(e)) {
    const id = idStr(unwrap(it, 'following')?.accountId);
    if (!id) continue;
    builder.event({ type: 'follow', t: NaN, actor: ego, targets: [[person(id), 'subject']] });
    builder.stat('following'); follows++;
  }
  for (const e of filesOf('follower')) for await (const it of ytdItems(e)) {
    const id = idStr(unwrap(it, 'follower')?.accountId);
    if (!id) continue;
    builder.event({ type: 'follow', t: NaN, actor: person(id), targets: [[ego, 'subject']] });
    builder.stat('followers'); follows++;
  }
  if (follows) builder.warn('undated-follows', 'Follow lists are a snapshot with no dates; follow ties have unknown time.', follows);
  progress?.(0.8, 'Likes and follows done');

  // ---- DMs ------------------------------------------------------------------
  for (const [types, group] of [[['directMessages'], false], [['directMessagesGroup'], true]]) {
    for (const e of filesOf(...types)) for await (const it of ytdItems(e)) {
      signal?.throwIfAborted();
      importConversation(builder, unwrap(it, 'dmConversation'), group, { ego, egoId, person });
    }
  }
  progress?.(1, 'Done');
}

function importConversation(builder, conv, group, { ego, egoId, person }) {
  const cid = idStr(conv?.conversationId);
  if (!cid) return;
  const items = [...(conv.messages || [])].reverse(); // README: reverse chronological
  const tOf = m => isoMs(Object.values(m)[0]?.createdAt);
  if (items.every(m => Number.isFinite(tOf(m)))) items.sort((a, b) => tOf(a) - tOf(b));

  const memberIds = new Set();
  if (!group) for (const p of cid.split('-')) if (p) memberIds.add(p);
  if (egoId) memberIds.add(egoId);
  let name = null;
  for (const m of items) {
    const [kind, v] = Object.entries(m)[0] || [];
    if (!v) continue;
    if (v.senderId) memberIds.add(idStr(v.senderId));
    if (v.recipientId) memberIds.add(idStr(v.recipientId));
    if (v.initiatingUserId) memberIds.add(idStr(v.initiatingUserId));
    for (const u of v.participantsSnapshot || []) memberIds.add(idStr(u));
    if (kind === 'participantsJoin') for (const u of v.userIds || []) memberIds.add(idStr(u));
    if (kind === 'conversationNameUpdate' && v.name) name = v.name;
  }
  const nodeOf = id => (id === egoId ? ego : person(id));
  const members = [...memberIds].filter(Boolean).map(nodeOf);
  const ctx = builder.context((group ? 'x:group_dm:' : 'x:dm:') + cid, {
    name: name || (group ? 'X group DM ' + cid : 'X DM ' + cid),
    kind: group ? 'group_dm' : 'dm', visibility: group ? 'group' : 'direct', medium: 'x', members,
  });
  builder.stat(group ? 'group-conversations' : 'conversations');

  for (const m of items) {
    const [kind, v] = Object.entries(m)[0] || [];
    if (!v) continue;
    const t = isoMs(v.createdAt);
    if (kind === 'messageCreate') {
      const sender = idStr(v.senderId);
      if (!sender) { builder.warn('dm-without-sender', 'DM items without senderId were skipped.'); continue; }
      const actor = nodeOf(sender);
      const targets = [];
      if (!group && v.recipientId) targets.push([nodeOf(idStr(v.recipientId)), 'dm']);
      const key = v.id ? 'x:dm:' + idStr(v.id) : null;
      builder.event({ type: 'message', t, actor, targets, context: ctx, key, text: v.text ?? null });
      builder.stat('dms');
      // Reaction keys inside reactions[] are UNVERIFIED (README names
      // reactionSenderID / reactionKey / reactionCreatedAt); read defensively.
      for (const r of v.reactions || []) {
        const rs = idStr(r.senderId ?? r.reactionSenderId ?? r.reactionSenderID);
        if (!rs) continue;
        builder.event({ type: 'reaction', t: isoMs(r.createdAt ?? r.reactionCreatedAt), actor: nodeOf(rs), targets: [[actor, 'subject']], context: ctx, parentKey: key, text: r.reactionKey ?? null });
        builder.stat('dm-reactions');
      }
    } else if (kind === 'joinConversation') {
      // The archive owner was added to the group by initiatingUserId.
      const by = idStr(v.initiatingUserId);
      builder.event({ type: 'join', t, actor: ego, targets: by ? [[nodeOf(by), 'subject']] : [], context: ctx });
      builder.stat('joins');
    } else if (kind === 'participantsJoin') {
      const by = idStr(v.initiatingUserId);
      for (const u of v.userIds || []) {
        builder.event({ type: 'join', t, actor: nodeOf(idStr(u)), targets: by ? [[nodeOf(by), 'subject']] : [], context: ctx });
        builder.stat('joins');
      }
    } else if (kind === 'participantsLeave') {
      for (const u of v.userIds || []) {
        builder.event({ type: 'leave', t, actor: nodeOf(idStr(u)), context: ctx });
        builder.stat('leaves');
      }
    } else if (kind !== 'conversationNameUpdate') {
      builder.warn('dm-unknown-item', `Unrecognised DM item types were skipped (e.g. ${kind}).`);
    }
  }
}

export default {
  id: 'x-archive',
  label: 'X / Twitter archive',
  family: 'online',
  detect,
  options: [],
  import: importArchive,
};
