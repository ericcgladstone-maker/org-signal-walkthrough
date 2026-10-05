// WhatsApp "Export chat" importer (docs/formats/whatsapp.md).
//
// One export = one chat = one source with view 'chat'. Several chat files
// dropped together become several sources. The line grammar lives in
// lib/whatsapp-grammar.js; this file decides who the participants are, which
// lines are really system messages, and turns messages into events in exact
// file order (turn-taking adjacency is how ties form in chats, and Android has
// minute resolution, so file order is the only reliable tiebreak).
//
// Times are the exporting phone's local wall clock with no offset. Without a
// `timezone` option they are read as UTC and the source tz is 'unknown'.

import { peek } from '../core/fileset.js';
import { nameKey } from './lib/text.js';
import { zonedToUtc, isValidTimeZone } from './lib/time.js';
import {
  HEADER_RE, splitMessages, parseHeaders, inferDaysFirst, wallClock, parseAuthor, classifyBody,
  extractMentions, matchSystem, authorlessSystem, titleFromName, cleanInvisible,
} from './lib/whatsapp-grammar.js';

// Chat files: iOS '_chat.txt', Android 'WhatsApp Chat with X.txt', otherwise
// any .txt naming chat/whatsapp (the whatsapp-chat-parser-website rule).
function chatEntries(fs) {
  const named = fs.entries.filter(e => /(^|\/)_chat\.txt$/i.test(e.rel) || /(^|\/)WhatsApp Chat[^/]*\.txt$/i.test(e.rel));
  if (named.length) return named;
  const loose = fs.entries.filter(e => /(chat|whatsapp)[^/]*\.txt$/i.test(e.rel));
  return loose.length ? [loose.sort((a, b) => a.rel.length - b.rel.length)[0]] : [];
}

// Share of the first 50 non-empty lines that look like message headers.
function headerShare(text) {
  const ls = text.split(/\r\n|\r|\n/).map(l => l.replace(/^[﻿​-‍]+/, '')).filter(l => l.trim()).slice(0, 50);
  if (ls.length > 1) ls.pop(); // peek() may cut the last line
  if (!ls.length) return 0;
  return ls.filter(l => HEADER_RE.test(l)).length / ls.length;
}

async function detect(fs) {
  let best = { score: 0, reason: '' };
  const named = new Set(chatEntries(fs));
  const candidates = [...named, ...fs.entries.filter(e => /\.txt$/i.test(e.rel) && !named.has(e)).slice(0, 5)];
  for (const e of candidates) {
    const share = headerShare(await peek(e, 8192));
    const isNamed = named.has(e);
    let score = 0;
    if (share >= 0.6) score = isNamed ? 0.95 : 0.8;
    else if (isNamed && share > 0) score = 0.6;
    else if (isNamed) score = 0.3;
    if (score > best.score) best = { score, reason: `${e.rel}: ${Math.round(share * 100)}% of the first lines are WhatsApp message headers` };
  }
  return best;
}

// Title of the chat: from the file name, a parent folder (several zips dropped
// together keep the zip name as a folder), or the single dropped file's name.
function chatTitle(entry, fs) {
  const parts = entry.path.split('/');
  for (let i = parts.length - 1; i >= 0; i--) { const t = titleFromName(parts[i]); if (t) return t; }
  if (fs.names.length === 1) return titleFromName(fs.names[0]);
  return null;
}

