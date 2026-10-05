// Gmail Takeout mailbox, per docs/formats/email.md:
//   takeout-<YYYYMMDDThhmmssZ>-001.zip
//   └── Takeout/Mail/All mail Including Spam and Trash.mbox
// An email export is an ego view: only messages that reached or left the
// ego's mailbox. Each message starts with the Takeout From_ line
// `From <gmail message id>@xxx <Day Mon DD HH:MM:SS +0000 YYYY>` (numeric zone
// before the year, as observed in parsers and fixtures), then RFC 5322
// headers including the Takeout-only X-GM-THRID (decimal string) and
// X-Gmail-Labels. Bcc appears only on the ego's own sent copy. Bodies use
// mboxrd quoting: a body line matching ^>*From gets one more '>'; whether
// Takeout itself uses mboxo or mboxrd is UNVERIFIED in the spec, and mboxrd is
// the reversible choice. LF line endings throughout.

import { zip, u8 } from './util.js';
import { involves } from '../observe.js';
import { MON, WDAY, pad, parts, offsetString } from '../time.js';

export function write({ world, ctx, records, obs, rng }) {
  const r = rng.fork('email');
  const ego = obs.ego;
  const egoAddr = world.people.email[ego];
  const spaces = ctx.spaces;

  // Which messages the mailbox holds: anything involving the ego, plus list
  // mail for lists the ego is on.
  const inBox = rec => {
    if (rec.kind !== 'message' || rec.actor < 0) return false;
    const s = rec.space >= 0 ? spaces[rec.space] : null;
    if (s && s.list) return rec.actor === ego || s.members.includes(ego);
    return involves(rec, ego);
  };

  // Message-IDs and Gmail ids are assigned to every message (in time order)
  // so ids do not depend on which mailbox is written.
  const byId = new Map();
  const msgId = new Map();
  for (const rec of records) {
    if (rec.kind !== 'message') continue;
    byId.set(rec.id, rec);
    msgId.set(rec.id, `<CA${r.b36(10)}+${r.hex(12)}@mail.${world.domain}>`);
  }
  const thrid = new Map(); // space -> decimal thread id
  let gmailSeq = BigInt('17' + r.digits(17));
  const threadId = si => {
    let t = thrid.get(si);
    if (!t) { t = '17' + r.digits(17); thrid.set(si, t); }
    return t;
  };

  const addr = i => mailbox(world.people.label[i], world.people.email[i]);
  const out = [];
  for (const rec of records) {
    if (!inBox(rec)) continue;
    const s = rec.space >= 0 ? spaces[rec.space] : null;
    const isList = !!(s && s.list);
    const sent = rec.actor === ego;
    const off = world.tzOffset[rec.actor] || 0;
    const gid = (gmailSeq += BigInt(1 + r.int(5000))).toString();

    // Ancestor chain for References (root first).
    const chain = [];
    for (let p = rec.parent; p >= 0 && byId.has(p) && chain.length < 30; p = byId.get(p).parent) chain.unshift(p);

    const labels = sent ? ['Sent'] : ['Inbox'];
    if (!sent && isList) labels.push('Category Updates');
    else if (!sent && r.chance(0.3)) labels.push('Important');
    labels.push('Opened');
    if (s && s.group != null && r.chance(0.15)) labels.push(`Projects/${world.groups[s.group]?.name || 'General'}`);

    const h = [];
    h.push(`X-GM-THRID: ${threadId(rec.space)}`);
    h.push(`X-Gmail-Labels: ${labels.join(',')}`);
    h.push(`Delivered-To: ${egoAddr}`);
    h.push('MIME-Version: 1.0');
    h.push(`Date: ${rfc5322Date(rec.t, off)}`);
    h.push(`From: ${addr(rec.actor)}`);
    if (isList) {
      h.push(`To: ${s.address}`);
      const local = s.address.split('@')[0];
      h.push(`List-Id: ${encodeWord(`${world.groups[s.group]?.name || 'All staff'} list`)} <${local}.${world.domain}>`);
      h.push(`List-Post: <mailto:${s.address}>`);
      h.push('Precedence: list');
    } else {
      if (rec.to?.length) h.push(`To: ${rec.to.map(addr).join(', ')}`);
      if (rec.cc?.length) h.push(`Cc: ${rec.cc.map(addr).join(', ')}`);
      if (sent && rec.bcc?.length) h.push(`Bcc: ${rec.bcc.map(addr).join(', ')}`);
    }
    const subject = rec.subject ?? s?.subject ?? '';
    h.push(`Subject: ${encodeWord(subject)}`);
    h.push(`Message-ID: ${msgId.get(rec.id)}`);
    if (chain.length) {
      h.push(`In-Reply-To: ${msgId.get(chain[chain.length - 1])}`);
      h.push(foldHeader(`References: ${chain.map(p => msgId.get(p)).join(' ')}`));
    }
    h.push('Content-Type: text/plain; charset="UTF-8"');
    h.push('Content-Transfer-Encoding: 8bit');

    // Body: the text, sometimes a line that starts with "From " (so quoting is
    // exercised), and for replies the quoted parent.
    const body = [];
    if (rec.text) {
      if (r.chance(0.08)) body.push(`From the notes: ${rec.text}`);
      else body.push(rec.text);
    }
    if (rec.text && chain.length) {
      const parent = byId.get(chain[chain.length - 1]);
      if (parent.text) {
        body.push('');
        body.push(`On ${quoteDate(parent.t, world.tzOffset[parent.actor] || 0)}, ${world.people.label[parent.actor]} <${world.people.email[parent.actor]}> wrote:`);
        for (const line of parent.text.split('\n')) body.push('> ' + line);
      }
    }
    if (rec.text && r.chance(0.5)) body.push('', '--', world.people.label[rec.actor]);
    const escaped = body.map(line => (/^>*From /.test(line) ? '>' + line : line));
    out.push(`From ${gid}@xxx ${fromLineDate(rec.t)}\n${h.join('\n')}\n\n${escaped.join('\n')}\n`);
  }
  const mbox = out.join('\n');
  const p = parts(world.span.end);
  const stamp = `${p.y}${pad(p.mo)}${pad(p.d)}T${pad(p.h)}${pad(p.mi)}${pad(p.s)}Z`;
  const entries = [{ path: 'Takeout/Mail/All mail Including Spam and Trash.mbox', bytes: u8(mbox) }];
  return [{ path: `takeout-${stamp}-001.zip`, bytes: zip(entries, world.span.end) }];
}

