// Threads (Meta) data download importer.
//
// Spec: docs/formats/threads.md (medium confidence: no official schema; keys
// from a real export and three agreeing parsers). Files are identified by their
// single top-level key, which always starts `text_post_app_` (unique to Threads
// among Meta exports), not by file name, so numbered splits (followers_1.json)
// and renamed files work. Every string is passed through the Meta mojibake fix,
// keys included (localized label keys are mangled too).
//
// Ego view with both follow directions (timestamped), likes (with author) and
// posts. Replies carry only an is_reply flag: the parent post and its author
// are NOT in the export, so no reply ties are created.

import { parseJSON } from './lib/json.js';
import { fixMojibakeDeep } from './lib/text.js';
import { unixSecMs } from './lib/time.js';
import { peek } from '../core/fileset.js';

const NS = 'threads';
const KEY = {
  posts: 'text_post_app_text_posts',
  likes: 'text_post_app_media_likes',
  saved: 'text_post_app_text_post_app_saved_posts',
  archived: 'text_post_app_text_app_archived_posts',
  viewed: 'text_post_app_text_post_app_posts_seen',
  followers: 'text_post_app_text_post_app_followers',
  following: 'text_post_app_text_post_app_following',
  requests: 'text_post_app_text_post_app_permanent_follow_requests',
  blocked: 'text_post_app_text_post_app_blocked_users',
  profile: 'text_post_app_text_post_app_profile',
};
const NAMES = /(^|\/)(threads_and_replies|liked_threads|saved_threads|archived_threads|threads_viewed|followers(_\d+)?|following(_\d+)?|recent_follow_requests|recently_unfollowed_profiles|blocked_profiles|personal_information)\.(json|html)$/i;

const arr = v => (Array.isArray(v) ? v : []);

// Usernames are case-insensitive; threads.net and threads.com are the same site.
const uname = s => String(s ?? '').trim().replace(/^@/, '').toLowerCase();
export function usernameFromHref(href) {
  const m = /^https?:\/\/(?:www\.)?threads\.(?:net|com)\/@?([A-Za-z0-9._]+)/i.exec(String(href ?? ''));
  return m ? m[1].toLowerCase() : null;
}

// Mentions can only be recovered from text (spec section 3). Threads/Instagram
// usernames are letters, digits, '.' and '_', and cannot end with '.', so a
// trailing period is sentence punctuation. Require a non-word char before '@'
// so e-mail addresses are not read as mentions.
export function textMentions(text) {
  const out = new Set();
  for (const m of String(text ?? '').matchAll(/(^|[^A-Za-z0-9._@])@([A-Za-z0-9._]+)/g)) {
    const u = m[2].replace(/\.+$/, '').toLowerCase();
    if (u) out.add(u);
  }
  return [...out];
}

// One follower/following entry: `username = value || title || lastPathSegment(href)`
// (spec); when `value` is present, `title` is the display name.
export function followEntry(item) {
  const sld = arr(item?.string_list_data)[0] ?? {};
  const username = uname(sld.value) || uname(item?.title) || usernameFromHref(sld.href) || uname(String(sld.href ?? '').split('/').filter(Boolean).pop());
  const display = sld.value && item?.title ? String(item.title) : null;
  return { username, display, t: unixSecMs(sld.timestamp) };
}

// Localized string_map_data (saved / viewed / archived): labels vary by account
// language, so classify by value shape: href -> URL, timestamp -> time, else author.
export function shapeEntry(smd) {
  const out = { url: null, t: NaN, author: null };
  for (const v of Object.values(smd ?? {})) {
    if (!v || typeof v !== 'object') continue;
    if (v.href) out.url = v.href;
    else if (v.timestamp) out.t = unixSecMs(v.timestamp);
    else if (typeof v.value === 'string' && !out.author) out.author = uname(v.value);
  }
  return out;
}

