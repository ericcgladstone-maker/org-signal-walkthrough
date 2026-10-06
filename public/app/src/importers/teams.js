// Microsoft Teams (docs/formats/teams.md). Three unrelated inputs:
//
//   A. Microsoft Graph chatMessage JSON (saved API responses or dumps). High
//      confidence: the schema is documented. No official file layout exists,
//      so we accept a single page {value:[...]}, an array of pages, a flat
//      array, or NDJSON, plus optional chats.json and members files.
//   B. Teams Free (personal) export: a .tar holding messages.json. Medium
//      confidence: the schema comes from the Skype export lineage, not from
//      Microsoft documentation. Ego view.
//   C. Purview eDiscovery Items.csv. Low resolution: one row per transcript
//      with a Participants list, so it yields co-participation only, never
//      who wrote to whom.

import { peek } from '../core/fileset.js';
import { UploadError } from '../core/upload.js';
import { parseCSV, rowsToObjects, entryText, parseTimestamp } from './tabular.js';

function aborted(signal) {
  if (signal?.aborted) { const e = new Error('Import cancelled'); e.name = 'AbortError'; throw e; }
}

// ---- time ------------------------------------------------------------------

// Graph times are ISO 8601 UTC. One documented example drops the 'T'
// (`2021-03-1706:47:05.123Z`), so repair that shape before parsing.
export function parseGraphTime(s) {
  if (typeof s !== 'string') return NaN;
  let v = s.trim();
  const bad = /^(\d{4})-(\d{2})-(\d{2})(\d{2}):(\d{2})/.exec(v);
  if (bad) v = `${bad[1]}-${bad[2]}-${bad[3]}T${v.slice(10)}`;
  return parseTimestamp(v, 'iso', 'UTC');
}

// ---- HTML -> text ------------------------------------------------------------

