// Email importer: mbox (any producer), Gmail Takeout, Apple Mail .mbox
// folders, Thunderbird extensionless folders, .eml files. PST/OST/.msg are
// detected and explained, not parsed (no browser-grade parser is vendored).
//
// Spec: docs/formats/email.md. An email export is an ego view: only messages
// that reached or left one mailbox.
//
// mbox files are split at the byte level rather than through lines(): message
// bodies are often 8-bit in a legacy charset (Content-Transfer-Encoding: 8bit,
// charset=iso-8859-1), and decoding the whole file as UTF-8 first would
// destroy them before postal-mime sees the charset. Each message is handed to
// postal-mime as bytes, which decodes headers (RFC 2047) and parts properly.

import { PostalMime } from '../../vendor/postal-mime.js';

// ---- detection --------------------------------------------------------------

const NAME_CANDIDATE = /(^|\/)[^/.]+$|\.(mbox|mbx|eml|pst|ost|msg)$/i;
const HEADER_LINE = /^[!-9;-~]+:[ \t]/;
const TYPICAL = /^(received|from|date|message-id|mime-version|to|subject|return-path|delivered-to):/im;
// RFC 4155 From_ line, also accepting Gmail's "+0000 2024" variant (zone before year)
// and single-digit days without padding.
export const FROM_LINE = /^From \S+ +\w{3} \w{3} +[ \d]?\d \d\d:\d\d:\d\d/;

async function peekBytes(entry, n = 2048) {
  const reader = entry.stream().getReader();
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
  }
  reader.cancel().catch(() => {});
  const out = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const c of chunks) { const k = Math.min(c.length, out.length - o); out.set(c.subarray(0, k), o); o += k; if (o >= out.length) break; }
  return out;
}

const latin1 = new TextDecoder('latin1');

// Classify one entry: 'mbox' | 'eml' | 'pst' | 'ost' | 'msg' | null.
export async function classify(entry) {
  if (!NAME_CANDIDATE.test(entry.rel)) return null;
  const b = await peekBytes(entry);
  if (b[0] === 0x21 && b[1] === 0x42 && b[2] === 0x44 && b[3] === 0x4e) {
    // "!BDN". The client magic (wMagicClient, "SM" = PST, "SO" = OST) sits at
    // offset 8 per MS-PST [UNVERIFIED here]; fall back to the extension.
    if (b[8] === 0x53 && b[9] === 0x4f) return 'ost';
    if (b[8] === 0x53 && b[9] === 0x4d) return 'pst';
    return /\.ost$/i.test(entry.rel) ? 'ost' : 'pst';
  }
  const ole = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  if (ole.every((x, i) => b[i] === x)) return /\.msg$/i.test(entry.rel) ? 'msg' : null; // OLE is also .doc/.xls
  let s = latin1.decode(b);
  if (s.startsWith('\u00ef\u00bb\u00bf')) s = s.slice(3);
  if (s.startsWith('From ')) {
    const rest = s.slice(s.indexOf('\n') + 1, 1024 + s.indexOf('\n'));
    if (/^[A-Za-z0-9-]+:/m.test(rest)) return 'mbox';
    return null;
  }
  const first = s.replace(/^[\r\n]+/, '').split(/\r?\n/)[0];
  if (HEADER_LINE.test(first)) {
    const typical = (s.match(new RegExp(TYPICAL.source, 'gim')) || []).length;
    if (/\.eml$/i.test(entry.rel) ? typical >= 1 : typical >= 2) return 'eml';
  }
  return null;
}

async function detect(fs) {
  const files = [];
  const kinds = new Set();
  let peeks = 0;
  for (const e of fs.entries) {
    if (!NAME_CANDIDATE.test(e.rel)) continue;
    if (++peeks > 400) break; // keep detect cheap on huge non-email drops
    const k = await classify(e);
    if (k) { files.push(e.rel); kinds.add(k); }
  }
  if (!files.length) return { score: 0, reason: '' };
  const takeout = files.some(f => /(^|\/)(Takeout\/)?Mail\/[^/]+\.mbox$/i.test(f));
  let score = 0, reason;
  if (kinds.has('mbox')) { score = 0.9; reason = takeout ? 'Gmail Takeout mailbox (mbox)' : 'mbox mailbox file'; }
  else if (kinds.has('eml')) { score = 0.8; reason = '.eml message files'; }
  else { score = 0.6; reason = 'Outlook data file (PST/OST/MSG): detected but cannot be read here'; }
  return { score, reason, files };
}