async function threadFiles(fs) {
  return fs.entries.filter(e => NAMES.test(e.rel) && (/(^|\/)threads\//i.test(e.rel) || !e.rel.includes('/')));
}

async function loadAll(fs) {
  const docs = [];
  for (const e of (await threadFiles(fs)).filter(e => /\.json$/i.test(e.rel))) {
    let v;
    try { v = fixMojibakeDeep(parseJSON(await e.text())); } catch { docs.push({ entry: e, bad: true }); continue; }
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    const k = Object.keys(v).find(x => x.startsWith('text_post_app_'));
    if (k) docs.push({ entry: e, key: k, data: v[k] });
  }
  return docs;
}

export default {
  id: 'threads',
  label: 'Threads data download (JSON)',
  family: 'online',
  options: [{ key: 'username', label: 'Your Threads username (if personal_information.json is missing)', type: 'text', default: '' }],

  async detect(fs) {
    const files = await threadFiles(fs);
    for (const e of files.filter(x => /\.json$/i.test(x.rel))) {
      if (/"text_post_app_/.test(await peek(e, 512))) return { score: 0.95, reason: `${e.rel} is a Threads export file` };
    }
    if (files.some(e => /\.html$/i.test(e.rel) && /(^|\/)threads\//i.test(e.rel))) return { score: 0.6, reason: 'Threads export in HTML format (needs JSON)' };
    return { score: 0 };
  },

  async import(fs, { builder, options = {}, progress, signal } = {}) {
    const docs = await loadAll(fs);
    if (!docs.some(d => d.key)) {
      const html = (await threadFiles(fs)).some(e => /\.html$/i.test(e.rel));
      throw new Error(html
        ? 'This Threads export is in HTML format. Request it again in Accounts Center -> Export your information and choose JSON as the format.'
        : 'No Threads export files (text_post_app_*) found.');
    }
    const of = k => docs.filter(d => d.key === k);

    // Ego: personal_information Username/Name. Labels are localized, so after
    // trying the English labels fall back to the entry whose href points at a
    // threads profile; then the option; then the Instagram zip name.
    let egoName = null, egoLabel = null, isPrivate = false;
    for (const d of of(KEY.profile)) {
      for (const item of arr(d.data)) {
        const smd = item?.string_map_data ?? {};
        egoName ||= uname(smd.Username?.value);
        egoLabel ||= smd.Name?.value || null;
        if (!egoName) for (const v of Object.values(smd)) { const u = usernameFromHref(v?.href); if (u) { egoName = u; break; } }
        const pa = smd['Private Account']?.value;
        if (typeof pa === 'string' && /^true$/i.test(pa)) isPrivate = true;
      }
    }
    egoName ||= uname(options.username) || null;
    if (!egoName) {
      const m = [...(fs.names ?? []), ...fs.entries.map(e => e.path)].map(p => /instagram-([A-Za-z0-9._]+)-\d{4}-\d{2}-\d{2}/i.exec(p)).find(Boolean);
      if (m) egoName = m[1].toLowerCase();
    }
    const egoKey = egoName ? `${NS}:${egoName}` : `${NS}:me`;
    builder.beginSource({ format: 'threads', family: 'online', medium: 'threads', view: 'ego', context: 'online', tz: 'UTC', fileNames: docs.map(d => d.entry.rel), egoKey });
    if (!egoName) builder.warn('ego-unknown', 'Your username was not found (personal_information.json missing); your account is a placeholder node. Set the username option.');
    for (const d of docs.filter(x => x.bad)) builder.warn('bad-json', `${d.entry.rel} could not be parsed and was skipped.`);
    const ego = builder.node(egoKey, { label: egoLabel || (egoName ? '@' + egoName : 'You'), platformIds: egoName ? { threads: egoName } : {} });
    const person = (u, display) => {
      if (u === egoName) return ego;
      // No label unless a display name is known: the model then shows the
      // username and still lets a later display name replace it.
      return builder.node(`${NS}:${u}`, { label: display || undefined, platformIds: { threads: u } });
    };

    // Posts. One context for the ego's profile feed: Threads posts carry no
    // thread or conversation id.
    const feed = builder.context(`${NS}:feed:${egoName ?? 'me'}`, { name: `${egoName ? '@' + egoName : 'Your'} posts`, kind: 'feed', visibility: isPrivate ? 'private' : 'public', medium: 'threads' });
    let replies = 0, textMentionCount = 0, n = 0;
    const addPosts = (items, statName) => {
      for (const item of arr(items)) {
        if (++n % 500 === 0) signal?.throwIfAborted();
        const media = arr(item?.media);
        const title = [item?.title, ...media.map(m => m?.title)].find(x => typeof x === 'string' && x !== '') ?? '';
        const ts = [item?.creation_timestamp, ...media.map(m => m?.creation_timestamp)].find(x => x != null);
        const isReply = [item?.text_app_post, ...media.map(m => m?.text_app_post)].some(x => x?.is_reply === true);
        builder.stat(statName);
        if (isReply) replies++;
        const ms = textMentions(title).filter(u => u !== egoName);
        textMentionCount += ms.length;
        builder.event({ type: 'message', t: unixSecMs(ts), actor: ego, targets: ms.map(u => [person(u), 'mention']), context: feed, text: title || null });
      }
    };
    for (const d of of(KEY.posts)) addPosts(d.data, 'posts');
    for (const d of of(KEY.archived)) {
      // Archived posts are own posts; shape varies (media list or localized map).
      const withMedia = arr(d.data).filter(x => Array.isArray(x?.media));
      addPosts(withMedia, 'archived-posts');
      const rest = arr(d.data).length - withMedia.length;
      if (rest) builder.warn('archived-unreadable', 'Some archived posts had no post body in the export and were skipped.', rest);
    }
    if (replies) builder.warn('reply-parent-missing', 'Threads marks replies (is_reply) but does not include the post or person replied to, so these replies add no reply ties.', replies);
    if (textMentionCount) builder.warn('mentions-from-text', 'Mentions were read from @username text in posts (the export has no mention list); renamed accounts may be missed.', textMentionCount);
    progress?.(0.4, 'posts');

    // Likes: title = author username, href = post URL (contains @author).
    for (const d of of(KEY.likes)) {
      for (const item of arr(d.data)) {
        const sld = arr(item?.string_list_data)[0] ?? {};
        const author = uname(item?.title) || usernameFromHref(sld.href);
        builder.stat('likes');
        if (!author) { builder.warn('like-author-missing', 'Likes without an author were skipped.'); continue; }
        builder.event({ type: 'like', t: unixSecMs(sld.timestamp), actor: ego, targets: [[person(author), 'subject']], text: typeof sld.value === 'string' ? sld.value : null });
      }
    }

    // Follows, both directions, with follow time (best effort per spec).
    for (const [k, dir] of [[KEY.following, 'out'], [KEY.followers, 'in']]) {
      for (const d of of(k)) {
        for (const item of arr(d.data)) {
          const f = followEntry(item);
          if (!f.username) { builder.warn('follow-without-username', 'Follow entries without a username were skipped.'); continue; }
          const other = person(f.username, f.display);
          builder.stat(dir === 'out' ? 'following' : 'followers');
          if (dir === 'out') builder.event({ type: 'follow', t: f.t, actor: ego, targets: [[other, 'subject']] });
          else builder.event({ type: 'follow', t: f.t, actor: other, targets: [[ego, 'subject']] });
        }
      }
    }

    // Saved / viewed: read by value shape (labels are localized) and counted;
    // the spec defines no tie for them, so they are not added as events.
    for (const [k, stat] of [[KEY.saved, 'saved'], [KEY.viewed, 'viewed']]) {
      for (const d of of(k)) for (const item of arr(d.data)) {
        builder.stat(stat);
        if (shapeEntry(item?.string_map_data).author) builder.stat(`${stat}-with-author`);
      }
    }
    for (const [k, stat] of [[KEY.blocked, 'blocked'], [KEY.requests, 'follow-requests']]) {
      for (const d of of(k)) builder.stat(stat, arr(d.data).length);
    }
    progress?.(1, 'done');
  },
};
