// Generic CSV/TSV import with a column mapper, plus the CSV reading helpers
// every other CSV-based importer uses (Purview Items.csv, Network Canvas,
// surveys, Gephi tables, profile join).
//
// Parsing is PapaParse. To stream big files we cut the byte stream into
// chunks of complete records ourselves (a newline ends a record only when the
// running count of double quotes is even, which is exactly RFC 4180's rule for
// quoted fields that contain newlines) and hand each chunk to Papa with the
// delimiter fixed from the first chunk.

import Papa from '../../vendor/papaparse.js';
import { lines, peek } from '../core/fileset.js';
import { EVENT_TYPES, ROLES, DatasetBuilder, VIEWS, DEFAULT_MODE_LABELS, declareTwoMode, addAffiliation } from '../core/model.js';

// ---- CSV helpers (shared) ---------------------------------------------------

const DELIMS = [',', ';', '\t', '|'];

// Pick the delimiter that splits the header line into the most fields,
// counting only delimiters outside quotes. Ties prefer comma.
export function sniffDelimiter(headLine) {
  let best = ',', bestN = 0;
  for (const d of DELIMS) {
    let n = 0, q = false;
    for (const c of headLine) { if (c === '"') q = !q; else if (!q && c === d) n++; }
    if (n > bestN) { best = d; bestN = n; }
  }
  return best;
}

// Whole-text parse. Returns { rows: string[][], delimiter }.
// Line endings are normalised first because Papa picks one linebreak per
// input and leaves stray \r on mixed files.
export function parseCSV(text, { delimiter } = {}) {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const d = delimiter || sniffDelimiter(t.slice(0, t.indexOf('\n') < 0 ? t.length : t.indexOf('\n')));
  const r = Papa.parse(t, { delimiter: d, skipEmptyLines: 'greedy' });
  return { rows: r.data, delimiter: d, errors: r.errors };
}

// Rows as objects keyed by the header row (duplicate headers get _2, _3 ...).
export function rowsToObjects(rows) {
  if (!rows.length) return { headers: [], records: [] };
  const headers = uniqueHeaders(rows[0]);
  const records = [];
  for (let i = 1; i < rows.length; i++) {
    const o = {};
    for (let j = 0; j < headers.length; j++) o[headers[j]] = rows[i][j] ?? '';
    records.push(o);
  }
  return { headers, records };
}

export function uniqueHeaders(h) {
  const seen = new Map();
  return h.map(x => {
    const k = String(x ?? '').trim();
    const n = (seen.get(k) || 0) + 1;
    seen.set(k, n);
    return n === 1 ? k : `${k}_${n}`;
  });
}

// Streaming: async iterator of string[] records from a byte stream.
export async function* csvRecords(stream, { delimiter, batchLines = 5000 } = {}) {
  let d = delimiter;
  let chunk = [];
  let pending = '';
  let quotes = 0;
  let count = 0;
  for await (const line of lines(stream)) {
    pending = pending ? pending + '\n' + line : line;
    for (let i = 0; i < line.length; i++) if (line.charCodeAt(i) === 34) quotes++;
    if (quotes % 2) continue; // inside a quoted field that spans lines
    quotes = 0;
    if (!d) d = sniffDelimiter(pending);
    chunk.push(pending); pending = '';
    if (++count >= batchLines) { yield* parseChunk(chunk, d); chunk = []; count = 0; }
  }
  if (pending) chunk.push(pending); // unbalanced quote at EOF: let Papa report it
  if (chunk.length) yield* parseChunk(chunk, d || ',');
}

function* parseChunk(chunk, d) {
  const r = Papa.parse(chunk.join('\n'), { delimiter: d, skipEmptyLines: 'greedy' });
  for (const row of r.data) yield row;
}

// Text of an entry, with a Windows-1252 fallback for Excel-saved CSVs that
// are not valid UTF-8 (the spec warns about these).
export async function entryText(entry) {
  const bytes = await entry.bytes();
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) return entry.text();
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^﻿/, ''); }
  catch { return new TextDecoder('windows-1252').decode(bytes); }
}

export async function headerRow(entry) {
  const head = await peek(entry, 8192);
  const first = head.replace(/^﻿/, '').split(/\r?\n/)[0] ?? '';
  return parseCSV(first).rows[0] ?? [];
}

// ---- time parsing ------------------------------------------------------------
//
// Spreadsheet timestamps come in many shapes. We never call Date.parse (its
// behaviour outside the strict ISO subset is implementation-defined); every
// accepted form is matched explicitly. Wall-clock times without a zone are
// interpreted in a chosen IANA zone (default UTC) and the source records that
// the zone was assumed.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2})(?:[.,](\d{1,9}))?)?\s*(Z|[+-]\d{2}:?\d{2}|UTC|GMT)?)?$/i;
const SLASH_RE = /^(\d{1,4})[/.-](\d{1,2})[/.-](\d{1,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?\s*([AaPp]\.?[Mm]\.?)?)?$/;

const dtfCache = new Map();
function zoneParts(tz, ms) {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    dtfCache.set(tz, f);
  }
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
}

