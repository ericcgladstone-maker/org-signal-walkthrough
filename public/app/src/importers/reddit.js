// Reddit: (a) the official data request zip of CSVs, and (b) Pushshift / Arctic
// Shift research dumps (NDJSON, one comment or submission per line).
// Spec: docs/formats/reddit.md.
//
// (a) is an ego view: only private messages and chats name a counterpart; public
//     comments carry the parent's fullname but not its author, so they give
//     ego -> subreddit activity and a reply structure without reply targets.
// (b) gives a real reply network, built in two passes over the files: first
//     index fullname (t1_/t3_ + id) -> author, then resolve each comment's
//     parent_id. Dumps are distributed zstd-compressed with a long window
//     (up to 2 GB, --long=31), which no browser decoder handles reliably, so
//     .zst input is detected and the user is told how to decompress it.

import { lines, peek } from '../core/fileset.js';
import { parseCSV, firstLine } from './lib/csv.js';
import { isoUtcMs } from './lib/time.js';
import { streamJSON } from './lib/json.js';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
export const ZSTD_HELP = 'Reddit dump files (.zst) use zstd with a long window that browsers cannot decompress. Decompress it first on your computer with:  zstd -d --long=31 FILE.zst  (install zstd from https://github.com/facebook/zstd or your package manager), then load the resulting NDJSON file.';

// ---- helpers ----------------------------------------------------------------

const userKey = u => 'reddit:' + String(u).trim().toLowerCase();
const subKey = s => 'reddit:subreddit:' + String(s).trim().toLowerCase().replace(/^\/?r\//, '');
const isDeleted = a => !a || a === '[deleted]' || a === '[removed]';
const stripPrefix = id => String(id ?? '').replace(/^t[1-6]_/, '');

// GDPR export dates: `YYYY-MM-DD HH:MM:SS UTC` (literal UTC suffix).
export function parseExportDate(s) {
  return isoUtcMs(String(s ?? '').trim().replace(/\s*UTC$/i, ''));
}

// created_utc: Unix seconds, a number or (older Pushshift) a string.
export function createdMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'number' ? v : Number(String(v).trim());
  return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
}

// Classify a GDPR CSV by its header names (file names may be split as name_1.csv).
export function classifyCsvHeader(line) {
  const f = new Set(line.split(',').map(s => s.trim().replace(/^"|"$/g, '').toLowerCase()));
  if (f.has('message_id') && f.has('username') && f.has('channel_url')) return 'chat';
  if (f.has('id') && f.has('from') && f.has('to') && f.has('thread_id')) return 'messages';
  if (f.has('id') && f.has('permalink') && f.has('subreddit') && f.has('link') && f.has('parent')) return 'comments';
  if (f.has('id') && f.has('permalink') && f.has('subreddit') && f.has('title')) return 'posts';
  if (f.size === 2 && f.has('username') && f.has('note')) return 'friends';
  if (f.size === 1 && f.has('subreddit')) return 'subscribed';
  return null;
}

// Classify a dump record from raw text (peeked first line).
function classifyDumpText(t) {
  const s = t.trimStart();
  if (s[0] !== '{' && s[0] !== '[') return null;
  if (!/"author"\s*:/.test(s) || !/"created_utc"\s*:/.test(s)) return null;
  if (/"parent_id"\s*:/.test(s) && /"link_id"\s*:/.test(s)) return 'comments';
  if (/"title"\s*:/.test(s) && (/"num_comments"\s*:/.test(s) || /"selftext"\s*:/.test(s))) return 'submissions';
  return null;
}

function isZstName(rel) { return /\.zst$/i.test(rel); }
async function hasZstMagic(e) {
  try { const b = new Uint8Array(await e.stream().getReader().read().then(r => r.value ?? new Uint8Array())); return ZSTD_MAGIC.every((x, i) => b[i] === x); } catch { return false; }
}

// Sort the FileSet into GDPR CSVs, dump files and zstd files.
// Peeks are bounded so detection stays cheap on exports with thousands of
// JSON files (a Slack export): files named like dumps are always checked,
// other CSV and JSON files only up to a sample. import() scans everything.
const SNIFF_CSV = 60, SNIFF_JSON = 20;

