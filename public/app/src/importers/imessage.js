// iMessage / SMS importer (docs/formats/imessage.md).
//
// Two inputs:
//   A. macOS `chat.db` (or the iOS backup's `sms.db`, same schema), read with
//      sql.js. Exact UTC times, handles as node ids, tapbacks, inline replies,
//      group membership and group actions.
//   B. imessage-exporter TXT output (one file per conversation). Lossy: local
//      wall-clock times without offset, names or raw handles, no parent ids.
//
// Ego view. chat.db holds no names, so handles (phone / email) are the nodes.

import { peek } from '../core/fileset.js';
import { decodeAttributedBody } from './lib/typedstream.js';
import { nameKey } from './lib/text.js';
import { zonedToUtc, isValidTimeZone } from './lib/time.js';

const NS = 'imessage';
const EGO_KEY = `${NS}:me`;
const APPLE_EPOCH_MS = 978307200000; // 2001-01-01T00:00:00Z

const BACKUP_HELP = 'Make a single consistent copy with: sqlite3 ~/Library/Messages/chat.db ".backup \'$HOME/Desktop/chat-copy.db\'" (Terminal needs Full Disk Access), then import chat-copy.db.';

// ---- sql.js loading -----------------------------------------------------------
//
// vendor/sql-wasm-browser.mjs is sql.js's browser build re-bundled as an ES
// module (default export: initSqlJs). We hand it the wasm bytes directly
// (`wasmBinary`) so no locateFile/fetch logic inside sql.js is involved. In
// Node (tests) the wasm is read from disk. setSqlJsLoader() lets a host supply
// its own loader.

let sqlJsLoader = null;
let sqlJsPromise = null;

// fn: async () => SQL (the object initSqlJs resolves to). Pass null to restore the default.
export function setSqlJsLoader(fn) {
  sqlJsLoader = fn;
  sqlJsPromise = null;
}

async function defaultSqlJsLoader() {
  const { default: initSqlJs } = await import('../../vendor/sql-wasm-browser.mjs');
  const wasmUrl = new URL('../../vendor/sql-wasm-browser.wasm', import.meta.url);
  let wasmBinary;
  if (wasmUrl.protocol === 'file:') {
    const fsp = await import('node:fs/promises');
    wasmBinary = new Uint8Array(await fsp.readFile(wasmUrl));
  } else {
    const w = await fetch(wasmUrl);
    if (!w.ok) throw new Error('Could not load the SQLite engine (vendor/sql-wasm-browser.wasm).');
    wasmBinary = new Uint8Array(await w.arrayBuffer());
  }
  return initSqlJs({ wasmBinary });
}

export function loadSqlJs() {
  if (!sqlJsPromise) sqlJsPromise = (sqlJsLoader || defaultSqlJsLoader)();
  return sqlJsPromise;
}

// ---- pure helpers ---------------------------------------------------------------

// message.date -> Unix ms. Apple epoch 2001-01-01Z; nanoseconds on High Sierra+
// databases, seconds on older ones. imessage-exporter's rule: >= 1e12 means ns.
// 0 / NULL (some system rows) -> NaN.
export function appleDateMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = typeof v === 'bigint' ? Number(v) : Number(v);
  if (!Number.isFinite(n) || n === 0) return NaN;
  return n >= 1e12 ? Math.floor(n / 1e6) + APPLE_EPOCH_MS : n * 1000 + APPLE_EPOCH_MS;
}

// Handle string -> { key, kind, value }. Phones keep only digits and a leading
// '+' (no country code is added: chat.db does not say which country a bare
// national number belongs to). Emails are lowercased. Anything else (short
// codes, business ids) is kept lowercased as is.
export function normalizeHandle(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (/^[^\s@]+@[^\s@]+$/.test(s)) {
    const v = s.toLowerCase();
    return { key: `${NS}:${v}`, kind: 'email', value: v };
  }
  if (/^\+?[\d\s().-]{5,}$/.test(s) && /\d{3}/.test(s.replace(/\D/g, ''))) {
    const v = (s.startsWith('+') ? '+' : '') + s.replace(/\D/g, '');
    return { key: `${NS}:${v}`, kind: 'phone', value: v };
  }
  const v = s.toLowerCase();
  return { key: `${NS}:${v}`, kind: 'other', value: v };
}