export function isValidZone(tz) {
  if (!tz || tz === 'UTC') return true;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

// Wall-clock fields in zone tz -> epoch ms. For times that do not exist (spring
// forward) or exist twice (fall back) this picks the earlier valid offset, as
// most libraries do.
export function localToUtc(y, mo, d, h = 0, mi = 0, s = 0, ms = 0, tz = 'UTC') {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!tz || tz === 'UTC') return wall;
  const off1 = zoneParts(tz, wall - (wall % 1000)) - (wall - (wall % 1000));
  let t = wall - off1;
  const off2 = zoneParts(tz, t - (t % 1000)) - (t - (t % 1000));
  if (off2 !== off1) t = wall - off2;
  return t;
}

function fracMs(f) { return f ? Math.round(Number('0.' + f) * 1000) : 0; }
function hour12(h, ap) {
  if (!ap) return h;
  const pm = /^p/i.test(ap);
  if (h === 12) return pm ? 12 : 0;
  return pm ? h + 12 : h;
}
function validYMD(y, m, d) { return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1000; }

// format: 'iso' | 'ymd' (alias of iso) | 'mdy' | 'dmy' | 'epoch-s' | 'epoch-ms' | 'excel'
// Returns epoch ms or NaN.
export function parseTimestamp(raw, format = 'iso', tz = 'UTC') {
  if (raw == null) return NaN;
  const v = String(raw).trim();
  if (!v) return NaN;
  if (format === 'epoch-s' || format === 'epoch-ms') {
    if (!/^-?\d+(\.\d+)?$/.test(v)) return NaN;
    return format === 'epoch-s' ? Math.round(Number(v) * 1000) : Math.round(Number(v));
  }
  if (format === 'excel') {
    // Excel serial days since 1899-12-30 (the 1900 leap-year bug is absorbed by that epoch).
    if (!/^\d+(\.\d+)?$/.test(v)) return NaN;
    const days = Number(v);
    const whole = Math.floor(days);
    const msOfDay = Math.round((days - whole) * 86400000);
    const base = Date.UTC(1899, 11, 30) + whole * 86400000;
    const dt = new Date(base);
    return localToUtc(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate(), 0, 0, 0, 0, tz) + msOfDay;
  }
  let m = ISO_RE.exec(v);
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', s = '0', f, z] = m;
    if (!validYMD(+y, +mo, +d) || +h > 24 || +mi > 59 || +s > 60) return NaN;
    if (z) {
      const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s, fracMs(f));
      if (/^(Z|UTC|GMT)$/i.test(z)) return base;
      const sign = z[0] === '-' ? -1 : 1;
      const digits = z.slice(1).replace(':', '');
      return base - sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60000;
    }
    return localToUtc(+y, +mo, +d, +h, +mi, +s, fracMs(f), tz);
  }
  m = SLASH_RE.exec(v);
  if (m) {
    let [, a, b, c, h = '0', mi = '0', s = '0', f, ap] = m;
    let y, mo, d;
    if (a.length === 4) { y = +a; mo = +b; d = +c; }               // 2024/03/04
    else if (format === 'dmy') { d = +a; mo = +b; y = +c; }
    else { mo = +a; d = +b; y = +c; }                              // mdy default for slashes
    if (y < 100) y += y < 50 ? 2000 : 1900;
    if (!validYMD(y, mo, d)) return NaN;
    return localToUtc(y, mo, d, hour12(+h, ap), +mi, +s, fracMs(f), tz);
  }
  return NaN;
}

// Look at sample values and guess a format. Returns { format, confidence, zoned, note }.
export function detectTimeFormat(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(Boolean).slice(0, 200);
  if (!vals.length) return { format: null, confidence: 0 };
  if (vals.every(v => /^\d+(\.\d+)?$/.test(v))) {
    const nums = vals.map(Number);
    const min = Math.min(...nums), max = Math.max(...nums);
    // 1e9 s = 2001-09-09, 1e10 s = 2286; 1e12 ms = 2001-09-09.
    if (min >= 1e12 && max < 1e14) return { format: 'epoch-ms', confidence: 0.9, zoned: true };
    if (min >= 3e8 && max < 1e10) return { format: 'epoch-s', confidence: 0.85, zoned: true };
    if (min >= 20000 && max < 80000) return { format: 'excel', confidence: 0.4, zoned: false, note: 'Numbers look like Excel serial dates; check before relying on them.' };
    return { format: null, confidence: 0 };
  }
  const iso = vals.filter(v => ISO_RE.test(v));
  if (iso.length === vals.length) {
    return { format: 'iso', confidence: 0.95, zoned: iso.every(v => /(Z|[+-]\d{2}:?\d{2}|UTC|GMT)$/i.test(v)) };
  }
  const sl = vals.map(v => SLASH_RE.exec(v));
  if (sl.every(Boolean)) {
    if (sl.every(m => m[1].length === 4)) return { format: 'iso', confidence: 0.8, zoned: false };
    const firstBig = sl.some(m => +m[1] > 12), secondBig = sl.some(m => +m[2] > 12);
    if (firstBig && !secondBig) return { format: 'dmy', confidence: 0.9, zoned: false };
    if (secondBig && !firstBig) return { format: 'mdy', confidence: 0.9, zoned: false };
    if (firstBig && secondBig) return { format: null, confidence: 0 };
    const dots = sl.every((m, i) => vals[i].includes('.'));
    return { format: dots ? 'dmy' : 'mdy', confidence: 0.4, zoned: false, note: 'Day and month cannot be told apart in these samples (no value above 12); check the format.' };
  }
  return { format: null, confidence: 0 };
}

