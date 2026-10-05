// Bluesky (AT Protocol) repository export importer.
//
// Spec: docs/formats/bluesky.md. Input is the account's `repo.car` (Settings ->
// Export my data, or com.atproto.sync.getRepo for any public account). The repo
// holds only what the account wrote, so the view is 'authored': posts (with
// reply parents, mentions and quotes), likes, reposts and follows, all outgoing.
// Followers and anything received are not in it.
//
// Parsing goes through vendor/atcute.js (@atcute/car + @atcute/repo), which
// walks the MST from the signed commit and verifies each block against its CID.

import { car, cbor, repo } from '../../vendor/atcute.js';
import { isoMs } from './lib/time.js';
import { peek } from '../core/fileset.js';

const NS = 'bsky';

// ---- small pure helpers (exported for tests) --------------------------------

// at://<did>/<collection>/<rkey> -> { did, collection, rkey } (null if not an at-uri).
export function parseAtUri(uri) {
  const m = /^at:\/\/([^/]+)(?:\/([^/]+)(?:\/([^/?#]+))?)?/.exec(String(uri ?? ''));
  return m ? { did: m[1], collection: m[2] ?? null, rkey: m[3] ?? null } : null;
}

const TID_ALPHABET = '234567abcdefghijklmnopqrstuvwxyz';
// TID record keys: 13 chars of base32-sortable, 64 bits = 0 | 53 bits of
// microseconds since epoch | 10 bits clock id (atproto TID spec). Returns ms or NaN.
export function tidToMs(rkey) {
  if (typeof rkey !== 'string' || rkey.length !== 13) return NaN;
  let v = 0n;
  for (const ch of rkey) {
    const d = TID_ALPHABET.indexOf(ch);
    if (d < 0) return NaN;
    v = (v << 5n) | BigInt(d);
  }
  if (v >> 63n) return NaN; // top bit must be 0
  return Number((v >> 10n) / 1000n);
}

// Mentioned DIDs from rich-text facets, with the facet's text as a label.
// Offsets are UTF-8 byte offsets (spec section 7), so slice the encoded bytes.
const enc = new TextEncoder();
const dec = new TextDecoder();
export function facetMentions(text, facets) {
  const out = [];
  if (!Array.isArray(facets)) return out;
  let bytes = null;
  for (const f of facets) {
    for (const feat of f?.features ?? []) {
      if (feat?.$type !== 'app.bsky.richtext.facet#mention' || typeof feat.did !== 'string') continue;
      let label = null;
      const s = f.index?.byteStart, e = f.index?.byteEnd;
      if (typeof text === 'string' && Number.isInteger(s) && Number.isInteger(e) && e > s) {
        bytes ??= enc.encode(text);
        if (e <= bytes.length) label = dec.decode(bytes.subarray(s, e));
      }
      out.push({ did: feat.did, label });
    }
  }
  return out;
}

// Quoted post URI: app.bsky.embed.record {record: strongRef} or
// app.bsky.embed.recordWithMedia {record: {record: strongRef}}.
export function quotedUri(embed) {
  if (!embed || typeof embed !== 'object') return null;
  if (embed.$type === 'app.bsky.embed.record') return embed.record?.uri ?? null;
  if (embed.$type === 'app.bsky.embed.recordWithMedia') return embed.record?.record?.uri ?? null;
  return null;
}

async function headBytes(entry, n) {
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
  for (const c of chunks) { const t = Math.min(c.length, out.length - o); out.set(c.subarray(0, t), o); o += t; if (o >= out.length) break; }
  return out;
}

// CAR v1 signature from the spec: varint header length, then a 2-entry CBOR map
// (0xa2) with the text key "roots" in the first 16 bytes. The import then
// confirms by decoding the root commit (version 3, did:...).
export function looksLikeCar(bytes) {
  if (bytes.length < 10) return false;
  let i = 0;
  while (i < 3 && bytes[i] & 0x80) i++; // varint length, usually one byte
  if (bytes[i + 1] !== 0xa2) return false;
  return new TextDecoder('latin1').decode(bytes.subarray(0, 16)).includes('roots');
}

// .car files, plus extension-less files named like a getRepo download.
function carCandidates(fs) {
  return fs.entries.filter(e => /\.car$/i.test(e.rel) || /(^|\/)[^/.]*repo[^/.]*$/i.test(e.rel));
}

const CHAT_RE = /(^|\/)chat\.jsonl$/i;

async function isChatJsonl(entry) {
  if (CHAT_RE.test(entry.rel)) return true;
  if (!/\.jsonl$/i.test(entry.rel)) return false;
  const head = (await peek(entry, 2048)).split('\n')[0];
  return head.includes('"sentAt"') && /"sender"\s*:\s*\{[^}]*"did"/.test(head);
}

// ---- network fetch (user-initiated only) -------------------------------------

// NETWORK: this function contacts public.api.bsky.app, plc.directory (or the
// did:web host) and the account's PDS. It must only run when the user asks to
// fetch a public repository by handle; importers never call it on their own.
// `fetch` is injectable so tests run offline. Returns the CAR bytes plus the
// resolved identity; wrap the bytes in a Blob named repo.car to import them.
export async function fetchRepo(handleOrDid, { fetch: f = globalThis.fetch, signal } = {}) {
  if (typeof f !== 'function') throw new Error('No fetch implementation available.');
  const input = String(handleOrDid ?? '').trim().replace(/^@/, '').replace(/^at:\/\//, '');
  if (!input) throw new Error('Enter a Bluesky handle (e.g. name.bsky.social) or a DID.');
  const getJSON = async (url, what) => {
    const r = await f(url, { signal, headers: { accept: 'application/json' } });
    if (!r.ok) throw new Error(`${what} failed (HTTP ${r.status}) at ${url}`);
    return r.json();
  };
  let did = input;
  if (!input.startsWith('did:')) {
    const j = await getJSON(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(input.toLowerCase())}`, 'Handle lookup');
    did = j?.did;
    if (typeof did !== 'string' || !did.startsWith('did:')) throw new Error(`Handle ${input} did not resolve to a DID.`);
  }
  let docUrl;
  if (did.startsWith('did:plc:')) docUrl = `https://plc.directory/${did}`;
  else if (did.startsWith('did:web:')) {
    // atproto allows only hostname-level did:web; a port is percent-encoded (%3A).
    // CORS on arbitrary did:web hosts is UNVERIFIED (spec section 1).
    const host = decodeURIComponent(did.slice('did:web:'.length));
    if (host.includes(':') && !/^[^:]+:\d+$/.test(host)) throw new Error(`Unsupported did:web with a path: ${did}`);
    docUrl = `https://${host}/.well-known/did.json`;
  } else throw new Error(`Unsupported DID method: ${did}`);
  const doc = await getJSON(docUrl, 'DID document lookup');
  const svc = (doc?.service ?? []).find(s => typeof s?.id === 'string' && s.id.endsWith('#atproto_pds'));
  const pds = typeof svc?.serviceEndpoint === 'string' ? svc.serviceEndpoint.replace(/\/+$/, '') : null;
  if (!pds) throw new Error(`The DID document for ${did} lists no #atproto_pds service.`);
  const aka = (doc.alsoKnownAs ?? []).find(a => typeof a === 'string' && a.startsWith('at://'));
  const r = await f(`${pds}/xrpc/com.atproto.sync.getRepo?did=${encodeURIComponent(did)}`, { signal, headers: { accept: 'application/vnd.ipld.car' } });
  if (!r.ok) throw new Error(`Repository download failed (HTTP ${r.status}) from ${pds}`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  return { did, handle: aka ? aka.slice(5) : (input.startsWith('did:') ? null : input.toLowerCase()), pds, bytes, fileName: 'repo.car' };
}

// ---- importer ------------------------------------------------------------------

const MISMATCH_DAYS = 30;

export default {
  id: 'bluesky',
  label: 'Bluesky repository (repo.car)',
  family: 'online',
  options: [],

  async detect(fs) {
    for (const e of carCandidates(fs)) {
      if (looksLikeCar(await headBytes(e, 32))) return { score: 0.95, reason: `${e.rel} is an AT Protocol repository CAR` };
    }
    for (const e of fs.entries) {
      if (await isChatJsonl(e)) return { score: 0.6, reason: `${e.rel} looks like a Bluesky chat export (format unverified)` };
    }
    return { score: 0 };
  },

  async import(fs, { builder, progress, signal } = {}) {
    const cars = [];
    for (const e of carCandidates(fs)) if (looksLikeCar(await headBytes(e, 32))) cars.push(e);
    const chats = [];
    for (const e of fs.entries) if (await isChatJsonl(e)) chats.push(e);

    for (let ci = 0; ci < cars.length; ci++) {
      await importCar(cars[ci], builder, { progress: (f, m) => progress?.((ci + f) / cars.length, m), signal });
      if (chats.length) warnChat(builder, chats);
    }
    if (!cars.length && chats.length) {
      builder.beginSource({ format: 'bluesky', family: 'online', medium: 'bluesky', view: 'authored', context: 'online', tz: 'UTC', fileNames: chats.map(c => c.rel) });
      warnChat(builder, chats);
    }
    if (!cars.length && !chats.length) throw new Error('No Bluesky repository (.car) found.');
  },
};

function warnChat(builder, chats) {
  // The chat.jsonl line schema is UNVERIFIED (Bluesky's chat service is closed
  // source; the lexicon declares only application/jsonl). Rather than guess field
  // names, report and skip.
  builder.warn('bluesky-chat-unverified', `Bluesky chat export (${chats.map(c => c.rel).join(', ')}) was not imported: its format is not documented, and it only contains messages you sent. Share an anonymized sample to add support.`, chats.length);
}

async function importCar(entry, builder, { progress, signal }) {
  const bytes = await entry.bytes();
  // Find the commit (header root) for the repo DID.
  const reader = car.fromUint8Array(bytes);
  const rootLink = reader.roots[0]?.$link;
  let commit = null;
  for (const block of reader) {
    if (cbor.toCidLink(block.cid).$link === rootLink) { commit = cbor.decode(block.bytes); break; }
  }
  if (!commit || typeof commit.did !== 'string' || !commit.did.startsWith('did:')) throw new Error(`${entry.rel}: no repository commit found at the CAR root.`);
  builder.beginSource({ format: 'bluesky', family: 'online', medium: 'bluesky', view: 'authored', context: 'online', tz: 'UTC', fileNames: [entry.rel], egoKey: `${NS}:${commit.did}` });
  // Spec: repo format v3; v2 is "mostly compatible". Continue but say so.
  if (commit.version !== 3) builder.warn('repo-version', `Repository format version ${commit.version} (expected 3); records were read but may be incomplete.`);
  const egoDid = commit.did;
  const ego = builder.node(`${NS}:${egoDid}`, { platformIds: { bluesky: egoDid } });
  const person = (did, label) => builder.node(`${NS}:${did}`, { label: label || undefined, platformIds: { bluesky: did, ...(label && label.startsWith('@') ? { handle: label.slice(1) } : {}) } });
  const threadCtx = uri => builder.context(`${NS}:thread:${uri}`, { name: uri, kind: 'thread', visibility: 'public', medium: 'bluesky' });

  const follows = new Set();
  let n = 0, mismatched = 0, noDate = 0, other = 0, quotesUnres = 0;
  const lists = new Map(); // list at-uri -> name
  const listItems = [];

  const timeOf = (rec, rkey) => {
    const t = isoMs(rec.createdAt);
    const tt = tidToMs(rkey);
    if (Number.isNaN(t)) { if (!Number.isNaN(tt)) noDate++; return tt; }
    if (!Number.isNaN(tt) && Math.abs(t - tt) > MISMATCH_DAYS * 86400000) mismatched++;
    return t;
  };

  for (const rec of repo.fromUint8Array(bytes)) {
    if (++n % 2000 === 0) { signal?.throwIfAborted(); progress?.(0.5, `${n} records`); }
    const { collection, rkey } = rec;
    if (!collection.startsWith('app.bsky.')) { other++; continue; }
    const r = rec.record;
    if (!r || typeof r !== 'object') continue;
    const uri = `at://${egoDid}/${collection}/${rkey}`;
    switch (collection) {
      case 'app.bsky.actor.profile': {
        builder.node(`${NS}:${egoDid}`, { label: r.displayName || undefined, attrs: { description: r.description, pronouns: r.pronouns, website: r.website } });
        builder.stat('profile');
        break;
      }
      case 'app.bsky.feed.post': {
        builder.stat('posts');
        const t = timeOf(r, rkey);
        const targets = [];
        const parent = parseAtUri(r.reply?.parent?.uri);
        const root = r.reply?.root?.uri;
        let replyDid = null;
        if (parent?.did) { replyDid = parent.did; targets.push([person(parent.did), 'reply']); builder.stat('replies'); }
        for (const m of facetMentions(r.text, r.facets)) {
          if (m.did === replyDid) continue; // the reply target already carries this tie
          targets.push([person(m.did, m.label), 'mention']);
          builder.stat('mentions');
        }
        const ctx = threadCtx(typeof root === 'string' ? root : uri);
        builder.event({ type: 'message', t, actor: ego, targets, context: ctx, key: `${NS}:post:${uri}`, parentKey: r.reply?.parent?.uri ? `${NS}:post:${r.reply.parent.uri}` : null, text: typeof r.text === 'string' ? r.text : null });
        // A quote post references another author's post. Recorded as a separate
        // 'repost' event with the quoted author as subject so it can be weighted
        // (or switched off) independently of the post itself.
        const q = quotedUri(r.embed);
        if (q) {
          const qa = parseAtUri(q);
          if (qa?.did) {
            builder.event({ type: 'repost', t, actor: ego, targets: [[person(qa.did), 'subject']], context: ctx, key: `${NS}:quote:${uri}` });
            builder.stat('quotes');
          } else quotesUnres++;
        }
        break;
      }
      case 'app.bsky.feed.like':
      case 'app.bsky.feed.repost': {
        const kind = collection.endsWith('like') ? 'like' : 'repost';
        builder.stat(kind === 'like' ? 'likes' : 'reposts');
        const s = parseAtUri(r.subject?.uri);
        if (!s?.did) { builder.warn('bad-subject', 'Likes or reposts without a valid subject URI were skipped.'); break; }
        builder.event({ type: kind, t: timeOf(r, rkey), actor: ego, targets: [[person(s.did), 'subject']], key: `${NS}:${kind}:${uri}` });
        break;
      }
      case 'app.bsky.graph.follow': {
        if (typeof r.subject !== 'string' || !r.subject.startsWith('did:')) { builder.warn('bad-subject', 'Follows without a valid subject DID were skipped.'); break; }
        // Spec section 7: duplicate follows of the same DID exist; keep the first.
        if (follows.has(r.subject)) { builder.warn('duplicate-follow', 'Duplicate follow records for the same account were merged.'); break; }
        follows.add(r.subject);
        builder.stat('follows');
        builder.event({ type: 'follow', t: timeOf(r, rkey), actor: ego, targets: [[person(r.subject), 'subject']], key: `${NS}:follow:${uri}` });
        break;
      }
      case 'app.bsky.graph.block':
        builder.stat('blocks');
        break;
      case 'app.bsky.graph.list':
        lists.set(uri, typeof r.name === 'string' ? r.name : rkey);
        builder.stat('lists');
        break;
      case 'app.bsky.graph.listitem':
        if (typeof r.subject === 'string' && typeof r.list === 'string') listItems.push(r);
        break;
      default:
        builder.stat('other-bsky-records');
    }
  }
  // List membership is a curated grouping: record it as a node attribute on
  // the listed account (names of the ego's lists that include them).
  const memberOf = new Map();
  for (const li of listItems) {
    const name = lists.get(li.list) ?? li.list;
    if (!memberOf.has(li.subject)) memberOf.set(li.subject, new Set());
    memberOf.get(li.subject).add(name);
  }
  for (const [did, names] of memberOf) builder.node(`${NS}:${did}`, { attrs: { bsky_lists: [...names].sort().join('; ') }, platformIds: { bluesky: did } });
  if (listItems.length) builder.stat('list-items', listItems.length);

  if (other) { builder.stat('non-bluesky-records', other); builder.warn('non-bluesky-records', 'Records written by other AT Protocol apps (not app.bsky.*) were ignored.', other); }
  if (mismatched) builder.warn('createdat-mismatch', `createdAt differs from the record key time by more than ${MISMATCH_DAYS} days (client-set dates, e.g. posts imported from another platform). createdAt was kept.`, mismatched);
  if (noDate) builder.warn('createdat-missing', 'Records without a usable createdAt were dated from their record key (TID).', noDate);
  if (quotesUnres) builder.warn('quote-unresolved', 'Quote embeds without a valid at-uri were ignored.', quotesUnres);
  const blocks = builder.source.counts.blocks;
  if (blocks) builder.warn('blocks-skipped', 'Blocks are listed in the counts but not added as ties.', blocks);
  progress?.(1, 'done');
}
