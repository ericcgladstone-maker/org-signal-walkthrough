// X / Twitter research datasets (docs/formats/x-research-datasets.md).
//
// API v2 response pages (twarc2 raw, one page per line), twarc2 flattened
// tweets, API v1.1 tweets (twarc v1, enterprise Native Enriched), and the
// twarc-csv / twarc json2csv CSV flattenings. A query-defined sample: only
// tweets in `data` (or the rows/lines themselves) are sampled; `includes` are
// referenced context and never produce events.
//
// Two passes over the files (both streamed for JSONL): pass 1 learns
// username -> id and tweet id -> author id from every record so retweet and
// quote authors resolve across pages; pass 2 emits events.

import { lines, peek } from '../core/fileset.js';
import { VIEWS } from '../core/model.js';
import { parseJSON, streamJSON } from './lib/json.js';
import { parseCSV, firstLine } from './lib/csv.js';
import { isoMs, twitterDateMs } from './lib/time.js';
import { decodeEntities } from './lib/text.js';
import { RT_RE, idStr, handleKey, EXCEL_ID_RE } from './lib/x-common.js';

export const ID_ONLY_MESSAGE =
  'This dataset contains only tweet ids (a "dehydrated" dataset). X allows sharing only ids, and turning ids back into tweets ' +
  '("rehydration") needs an authenticated, paid X API account and a server, which a browser-only tool cannot use. ' +
  'Rehydrate the ids first (for example `twarc2 hydrate ids.txt tweets.jsonl` with your own API access), then import the resulting JSONL.';
export const GNIP_MESSAGE =
  'This looks like GNIP Activity Streams (fields verb/actor/object/postedTime). That legacy format is not supported; ' +
  're-export the data as API v1.1 or v2 JSON if you can.';

const CAND_RE = /\.(jsonl|ndjson|json|csv|txt|tsv)(\.gz)?$/i;
const TWARC_CSV = ['referenced_tweets.retweeted.id', '__twarc.version'];
const JSON2CSV = ['retweet_or_quote_user_id', 'tweet_url'];

// ---- sniffing -----------------------------------------------------------------

async function headText(entry, n = 65536) {
  if (!/\.gz$/i.test(entry.rel)) return peek(entry, n);
  const reader = entry.stream().pipeThrough(new DecompressionStream('gzip')).pipeThrough(new TextDecoderStream()).getReader();
  let s = '';
  try {
    while (s.length < n) { const { done, value } = await reader.read(); if (done) break; s += value; }
  } catch { /* truncated gzip head is fine for sniffing */ }
  reader.cancel().catch(() => {});
  return s.replace(/^﻿/, '');
}

export function classifyObject(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  if ('data' in o && ('includes' in o || 'meta' in o || '__twarc' in o)) return 'page';
  if (o.verb && o.actor && o.object && o.postedTime) return 'gnip';
  if (o.id_str && o.user?.screen_name && ('text' in o || 'full_text' in o)) return 'v11';
  if (o.author_id && o.id && ('text' in o || 'edit_history_tweet_ids' in o) && !o.user) return 'v2';
  if (o.id && o.username && !o.author_id && !('text' in o)) return 'users';
  return null;
}

const ID_LINE = /^\d{6,20}$/;