// ---- column mapper -------------------------------------------------------------
//
// A mapping names which column plays which role:
//   { actor, targets, targetSeparator, timestamp, timeFormat, timezone, context,
//     text, weight, type, directed, id, label, attrs[], namespace, role, eventType }
// kind 'events'  one row = one event (actor -> targets at a time)
//      'edges'   one row = one declared tie (source -> target, weight)
//      'nodes'   one row = one person (id, label, attributes)
//      'affiliations'  two-mode incidence list: one row = one person's
//                membership of one event / group (actor, targets = the event
//                column, optional weight, timestamp; targetSeparator splits a
//                list of events), mapping.modeLabels = [people, events]
//      'incidence'  two-mode incidence matrix: one row per person (actor =
//                the row-name column), mapping.events = the event columns,
//                a cell's number is the tie's weight (blank or 0 = none;
//                x / yes / true = 1), attrs = person attributes
// Two-mode kinds write affiliations (addAffiliation): people keep the key
// `<namespace>:<value>`, events get `<namespace>:event:<value>` so an event
// named like a person stays a separate node.
// Header aliases extend the list in docs/formats/network-files.md section 6
// (our convention, not a standard) with common message-log names.

const ALIASES = {
  actor: ['source', 'from', 'sender', 'ego', 'src', 'node1', 'actor', 'i', 'u', 'author', 'user', 'username', 'user_id', 'userid', 'speaker', 'poster', 'respondent', 'from_id', 'sender_id', 'source_id'],
  targets: ['target', 'to', 'receiver', 'recipient', 'recipients', 'alter', 'dst', 'node2', 'j', 'v', 'mentions', 'addressee', 'to_id', 'target_id', 'receiver_id', 'recipient_id', 'nominee', 'alters'],
  timestamp: ['time', 'timestamp', 'date', 'datetime', 'created_at', 'created', 'sent', 'sent_at', 'ts', 'time_stamp', 'date_time', 'when', 'start', 'start_time'],
  context: ['channel', 'thread', 'conversation', 'conversation_id', 'room', 'group', 'context', 'chat', 'chat_id', 'channel_id', 'thread_id', 'team', 'meeting'],
  text: ['text', 'message', 'body', 'content', 'msg', 'comment', 'subject'],
  weight: ['weight', 'value', 'count', 'n', 'strength', 'frequency', 'freq', 'score', 'rating'],
  type: ['type', 'relation', 'tie', 'kind', 'event', 'event_type', 'relationship', 'tie_type'],
  directed: ['directed', 'direction', 'is_directed'],
  id: ['id', 'node', 'node_id', 'key', 'person', 'person_id', 'employee_id', 'email', 'name', 'uid'],
  label: ['label', 'name', 'full_name', 'fullname', 'display_name', 'displayname'],
};

const norm = h => String(h ?? '').trim().toLowerCase().replace(/[\s.-]+/g, '_');
const OTHER_PERSON = /(^|_)(manager|supervisor|boss|reports_?to|line_?manager|mentor|parent|lead_by|approver)(_|$)/;

function headerScore(h, role) {
  const n = norm(h);
  const list = ALIASES[role];
  if (list.includes(n)) return 0.9;
  // Prefix/suffix forms like "sender_email", "message_text", "recipient list".
  if (list.some(a => a.length > 2 && (n.startsWith(a + '_') || n.endsWith('_' + a)))) return 0.6;
  return 0;
}

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function profileColumn(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(Boolean);
  const n = vals.length || 1;
  const numeric = vals.filter(v => /^-?\d+([.,]\d+)?$/.test(v)).length / n;
  const avgLen = vals.reduce((s, v) => s + v.length, 0) / n;
  const listSep = [';', '|', ','].find(sep => vals.filter(v => v.includes(sep) && v.split(sep).every(p => p.trim() && p.trim().length < 60 && !/\s{2,}/.test(p))).length / n > 0.2) || null;
  const emails = vals.filter(v => EMAIL.test(v)).length / n;
  const distinct = new Set(vals).size;
  const time = detectTimeFormat(vals);
  const bool = vals.every(v => /^(true|false|yes|no|0|1|directed|undirected)$/i.test(v));
  return { count: vals.length, numeric, avgLen, listSep, emails, distinct, time, bool };
}