const ENT = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" };
function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<at\b[^>]*>(.*?)<\/at>/gis, (m, n) => '@' + n.replace(/<[^>]*>/g, ''))
    .replace(/<(br|\/p|\/div|\/li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (m, e) => {
      if (e[0] === '#') { const cp = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
      return ENT[e.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// ---- tar ---------------------------------------------------------------------

// Minimal streaming tar reader: ustar, pax ('x' path=) and GNU long names ('L').
// Reads 512-byte headers sequentially, keeps only the bodies `want(name)` asks
// for and skips the rest, so media folders never sit in memory.
class ByteReader {
  constructor(stream) { this.r = stream.getReader(); this.chunks = []; this.len = 0; this.done = false; }
  async fill(n) {
    while (this.len < n && !this.done) {
      const { done, value } = await this.r.read();
      if (done) { this.done = true; break; }
      if (value?.length) { this.chunks.push(value); this.len += value.length; }
    }
    return this.len >= n;
  }
  take(n) {
    const out = new Uint8Array(n);
    let o = 0;
    while (o < n) {
      const c = this.chunks[0];
      const k = Math.min(c.length, n - o);
      out.set(c.subarray(0, k), o); o += k;
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
    }
    this.len -= n;
    return out;
  }
  async read(n) { if (!(await this.fill(n))) return null; return this.take(n); }
  async skip(n) {
    while (n > 0) {
      if (!this.len && !(await this.fill(1))) return false;
      const c = this.chunks[0];
      const k = Math.min(c.length, n);
      if (k === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(k);
      this.len -= k; n -= k;
    }
    return true;
  }
  cancel() { this.r.cancel().catch(() => {}); }
}

const latin = new TextDecoder('latin1');
const utf8 = new TextDecoder('utf-8');
function cstr(b, o, n) { let e = o; while (e < o + n && b[e]) e++; return utf8.decode(b.subarray(o, e)); }
function octal(b, o, n) {
  // GNU base-256 for sizes over 8 GB: high bit of the first byte set.
  if (b[o] & 0x80) { let v = b[o] & 0x7f; for (let i = 1; i < n; i++) v = v * 256 + b[o + i]; return v; }
  const s = latin.decode(b.subarray(o, o + n)).replace(/\0.*$/s, '').trim();
  return s ? parseInt(s, 8) : 0;
}

export async function* tarEntries(stream, want = () => true) {
  const br = new ByteReader(stream);
  let longName = null, paxPath = null;
  try {
    for (;;) {
      const h = await br.read(512);
      if (!h) return;
      if (h.every(x => x === 0)) return; // end-of-archive marker
      // Checksum: sum of header bytes with the checksum field read as spaces.
      let sum = 0;
      for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i];
      if (sum !== octal(h, 148, 8)) throw new Error('Not a tar archive, or the tar file is corrupt (header checksum mismatch).');
      const size = octal(h, 124, 12);
      const type = String.fromCharCode(h[156] || 48);
      const magic = latin.decode(h.subarray(257, 262));
      let name = cstr(h, 0, 100);
      if (magic === 'ustar') { const prefix = cstr(h, 345, 155); if (prefix) name = prefix + '/' + name; }
      const padded = Math.ceil(size / 512) * 512;
      if (type === 'L' || type === 'x' || type === 'g') {
        const body = await br.read(padded);
        if (!body) throw new Error('Truncated tar archive.');
        const data = body.subarray(0, size);
        if (type === 'L') longName = cstr(data, 0, data.length);
        else if (type === 'x') {
          // Records: "<len> key=value\n"
          const s = utf8.decode(data);
          let p = 0;
          while (p < s.length) {
            const sp = s.indexOf(' ', p); if (sp < 0) break;
            const len = parseInt(s.slice(p, sp), 10); if (!(len > 0)) break;
            const rec = s.slice(sp + 1, p + len - 1);
            const eq = rec.indexOf('=');
            if (rec.slice(0, eq) === 'path') paxPath = rec.slice(eq + 1);
            p += len;
          }
        }
        continue;
      }
      if (paxPath) name = paxPath; else if (longName) name = longName;
      paxPath = null; longName = null;
      const isFile = type === '0' || type === '\0' || type === '7';
      if (isFile && want(name)) {
        const body = await br.read(padded);
        if (!body) throw new Error('Truncated tar archive.');
        yield { name, size, type: 'file', data: body.subarray(0, size) };
      } else {
        if (!(await br.skip(padded))) throw new Error('Truncated tar archive.');
        yield { name, size, type: isFile ? 'file' : type === '5' ? 'dir' : 'other', data: null };
      }
    }
  } finally { br.cancel(); }
}

// ---- detection ------------------------------------------------------------------

// Graph JSON as the REST API returns it (camelCase), or as Microsoft Graph
// PowerShell writes SDK objects with ConvertTo-Json (PascalCase).
const looksGraph = s => /"messageType"\s*:/.test(s) && /"createdDateTime"\s*:/.test(s) && /"from"\s*:/.test(s)
  || /"MessageType"\s*:/.test(s) && /"CreatedDateTime"\s*:/.test(s) && /"From"\s*:/.test(s)
  || /"@odata\.context"\s*:\s*"[^"]*(\/messages|getAllMessages|#Collection\((microsoft\.graph\.)?chatMessage\))/.test(s);
const looksChats = s => /"[cC]hatType"\s*:/.test(s);
// The channel list response (GET /teams/{id}/channels) has no @odata.context in
// Microsoft's examples; membershipType is what marks it.
const looksChannels = s => /"membershipType"\s*:/.test(s);
// Purview items report: CamelCase names (review set docs) or display names
// with spaces (the new eDiscovery experience): "Conversation ID", "Participants".
const purviewHeader = first => { const h = first.toLowerCase().replace(/["\s_]/g, ''); return /conversationid/.test(h) && /participants/.test(h); };
const looksMembers = s => /conversationMember|"@odata\.context"\s*:\s*"[^"]*\/members/.test(s) || (/"userId"\s*:/.test(s) && /"roles"\s*:/.test(s));
const looksFree = s => /"userId"\s*:/.test(s) && /"exportDate"\s*:/.test(s) || /"MessageList"\s*:/.test(s);

async function detect(fs) {
  const files = [];
  const summaries = [];
  const reasons = new Set();
  let score = 0;
  let checked = 0;
  const unchecked = [], graphDirs = new Set();
  const dirOf = rel => rel.slice(0, rel.lastIndexOf('/') + 1);
  for (const e of fs.entries) {
    const rel = e.rel;
    if (/\.tar$/i.test(rel)) {
      const head = await peek(e, 1024);
      // ustar magic at 257, or a messages.json name in the first header.
      if (head.slice(257, 262) === 'ustar' || /messages\.json/.test(head)) { files.push(rel); score = Math.max(score, 0.8); reasons.add('Teams Free export (.tar)'); }
      continue;
    }
    if (/(^|\/)items(_[^/]*)?\.csv$/i.test(rel)) {
      const head = await peek(e, 4096);
      const first = head.replace(/^﻿/, '').split(/\r?\n/)[0];
      if (purviewHeader(first)) { files.push(rel); score = Math.max(score, 0.8); reasons.add('Purview eDiscovery Items.csv (Teams)'); }
      continue;
    }
    // The process report's Summary.csv without Items.csv (the items report
    // was not downloaded, or was left out of the upload).
    if (/(^|\/)summary(_[^/]*)?\.csv$/i.test(rel)) {
      const first = (await peek(e, 1024)).replace(/^﻿/, '').split(/\r?\n/)[0].toLowerCase().replace(/["\s]/g, '');
      if (/^location,itemcount/.test(first)) { summaries.push(rel); continue; }
    }
    if (!/\.(json|ndjson|jsonl)$/i.test(rel)) continue;
    if (/\/\d{4}-\d{2}-\d{2}\.json$/.test(rel)) continue; // Slack day files: never Teams, and there can be thousands
    // Keep detection cheap on huge drops: only the first 400 JSON files are
    // opened. One-file-per-message dumps (archive/data/<chat>/msg_<id>.json)
    // easily exceed that, so the rest are claimed below when they sit in a
    // folder where Graph messages were found.
    if (checked++ > 400) { unchecked.push(e); continue; }
    const head = await peek(e, 4096);
    if (/(^|\/)messages\.json$/i.test(rel) && looksFree(head)) { files.push(rel); score = Math.max(score, 0.85); reasons.add('Teams Free export (messages.json)'); }
    else if (looksGraph(head)) { files.push(rel); graphDirs.add(dirOf(rel)); score = Math.max(score, 0.9); reasons.add('Microsoft Graph Teams messages'); }
    else if (looksChats(head) || looksChannels(head) || (/(^|\/)members\//i.test(rel) && looksMembers(head))) files.push(rel);
  }
  if (!score) {
    // Lists of chats or channels without any message file, or an eDiscovery
    // Summary.csv without Items.csv: claimed so the import can say what is missing.
    if (files.length) return { score: 0.6, reason: 'Teams chat or channel list without messages', files };
    if (summaries.length) return { score: 0.6, reason: 'Purview eDiscovery summary without Items.csv', files: summaries };
    return { score: 0, reason: '' };
  }
  // Past the cap: one file is opened per folder not seen yet.
  const dirLooks = new Map();
  for (const e of unchecked) {
    const d = dirOf(e.rel);
    if (/(^|\/)messages\.json$/i.test(e.rel)) continue;
    if (!graphDirs.has(d) && !dirLooks.has(d)) dirLooks.set(d, dirLooks.size < 2000 && looksGraph(await peek(e, 4096)));
    if (graphDirs.has(d) || dirLooks.get(d)) files.push(e.rel);
  }
  return { score, reason: [...reasons].join('; '), files };
}

// ---- Graph JSON ------------------------------------------------------------------

async function readJsonish(entry) {
  const text = await entry.text();
  try { return { data: normalizeKeys(JSON.parse(text)), ndjson: false }; }
  catch {
    const out = [];
    for (const line of text.split(/\r?\n/)) { const l = line.trim(); if (!l) continue; try { out.push(JSON.parse(l)); } catch { return { data: null }; } }
    return { data: normalizeKeys(out), ndjson: true };
  }
}

// Microsoft Graph PowerShell (Get-MgChatMessage ... | ConvertTo-Json) writes the
// SDK's objects: PascalCase names, derived-type fields (userId, email of a
// member) in an AdditionalProperties bag, and depending on the PowerShell
// version, enums as numbers and dates as "/Date(ms)/". [UNVERIFIED against a
// real dump; derived from the SDK's model shape.] Converted back to the REST shape.
const ENUMS = {
  messageType: ['message', 'chatEvent', 'typing', 'unknownFutureValue', 'systemEventMessage'],
  chatType: ['oneOnOne', 'group', 'meeting', 'unknownFutureValue'],
  membershipType: ['standard', 'private', 'unknownFutureValue', 'shared'],
  userIdentityType: ['aadUser', 'onPremiseAadUser', 'anonymousGuest', 'federatedUser', 'personalMicrosoftAccountUser', 'skypeUser', 'phoneUser', 'unknownFutureValue', 'emailUser', 'azureCommunicationServicesUser'],
};
function isPascal(x, depth = 0) {
  if (Array.isArray(x)) return x.length > 0 && depth < 3 && isPascal(x[0], depth + 1);
  return !!x && typeof x === 'object' && 'Id' in x && ('MessageType' in x || 'ChatType' in x || 'ChatId' in x || 'MembershipType' in x);
}
function camelize(x, key) {
  if (Array.isArray(x)) return x.map(v => camelize(v));
  if (x && typeof x === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(x)) {
      if (k === 'AdditionalProperties') continue;
      const ck = k[0] === '@' ? k : k[0].toLowerCase() + k.slice(1);
      out[ck] = camelize(v, ck);
    }
    const extra = x.AdditionalProperties;
    if (extra && typeof extra === 'object') for (const [k, v] of Object.entries(extra)) if (out[k] == null) out[k] = camelize(v, k);
    return out;
  }
  if (typeof x === 'number' && ENUMS[key]) return ENUMS[key][x] ?? String(x);
  if (typeof x === 'number' && key === 'contentType') return x === 1 ? 'html' : 'text';
  if (typeof x === 'string') { const m = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/.exec(x); if (m) return new Date(+m[1]).toISOString(); }
  return x;
}
function normalizeKeys(data) { return isPascal(data) ? camelize(data) : data; }

// Flatten the accepted container shapes into items, each with the
// @odata.context of the page it came from (a trimmed or $select-ed message may
// name its chat or channel only there), plus every context seen (they name the
// chat for members pages). Channel roots fetched with $expand=replies carry
// their replies nested in `replies`; those are items too.
function flatten(data) {
  const items = [], contexts = [];
  const push = (it, ctx) => {
    if (!it || typeof it !== 'object' || Array.isArray(it)) return;
    items.push({ it, ctx });
    if (Array.isArray(it.replies)) for (const r of it.replies) push(r, ctx);
  };
  const visit = (x, depth, ctx) => {
    if (!x || typeof x !== 'object' || depth > 3) return;
    if (Array.isArray(x)) { for (const y of x) visit(y, depth + 1, ctx); return; }
    const c = typeof x['@odata.context'] === 'string' ? x['@odata.context'] : ctx;
    if (c && c !== ctx) contexts.push(c);
    if (Array.isArray(x.value)) { for (const y of x.value) push(y, c); return; }
    push(x, c);
  };
  visit(data, 0, null);
  return { items, contexts };
}

// Conversation named by a messages page's @odata.context:
//   ...$metadata#chats('19%3A...%40thread.v2')/messages
//   ...$metadata#teams('<team>')/channels('19%3A...%40thread.tacv2')/messages('<root>')/replies
function conversationFromContext(ctx) {
  if (!ctx) return null;
  const dec = s => { try { return decodeURIComponent(s); } catch { return s; } };
  let m = /chats\('([^']+)'\)\/messages/.exec(ctx);
  if (m) return { chatId: dec(m[1]) };
  m = /teams\('([^']+)'\)\/channels\('([^']+)'\)\/messages(?:\('([^']+)'\)\/replies)?/.exec(ctx);
  if (m) return { channelIdentity: { teamId: dec(m[1]), channelId: dec(m[2]) }, replyToId: m[3] ? dec(m[3]) : null };
  return null;
}

function chatIdFromContext(ctxs) {
  for (const c of ctxs) {
    const m = /chats\('([^']+)'\)/.exec(c);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

async function importGraph(fs, entries, { builder, options, progress, signal }) {
  const messages = [];
  const chats = new Map();     // chatId -> chat resource
  const members = new Map();   // chatId -> [{ userId, displayName, email }]
  const channels = new Map();  // teamId/channelId -> { membershipType, displayName }
  let odataAll = false;
  let n = 0, unusedFiles = 0;
  for (const e of entries) {
    aborted(signal);
    progress(0.1 + 0.4 * (n++ / entries.length), `Teams: reading ${e.rel}`);
    const { data } = await readJsonish(e);
    if (data == null) { builder.warn('teams-bad-json', 'A Teams JSON file could not be parsed and was skipped.'); continue; }
    const { items, contexts } = flatten(data);
    if (contexts.some(c => /getAllMessages/.test(c))) odataAll = true;
    const memberChat = chatIdFromContext(contexts.filter(c => /\/members/.test(c)))
      ?? (/(^|\/)members\/([^/]+)\.json$/i.exec(e.rel) ? decodeURIComponent(/(^|\/)members\/([^/]+)\.json$/i.exec(e.rel)[2]) : null);
    let used = 0;
    for (const { it, ctx } of items) {
      if ('messageType' in it || ('createdDateTime' in it && 'from' in it && 'body' in it)) {
        if (!it.chatId && !it.channelIdentity) {
          const conv = conversationFromContext(ctx);
          if (conv) { Object.assign(it, conv.chatId ? { chatId: conv.chatId } : { channelIdentity: conv.channelIdentity }); if (conv.replyToId && !it.replyToId) it.replyToId = conv.replyToId; builder.stat('conversation-from-page-context'); }
        }
        messages.push(it); used++;
      } else if ('chatType' in it) {
        chats.set(it.id, it); used++;
        if (Array.isArray(it.members)) members.set(it.id, it.members); // $expand=members
      } else if ('membershipType' in it && it.id) { channels.set(it.id, it); used++; }
      else if (('userId' in it || /conversationMember/.test(it['@odata.type'] || '')) && memberChat) {
        if (!members.has(memberChat)) members.set(memberChat, []);
        members.get(memberChat).push(it); used++;
      }
    }
    if (!used) unusedFiles++;
  }
  if (unusedFiles) builder.warn('teams-file-not-recognised', 'Some JSON files next to the Teams data hold no messages, chats, members or channels (image lists, settings, other tools\' metadata) and were not used.', unusedFiles);

  const chatOnly = messages.every(m => !m.channelIdentity);
  // A delegated /me/chats dump is one person's chats (ego view); the admin
  // Export APIs (getAllMessages) or channel dumps cover a team or tenant.
  let view = options.view && options.view !== 'auto' ? options.view : (odataAll || !chatOnly ? 'full' : 'ego');

  const userNode = (u, extra = {}) => {
    const attrs = { name: u.displayName || undefined, identity_type: u.userIdentityType, tenant_id: u.tenantId, external: u.userIdentityType === 'federatedUser' ? true : undefined, email: u.email ? String(u.email).toLowerCase() : undefined, ...extra };
    return builder.node('teams:' + u.id, { label: u.displayName || undefined, attrs, platformIds: { teams: u.id } });
  };
  const appNode = (a) => builder.node('teams:app:' + a.id, { label: a.displayName || undefined, isBot: true, platformIds: { teams: a.id }, attrs: { name: a.displayName || undefined } });

  // Members per chat (node indices).
  const memberIdx = new Map();
  for (const [cid, list] of members) {
    memberIdx.set(cid, list.filter(m => m.userId || m.id).map(m => userNode({ id: m.userId || m.id, displayName: m.displayName, email: m.email })));
  }

  // De-duplicate (export APIs return a copy per participant's mailbox).
  const seen = new Set();
  const uniq = [];
  for (const m of messages) {
    const cid = m.chatId || (m.channelIdentity ? m.channelIdentity.teamId + '/' + m.channelIdentity.channelId : null);
    const k = cid + '|' + m.id;
    if (seen.has(k)) { builder.stat('duplicates-skipped'); continue; }
    seen.add(k);
    uniq.push({ m, cid, t: parseGraphTime(m.createdDateTime) });
  }
  uniq.sort((a, b) => (a.t || 0) - (b.t || 0));

  // Senders seen per chat, for chats without a member list.
  const sendersSeen = new Map();
  const author = new Map(); // ctx|id -> node index
  const realMsgs = [];
  for (const x of uniq) {
    const { m } = x;
    if (m.messageType && m.messageType !== 'message') { builder.stat('system-events-skipped'); continue; }
    const from = m.from;
    if (!from || (!from.user && !from.application)) { builder.stat('system-events-skipped'); continue; }
    if (m.deletedDateTime) builder.stat('deleted-messages');
    x.actor = from.user?.id ? userNode(from.user) : appNode(from.application);
    if (!from.user?.id) builder.stat('bot-messages');
    if (x.cid == null) { builder.warn('teams-no-conversation', 'Some messages name neither a chat nor a channel and were skipped.'); continue; }
    if (m.chatId) {
      if (!sendersSeen.has(m.chatId)) sendersSeen.set(m.chatId, new Set());
      sendersSeen.get(m.chatId).add(x.actor);
    }
    author.set(x.cid + '|' + m.id, x.actor);
    realMsgs.push(x);
  }

  // Contexts.
  const ctxIdx = new Map();
  let inferredType = 0, unknownChannel = 0, inferredMembers = 0;
  const context = (x) => {
    if (ctxIdx.has(x.cid)) return ctxIdx.get(x.cid);
    const m = x.m;
    let ci;
    if (m.chatId) {
      const chat = chats.get(m.chatId);
      let mem = memberIdx.get(m.chatId);
      // A 1:1 chat id names both members: 19:<userId>_<userId>@unq.gbl.spaces.
      const pair = /^19:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})@unq\.gbl\.spaces$/i.exec(m.chatId);
      if (!mem && pair) { mem = [userNode({ id: pair[1] }), userNode({ id: pair[2] })]; memberIdx.set(m.chatId, mem); builder.stat('members-from-chat-id'); }
      if (!mem) { mem = [...(sendersSeen.get(m.chatId) || [])]; inferredMembers++; }
      let type = chat?.chatType;
      if (!type) {
        // [UNVERIFIED id patterns] 1:1 chat ids end in @unq.gbl.spaces; meeting chats start 19:meeting_.
        type = /@unq\.gbl\.spaces$/i.test(m.chatId) ? 'oneOnOne' : /^19:meeting_/i.test(m.chatId) ? 'meeting' : mem.length === 2 ? 'oneOnOne' : 'group';
        inferredType++;
      }
      const kind = type === 'oneOnOne' ? 'dm' : type === 'meeting' ? 'meeting' : 'group_dm';
      ci = builder.context('teams:' + m.chatId, { name: chat?.topic || (type === 'oneOnOne' ? 'Teams 1:1 chat' : 'Teams group chat'), kind, visibility: type === 'oneOnOne' ? 'direct' : 'group', medium: 'teams', members: mem });
      x.members = mem;
    } else {
      const ch = channels.get(m.channelIdentity.channelId);
      // Channel privacy needs the channel resource's membershipType; without it we do not guess.
      const vis = ch ? (ch.membershipType === 'standard' ? 'public' : 'private') : 'unknown';
      if (!ch) unknownChannel++;
      ci = builder.context('teams:' + x.cid, { name: ch?.displayName || 'Teams channel', kind: 'channel', visibility: vis, medium: 'teams' });
    }
    ctxIdx.set(x.cid, ci);
    return ci;
  };

  let i = 0;
  for (const x of realMsgs) {
    if ((++i & 1023) === 0) { aborted(signal); progress(0.5 + 0.5 * i / realMsgs.length, 'Teams: messages'); }
    const { m } = x;
    const ci = context(x);
    const mem = m.chatId ? memberIdx.get(m.chatId) || [...(sendersSeen.get(m.chatId) || [])] : null;
    const targets = [];
    const used = new Set();
    const add = (n, r) => { if (n === x.actor || used.has(n + r)) return; used.add(n + r); targets.push([n, r]); };
    if (mem) for (const n of mem) add(n, 'dm');
    // In a 1:1 chat a mention of the partner repeats the dm tie; in group chats it singles someone out.
    const oneOnOne = mem && builder.contexts.kinds[ci] === 'dm';
    let parentKey = null;
    if (m.replyToId && m.replyToId !== m.id) {
      parentKey = `teams:${x.cid}:${m.replyToId}`;
      const pa = author.get(x.cid + '|' + m.replyToId);
      if (pa !== undefined && pa !== x.actor) add(pa, 'reply');
      else builder.warn('teams-reply-parent-absent', 'Some channel replies point to a root post that is not in the data, so no reply tie was drawn for them (Graph replies do not name the root author).');
    }
    // Chats have no replyToId; a reply is a quote: an attachment of type
    // messageReference whose content (a JSON string) names the quoted message
    // and its sender. In a 1:1 chat the reply only repeats the dm tie.
    for (const a of m.attachments || []) {
      if (a?.contentType !== 'messageReference') continue;
      let ref = null;
      try { ref = typeof a.content === 'string' ? JSON.parse(a.content) : a.content; } catch { ref = null; }
      const qid = ref?.messageId || a.id;
      if (!qid) continue;
      builder.stat('quoted-replies');
      if (!parentKey) parentKey = `teams:${x.cid}:${qid}`;
      const su = ref?.messageSender?.user;
      const pa = author.get(x.cid + '|' + qid) ?? (su?.id ? userNode(su) : undefined);
      if (pa !== undefined && !oneOnOne) add(pa, 'reply');
    }
    for (const mn of m.mentions || []) {
      const t = mn?.mentioned;
      const who = t?.user?.id ? userNode(t.user) : t?.application?.id ? appNode(t.application) : -1;
      if (who >= 0) { if (!(oneOnOne && used.has(who + 'dm'))) add(who, 'mention'); }
      else if (t) builder.stat('broadcast-mentions'); // team, channel, chat or tag: audience-wide
    }
    const key = `teams:${x.cid}:${m.id}`;
    const text = m.body?.contentType === 'html' ? htmlToText(m.body.content) : (m.body?.content ?? '');
    builder.event({ type: 'message', t: x.t, actor: x.actor, targets, context: ci, key, parentKey, text: text || null });
    builder.stat('messages');
    if (!Number.isFinite(x.t)) builder.warn('teams-bad-time', 'Some messages have an unreadable createdDateTime; their time is unknown.');
    for (const r of m.reactions || []) {
      const u = r?.user?.user;
      if (!u?.id) continue;
      const rt = parseGraphTime(r.createdDateTime);
      builder.event({ type: 'reaction', t: Number.isFinite(rt) ? rt : x.t, actor: userNode(u), targets: [[x.actor, 'subject']], context: ci, parentKey: key, text: r.reactionType || null });
      builder.stat('reactions');
    }
  }
  if (inferredType) builder.warn('teams-chat-type-inferred', 'Some chats had no chat record (chats.json), so whether they are 1:1, group or meeting chats was inferred from their id or size.', inferredType);
  if (inferredMembers) builder.warn('teams-members-inferred', 'Some chats had no member list, so their members were inferred from who posted. People who only read are missing, which weakens these ties.', inferredMembers);
  if (unknownChannel) builder.warn('teams-channel-visibility-unknown', 'Channel privacy (standard, private or shared) is not in message data; these channels are marked unknown.', unknownChannel);

  // Ego for a single person's chat dump: the one person in every chat.
  let egoKey = null;
  if (view === 'ego') {
    const sets = [...ctxIdx.keys()].map(cid => new Set(memberIdx.get(cid) || sendersSeen.get(cid) || []));
    if (sets.length) {
      const common = [...sets[0]].filter(n => sets.every(s => s.has(n)));
      if (common.length === 1) egoKey = builder.nodes.keys[common[0]];
    }
    if (!egoKey) builder.warn('teams-ego-unknown', 'These look like one person\'s chats, but whose could not be determined; set it in the import options if needed.');
  }
  return { view, egoKey };
}

// ---- Teams Free messages.json -------------------------------------------------------

function mri(s) {
  if (typeof s !== 'string') return null;
  // `from` is sometimes a contacts URL ending in the MRI.
  const i = s.lastIndexOf('/');
  return i >= 0 && /^https?:/i.test(s) ? s.slice(i + 1) : s;
}

// properties.emotions: an array, or the same array as a JSON string, of
// { key: 'like' | 'heart' | ..., users: [{ mri, time (epoch ms), value }] }.
function freeEmotions(props) {
  let e = props?.emotions;
  if (typeof e === 'string') { try { e = JSON.parse(e); } catch { e = null; } }
  return Array.isArray(e) ? e.filter(x => x && Array.isArray(x.users)) : [];
}

function importFree(doc, { builder }) {
  const owner = mri(doc.userId);
  const ownerIdx = owner ? builder.node('teams:' + owner, { platformIds: { teams: owner }, attrs: { is_ego: true } }) : -1;
  let inferred = 0, special = 0;
  const seen = new Set();
  for (const conv of doc.conversations || []) {
    const id = conv.id;
    if (!id) continue;
    const list = conv.MessageList || [];
    // 48: ids are the account's own lists (48:calllogs, 48:notes, 48:drafts...),
    // not conversations with anyone.
    if (/^48:/.test(id)) { special += list.length; builder.stat('special-lists-skipped'); continue; }
    // 1:1 conversations are keyed by the partner's MRI: 8: people, 28: bots.
    const direct = /^(8|28):/.test(id);
    // threadProperties.members is a JSON string, not an array; some exports
    // have an array of { MemberMri } objects instead.
    let memberIds = [];
    const tm = conv.threadProperties?.members;
    if (typeof tm === 'string') { try { memberIds = JSON.parse(tm); } catch { memberIds = []; } }
    else if (Array.isArray(tm)) memberIds = tm;
    memberIds = memberIds.map(x => (x && typeof x === 'object' ? x.MemberMri ?? x.mri ?? x.id : x));
    if (direct) memberIds = [owner, id]; // a 1:1 conversation id is the partner's MRI
    if (!memberIds.filter(Boolean).length) {
      memberIds = [...new Set([owner, ...list.map(m => mri(m.from))].filter(Boolean))];
      inferred++;
    }
    const nodeFor = (k, name) => builder.node('teams:' + k, { label: name || undefined, platformIds: { teams: k }, isBot: /^28:/.test(k) || undefined, attrs: { name: name || undefined } });
    const memIdx = [...new Set(memberIds.map(mri).filter(Boolean))].map(k => nodeFor(k, k === id && direct ? conv.displayName : null));
    const ci = builder.context('teams:' + id, { name: conv.displayName || conv.threadProperties?.topic || (direct ? 'Teams 1:1 chat' : 'Teams group chat'), kind: direct ? 'dm' : 'group_dm', visibility: direct ? 'direct' : 'group', medium: 'teams', members: memIdx });
    for (const m of list) {
      const k = id + '|' + m.id;
      if (seen.has(k)) { builder.stat('duplicates-skipped'); continue; }
      seen.add(k);
      const type = String(m.messagetype || '');
      if (!/^(RichText|Text)/.test(type)) { builder.stat('system-events-skipped'); continue; }
      const from = mri(m.from);
      if (!from) continue;
      const actor = nodeFor(from, m.displayName);
      const used = new Set();
      const targets = [];
      const add = (n, r) => { if (n === actor || used.has(n + r)) return; used.add(n + r); targets.push([n, r]); };
      for (const n of memIdx) add(n, 'dm');
      const content = String(m.content ?? '');
      // <quote author="8:x" messageid="..."> is a reply; <at id="8:x">Name</at> a
      // mention. In a 1:1 chat both only repeat the dm tie.
      let parentKey = null;
      const qm = /<quote\b[^>]*>/i.exec(content);
      if (qm) {
        const qa = /\bauthor="([^"]+)"/.exec(qm[0])?.[1], qid = /\bmessageid="([^"]+)"/.exec(qm[0])?.[1];
        if (qid) parentKey = `teams:${id}:${qid}`;
        if (qa && !direct) add(nodeFor(qa, /\bauthorname="([^"]*)"/.exec(qm[0])?.[1]), 'reply');
        builder.stat('quoted-replies');
      }
      if (!direct) for (const [, who] of content.matchAll(/<at\b[^>]*\bid="(\d+:[^"]+)"/gi)) add(nodeFor(who), 'mention');
      if (m.properties?.deletetime) builder.stat('deleted-messages');
      const key = `teams:${id}:${m.id}`;
      // Quoted text repeats the earlier message; leave it out of this one's text.
      const own = content.replace(/<quote\b[\s\S]*?<\/quote>/gi, ' ');
      const t = parseGraphTime(m.originalarrivaltime);
      builder.event({ type: 'message', t, actor, targets, context: ci, key, parentKey, text: /^RichText\/(Media|UriObject)/.test(type) ? null : htmlToText(own) || null });
      builder.stat('messages');
      for (const em of freeEmotions(m.properties)) {
        for (const u of em.users) {
          const who = mri(u?.mri);
          if (!who) continue;
          const rt = Number(u.time);
          builder.event({ type: 'reaction', t: Number.isFinite(rt) && rt > 0 ? rt : t, actor: nodeFor(who), targets: [[actor, 'subject']], context: ci, parentKey: key, text: em.key || null });
          builder.stat('reactions');
        }
      }
    }
  }
  if (inferred) builder.warn('teams-members-inferred', 'Some group chats had no member list, so their members were inferred from who posted. People who only read are missing.', inferred);
  if (special) builder.warn('teams-free-special-lists', 'The call log, notes and other lists of the account itself (conversation ids starting 48:) are not conversations with anyone and were left out.', special);
  return ownerIdx >= 0 ? 'teams:' + owner : null;
}

// ---- Purview Items.csv ------------------------------------------------------------------

// Participants: "Name <upn>" items. The separator is not documented
// [UNVERIFIED]; we pull every Name <addr> pair, else split on ; or ,.
export function parseParticipants(s) {
  const out = [];
  if (!s) return out;
  // Pull out every Name <addr> pair first (names may contain commas), then
  // treat what is left, split on ; or , as bare addresses or bare names.
  const rest = String(s).replace(/(?:"([^"]*)"|([^<;,"]*))\s*<([^>]+)>/g, (m, q, name, email) => {
    out.push({ name: (q ?? name).trim(), email: email.trim().toLowerCase() });
    return ';';
  });
  for (const p of rest.split(/[;,]/).map(x => x.trim()).filter(Boolean)) {
    if (/^[^\s@]+@[^\s@]+$/.test(p)) out.push({ name: '', email: p.toLowerCase() });
    else out.push({ name: p, email: null });
  }
  return out;
}

const normName = s => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

async function importPurview(entry, { builder, options }) {
  const { records, headers } = rowsToObjects(parseCSV(await entryText(entry)).rows);
  // Field names come as CamelCase (ConversationId, FileClass) or as display
  // names (Conversation ID, File class, Item class): compare without case,
  // spaces or underscores, and accept the documented aliases.
  const squash = h => h.toLowerCase().replace(/[\s_]/g, '');
  const col = (...names) => { for (const n of names) { const h = headers.find(x => squash(x) === squash(n)); if (h) return h; } return undefined; };
  const cConv = col('ConversationId'), cPart = col('Participants'), cDate = col('Date'), cType = col('ConversationType'),
    cName = col('Conversation name'), cClass = col('FileClass'), cKind = col('MessageKind'), cChan = col('TeamsChannelName', 'Channel Name', 'Teams channel'),
    cItem = col('Item class', 'ItemClass', 'Message class');
  const seen = new Set();
  let nameOnly = 0, badDate = 0;
  for (const r of records) {
    // Items.csv also lists emails and documents; keep Teams conversations only.
    if (cClass && r[cClass] && !/conversation/i.test(r[cClass])) { builder.stat('non-teams-items-skipped'); continue; }
    if (cKind && r[cKind] && !/teams/i.test(r[cKind])) { builder.stat('non-teams-items-skipped'); continue; }
    if (cItem && r[cItem] && !/SkypeTeams/i.test(r[cItem])) { builder.stat('non-teams-items-skipped'); continue; }
    const ppl = parseParticipants(r[cPart]);
    if (ppl.length < 1) { builder.stat('rows-without-participants'); continue; }
    const t = parseTimestamp(r[cDate], 'iso', 'UTC');
    const ts = Number.isFinite(t) ? t : parseTimestamp(r[cDate], options.purviewDateFormat || 'mdy', 'UTC');
    if (!Number.isFinite(ts)) badDate++;
    // Every custodian's mailbox holds a copy: de-duplicate on conversation + time + people.
    const idxs = ppl.map(p => {
      if (p.email) return builder.node('teams:' + p.email, { label: p.name || undefined, attrs: { name: p.name || undefined, email: p.email }, platformIds: { teams: p.email } });
      nameOnly++;
      return builder.node('teams:name:' + normName(p.name), { label: p.name, attrs: { name: p.name } });
    });
    const dk = `${r[cConv]}|${r[cDate]}|${[...idxs].sort((a, b) => a - b).join(',')}`;
    if (seen.has(dk)) { builder.stat('duplicates-skipped'); continue; }
    seen.add(dk);
    const isChannel = /channel/i.test(r[cType] || '');
    const uniq = [...new Set(idxs)];
    const ci = builder.context('teams:purview:' + (r[cConv] || dk), {
      name: (isChannel && cChan && r[cChan]) || r[cName] || 'Teams conversation',
      kind: isChannel ? 'channel' : uniq.length === 2 ? 'dm' : 'group_dm',
      visibility: isChannel ? 'unknown' : uniq.length === 2 ? 'direct' : 'group', medium: 'teams', members: uniq,
    });
    builder.event({ type: 'copresence', t: ts, actor: uniq[0], targets: uniq.slice(1).map(n => [n, 'attendee']), context: ci });
    builder.stat('transcripts');
  }
  builder.warn('purview-participants-only', 'Purview Items.csv lists who took part in each transcript, not who wrote to whom or when each message was sent. Ties here are co-participation per transcript, a much weaker signal than messages.');
  if (nameOnly) builder.warn('purview-name-only-participants', 'Some participants appear by name only (no address); people with the same name will be merged and should be checked.', nameOnly);
  if (badDate) builder.warn('purview-bad-date', 'Some transcript dates could not be read; their time is unknown.', badDate);
}

// ---- entry point -----------------------------------------------------------------

async function importTeams(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const d = await detect(fs);
  const files = new Set(d.files || []);
  const entries = fs.entries.filter(e => files.has(e.rel));
  const tars = entries.filter(e => /\.tar$/i.test(e.rel));
  const csvs = entries.filter(e => /\.csv$/i.test(e.rel));
  const freeJson = [];
  const graph = [];
  for (const e of entries) {
    if (!/\.(json|ndjson|jsonl)$/i.test(e.rel)) continue;
    if (/(^|\/)messages\.json$/i.test(e.rel) && looksFree(await peek(e, 4096))) freeJson.push(e); else graph.push(e);
  }

  // Nothing but lists or a summary: say which files are missing.
  if (!tars.length && !freeJson.length && !csvs.length && graph.length) {
    let anyMessages = false;
    for (const e of graph) if (looksGraph(await peek(e, 4096))) { anyMessages = true; break; }
    if (!anyMessages) {
      throw new UploadError('teams-no-messages', `${graph.map(e => e.rel.split('/').pop()).slice(0, 3).join(', ')} ${graph.length === 1 ? 'lists' : 'list'} chats, channels or members, but no message files came with ${graph.length === 1 ? 'it' : 'them'}, so there are no messages to read. A Graph dump keeps messages in separate files (for example messages/<chat id>.json from /chats/{id}/messages); load the whole folder.`);
    }
  }
  if (!tars.length && !freeJson.length && !graph.length && csvs.some(e => /(^|\/)summary(_[^/]*)?\.csv$/i.test(e.rel))) {
    throw new UploadError('purview-no-items', 'This is the summary of a Purview eDiscovery export (Summary.csv: item counts per location) without its items report, so there is nothing to read. Download the export\'s Items.csv (or Items_<n>_<date>.csv) from the same package and load it; it lists the participants of each Teams conversation.');
  }

  if (graph.length) {
    builder.beginSource({ format: 'teams', family: 'workplace', medium: 'teams', view: 'full', context: 'workplace', tz: 'UTC', fileNames: graph.map(e => e.rel), egoKey: null, variant: 'graph', directed: true });
    const { view, egoKey } = await importGraph(fs, graph, { builder, options, progress, signal });
    builder.source.view = view;
    builder.source.egoKey = options.egoKey || egoKey;
  }

  const freeDocs = [];
  for (const e of freeJson) freeDocs.push({ name: e.rel, text: () => e.text() });
  for (const e of tars) {
    aborted(signal);
    for await (const t of tarEntries(e.stream(), n => /(^|\/)messages\.json$/i.test(n))) {
      if (t.data) freeDocs.push({ name: e.rel + '/' + t.name, text: async () => utf8.decode(t.data).replace(/^﻿/, '') });
    }
  }
  for (const f of freeDocs) {
    aborted(signal);
    builder.beginSource({ format: 'teams', family: 'workplace', medium: 'teams', view: 'ego', context: 'personal', tz: 'UTC', fileNames: [f.name], egoKey: null, variant: 'teams-free', directed: true });
    let doc;
    try { doc = JSON.parse(await f.text()); } catch { builder.warn('teams-bad-json', 'messages.json could not be parsed.'); continue; }
    builder.warn('teams-free-unofficial-schema', 'Teams Free exports are read using the Skype export layout, which Microsoft does not document. Results are lower confidence; check a few conversations by hand.');
    builder.source.egoKey = importFree(doc, { builder });
  }
  if (tars.length && !freeDocs.length) {
    builder.beginSource({ format: 'teams', family: 'workplace', medium: 'teams', view: 'ego', context: 'personal', tz: 'UTC', fileNames: tars.map(e => e.rel), variant: 'teams-free' });
    builder.warn('teams-free-no-messages', 'The .tar file holds no messages.json, so there is nothing to import. Re-export with "Chat history" selected.');
  }

  for (const e of csvs) {
    aborted(signal);
    builder.beginSource({ format: 'teams', family: 'workplace', medium: 'teams', view: 'full', context: 'workplace', tz: 'UTC', fileNames: [e.rel], egoKey: null, variant: 'purview', directed: false });
    builder.warn('purview-custodians-only', 'A Purview export covers only the custodians and date range the search selected; people outside it appear only when they shared a conversation with a custodian.');
    await importPurview(e, { builder, options });
  }
  progress(1, 'Teams: done');
}

export default {
  id: 'teams',
  label: 'Microsoft Teams (Graph JSON, Teams Free export, Purview Items.csv)',
  family: 'workplace',
  detect,
  options: [
    { key: 'view', label: 'Graph JSON covers', type: 'select', default: 'auto', choices: [
      { value: 'auto', label: 'Decide from the data' }, { value: 'ego', label: 'One person\'s chats' }, { value: 'full', label: 'A whole team or tenant' }] },
    { key: 'egoKey', label: 'Whose chats these are (node key, for one-person dumps)', type: 'text', default: '' },
    { key: 'purviewDateFormat', label: 'Purview date order when not ISO', type: 'select', default: 'mdy', choices: [{ value: 'mdy', label: 'Month/day/year' }, { value: 'dmy', label: 'Day/month/year' }] },
  ],
  import: importTeams,
};