async function scan(fs, { bounded = false } = {}) {
  const out = { csv: [], dumps: [], zst: [] };
  let csvSeen = 0, jsonSeen = 0;
  for (const e of fs.entries) {
    const name = e.rel.split('/').pop();
    if (isZstName(name)) { out.zst.push(e); continue; }
    if (/\.csv$/i.test(name)) {
      if (bounded && ++csvSeen > SNIFF_CSV) continue;
      const kind = classifyCsvHeader(firstLine(await peek(e, 2048)));
      if (kind) out.csv.push({ e, kind });
      continue;
    }
    const dumpName = /^R[CS]_\d{4}-\d{2}$/.test(name) || /_(comments|submissions)$/i.test(name);
    if (bounded && !dumpName && /\.(ndjson|jsonl|json)$/i.test(name) && ++jsonSeen > SNIFF_JSON) continue;
    if (dumpName || /\.(ndjson|jsonl|json)$/i.test(name)) {
      // A dump renamed without its .zst extension is still compressed: check the magic bytes.
      if (dumpName && await hasZstMagic(e)) { out.zst.push(e); continue; }
      const kind = classifyDumpText(await peek(e, 65536));
      if (kind) out.dumps.push({ e, kind });
    }
  }
  return out;
}

async function detect(fs) {
  const s = await scan(fs, { bounded: true });
  const gdpr = s.csv.filter(c => ['comments', 'messages', 'chat', 'posts'].includes(c.kind));
  if (s.dumps.length) return { score: 0.9, reason: `Reddit dump (${s.dumps.map(d => d.kind).join(', ')})` };
  if (gdpr.length) return { score: 0.9, reason: `Reddit data request export (${[...new Set(gdpr.map(c => c.kind))].join(', ')})` };
  if (s.zst.length && s.zst.some(e => /^R[CS]_|_(comments|submissions)\.zst$/i.test(e.rel.split('/').pop()))) {
    return { score: 0.8, reason: 'zstd-compressed Reddit dump: must be decompressed first (zstd -d --long=31)' };
  }
  return { score: 0, reason: '' };
}

// Records of one dump file: NDJSON, or a JSON array (Arctic Shift web tool
// output format is UNVERIFIED, so accept both).
async function* dumpRecords(e, onBytes) {
  const head = (await peek(e, 64)).trimStart();
  if (head[0] === '[') {
    for await (const { value } of streamJSON(e.stream(), ['*'])) yield value;
    return;
  }
  for await (const line of lines(e.stream())) {
    onBytes?.(line.length + 1);
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { yield { __bad: true }; continue; }
    yield r;
  }
}

// ---- (b) research dumps ---------------------------------------------------------