// headers: string[]; sampleRows: string[][] (data rows, no header).
// Returns { kind, mapping, columns: [{ header, role, confidence, reason }], notes[] }.
export function suggestMapping(headers, sampleRows = []) {
  const cols = headers.map((h, j) => ({ header: h, prof: profileColumn(sampleRows.map(r => r[j])) }));
  const two = suggestTwoMode(headers, cols, sampleRows);
  if (two) return two;
  const notes = [];
  const taken = new Set();
  const pick = (role, extra = () => 0) => {
    let best = null, bestS = 0;
    for (const c of cols) {
      if (taken.has(c.header)) continue;
      const s = Math.min(1, headerScore(c.header, role) + extra(c));
      if (s > bestS) { best = c; bestS = s; }
    }
    if (best && bestS >= 0.3) { taken.add(best.header); return { col: best, confidence: +bestS.toFixed(2) }; }
    return null;
  };
  const roles = {};
  // Order matters: specific roles first so generic ones (id, label) do not steal them.
  roles.timestamp = pick('timestamp', c => (c.prof.time.format ? 0.5 * c.prof.time.confidence : 0));
  roles.actor = pick('actor');
  roles.targets = pick('targets', c => (c.prof.listSep ? 0.1 : 0));
  roles.weight = pick('weight', c => (c.prof.numeric > 0.95 && headerScore(c.header, 'weight') ? 0.1 : 0));
  roles.text = pick('text', c => (c.prof.avgLen > 30 ? 0.35 : 0));
  roles.context = pick('context');
  roles.type = pick('type');
  roles.directed = pick('directed', c => (c.prof.bool && headerScore(c.header, 'directed') ? 0.1 : 0));
  // A "Type" column holding Directed/Undirected is Gephi's directedness flag, not a tie type.
  if (roles.type && !roles.directed) {
    const j = headers.indexOf(roles.type.col.header);
    const vals = sampleRows.map(r => String(r[j] ?? '').trim()).filter(Boolean);
    if (vals.length && vals.every(v => /^(directed|undirected|mutual)$/i.test(v))) { roles.directed = roles.type; delete roles.type; }
  }

  let kind;
  if (roles.actor && roles.targets) kind = roles.timestamp || roles.text || roles.context ? 'events' : 'edges';
  else {
    kind = 'nodes';
    // Undo event-ish picks that make no sense for a node table.
    for (const r of ['actor', 'targets', 'timestamp', 'text', 'context', 'type', 'directed']) if (roles[r]) { taken.delete(roles[r].col.header); delete roles[r]; }
    delete roles.weight; taken.clear();
    // A column that names someone else (manager, mentor) is never the row's
    // own id or name, however name-like its header. Among id candidates a
    // unique email column wins: it is what other sources can be matched on.
    const other = c => (OTHER_PERSON.test(norm(c.header)) ? -1 : 0);
    const unique = c => c.prof.distinct === c.prof.count && c.prof.count;
    roles.id = pick('id', c => (unique(c) ? 0.2 : 0) + (unique(c) && c.prof.emails > 0.9 ? 0.35 : 0) + other(c));
    roles.label = pick('label', other);
    for (const c of cols) if (OTHER_PERSON.test(norm(c.header))) notes.push(`"${c.header}" names another person; it is kept as an attribute, not used as this row's id or name.`);
    if (!roles.id && cols.length) {
      const c = cols.find(c => c.prof.distinct === c.prof.count && c.prof.count) || cols[0];
      taken.add(c.header); roles.id = { col: c, confidence: 0.3 };
      notes.push(`No obvious id column; using "${c.header}".`);
    }
  }

  const mapping = { namespace: 'csv' };
  const columns = [];
  for (const [role, r] of Object.entries(roles)) {
    if (!r) continue;
    mapping[role] = r.col.header;
    columns.push({ header: r.col.header, role, confidence: r.confidence, reason: headerScore(r.col.header, role) ? 'header name' : 'values' });
  }
  if (mapping.targets) {
    const sep = cols.find(c => c.header === mapping.targets).prof.listSep;
    if (sep) { mapping.targetSeparator = sep; notes.push(`"${mapping.targets}" holds lists separated by "${sep}"; each entry becomes a target.`); }
  }
  if (mapping.timestamp) {
    const tf = cols.find(c => c.header === mapping.timestamp).prof.time;
    mapping.timeFormat = tf.format || 'iso';
    mapping.timezone = 'UTC';
    if (tf.note) notes.push(tf.note);
    if (tf.format && !tf.zoned) notes.push('Times have no time zone; they are read as UTC unless you choose a zone.');
  }
  if (kind === 'nodes' || kind === 'events') {
    mapping.attrs = kind === 'nodes' ? headers.filter(h => !taken.has(h)) : [];
  }
  if (kind === 'edges') { mapping.role = 'declared'; mapping.eventType = 'declared'; }
  if (kind === 'events') { mapping.role = 'to'; mapping.eventType = 'message'; }
  const idCol = mapping.actor || mapping.id;
  if (idCol) {
    const c = cols.find(c => c.header === idCol);
    if (c.prof.emails > 0.9) notes.push(`"${idCol}" holds email addresses; they are stored as the email attribute so they can be matched to mailbox data.`);
  }
  for (const c of cols) if (!taken.has(c.header) && !(mapping.attrs || []).includes(c.header)) columns.push({ header: c.header, role: 'ignore', confidence: 0, reason: 'no role matched' });
  return { kind, mapping, columns, notes };
}

