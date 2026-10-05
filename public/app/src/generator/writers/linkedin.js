// LinkedIn "Download your data" archive (full), per docs/formats/linkedin.md:
//   Complete_LinkedInDataExport_MM-DD-YYYY.zip
//     Connections.csv   3-line "Notes:" preamble, then First Name,...,Connected On
//     messages.csv      CONVERSATION ID,...,IS CONVERSATION DRAFT (DATE in UTC)
//     Invitations.csv   recent requests, Sent At as `M/D/YY, h:mm AM`
//     Profile.csv, Positions.csv, Education.csv   the ego only
// Each file has its own date format, as the spec warns. Connections are a star
// around the ego with each connection's current employer and title at export
// time; emails are mostly missing because sharing them is off by default.

import { zip, u8, csv } from './util.js';
import { MON, pad, parts } from '../time.js';

const PREAMBLE = 'Notes:\n"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have allowed their connections to see or download their email address using this setting https://www.linkedin.com/psettings/privacy/email. You can learn more here https://www.linkedin.com/help/linkedin/answer/261"\n\n';

export function write({ world, ctx, records, ident, obs, rng, native = {} }) {
  const r = rng.fork('linkedin');
  const ego = obs.ego;
  const { span, ties } = world;
  const P = world.people;
  const url = i => ident.url[i];

  // ---- Connections.csv: ego's ties formed before export, newest first.
  const conns = [];
  for (let ti = 0; ti < ties.count; ti++) {
    const a = ties.a[ti], b = ties.b[ti];
    if (a !== ego && b !== ego) continue;
    const t = ties.from[ti];
    if (!(t < span.end)) continue;
    conns.push({ other: a === ego ? b : a, t: Number.isFinite(t) ? t : span.start });
  }
  conns.sort((x, y) => y.t - x.t || x.other - y.other);
  native.connections = conns;
  const connRows = [['First Name', 'Last Name', 'URL', 'Email Address', 'Company', 'Position', 'Connected On']];
  for (const c of conns) {
    const a = P.attrs[c.other];
    connRows.push([P.first[c.other], P.last[c.other], url(c.other), r.chance(0.08) ? P.email[c.other] : '', a.company || '', a.position || '', connectedOn(c.t)]);
  }

  // ---- messages.csv: ego's conversations.
  const msgRows = [['CONVERSATION ID', 'CONVERSATION TITLE', 'FROM', 'SENDER PROFILE URL', 'TO', 'RECIPIENT PROFILE URLS', 'DATE', 'SUBJECT', 'CONTENT', 'FOLDER', 'ATTACHMENTS', 'IS MESSAGE DRAFT', 'IS CONVERSATION DRAFT']];
  const convId = new Map();
  const convs = new Map();
  for (const rec of records) {
    if (rec.kind !== 'message' || !(rec.space >= 0)) continue;
    const s = ctx.spaces[rec.space];
    if (s.kind !== 'dm' || !s.members.includes(ego)) continue;
    if (!convId.has(rec.space)) { convId.set(rec.space, '2-' + base64(r.hex(24) + '_' + r.hex(8))); convs.set(rec.space, []); }
    convs.get(rec.space).push(rec);
  }
  // Newest conversation first, newest message first within it.
  const order = [...convs].sort((a, b) => b[1][b[1].length - 1].t - a[1][a[1].length - 1].t);
  for (const [si, recs] of order) {
    for (const rec of recs.slice().reverse()) {
      const to = rec.to || ctx.spaces[si].members.filter(m => m !== rec.actor);
      msgRows.push([convId.get(si), '', P.label[rec.actor], url(rec.actor), to.map(i => P.label[i]).join(','), to.map(url).join(','), utcDate(rec.t), rec.subject || '', rec.text ?? '', 'INBOX', '', 'No', 'No']);
    }
  }

  // ---- Invitations.csv: connections made during the export window.
  const invRows = [['From', 'To', 'Sent At', 'Message', 'Direction', 'inviterProfileUrl', 'inviteeProfileUrl']];
  for (const c of conns) {
    if (c.t < span.start) continue;
    const out = r.chance(0.5);
    const [from, to] = out ? [ego, c.other] : [c.other, ego];
    const sent = c.t - r.int(5 * 86400) * 1000;
    invRows.push([P.label[from], P.label[to], usDate(sent), '', out ? 'OUTGOING' : 'INCOMING', url(from), url(to)]);
    (native.invitations ||= []).push({ from, to, t: sent });
  }

  // ---- ego profile, positions, education.
  const career = P.careers[ego];
  const a = P.attrs[ego];
  const profile = [['First Name', 'Last Name', 'Maiden Name', 'Address', 'Birth Date', 'Headline', 'Summary', 'Industry', 'Zip Code', 'Geo Location', 'Twitter Handles', 'Websites', 'Instant Messengers'],
    [P.first[ego], P.last[ego], '', '', '', `${a.position} at ${a.company}`, '', a.industry, '', a.location, '', '', '']];
  const positions = [['Company Name', 'Title', 'Description', 'Location', 'Started On', 'Finished On']];
  for (const j of career.jobs.slice().reverse()) positions.push([world.employers[j.employer].name, j.title, '', a.location, monthYear(j.start), j.end ? monthYear(j.end) : '']);
  const education = [['School Name', 'Start Date', 'End Date', 'Notes', 'Degree Name', 'Activities'],
    [world.schools[career.school], String(career.grad - 4), String(career.grad), '', r.pick(['Bachelor of Science', 'Bachelor of Arts', 'Master of Science']), '']];

  const files = [
    { path: 'Connections.csv', bytes: u8(PREAMBLE + csv(connRows, '\n')) },
    { path: 'messages.csv', bytes: u8(csv(msgRows, '\n')) },
    { path: 'Invitations.csv', bytes: u8(csv(invRows, '\n')) },
    { path: 'Profile.csv', bytes: u8(csv(profile, '\n')) },
    { path: 'Positions.csv', bytes: u8(csv(positions, '\n')) },
    { path: 'Education.csv', bytes: u8(csv(education, '\n')) },
  ];
  const p = parts(span.end);
  return [{ path: `Complete_LinkedInDataExport_${pad(p.mo)}-${pad(p.d)}-${p.y}.zip`, bytes: zip(files, span.end) }];
}

const connectedOn = t => { const p = parts(t); return `${pad(p.d)} ${MON[p.mo - 1]} ${p.y}`; };
const utcDate = t => { const p = parts(t); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} UTC`; };
const usDate = t => { const p = parts(t); const h = p.h % 12 || 12; return `${p.mo}/${p.d}/${pad(p.y % 100)}, ${h}:${pad(p.mi)} ${p.h < 12 ? 'AM' : 'PM'}`; };
const monthYear = t => { const p = parts(t); return `${MON[p.mo - 1]} ${p.y}`; };
const base64 = s => btoa(s);