function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// Analyse one chat text. Pure: returns everything the importer needs.
export function analyzeChat(text, { title = null, dateOrder = 'auto' } = {}) {
  const { raw, orphanLines } = splitMessages(text);
  const parsed = parseHeaders(raw);
  let daysFirst = dateOrder === 'day-first' ? true : dateOrder === 'month-first' ? false : inferDaysFirst(parsed);
  const ambiguous = dateOrder === 'auto' && daysFirst === null;
  if (daysFirst === null) daysFirst = true; // reference parser default

  let chatTitleName = title;
  const msgs = [];
  let reclassified = 0;
  for (let i = 0; i < parsed.length; i++) {
    const p = parsed[i];
    const wall = wallClock(p, daysFirst);
    const m = { line: p.line, wall, author: null, body: p.body, system: null, cls: null };
    const fused = p.author !== null ? authorlessSystem(p.author, p.body) : null;
    if (fused) {
      m.system = fused;
      m.body = p.author + ': ' + p.body;
    } else if (p.author === null) {
      m.system = matchSystem(p.body) || { type: 'other', people: [], group: false };
    } else {
      const a = parseAuthor(p.author);
      const sys = matchSystem(p.body);
      const startsLRM = /^[‎‏]/.test(p.body);
      const clean = cleanInvisible(p.body).trim();
      const isTitle = chatTitleName && nameKey(a.name) === nameKey(chatTitleName);
      // Spec section 3 heuristics for 2024+ iOS, where system lines carry an author:
      //  (3) an end-to-end notice among the first 10 messages is always system,
      //      and its author is the chat title;
      //  (1) the author equals the chat title and the body is a system wording;
      //  (2) the body starts with U+200E and is a system wording;
      //  plus the issue #258 form 'Boris: Boris created group "X"'.
      const e2eEarly = i < 10 && /end-to-end/i.test(clean);
      const selfNamed = sys && clean.toLowerCase().startsWith(a.name.toLowerCase() + ' ');
      if (e2eEarly || (sys && (isTitle || startsLRM || selfNamed))) {
        if (e2eEarly && !chatTitleName) chatTitleName = a.name;
        m.system = sys || { type: 'e2e', people: [], group: false };
        m.systemAuthor = a.name;
        reclassified++;
      } else {
        m.author = a;
        m.cls = classifyBody(p.body);
        m.mentions = extractMentions(p.body);
      }
    }
    msgs.push(m);
  }
  return { msgs, daysFirst, ambiguous, orphanLines, chatTitle: chatTitleName, reclassified };
}

