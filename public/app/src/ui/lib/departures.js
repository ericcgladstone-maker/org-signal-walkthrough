// People who left part-way through the data (J7): a deactivated account, or
// someone who was active and then went silent well before the data ends.
// A whole-period measure mixes the time before and after they left, and the
// rank-stability resampling cannot see that, so the People table, the
// profile and the stability panel mark them.

import { isDeactivated } from './measures.js';

const DAY = 86400000;

// Silent for at least two weeks and at least 15% of the span, after at least
// five events of their own, in data covering four weeks or more.
export const QUIET = { minDays: 14, minShare: 0.15, minEvents: 5, minSpanDays: 28 };

const cache = new WeakMap();

// Map(dataset index -> { kind: 'deactivated' | 'silent', last, quietDays })
export function departures(ds, opts = QUIET) {
  if (!ds?.nodes) return new Map();
  const hit = cache.get(ds);
  if (hit && hit.opts === opts) return hit.value;
  const n = ds.nodes.count;
  const e = ds.events || { count: 0 };
  const last = new Float64Array(n).fill(-Infinity);
  const count = new Uint32Array(n);
  let t0 = Infinity, t1 = -Infinity;
  for (let k = 0; k < e.count; k++) {
    const t = e.t[k];
    if (!(t === t)) continue;
    if (t < t0) t0 = t;
    if (t > t1) t1 = t;
    const a = e.actor[k];
    if (a >= 0 && a < n) { count[a]++; if (t > last[a]) last[a] = t; }
  }
  const out = new Map();
  const span = t1 - t0;
  // Silence means leaving only in a bounded group's record (view 'full', such
  // as a workspace export). In one person's exports (chats, a mailbox, an
  // archive; family or context 'personal') a contact who goes quiet has just
  // stopped talking with the owner, so only deactivations are marked there.
  const timed = Number.isFinite(span) && span >= opts.minSpanDays * DAY && wholeGroup(ds);
  const gap = Math.max(opts.minDays * DAY, opts.minShare * span);
  for (let i = 0; i < n; i++) {
    const lt = Number.isFinite(last[i]) ? last[i] : null;
    if (isDeactivated(ds, i)) out.set(i, { kind: 'deactivated', last: lt, quietDays: lt != null && timed ? Math.floor((t1 - lt) / DAY) : null });
    else if (timed && count[i] >= opts.minEvents && t1 - last[i] >= gap) out.set(i, { kind: 'silent', last: lt, quietDays: Math.floor((t1 - lt) / DAY) });
  }
  cache.set(ds, { opts, value: out });
  return out;
}

// Does any source record a whole group (not one person's view of it)?
export function wholeGroup(ds) {
  const S = ds?.meta?.sources || [];
  if (!S.length) return true;
  return S.some(x => (x.view == null || x.view === 'full') && x.family !== 'personal' && x.context !== 'personal');
}

// Does the data carry times that differ? (Drawings have none and an
// interview stamps every answer with the same moment: "first and last seen"
// and a monthly series mean nothing there.)
export function hasTimes(ds) {
  const e = ds?.events;
  if (!e) return false;
  let first = null;
  for (let k = 0; k < e.count; k++) {
    const t = e.t[k];
    if (!(t === t)) continue;
    if (first == null) first = t;
    else if (t !== first) return true;
  }
  return false;
}