// associated_message_guid carries prefixes like 'p:0/<guid>' or 'bp:<guid>'
// (commonly seen, unverified): strip up to the last '/' or ':'.
export function stripAssociatedGuid(g) {
  if (!g) return null;
  const s = String(g);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf(':'));
  return i >= 0 ? s.slice(i + 1) : s;
}

const TAPBACK_NAMES = ['loved', 'liked', 'disliked', 'laughed', 'emphasized', 'questioned', 'emoji', 'sticker'];

function cleanText(s) {
  if (s == null) return null;
  const t = String(s).replace(/￼/g, '').trim();
  return t ? t : null;
}

// ---- detection --------------------------------------------------------------------

const SQLITE_MAGIC = 'SQLite format 3\u0000';
const DB_NAME_RE = /(^|\/)(chat|sms)\.db$|(^|\/)3d0d7e5fb2ce288813306e4d4636395e047a3d28$/i;
const DB_EXT_RE = /\.(db|sqlite|sqlite3)$/i;
// imessage-exporter TXT timestamp line: `%b %d, %Y %l:%M:%S %p` (%l space-pads,
// so "May 17, 2022  5:29:42 PM"). Leading whitespace allowed: threaded replies
// are re-printed under their parent, possibly indented.
const TXT_TS_RE = /^\s*([A-Z][a-z]{2}) (\d{2}), (\d{4}) ([ \d]\d):(\d{2}):(\d{2}) ([AP]M)(.*)$/;

function dbCandidates(fs) {
  return fs.entries.filter(e => DB_NAME_RE.test(e.rel) || DB_EXT_RE.test(e.rel)).slice(0, 20);
}

async function sniffDb(e) {
  const head = await peek(e, 65536);
  if (!head.startsWith(SQLITE_MAGIC)) return 0;
  // sqlite_master lives on page 1, so CREATE TABLE text is usually in the first 64 KB.
  const tables = head.includes('chat_message_join') && head.includes('chat_handle_join');
  if (tables) return 0.95;
  return DB_NAME_RE.test(e.rel) ? 0.6 : 0;
}

function txtCandidates(fs) {
  return fs.entries.filter(e => /\.txt$/i.test(e.rel));
}

async function sniffTxt(e) {
  const head = await peek(e, 2048);
  const ls = head.split(/\r?\n/);
  let i = 0;
  while (i < ls.length && !ls[i].trim()) i++;
  const m = TXT_TS_RE.exec(ls[i] || '');
  if (!m) return false;
  // Either a message block (sender on the next line) or a one-line announcement.
  return (m[8].trim() === '' || m[8].startsWith(' (')) ? !!(ls[i + 1] || '').trim() : true;
}

async function detect(fs) {
  let best = 0;
  for (const e of dbCandidates(fs)) best = Math.max(best, await sniffDb(e));
  if (best >= 0.5) return { score: best, reason: best >= 0.9 ? 'SQLite database with the Messages tables (chat.db / sms.db)' : 'SQLite file named like chat.db / sms.db' };
  const txts = txtCandidates(fs);
  let hits = 0;
  for (const e of txts.slice(0, 5)) if (await sniffTxt(e)) hits++;
  if (hits) {
    const orphan = txts.some(e => /(^|\/)orphaned\.txt$/i.test(e.rel));
    return { score: orphan ? 0.9 : 0.85, reason: 'imessage-exporter text export (timestamp / sender blocks)' };
  }
  return { score: 0, reason: '' };
}

