// Calendar importer: iCalendar (.ics) from Google (export zip, Takeout),
// Outlook and Apple. Spec: docs/formats/calendar.md. A personal calendar is
// an ego view: only meetings the owner was on, with the attendee lists the
// organizer shared.
//
// Each expanded occurrence becomes one `copresence` event: actor = organizer
// (or the calendar owner when there is none), targets = non-declined human
// attendees with role 'attendee'. Context = the series (UID), kind 'meeting'.
//
// Time zones, and their limits:
//   - TZIDs with an embedded VTIMEZONE: converted by ical.js from that block
//     (authoritative for the file; DST rules included).
//   - TZIDs without a VTIMEZONE: if the runtime's Intl knows the IANA name,
//     wall time is converted with Intl offsets; else a small Windows -> IANA
//     table (a subset of CLDR windowsZones, territory 001) is tried.
//   - Anything else, and floating times (no TZID, no Z), is interpreted in
//     X-WR-TIMEZONE or the `defaultTz` option and flagged 'floating-time'.
//   - Recurrences are expanded in local wall time and each instance converted
//     separately, so a weekly 10:00 meeting stays at 10:00 local across DST.
//   - Wall times inside a DST gap or overlap resolve to one of the two
//     candidate instants (Intl offset probing); ical.js does its own choice
//     for VTIMEZONE zones. Display-name TZIDs like "(UTC+01:00) Amsterdam"
//     are not parsed and fall back to floating.

import ICAL from '../../vendor/ical.js';
import { localToUtc, isValidZone } from './tabular.js';

const EXT = /\.(ics|ical|ifb)$/i;

async function headText(entry, n = 512) {
  const r = entry.stream().getReader();
  const { value } = await r.read();
  r.cancel().catch(() => {});
  return new TextDecoder('utf-8').decode((value || new Uint8Array()).subarray(0, n));
}

async function detect(fs) {
  const files = [];
  for (const e of fs.entries) {
    if (!EXT.test(e.rel)) continue;
    const h = (await headText(e)).replace(/^﻿/, '').replace(/^\s+/, '');
    if (/^BEGIN:VCALENDAR/i.test(h)) files.push(e.rel);
  }
  if (!files.length) return { score: 0, reason: '' };
  const takeout = files.some(f => /(^|\/)Calendar\/[^/]+\.ics$/i.test(f));
  return { score: 0.9, reason: takeout ? 'Google Takeout calendar (.ics)' : 'iCalendar file (.ics)', files };
}

// Unfold at the byte level: a fold (CRLF or LF followed by one space or tab)
// may split a multi-byte UTF-8 character, so it must go before decoding.
export function unfoldBytes(b) {
  const out = new Uint8Array(b.length);
  let o = 0;
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 13 && b[i + 1] === 10 && (b[i + 2] === 32 || b[i + 2] === 9)) { i += 2; continue; }
    if (b[i] === 10 && (b[i + 1] === 32 || b[i + 1] === 9)) { i += 1; continue; }
    out[o++] = b[i];
  }
  let s = new TextDecoder('utf-8').decode(out.subarray(0, o));
  return s.replace(/^﻿/, '');
}

