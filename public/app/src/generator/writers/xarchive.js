// X personal archive, per docs/formats/x-archive.md:
//   Your archive.html
//   data/manifest.js     window.__THAR_CONFIG = { userInfo, archiveInfo, readmeInfo, dataTypes }
//   data/README.txt
//   data/<type>.js       window.YTD.<type_with_underscores>.part0 = [ ... ]
// Only the archive owner's (ego's) view: their posts, replies and retweets,
// their likes (undated, no author), follower/following id lists (a snapshot at
// export time, no dates) and their DMs. Every number is a string, ids too,
// because snowflakes exceed 2^53. Tweet ids are snowflakes derived from the
// post time so they sort like real ones and decode to the right time.

import { zip, u8 } from './util.js';
import { snowflake, X_EPOCH } from '../identity.js';
import { WDAY, MON, pad, parts } from '../time.js';

const PART_SIZE = 5000; // tweets per part file; larger archives get tweets-part1.js ...

export function write({ world, ctx, records, ident, obs, rng, native = {} }) {
  const r = rng.fork('xarchive');
  const ego = obs.ego;
  const { span } = world;
  const egoId = ident.accountId[ego];
  // X screen names are 1-15 of [A-Za-z0-9_] (the importer's RT pattern relies on
  // it); world handles may hold dots or run longer, so map them once, uniquely.
  const xHandles = new Map(), usedH = new Set();
  const handle = i => {
    let h = xHandles.get(i);
    if (h === undefined) {
      const base = String(ident.handle?.[i] ?? world.people.handle[i]).replace(/[^A-Za-z0-9_]/g, '_').slice(0, 15) || 'user';
      h = base;
      for (let k = 2; usedH.has(h.toLowerCase()); k++) h = base.slice(0, 15 - String(k).length) + k;
      usedH.add(h.toLowerCase()); xHandles.set(i, h);
    }
    return h;
  };

  // Tweet ids for every public post or reply in the world, so replies, likes
  // and retweets by the ego point at ids that decode consistently.
  const tweetId = new Map();
  const byId = new Map();
  for (const rec of records) {
    byId.set(rec.id, rec);
    if (rec.kind === 'message' && !(rec.space >= 0)) tweetId.set(rec.id, snowflake(rec.t, X_EPOCH, r));
  }
  const counts = new Map(); // record id -> { likes, rts }
  for (const rec of records) {
    if ((rec.kind === 'like' || rec.kind === 'repost') && rec.parent >= 0) {
      const c = counts.get(rec.parent) || { likes: 0, rts: 0 };
      if (rec.kind === 'like') c.likes++; else c.rts++;
      counts.set(rec.parent, c);
    }
  }

  // Links in posts are wrapped by t.co, as they are in real archives.
  const shortened = new Map();
  const shorten = s => s.replace(/https?:\/\/\S+/g, u => {
    const k = 'https://t.co/' + r.b36(10).toLowerCase().replace(/^(.)/, c => c.toUpperCase());
    shortened.set(k, u);
    return k;
  });

  const tweets = [], likes = [], dmConvs = new Map();
  for (const rec of records) {
    if (rec.actor === ego && rec.kind === 'message' && !(rec.space >= 0)) tweets.push({ tweet: tweetObject(rec) });
    else if (rec.actor === ego && rec.kind === 'repost' && byId.has(rec.parent)) tweets.push({ tweet: retweetObject(rec) });
    else if (rec.actor === ego && rec.kind === 'like' && tweetId.has(rec.parent)) {
      const p = byId.get(rec.parent);
      const id = tweetId.get(rec.parent);
      likes.push({ like: { tweetId: id, fullText: escapeHtml(p.text ?? ''), expandedUrl: `https://twitter.com/i/web/status/${id}` } });
    } else if (rec.kind === 'message' && rec.space >= 0) {
      const s = ctx.spaces[rec.space];
      if (s.kind === 'dm' && s.members.includes(ego)) {
        if (!dmConvs.has(rec.space)) dmConvs.set(rec.space, []);
        dmConvs.get(rec.space).push(rec);
      }
    }
  }

  function textWithMentions(rec, prefixIds) {
    const prefix = prefixIds.map(i => '@' + handle(i)).join(' ');
    return { prefix: prefix ? prefix + ' ' : '', body: rec.text ?? '' };
  }

  function entitiesFor(full, mentionIds) {
    const user_mentions = [];
    for (const i of mentionIds) {
      const h = '@' + handle(i);
      const at = full.indexOf(h);
      if (at < 0) continue;
      user_mentions.push({ name: world.people.label[i], screen_name: handle(i), indices: [String(at), String(at + h.length)], id_str: ident.accountId[i], id: ident.accountId[i] });
    }
    const hashtags = [];
    for (const m of full.matchAll(/#(\w+)/g)) hashtags.push({ text: m[1], indices: [String(m.index), String(m.index + m[0].length)] });
    const urls = [];
    for (const m of full.matchAll(/https:\/\/t\.co\/\w+/g)) {
      const exp = shortened.get(m[0]);
      urls.push({ url: m[0], expanded_url: exp, display_url: exp.replace(/^https:\/\//, '').slice(0, 26) + (exp.length > 34 ? '…' : ''), indices: [String(m.index), String(m.index + m[0].length)] });
    }
    return { hashtags, symbols: [], user_mentions, urls };
  }

  function base(rec, id, full, rangeStart, ments) {
    const c = counts.get(rec.id) || { likes: 0, rts: 0 };
    return {
      edit_info: { initial: { editTweetIds: [id], editableUntil: new Date(rec.t + 3600000).toISOString(), editsRemaining: '5', isEditEligible: true } },
      retweeted: false,
      source: '<a href="https://mobile.twitter.com" rel="nofollow">Twitter Web App</a>',
      entities: entitiesFor(full, ments),
      display_text_range: [String(rangeStart), String([...full].length)],
      favorite_count: String(c.likes),
      id_str: id,
      truncated: false,
      retweet_count: String(c.rts),
      id,
      created_at: twitterDate(rec.t),
      favorited: false,
      full_text: escapeHtml(full),
      lang: 'en',
    };
  }

  function tweetObject(rec) {
    const id = tweetId.get(rec.id);
    const replyTo = rec.replyTo >= 0 ? rec.replyTo : -1;
    const ments = (rec.mentions || []).filter(i => i >= 0);
    // A reply starts with the replied-to handle (outside display_text_range); other mentions are inline.
    const lead = replyTo >= 0 ? [replyTo] : [];
    const inline = ments.filter(i => i !== replyTo);
    const { prefix } = textWithMentions(rec, lead);
    const body = shorten(rec.text ?? '');
    const full = prefix + (inline.length ? inline.map(i => '@' + handle(i)).join(' ') + ' ' : '') + body;
    const t = base(rec, id, full, [...prefix].length, [...lead, ...inline]);
    if (replyTo >= 0 && rec.parent >= 0 && tweetId.has(rec.parent)) {
      const pid = tweetId.get(rec.parent);
      Object.assign(t, {
        in_reply_to_status_id_str: pid, in_reply_to_status_id: pid,
        in_reply_to_user_id: ident.accountId[replyTo], in_reply_to_user_id_str: ident.accountId[replyTo],
      });
      // Spec quirk: the screen name is sometimes missing even when the user id is present.
      if (r.chance(0.9)) t.in_reply_to_screen_name = handle(replyTo);
    }
    return t;
  }

  function retweetObject(rec) {
    const id = snowflake(rec.t, X_EPOCH, r);
    const p = byId.get(rec.parent);
    const src = p.actor;
    let orig = `RT @${handle(src)}: ${shorten(p.text ?? '')}`;
    // Retweet text is truncated in the archive.
    if ([...orig].length > 140) orig = [...orig].slice(0, 139).join('') + '…';
    const t = base(rec, id, orig, 0, [src]);
    t.retweet_count = '0'; t.favorite_count = '0';
    return t;
  }

  // ---- DMs: one conversation per pair, "<idA>-<idB>", newest message first.
  const dms = [];
  for (const [si, recs] of dmConvs) {
    const [a, b] = ctx.spaces[si].members;
    const ids = [ident.accountId[a], ident.accountId[b]].sort((x, y) => (BigInt(x) < BigInt(y) ? -1 : 1));
    const messages = recs.map(rec => ({
      messageCreate: {
        recipientId: ident.accountId[rec.to[0]], reactions: [], urls: [], text: rec.text ?? '', mediaUrls: [],
        senderId: ident.accountId[rec.actor], id: snowflake(rec.t, X_EPOCH, r), createdAt: new Date(rec.t).toISOString(),
      },
    })).reverse();
    dms.push({ dmConversation: { conversationId: ids.join('-'), messages } });
  }

  // ---- follow lists at export time (true ties still active, other account still there).
  const following = [], followers = [];
  const ties = world.ties;
  const live = i => world.leftAt[i] >= span.end;
  for (let ti = 0; ti < ties.count; ti++) {
    if (!(ties.from[ti] < span.end) || ties.until[ti] < span.end) continue;
    const a = ties.a[ti], b = ties.b[ti];
    if (a === ego && live(b)) following.push({ following: { accountId: ident.accountId[b], userLink: `https://twitter.com/intent/user?user_id=${ident.accountId[b]}` } });
    if (b === ego && live(a)) followers.push({ follower: { accountId: ident.accountId[a], userLink: `https://twitter.com/intent/user?user_id=${ident.accountId[a]}` } });
    if (a === ego && live(b)) (native.following ||= []).push(b);
    if (b === ego && live(a)) (native.followers ||= []).push(a);
  }

  const attrs = world.people.attrs[ego];
  const created = new Date(span.start - (attrs.account_age_days || 400) * 86400000);
  const account = [{ account: { email: world.people.email?.[ego] || `${handle(ego)}@mail.example`, createdVia: 'web', username: handle(ego), accountId: egoId, createdAt: created.toISOString(), accountDisplayName: world.people.label[ego] } }];
  const profile = [{ profile: { description: { bio: attrs.bio || '', website: '', location: attrs.location || '' }, avatarMediaUrl: `https://pbs.twimg.example/profile_images/${r.digits(19)}/${r.hex(8)}.jpg` } }];

  // ---- data files
  const files = [];
  const dataTypes = {};
  const addType = (type, file, items, extra = {}) => {
    const parts = type === 'tweets' && items.length > PART_SIZE ? chunk(items, PART_SIZE) : [items];
    const list = parts.map((p, k) => {
      const fileName = `data/${k === 0 ? file : file.replace(/\.js$/, `-part${k}.js`)}`;
      const global = `YTD.${file.replace(/\.js$/, '').replace(/-/g, '_')}.part${k}`;
      files.push({ path: fileName, bytes: u8(`window.${global} = ${p.length ? xStringify(p) : '[ ]'}`) });
      return { fileName, globalName: global, count: String(p.length) };
    });
    dataTypes[camel(file.replace(/\.js$/, ''))] = { ...extra, files: list };
  };
  addType('account', 'account.js', account);
  addType('profile', 'profile.js', profile, { mediaDirectory: 'data/profile_media' });
  addType('tweets', 'tweets.js', tweets, { mediaDirectory: 'data/tweets_media' });
  addType('like', 'like.js', likes);
  addType('follower', 'follower.js', followers);
  addType('following', 'following.js', following);
  addType('directMessages', 'direct-messages.js', dms, { mediaDirectory: 'data/direct_messages_media' });
  addType('directMessagesGroup', 'direct-messages-group.js', [], { mediaDirectory: 'data/direct_messages_group_media' });
  addType('block', 'block.js', []);
  addType('mute', 'mute.js', []);
  const readme = 'Twitter archive\n\nThis archive contains your account data. Each data/*.js file is a JavaScript assignment of a JSON array.\n\ntweets.js: the posts, replies and retweets you wrote.\nlike.js: the posts you liked.\nfollower.js / following.js: account ids of your followers and the accounts you follow.\ndirect-messages.js: your one-to-one direct message conversations.\n';
  files.push({ path: 'data/README.txt', bytes: u8(readme) });
  const size = files.reduce((s, f) => s + f.bytes.length, 0);
  const manifest = {
    userInfo: { accountId: egoId, userName: handle(ego), displayName: world.people.label[ego] },
    archiveInfo: { sizeBytes: String(size), generationDate: new Date(span.end).toISOString(), isPartialArchive: false, maxPartSizeBytes: '53687091200' },
    readmeInfo: { fileName: 'data/README.txt', directory: 'data/', name: 'README.txt' },
    dataTypes,
  };
  files.unshift({ path: 'data/manifest.js', bytes: u8(`window.__THAR_CONFIG = ${xStringify(manifest)}`) });
  files.unshift({ path: 'Your archive.html', bytes: u8('<!DOCTYPE html><html><head><meta charset="utf-8"><title>Your archive</title></head><body><p>Open the data folder to read your archive.</p></body></html>\n') });
  const p = parts(span.end);
  return [{ path: `twitter-${p.y}-${pad(p.mo)}-${pad(p.d)}-${r.hex(64)}.zip`, bytes: zip(files, span.end) }];
}

// "Tue Mar 05 14:02:11 +0000 2024"
function twitterDate(t) {
  const p = parts(t);
  return `${WDAY[p.dow]} ${MON[p.mo - 1]} ${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)} +0000 ${p.y}`;
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const camel = s => s.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const chunk = (a, n) => { const out = []; for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n)); return out; };

// X writes `"key" : value` with two-space indentation.
function xStringify(v, ind = '') {
  const next = ind + '  ';
  if (Array.isArray(v)) {
    if (!v.length) return '[ ]';
    return '[ ' + v.map(x => xStringify(x, ind)).join(', ') + ' ]';
  }
  if (v && typeof v === 'object') {
    const keys = Object.keys(v).filter(k => v[k] !== undefined);
    if (!keys.length) return '{ }';
    return '{\n' + keys.map(k => `${next}${JSON.stringify(k)} : ${xStringify(v[k], next)}`).join(',\n') + `\n${ind}}`;
  }
  return JSON.stringify(v);
}