// -> { kind: 'jsonl'|'json'|'twarc-csv'|'json2csv'|'ids'|'gnip'|'users'|null, sub, reason }
export async function sniff(entry) {
  if (!CAND_RE.test(entry.rel)) return { kind: null };
  const head = await headText(entry);
  const trimmed = head.trimStart();
  if (/^window\.YTD\./.test(trimmed)) return { kind: null }; // personal archive, see x-archive
  if (/\.(csv|tsv|txt)(\.gz)?$/i.test(entry.rel) && !/^[[{]/.test(trimmed)) {
    const header = firstLine(head).split(/[,\t]/).map(h => h.trim().replace(/^"|"$/g, ''));
    if (TWARC_CSV.every(c => header.includes(c))) return { kind: 'twarc-csv', reason: 'twarc-csv (API v2) CSV' };
    if (JSON2CSV.every(c => header.includes(c))) return { kind: 'json2csv', reason: 'twarc json2csv (API v1.1) CSV' };
    const rows = head.split(/\r?\n/).slice(0, -1).map(l => l.trim().replace(/^"|"$/g, '')).filter(Boolean);
    const body = rows.length && /^(id|ids|tweet_?id|tweet_?ids|status_?id|id_str)$/i.test(rows[0]) ? rows.slice(1) : rows;
    if (body.length && body.every(l => ID_LINE.test(l))) return { kind: 'ids', reason: 'dehydrated tweet ids (cannot be imported in the browser)' };
    return { kind: null };
  }
  if (!/^[[{]/.test(trimmed)) return { kind: null };
  // First JSON value: a full line when we have it, else regex hints on the head.
  const nl = trimmed.indexOf('\n');
  const isArray = trimmed[0] === '[';
  let first = null;
  try { first = parseJSON(nl >= 0 ? trimmed.slice(0, nl) : trimmed); } catch { /* incomplete */ }
  if (isArray) {
    if (Array.isArray(first)) first = first[0];
    else {
      const m = /^\[\s*(\{[\s\S]*?\})\s*,?\s*\n/.exec(trimmed);
      try { first = m ? parseJSON(m[1]) : null; } catch { first = null; }
    }
  }
  let sub = classifyObject(first);
  if (!sub) {
    if (/^[[\s]*\{\s*"data"\s*:/.test(trimmed) && /"(includes|meta)"\s*:/.test(head)) sub = 'page';
    else if (/"id_str"\s*:/.test(head) && /"screen_name"\s*:/.test(head)) sub = 'v11';
    else if (/"author_id"\s*:/.test(head) && /"(text|edit_history_tweet_ids)"\s*:/.test(head) && !/"user"\s*:\s*\{/.test(head)) sub = 'v2';
    else if (/"verb"\s*:/.test(head) && /"postedTime"\s*:/.test(head)) sub = 'gnip';
  }
  if (!sub) return { kind: null };
  if (sub === 'gnip') return { kind: 'gnip', reason: 'GNIP Activity Streams (unsupported)' };
  if (sub === 'users') return { kind: 'users', reason: 'user list (followers/following), not tweets' };
  // JSONL when the extension says so or a second line starts a new object;
  // otherwise one JSON document (array or single API response).
  const rest = nl >= 0 ? trimmed.slice(nl + 1).trimStart() : '';
  const kind = isArray ? 'json' : (/\.(jsonl|ndjson)(\.gz)?$/i.test(entry.rel) || rest.startsWith('{') ? 'jsonl' : 'json');
  const label = { page: 'API v2 response pages (twarc2)', v2: 'API v2 tweets (flattened)', v11: 'API v1.1 tweets' }[sub];
  return { kind, sub, reason: label };
}

const SCORES = { 'twarc-csv': 0.95, json2csv: 0.95, page: 0.95, v2: 0.9, v11: 0.85, ids: 0.6, gnip: 0.6 };

async function detect(fs) {
  let best = { score: 0 };
  for (const e of fs.entries.filter(x => CAND_RE.test(x.rel)).slice(0, 50)) {
    let s;
    try { s = await sniff(e); } catch { continue; }
    const score = SCORES[s.sub] ?? SCORES[s.kind] ?? 0;
    if (score > best.score) best = { score, reason: `${s.reason} in ${e.rel}` };
  }
  return best;
}

// ---- record readers ---------------------------------------------------------

function textStream(entry) {
  const s = entry.stream();
  return /\.gz$/i.test(entry.rel) ? s.pipeThrough(new DecompressionStream('gzip')) : s;
}

// Yields raw JSON objects (pages or tweets) or CSV rows tagged by kind.
async function* rawRecords(entry, kind, builder) {
  if (kind === 'jsonl') {
    for await (const line of lines(textStream(entry))) {
      if (!line.trim()) continue;
      let o;
      try { o = parseJSON(line); } catch { builder.warn('bad-json-line', 'Lines that were not valid JSON were skipped.'); continue; }
      yield o;
    }
  } else if (kind === 'json') {
    // Arrays are streamed element by element; a single object (one API
    // response) has to be parsed whole.
    const head = (await headText(entry, 256)).trimStart();
    if (head[0] === '[') {
      const src = textStream(entry);
      for await (const { value } of streamJSON(src, ['*'])) yield value;
    } else {
      const text = await new Response(textStream(entry)).text();
      let doc;
      try { doc = parseJSON(text); } catch {
        // Pages longer than the sniffing window can hide that this is JSONL.
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue;
          try { doc = parseJSON(line); } catch { builder.warn('bad-json-line', 'Lines that were not valid JSON were skipped.'); continue; }
          yield doc;
        }
        return;
      }
      yield doc;
    }
  } else {
    // CSV: papaparse over the whole text (quoted multi-line text fields make
    // line streaming unsafe). Practical limit is a few hundred MB per file.
    const text = await new Response(textStream(entry)).text();
    const { rows } = parseCSV(text);
    for (const r of rows) yield r;
  }
}

// ---- normalisation ------------------------------------------------------------
// Normalised tweet: { id, authorId, t, text, conv, replyUser, replyStatus,
//   mentions[{id, username, start}], visibleFrom, rtOf{id, authorId, username},
//   quoteOf{...}, editIds[] }. Side info: users[{id, username, name, attrs}],
//   tweetAuthors[[tweetId, authorId]].

function userFromV2(u) {
  if (!u || !idStr(u.id)) return null;
  const pm = u.public_metrics || {};
  return { id: idStr(u.id), username: u.username, name: u.name, attrs: { followers: pm.followers_count, following: pm.following_count, verified: u.verified } };
}
function userFromV11(u) {
  if (!u || !idStr(u.id_str ?? u.id)) return null;
  return { id: idStr(u.id_str ?? u.id), username: u.screen_name, name: u.name, attrs: { followers: u.followers_count, following: u.friends_count, verified: u.verified } };
}

function normV2(t, out) {
  const users = out.users;
  if (t.author) { const u = userFromV2(t.author); if (u) users.push(u); }
  if (t.in_reply_to_user) { const u = userFromV2(t.in_reply_to_user); if (u) users.push(u); }
  const n = {
    id: idStr(t.id), authorId: idStr(t.author_id ?? t.author?.id), t: isoMs(t.created_at),
    text: t.note_tweet?.text ?? t.text ?? null, conv: idStr(t.conversation_id),
    replyUser: idStr(t.in_reply_to_user_id ?? t.in_reply_to_user?.id), replyStatus: null,
    mentions: [], visibleFrom: Number(t.display_text_range?.[0] ?? 0), rtOf: null, quoteOf: null,
    editIds: (t.edit_history_tweet_ids || []).map(String),
  };
  for (const r of t.referenced_tweets || []) {
    const ref = { id: idStr(r.id), authorId: idStr(r.author_id ?? r.author?.id), username: r.author?.username };
    if (r.author) { const u = userFromV2(r.author); if (u) users.push(u); }
    if (ref.id && ref.authorId) out.tweetAuthors.push([ref.id, ref.authorId]);
    if (r.type === 'replied_to') n.replyStatus = ref.id;
    else if (r.type === 'retweeted') n.rtOf = ref;
    else if (r.type === 'quoted') n.quoteOf = ref;
  }
  const ents = t.note_tweet?.entities?.mentions ? t.note_tweet.entities : t.entities;
  for (const m of ents?.mentions || []) {
    n.mentions.push({ id: idStr(m.id), username: m.username, start: Number(m.start ?? 0) });
    if (idStr(m.id) && m.username) users.push({ id: idStr(m.id), username: m.username, name: m.name, attrs: {} });
  }
  if (t.__twarc?.url) out.urls.push(t.__twarc.url);
  out.tweets.push(n);
}

function normPage(p, out) {
  for (const u of p.includes?.users || []) { const x = userFromV2(u); if (x) out.users.push(x); }
  for (const it of p.includes?.tweets || []) if (idStr(it.id) && idStr(it.author_id)) out.tweetAuthors.push([idStr(it.id), idStr(it.author_id)]);
  if (Array.isArray(p.errors) && p.errors.length) out.errors += p.errors.length;
  if (p.__twarc?.url) out.urls.push(p.__twarc.url);
  const data = Array.isArray(p.data) ? p.data : (p.data ? [p.data] : []);
  for (const t of data) normV2(t, out);
}

function normV11(t, out) {
  const u = userFromV11(t.user);
  if (u) out.users.push(u);
  const ext = t.truncated && t.extended_tweet ? t.extended_tweet : null;
  const ents = ext?.entities ?? t.entities;
  const n = {
    id: idStr(t.id_str ?? t.id), authorId: u?.id ?? null, t: twitterDateMs(t.created_at),
    text: decodeEntities(ext?.full_text ?? t.full_text ?? t.text ?? ''), conv: null,
    replyUser: idStr(t.in_reply_to_user_id_str ?? t.in_reply_to_user_id), replyStatus: idStr(t.in_reply_to_status_id_str ?? t.in_reply_to_status_id),
    mentions: [], visibleFrom: Number((ext?.display_text_range ?? t.display_text_range)?.[0] ?? 0), rtOf: null, quoteOf: null, editIds: [],
  };
  if (n.replyUser && t.in_reply_to_screen_name) out.users.push({ id: n.replyUser, username: t.in_reply_to_screen_name, attrs: {} });
  for (const m of ents?.user_mentions || []) {
    const id = idStr(m.id_str ?? m.id);
    n.mentions.push({ id, username: m.screen_name, start: Number(m.indices?.[0] ?? 0) });
    if (id && m.screen_name) out.users.push({ id, username: m.screen_name, name: m.name, attrs: {} });
  }
  const rs = t.retweeted_status;
  if (rs) {
    // retweeted_status always points at the original; its text is complete
    // while the top-level RT text is truncated.
    const ru = userFromV11(rs.user);
    if (ru) out.users.push(ru);
    n.rtOf = { id: idStr(rs.id_str ?? rs.id), authorId: ru?.id ?? null, username: ru?.username };
    const rext = rs.truncated && rs.extended_tweet ? rs.extended_tweet : null;
    n.text = decodeEntities(rext?.full_text ?? rs.full_text ?? rs.text ?? n.text);
    if (n.rtOf.id && n.rtOf.authorId) out.tweetAuthors.push([n.rtOf.id, n.rtOf.authorId]);
  }
  const qid = idStr(t.quoted_status_id_str ?? t.quoted_status?.id_str);
  if (qid || t.quoted_status) {
    const qu = userFromV11(t.quoted_status?.user);
    if (qu) out.users.push(qu);
    n.quoteOf = { id: qid, authorId: qu?.id ?? null, username: qu?.username };
    if (qid && qu) out.tweetAuthors.push([qid, qu.id]);
  }
  out.tweets.push(n);
}

function jsonList(v) {
  if (!v) return [];
  try { const x = parseJSON(v); return Array.isArray(x) ? x : []; } catch { return []; }
}

// CSV id cells: '' -> null; Excel scientific notation -> flagged.
function csvId(v, out, what) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  if (EXCEL_ID_RE.test(s)) { out.mangled[what] = (out.mangled[what] || 0) + 1; return undefined; }
  return s;
}

function normTwarcCsv(r, out) {
  const id = csvId(r.id, out, 'id');
  const authorId = csvId(r.author_id, out, 'author_id');
  if (!authorId) { out.skipped++; return; }
  if (r['__twarc.url']) out.urls.push(r['__twarc.url']);
  out.users.push({ id: authorId, username: r['author.username'] || undefined, name: r['author.name'] || undefined,
    attrs: { followers: r['author.public_metrics.followers_count'] || undefined } });
  const replyUser = csvId(r.in_reply_to_user_id, out, 'in_reply_to_user_id') || null;
  if (replyUser && r.in_reply_to_username) out.users.push({ id: replyUser, username: r.in_reply_to_username, attrs: {} });
  const ref = (rid, uid, uname) => {
    const i = csvId(r[rid], out, rid) || null;
    const a = csvId(r[uid], out, uid) || null;
    if (!i && !a && !r[uname]) return null;
    if (a && r[uname]) out.users.push({ id: a, username: r[uname], attrs: {} });
    if (i && a) out.tweetAuthors.push([i, a]);
    return { id: i, authorId: a, username: r[uname] || undefined };
  };
  const n = {
    id: id || null, authorId, t: isoMs(r.created_at), text: r.text ?? null, conv: csvId(r.conversation_id, out, 'conversation_id') || null,
    replyUser, replyStatus: csvId(r['referenced_tweets.replied_to.id'], out, 'replied_to') || null,
    mentions: [], visibleFrom: 0,
    rtOf: ref('referenced_tweets.retweeted.id', 'retweeted_user_id', 'retweeted_username'),
    quoteOf: ref('referenced_tweets.quoted.id', 'quoted_user_id', 'quoted_username'),
    editIds: jsonList(r.edit_history_tweet_ids).map(String),
  };
  for (const m of jsonList(r['entities.mentions'])) {
    n.mentions.push({ id: idStr(m.id), username: m.username, start: Number(m.start ?? 0) });
    if (idStr(m.id) && m.username) out.users.push({ id: idStr(m.id), username: m.username, attrs: {} });
  }
  out.tweets.push(n);
}

function normJson2csv(r, out) {
  const id = csvId(r.id, out, 'id');
  const authorId = csvId(r.user_id, out, 'user_id');
  if (!authorId) { out.skipped++; return; }
  out.users.push({ id: authorId, username: r.user_screen_name || undefined, name: r.user_name || undefined, attrs: { followers: r.user_followers_count || undefined } });
  const replyUser = csvId(r.in_reply_to_user_id, out, 'in_reply_to_user_id') || null;
  if (replyUser && r.in_reply_to_screen_name) out.users.push({ id: replyUser, username: r.in_reply_to_screen_name, attrs: {} });
  const type = String(r.tweet_type || '').toLowerCase();
  const refId = csvId(r.retweet_or_quote_id, out, 'retweet_or_quote_id') || null;
  const refUser = csvId(r.retweet_or_quote_user_id, out, 'retweet_or_quote_user_id') || null;
  if (refUser && r.retweet_or_quote_screen_name) out.users.push({ id: refUser, username: r.retweet_or_quote_screen_name, attrs: {} });
  if (refId && refUser) out.tweetAuthors.push([refId, refUser]);
  const ref = refId || refUser ? { id: refId, authorId: refUser, username: r.retweet_or_quote_screen_name || undefined } : null;
  let t = twitterDateMs(r.created_at);
  if (!Number.isFinite(t)) t = isoMs(r.parsed_created_at);
  const text = decodeEntities(r.text ?? '');
  // json2csv has no mention-id column: mentions come from @handles in the text
  // and resolve to ids only through handles seen elsewhere in the dataset.
  const mentions = [...text.matchAll(/(?:^|[^\w])@(\w{1,15})/g)].map(m => ({ id: null, username: m[1], start: m.index }));
  out.tweets.push({
    id: id || null, authorId, t, text, conv: null, replyUser,
    replyStatus: csvId(r.in_reply_to_status_id, out, 'in_reply_to_status_id') || null,
    mentions: type === 'retweet' ? [] : mentions, visibleFrom: 0, mentionsFromText: true,
    rtOf: type === 'retweet' ? ref : null, quoteOf: type === 'quote' ? ref : null, editIds: [],
  });
}

function normalize(raw, kind, out) {
  if (kind === 'twarc-csv') return normTwarcCsv(raw, out);
  if (kind === 'json2csv') return normJson2csv(raw, out);
  const c = classifyObject(raw);
  if (c === 'page') normPage(raw, out);
  else if (c === 'v2') normV2(raw, out);
  else if (c === 'v11') normV11(raw, out);
  else if (c === 'gnip') out.gnip++;
  else if (c === 'users') out.userRecords++;
  else out.unknown++;
}

const newOut = () => ({ tweets: [], users: [], tweetAuthors: [], urls: [], errors: 0, gnip: 0, userRecords: 0, unknown: 0, skipped: 0, mangled: {} });

// ---- import -------------------------------------------------------------------

async function importResearch(fs, { builder, progress, signal }) {
  const files = [];
  const rejected = { ids: [], gnip: [], users: [] };
  for (const e of fs.entries.filter(x => CAND_RE.test(x.rel))) {
    const s = await sniff(e);
    if (s.kind === 'ids' || s.kind === 'gnip' || s.kind === 'users') rejected[s.kind].push(e.rel);
    else if (s.kind) files.push({ entry: e, kind: s.kind });
  }
  if (!files.length) {
    if (rejected.ids.length) throw new Error(ID_ONLY_MESSAGE);
    if (rejected.gnip.length) throw new Error(GNIP_MESSAGE);
    throw new Error('No X API tweet data (v1.1, v2, twarc JSONL or CSV) was found in these files.');
  }

  builder.beginSource({ format: 'x-research', family: 'online', medium: 'x', view: VIEWS.SAMPLE, context: 'online', tz: 'UTC',
    fileNames: files.map(f => f.entry.rel), egoKey: null });
  if (rejected.ids.length) builder.warn('ids-only-skipped', `Files with tweet ids only were skipped: ${rejected.ids.join(', ')}. ${ID_ONLY_MESSAGE}`, rejected.ids.length);
  if (rejected.gnip.length) builder.warn('gnip-unsupported', GNIP_MESSAGE, rejected.gnip.length);
  if (rejected.users.length) builder.warn('user-list-skipped', 'Follower/following user lists were skipped: the account they belong to is not recorded in the file.', rejected.users.length);

  // ---- pass 1: maps ----
  const userInfo = new Map();     // id -> { username, name, attrs }
  const usernameToId = new Map(); // lowercase username -> id
  const tweetAuthor = new Map();  // tweet id -> author id
  const parentOf = new Map();     // tweet id -> replied-to tweet id (v1.1 thread roots)
  const superseded = new Set();   // older versions of edited tweets whose latest version is present
  const urls = new Set();
  const editChains = [];
  const tally = newOut(); delete tally.tweets; delete tally.users; delete tally.tweetAuthors; delete tally.urls;
  const totalBytes = files.reduce((s, f) => s + (f.entry.size || 0), 0) || 1;
  let doneBytes = 0;

  const absorb = out => {
    for (const u of out.users) {
      if (!u.id) continue;
      const prev = userInfo.get(u.id) || { attrs: {} };
      userInfo.set(u.id, { username: u.username || prev.username, name: u.name || prev.name, attrs: { ...prev.attrs, ...Object.fromEntries(Object.entries(u.attrs || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')) } });
      if (u.username) usernameToId.set(u.username.toLowerCase(), u.id);
    }
    for (const [tid, aid] of out.tweetAuthors) tweetAuthor.set(tid, aid);
    for (const n of out.tweets) {
      if (n.id && n.authorId) tweetAuthor.set(n.id, n.authorId);
      if (n.id && n.replyStatus) parentOf.set(n.id, n.replyStatus);
      if (n.id && n.editIds.length > 1) editChains.push(n.editIds);
    }
    for (const u of out.urls) if (urls.size < 50) urls.add(u);
  };

  for (const f of files) {
    for await (const raw of rawRecords(f.entry, f.kind, builder)) {
      signal?.throwIfAborted();
      const out = newOut();
      normalize(raw, f.kind, out);
      absorb(out);
      for (const k of ['errors', 'gnip', 'userRecords', 'unknown', 'skipped']) tally[k] += out[k];
      for (const [k, v] of Object.entries(out.mangled)) tally.mangled[k] = (tally.mangled[k] || 0) + v;
    }
    doneBytes += f.entry.size || 0;
    progress?.(0.4 * doneBytes / totalBytes, `Indexed ${f.entry.rel}`);
  }
  // Edits: keep the latest id per edit chain (spec section 7). The chain lists
  // ids oldest first; an older id is dropped only when the latest is present.
  const present = new Set(tweetAuthor.keys());
  for (const chain of editChains) {
    const latest = chain[chain.length - 1];
    if (present.has(latest)) for (const old of chain.slice(0, -1)) superseded.add(old);
  }
  builder.source.queries = [...urls];

  if (tally.errors) builder.warn('api-errors', 'API pages reported missing (deleted or protected) referenced items in errors[].', tally.errors);
  if (tally.gnip) builder.warn('gnip-unsupported', GNIP_MESSAGE, tally.gnip);
  if (tally.userRecords) builder.warn('user-list-skipped', 'User objects without tweets were skipped.', tally.userRecords);
  if (tally.unknown) builder.warn('unknown-record', 'Records that were neither X API v1.1 nor v2 tweets were skipped.', tally.unknown);
  const mangledTotal = Object.values(tally.mangled).reduce((a, b) => a + b, 0);
  if (mangledTotal) builder.warn('excel-mangled-ids', `Some id cells are in scientific notation (e.g. 1.8E+18): the CSV was opened and saved in Excel, which destroys 64-bit ids. Affected columns: ${Object.keys(tally.mangled).join(', ')}. Use the original CSV.`, mangledTotal);
  if (tally.skipped) builder.warn('row-without-author', 'CSV rows without a usable author id were skipped.', tally.skipped);

  // ---- pass 2: events ----
  const person = id => builder.node('x:' + id, { platformIds: { x: id } });
  const resolveRef = (ref, rtText) => {
    let aid = ref?.authorId || (ref?.id ? tweetAuthor.get(ref.id) : null);
    let handle = ref?.username;
    if (!aid && !handle && rtText) handle = RT_RE.exec(rtText)?.[1];
    if (!aid && handle) aid = usernameToId.get(handle.toLowerCase());
    if (aid) return person(aid);
    if (handle) {
      builder.warn('handle-only-node', 'Some accounts are known only by @handle; they may duplicate an id-keyed node of the same person.');
      return builder.node(handleKey(handle), { label: '@' + handle, platformIds: { handle } });
    }
    return -1;
  };
  const rootCache = new Map();
  const rootOf = id => {
    if (rootCache.has(id)) return rootCache.get(id);
    let cur = id;
    const seen = new Set([id]);
    while (parentOf.has(cur) && !seen.has(parentOf.get(cur))) { cur = parentOf.get(cur); seen.add(cur); }
    rootCache.set(id, cur);
    return cur;
  };

  const seen = new Set();
  let dups = 0, edits = 0;
  doneBytes = 0;
  for (const f of files) {
    for await (const raw of rawRecords(f.entry, f.kind, builder)) {
      signal?.throwIfAborted();
      const out = newOut();
      normalize(raw, f.kind, out);
      for (const n of out.tweets) {
        if (!n.authorId) { builder.warn('tweet-without-author', 'Tweets without an author id were skipped (request the author_id field / user object).'); continue; }
        if (n.id) {
          if (seen.has(n.id)) { dups++; continue; }
          seen.add(n.id);
          if (superseded.has(n.id)) { edits++; continue; }
        }
        emit(n);
      }
    }
    doneBytes += f.entry.size || 0;
    progress?.(0.4 + 0.6 * doneBytes / totalBytes, `Imported ${f.entry.rel}`);
  }
  if (dups) builder.warn('duplicate-tweets', 'Tweets seen more than once (overlapping pages or resumed runs) were counted once.', dups);
  if (edits) builder.warn('edit-superseded', 'Earlier versions of edited tweets were dropped in favour of the latest version.', edits);

  // Labels and attributes only for accounts that ended up as nodes: includes
  // are context, not sampled nodes.
  for (const [id, u] of userInfo) {
    if (!builder.hasNode('x:' + id)) continue;
    builder.node('x:' + id, { label: u.name || (u.username ? '@' + u.username : undefined), attrs: u.attrs, platformIds: u.username ? { handle: u.username } : undefined });
  }

  function emit(n) {
    const actor = person(n.authorId);
    const key = n.id ? 'x:tweet:' + n.id : null;
    builder.stat('tweets');
    if (n.rtOf) {
      const subj = resolveRef(n.rtOf, n.text);
      if (subj < 0) builder.warn('retweet-author-unknown', 'Retweets whose original author could not be resolved have no target.');
      builder.event({ type: 'repost', t: n.t, actor, targets: subj >= 0 ? [[subj, 'subject']] : [], key, text: n.text });
      builder.stat('retweets');
      return;
    }
    const targets = [];
    let replyNode = -1;
    const replyUser = n.replyUser || (n.replyStatus ? tweetAuthor.get(n.replyStatus) : null);
    if (replyUser) { replyNode = person(replyUser); targets.push([replyNode, 'reply']); builder.stat('replies'); }
    // Do not count the auto-prepended reply @-mention twice: skip mentions
    // before display_text_range[0], and a mention of the reply target itself.
    for (const m of n.mentions) {
      if (m.start < n.visibleFrom) continue;
      const id = m.id || (m.username ? usernameToId.get(m.username.toLowerCase()) : null);
      if (!id) { builder.warn('mention-unresolved', 'Mentions whose account id could not be resolved were skipped.'); continue; }
      const mn = person(id);
      if (mn === replyNode) continue;
      targets.push([mn, 'mention']);
      builder.stat('mentions');
    }
    const root = n.conv || (n.id ? rootOf(n.id) : null);
    const ctx = root ? builder.context('x:thread:' + root, { name: 'X conversation ' + root, kind: 'thread', visibility: 'public', medium: 'x' }) : -1;
    builder.event({ type: 'message', t: n.t, actor, targets, context: ctx, key, parentKey: n.replyStatus ? 'x:tweet:' + n.replyStatus : null, text: n.text });
    if (!Number.isFinite(n.t)) builder.warn('bad-time', 'Some tweets had no readable created_at; their time is unknown.');
    if (n.quoteOf) {
      const subj = resolveRef(n.quoteOf, null);
      if (subj >= 0) {
        builder.event({ type: 'repost', t: n.t, actor, targets: [[subj, 'subject']], key: n.id ? 'x:quote:' + n.id : null });
        builder.stat('quotes');
      } else builder.warn('quote-author-unknown', 'Quotes whose quoted author could not be resolved were not linked.');
    }
  }
}

export default {
  id: 'x-research',
  label: 'X / Twitter research dataset (API JSON, twarc)',
  family: 'online',
  detect,
  options: [],
  import: importResearch,
};