// ---- two-mode tables ------------------------------------------------------------

// Columns naming what people belong to or attend (incidence lists).
const EVENTISH = /^(events?|event_(name|id)|groups?|group_(name|id)|clubs?|organi[sz]ations?|org|affiliations?|boards?|committees?|courses?|class(es)?|projects?|meetings?|parties|party|venues?|activit(y|ies)|memberships?)$/;
const PERSONISH = /^(person|people|member|members|actor|actors|name|participant|attendee|student|director|employee|woman|women|man|men|person_id|member_id|user|individual)$/;
const BINARY_CELL = /^(0|1|0\.0|1\.0|x|yes|no|true|false)$/i;
// Mode labels name a kind of node in the plural ("Students", "Clubs"), as
// the views count them: "5 students, 3 clubs".
const modeLabel = (h, k) => {
  let t = String(h ?? '').trim().replace(/[_-]+/g, ' ');
  if (!t || /^(id|name|key|label)$/i.test(t)) return DEFAULT_MODE_LABELS[k];
  if (/^person$/i.test(t)) t = 'people';
  else if (/[^aeiou]y$/i.test(t)) t = t.slice(0, -1) + 'ies';
  else if (/(s|x|ch|sh)$/i.test(t)) t = /s$/i.test(t) ? t : t + 'es';
  else if (!/(people|men|women|children)$/i.test(t)) t += 's';
  return t.charAt(0).toUpperCase() + t.slice(1);
};

// Two-mode shapes, recognised before the one-mode roles:
//   incidence matrix: a first column of distinct names, then two or more
//     columns holding only 0/1 (or x / yes) cells
//   incidence list: a person-like column whose values repeat and an
//     event-like column (event, group, club, committee, ...)
// Returns a suggestMapping result or null.
function suggestTwoMode(headers, cols, rows) {
  if (!rows.length || headers.length < 2) return null;
  const first = cols[0];
  const rest = cols.slice(1);
  if (rest.length >= 2 && first.prof.count >= 2 && first.prof.distinct === first.prof.count && first.prof.numeric < 0.5) {
    // Event columns hold only 0/1 (x / yes) cells; other columns (a year, a
    // team) are attributes of the row. Most columns must be event columns.
    const isEvent = rest.map((c, j) => rows.every(r => { const v = String(r[j + 1] ?? '').trim(); return v === '' || BINARY_CELL.test(v); }) && !OTHER_PERSON.test(norm(c.header)));
    const evH = headers.slice(1).filter((_, j) => isEvent[j]), attrH = headers.slice(1).filter((_, j) => !isEvent[j]);
    const ones = rows.some(r => r.slice(1).some((v, j) => isEvent[j] && /^(1|1\.0|x|yes|true)$/i.test(String(v ?? '').trim())));
    if (evH.length >= 2 && evH.length > attrH.length && ones) {
      return {
        kind: 'incidence',
        mapping: { namespace: 'csv', actor: headers[0], events: evH, attrs: attrH, modeLabels: [modeLabel(headers[0], 0), DEFAULT_MODE_LABELS[1]] },
        columns: [{ header: headers[0], role: 'actor', confidence: 0.7, reason: 'values' }, ...evH.map(h => ({ header: h, role: 'event', confidence: 0.7, reason: 'values' })), ...attrH.map(h => ({ header: h, role: 'attr', confidence: 0.5, reason: 'values' }))],
        notes: [`Looks like a two-mode incidence matrix: one row per "${headers[0]}", one column per event or group; a 1 means the row belongs to that event or group.`],
      };
    }
  }
  const ev = cols.find(c => EVENTISH.test(norm(c.header)));
  const actor = cols.find(c => c !== ev && (PERSONISH.test(norm(c.header)) || headerScore(c.header, 'actor') >= 0.9 || headerScore(c.header, 'id') >= 0.9));
  if (ev && actor && actor.prof.count >= 2 && actor.prof.distinct < actor.prof.count) {
    const mapping = { namespace: 'csv', actor: actor.header, targets: ev.header, modeLabels: [modeLabel(actor.header, 0), modeLabel(ev.header, 1)] };
    const columns = [{ header: actor.header, role: 'actor', confidence: 0.7, reason: 'header name' }, { header: ev.header, role: 'targets', confidence: 0.7, reason: 'header name' }];
    // Weight: a weight-like header, else the one all-numeric column (hours, days attended).
    const nums = cols.filter(c => c !== ev && c !== actor && c.prof.numeric > 0.95 && c.prof.count);
    const w = nums.find(c => headerScore(c.header, 'weight')) || (nums.length === 1 ? nums[0] : null);
    if (w) { mapping.weight = w.header; columns.push({ header: w.header, role: 'weight', confidence: 0.6, reason: 'header name' }); }
    const t = cols.find(c => c !== ev && c !== actor && c !== w && c.prof.time.format);
    if (t) { mapping.timestamp = t.header; mapping.timeFormat = t.prof.time.format; mapping.timezone = 'UTC'; columns.push({ header: t.header, role: 'timestamp', confidence: 0.6, reason: 'values' }); }
    if (ev.prof.listSep) mapping.targetSeparator = ev.prof.listSep;
    for (const c of cols) if (!columns.some(x => x.header === c.header)) columns.push({ header: c.header, role: 'ignore', confidence: 0, reason: 'no role matched' });
    return { kind: 'affiliations', mapping, columns, notes: [`Looks like a two-mode list: each row says that a "${actor.header}" belongs to or attended a "${ev.header}".`] };
  }
  return null;
}

