// LinkedIn "Download your data" archive (Basic_ or Complete_LinkedInDataExport).
// Spec: docs/formats/linkedin.md.
//
// What we read and why:
//   Connections.csv  ego -> each 1st-degree connection as a declared tie, timed by
//                    "Connected On" (a date, no time, no zone). Company/Position
//                    become node attrs (a snapshot at export time, not at
//                    connection time).
//   messages.csv     conversations; the only timestamped interactions, and the
//                    only file with an explicit zone (UTC).
//   Invitations.csv  connection requests in either direction (declared, directed).
//   Endorsement_Received_Info.csv / Endorsement_Given_Info.csv  directed weak ties.
//   Profile / Positions / Education  ego attributes only.
//
// Identity: the profile URL slug (/in/<slug>, lowercased) is the person key
// everywhere. Names collide and change, so they are used only as a fallback.
// Every file has its own date format, so each gets its own parser and nothing
// is auto-guessed (spec section 7).

import { parseCSV, firstLine } from './lib/csv.js';
import { stripHtml, nameKey } from './lib/text.js';
import { peek } from '../core/fileset.js';

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// File names vary across years ("Company Follows.csv" vs "Company_Follows.csv"):
// compare case-insensitively with spaces and underscores removed.
const norm = s => s.toLowerCase().replace(/[\s_]+/g, '');
function findFile(fs, name) {
  const want = norm(name);
  return fs.entries.find(e => norm(e.rel.split('/').pop()) === want) ?? null;
}

// ---- identity ---------------------------------------------------------------