// ---- chat.db import -------------------------------------------------------------

const MESSAGE_COLS = ['ROWID', 'guid', 'text', 'attributedBody', 'handle_id', 'other_handle', 'service', 'date',
  'is_from_me', 'item_type', 'group_action_type', 'group_title', 'associated_message_guid', 'associated_message_type',
  'thread_originator_guid', 'destination_caller_id', 'cache_has_attachments'];

function columns(db, table) {
  const r = db.exec(`PRAGMA table_info(${table})`);
  return new Set(r.length ? r[0].values.map(v => v[1]) : []);
}

function all(db, sql) {
  const out = [];
  const st = db.prepare(sql);
  try { while (st.step()) out.push(st.getAsObject()); } finally { st.free(); }
  return out;
}

async function importDb(fs, entry, { builder, progress, signal }) {
  builder.beginSource({ format: 'imessage', family: 'personal', medium: 'imessage', view: 'ego', context: 'personal', tz: 'UTC', fileNames: [entry.rel], egoKey: EGO_KEY });
  if (entry.size > 1e9) {
    builder.warn('large-database', `This database is ${(entry.size / 1e9).toFixed(1)} GB. The browser must hold it all in memory and may run out above about 1-2 GB. If the import fails, make a slimmed copy (sqlite3 chat.db ".backup x.db", then VACUUM) or delete old rows from the copy first.`);
  }
  progress?.(0.02, 'Loading SQLite engine');
  const SQL = await loadSqlJs();
  signal?.throwIfAborted();
  progress?.(0.05, 'Reading database');
  const bytes = await entry.bytes();
  // WAL handling. sql.js reads one file image and cannot apply a -wal sidecar,
  // so frames not yet checkpointed into the main file are lost. A `.backup` copy
  // folds them in but keeps the WAL flag in the header (bytes 18/19 == 2), so the
  // header alone cannot tell a safe copy from a Finder copy: warn either way.
  const walSidecar = fs.entries.find(e => e.rel.toLowerCase() === `${entry.rel.toLowerCase()}-wal`);
  if (walSidecar) {
    builder.warn('wal-not-applied', `A ${walSidecar.rel} file was included. The browser cannot apply it, so messages it holds (often the most recent days or weeks) are missing. ${BACKUP_HELP}`);
  } else if (bytes[18] === 2 || bytes[19] === 2) {
    builder.warn('wal-mode-copy', `This database uses write-ahead logging. If it was copied in Finder (or with cp) instead of sqlite3 .backup, recent messages still in chat.db-wal are missing. ${BACKUP_HELP}`);
  }
  // Mark the in-memory image as rollback-journal so SQLite does not look for a WAL
  // file that does not exist in sql.js's virtual file system.
  if (bytes[18] === 2) bytes[18] = 1;
  if (bytes[19] === 2) bytes[19] = 1;
  let db;
  try { db = new SQL.Database(bytes); } catch (e) { throw new Error(`Could not open the database: ${e.message}`); }
  try {
    for (const t of ['message', 'handle', 'chat', 'chat_message_join', 'chat_handle_join']) {
      if (!columns(db, t).size) throw new Error(`This SQLite file has no "${t}" table, so it is not a Messages chat.db / sms.db.`);
    }
    if (fs.entries.some(e => /\.abcddb$/i.test(e.rel))) {
      builder.warn('contacts-not-read', 'A Contacts database (.abcddb) was included but is not read yet: its schema is not documented in the format spec. People are shown by phone number or email.');
    }

    const ego = builder.node(EGO_KEY, { label: 'Me' });

    // Handles -> nodes. Several handle rows can share one node (iMessage and SMS
    // rows for the same number).
    const hcols = columns(db, 'handle');
    const handles = all(db, `SELECT ROWID, id, ${hcols.has('service') ? 'service' : 'NULL AS service'}, ${hcols.has('person_centric_id') ? 'person_centric_id' : 'NULL AS person_centric_id'} FROM handle`);
    const handleNode = new Map();
    for (const h of handles) {
      const n = normalizeHandle(h.id);
      if (!n) continue;
      const pid = { [n.kind === 'other' ? 'handle' : n.kind]: n.value };
      if (h.person_centric_id) pid.apple_person = String(h.person_centric_id);
      handleNode.set(h.ROWID, builder.node(n.key, { label: String(h.id).trim(), attrs: { handle_type: n.kind }, platformIds: pid }));
      builder.stat('handles');
    }

    // Chats and membership. Group = more than one chat_handle_join row (the spec
    // says chat.style 43/45 is unverified, so it is not used).
    const ccols = columns(db, 'chat');
    const chats = all(db, `SELECT ROWID, guid, chat_identifier, ${ccols.has('display_name') ? 'display_name' : 'NULL AS display_name'} FROM chat`);
    const members = new Map();
    for (const r of all(db, 'SELECT chat_id, handle_id FROM chat_handle_join')) {
      if (!members.has(r.chat_id)) members.set(r.chat_id, []);
      if (handleNode.has(r.handle_id)) members.get(r.chat_id).push(handleNode.get(r.handle_id));
    }
    const chatInfo = new Map(); // chat ROWID -> { ctx, group, other }
    for (const c of chats) {
      const mem = [...new Set(members.get(c.ROWID) || [])];
      const group = mem.length > 1 || (mem.length === 0 && /^chat\d+$/.test(c.chat_identifier || ''));
      if (group) {
        const name = (c.display_name && String(c.display_name).trim()) || mem.map(i => builder.nodes.labels[i]).join(', ') || c.chat_identifier;
        const ctx = builder.context(`${NS}:group_dm:${c.guid}`, { name, kind: 'group_dm', visibility: 'group', members: [ego, ...mem] });
        chatInfo.set(c.ROWID, { ctx, group: true, other: -1 });
      } else {
        // 1:1. The same person often has separate iMessage and SMS chats; the spec
        // says to merge on the participant set, so the context is keyed by handle.
        let other = mem[0];
        if (other === undefined) {
          const n = normalizeHandle(c.chat_identifier);
          other = n ? builder.node(n.key, { label: String(c.chat_identifier).trim(), attrs: { handle_type: n.kind } }) : -1;
        }
        const okey = other >= 0 ? builder.nodes.keys[other].slice(NS.length + 1) : c.guid;
        const ctx = builder.context(`${NS}:dm:${okey}`, { name: other >= 0 ? builder.nodes.labels[other] : c.chat_identifier, kind: 'dm', visibility: 'direct', members: other >= 0 ? [ego, other] : [ego] });
        chatInfo.set(c.ROWID, { ctx, group: false, other });
      }
      builder.stat('chats');
    }

    const mcols = columns(db, 'message');
    const sel = MESSAGE_COLS.map(c => (mcols.has(c) ? `m.${c}` : `NULL AS ${c}`)).join(', ');
    const missing = ['date', 'is_from_me', 'handle_id'].filter(c => !mcols.has(c));
    if (missing.length) throw new Error(`The message table lacks required columns: ${missing.join(', ')}.`);

    const orphans = db.exec('SELECT COUNT(*) FROM message WHERE ROWID NOT IN (SELECT message_id FROM chat_message_join)')[0].values[0][0];
    if (orphans) builder.warn('orphaned-messages', 'Messages not linked to any chat were skipped (they have no conversation to place them in).', orphans);

    // Pre-pass: who wrote each message (for reply and tapback targets), and the
    // final state of every tapback so a later removal (3000-3007) cancels the add.
    const author = new Map(); // guid -> node index
    const tapState = new Map(); // `${actor}|${parentGuid}|${kind}` -> rowid of the surviving add, or null
    {
      const st = db.prepare(`SELECT m.ROWID, m.guid, m.is_from_me, m.handle_id, ${mcols.has('associated_message_type') ? 'm.associated_message_type' : '0'} AS amt, ${mcols.has('associated_message_guid') ? 'm.associated_message_guid' : 'NULL'} AS amg FROM message m ORDER BY m.date, m.ROWID`);
      try {
        while (st.step()) {
          const r = st.getAsObject();
          const actor = r.is_from_me ? ego : (handleNode.get(r.handle_id) ?? -1);
          if (r.guid != null) author.set(String(r.guid), actor);
          const amt = r.amt || 0;
          if ((amt >= 2000 && amt <= 2007) || (amt >= 3000 && amt <= 3007)) {
            const k = `${actor}|${stripAssociatedGuid(r.amg)}|${amt % 1000}`;
            tapState.set(k, amt < 3000 ? r.ROWID : null);
          }
        }
      } finally { st.free(); }
    }

    const total = db.exec('SELECT COUNT(*) FROM chat_message_join')[0].values[0][0] || 1;
    const seen = new Set();
    const st = db.prepare(`SELECT ${sel}, cmj.chat_id AS chat_id FROM message m JOIN chat_message_join cmj ON cmj.message_id = m.ROWID ORDER BY m.date, m.ROWID`);
    const egoHandles = new Set();
    let done = 0;
    try {
      while (st.step()) {
        if ((++done & 1023) === 0) { signal?.throwIfAborted(); progress?.(0.1 + 0.85 * done / total, 'Reading messages'); }
        const r = st.getAsObject();
        const guid = r.guid != null ? String(r.guid) : `rowid-${r.ROWID}`;
        if (seen.has(guid)) continue; // a message joined to two chats
        seen.add(guid);
        const info = chatInfo.get(r.chat_id);
        if (!info) { builder.warn('unknown-chat', 'Messages pointing at a chat row that does not exist were skipped.'); continue; }
        const t = appleDateMs(r.date);
        if (Number.isNaN(t)) builder.warn('missing-date', 'Rows with a zero or empty date (usually system rows) have no time.');
        if (r.destination_caller_id && r.is_from_me) egoHandles.add(String(r.destination_caller_id));
        const actor = r.is_from_me ? ego : (handleNode.get(r.handle_id) ?? -1);
        const itemType = r.item_type || 0;
        const amt = r.associated_message_type || 0;

        // Group actions (item_type / group_action_type, per imessage-exporter group_action.rs).
        if (itemType !== 0) {
          const other = handleNode.get(r.other_handle) ?? -1;
          if (itemType === 1 && (r.group_action_type || 0) === 0 && other >= 0) {
            builder.event({ type: 'join', t, actor: other, context: info.ctx });
            builder.context(builder.contexts.keys[info.ctx], { members: [other] });
            builder.stat('joins');
          } else if (itemType === 1 && r.group_action_type === 1 && other >= 0) {
            builder.event({ type: 'leave', t, actor: other, context: info.ctx });
            builder.stat('leaves');
          } else if (itemType === 3 && (r.group_action_type || 0) === 0 && actor >= 0) {
            builder.event({ type: 'leave', t, actor, context: info.ctx });
            builder.stat('leaves');
          } else if (itemType === 2) {
            builder.stat('renames');
          } else {
            builder.stat('system-rows-skipped');
          }
          continue;
        }

        if (actor < 0) { builder.warn('unknown-sender', 'Incoming rows without a sender handle were skipped.'); continue; }

        // Tapbacks: 2000-2007 added, 3000-3007 removed. Reaction from the reactor to
        // the parent message's author.
        if ((amt >= 2000 && amt <= 2007) || (amt >= 3000 && amt <= 3007)) {
          if (amt >= 3000) { builder.stat('tapbacks-removed'); continue; }
          const pg = stripAssociatedGuid(r.associated_message_guid);
          if (tapState.get(`${actor}|${pg}|${amt % 1000}`) !== r.ROWID) { builder.stat('tapbacks-cancelled'); continue; }
          const subj = author.get(pg);
          if (subj === undefined) { builder.warn('tapback-parent-missing', 'Tapbacks whose message is not in the database were skipped (no way to know whom they reacted to).'); continue; }
          builder.event({ type: 'reaction', t, actor, targets: subj >= 0 ? [[subj, 'subject']] : [], context: info.ctx, key: `${NS}:msg:${guid}`, parentKey: `${NS}:msg:${pg}`, text: TAPBACK_NAMES[amt % 1000] });
          builder.stat('reactions');
          continue;
        }
        if (amt === 1000) {
          const pg = stripAssociatedGuid(r.associated_message_guid);
          const subj = author.get(pg);
          if (subj !== undefined) {
            builder.event({ type: 'reaction', t, actor, targets: subj >= 0 ? [[subj, 'subject']] : [], context: info.ctx, key: `${NS}:msg:${guid}`, parentKey: `${NS}:msg:${pg}`, text: 'sticker' });
            builder.stat('reactions');
          } else builder.warn('tapback-parent-missing', 'Tapbacks whose message is not in the database were skipped (no way to know whom they reacted to).');
          continue;
        }
        if (amt !== 0) builder.warn('unknown-associated-type', 'Rows with an unrecognised associated_message_type were read as ordinary messages.');

        let text = cleanText(r.text);
        if (text === null && r.attributedBody) {
          const dec = decodeAttributedBody(r.attributedBody);
          if (dec === null) builder.warn('attributed-body-undecoded', 'Some message bodies are stored only in attributedBody and could not be decoded; those messages are kept without text.');
          else builder.stat('attributed-body-decoded');
          text = cleanText(dec);
        }

        const targets = [];
        if (!info.group) {
          if (r.is_from_me) { if (info.other >= 0) targets.push([info.other, 'dm']); } else targets.push([ego, 'dm']);
        }
        let parentKey = null;
        if (r.thread_originator_guid) {
          const pg = String(r.thread_originator_guid);
          parentKey = `${NS}:msg:${pg}`;
          const pa = author.get(pg);
          if (pa !== undefined && pa >= 0) targets.push([pa, 'reply']);
          builder.stat('replies');
        }
        builder.event({ type: 'message', t, actor, targets, context: info.ctx, key: `${NS}:msg:${guid}`, parentKey, text });
        builder.stat('messages');
      }
    } finally { st.free(); }
    if (egoHandles.size) builder.node(EGO_KEY, { platformIds: { own_handles: [...egoHandles].sort().join(', ') } });
    progress?.(1, 'Done');
  } finally {
    db.close();
  }
}