async function importDumps(b, dumps, { progress, signal }) {
  const total = dumps.reduce((s, d) => s + (d.e.size || 0), 0) || 1;
  // Pass 1: fullname -> author (null for [deleted]); collect scope for the view.
  const author = new Map();
  const subs = new Set(), authors = new Set();
  let done = 0;
  for (const d of dumps) {
    for await (const r of dumpRecords(d.e, n => { done += n; })) {
      if (signal?.aborted) signal.throwIfAborted();
      if (r.__bad || !r.id) continue;
      const pre = d.kind === 'comments' ? 't1_' : 't3_';
      author.set(pre + stripPrefix(r.id), isDeleted(r.author) ? null : r.author);
      if (r.subreddit) subs.add(String(r.subreddit).toLowerCase());
      if (!isDeleted(r.author)) authors.add(String(r.author).toLowerCase());
      if (author.size % 20000 === 0) progress?.(0.45 * done / (2 * total), 'Indexing Reddit authors');
    }
  }
  // One author: a user's own history. One subreddit: that community's full public
  // record as captured. Otherwise: a time/topic window over a larger population.
  const view = authors.size === 1 ? 'authored' : subs.size === 1 ? 'full' : 'sample';
  b.beginSource({ format: 'reddit', family: 'community', medium: 'reddit', view, context: 'community', tz: 'UTC', fileNames: dumps.map(d => d.e.rel), egoKey: view === 'authored' ? userKey([...authors][0]) : null });
  b.warn('captured-record', 'Research dumps show content as captured by Pushshift / Arctic Shift (deleted later content may persist; private and quarantined subreddits are absent).');

  const nodeOf = (name, r) => b.node(userKey(name), {
    label: name,
    isBot: name === 'AutoModerator',
    platformIds: r?.author_fullname ? { reddit: r.author_fullname } : undefined,
  });
  let deleted = 0, outside = 0, deletedParent = 0, badTime = 0, bad = 0;
  done = 0;
  for (const d of dumps) {
    for await (const r of dumpRecords(d.e, n => { done += n; })) {
      if (signal?.aborted) signal.throwIfAborted();
      if (r.__bad || !r.id) { bad++; continue; }
      if (isDeleted(r.author)) { deleted++; continue; }
      const t = createdMs(r.created_utc);
      if (Number.isNaN(t)) badTime++;
      const actor = nodeOf(r.author, r);
      const ctx = r.subreddit ? b.context(subKey(r.subreddit), { name: 'r/' + r.subreddit, kind: 'subreddit', visibility: 'public', medium: 'reddit' }) : -1;
      if (d.kind === 'submissions') {
        const text = [r.title, isDeleted(r.selftext) ? '' : r.selftext].filter(Boolean).join('\n\n');
        b.event({ type: 'message', t, actor, context: ctx, key: 'reddit:t3_' + stripPrefix(r.id), text: text || null });
        b.stat('submissions');
      } else {
        const pid = String(r.parent_id ?? '');
        const targets = [];
        if (/^t[13]_/.test(pid)) {
          const pa = author.get(pid);
          if (pa === undefined) outside++;
          else if (pa === null) deletedParent++;
          else targets.push([nodeOf(pa), 'reply']);
        }
        b.event({ type: 'message', t, actor, targets, context: ctx, key: 'reddit:t1_' + stripPrefix(r.id), parentKey: pid ? 'reddit:' + pid : null, text: isDeleted(r.body) ? null : r.body ?? null });
        b.stat('comments');
      }
      if ((b.ev.type.length & 16383) === 0) progress?.(0.5 + 0.45 * done / total, 'Building Reddit reply network');
    }
  }
  if (deleted) b.warn('deleted-author', 'Records whose author is [deleted] were dropped (they would collapse into one fake person). Replies to them have no reply target.', deleted);
  if (deletedParent) b.warn('reply-to-deleted', 'Comments replying to a [deleted] author: kept, without a reply target.', deletedParent);
  if (outside) b.warn('parent-outside-data', 'Comments whose parent is not in the loaded files (outside the time or subreddit window): kept, without a reply target.', outside);
  if (badTime) b.warn('bad-time', 'Records with a missing or non-numeric created_utc; they have no time.', badTime);
  if (bad) b.warn('bad-line', 'Lines that were not valid JSON or had no id were skipped.', bad);
}

// ---- (a) official data request ------------------------------------------------

