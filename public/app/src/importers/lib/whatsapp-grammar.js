// WhatsApp "Export chat" text grammar (docs/formats/whatsapp.md section 2-3).
//
// Pure functions, no model access, so the grammar can be tested line by line.
// The header regex and the day/month inference are ports of
// whatsapp-chat-parser v4 (MIT, src/parser.ts, src/date.ts, src/time.ts) and
// are checked against its 12 format fixtures in test/importers-b/whatsapp.test.js.
// Our additions over the reference parser, each from the spec:
//   - leading U+FEFF and U+200B-U+200D are stripped at every line start (stray
//     BOMs mid-file, whatstk), not only U+200E/U+200F;
//   - German day-period words as AM/PM alternatives (WhatsR; UNVERIFIED beyond DE);
//   - body classification (omitted media, attachments, deleted, edited, calls,
//     polls, locations) and system-message recognition, including the 2024+ iOS
//     style where the author slot holds the group/contact name or the affected person.

// Header. Groups: 1 date, 2 time, 3 am/pm word. Same as the reference regex,
// with the AM/PM alternative widened (see above).
const SHARED = String.raw`^(?:‎|‏)*\[?(\d{1,4}[-/.]\s?\d{1,4}[-/.]\s?\d{1,4})[,.]?\s\D*?(\d{1,2}[.:]\d{1,2}(?:[.:]\d{1,2})?)(?:\s([ap]\.?\s?m\.?|morgens|vorm\.|mittags|nachm\.|abends|nachts))?\]?(?:\s-|:)?\s`;
export const HEADER_RE = new RegExp(SHARED, 'i');
const USER_RE = new RegExp(SHARED + String.raw`(.+?):\s([^]*)`, 'i');
const SYSTEM_RE = new RegExp(SHARED + String.raw`([^]+)`, 'i');

// Invisible marks that may lead a line (BOM anywhere at line start, zero-width
// space/joiners). U+200E/U+200F are left for the header regex, which allows them.
const LEAD_JUNK = /^[﻿​-‍]+/;
// Everything invisible we remove from names and from text used for classification.
const INVISIBLE = /[﻿​-‏⁨⁩]/g;

export const cleanInvisible = s => s.replace(INVISIBLE, '');

// Split text into raw messages: a header line starts a message; anything else
// continues the previous one (reference makeArrayOfMessages). Lines before the
// first header are returned separately so the importer can warn about them.
export function splitMessages(text) {
  const lines = text.split(/\r\n|\r|\n/);
  const out = [];
  let orphan = 0;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n].replace(LEAD_JUNK, '');
    if (USER_RE.test(line)) out.push({ system: false, msg: line, line: n + 1 });
    else if (SYSTEM_RE.test(line)) out.push({ system: true, msg: line, line: n + 1 });
    else if (out.length) out[out.length - 1].msg += '\n' + lines[n];
    else if (line.trim()) orphan++;
  }
  return { raw: out, orphanLines: orphan };
}

// Year is the longest component; it moves to the end (reference orderDateComponents).
export function orderDateComponents(date) {
  const [a, b, c] = date.split(/[-/.] ?/);
  const max = Math.max(a.length, b.length, c.length);
  if (c.length === max) return [a, b, c];
  if (b.length === max) return [a, c, b];
  return [b, c, a];
}

// --- day/month order inference (reference src/date.ts) -----------------------

export function checkAbove12(dates) {
  if (dates.some(d => d[0] > 12)) return true;
  if (dates.some(d => d[1] > 12)) return false;
  return null;
}

export function checkDecreasing(dates) {
  const byYear = new Map();
  for (const d of dates) { if (!byYear.has(d[2])) byYear.set(d[2], []); byYear.get(d[2]).push(d); }
  const results = [...byYear.values()].map(ds => {
    if (ds.slice(1).some((d, i) => d[0] - ds[i][0] < 0)) return true;
    if (ds.slice(1).some((d, i) => d[1] - ds[i][1] < 0)) return false;
    return null;
  });
  if (results.includes(true)) return true;
  if (results.includes(false)) return false;
  return null;
}

