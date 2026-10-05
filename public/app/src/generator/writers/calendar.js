// Google Calendar export of the ego's calendar, per docs/formats/calendar.md.
//
// Google's direct export is a zip of .ics files, one per calendar; the exact
// names inside it are UNVERIFIED (reported as calendar ids, i.e. the owner's
// address for the primary calendar), so we write `<ego email>.ical.zip`
// holding `<ego email>.ics`.
//
// A calendar export is an ego view: only series the ego organizes or attends.
// Each meeting series becomes a master VEVENT (RRULE for recurring ones,
// EXDATE for skipped weeks) plus override VEVENTs carrying RECURRENCE-ID for
// moved occurrences. Times are local wall-clock with TZID pointing at an
// embedded VTIMEZONE; the generator's zones are fixed offsets, so each
// VTIMEZONE has a single STANDARD component. Lines are folded at 75 octets
// (CRLF + space, never inside a UTF-8 sequence) and end in CRLF.

import { zip, u8 } from './util.js';
import { pad, parts, offsetString } from '../time.js';

export function write({ world, ctx, obs, rng }) {
  const r = rng.fork('calendar');
  const ego = obs.ego;
  const egoAddr = world.people.email[ego];
  const locs = world.locs || [];
  const zoneFor = off => locs.find(l => l.offset === off) || { tz: off === 0 ? 'Etc/UTC' : `Etc/GMT${off > 0 ? '-' : '+'}${Math.abs(off)}`, offset: off };
  const egoZone = zoneFor(world.tzOffset[ego] || 0);
  const used = new Map([[egoZone.tz, egoZone]]);

  const lines = [];
  const L = s => lines.push(s);
  const stamp = utcStamp(world.span.end);
  const events = [];
  for (const se of ctx.series) {
    if (se.organizer !== ego && !se.attendees.includes(ego)) continue;
    const z = zoneFor(se.tzOffset || 0);
    used.set(z.tz, z);
    const loc = t => localStamp(t, z.offset);
    const durMs = se.durMin * 60000;
    const ev = [];
    let room = null;
    const attendeeLines = () => {
      const a = [];
      const people = [se.organizer, ...se.attendees];
      for (const p of people) {
        const role = p === se.organizer ? 'REQ-PARTICIPANT' : se.attendees.length > 6 && r.chance(0.2) ? 'OPT-PARTICIPANT' : 'REQ-PARTICIPANT';
        a.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=${role};PARTSTAT=${se.partstat[p] || 'NEEDS-ACTION'};${p === se.organizer ? '' : 'RSVP=TRUE;'}CN=${paramValue(world.people.label[p])};X-NUM-GUESTS=0:mailto:${world.people.email[p]}`);
      }
      if (room) a.push(`ATTENDEE;CUTYPE=RESOURCE;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;CN=${paramValue(room.name)};X-NUM-GUESTS=0:mailto:${room.addr}`);
      return a;
    };
    room = r.chance(0.3) ? { name: `Room ${1 + r.int(6)}.${pad(1 + r.int(20))}`, addr: `c_${r.hex(24)}@resource.calendar.google.com` } : null;
    const created = utcStamp(se.dtstart - (3 + r.int(60)) * 86400000);
    const seq = r.int(3);
    const common = (summary) => {
      const c = [];
      c.push(`DTSTAMP:${stamp}`);
      c.push(`ORGANIZER;CN=${paramValue(world.people.label[se.organizer])}:mailto:${world.people.email[se.organizer]}`);
      c.push(`UID:${se.uid}`);
      c.push(...attendeeLines());
      c.push(`CREATED:${created}`);
      if (r.chance(0.3)) c.push(`DESCRIPTION:${textValue(`Agenda:\n1. Updates, risks\n2. Next steps\nJoin: https://meet.${world.domain}/${r.hex(3)}-${r.hex(4)}-${r.hex(3)}`)}`);
      c.push(`LAST-MODIFIED:${created}`);
      c.push(`LOCATION:${room ? textValue(room.name) : ''}`);
      c.push(`SEQUENCE:${seq}`);
      c.push('STATUS:CONFIRMED');
      c.push(`SUMMARY:${textValue(summary || 'Meeting')}`);
      c.push('TRANSP:OPAQUE');
      return c;
    };
    ev.push('BEGIN:VEVENT');
    ev.push(`DTSTART;TZID=${z.tz}:${loc(se.dtstart)}`);
    ev.push(`DTEND;TZID=${z.tz}:${loc(se.dtstart + durMs)}`);
    if (!se.single) {
      ev.push(`RRULE:FREQ=WEEKLY;${se.intervalWeeks > 1 ? `INTERVAL=${se.intervalWeeks};` : ''}UNTIL=${utcStamp(se.until)}`);
      for (const x of se.exdates) ev.push(`EXDATE;TZID=${z.tz}:${loc(x)}`);
    }
    ev.push(...common(se.title));
    ev.push('END:VEVENT');
    for (const ov of se.single ? [] : se.overrides) {
      ev.push('BEGIN:VEVENT');
      ev.push(`DTSTART;TZID=${z.tz}:${loc(ov.start)}`);
      ev.push(`DTEND;TZID=${z.tz}:${loc(ov.start + durMs)}`);
      ev.push(`RECURRENCE-ID;TZID=${z.tz}:${loc(ov.recurrenceId)}`);
      ev.push(...common(ov.title || se.title));
      ev.push('END:VEVENT');
    }
    events.push(...ev);
  }

  L('BEGIN:VCALENDAR');
  L('PRODID:-//Google Inc//Google Calendar 70.9054//EN');
  L('VERSION:2.0');
  L('CALSCALE:GREGORIAN');
  L('METHOD:PUBLISH');
  L(`X-WR-CALNAME:${textValue(egoAddr)}`);
  L(`X-WR-TIMEZONE:${egoZone.tz}`);
  for (const z of [...used.values()].sort((a, b) => (a.tz < b.tz ? -1 : 1))) {
    L('BEGIN:VTIMEZONE');
    L(`TZID:${z.tz}`);
    L(`X-LIC-LOCATION:${z.tz}`);
    L('BEGIN:STANDARD');
    L(`TZOFFSETFROM:${offsetString(z.offset)}`);
    L(`TZOFFSETTO:${offsetString(z.offset)}`);
    L(`TZNAME:${offsetString(z.offset)}`);
    L('DTSTART:19700101T000000');
    L('END:STANDARD');
    L('END:VTIMEZONE');
  }
  lines.push(...events);
  L('END:VCALENDAR');
  const ics = lines.map(fold).join('\r\n') + '\r\n';
  return [{ path: `${egoAddr}.ical.zip`, bytes: zip([{ path: `${egoAddr}.ics`, bytes: u8(ics) }], world.span.end) }];
}

function utcStamp(t) { const p = parts(t, 0); return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}Z`; }
function localStamp(t, off) { const p = parts(t, off); return `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}`; }

// TEXT value escaping (RFC 5545 3.3.11).
export function textValue(s) { return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n'); }

// Parameter values containing : ; , are double-quoted (DQUOTE itself is not allowed).
function paramValue(s) { const v = String(s).replace(/"/g, "'"); return /[:;,]/.test(v) ? `"${v}"` : v; }

// Fold to at most 75 octets per physical line, never inside a UTF-8 sequence.
export function fold(line) {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out = [];
  let cur = '', bytes = 0, limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (bytes + b > limit) { out.push(cur); cur = ' '; bytes = 1; limit = 75; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