// ---- byte-level line reader ---------------------------------------------------

// Async iterator of lines as Uint8Array (without \n or trailing \r).
async function* byteLines(stream) {
  const reader = stream.getReader();
  let carry = new Uint8Array(0);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    let buf = value;
    if (carry.length) { const m = new Uint8Array(carry.length + value.length); m.set(carry); m.set(value, carry.length); buf = m; }
    let start = 0, i;
    while ((i = buf.indexOf(10, start)) >= 0) {
      const end = i > start && buf[i - 1] === 13 ? i - 1 : i;
      yield buf.subarray(start, end);
      start = i + 1;
    }
    carry = buf.slice(start);
  }
  if (carry.length) yield carry[carry.length - 1] === 13 ? carry.subarray(0, carry.length - 1) : carry;
}

function startsFrom(l) { return l.length >= 5 && l[0] === 70 && l[1] === 114 && l[2] === 111 && l[3] === 109 && l[4] === 32; }

// Split an mbox stream into messages: { fromLine, bytes }.
// Rule (spec): a From_ line begins a message only after a blank line or at the
// start of the file, and only if it looks like a real From_ line. Content-Length
// is ignored (mboxcl producers are rare, and lengths are often wrong).
// Body lines ">From ", ">>From " ... lose one '>' (mboxrd). For mboxo files this
// also turns an originally-quoted ">From" into "From", which is harmless here.
export async function* mboxMessages(stream) {
  let prevBlank = true;
  let cur = null;
  let preamble = 0;
  const flush = () => {
    const ls = cur.lines;
    if (ls.length && ls[ls.length - 1].length === 0) ls.pop(); // separator blank line
    let n = 0;
    for (const l of ls) n += l.length + 1;
    const out = new Uint8Array(n);
    let o = 0;
    for (const l of ls) { out.set(l, o); o += l.length; out[o++] = 10; }
    return { fromLine: cur.fromLine, bytes: out, preamble };
  };
  for await (const line of byteLines(stream)) {
    if (prevBlank && startsFrom(line)) {
      const s = latin1.decode(line);
      if (FROM_LINE.test(s)) {
        if (cur) yield flush();
        cur = { fromLine: s, lines: [] };
        prevBlank = false;
        continue;
      }
    }
    if (cur) {
      let l = line;
      if (l[0] === 62) { // '>'
        let k = 0;
        while (l[k] === 62) k++;
        if (startsFrom(l.subarray(k))) l = l.subarray(1);
      }
      // subarray views share the reader's chunk buffer, which is replaced (not
      // mutated) on the next read, so keeping the view is safe.
      cur.lines.push(l);
    } else if (line.length) preamble++;
    prevBlank = line.length === 0;
  }
  if (cur) yield flush();
}

// ---- dates ------------------------------------------------------------------

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const ZONES = { ut: 0, utc: 0, gmt: 0, z: 0, est: -300, edt: -240, cst: -360, cdt: -300, mst: -420, mdt: -360, pst: -480, pdt: -420 };

function stripComments(s) {
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== prev);
  return s;
}