const TWO_MODE_KINDS = new Set(['affiliations', 'incidence']);

// One row of a two-mode table -> affiliations.
function cellWeight(v) {
  const s = String(v ?? '').trim();
  if (!s || /^(no|false)$/i.test(s)) return 0;
  if (/^(x|yes|true)$/i.test(s)) return 1;
  const n = Number(s.replace(/^(-?\d+),(\d+)$/, '$1.$2'));
  return Number.isFinite(n) ? n : NaN;
}

// ---- import -----------------------------------------------------------------

const DIRECTED_FALSE = /^(undirected|false|no|0|mutual)$/i;

function typedValue(v) {
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s) && Number.isFinite(Number(s))) return Number(s);
  if (/^(true|false)$/i.test(s)) return /^t/i.test(s);
  return s;
}

function splitTargets(v, sep) {
  if (!sep) return [v];
  return v.split(sep).map(x => x.trim()).filter(Boolean);
}

// Import one table into a builder. Returns the number of rows read.
// opts: { builder, mapping, kind, fileName, rows (string[][] incl. header) | stream, progress, signal }
async function importTable({ builder, mapping, kind, fileName, records, signal }) {
  const m = mapping;
  const ns = m.namespace || 'csv';
  const nodeFor = (raw) => {
    const v = String(raw ?? '').trim();
    if (!v) return -1;
    const attrs = EMAIL.test(v) ? { email: v.toLowerCase() } : undefined;
    return builder.node(`${ns}:${v}`, { label: v, attrs });
  };
  let headers = null, idx = {};
  let rowsRead = 0, skipped = 0, badTime = 0, undirected = 0, directed = 0;
  const ctxDefault = builder.context(`${ns}:file:${fileName}`, { name: fileName, kind: kind === 'edges' || TWO_MODE_KINDS.has(kind) ? 'network' : 'channel', visibility: 'unknown' });
  const twoMode = TWO_MODE_KINDS.has(kind);
  let eventCols = null;
  if (twoMode) {
    declareTwoMode(builder, [0, 1].map(k => m.modeLabels?.[k] || DEFAULT_MODE_LABELS[k]));
    builder.source.directed = false;
  }
  const actorKey = v => `${ns}:${v}`, eventKey = v => `${ns}:event:${v}`;
  for await (const row of records) {
    if (!headers) {
      headers = uniqueHeaders(row);
      for (const [k, v] of Object.entries(m)) if (typeof v === 'string') idx[k] = headers.indexOf(v);
      if (kind === 'incidence') {
        eventCols = (m.events || []).map(h => [h, headers.indexOf(h)]).filter(([, j]) => j >= 0 && j !== idx.actor);
        if (!eventCols.length) throw new Error(`No event columns of ${fileName} are mapped. Columns: ${headers.join(', ')}`);
      }
      for (const need of kind === 'nodes' ? ['id'] : kind === 'incidence' ? ['actor'] : ['actor', 'targets']) {
        if (!(idx[need] >= 0)) throw new Error(`Column "${m[need]}" (mapped as ${need}) is not in ${fileName}. Columns: ${headers.join(', ')}`);
      }
      continue;
    }
    if (signal?.aborted) throw new Error('Import cancelled.');
    rowsRead++;
    const cell = k => (idx[k] >= 0 ? String(row[idx[k]] ?? '').trim() : '');
    if (kind === 'incidence') {
      const who = cell('actor');
      if (!who) { skipped++; continue; }
      const attrs = {};
      for (const a of m.attrs || []) { const j = headers.indexOf(a); if (j >= 0 && String(row[j] ?? '').trim() !== '') attrs[a] = typedValue(row[j]); }
      const label = cell('label') || who;
      for (const [h, j] of eventCols) {
        const w = cellWeight(row[j]);
        if (Number.isNaN(w)) { skipped++; continue; }
        if (!w) continue;
        addAffiliation(builder, actorKey(who), eventKey(h), { weight: w, actorLabel: label, eventLabel: h, actorAttrs: attrs, context: ctxDefault });
        builder.stat('affiliations');
      }
      // People with no membership still belong to the network (isolates).
      addAffiliationNode(builder, actorKey(who), 0, label, attrs);
      for (const [h] of eventCols) addAffiliationNode(builder, eventKey(h), 1, h);
      builder.stat('nodes');
      continue;
    }
    if (kind === 'affiliations') {
      const who = cell('actor'), what = cell('targets');
      if (!who || !what) { skipped++; continue; }
      let t = NaN;
      if (idx.timestamp >= 0 && cell('timestamp')) { t = parseTimestamp(cell('timestamp'), m.timeFormat || 'iso', m.timezone || 'UTC'); if (Number.isNaN(t)) badTime++; }
      let w = 1;
      if (idx.weight >= 0 && cell('weight') !== '') { w = cellWeight(cell('weight')); if (Number.isNaN(w)) { skipped++; continue; } if (!w) { builder.stat('zero-weight-rows'); continue; } }
      for (const e of splitTargets(what, m.targetSeparator)) {
        addAffiliation(builder, actorKey(who), eventKey(e), { weight: w, t, actorLabel: who, eventLabel: e, context: ctxDefault });
        builder.stat('affiliations');
      }
      continue;
    }
    if (kind === 'nodes') {
      const id = cell('id');
      if (!id) { skipped++; continue; }
      const attrs = {};
      for (const a of m.attrs || []) {
        const j = headers.indexOf(a);
        if (j >= 0 && String(row[j] ?? '').trim() !== '') attrs[a] = typedValue(row[j]);
      }
      if (EMAIL.test(id)) attrs.email = id.toLowerCase();
      builder.node(`${ns}:${id}`, { label: cell('label') || id, attrs });
      builder.stat('nodes');
      continue;
    }
    const a = nodeFor(cell('actor'));
    const tv = cell('targets');
    if (a < 0 || !tv) { skipped++; continue; }
    let t = NaN;
    if (idx.timestamp >= 0 && cell('timestamp')) {
      t = parseTimestamp(cell('timestamp'), m.timeFormat || 'iso', m.timezone || 'UTC');
      if (Number.isNaN(t)) badTime++;
    }
    let w = 1;
    if (idx.weight >= 0 && cell('weight') !== '') {
      const n = Number(cell('weight').replace(',', '.'));
      if (!Number.isFinite(n)) { skipped++; continue; }
      w = n;
      if (n === 0 && kind === 'edges') { builder.stat('zero-weight-rows'); continue; }
    }
    let type = m.eventType || (kind === 'edges' ? 'declared' : 'message');
    let role = m.role || (kind === 'edges' ? 'declared' : 'to');
    let ctx = ctxDefault;
    const ty = cell('type');
    if (ty) {
      const low = ty.toLowerCase();
      if (EVENT_TYPE_SET.has(low)) type = low;
      else if (ROLE_SET.has(low)) role = low;
      else ctx = builder.context(`${ns}:rel:${fileName}#${ty}`, { name: `${fileName} / ${ty}`, kind: kind === 'edges' ? 'network' : 'channel', visibility: 'unknown' });
    }
    if (idx.context >= 0 && cell('context')) {
      const c = cell('context');
      ctx = builder.context(`${ns}:ctx:${c}`, { name: c, kind: 'channel', visibility: 'unknown' });
    }
    if (idx.directed >= 0) { if (DIRECTED_FALSE.test(cell('directed'))) undirected++; else directed++; }
    const targets = splitTargets(tv, m.targetSeparator).map(x => [nodeFor(x), role]).filter(([n]) => n >= 0);
    if (targets.length === 1 && targets[0][0] === a) builder.stat('self-loops');
    builder.event({ type, t, actor: a, targets, context: ctx, weight: w, text: idx.text >= 0 ? (cell('text') || null) : null });
    builder.stat(kind === 'edges' ? 'edges' : 'events');
  }
  if (!headers) builder.warn('empty-file', `${fileName} has no rows.`);
  if (skipped) builder.warn('rows-skipped', kind === 'incidence' ? 'Rows without a name, or cells that are not a number (or x / yes), were skipped.' : `Rows with an empty ${kind === 'nodes' ? 'id' : kind === 'affiliations' ? 'person or event' : 'source or target'} or a non-numeric weight were skipped.`, skipped);
  if (badTime) builder.warn('bad-timestamps', `Timestamps that did not match the chosen format (${m.timeFormat || 'iso'}) were left unknown.`, badTime);
  if (undirected && directed) builder.warn('mixed-directedness', 'Some rows are marked undirected and some directed; each row is stored as written (source to target).', undirected);
  if (!twoMode) builder.source.directed = undirected && !directed ? false : builder.source.directed;
  builder.stat('rows', rowsRead);
  return rowsRead;
}