export function changeFrequencyAnalysis(dates) {
  let first = 0, second = 0;
  for (let i = 1; i < dates.length; i++) {
    first += Math.abs(dates[i - 1][0] - dates[i][0]);
    second += Math.abs(dates[i - 1][1] - dates[i][1]);
  }
  if (first > second) return true;
  if (first < second) return false;
  return null;
}

// true = days first, false = months first, null = undecided (callers then
// treat it as days first, like the reference parser, and warn).
export function daysBeforeMonths(dates) {
  return checkAbove12(dates) ?? checkDecreasing(dates) ?? changeFrequencyAnalysis(dates);
}

// --- time ---------------------------------------------------------------------

// 'p. m.' / 'PM' / 'a.m.' -> 'AM' | 'PM'. German day periods (UNVERIFIED, from
// WhatsR's indicator list): morgens/vorm. are AM, nachm./abends/mittags are PM;
// 'nachts' is late evening for 8-11 and small hours otherwise.
function ampmOf(word, hour) {
  const w = word.toLowerCase();
  if (/^(morgens|vorm\.)$/.test(w)) return 'AM';
  if (/^(nachm\.|abends|mittags)$/.test(w)) return 'PM';
  if (w === 'nachts') return hour >= 8 && hour <= 11 ? 'PM' : 'AM';
  const letters = w.replace(/[^apm]/g, '').toUpperCase();
  return letters === 'PM' ? 'PM' : 'AM';
}

// -> [h, m, s] in 24h. Reference convertTime12to24: '12' -> 0, then +12 for PM.
export function parseTime(time, ampm) {
  let [h, m, s] = time.split(/[:.]/).map(Number);
  s = s || 0;
  if (ampm) {
    const p = ampmOf(ampm, h);
    if (h === 12) h = 0;
    if (p === 'PM') h += 12;
  }
  return [h, m, s];
}

// --- header parsing -----------------------------------------------------------

// Parse raw messages (from splitMessages) into header fields; dates stay as
// components until the day/month order is known for the whole file.
export function parseHeaders(raw) {
  return raw.map(({ system, msg, line }) => {
    if (!system) {
      const m = USER_RE.exec(msg);
      return { line, date: m[1], time: m[2], ampm: m[3] || null, author: m[4], body: m[5] };
    }
    const m = SYSTEM_RE.exec(msg);
    return { line, date: m[1], time: m[2], ampm: m[3] || null, author: null, body: m[4] };
  });
}

// Year written first ('2025/03/04', '2025-03-04'): always year-month-day.
// Deviation from the reference parser, which leaves such dates to the day/month
// inference and so reads an ambiguous '2025/03/04' as 3 April.
export function yearFirst(date) {
  const [a, b, c] = date.split(/[-/.] ?/);
  return a.length > b.length && a.length > c.length;
}

// Decide day/month order for a file: unique dates in order of first appearance.
export function inferDaysFirst(parsed) {
  if (parsed.length && parsed.every(p => yearFirst(p.date))) return false;
  const dates = Array.from(new Set(parsed.map(p => p.date)), d => orderDateComponents(d).map(Number));
  return daysBeforeMonths(dates);
}

// Wall-clock fields { y, mo, d, h, mi, s } or null when the date is impossible.
export function wallClock(p, daysFirst) {
  const [a, b, yRaw] = orderDateComponents(p.date);
  const [day, month] = daysFirst === false || yearFirst(p.date) ? [+b, +a] : [+a, +b];
  const y = +yRaw.padStart(4, '2000'); // 2-digit years are 20xx (reference normalizeDate)
  const [h, mi, s] = parseTime(p.time, p.ampm);
  if (!(month >= 1 && month <= 12 && day >= 1 && day <= 31 && h <= 23 && mi <= 59 && s <= 59)) return null;
  // Reject 31 Feb and friends rather than letting Date roll over.
  const probe = new Date(Date.UTC(y, month - 1, day));
  if (probe.getUTCMonth() !== month - 1) return null;
  return { y, mo: month, d: day, h, mi, s };
}

// --- authors ------------------------------------------------------------------