const SLUG_RE = /linkedin\.com\/in\/([^/?#\s,]+)/i;
// Multi-recipient delimiter is UNVERIFIED (spec 7): split by URL shape, never by a delimiter.
const URL_RE = /https?:\/\/(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[^,\s;|]+/gi;

export function profileSlug(url) {
  const m = SLUG_RE.exec(String(url ?? ''));
  if (!m) return null;
  let s = m[1];
  try { s = decodeURIComponent(s); } catch { /* keep raw */ }
  return s.replace(/\/+$/, '').toLowerCase() || null;
}

// Node key for a profile URL. URLs that are not /in/<slug> (very old /pub/
// forms, company pages) are keyed by the normalised URL itself.
function urlKey(url) {
  const slug = profileSlug(url);
  if (slug) return 'linkedin:' + slug;
  const u = String(url ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
  return u ? 'linkedin:url:' + u.replace(/^https?:\/\/(www\.)?/, '') : null;
}

// ---- dates (one parser per file, spec 7) -------------------------------------

// Connections.csv "Connected On": observed `08 Feb 2026`; also ISO and MM/DD/YYYY.
// Date only; stored as UTC midnight. English month names only (locale variants UNVERIFIED).
export function parseConnectedOn(s) {
  const t = String(s ?? '').trim();
  let m = /^(\d{1,2})[ -]([A-Za-z]{3})[A-Za-z]*\.?[ -](\d{4})$/.exec(t);
  if (m) { const mo = MONTHS[m[2].toLowerCase()]; return mo ? Date.UTC(+m[3], mo - 1, +m[1]) : NaN; }
  m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
  return NaN;
}

// messages.csv DATE: `2025-06-01 14:03:22 UTC` (explicit UTC). Endorsements may use
// the SearchQueries style `2024/02/01 15:02:55 UTC` (UNVERIFIED), so accept '/' too.
export function parseUtcStamp(s) {
  const m = /^(\d{4})[-/](\d{2})[-/](\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?(?:\s*UTC)?$/.exec(String(s ?? '').trim());
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) : NaN;
}

// Invitations.csv Sent At: `1/29/26, 2:37 PM` (US style, 12 h, no zone). Read as UTC.
export function parseInvitationDate(s) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4}),?[\s  ]+(\d{1,2}):(\d{2})(?::(\d{2}))?[\s  ]*([AaPp])\.?[Mm]\.?$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  let y = +m[3]; if (m[3].length === 2) y += 2000;
  let h = +m[4] % 12; if (/p/i.test(m[7])) h += 12;
  return Date.UTC(y, +m[1] - 1, +m[2], h, +m[5], +(m[6] || 0));
}

const isYes = v => /^(yes|true|1|y)$/i.test(String(v ?? '').trim());

// Sponsored messages and InMail campaigns: their CONTENT is built in LinkedIn's
// campaign editor and starts with this class (observed 2021-2026 exports).
const SPONSORED_RE = /class="spinmail-quill-editor/i;

// TO without recipient URLs (exports before mid-2023) joins names with ", ",
// and names themselves contain ", " ("Jane Doe, Ph.D."). Split into names the
// export knows elsewhere (longest match first); a segment that matches nothing
// keeps any credential-like segments that follow it ("Ph.D.", "MBA", "Jr.").
// Returns { names, unmatched } where unmatched counts names not known.
const CREDENTIAL_RE = /^(?:[A-Z][A-Za-z]{0,4}\.?(?:[A-Z][a-z]?\.?)*|Jr\.?|Sr\.?|I{2,3}|IV)$/;
export function splitRecipientNames(to, isKnown) {
  const segs = String(to ?? '').split(/,\s+/).map(s => s.trim()).filter(Boolean);
  const names = [];
  let unmatched = 0;
  for (let i = 0; i < segs.length;) {
    let j = segs.length;
    for (; j > i; j--) if (isKnown(segs.slice(i, j).join(', '))) break;
    if (j > i) { names.push(segs.slice(i, j).join(', ')); i = j; continue; }
    let k = i + 1;
    while (k < segs.length && CREDENTIAL_RE.test(segs[k]) && !isKnown(segs[k])) k++;
    names.push(segs.slice(i, k).join(', '));
    unmatched++;
    i = k;
  }
  return { names, unmatched };
}

// ---- CSV access by header name (case-insensitive, trimmed; never by position) --

function rowsByName(text) {
  const { rows } = parseCSV(text);
  return rows.map(r => {
    const o = {};
    for (const [k, v] of Object.entries(r)) if (k !== '__parsed_extra') o[k.trim().toLowerCase()] = typeof v === 'string' ? v.trim() : v;
    return o;
  });
}

// Connections.csv: do not hard-skip 3 lines. Find the first row that contains
// both "First Name" and "Connected On" (older exports lack the preamble).
export function parseConnections(text) {
  const { rows } = parseCSV(text, { header: false });
  const h = rows.findIndex(r => r.some(c => c.trim() === 'First Name') && r.some(c => c.trim() === 'Connected On'));
  if (h < 0) return null;
  const head = rows[h].map(c => c.trim().toLowerCase());
  return rows.slice(h + 1).filter(r => r.some(c => c.trim())).map(r => Object.fromEntries(head.map((k, i) => [k, (r[i] ?? '').trim()])));
}

// ---- detection --------------------------------------------------------------

// Header lines are compared with quotes removed: since 2026 messages.csv
// quotes every field, the header too ("CONVERSATION ID","CONVERSATION TITLE",...).
const unquote = s => s.replace(/"/g, '');

async function sniff(fs) {
  const hits = [];
  const conn = findFile(fs, 'Connections.csv');
  if (conn) {
    const head = unquote(await peek(conn, 2048));
    // Preamble since 2022; before mid-2023 there is no URL column
    // ("First Name,Last Name,Email Address,...").
    if (/^﻿?Notes:/.test(head) || (/(^|\n)First Name,Last Name,/.test(head) && /Connected On/.test(head))) hits.push('Connections.csv');
  }
  const msgs = findFile(fs, 'messages.csv');
  if (msgs && /^CONVERSATION ID,CONVERSATION TITLE,FROM/i.test(unquote(firstLine(await peek(msgs, 1024))))) hits.push('messages.csv');
  const inv = findFile(fs, 'Invitations.csv');
  if (inv) {
    // The profile URL columns were added in late 2023.
    const l = unquote(firstLine(await peek(inv, 1024)));
    if (/^From,To,Sent At,Message,Direction/i.test(l) || (/Direction/.test(l) && /inviterProfileUrl/.test(l))) hits.push('Invitations.csv');
  }
  return hits;
}

async function detect(fs) {
  const hits = await sniff(fs);
  if (hits.length) return { score: 0.95, reason: `LinkedIn export: ${hits.join(', ')}` };
  const zipName = fs.names.some(n => /(Basic|Complete)_LinkedInDataExport_\d{2}-\d{2}-\d{4}/i.test(n));
  const prof = findFile(fs, 'Profile.csv');
  if (prof && /Headline/.test(firstLine(await peek(prof, 1024))) && (zipName || findFile(fs, 'Positions.csv'))) return { score: 0.7, reason: 'LinkedIn Profile.csv / Positions.csv' };
  return { score: 0, reason: '' };
}

// ---- import -----------------------------------------------------------------

async function importLinkedIn(fs, { builder, options = {}, progress, signal } = {}) {
  const b = builder;
  const files = {};
  for (const n of ['Connections.csv', 'messages.csv', 'Invitations.csv', 'Profile.csv', 'Positions.csv', 'Education.csv', 'Endorsement_Received_Info.csv', 'Endorsement_Given_Info.csv']) {
    const e = findFile(fs, n);
    if (e) files[n] = e;
  }
  const read = async n => (files[n] ? files[n].text() : null);

  // Parse everything first: the ego URL must be inferred before events are written.
  const connections = files['Connections.csv'] ? parseConnections(await read('Connections.csv')) : null;
  const messages = files['messages.csv'] ? rowsByName(await read('messages.csv')) : [];
  const invitations = files['Invitations.csv'] ? rowsByName(await read('Invitations.csv')) : [];
  const profile = files['Profile.csv'] ? rowsByName(await read('Profile.csv'))[0] ?? null : null;
  const positions = files['Positions.csv'] ? rowsByName(await read('Positions.csv')) : [];
  const education = files['Education.csv'] ? rowsByName(await read('Education.csv')) : [];
  const endRecv = files['Endorsement_Received_Info.csv'] ? rowsByName(await read('Endorsement_Received_Info.csv')) : [];
  const endGiven = files['Endorsement_Given_Info.csv'] ? rowsByName(await read('Endorsement_Given_Info.csv')) : [];
  progress?.(0.2, 'Read LinkedIn files');

  const egoName = profile ? [profile['first name'], profile['last name']].filter(Boolean).join(' ') : '';

  // Ego URL is usually not in Profile.csv. Strongest evidence: invitations
  // (OUTGOING inviter / INCOMING invitee are the ego). Otherwise the URL that
  // appears in nearly every conversation of messages.csv (spec 3).
  let egoUrlKey = null, egoHow = null, egoMsgName = null;
  const invVotes = new Map();
  for (const r of invitations) {
    const d = (r.direction || '').toUpperCase();
    const u = d === 'OUTGOING' ? r.inviterprofileurl : d === 'INCOMING' ? r.inviteeprofileurl : null;
    const k = u && urlKey(u);
    if (k) invVotes.set(k, (invVotes.get(k) || 0) + 1);
  }
  if (invVotes.size) { egoUrlKey = [...invVotes].sort((a, b) => b[1] - a[1])[0][0]; egoHow = 'invitations'; }
  const convIds = new Set(messages.map(r => r['conversation id']));
  if (!egoUrlKey && messages.length) {
    const seen = new Map(); // key -> Set(conv)
    const names = new Map(); // key -> name
    for (const r of messages) {
      const add = (u, name) => { const k = urlKey(u); if (!k) return; if (!seen.has(k)) seen.set(k, new Set()); seen.get(k).add(r['conversation id']); if (name && !names.has(k)) names.set(k, name); };
      add(r['sender profile url'], r.from);
      for (const u of String(r['recipient profile urls'] ?? '').match(URL_RE) || []) add(u, null);
    }
    const ranked = [...seen].map(([k, s]) => [k, s.size]).sort((a, b) => b[1] - a[1]);
    // Prefer a candidate whose sender name equals the Profile.csv name. Such a
    // match is accepted on its own: before mid-2023 messages.csv has no
    // recipient URLs, so the owner's URL appears only in conversations the
    // owner wrote in, often far fewer than 80% of them.
    const byName = egoName && ranked.find(([k]) => nameKey(names.get(k)) === nameKey(egoName));
    let top = byName || ranked[0];
    let found = !!top && (byName ? true : convIds.size > 1 && top[1] >= Math.max(2, 0.8 * convIds.size));
    if (!found && egoName) {
      // By elimination: a URL that sent under someone else's name is not the
      // owner's. If exactly one URL in every conversation is left (e.g. one
      // conversation in which only the other person wrote), it is the owner's.
      const rest = ranked.filter(([k, n]) => n === convIds.size && (!names.has(k) || nameKey(names.get(k)) === nameKey(egoName)));
      if (rest.length === 1) { top = rest[0]; found = true; }
    }
    if (found) { egoUrlKey = top[0]; egoHow = 'messages'; egoMsgName = names.get(top[0]) || null; }
  }
  const egoKey = egoUrlKey || 'linkedin:me';

  const fileNames = Object.values(files).map(e => e.rel);
  b.beginSource({ format: 'linkedin', family: 'professional', medium: 'linkedin', view: 'ego', context: 'professional', tz: 'UTC', fileNames, egoKey });
  // LinkedIn sends a large export in two parts: the first (minutes after the
  // request) holds profile files only; connections, messages and invitations
  // arrive in the second, about a day later (seen in a real export, 2026-10-04).
  const profileOnly = !files['Connections.csv'] && !files['messages.csv'] && !files['Invitations.csv'];
  if (profileOnly) b.warn('linkedin-profile-only', 'This LinkedIn export has profile files only (no Connections.csv, messages.csv or Invitations.csv), so it holds no network. LinkedIn sends a requested export in two parts: this looks like the first. Load the second file, which LinkedIn emails when it is ready (usually within a day).');
  else if (!egoUrlKey) b.warn('ego-url-unknown', 'Could not tell which profile URL is yours (Profile.csv has none and no invitations or messages identified it). Your node is keyed "linkedin:me" and will not merge with your URL if it appears elsewhere.');
  else if (egoHow === 'messages') b.warn('ego-url-inferred', 'Your profile URL was inferred from messages.csv (the URL that sends under your Profile.csv name, or the one present in nearly every conversation). Check the ego node in the identity review.');

  // Ego attributes (Profile / Positions / Education): ego node only.
  const egoAttrs = {};
  if (profile) {
    egoAttrs.headline = profile.headline; egoAttrs.industry = profile.industry; egoAttrs.location = profile['geo location'];
  }
  const current = positions.find(p => !p['finished on']);
  if (current) { egoAttrs.company = current['company name']; egoAttrs.position = current.title; }
  if (positions.length) egoAttrs.positions = positions.map(p => `${p.title || '?'} @ ${p['company name'] || '?'} (${p['started on'] || '?'} - ${p['finished on'] || 'present'})`).join('; ');
  if (education.length) egoAttrs.education = education.map(e => [e['school name'], e['degree name']].filter(Boolean).join(', ')).join('; ');
  // Without Profile.csv, the name the owner's URL sends under in messages.csv.
  const ego = b.node(egoKey, { label: egoName || egoMsgName || 'Me (LinkedIn)', attrs: egoAttrs });
  b.stat('positions', positions.length); b.stat('education', education.length);

  // Name -> key map for participants that lack a URL: unique full names only.
  // Learned first from every row that pairs a name with a profile URL (all
  // files), so that URL-less rows anywhere (Connections.csv and Invitations.csv
  // before mid-2023, "LinkedIn Member" senders, TO names) can join them.
  const nameToKey = new Map();
  const nameAmbiguous = new Set();
  const learnName = (name, key) => {
    const n = nameKey(name);
    if (!n || !key) return;
    if (nameToKey.has(n) && nameToKey.get(n) !== key) nameAmbiguous.add(n); else nameToKey.set(n, key);
  };
  const egoNameKey = nameKey(egoName);
  for (const r of connections || []) { const k = urlKey(r.url); if (k) learnName([r['first name'], r['last name']].filter(Boolean).join(' '), k); }
  for (const r of messages) {
    const sk = urlKey(r['sender profile url']);
    if (sk && r.from) learnName(r.from, sk);
    const ru = String(r['recipient profile urls'] ?? '').match(URL_RE) || [];
    if (ru.length === 1 && r.to) learnName(r.to, urlKey(ru[0]));
  }
  for (const r of invitations) { learnName(r.from, urlKey(r.inviterprofileurl)); learnName(r.to, urlKey(r.inviteeprofileurl)); }
  for (const [p, rows] of [['endorser', endRecv], ['endorsee', endGiven]]) {
    for (const r of rows) learnName([r[p + ' first name'], r[p + ' last name']].filter(Boolean).join(' '), urlKey(r[p + ' public url']));
  }
  const knownName = name => { const n = nameKey(name); return !!n && (n === egoNameKey || (nameToKey.has(n) && !nameAmbiguous.has(n))); };

  // Connections: declared ego -> connection.
  if (files['Connections.csv'] && !connections) b.warn('connections-header-missing', 'Connections.csv has no row with "First Name" and "Connected On"; it was skipped.');
  const connected = new Set();
  let badDates = 0, noUrl = 0, connByName = 0, hidden = 0;
  for (const [i, r] of (connections || []).entries()) {
    if (signal?.aborted) signal.throwIfAborted();
    const label = [r['first name'], r['last name']].filter(Boolean).join(' ');
    let key = urlKey(r.url);
    // Rows with only a date (",,,,,,07 Jun 2026"): members who hid or closed
    // their profile. Nothing identifies them, so they are counted, not added.
    if (!key && !label) { hidden++; continue; }
    if (!key) {
      const n = nameKey(label);
      if (nameToKey.has(n) && !nameAmbiguous.has(n) && nameToKey.get(n) !== egoKey) { key = nameToKey.get(n); connByName++; }
      else { noUrl++; key = 'linkedin:name:' + (n || 'connection-' + i); learnName(label, key); }
    }
    const t = parseConnectedOn(r['connected on']);
    if (Number.isNaN(t) && r['connected on']) badDates++;
    const n = b.node(key, {
      label: label || undefined,
      attrs: { company: r.company, position: r.position, connected_on: Number.isNaN(t) ? undefined : new Date(t).toISOString().slice(0, 10) },
      platformIds: Object.assign({ linkedin: profileSlug(r.url) ?? undefined }, r['email address'] ? { email: r['email address'].toLowerCase() } : {}),
    });
    connected.add(key);
    b.event({ type: 'declared', t, actor: ego, targets: [[n, 'declared']], key: 'linkedin:connection:' + key.slice(9) });
    b.stat('connections');
  }
  if (badDates) b.warn('unparsed-date', 'Connections.csv "Connected On" values in an unrecognised format (only English "08 Feb 2026", ISO and MM/DD/YYYY are read); those ties have no time.', badDates);
  if (connByName) b.warn('connection-url-by-name', 'Connections.csv has no URL column (exports before mid-2023); connections were joined to the profile URL that messages or invitations give for the same full name. A name shared by two people is not joined.', connByName);
  if (noUrl) b.warn('no-profile-url', 'Connections without a profile URL; keyed by name, which may collide.', noUrl);
  if (hidden) { b.stat('hidden-connections', hidden); b.warn('hidden-connections', 'Rows in Connections.csv with a date but no name or profile URL (members who hid or closed their profile). They are not added as people, so the network has fewer connections than the file has rows.', hidden); }
  if (connections?.length) b.warn('connection-date-only', 'Connected On is a date without time or zone; ties are placed at midnight UTC of that day.');

  // ---- messages ----
  let drafts = 0, byName = 0, unknownMember = 0, ambiguousTo = 0, badMsgDates = 0, sponsored = 0, spam = 0;
  const convs = new Map(); // id -> rows
  for (const r of messages) {
    if (isYes(r['is message draft']) || isYes(r['is conversation draft'])) { drafts++; continue; }
    // FOLDER is INBOX, ARCHIVE, SPAM or empty (sent messages are in INBOX).
    if (/^spam$/i.test(r.folder || '') && !options.includeSpam) { spam++; continue; }
    const id = r['conversation id'] || '(none)';
    if (!convs.has(id)) convs.set(id, []);
    convs.get(id).push(r);
  }
  const resolve = (url, name, convId) => {
    const k = urlKey(url);
    if (k) return { key: k, label: name || undefined };
    const n = nameKey(name);
    if (n === nameKey(egoName) && n) return { key: egoKey, label: name };
    if (n && nameToKey.has(n) && !nameAmbiguous.has(n)) { byName++; return { key: nameToKey.get(n), label: name }; }
    // Deleted accounts and "LinkedIn Member": a distinct unknown node per conversation (spec 5).
    unknownMember++;
    return { key: `linkedin:unknown:${convId}:${n || 'member'}`, label: name || 'LinkedIn Member' };
  };
  let ci = 0;
  for (const [convId, rows] of convs) {
    if (signal?.aborted) signal.throwIfAborted();
    const parts = new Map(); // key -> node index
    const msgs = [];
    let multiRecipient = false;
    for (const r of rows) {
      const s = resolve(r['sender profile url'], r.from, convId);
      const sIdx = b.node(s.key, { label: s.label });
      parts.set(s.key, sIdx);
      const urls = String(r['recipient profile urls'] ?? '').match(URL_RE) || [];
      const rec = [];
      if (urls.length) {
        if (new Set(urls.map(urlKey)).size > 1) multiRecipient = true;
        for (const u of urls) rec.push(resolve(u, urls.length === 1 ? r.to : null, convId));
      } else if (r.to) {
        // No URLs (exports before mid-2023): names only, joined with ", ".
        // A comma may also be part of a name ("Jane Doe, Ph.D."), so split
        // only into names known from elsewhere in the export.
        const { names, unmatched } = r.to.includes(',') ? splitRecipientNames(r.to, knownName) : { names: [r.to], unmatched: 0 };
        if (unmatched) ambiguousTo++;
        for (const nm of names) rec.push(resolve(null, nm, convId));
      }
      for (const x of rec) parts.set(x.key, b.node(x.key, { label: x.label }));
      const t = parseUtcStamp(r.date);
      if (Number.isNaN(t)) badMsgDates++;
      msgs.push({ r, s, sIdx, rec, t });
      if ((SPONSORED_RE.test(r.content || '') || r.subject) && !connected.has(s.key) && s.key !== egoKey) sponsored++;
    }
    const isGroup = multiRecipient || parts.size > 2;
    const kind = isGroup ? 'group_dm' : 'dm';
    const title = rows.find(r => r['conversation title'])?.['conversation title'];
    const ctx = b.context(`linkedin:${kind}:${convId}`, {
      name: title || [...parts.keys()].filter(k => k !== egoKey).map(k => b.nodes.labels[b.nodeIndex(k)]).join(', ') || convId,
      kind, visibility: isGroup ? 'group' : 'direct', medium: 'linkedin', members: [...parts.values()],
    });
    // Export row order is not guaranteed chronological; order by time within the conversation.
    msgs.sort((a, c) => (a.t || 0) - (c.t || 0));
    for (const [j, m] of msgs.entries()) {
      let targets = [];
      if (!isGroup) {
        for (const x of m.rec) targets.push([b.nodeIndex(x.key), 'dm']);
        if (!targets.length) for (const [k, idx] of parts) if (k !== m.s.key) targets.push([idx, 'dm']);
      }
      b.event({ type: 'message', t: m.t, actor: m.sIdx, targets, context: ctx, key: `linkedin:msg:${convId}:${j}`, text: m.r.content ? stripHtml(m.r.content.replace(/\r\n?/g, '\n')) : null });
      b.stat('messages');
    }
    b.stat('conversations');
    if (++ci % 200 === 0) progress?.(0.3 + 0.5 * ci / convs.size, 'Reading LinkedIn messages');
  }
  if (drafts) b.warn('drafts-skipped', 'Draft messages (IS MESSAGE DRAFT / IS CONVERSATION DRAFT) were skipped.', drafts);
  if (byName) b.warn('matched-by-name', 'Message participants without a profile URL were matched to a connection by exact full name (low confidence).', byName);
  if (unknownMember) b.warn('unknown-member', 'Message participants with no profile URL and no unique name match (deleted accounts, "LinkedIn Member"); each is a separate node per conversation.', unknownMember);
  if (ambiguousTo) b.warn('ambiguous-recipients', 'Rows with no recipient URLs whose TO names could not all be matched to a person known elsewhere in the export; TO was split at ", " (names such as "Jane Doe, Ph.D." were kept together where recognisable), so check these recipients.', ambiguousTo);
  if (spam) b.warn('spam-excluded', 'Messages in the SPAM folder of messages.csv were left out. Turn on "Include messages in the SPAM folder" to keep them.', spam);
  if (badMsgDates) b.warn('unparsed-date', 'messages.csv DATE values not in "YYYY-MM-DD HH:MM:SS UTC" form; those messages have no time.', badMsgDates);
  if (sponsored) b.warn('possible-sponsored', 'Messages from people who are not your connections that carry a SUBJECT or were written in LinkedIn\'s campaign editor (InMail, recruiters, sponsored messages). They are kept; consider excluding them.', sponsored);

  // ---- invitations ----
  let badInv = 0;
  for (const [i, r] of invitations.entries()) {
    const from = resolve(r.inviterprofileurl, r.from, 'invitations');
    const to = resolve(r.inviteeprofileurl, r.to, 'invitations');
    const a = b.node(from.key, { label: from.label });
    const c = b.node(to.key, { label: to.label });
    const t = parseInvitationDate(r['sent at']);
    if (Number.isNaN(t) && r['sent at']) badInv++;
    const dir = (r.direction || '').toUpperCase();
    const other = dir === 'OUTGOING' ? c : a;
    if (dir === 'OUTGOING' || dir === 'INCOMING') b.node(b.nodes.keys[other], { attrs: { invitation: dir === 'OUTGOING' ? 'sent' : 'received' } });
    b.event({ type: 'declared', t, actor: a, targets: [[c, 'declared']], key: `linkedin:invitation:${i}`, text: r.message || null });
    b.stat('invitations');
  }
  if (invitations.length) b.warn('invitation-time-zone-unknown', 'Invitations.csv "Sent At" has no time zone; read as UTC. Invitations are also declared ties, so an accepted invitation adds to the connection tie.');
  if (badInv) b.warn('unparsed-date', 'Invitations.csv "Sent At" values not in "M/D/YY, h:mm AM" form; those invitations have no time.', badInv);

  // ---- endorsements (column names medium confidence, date format UNVERIFIED) ----
  for (const [dir, rows] of [['received', endRecv], ['given', endGiven]]) {
    for (const [i, r] of rows.entries()) {
      const p = dir === 'received' ? 'endorser' : 'endorsee';
      const name = [r[p + ' first name'], r[p + ' last name']].filter(Boolean).join(' ');
      const o = resolve(r[p + ' public url'], name, 'endorsements');
      const on = b.node(o.key, { label: o.label });
      const [actor, target] = dir === 'received' ? [on, ego] : [ego, on];
      b.event({ type: 'declared', t: parseUtcStamp(r['endorsement date']), actor, targets: [[target, 'declared']], key: `linkedin:endorsement:${dir}:${i}`, text: r['skill name'] || null });
      b.stat('endorsements');
    }
  }
  progress?.(1, 'LinkedIn import done');
}

export default {
  id: 'linkedin',
  label: 'LinkedIn data export',
  family: 'professional',
  detect,
  options: [
    { key: 'includeSpam', label: 'Include messages in the SPAM folder', type: 'boolean', default: false },
  ],
  import: importLinkedIn,
};