// ---- imessage-exporter TXT import ------------------------------------------------

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const REPLY_MARKER = 'This message responded to an earlier message.';
// Tapback lines printed under a message: "{tapback} by {who}". Only recognised as
// the trailing lines of a block, so ordinary text such as "Liked by everyone" in
// the middle of a message is not misread.
const TAPBACK_LINE = /^(Loved|Liked|Disliked|Laughed at|Emphasized|Questioned) by (.+)$/;

// Parse one exported conversation file into blocks:
//   { kind: 'message', wall: [y,mo,d,h,mi,s], sender, lines[], reply, tapbacks[{name, who}] }
//   { kind: 'announcement', wall, text }
export function parseExporterTxt(text) {
  const ls = text.replace(/^﻿/, '').split(/\r?\n/);
  const blocks = [];
  let i = 0;
  while (i < ls.length) {
    const m = TXT_TS_RE.exec(ls[i]);
    if (!m) { i++; continue; }
    const mo = MONTHS[m[1]];
    let h = +m[4].trim() % 12;
    if (m[7] === 'PM') h += 12;
    const wall = [+m[3], mo, +m[2], h, +m[5], +m[6]];
    const rest = m[8];
    if (rest.trim() !== '' && !rest.startsWith(' (')) {
      blocks.push({ kind: 'announcement', wall, text: rest.trim() });
      i++;
      continue;
    }
    const sender = (ls[i + 1] ?? '').trim();
    let j = i + 2;
    const body = [];
    while (j < ls.length && !TXT_TS_RE.test(ls[j])) body.push(ls[j++]);
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const lines = body.map(l => l.trim());
    const tapbacks = [];
    while (lines.length > 1 && TAPBACK_LINE.test(lines[lines.length - 1])) {
      const t = TAPBACK_LINE.exec(lines.pop());
      tapbacks.unshift({ name: t[1].toLowerCase().replace(' at', ''), who: t[2].trim() });
    }
    // An optional "Tapbacks:" header line (layout not confirmed by the spec).
    if (tapbacks.length && lines[lines.length - 1] === 'Tapbacks:') lines.pop();
    const reply = lines.includes(REPLY_MARKER);
    blocks.push({ kind: 'message', wall, sender, lines: lines.filter(l => l !== REPLY_MARKER), reply, tapbacks });
    i = j;
  }
  return blocks;
}