// RFC 5322 date (with the obsolete forms of section 4.3) -> epoch ms, or NaN.
// Date.parse is implementation-defined, so this is explicit:
//   [day-name[,]] DD Mon YYYY HH:MM[:SS] [zone]
// Two-digit years: 00-49 -> 20xx, 50-99 -> 19xx; three-digit years + 1900.
// Named US zones per RFC 5322 4.3; military letters and "-0000" mean "zone
// unknown", which RFC 5322 says to treat as UTC (+0000). Missing zone: UTC.
export function parseEmailDate(str) {
  if (!str) return NaN;
  const s = stripComments(String(str)).replace(/\s+/g, ' ').trim();
  const m = /(\d{1,2})[ -]([A-Za-z]{3})[a-z]*\.?[ -](\d{2,4}) (\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(?: ?([+-]\d{2}:?\d{2}|[A-Za-z]{1,5}))?/.exec(s);
  if (!m) return NaN;
  const mon = MONTHS[m[2].toLowerCase()];
  if (mon === undefined) return NaN;
  let y = +m[3];
  if (m[3].length === 2) y += y < 50 ? 2000 : 1900;
  else if (m[3].length === 3) y += 1900;
  const d = +m[1], H = +m[4], M = +m[5], S = m[6] ? +m[6] : 0;
  if (d < 1 || d > 31 || H > 23 || M > 59 || S > 60) return NaN;
  let off = 0;
  const z = m[7];
  if (z) {
    if (/^[+-]/.test(z)) {
      const zz = z.replace(':', '');
      off = (zz[0] === '-' ? -1 : 1) * (+zz.slice(1, 3) * 60 + +zz.slice(3, 5));
    } else {
      const k = z.toLowerCase();
      if (k in ZONES) off = ZONES[k];
      else if (k.length === 1) off = 0; // military: RFC 5322 says treat as -0000
      else off = 0;                      // unknown name: assume UTC
    }
  }
  const ms = Date.UTC(y, mon, d, H, M, Math.min(S, 59)) - off * 60000;
  // Reject impossible calendar days (Date.UTC rolls 31 Feb into March).
  const chk = new Date(Date.UTC(y, mon, d));
  if (chk.getUTCMonth() !== mon) return NaN;
  return ms;
}

// mbox From_ line date: asctime ("Mon Mar  4 11:20:34 2024", UTC per RFC 4155)
// or Gmail's "Mon Mar 04 11:20:34 +0000 2024".
export function parseFromLineDate(line) {
  const m = /^From \S+ +\w{3} (\w{3}) +(\d{1,2}) (\d\d):(\d\d):(\d\d)(?: ([+-]\d{4}))? +(\d{4})/.exec(line || '');
  if (!m) return NaN;
  const mon = MONTHS[m[1].toLowerCase()];
  if (mon === undefined) return NaN;
  let off = 0;
  if (m[6]) off = (m[6][0] === '-' ? -1 : 1) * (+m[6].slice(1, 3) * 60 + +m[6].slice(3, 5));
  return Date.UTC(+m[7], mon, +m[2], +m[3], +m[4], +m[5]) - off * 60000;
}

const MIN_DATE = Date.UTC(1990, 0, 1);
function saneDate(t) { return t >= MIN_DATE && t <= Date.now() + 86400000; }

// ---- RFC 2047 (labels only; postal-mime already decodes addresses) ----------

function decodeWords(s) {
  return String(s).replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=(\s+(?==\?))?/g, (m, cs, enc, txt) => {
    let bytes;
    try {
      if (enc.toUpperCase() === 'B') bytes = Uint8Array.from(atob(txt), c => c.charCodeAt(0));
      else {
        const t = txt.replace(/_/g, ' ');
        const out = [];
        for (let i = 0; i < t.length; i++) {
          if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) { out.push(parseInt(t.slice(i + 1, i + 3), 16)); i += 2; }
          else out.push(t.charCodeAt(i) & 0xff);
        }
        bytes = Uint8Array.from(out);
      }
      let dec;
      try { dec = new TextDecoder(cs.split('*')[0].trim()); } catch { dec = latin1; }
      return dec.decode(bytes);
    } catch { return m; }
  });
}

// ---- helpers ----------------------------------------------------------------

function normAddr(a) {
  if (!a) return '';
  let s = String(a).trim().replace(/^<|>$/g, '').trim();
  if (/^mailto:/i.test(s)) s = s.slice(7);
  return s.toLowerCase();
}

function msgIds(v) {
  if (!v) return [];
  const ids = [...String(v).matchAll(/<([^<>\s]+)>/g)].map(m => m[1]);
  if (ids.length) return ids;
  const t = String(v).trim();
  return t ? t.split(/\s+/) : [];
}