async function importGdpr(b, csvs, { options, progress, signal }) {
  const tables = { comments: [], posts: [], messages: [], chat: [], friends: [], subscribed: [] };
  for (const { e, kind } of csvs) {
    const { rows } = parseCSV(await e.text());
    for (const r of rows) {
      const o = {};
      for (const [k, v] of Object.entries(r)) if (k !== '__parsed_extra') o[k.toLowerCase()] = typeof v === 'string' ? v.trim() : v;
      tables[kind].push(o);
    }
  }
  progress?.(0.3, 'Read Reddit CSVs');

  // Ego: given, else the username present in most PM rows (sender or recipient;
  // both directions are in messages.csv), else the most frequent chat sender.
  let ego = (options?.username || '').trim().replace(/^\/?u\//, '') || null;
  let egoHow = ego ? 'option' : null;
  if (!ego) {
    const votes = new Map();
    const vote = u => { if (u && !/^\/?r\//.test(u) && !u.startsWith('#')) votes.set(u, (votes.get(u) || 0) + 1); };
    for (const r of tables.messages) { const seen = new Set([r.from, r.to]); for (const u of seen) vote(u); }
    if (!votes.size) for (const r of tables.chat) vote(r.username);
    if (votes.size) { ego = [...votes].sort((a, c) => c[1] - a[1])[0][0]; egoHow = 'inferred'; }
  }
  const egoKey = ego ? userKey(ego) : 'reddit:me';
  b.beginSource({ format: 'reddit', family: 'community', medium: 'reddit', view: 'ego', context: 'community', tz: 'UTC', fileNames: csvs.map(c => c.e.rel), egoKey });
  if (!ego) b.warn('ego-unknown', 'Could not tell your username (no messages or chats). Set the "Your Reddit username" option to label your node.');
  else if (egoHow === 'inferred') b.warn('ego-inferred', `Your username was inferred as "${ego}" from private messages / chats. Set the "Your Reddit username" option if this is wrong.`);
  const egoIdx = b.node(egoKey, { label: ego || 'Me (Reddit)' });
  const userNode = u => (userKey(u) === egoKey ? egoIdx : b.node(userKey(u), { label: u, isBot: u === 'AutoModerator' }));
  const subCtx = s => b.context(subKey(s), { name: 'r/' + String(s).replace(/^\/?r\//, ''), kind: 'subreddit', visibility: 'public', medium: 'reddit' });

  // Own posts and comments. Parents are fullnames (t1_/t3_) of items whose
  // author the export does not give; only own items can resolve.
  const own = new Set([...tables.posts.map(r => 't3_' + stripPrefix(r.id)), ...tables.comments.map(r => 't1_' + stripPrefix(r.id))]);
  let unknownParent = 0, badDate = 0;
  const time = s => { const t = parseExportDate(s); if (Number.isNaN(t) && s) badDate++; return t; };
  for (const r of tables.posts) {
    if (signal?.aborted) signal.throwIfAborted();
    b.event({ type: 'message', t: time(r.date), actor: egoIdx, context: r.subreddit ? subCtx(r.subreddit) : -1, key: 'reddit:t3_' + stripPrefix(r.id), text: [r.title, r.body].filter(Boolean).join('\n\n') || null });
    b.stat('posts');
  }
  for (const r of tables.comments) {
    if (signal?.aborted) signal.throwIfAborted();
    const p = r.parent || '';
    if (p && !own.has(p)) unknownParent++;
    b.event({ type: 'message', t: time(r.date), actor: egoIdx, context: r.subreddit ? subCtx(r.subreddit) : -1, key: 'reddit:t1_' + stripPrefix(r.id), parentKey: p ? 'reddit:' + p : null, text: r.body || null });
    b.stat('comments');
  }
  if (unknownParent) b.warn('reply-author-unknown', 'Your comments reply to posts or comments whose author is not in the export (Reddit gives only the parent id). They count as subreddit activity, not as ties.', unknownParent);

  // Private messages: both directions. Messages to a subreddit (modmail) have no person target.
  let modmail = 0;
  for (const r of tables.messages) {
    if (!r.from) continue;
    const toSub = /^\/?r\//i.test(r.to || '') || (r.to || '').startsWith('#');
    const a = userNode(r.from);
    const c = r.to && !toSub ? userNode(r.to) : -1;
    if (toSub) modmail++;
    const pair = [r.from, r.to || ''].map(x => x.toLowerCase()).sort().join('|');
    const ck = 'reddit:dm:' + (r.thread_id || pair);
    const ctx = b.context(ck, { name: r.subject || [r.from, r.to].filter(Boolean).join(' / '), kind: 'dm', visibility: 'direct', medium: 'reddit', members: c >= 0 ? [a, c] : [a] });
    b.event({ type: 'message', t: time(r.date), actor: a, targets: c >= 0 ? [[c, 'dm']] : [], context: ctx, key: 'reddit:t4_' + stripPrefix(r.id), text: r.body || null });
    b.stat('messages');
  }
  if (modmail) b.warn('message-to-subreddit', 'Private messages addressed to a subreddit (modmail) have no person recipient.', modmail);

  // Chats: participants per channel_url = distinct senders seen. conversation_type
  // values are UNVERIFIED, so group-ness is decided by participant count, plus a
  // defensive check for a type mentioning group/channel/subreddit.
  const chans = new Map();
  const chatAuthor = new Map();
  for (const r of tables.chat) {
    if (!r.channel_url || !r.username) continue;
    if (!chans.has(r.channel_url)) chans.set(r.channel_url, { users: new Set(), rows: [], type: r.conversation_type || '', name: r.channel_name || '' });
    const ch = chans.get(r.channel_url);
    ch.users.add(r.username); ch.rows.push(r);
    if (r.message_id) chatAuthor.set(r.message_id, r.username);
  }
  let replyUnknown = 0;
  for (const [url, ch] of chans) {
    const members = [...ch.users].map(userNode);
    const group = ch.users.size > 2 || /group|channel|subreddit|community/i.test(ch.type);
    const kind = group ? 'group_dm' : 'dm';
    const ctx = b.context(`reddit:${kind}:${url}`, { name: ch.name || [...ch.users].join(', '), kind, visibility: group ? 'group' : 'direct', medium: 'reddit', members });
    const rows = ch.rows.map(r => ({ r, t: time(r.created_at) })).sort((x, y) => (x.t || 0) - (y.t || 0));
    for (const { r, t } of rows) {
      const a = userNode(r.username);
      const targets = [];
      if (!group) for (const m of members) if (m !== a) targets.push([m, 'dm']);
      const pid = r.thread_parent_message_id;
      if (pid) {
        const pa = chatAuthor.get(pid);
        if (pa) targets.push([userNode(pa), 'reply']); else replyUnknown++;
      }
      b.event({ type: 'message', t, actor: a, targets, context: ctx, key: r.message_id ? 'reddit:chat:' + r.message_id : null, parentKey: pid ? 'reddit:chat:' + pid : null, text: r.message || null });
      b.stat('chat_messages');
    }
  }
  if (replyUnknown) b.warn('chat-parent-missing', 'Chat replies whose parent message is not in chat_history.csv; kept without a reply target.', replyUnknown);
  if (chans.size && [...chans.values()].some(c => c.users.size < 2)) b.warn('chat-one-sided', 'Some chats show only one sender, so the other participants are unknown and no direct target was recorded.');

  for (const r of tables.friends) {
    if (!r.username) continue;
    b.event({ type: 'declared', actor: egoIdx, targets: [[userNode(r.username), 'declared']], key: 'reddit:friend:' + r.username.toLowerCase(), text: r.note || null });
    b.stat('friends');
  }
  if (tables.friends.length) b.warn('friends-undated', 'friends.csv has no dates; friend ties have no time.');
  if (tables.subscribed.length) {
    const subs = tables.subscribed.map(r => r.subreddit).filter(Boolean);
    b.node(egoKey, { attrs: { subscribed_subreddits: subs.join('; ') } });
    b.stat('subscribed_subreddits', subs.length);
  }
  if (badDate) b.warn('unparsed-date', 'Dates not in "YYYY-MM-DD HH:MM:SS UTC" form; those rows have no time.', badDate);
}

async function importReddit(fs, { builder, options, progress, signal } = {}) {
  const s = await scan(fs);
  if (!s.dumps.length && !s.csv.length) {
    if (s.zst.length) throw new Error(ZSTD_HELP);
    throw new Error('No Reddit data request CSVs or Pushshift / Arctic Shift NDJSON files found.');
  }
  if (s.csv.length) await importGdpr(builder, s.csv, { options, progress, signal });
  if (s.dumps.length) await importDumps(builder, s.dumps, { progress, signal });
  if (s.zst.length) builder.warn('zst-skipped', `${s.zst.length} .zst file(s) were skipped. ${ZSTD_HELP}`, s.zst.length);
  progress?.(1, 'Reddit import done');
}

export default {
  id: 'reddit',
  label: 'Reddit (data request export or Pushshift / Arctic Shift dump)',
  family: 'community',
  detect,
  options: [{ key: 'username', label: 'Your Reddit username (data request export only)', type: 'text', default: '' }],
  import: importReddit,
};