const EVENT_TYPE_SET = new Set(EVENT_TYPES);
const ROLE_SET = new Set(ROLES);

const TABLE_RE = /\.(csv|tsv|tab|txt)$/i;
const SHEET_RE = /\.(xlsx|xlsm|xls|ods|numbers)$/i;

// Public: import every CSV/TSV in fs with one mapping. Without a builder,
// returns a built Dataset; with one, writes into it and returns null.
export async function importTabular(fs, { mapping, kind, builder, files, progress, signal, view } = {}) {
  const own = !builder;
  const b = builder || new DatasetBuilder({ name: 'Spreadsheet import' });
  const entries = (files ? files.map(f => fs.get(f)).filter(Boolean) : fs.entries.filter(e => TABLE_RE.test(e.rel)));
  if (!entries.length) throw new Error('No CSV or TSV files to import.');
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    let map = mapping, k = kind;
    if (!map) {
      const head = await sampleRows(e);
      const s = suggestMapping(head[0] || [], head.slice(1));
      map = s.mapping; k = k || s.kind;
      b.beginSource(sourceInfo(e, k, view));
      b.warn('auto-mapping', `No column mapping was chosen, so one was guessed (${k}: ${Object.entries(map).filter(([, v]) => typeof v === 'string' && v !== 'csv').map(([r, c]) => `${r}=${c}`).join(', ')}). Check it in the column mapper.`);
    } else {
      k = k || 'events';
      b.beginSource(sourceInfo(e, k, view));
    }
    if (map.timestamp && (!map.timezone || map.timezone === 'UTC')) b.source.tz = 'assumed UTC';
    else if (map.timezone) b.source.tz = map.timezone;
    if (map.timezone && !isValidZone(map.timezone)) throw new Error(`Unknown time zone "${map.timezone}".`);
    const delimiter = /\.(tsv|tab)$/i.test(e.rel) ? '\t' : undefined;
    await importTable({ builder: b, mapping: map, kind: k, fileName: e.rel, records: csvRecords(e.stream(), { delimiter }), signal });
    progress?.((i + 1) / entries.length, `Read ${e.rel}`);
  }
  return own ? b.build() : null;
}