function hash(s) {
  // Two FNV-1a 32-bit passes with different seeds -> 64 bits; only used to
  // dedupe messages that lack a Message-ID.
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(16).padStart(8, '0') + (b >>> 0).toString(16).padStart(8, '0');
}

function expand(list) {
  const out = [];
  for (const a of list || []) {
    if (a && Array.isArray(a.group)) out.push(...expand(a.group));
    else if (a) out.push(a);
  }
  return out;
}

function htmlToText(h) {
  return String(h).replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/[ \t]+/g, ' ').trim();
}

// Header block only (up to the first blank line), for headersOnly mode.
function headerBlock(bytes) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 10 && (bytes[i + 1] === 10 || (bytes[i + 1] === 13 && bytes[i + 2] === 10))) return bytes.subarray(0, i + 1);
  }
  return bytes;
}

const PST_ADVICE = 'Outlook PST/OST/MSG files cannot be read in the browser yet (no parser is available here). Convert the file to mbox first, '
  + 'for example with readpst ("readpst -r -o out mailbox.pst", from libpst), or by importing it into Thunderbird and exporting the folders '
  + 'as mbox with the ImportExportTools NG add-on, then import the mbox files.';

// ---- import -----------------------------------------------------------------

const CONSUMER_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com', 'yahoo.com',
  'ymail.com', 'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.de', 'web.de',
  'mail.com', 'fastmail.com', 'zoho.com', 'yandex.com', 'hey.com']);

async function importEmail(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const opt = { keepText: true, headersOnly: false, excludeLists: false, excludeAutomated: false, includeSpamTrash: false, maxRecipients: 50, egoAddress: '', ...options };
  // The UI offers one choice (`content`) instead of two booleans that could
  // contradict each other; keepText / headersOnly still work for callers.
  if (options.content === 'headers') { opt.headersOnly = true; opt.keepText = false; }
  const groups = { mbox: [], eml: [], pst: [] };
  for (const e of fs.entries) {
    const k = await classify(e);
    if (k === 'mbox') groups.mbox.push(e);
    else if (k === 'eml') groups.eml.push(e);
    else if (k) groups.pst.push(e);
  }
  const all = [...groups.mbox, ...groups.eml, ...groups.pst];
  const takeout = groups.mbox.some(e => /(^|\/)(Takeout\/)?Mail\/[^/]+\.mbox$/i.test(e.rel));
  const variant = takeout ? 'takeout' : groups.mbox.length ? 'mbox' : groups.eml.length ? 'eml' : 'pst';
  builder.beginSource({ format: 'email', family: 'workplace', medium: 'email', view: 'ego', context: 'workplace', tz: 'UTC',
    fileNames: all.map(e => e.rel), egoKey: null, variant });

  if (groups.pst.length) builder.warn('pst-unsupported', PST_ADVICE, groups.pst.length);
  if (!groups.mbox.length && !groups.eml.length) return;

  const st = {
    seen: new Set(),
    names: new Map(),          // address -> Map(name -> count)
    delivered: new Map(), sentFrom: new Map(), recipients: new Map(),
    authorOf: new Map(),       // message key -> sender node, for reply ties
    pending: [],               // replies read before their parent
    threadVis: new Map(),      // context index -> 'direct'|'group'|'unknown'
    opt, builder,
  };
  const total = all.reduce((s, e) => s + (e.size || 0), 0) || 1;
  let done = 0;
  const tick = (n, label) => { done += n; progress(Math.min(0.99, done / total), label); };

  for (const e of groups.mbox) {
    let n = 0;
    let gen;
    try { gen = mboxMessages(e.stream()); } catch (err) { builder.warn('read-error', `Could not read ${e.rel}: ${err.message}`); continue; }
    let pre = 0;
    for await (const m of gen) {
      if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
      pre = m.preamble;
      await handleMessage(st, m.bytes, m.fromLine);
      if (++n % 200 === 0) progress(Math.min(0.99, (done + (e.size || 0) * 0.5) / total), `${e.rel}: ${n} messages`);
    }
    if (pre) builder.warn('mbox-preamble', 'Lines before the first "From " separator were ignored', pre);
    if (!n) builder.warn('empty-mbox', `${e.rel} contained no messages`);
    tick(e.size || 0, e.rel);
  }
  for (const e of groups.eml) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    await handleMessage(st, await e.bytes(), null);
    tick(e.size || 0, e.rel);
  }

  finish(st);
  progress(1, 'done');
}