// Subset of CLDR windowsZones.xml (territory "001" defaults). [UNVERIFIED
// against the current CLDR release; these long-standing names rarely change.]
const WINDOWS_ZONES = {
  'UTC': 'UTC', 'GMT Standard Time': 'Europe/London', 'Greenwich Standard Time': 'Atlantic/Reykjavik',
  'W. Europe Standard Time': 'Europe/Berlin', 'Romance Standard Time': 'Europe/Paris',
  'Central Europe Standard Time': 'Europe/Budapest', 'Central European Standard Time': 'Europe/Warsaw',
  'E. Europe Standard Time': 'Europe/Chisinau', 'FLE Standard Time': 'Europe/Kiev', 'GTB Standard Time': 'Europe/Bucharest',
  'Russian Standard Time': 'Europe/Moscow', 'Turkey Standard Time': 'Europe/Istanbul', 'Israel Standard Time': 'Asia/Jerusalem',
  'South Africa Standard Time': 'Africa/Johannesburg', 'Arabian Standard Time': 'Asia/Dubai',
  'India Standard Time': 'Asia/Calcutta', 'China Standard Time': 'Asia/Shanghai', 'Singapore Standard Time': 'Asia/Singapore',
  'Tokyo Standard Time': 'Asia/Tokyo', 'Korea Standard Time': 'Asia/Seoul', 'W. Australia Standard Time': 'Australia/Perth',
  'AUS Eastern Standard Time': 'Australia/Sydney', 'New Zealand Standard Time': 'Pacific/Auckland',
  'Eastern Standard Time': 'America/New_York', 'Central Standard Time': 'America/Chicago',
  'Mountain Standard Time': 'America/Denver', 'US Mountain Standard Time': 'America/Phoenix',
  'Pacific Standard Time': 'America/Los_Angeles', 'Alaskan Standard Time': 'America/Anchorage',
  'Hawaiian Standard Time': 'Pacific/Honolulu', 'Atlantic Standard Time': 'America/Halifax',
  'SA Pacific Standard Time': 'America/Bogota', 'E. South America Standard Time': 'America/Sao_Paulo',
  'Argentina Standard Time': 'America/Buenos_Aires', 'Pacific SA Standard Time': 'America/Santiago',
};