// A node of a known mode without a tie (an incidence-matrix row of zeros).
function addAffiliationNode(builder, key, mode, label, attrs) {
  builder.node(key, { label, attrs: { ...(attrs || {}), bipartite: mode } });
}

function sourceInfo(e, kind, view) {
  return {
    format: 'tabular', family: 'tabular', medium: kind === 'edges' || TWO_MODE_KINDS.has(kind) ? 'declared' : 'unknown',
    view: view || VIEWS.FULL, context: 'custom', tz: 'UTC', fileNames: [e.rel], tableKind: kind,
  };
}

// First rows of an entry (header + up to n data rows), for the mapper UI.
export async function sampleRows(entry, n = 50) {
  const head = await peek(entry, 65536);
  const cut = head.lastIndexOf('\n');
  const text = cut > 0 && head.length >= 65536 ? head.slice(0, cut) : head;
  const delimiter = /\.(tsv|tab)$/i.test(entry.rel || '') ? '\t' : undefined;
  return parseCSV(text, { delimiter }).rows.slice(0, n + 1);
}

export default {
  id: 'tabular',
  label: 'Spreadsheet (CSV or TSV) with a column mapper',
  family: 'tabular',
  // Low score on purpose: any CSV qualifies, so specific importers win and this is the fallback.
  async detect(fs) {
    const sheets = fs.entries.filter(e => SHEET_RE.test(e.rel));
    const tables = fs.entries.filter(e => TABLE_RE.test(e.rel) && e.size > 0);
    const csv = [];
    for (const e of tables.slice(0, 200)) {
      const head = await peek(e, 2048);
      const line = head.split(/\r?\n/)[0] || '';
      // A table needs a delimiter on the first line; prose .txt files do not qualify.
      if (/[,;\t|]/.test(line) && !/^\s*(\{|\[|<|BEGIN:|From |\*vertices|dl\b|graph\s*\[)/i.test(head)) csv.push(e.rel);
    }
    if (csv.length) return { score: 0.2, reason: `${csv.length} delimited table file(s); map the columns yourself if no specific importer fits.`, files: csv };
    if (sheets.length) return { score: 0.5, reason: 'Excel or other spreadsheet workbook: save each sheet as CSV (File > Save As > CSV UTF-8) and import that.', files: sheets.map(e => e.rel) };
    return { score: 0, reason: '' };
  },
  options: [
    { key: 'mapping', label: 'Column mapping', type: 'mapping', default: null },
    { key: 'kind', label: 'Each row is', type: 'choice', default: null, choices: [{ value: 'events', label: 'An event (message, meeting)' }, { value: 'edges', label: 'A tie between two people' }, { value: 'nodes', label: 'A person' }, { value: 'affiliations', label: 'A person and an event or group they belong to (two-mode list)' }, { value: 'incidence', label: 'A person, with one column per event or group (two-mode matrix)' }] },
    { key: 'view', label: 'Who the table covers', type: 'choice', default: 'full', choices: [{ value: 'full', label: 'Everyone in a bounded group' }, { value: 'ego', label: "One person's contacts" }, { value: 'sample', label: 'A sample of a larger group' }] },
  ],
  async import(fs, { builder, options = {}, progress, signal }) {
    const det = await this.detect(fs);
    const sheets = fs.entries.filter(e => SHEET_RE.test(e.rel));
    const files = det.score === 0.2 ? det.files : [];
    if (!files.length && sheets.length) {
      builder.beginSource({ format: 'tabular', family: 'tabular', view: VIEWS.FULL, fileNames: sheets.map(e => e.rel) });
      builder.warn('spreadsheet-unsupported', 'Workbook files (.xlsx, .xls, .ods, .numbers) cannot be read directly. Open the file and save each sheet as CSV (UTF-8), then import the CSV files.', sheets.length);
      return;
    }
    if (!files.length) throw new Error('No delimited table files found.');
    await importTabular(fs, { mapping: options.mapping || null, kind: options.kind || null, builder, files, progress, signal, view: options.view });
  },
};