async function handleMessage(st, bytes, fromLine) {
  const { builder, opt } = st;
  let p;
  try { p = await PostalMime.parse(opt.headersOnly ? headerBlock(bytes) : bytes); }
  catch (err) { builder.warn('parse-error', `A message could not be parsed: ${err.message}`); return; }
  builder.stat('messages-read');
  const H = new Map();
  for (const h of p.headers || []) { if (!H.has(h.key)) H.set(h.key, []); H.get(h.key).push(h.value); }
  const h1 = k => (H.get(k) || [])[0];

  // Gmail labels (Takeout). Comma-separated; localized system labels are not
  // recognised (only the English Spam/Trash/Sent) [UNVERIFIED: quoting of labels with commas].
  const labels = h1('x-gmail-labels') ? decodeWords(h1('x-gmail-labels')).split(',').map(s => s.trim().toLowerCase()) : [];
  if (!opt.includeSpamTrash && (labels.includes('spam') || labels.includes('trash'))) { builder.stat('spam-trash-skipped'); return; }

  // Dedupe on Message-ID (merged mboxes and per-label Takeout files overlap).
  const mid = msgIds(h1('message-id') || p.messageId)[0] || null;
  const dateRaw = h1('date');
  const fromObj = expand(p.from ? [p.from] : [])[0];
  const fromAddr = normAddr(fromObj?.address);
  const key = mid ? `email:${mid}` : `email:h:${hash(`${fromAddr}\n${dateRaw || ''}\n${p.subject || ''}`)}`;
  if (st.seen.has(key)) { builder.stat('duplicates'); return; }
  st.seen.add(key);
  if (!mid) builder.stat('no-message-id');

  if (!fromAddr) { builder.stat('no-sender'); builder.warn('no-sender', 'Messages without a usable From address were skipped'); return; }

  const listRaw = h1('list-id');
  const listId = listRaw ? ((/<([^>]+)>/.exec(listRaw) || [])[1] || listRaw).trim().toLowerCase() : null;
  if (listId && opt.excludeLists) { builder.stat('list-skipped'); return; }
  const prec = (h1('precedence') || '').trim().toLowerCase();
  const auto = (h1('auto-submitted') || '').trim().toLowerCase();
  const automated = /^(bulk|list|junk)$/.test(prec) || (auto && auto !== 'no');
  if (automated) {
    builder.stat('automated');
    if (opt.excludeAutomated) return;
  }

  // Time: Date header, else From_ line, else first Received.
  let t = parseEmailDate(dateRaw);
  if (!saneDate(t)) {
    let fb = parseFromLineDate(fromLine);
    if (!saneDate(fb)) {
      const rec = h1('received');
      fb = rec ? parseEmailDate(rec.slice(rec.lastIndexOf(';') + 1)) : NaN;
    }
    t = saneDate(fb) ? fb : NaN;
    builder.stat('date-fallback');
    builder.warn('date-fallback', 'Messages whose Date header was missing or implausible; time taken from the mbox separator or Received header where possible', 1);
    if (Number.isNaN(t)) builder.stat('no-date');
  }

  // Ego evidence.
  for (const d of H.get('delivered-to') || []) { const a = normAddr(d); if (a) st.delivered.set(a, (st.delivered.get(a) || 0) + 1); }
  if (labels.includes('sent')) st.sentFrom.set(fromAddr, (st.sentFrom.get(fromAddr) || 0) + 1);
  const sender = normAddr(p.sender?.address);
  if (sender && sender !== fromAddr) builder.stat('sender-differs');

  const person = (a, role) => {
    const addr = normAddr(a.address);
    if (!addr || !addr.includes('@')) { builder.stat('invalid-address'); return -1; }
    const name = (a.name || '').trim();
    if (name && normAddr(name) !== addr) {
      let m = st.names.get(addr);
      if (!m) st.names.set(addr, m = new Map());
      m.set(name, (m.get(name) || 0) + 1);
    }
    return builder.node(`email:${addr}`, { attrs: { email: addr, domain: addr.slice(addr.lastIndexOf('@') + 1) }, platformIds: { email: addr } });
  };

  const actor = person(fromObj, 'from');
  if (actor < 0) return;
  const targets = [];
  const seenT = new Set();
  // List mail: the list node stands for the audience instead of the list address.
  let listAddrs = new Set();
  if (listId) {
    const post = msgIds(h1('list-post')).map(normAddr).filter(x => x.includes('@'));
    // Heuristic: list id "dev.lists.example.org" usually posts to dev@lists.example.org.
    listAddrs = new Set([...post, listId.replace('.', '@')]);
    const ln = builder.node(`email:list:${listId}`, { label: listRaw.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || listId, attrs: { is_list: true } });
    targets.push([ln, 'to']); seenT.add(ln);
  }
  let nRecip = 0, self = false;
  for (const [field, role] of [['to', 'to'], ['cc', 'cc'], ['bcc', 'bcc']]) {
    for (const a of expand(p[field])) {
      const addr = normAddr(a.address);
      if (listAddrs.has(addr)) continue;
      const n = person(a, role);
      if (n < 0) continue;
      st.recipients.set(addr, (st.recipients.get(addr) || 0) + 1);
      if (n === actor) { self = true; continue; }
      if (seenT.has(n)) continue; // same person in To and Cc: keep the first (strongest) role
      seenT.add(n); targets.push([n, role]); nRecip++;
    }
  }
  if (self) builder.stat('self-messages');
  if (nRecip > opt.maxRecipients) {
    builder.stat('broadcast-messages');
    builder.warn('broadcast-messages', `Messages with more than ${opt.maxRecipients} recipients (kept; consider capping recipients when building the network)`);
  }

  // Thread context and parent.
  const refs = msgIds(h1('references') || p.references);
  const irt = msgIds(h1('in-reply-to') || p.inReplyTo);
  const thrid = h1('x-gm-thrid');
  const threadKey = thrid ? `email:thread:${thrid.trim()}` : `email:thread:${refs[0] || irt[0] || mid || key.slice(6)}`;
  const vis = listId || nRecip > 1 ? 'group' : nRecip === 1 ? 'direct' : 'unknown';
  const ci = builder.context(threadKey, { name: p.subject ? decodeWords(p.subject) : '(no subject)', kind: 'email_thread', visibility: vis, medium: 'email', members: [actor, ...targets.map(x => x[0])] });
  const prevVis = st.threadVis.get(ci);
  st.threadVis.set(ci, prevVis === 'group' || vis === 'group' ? 'group' : prevVis === 'direct' || vis === 'direct' ? 'direct' : 'unknown');
  const parentId = irt[0] || refs[refs.length - 1] || null;

  let text = null;
  if (opt.keepText && !opt.headersOnly) {
    text = p.text || (p.html ? htmlToText(p.html) : null);
    if (text) builder.stat('with-text');
  }
  const ev = { type: 'message', t, actor, targets, context: ci, key, parentKey: parentId ? `email:${parentId}` : null, text };
  st.authorOf.set(key, actor);
  builder.stat('messages');
  if (listId) builder.stat('list-messages');
  // Reply tie to the parent's sender, known only when the parent is in the
  // mailbox too (spec: "Reply edges: when the parent is present"). Mailboxes
  // are not in time order, so a reply whose parent has not been read yet waits
  // until the end.
  if (ev.parentKey && !st.authorOf.has(ev.parentKey)) { st.pending.push(ev); return; }
  emitWithReply(st, ev);
}