function conversationName(rel) {
  const base = rel.split('/').pop().replace(/\.txt$/i, '');
  return base.replace(/ - \d+$/, ''); // named group chats get " - <chat rowid>"
}

async function importTxt(fs, entries, { builder, options, progress, signal }) {
  let tz = options?.timezone ?? 'unknown';
  if (tz !== 'unknown' && !isValidTimeZone(tz)) tz = 'unknown';
  builder.beginSource({ format: 'imessage', family: 'personal', medium: 'imessage', view: 'ego', context: 'personal', tz, fileNames: entries.map(e => e.rel), egoKey: EGO_KEY });
  if ((options?.timezone ?? 'unknown') !== tz) builder.warn('invalid-timezone', `"${options.timezone}" is not a known time zone name; times were read as UTC.`);
  if (tz === 'unknown') builder.warn('timezone-unknown', 'imessage-exporter writes local times without an offset. They were read as UTC; set the time zone of the computer that ran the export to correct them.');
  const ego = builder.node(EGO_KEY, { label: 'Me' });
  const byName = new Set();

  const person = who => {
    const w = who.trim();
    if (w === 'Me' || w === 'You') return ego;
    const n = normalizeHandle(w);
    if (n && n.kind !== 'other') return builder.node(n.key, { label: w, attrs: { handle_type: n.kind }, platformIds: { [n.kind]: n.value } });
    byName.add(nameKey(w));
    return builder.node(`${NS}:name:${nameKey(w)}`, { label: w });
  };

  for (let fi = 0; fi < entries.length; fi++) {
    signal?.throwIfAborted();
    progress?.(fi / entries.length, `Reading ${entries[fi].rel}`);
    const e = entries[fi];
    const blocks = parseExporterTxt(await e.text());
    const orphan = /(^|\/)orphaned\.txt$/i.test(e.rel);
    const name = conversationName(e.rel);

    // Threaded replies are printed twice (under the parent and in place): dedupe
    // on (time, sender, text) as the spec recommends.
    const seen = new Set();
    const msgs = [];
    for (const b of blocks) {
      const id = `${b.wall.join(',')}|${b.kind === 'message' ? b.sender : ''}|${b.kind === 'message' ? b.lines.join('\n') : b.text}`;
      if (seen.has(id)) { builder.stat('duplicate-thread-replies'); continue; }
      seen.add(id);
      msgs.push(b);
    }
    const senders = new Set(msgs.filter(b => b.kind === 'message').map(b => person(b.sender)));
    const hasAnnouncement = msgs.some(b => b.kind === 'announcement');
    const group = !orphan && (senders.size > 2 || hasAnnouncement || (senders.size === 2 && !senders.has(ego)));
    let ctx = -1;
    let other = -1;
    if (orphan) {
      ctx = builder.context(`${NS}:chat:txt/${name}`, { name: 'Messages without a conversation', kind: 'chat', visibility: 'unknown' });
    } else if (group) {
      ctx = builder.context(`${NS}:group_dm:txt/${name}`, { name, kind: 'group_dm', visibility: 'group', members: [ego, ...senders] });
    } else {
      other = [...senders].find(s => s !== ego) ?? person(name);
      ctx = builder.context(`${NS}:dm:txt/${name}`, { name, kind: 'dm', visibility: 'direct', members: [ego, other] });
    }
    builder.stat('chats');

    let n = 0;
    for (const b of msgs) {
      const t = zonedToUtc(b.wall[0], b.wall[1], b.wall[2], b.wall[3], b.wall[4], b.wall[5], 0, tz);
      if (b.kind === 'announcement') {
        let m;
        if ((m = /^(.+?) added (.+?) to the conversation\.$/.exec(b.text))) {
          const a = person(m[2]);
          builder.event({ type: 'join', t, actor: a, context: ctx });
          builder.context(builder.contexts.keys[ctx], { members: [a] });
          builder.stat('joins');
        } else if ((m = /^(.+?) removed (.+?) from the conversation\.$/.exec(b.text))) {
          builder.event({ type: 'leave', t, actor: person(m[2]), context: ctx });
          builder.stat('leaves');
        } else if ((m = /^(.+?) left the conversation\.$/.exec(b.text))) {
          builder.event({ type: 'leave', t, actor: person(m[1]), context: ctx });
          builder.stat('leaves');
        } else builder.stat('announcements-other');
        continue;
      }
      const actor = person(b.sender);
      const targets = [];
      if (!group && !orphan) targets.push(actor === ego ? [other, 'dm'] : [ego, 'dm']);
      const key = `${NS}:txt:${name}:${n++}`;
      if (b.reply) builder.warn('reply-parent-unknown', 'imessage-exporter marks replies ("This message responded to an earlier message.") but does not say which message; they are kept as plain messages.');
      builder.event({ type: 'message', t, actor, targets, context: ctx, key, text: cleanText(b.lines.join('\n')) });
      builder.stat('messages');
      for (const tb of b.tapbacks) {
        builder.event({ type: 'reaction', t, actor: person(tb.who), targets: [[actor, 'subject']], context: ctx, parentKey: key, text: tb.name });
        builder.stat('reactions');
      }
    }
  }
  if (byName.size) builder.warn('identity-by-name', 'Some senders appear only by contact name, so they are identified by display name (two contacts with the same name would merge).', byName.size);
  progress?.(1, 'Done');
}

// ---- entry point ------------------------------------------------------------------

async function importIMessage(fs, ctx) {
  const dbs = [];
  for (const e of dbCandidates(fs)) if (await sniffDb(e) >= 0.5) dbs.push(e);
  if (dbs.length) {
    const txts = txtCandidates(fs);
    for (const e of dbs) await importDb(fs, e, ctx);
    if (txts.length) ctx.builder.warn('txt-ignored', 'Text files next to the database were not imported (the database already holds the messages).', txts.length);
    return;
  }
  const txts = [];
  for (const e of txtCandidates(fs)) if (await sniffTxt(e)) txts.push(e);
  if (!txts.length) throw new Error('No Messages chat.db / sms.db and no imessage-exporter text files found.');
  await importTxt(fs, txts, ctx);
}

export default {
  id: 'imessage',
  label: 'iMessage / SMS (chat.db or imessage-exporter text)',
  family: 'personal',
  detect,
  options: [
    { key: 'timezone', label: 'Time zone of the computer that ran imessage-exporter (TXT only; chat.db times are exact)', type: 'timezone', default: 'unknown' },
  ],
  import: importIMessage,
};