function resolveZone(tzid) {
  if (!tzid) return null;
  const t = String(tzid).replace(/^"|"$/g, '').replace(/^\//, '');
  if (t.toUpperCase() === 'UTC' || t === 'Z' || t === 'GMT') return 'UTC';
  if (isValidZone(t)) return t;
  if (WINDOWS_ZONES[t]) return WINDOWS_ZONES[t];
  return null;
}

function normAddr(v) {
  if (!v) return '';
  const s = String(v).trim();
  if (!/^mailto:/i.test(s)) return '';
  return s.slice(7).trim().toLowerCase();
}

function prop1(comp, name) { const p = comp.getFirstProperty(name); return p ? p.getFirstValue() : null; }
function param(p, name) { const v = p.getParameter(name); return Array.isArray(v) ? v[0] : v; }

// ---- import -----------------------------------------------------------------

async function importCalendar(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const opt = { egoAddress: '', defaultTz: 'UTC', windowStart: '', windowEnd: '', maxOccurrences: 500, includeAllDay: false, weightBy: 'count', maxAttendees: 50, ...options };
  const entries = [];
  for (const e of fs.entries) {
    if (!EXT.test(e.rel)) continue;
    const h = (await headText(e)).replace(/^﻿/, '').replace(/^\s+/, '');
    if (/^BEGIN:VCALENDAR/i.test(h)) entries.push(e);
  }
  const defaultTz = resolveZone(opt.defaultTz) || 'UTC';
  builder.beginSource({ format: 'calendar', family: 'workplace', medium: 'calendar', view: 'ego', context: 'workplace', tz: defaultTz,
    fileNames: entries.map(e => e.rel), egoKey: null });

  // Pass 1: parse every file into occurrences. Nothing is emitted until all
  // files are read, because duplicates across files (same UID in the primary
  // and a shared calendar) must be resolved first, and the ego must be known
  // to stand in for missing organizers.
  const parsed = [];
  const egoVotes = new Map();
  let maxStamp = -Infinity, maxSingle = -Infinity;
  for (let fi = 0; fi < entries.length; fi++) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    const e = entries[fi];
    progress(0.6 * fi / entries.length, `Reading ${e.rel}`);
    let comp;
    try { comp = new ICAL.Component(ICAL.parse(unfoldBytes(await e.bytes()))); }
    catch (err) { builder.warn('parse-error', `Could not parse ${e.rel}: ${err.message}`); continue; }
    const calName = prop1(comp, 'x-wr-calname');
    const calTz = resolveZone(prop1(comp, 'x-wr-timezone'));
    // Owner evidence: Google names the primary calendar after the address
    // (file "<address>.ics", X-WR-CALNAME = address) [file name UNVERIFIED].
    const base = e.rel.split('/').pop().replace(EXT, '');
    for (const c of [calName, base]) if (c && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(c) && !/calendar\.google\.com$/i.test(c)) egoVotes.set(c.toLowerCase(), (egoVotes.get(c.toLowerCase()) || 0) + 1000);
    const vevents = comp.getAllSubcomponents('vevent');
    for (const v of vevents) { const s = prop1(v, 'dtstamp'); if (s && s.toUnixTime) maxStamp = Math.max(maxStamp, s.toUnixTime() * 1000); }
    parsed.push({ e, comp, calTz, vevents });
  }

  const winStart = opt.windowStart ? Date.parse(opt.windowStart) : -Infinity; // ISO input from the UI
  let winEnd = opt.windowEnd ? Date.parse(opt.windowEnd) : NaN;

  const occ = []; // { uid, rid, start, end, seq, comp, allDay, file }
  const files = parsed.map(({ e, comp, calTz, vevents }) => {
    // Group VEVENTs by UID: one master (no RECURRENCE-ID) plus overrides, in any file order.
    const byUid = new Map();
    for (const v of vevents) {
      const uid = prop1(v, 'uid') || `nouid:${e.rel}:${byUid.size}`;
      if (!prop1(v, 'uid')) builder.stat('missing-uid');
      if (!byUid.has(uid)) byUid.set(uid, { master: null, ex: [] });
      const g = byUid.get(uid);
      if (v.getFirstProperty('recurrence-id')) g.ex.push(v);
      else if (!g.master || (prop1(v, 'sequence') || 0) > (prop1(g.master, 'sequence') || 0)) g.master = v;
    }
    return { e, comp, calTz, byUid };
  });
  const tzidOf = (c, name) => { const p = c.getFirstProperty(name); return p ? param(p, 'tzid') : null; };

  // Register a file's zones while working on it; remove the ones we added
  // afterwards so a differently-defined TZID of the same name in another file
  // is not reused (TimezoneService is global).
  const withZones = (comp, fn) => {
    const added = [];
    for (const tz of comp.getAllSubcomponents('vtimezone')) {
      const id = prop1(tz, 'tzid');
      if (!id) continue;
      if (!ICAL.TimezoneService.has(id)) added.push(id);
      ICAL.TimezoneService.register(tz);
    }
    try { return fn(); } finally { for (const id of added) ICAL.TimezoneService.remove(id); }
  };
  const makeToMs = (calTz, quiet = false) => {
    const floatZone = calTz || defaultTz;
    return (t, tzHint) => {
      if (!t) return NaN;
      if (t.isDate) return localToUtc(t.year, t.month, t.day, 0, 0, 0, 0, floatZone);
      const z = t.zone;
      if (z === ICAL.Timezone.utcTimezone) return Date.UTC(t.year, t.month - 1, t.day, t.hour, t.minute, t.second);
      if (z && z !== ICAL.Timezone.localTimezone && z.tzid && ICAL.TimezoneService.has(z.tzid)) return t.toUnixTime() * 1000;
      const zone = resolveZone(tzHint);
      if (zone) return localToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, 0, zone);
      if (!quiet) builder.stat('floating-times');
      if (!quiet) builder.warn('floating-time', `Times without a usable time zone were read as ${floatZone}${calTz ? " (the calendar's X-WR-TIMEZONE)" : ' (set the default time zone option if this is wrong)'}`);
      return localToUtc(t.year, t.month, t.day, t.hour, t.minute, t.second, 0, floatZone);
    };
  };

  if (Number.isNaN(winEnd)) {
    // Default window end: the export date (latest DTSTAMP) or the last
    // one-off meeting, whichever is later. Unbounded series stop there.
    for (const f of files) withZones(f.comp, () => {
      const toMs = makeToMs(f.calTz, true);
      for (const { master } of f.byUid.values()) {
        if (master && !master.getFirstProperty('rrule') && !master.getFirstProperty('rdate')) {
          const s = new ICAL.Event(master, { exceptions: [] }).startDate;
          if (s && !s.isDate) maxSingle = Math.max(maxSingle, toMs(s, tzidOf(master, 'dtstart')));
        }
      }
    });
    winEnd = Math.max(maxStamp, maxSingle);
    if (!Number.isFinite(winEnd)) winEnd = Date.now();
  }

  for (const { e, comp, calTz, byUid } of files) withZones(comp, () => {
    const toMs = makeToMs(calTz);
    const ridMs = makeToMs(calTz, true); // occurrence ids: same conversion, not counted twice
    for (const [uid, g] of byUid) {
      const exList = g.ex;
      if (!g.master) {
        // Orphan overrides (the master was not exported): each is a one-off.
        for (const x of exList) pushOcc(new ICAL.Event(x), x, null);
        continue;
      }
      // `exceptions: []` matters: without it ical.js relates EVERY vevent with a
      // RECURRENCE-ID in the calendar to this master, whatever its UID, so an
      // override of one series replaces the same wall-clock occurrence of any
      // other series. Only this UID's overrides are related, below.
      const ev = new ICAL.Event(g.master, { exceptions: [] });
      for (const x of exList) {
        try { ev.relateException(new ICAL.Event(x)); }
        catch { builder.stat('bad-override'); pushOcc(new ICAL.Event(x), x, null); }
      }
      const masterTz = tzidOf(g.master, 'dtstart');
      if (!ev.isRecurring()) { pushOcc(ev, g.master, null); continue; }
      const it = ev.iterator();
      let n = 0, next, capped = false;
      while ((next = it.next())) {
        const rid = ridMs(next, masterTz);
        if (rid > winEnd) { builder.stat('beyond-window'); break; }
        if (++n > opt.maxOccurrences) { capped = true; break; }
        if (rid < winStart) continue;
        let d;
        try { d = ev.getOccurrenceDetails(next); } catch { builder.stat('bad-occurrence'); continue; }
        const item = d.item;
        const itemComp = item.component;
        const start = toMs(d.startDate, tzidOf(itemComp, 'dtstart'));
        const dur = d.endDate && d.startDate ? d.endDate.subtractDate(d.startDate).toSeconds() * 1000 : 0;
        occ.push({ uid, rid, start, end: start + dur, seq: prop1(itemComp, 'sequence') || 0, comp: itemComp, allDay: d.startDate.isDate, file: e.rel });
      }
      if (capped) builder.warn('occurrence-cap', `Recurring series were cut at ${opt.maxOccurrences} occurrences (raise the limit or narrow the time window)`);
    }
    function pushOcc(event, comp, _) {
      const s = event.startDate;
      if (!s) { builder.stat('no-start'); return; }
      const start = toMs(s, tzidOf(comp, 'dtstart'));
      let dur = 0;
      if (event.endDate) dur = event.endDate.subtractDate(s).toSeconds() * 1000;
      const ridProp = comp.getFirstProperty('recurrence-id');
      const rid = ridProp ? ridMs(ridProp.getFirstValue(), param(ridProp, 'tzid')) : start;
      if (start < winStart || (opt.windowEnd && start > winEnd)) { builder.stat('outside-window'); return; }
      occ.push({ uid: event.uid || prop1(comp, 'uid'), rid, start, end: start + dur, seq: prop1(comp, 'sequence') || 0, comp, allDay: s.isDate, file: e.rel });
    }
  });

  // Dedupe across files by UID + original occurrence time, keeping the highest SEQUENCE.
  const best = new Map();
  for (const o of occ) {
    const k = `${o.uid}\u0000${o.rid}`;
    const prev = best.get(k);
    if (!prev) best.set(k, o);
    else { builder.stat('duplicate-occurrences'); if (o.seq > prev.seq) best.set(k, o); }
  }

  // Participants per occurrence.
  const names = new Map();
  const vote = (addr, name) => {
    if (name) { let m = names.get(addr); if (!m) names.set(addr, m = new Map()); m.set(name, (m.get(name) || 0) + 1); }
  };
  const rows = [];
  for (const o of best.values()) {
    const c = o.comp;
    if (String(prop1(c, 'status') || '').toUpperCase() === 'CANCELLED') { builder.stat('cancelled'); continue; }
    if (o.allDay && !opt.includeAllDay) { builder.stat('all-day-skipped'); continue; }
    const orgP = c.getFirstProperty('organizer');
    const organizer = orgP ? normAddr(orgP.getFirstValue()) : '';
    if (organizer) vote(organizer, param(orgP, 'cn'));
    const people = new Map(); // addr -> { group }, non-declined participants
    const invited = new Set(organizer ? [organizer] : []); // every human invitee, declined included
    let declinedOrganizer = false;
    for (const a of c.getAllProperties('attendee')) {
      const addr = normAddr(a.getFirstValue());
      if (!addr) { builder.stat('non-email-attendees'); continue; }
      const cutype = String(param(a, 'cutype') || 'INDIVIDUAL').toUpperCase();
      const role = String(param(a, 'role') || 'REQ-PARTICIPANT').toUpperCase();
      const partstat = String(param(a, 'partstat') || 'NEEDS-ACTION').toUpperCase();
      // Google room addresses: ...@resource.calendar.google.com, even if CUTYPE is missing.
      if (cutype === 'ROOM' || cutype === 'RESOURCE' || /@resource\.calendar\.google\.com$/.test(addr)) { builder.stat('rooms-resources'); continue; }
      vote(addr, param(a, 'cn'));
      if (role === 'NON-PARTICIPANT') { builder.stat('non-participants'); continue; }
      invited.add(addr);
      if (partstat === 'DECLINED') {
        builder.stat('declined');
        if (addr === organizer) declinedOrganizer = true;
        continue;
      }
      if (partstat === 'NEEDS-ACTION') builder.stat('needs-action');
      if (cutype === 'GROUP') {
        builder.stat('group-attendees');
        builder.warn('group-attendee', 'Some attendees are distribution lists (CUTYPE=GROUP); their members are not listed in the file');
      }
      people.set(addr, { group: cutype === 'GROUP' });
      egoVotes.set(addr, (egoVotes.get(addr) || 0) + 1);
    }
    if (organizer) egoVotes.set(organizer, (egoVotes.get(organizer) || 0) + 1);
    rows.push({ o, organizer, people, invited: invited.size, declinedOrganizer, summary: prop1(c, 'summary'), cls: String(prop1(c, 'class') || '').toUpperCase() });
  }

  // Ego: option, else owner evidence from file names / X-WR-CALNAME (heavily
  // weighted above), else the most frequent participant.
  let ego = String(opt.egoAddress || '').trim().toLowerCase() || null, how = 'option';
  if (!ego) {
    let b = null, bc = 0;
    for (const [k, v] of egoVotes) if (v > bc) { b = k; bc = v; }
    ego = b; how = bc >= 1000 ? 'calendar-name' : 'most-frequent-participant';
  }
  const person = addr => builder.node(`email:${addr}`, { attrs: { email: addr, domain: addr.slice(addr.lastIndexOf('@') + 1) }, platformIds: { email: addr } });
  if (ego) {
    const k = `email:${ego}`;
    builder.node(k, { attrs: { email: ego, domain: ego.slice(ego.lastIndexOf('@') + 1), is_ego: true }, platformIds: { email: ego } });
    builder.source.egoKey = k;
    builder.source.egoInferredFrom = how;
    if (how === 'most-frequent-participant') builder.warn('ego-guessed', `The calendar owner was guessed as ${ego} (the most frequent participant). Set the "Calendar owner address" option if this is wrong.`);
  } else builder.warn('ego-unknown', 'Could not tell whose calendar this is. Set the "Calendar owner address" option.');

  const ctxVis = new Map();
  rows.sort((a, b) => a.o.start - b.o.start);
  for (let ri = 0; ri < rows.length; ri++) {
    const { o, organizer, people, invited, declinedOrganizer, summary, cls } = rows[ri];
    if (ri % 500 === 0) progress(0.6 + 0.4 * ri / rows.length, 'Building meetings');
    let actorAddr = organizer || ego;
    if (!actorAddr) { builder.stat('no-organizer'); continue; }
    if (!organizer) builder.stat('no-organizer-used-ego');
    if (declinedOrganizer) builder.stat('organizer-declined');
    const others = [...people.keys()].filter(a => a !== actorAddr);
    if (!others.length) { builder.stat('solo-events'); continue; }
    const participants = others.length + 1;
    if (participants > opt.maxAttendees) {
      builder.stat('large-meetings');
      builder.warn('large-meetings', `Meetings with more than ${opt.maxAttendees} participants (kept; they add many weak co-presence ties)`);
    }
    const actor = person(actorAddr);
    const targets = others.map(a => [person(a), 'attendee']);
    // Size class (spec: 2 people = direct, more = group) counts who was
    // invited, not who accepted: a three-person meeting with one decline is
    // still a group meeting, not a 1:1.
    const size = Math.max(invited + (organizer ? 0 : 1), participants);
    const vis = cls === 'PRIVATE' || cls === 'CONFIDENTIAL' ? 'private' : size === 2 ? 'direct' : 'group';
    const ci = builder.context(`cal:${o.uid}`, { name: summary || '(no title)', kind: 'meeting', visibility: vis, medium: 'calendar', members: [actor, ...targets.map(t => t[0])] });
    const pv = ctxVis.get(ci);
    ctxVis.set(ci, pv === 'private' || vis === 'private' ? 'private' : pv === 'group' || vis === 'group' ? 'group' : 'direct');
    const minutes = (o.end - o.start) / 60000;
    const weight = opt.weightBy === 'duration' ? (minutes > 0 ? minutes : 0) : 1;
    builder.event({ type: 'copresence', t: o.start, actor, targets, context: ci, key: `cal:${o.uid}:${o.rid}`, text: summary || null, weight });
    builder.stat('meetings');
    if (o.allDay) builder.stat('all-day-included');
  }
  // A series' visibility is the most restrictive / widest seen across occurrences.
  for (const [ci, v] of ctxVis) builder.setVisibility(ci, v);
  for (const [addr, m] of names) {
    const i = builder.nodeIndex(`email:${addr}`);
    if (i < 0) continue;
    let b = null, bc = 0;
    for (const [n, c] of m) if (c > bc) { b = n; bc = c; }
    if (b && builder.nodes.labels[i] === addr) builder.setLabel(i, b);
  }
  builder.source.window = { start: Number.isFinite(winStart) ? winStart : null, end: Number.isFinite(winEnd) ? winEnd : null };
  progress(1, 'done');
}

export default {
  id: 'calendar',
  label: 'Calendar (.ics)',
  family: 'workplace',
  detect,
  options: [
    { key: 'egoAddress', label: 'Calendar owner address', type: 'string', default: '' },
    { key: 'defaultTz', label: 'Time zone for times without one (IANA name)', type: 'string', default: 'UTC' },
    { key: 'windowStart', label: 'Expand recurring meetings from (date)', type: 'date', default: '' },
    { key: 'windowEnd', label: 'Expand recurring meetings until (date; default: export date)', type: 'date', default: '' },
    { key: 'maxOccurrences', label: 'Maximum occurrences per series', type: 'number', default: 500 },
    { key: 'includeAllDay', label: 'Include all-day events', type: 'boolean', default: false },
    { key: 'weightBy', label: 'Weight meetings by', type: 'select', default: 'count', choices: [{ value: 'count', label: 'Count (1 per meeting)' }, { value: 'duration', label: 'Duration (minutes)' }] },
    { key: 'maxAttendees', label: 'Flag meetings larger than', type: 'number', default: 50 },
  ],
  import: importCalendar,
};