// Author slot -> { name, nonContact, phone }. iOS shows non-contacts as
// '~' + U+202F (or space/NBSP) + push name.
export function parseAuthor(raw) {
  let name = cleanInvisible(raw).replace(/[  ]/g, ' ').trim();
  let nonContact = false;
  if (name.startsWith('~')) { nonContact = true; name = name.slice(1).trim(); }
  const phone = phoneOf(name);
  return { name, nonContact, phone };
}

// '+44 7700 900123' / '+1 (555) 010-0199' -> '+447700900123'; null if not a number.
export function phoneOf(s) {
  const t = String(s).replace(/[  ]/g, ' ').trim();
  if (!/^\+?[\d\s()\-.]+$/.test(t)) return null;
  const digits = t.replace(/\D/g, '');
  if (digits.length < 6) return null;
  return (t.startsWith('+') ? '+' : '') + digits;
}

// --- body classification ------------------------------------------------------

const EDITED_RE = /\s*‎?<This message was edited\.?>\s*$/i;
const DELETED_RE = /^(this message was deleted|you deleted this message|message deleted|diese nachricht wurde gelöscht|du hast diese nachricht gelöscht)\.?$/i;
const OMITTED_RE = /^(<(media omitted|video message omitted|video note omitted|medien ausgeschlossen)>|(image|video|audio|gif|sticker|contact card|document|bild|audio|sticker) omitted|.+\bdocument omitted|(bild|video|audio|sticker|gif) weggelassen)$/i;
// Reference regexAttachment: '<attached: file>' (iOS) or 'file (file attached)' (Android, localized).
const ATTACH_RE = /^(?:‎|‏)*(?:<.+:(.+)>|([\w-]+\.\w+)\s[(<].+[)>])/;
const LOCATION_RE = /^(location|standort): https?:\/\//i;
const LIVE_LOCATION_RE = /^live location shared$/i;
const CALL_RE = /^(missed voice call|missed video call|voice call|video call)\b/i;
const POLL_RE = /^POLL:\n/;

// -> { kind, text, edited, attachment }
// kind: message | media | deleted | call | poll | location | empty
export function classifyBody(body) {
  let b = body;
  let edited = false;
  if (EDITED_RE.test(b)) { edited = true; b = b.replace(EDITED_RE, ''); }
  const clean = cleanInvisible(b).trim();
  const firstLine = clean.split('\n')[0].trim();
  if (clean === '' || clean === ':.') return { kind: 'empty', text: null, edited, attachment: null };
  if (DELETED_RE.test(clean)) return { kind: 'deleted', text: null, edited, attachment: null };
  if (OMITTED_RE.test(firstLine)) {
    const rest = clean.split('\n').slice(1).join('\n').trim();
    return { kind: 'media', text: rest || null, edited, attachment: null };
  }
  const am = ATTACH_RE.exec(b.split('\n')[0]);
  if (am) {
    // Android puts a caption on the following line(s); iOS drops it.
    const rest = clean.split('\n').slice(1).join('\n').trim();
    return { kind: 'media', text: rest || null, edited, attachment: (am[1] || am[2]).trim() };
  }
  if (CALL_RE.test(clean)) return { kind: 'call', text: clean, edited, attachment: null };
  if (POLL_RE.test(clean)) return { kind: 'poll', text: clean, edited, attachment: null };
  if (LOCATION_RE.test(clean) || LIVE_LOCATION_RE.test(clean)) return { kind: 'location', text: clean, edited, attachment: null };
  return { kind: 'message', text: clean, edited, attachment: null };
}

// '@' + U+2068 Name U+2069 (current exports) and '@<digits>' (numbers that are
// not saved contacts). -> [{ name } | { phone }]
export function extractMentions(body) {
  const out = [];
  for (const m of body.matchAll(/@⁨([^⁩]+)⁩/g)) {
    const raw = m[1].trim();
    const phone = phoneOf(raw.replace(/^~\s*/, ''));
    out.push(phone ? { phone, name: raw } : { name: parseAuthor(raw).name });
  }
  for (const m of body.matchAll(/(?:^|[^\w⁨])@(\+?\d{6,15})\b/g)) out.push({ phone: phoneOf(m[1]), name: m[1] });
  return out;
}

