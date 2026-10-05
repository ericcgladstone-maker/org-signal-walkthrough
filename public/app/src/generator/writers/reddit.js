// Reddit research dumps (Pushshift / Arctic Shift style), per
// docs/formats/reddit.md section (b): per-subreddit NDJSON extracts, already
// decompressed (browsers cannot rely on zstd), named
// `<subreddit>_submissions.ndjson` and `<subreddit>_comments.ndjson`.
// One JSON object per line with keys sorted and lines ordered by
// (created_utc, id), as post-2023 dumps are. Ids are base-36 without prefix;
// link_id / parent_id / name carry t3_ / t1_ prefixes; author_fullname t2_.
// A sample view keeps only what sampled authors wrote, so some parents are
// missing, as in real samples.

import { u8 } from './util.js';

export function write({ world, ctx, records, ident, obs, rng }) {
  const r = rng.fork('reddit');
  // Base-36 ids increase with time, like real ones.
  let nextSub = parseInt('1a' + r.b36(4).toLowerCase(), 36);
  let nextCom = parseInt('k' + r.b36(6).toLowerCase(), 36);
  const fullname = new Map();
  const userFull = a => {
    if (a < 0) return 't2_6l4z3';
    if (!fullname.has(a)) fullname.set(a, 't2_' + (parseInt(r.b36(8), 36)).toString(36));
    return fullname.get(a);
  };
  const author = a => (a < 0 ? (ctx.bots[-1 - a]?.name || 'AutoModerator') : ident.username[a]);
  const keep = rec => obs.view !== 'sample' || (rec.actor >= 0 && obs.sampled?.[rec.actor] === 1);

  const out = [];
  ctx.spaces.forEach((s, si) => {
    if (s.kind !== 'subreddit') return;
    const subId = 't5_' + parseInt(r.b36(5), 36).toString(36);
    const recs = records.filter(x => x.space === si && x.kind === 'message');
    const info = new Map(); // record id -> { id36, isSub, root36, slug }
    const subs = [], coms = [];
    const nComments = new Map();
    for (const rec of recs) {
      if (rec.meta?.submission) {
        const id36 = (nextSub += 1 + r.int(40)).toString(36);
        info.set(rec.id, { id36, isSub: true, root36: id36, slug: slugOf(rec.subject || rec.text || 'post') });
      } else {
        const p = info.get(rec.parent);
        if (!p) continue;
        const id36 = (nextCom += 1 + r.int(300)).toString(36);
        info.set(rec.id, { id36, isSub: false, root36: p.root36, slug: p.slug });
        nComments.set(p.root36, (nComments.get(p.root36) || 0) + 1);
      }
    }
    for (const rec of recs) {
      const me = info.get(rec.id);
      if (!me || !keep(rec)) continue;
      const created = Math.floor(rec.t / 1000);
      const mod = rec.actor < 0 || rec.meta?.distinguished === 'moderator' || !!rec.meta?.stickied;
      const common = {
        author: author(rec.actor), author_fullname: userFull(rec.actor), created_utc: created,
        distinguished: mod ? 'moderator' : null, id: me.id36, retrieved_on: created + 36 * 3600,
        score: rec.meta?.score ?? 1, stickied: !!rec.meta?.stickied, subreddit: s.name, subreddit_id: subId,
      };
      if (me.isSub) {
        const permalink = `/r/${s.name}/comments/${me.id36}/${me.slug}/`;
        subs.push(sorted({ ...common, is_self: true, name: 't3_' + me.id36, num_comments: nComments.get(me.id36) || 0, over_18: false, permalink, selftext: rec.text ?? '', title: rec.subject || (rec.text ?? '').slice(0, 80) || 'Untitled', url: 'https://www.reddit.com' + permalink }));
      } else {
        const p = info.get(rec.parent);
        coms.push(sorted({ ...common, body: rec.text ?? '', edited: false, link_id: 't3_' + me.root36, name: 't1_' + me.id36, parent_id: (p.isSub ? 't3_' : 't1_') + p.id36, permalink: `/r/${s.name}/comments/${me.root36}/${me.slug}/${me.id36}/` }));
      }
    }
    const order = (a, b) => a.created_utc - b.created_utc || parseInt(a.id, 36) - parseInt(b.id, 36);
    subs.sort(order); coms.sort(order);
    out.push({ path: `${s.name}_submissions.ndjson`, bytes: u8(subs.map(o => JSON.stringify(o)).join('\n') + (subs.length ? '\n' : '')) });
    out.push({ path: `${s.name}_comments.ndjson`, bytes: u8(coms.map(o => JSON.stringify(o)).join('\n') + (coms.length ? '\n' : '')) });
  });
  return out;
}

function sorted(o) { const out = {}; for (const k of Object.keys(o).sort()) out[k] = o[k]; return out; }
function slugOf(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').split('_').slice(0, 8).join('_') || 'post'; }