function emitWithReply(st, ev) {
  const pa = ev.parentKey ? st.authorOf.get(ev.parentKey) : undefined;
  if (pa !== undefined && pa !== ev.actor) ev.targets.push([pa, 'reply']);
  st.builder.event(ev);
}

function finish(st) {
  const { builder, opt } = st;
  for (const ev of st.pending) emitWithReply(st, ev);
  st.pending.length = 0;
  // Most frequent display name per address becomes the label.
  for (const [addr, m] of st.names) {
    const i = builder.nodeIndex(`email:${addr}`);
    if (i < 0) continue;
    let best = null, bc = 0;
    for (const [n, c] of m) if (c > bc) { best = n; bc = c; }
    if (best) builder.setLabel(i, best);
  }
  // Thread visibility is the widest seen over the thread's messages. The
  // builder keeps the first value it was given, so fix it up here.
  for (const [ci, v] of st.threadVis) builder.setVisibility(ci, v);

  // Ego: explicit option, else Delivered-To, else From of Sent-labelled mail,
  // else the most frequent recipient (weakest evidence, flagged).
  const top = m => { let b = null, c = 0; for (const [k, v] of m) if (v > c) { b = k; c = v; } return b; };
  let ego = normAddr(opt.egoAddress) || null, how = 'option';
  if (!ego) { ego = top(st.delivered); how = 'delivered-to'; }
  if (!ego) { ego = top(st.sentFrom); how = 'sent-label'; }
  if (!ego) { ego = top(st.recipients); how = 'most-frequent-recipient'; }
  if (ego) {
    const key = `email:${ego}`;
    builder.node(key, { attrs: { email: ego, domain: ego.slice(ego.lastIndexOf('@') + 1), is_ego: true }, platformIds: { email: ego } });
    builder.source.egoKey = key;
    builder.source.egoInferredFrom = how;
    // A consumer mailbox is someone's personal mail, not a workplace's; the
    // report and the methods appendix describe the source by this context.
    if (CONSUMER_DOMAINS.has(ego.slice(ego.lastIndexOf('@') + 1))) { builder.source.context = 'personal'; builder.source.family = 'personal'; }
    if (how === 'most-frequent-recipient') builder.warn('ego-guessed', `The mailbox owner was guessed as ${ego} (the most frequent recipient). Set "Your email address" in the import options if this is wrong.`);
  } else {
    builder.warn('ego-unknown', 'Could not tell whose mailbox this is. Set "Your email address" in the import options.');
  }
  // Say what the options left out, so a file named "Including Spam and Trash"
  // or a missing newsletter is not a surprise.
  const c = builder.source.counts;
  const named = (builder.source.fileNames || []).some(f => /spam and trash/i.test(f));
  if (!opt.includeSpamTrash && (c['spam-trash-skipped'] || named)) builder.warn('spam-trash-excluded', `Messages labelled Spam or Trash are left out${named ? ', although the Takeout file name says "Including Spam and Trash"' : ''} (${c['spam-trash-skipped'] || 'none'} found). Tick "Include Gmail Spam and Trash" to keep them.`, c['spam-trash-skipped'] || 0);
  // Kept by default (the generator's round trip and earlier projects rely on
  // it), so say how much of the mailbox is newsletters and notifications.
  if (c.automated) {
    if (opt.excludeAutomated) builder.warn('automated-excluded', 'Bulk and automated messages (newsletters, notifications) were left out. Untick "Leave out bulk and automated mail" to keep them.', c.automated);
    else builder.warn('automated-included', 'Bulk and automated messages (newsletters, notifications) are included and tie you to their senders. Tick "Leave out bulk and automated mail" to drop them.', c.automated);
  }
}

export default {
  id: 'email',
  label: 'Email (mbox, Gmail Takeout, .eml)',
  family: 'workplace',
  detect,
  options: [
    { key: 'egoAddress', label: 'Your email address (helps recognize you; leave blank to work it out from the mail)', type: 'string', default: '' },
    { key: 'content', label: 'Message content', type: 'choice', default: 'text', choices: [{ value: 'text', label: 'Keep message text' }, { value: 'headers', label: 'Headers only (faster, no text)' }] },
    { key: 'excludeLists', label: 'Leave out mailing-list mail', type: 'boolean', default: false },
    { key: 'excludeAutomated', label: 'Leave out bulk and automated mail', type: 'boolean', default: false },
    { key: 'includeSpamTrash', label: 'Include Gmail Spam and Trash', type: 'boolean', default: false },
    { key: 'maxRecipients', label: 'Flag messages with more recipients than', type: 'number', default: 50 },
  ],
  import: importEmail,
};