// "Name" <addr> with RFC 2047 encoding for non-ASCII display names.
export function mailbox(name, address) {
  if (!name) return address;
  if (/[^\x20-\x7e]/.test(name)) return `${encodeWord(name)} <${address}>`;
  if (/[()<>@,;:\\".[\]]/.test(name)) return `"${name.replace(/(["\\])/g, '\\$1')}" <${address}>`;
  return `${name} <${address}>`;
}

// RFC 2047 B-encoded words, split so each word stays within 75 characters
// and never splits a UTF-8 sequence. ASCII text passes through unchanged.
export function encodeWord(text) {
  if (!/[^\x20-\x7e]/.test(text)) return text;
  const words = [];
  let chunk = [];
  let bytes = 0;
  const flush = () => { if (chunk.length) words.push(`=?UTF-8?B?${b64(Uint8Array.from(chunk))}?=`); chunk = []; bytes = 0; };
  for (const ch of text) {
    const b = new TextEncoder().encode(ch);
    if (bytes + b.length > 45) flush(); // 45 bytes -> 60 base64 chars + 12 overhead = 72
    chunk.push(...b); bytes += b.length;
  }
  flush();
  return words.join(' ');
}

function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function foldHeader(line) {
  if (line.length <= 78) return line;
  const toks = line.split(' ');
  const lines = [];
  let cur = toks.shift();
  for (const t of toks) {
    if (cur.length + 1 + t.length > 78) { lines.push(cur); cur = ' ' + t; } else cur += ' ' + t;
  }
  lines.push(cur);
  return lines.join('\n');
}

function rfc5322Date(t, off) {
  const p = parts(t, off);
  return `${WDAY[p.dow]}, ${p.d} ${MON[p.mo - 1]} ${p.y} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} ${offsetString(off)}`;
}

function fromLineDate(t) {
  const p = parts(t, 0);
  return `${WDAY[p.dow]} ${MON[p.mo - 1]} ${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} +0000 ${p.y}`;
}

function quoteDate(t, off) {
  const p = parts(t, off);
  return `${WDAY[p.dow]}, ${MON[p.mo - 1]} ${p.d}, ${p.y} at ${pad(p.h)}:${pad(p.mi)}`;
}
