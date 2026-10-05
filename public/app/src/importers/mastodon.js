// Mastodon account archive and CSV export importer.
//
// Spec: docs/formats/mastodon.md (Mastodon only; Pleroma/Akkoma/Misskey/
// GoToSocial export differently and are not covered). Ego view: the account's
// own statuses (including followers-only and DMs sent), boosts, liked and
// bookmarked status URIs, and the following list. No followers, nothing
// received.
//
// Identity. People appear as ActivityPub actor URIs (addressing, Mention href)
// and as `user@domain` (Mention name, CSVs). The spec reconciles the two via
// Mention tags: every Mention gives href -> @user@domain. Node keys are
// `mastodon:user@domain` when known, else `mastodon:<actor URI>`. Usernames are
// never parsed out of URIs: actor URI schemes vary (/users/<name>,
// /ap/users/<id> on 4.5+, other software).

import { streamJSON, readJSON } from './lib/json.js';
import { stripHtml } from './lib/text.js';
import { isoMs } from './lib/time.js';
import { parseCSV } from './lib/csv.js';
import { peek } from '../core/fileset.js';

const NS = 'mastodon';
const PUBLIC = new Set(['https://www.w3.org/ns/activitystreams#Public', 'as:Public', 'Public']);

// ---- pure helpers (exported for tests) -----------------------------------------

const arr = v => (Array.isArray(v) ? v : v == null ? [] : [v]);
const hostOf = u => { try { return new URL(u).host.toLowerCase(); } catch { return null; } };

// Visibility from addressing (spec section 4, TagManager#to/#cc):
// Public in to -> public; Public in cc -> unlisted; the ego's followers
// collection present -> private (followers-only); else direct.
export function visibilityOf(to, cc, followersUri) {
  const t = arr(to), c = arr(cc);
  if (t.some(x => PUBLIC.has(x))) return 'public';
  if (c.some(x => PUBLIC.has(x))) return 'unlisted';
  const isFollowers = x => x === followersUri || (followersUri == null && /\/followers$/.test(x));
  if (t.some(isFollowers) || c.some(isFollowers)) return 'private';
  return 'direct';
}

// '@user@domain' or '@user' (local accounts are serialized without a domain in
// some versions) -> 'user@domain'. The fallback domain is the href's host.
export function acctFromMention(name, href) {
  const m = /^@?([^@\s]+)(?:@([^@\s]+))?$/.exec(String(name ?? '').trim());
  if (!m) return null;
  const domain = (m[2] ?? hostOf(href) ?? '').toLowerCase();
  return domain ? `${m[1].toLowerCase()}@${domain}` : null;
}

// Collections are not people.
function isCollection(u, egoId) {
  return PUBLIC.has(u) || /\/(followers|following)$/.test(u) || u === egoId;
}

// Actor URI that owns a status URI, using only actor URIs we have seen (prefix
// match on a path boundary). Works for /users/<name>/statuses/<id> and
// /ap/users/<id>/statuses/<id> without reading names out of the path.
function ownerByPrefix(statusUri, actorUris) {
  let best = null;
  for (const a of actorUris) if (statusUri.startsWith(a + '/') && (!best || a.length > best.length)) best = a;
  return best;
}

// Heuristic (flagged): Mastodon status URIs are <actor URI>/statuses/<id>.
function ownerByPattern(statusUri) {
  const m = /^(https?:\/\/[^/]+\/.+?)\/statuses\/[^/]+$/.exec(statusUri);
  return m ? m[1] : null;
}

// ---- detection -------------------------------------------------------------------

const FOLLOW_HDR = /^Account address(,|$)/;

async function sniff(fs) {
  const find = name => fs.entries.find(e => e.rel.toLowerCase() === name || e.rel.toLowerCase().endsWith('/' + name)) ?? null;
  const outbox = find('outbox.json'), actor = find('actor.json'), likes = find('likes.json'), bookmarks = find('bookmarks.json');
  const r = { outbox: null, actor: null, likes: null, bookmarks: null, following: null, lists: null };
  if (outbox) { const h = await peek(outbox, 4096); if (/"type"\s*:\s*"OrderedCollection"/.test(h) && /"id"\s*:\s*"outbox\.json"/.test(h)) r.outbox = outbox; }
  if (actor) { const h = await peek(actor, 8192); if (/"outbox"\s*:\s*"outbox\.json"/.test(h) || /"preferredUsername"/.test(h)) r.actor = actor; }
  if (likes) { const h = await peek(likes, 1024); if (/"id"\s*:\s*"likes\.json"/.test(h)) r.likes = likes; }
  if (bookmarks) { const h = await peek(bookmarks, 1024); if (/"id"\s*:\s*"bookmarks\.json"/.test(h)) r.bookmarks = bookmarks; }
  for (const e of fs.entries) {
    if (!/\.csv$/i.test(e.rel)) continue;
    const first = (await peek(e, 512)).split(/\r?\n/)[0];
    if (FOLLOW_HDR.test(first) && /show boosts/i.test(first)) r.following = e;
    else if (/(^|\/)lists\.csv$/i.test(e.rel)) r.lists = e;
  }
  return r;
}