async function importChat(entry, fs, { builder, options, progress, signal }) {
  let tz = options?.timezone ?? 'unknown';
  if (tz !== 'unknown' && !isValidTimeZone(tz)) {
    builder.beginSource({ format: 'whatsapp', family: 'personal', medium: 'whatsapp', view: 'chat', context: 'personal', tz: 'unknown', fileNames: [entry.path] });
    builder.warn('timezone-invalid', `"${tz}" is not a known IANA time zone name; times were read as UTC instead.`);
    tz = 'unknown';
  } else {
    builder.beginSource({ format: 'whatsapp', family: 'personal', medium: 'whatsapp', view: 'chat', context: 'personal', tz, fileNames: [entry.path] });
  }
  const text = await entry.text();
  signal?.throwIfAborted();
  const fileTitle = chatTitle(entry, fs);
  const a = analyzeChat(text, { title: fileTitle, dateOrder: options?.dateOrder ?? 'auto' });
  const { msgs } = a;

  builder.warn('identity-by-name', 'WhatsApp exports carry display names only (as saved on the exporting phone), so people are identified by name. The same person can appear under different names in different exports.');
  if (tz === 'unknown') builder.warn('timezone-unknown', "Times are the exporting phone's local clock with no offset. They were read as UTC; set the time zone option to the phone's zone for correct absolute times.");
  if (a.ambiguous) builder.warn('date-order-ambiguous', 'Could not tell from the dates whether days or months come first; assumed day first. Set the date order option if dates look wrong.');
  if (a.orphanLines) builder.warn('orphan-lines', 'Lines before the first message header were ignored.', a.orphanLines);
  if (a.reclassified) builder.warn('system-by-heuristic', 'Lines that look like authored messages were treated as WhatsApp system notices (newer iOS exports put the group or contact name in the author slot).', a.reclassified);

  const egoName = options?.egoName ? nameKey(options.egoName) : null;
  const keyOf = (name, phone) => (phone ? `whatsapp:${phone}` : `whatsapp:${nameKey(name)}`);

  // Pass 1: participants (authors of real messages, people named in join/leave
  // notices) and the group/direct decision.
  const people = new Map(); // key -> { name, phone, nonContact }
  const addPerson = (name, phone, nonContact) => {
    const k = keyOf(name, phone);
    const p = people.get(k);
    if (!p) people.set(k, { name, phone, nonContact: !!nonContact });
    else if (nonContact === false) p.nonContact = false; // system notices (null) never override
    return k;
  };
  let groupEvidence = false;
  const authors = new Set();
  for (const m of msgs) {
    if (m.author) { authors.add(addPerson(m.author.name, m.author.phone, m.author.nonContact)); continue; }
    if (m.system.group) groupEvidence = true;
  }
  // Resolve a name written in a system notice to a person key. 'You' is the
  // exporter: known only if the user told us their name.
  const resolve = name => {
    const clean = name.replace(/^~\s*/, '').trim();
    if (/^(you|du|sie)$/i.test(clean)) return egoName ? addPerson(options.egoName.trim(), null, false) : null;
    const ph = parseAuthor(clean).phone;
    if (ph) return addPerson(clean, ph, null);
    return addPerson(clean, null, null);
  };
  // A name in a system notice that matches the chat title (the group itself) is not a person.
  for (const m of msgs) {
    if (!m.system || (m.system.type !== 'join' && m.system.type !== 'leave' && m.system.type !== 'create')) continue;
    m.systemPeople = [];
    // The creator of a group is a member; no event is emitted for 'create'.
    for (const n of m.system.people) {
      const k = resolve(n);
      if (k) m.systemPeople.push(k); else builder.warn('system-you-unresolved', 'A system notice refers to "You" (the person who exported the chat); set your name in the options to attribute it.');
    }
  }
  const isGroup = groupEvidence || authors.size > 2;
  // In a group, an @-mention names a member even if they never wrote: the
  // name sits between U+2068/U+2069 isolates (or is a phone number), so its
  // extent is exact, and people are keyed by name anyway (spec: "@⁨Name⁩
  // spans can be used to extract mention edges"). Not in a 1:1 chat, where a
  // third person would wrongly become a recipient.
  if (isGroup) {
    const known = new Set([...people.values()].map(p => nameKey(p.name)));
    for (const m of msgs) {
      if (!m.author) continue;
      for (const mn of m.mentions) {
        if (mn.phone) { if (![...people.values()].some(p => p.phone && p.phone.replace('+', '') === mn.phone.replace('+', ''))) addPerson(mn.name, mn.phone, null); continue; }
        if (mn.name && !known.has(nameKey(mn.name))) { addPerson(mn.name, null, null); known.add(nameKey(mn.name)); }
      }
    }
  }
  if (egoName && people.has(`whatsapp:${egoName}`)) builder.source.egoKey = `whatsapp:${egoName}`;

  // Direct chat where only one side wrote: the chat title names the other side.
  if (!isGroup && authors.size === 1 && a.chatTitle) {
    const k = keyOf(a.chatTitle, parseAuthor(a.chatTitle).phone);
    if (!authors.has(k)) addPerson(a.chatTitle, parseAuthor(a.chatTitle).phone, false);
  }
  if (!isGroup && people.size < 2) builder.warn('direct-partner-unknown', 'Only one person wrote in this one-to-one chat and the file name does not name the other; their messages have no recipient.');
  // The exporter of a one-to-one chat is the participant the chat is not
  // named after ("WhatsApp Chat - Dana Sato": the other person wrote it). This
  // names the owner without asking, so several chats from one phone share an
  // owner and "Are these all you?" can offer them together.
  if (!builder.source.egoKey && !isGroup && people.size === 2 && a.chatTitle) {
    const tk = nameKey(a.chatTitle.replace(/^~\s*/, ''));
    const keys = [...people.keys()];
    const named = keys.filter(k => nameKey(people.get(k).name.replace(/^~\s*/, '')) === tk || (people.get(k).phone && parseAuthor(a.chatTitle).phone === people.get(k).phone));
    if (named.length === 1) {
      builder.source.egoKey = keys.find(k => k !== named[0]);
      builder.source.egoInferredFrom = 'chat-title';
    }
  }
  if (a.chatTitle) builder.source.title = a.chatTitle;

  const idx = new Map();
  for (const [k, p] of people) {
    idx.set(k, builder.node(k, {
      label: p.name,
      attrs: { is_phone_number: !!p.phone, is_saved_contact: !(p.nonContact || p.phone) },
      platformIds: p.phone ? { whatsapp_phone: p.phone } : { whatsapp_name: p.name },
    }));
  }

  const first = msgs.find(m => m.wall);
  const firstStamp = first ? `${first.wall.y}-${first.wall.mo}-${first.wall.d} ${first.wall.h}:${first.wall.mi}:${first.wall.s}` : '';
  const id = fnv1a(`${a.chatTitle || entry.path}|${firstStamp}`);
  const kind = isGroup ? 'group_dm' : 'dm';
  const ctx = builder.context(`whatsapp:${kind}:${id}`, {
    name: a.chatTitle || entry.path.split('/').pop(),
    kind, visibility: isGroup ? 'group' : 'direct', medium: 'whatsapp',
    members: [...idx.values()],
  });

  // Mentions resolve to participants by phone digits or normalized name.
  const byName = new Map();
  for (const [k, p] of people) byName.set(nameKey(p.name), k);
  const mentionTarget = mn => {
    if (mn.phone && idx.has(`whatsapp:${mn.phone}`)) return idx.get(`whatsapp:${mn.phone}`);
    if (mn.phone) for (const [k, p] of people) if (p.phone && p.phone.replace('+', '') === mn.phone.replace('+', '')) return idx.get(k);
    const k = byName.get(nameKey(mn.name));
    return k ? idx.get(k) : -1;
  };

  // Pass 2: events in file order.
  let prevT = -Infinity, backwards = 0, badDates = 0, n = 0;
  for (const m of msgs) {
    if ((++n & 1023) === 0) { signal?.throwIfAborted(); progress?.(n / msgs.length, 'Reading WhatsApp chat'); }
    let t = NaN;
    if (m.wall) t = zonedToUtc(m.wall.y, m.wall.mo, m.wall.d, m.wall.h, m.wall.mi, m.wall.s, 0, tz);
    else badDates++;
    if (t < prevT) backwards++;
    if (!Number.isNaN(t)) prevT = t;
    const key = `whatsapp:${id}:${m.line}`;
    if (m.author) {
      const actor = idx.get(keyOf(m.author.name, m.author.phone));
      const targets = [];
      if (!isGroup) for (const [k, i] of idx) if (i !== actor) targets.push([i, 'dm']);
      for (const mn of m.mentions) {
        const ti = mentionTarget(mn);
        if (ti >= 0) targets.push([ti, 'mention']);
        else builder.warn('mention-unmatched', 'Mentions of people who never wrote in or joined this chat were not linked.');
      }
      builder.event({ type: 'message', t, actor, targets, context: ctx, key, text: m.cls.text });
      builder.stat('messages');
      builder.stat(`kind:${m.cls.kind}`);
      if (m.cls.edited) builder.stat('edited');
      continue;
    }
    builder.stat('systemMessages');
    if (m.system.type === 'join' || m.system.type === 'leave') {
      for (const k of m.systemPeople) {
        builder.event({ type: m.system.type, t, actor: idx.get(k), context: ctx, text: cleanInvisible(m.body).trim() });
        builder.stat(m.system.type === 'join' ? 'joins' : 'leaves');
      }
    }
  }
  if (badDates) builder.warn('bad-date', 'Messages with an impossible date (check the date order option) have no time.', badDates);
  if (backwards) builder.warn('time-backwards', 'Timestamps go backwards in places; file order was kept as the message order.', backwards);
  if (!msgs.length) builder.warn('no-messages', 'No WhatsApp message lines were found in this file.');
}

export default {
  id: 'whatsapp',
  label: 'WhatsApp chat export',
  family: 'personal',
  detect,
  options: [
    { key: 'timezone', label: 'Time zone of the exporting phone', type: 'timezone', default: 'unknown' },
    { key: 'dateOrder', label: 'Date order', type: 'select', default: 'auto', choices: ['auto', 'day-first', 'month-first'] },
    { key: 'egoName', label: 'Your name as it appears in the chat (optional)', type: 'text', default: '' },
  ],
  async import(fs, ctx) {
    const files = chatEntries(fs);
    if (!files.length) {
      // A lone .txt with another name that passed detection on content.
      for (const e of fs.entries.filter(e => /\.txt$/i.test(e.rel))) if (headerShare(await peek(e, 8192)) >= 0.6) files.push(e);
    }
    if (!files.length) throw new Error('No WhatsApp chat text file found (expected _chat.txt or "WhatsApp Chat with <name>.txt").');
    for (const e of files) await importChat(e, fs, ctx);
  },
};