// --- system messages ----------------------------------------------------------
//
// English (plus a few German) wordings from the spec's table. Each rule yields
// { type: 'e2e'|'create'|'join'|'leave'|'rename'|'admin'|'security'|'number'|'other', people[], group }.
// people are display names as written ('You' kept so the caller can resolve it).

const splitNames = s => s.replace(/\.$/, '').split(/\s*,\s*|\s+and\s+|\s+und\s+/).map(x => x.trim()).filter(Boolean);

const SYSTEM_RULES = [
  [/end-to-end encrypted|ende-zu-ende-verschlüsselt/i, () => ({ type: 'e2e', people: [], group: false })],
  [/^(.+?) created (?:the )?group "(.*)"\.?$/i, m => ({ type: 'create', people: [m[1]], group: true })],
  [/^(.+?) (?:was|were) added\.?$/i, m => ({ type: 'join', people: splitNames(m[1]), group: true })],
  [/^(.+?) added (.+?)\.?$/i, m => ({ type: 'join', people: splitNames(m[2]), by: m[1], group: true })],
  [/^(.+?) removed (.+?)\.?$/i, m => ({ type: 'leave', people: splitNames(m[2]), by: m[1], group: true })],
  [/^(.+?) left(?: the group)?\.?$/i, m => ({ type: 'leave', people: splitNames(m[1]), group: true })],
  // Wording UNVERIFIED (no fixture opened in the spec research).
  [/^(.+?) joined using (?:this|the|a) group's invite link\.?$/i, m => ({ type: 'join', people: [m[1]], group: true })],
  [/^(.+?) hat die gruppe verlassen\.?$/i, m => ({ type: 'leave', people: [m[1]], group: true })],
  [/^(.+?) hat (.+?) hinzugefügt\.?$/i, m => ({ type: 'join', people: splitNames(m[2]), by: m[1], group: true })],
  [/changed (?:the|this) (?:group name|subject|group description|group icon|group's icon|group settings|settings)|changed the group name/i, () => ({ type: 'rename', people: [], group: true })],
  [/deleted this group's icon/i, () => ({ type: 'rename', people: [], group: true })],
  [/now an admin|no longer an admin/i, () => ({ type: 'admin', people: [], group: true })],
  [/security code/i, () => ({ type: 'security', people: [], group: false })],
  [/changed their phone number|^\+?[\d\s()-]+ changed to \+?[\d\s()-]+$/i, () => ({ type: 'number', people: [], group: false })],
  [/^(messages to this group are now secured|disappearing messages|you blocked this contact|you unblocked this contact)/i, () => ({ type: 'other', people: [], group: false })],
];

export function matchSystem(text) {
  const t = cleanInvisible(text).trim();
  for (const [re, f] of SYSTEM_RULES) {
    const m = re.exec(t);
    if (m) return f(m);
  }
  return null;
}

// Authorless system notices whose wording contains ': ' (e.g. 'Alex changed the
// subject to: Plan B', or a group name with a colon inside a rename notice) are
// split by the reference grammar into a fake author 'Alex changed the subject
// to' and a body. A line is a system notice instead when the author slot itself
// holds system-notice wording AND the whole 'author: body' text matches a known
// system phrase. Both conditions are required so an ordinary 'Bob: everyone
// left' stays an authored message.
const SYSTEM_IN_AUTHOR = /\b(changed (?:the|this) (?:subject|group name|group description|group's icon|group icon|group settings|settings)|changed the group name|end-to-end encrypted|security code|changed their phone number|created (?:the )?group|added|removed|left|joined using|now an admin|no longer an admin)\b/i;

export function authorlessSystem(author, body) {
  if (!SYSTEM_IN_AUTHOR.test(cleanInvisible(author))) return null;
  return matchSystem(author + ': ' + body);
}

// Chat title from a file or zip name ('WhatsApp Chat - X.zip', 'WhatsApp Chat with X.txt').
export function titleFromName(name) {
  const base = String(name).split('/').pop();
  const m = /^WhatsApp Chat (?:-|with) (.+?)(?:\.(?:zip|txt))?$/i.exec(base);
  return m ? m[1].trim() : null;
}