// ---- importer ----------------------------------------------------------------------

export default {
  id: 'mastodon',
  label: 'Mastodon archive or CSV export',
  family: 'online',
  options: [{ key: 'account', label: 'Your account (user@domain), if importing CSVs without the archive', type: 'text', default: '' }],

  async detect(fs) {
    const r = await sniff(fs);
    if (r.outbox && r.actor) return { score: 0.95, reason: 'Mastodon archive (actor.json + outbox.json)' };
    if (r.outbox) return { score: 0.9, reason: 'Mastodon outbox.json' };
    if (r.following) return { score: 0.9, reason: `${r.following.rel} is a Mastodon following export` };
    if (r.likes || r.bookmarks) return { score: 0.7, reason: 'Mastodon likes/bookmarks collection' };
    return { score: 0 };
  },

  async import(fs, { builder, options = {}, progress, signal } = {}) {
    const f = await sniff(fs);
    if (!f.outbox && !f.following && !f.likes && !f.bookmarks) throw new Error('No Mastodon archive files found (outbox.json, actor.json, following_accounts.csv).');

    // Ego.
    let actor = null;
    if (f.actor) actor = await readJSON(f.actor);
    const egoId = typeof actor?.id === 'string' ? actor.id : null;
    const followersUri = typeof actor?.followers === 'string' ? actor.followers : (egoId ? egoId + '/followers' : null);
    let egoAcct = null;
    if (actor?.preferredUsername && egoId) egoAcct = `${String(actor.preferredUsername).toLowerCase()}@${hostOf(egoId)}`;
    else if (options.account) egoAcct = String(options.account).replace(/^@/, '').toLowerCase();
    const egoKey = egoAcct ? `${NS}:${egoAcct}` : egoId ? `${NS}:${egoId}` : `${NS}:me`;

    const fileNames = Object.values(f).filter(Boolean).map(e => e.rel);
    builder.beginSource({ format: 'mastodon', family: 'online', medium: 'mastodon', view: 'ego', context: 'online', tz: 'UTC', fileNames, egoKey });
    if (egoKey === `${NS}:me`) builder.warn('ego-unknown', 'actor.json was not provided and no account was entered, so your own account is a placeholder node. Add actor.json or set the account option.');

    // Pass 1: href -> acct from every Mention tag (the spec's reconciliation key).
    const acctOf = new Map();
    if (egoId && egoAcct) acctOf.set(egoId, egoAcct);
    if (f.outbox) {
      for await (const { value: act } of streamJSON(f.outbox.stream(), ['orderedItems.*'])) {
        const obj = act?.object;
        if (obj && typeof obj === 'object') for (const t of arr(obj.tag)) {
          if (t?.type === 'Mention' && typeof t.href === 'string' && !acctOf.has(t.href)) {
            const a = acctFromMention(t.name, t.href);
            if (a) acctOf.set(t.href, a);
          }
        }
      }
    }
    const knownActors = [...acctOf.keys()];

    const ego = builder.node(egoKey, {
      label: actor?.name || (egoAcct ? '@' + egoAcct : undefined),
      attrs: { instance: egoAcct?.split('@')[1] ?? (egoId ? hostOf(egoId) : undefined) },
      platformIds: { ...(egoId ? { mastodon: egoId } : {}), ...(egoAcct ? { acct: egoAcct } : {}) },
    });
    const byUri = uri => {
      if (uri === egoId) return ego;
      const a = acctOf.get(uri);
      if (a) return byAcct(a, uri);
      return builder.node(`${NS}:${uri}`, { attrs: { instance: hostOf(uri) }, platformIds: { mastodon: uri } });
    };
    const byAcct = (acct, uri) => {
      acct = acct.replace(/^@/, '').toLowerCase();
      if (acct === egoAcct) return ego;
      return builder.node(`${NS}:${acct}`, { label: '@' + acct, attrs: { instance: acct.split('@')[1] }, platformIds: { acct, ...(uri ? { mastodon: uri } : {}) } });
    };

    // Pass 2: activities.
    let n = 0, replyUnknown = 0, boostHeur = 0, boostUnknown = 0, quoteUnknown = 0, other = 0;
    if (f.outbox) {
      const total = f.outbox.size || 1;
      for await (const { value: act } of streamJSON(f.outbox.stream(), ['orderedItems.*'])) {
        if (++n % 1000 === 0) { signal?.throwIfAborted(); progress?.(Math.min(0.9, n * 3000 / total), `${n} activities`); }
        if (act?.type === 'Create' && act.object && typeof act.object === 'object') {
          const o = act.object;
          builder.stat('statuses');
          const vis = visibilityOf(o.to ?? act.to, o.cc ?? act.cc, followersUri);
          const t = isoMs(o.published ?? act.published);
          const mentions = arr(o.tag).filter(x => x?.type === 'Mention' && typeof x.href === 'string');
          const targets = [];
          // Reply author: the actor whose URI owns inReplyTo, among Mention hrefs
          // and addressed actors (Mastodon auto-mentions the parent author).
          let replyActor = null;
          if (typeof o.inReplyTo === 'string') {
            builder.stat('replies');
            const cands = [...mentions.map(m => m.href), ...arr(o.to), ...arr(o.cc)].filter(u => typeof u === 'string' && !isCollection(u, null));
            replyActor = ownerByPrefix(o.inReplyTo, egoId ? [...cands, egoId] : cands);
            if (replyActor) targets.push([byUri(replyActor), 'reply']);
            else replyUnknown++;
          }
          if (vis === 'direct') {
            builder.stat('direct-messages');
            const addressees = new Set([...arr(o.to), ...arr(o.cc)].filter(u => typeof u === 'string' && !isCollection(u, egoId)));
            for (const m of mentions) addressees.add(m.href);
            for (const u of addressees) if (u !== replyActor) targets.push([byUri(u), 'dm']);
          } else {
            for (const m of mentions) if (m.href !== replyActor && m.href !== egoId) { targets.push([byUri(m.href), 'mention']); builder.stat('mentions'); }
          }
          const conv = (typeof o.context === 'string' && o.context) || (typeof o.conversation === 'string' && o.conversation) || o.id;
          let ctx;
          if (vis === 'direct') {
            const group = targets.filter(x => x[1] === 'dm').length > 1;
            ctx = builder.context(`${NS}:${group ? 'group_dm' : 'dm'}:${conv}`, { name: conv, kind: group ? 'group_dm' : 'dm', visibility: group ? 'group' : 'direct', medium: 'mastodon' });
          } else if (vis === 'private') {
            ctx = builder.context(`${NS}:private:${conv}`, { name: conv, kind: 'thread', visibility: 'private', medium: 'mastodon' });
          } else {
            // public and unlisted are both readable by anyone.
            ctx = builder.context(`${NS}:thread:${conv}`, { name: conv, kind: 'thread', visibility: 'public', medium: 'mastodon' });
            if (vis === 'unlisted') builder.stat('unlisted');
          }
          const body = stripHtml(o.content ?? '');
          builder.event({ type: 'message', t, actor: ego, targets, context: ctx, key: `${NS}:status:${o.id}`, parentKey: typeof o.inReplyTo === 'string' ? `${NS}:status:${o.inReplyTo}` : null, text: o.summary ? `[CW: ${o.summary}] ${body}` : body });
          // Quote posts (4.4+): separate repost event with the quoted author as subject.
          const q = [o.quote, o.quoteUri, o._misskey_quote].find(x => typeof x === 'string');
          if (q) {
            const owner = ownerByPrefix(q, [...knownActors, ...(egoId ? [egoId] : [])]);
            if (owner) { builder.event({ type: 'repost', t, actor: ego, targets: [[byUri(owner), 'subject']], context: ctx, key: `${NS}:quote:${o.id}` }); builder.stat('quotes'); }
            else quoteUnknown++;
          }
        } else if (act?.type === 'Announce') {
          builder.stat('boosts');
          const t = isoMs(act.published);
          let author = null;
          if (act.object && typeof act.object === 'object') author = egoId; // self-boost of an inlined own post
          else {
            // Spec: cc carries the boosted author's actor URI.
            const cc = arr(act.cc).filter(u => typeof u === 'string' && !isCollection(u, egoId));
            const objUri = typeof act.object === 'string' ? act.object : '';
            author = ownerByPrefix(objUri, cc) ?? (cc.length === 1 ? cc[0] : null) ?? ownerByPrefix(objUri, knownActors);
            if (!author) { author = ownerByPattern(objUri); if (author) boostHeur++; }
          }
          if (!author) { boostUnknown++; builder.event({ type: 'repost', t, actor: ego, key: `${NS}:boost:${act.id}` }); continue; }
          builder.event({ type: 'repost', t, actor: ego, targets: [[byUri(author), 'subject']], key: `${NS}:boost:${act.id}` });
        } else other++;
      }
    }
    if (replyUnknown) builder.warn('reply-author-unknown', 'Replies whose parent author could not be identified from Mention tags or addressing (parent deleted or remote). They are kept without a reply tie.', replyUnknown);
    if (boostHeur) builder.warn('boost-author-heuristic', 'Boosted authors guessed from the status URI shape (/statuses/<id>); may be wrong on non-Mastodon servers.', boostHeur);
    if (boostUnknown) builder.warn('boost-author-unknown', 'Boosts whose original author could not be identified were kept without a target.', boostUnknown);
    if (quoteUnknown) builder.warn('quote-author-unknown', 'Quote posts whose quoted author could not be identified were not added as ties.', quoteUnknown);
    if (other) builder.warn('unknown-activity', 'Outbox activities other than Create and Announce were skipped.', other);

    // Likes and bookmarks: status URIs only, no time, author by heuristic.
    const undated = async (entry, kind) => {
      const doc = await readJSON(entry);
      let heur = 0, unknown = 0;
      for (const uri of arr(doc?.orderedItems)) {
        if (typeof uri !== 'string') continue;
        builder.stat(kind);
        let owner = ownerByPrefix(uri, knownActors);
        if (!owner) { owner = ownerByPattern(uri); if (owner) heur++; }
        if (owner) builder.event({ type: 'like', t: NaN, actor: ego, targets: [[byUri(owner), 'subject']], key: `${NS}:${kind}:${uri}` });
        else { unknown++; builder.event({ type: 'like', t: NaN, actor: ego, key: `${NS}:${kind}:${uri}` }); }
      }
      return { heur, unknown };
    };
    for (const [entry, kind] of [[f.likes, 'likes'], [f.bookmarks, 'bookmarks']]) {
      if (!entry) continue;
      const { heur, unknown } = await undated(entry, kind);
      const cnt = builder.source.counts[kind] || 0;
      if (cnt) builder.warn(`undated-${kind}`, `${kind === 'likes' ? 'Likes' : 'Bookmarks'} have no timestamp in the export; they are imported as undated like events.`, cnt);
      if (heur) builder.warn(`heuristic-${kind}-author`, `Authors of ${kind} were guessed from the status URI (author is not in the export); treat these ties as approximate.`, heur);
      if (unknown) builder.warn(`unknown-${kind}-author`, `Some ${kind} have no recognisable author and carry no tie.`, unknown);
    }

    // following_accounts.csv: Account address,Show boosts,Notify on new posts,Languages
    if (f.following) {
      const { rows } = parseCSV(await f.following.text());
      for (const row of rows) {
        const addr = String(row['Account address'] ?? '').trim().replace(/^@/, '');
        if (!addr.includes('@')) { builder.warn('bad-account-address', 'Rows in following_accounts.csv without a user@domain address were skipped.'); continue; }
        const who = byAcct(addr);
        builder.node(builder.nodes.keys[who], { attrs: { show_boosts: row['Show boosts'], notify_on_new_posts: row['Notify on new posts'] } });
        builder.event({ type: 'follow', t: NaN, actor: ego, targets: [[who, 'subject']], key: `${NS}:follow:${addr.toLowerCase()}` });
        builder.stat('follows');
      }
      const c = builder.source.counts.follows || 0;
      if (c) builder.warn('undated-follows', 'The following list has no follow dates (a current snapshot).', c);
    }

    // lists.csv (headerless "List title,user@domain"): a curated grouping, kept as a node attribute.
    if (f.lists) {
      const { rows } = parseCSV(await f.lists.text(), { header: false });
      const memberOf = new Map();
      for (const r of rows) {
        if (r.length < 2 || !String(r[1]).includes('@')) continue;
        const a = String(r[1]).trim().replace(/^@/, '').toLowerCase();
        if (!memberOf.has(a)) memberOf.set(a, new Set());
        memberOf.get(a).add(String(r[0]).trim());
      }
      for (const [a, names] of memberOf) { const i = byAcct(a); builder.node(builder.nodes.keys[i], { attrs: { mastodon_lists: [...names].sort().join('; ') } }); }
      builder.stat('list-members', memberOf.size);
    }
    progress?.(1, 'done');
  },
};
