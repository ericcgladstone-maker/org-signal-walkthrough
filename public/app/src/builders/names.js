// Name helpers for anywhere a person is named or picked: type-ahead matching
// against a list, and the "is this someone you already named?" check that
// keeps "Jon" and "Jonathan Reyes" from becoming two people.
//
// Pure functions over plain labels; the UI (src/ui/build/pick.js) wraps them.

import { normName } from './common.js';

const parts = s => normName(s).replace(/[.,'’-]/g, ' ').split(/\s+/).filter(Boolean);

// Levenshtein distance with an early exit above `max` (names are short).
export function editDistance(a, b, max = 3) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// Why `name` may be the same person as `other`, or null. Reasons, strongest first:
//   'same'        identical after normalising case, spacing and accents
//   'spelling'    full names within edit distance 2 ("Jon Reyes" / "John Reyes")
//   'initial'     an initial and the same surname ("J. Reyes" / "Jonathan Reyes")
//   'short'       one is the other's first name or a short form of it ("Jon" / "Jonathan Reyes")
//   'first-name'  same first name, different surname ("Ana Ruiz" / "Ana Lopez"): could be either
export function duplicateReason(name, other) {
  const a = normName(name), b = normName(other);
  if (!a || !b) return null;
  if (a === b) return 'same';
  const pa = parts(name), pb = parts(other);
  if (!pa.length || !pb.length) return null;
  const longEnough = Math.min(a.length, b.length) >= 4;
  if (longEnough && editDistance(a, b, 2) <= 2) return 'spelling';
  if (pa.length >= 2 && pb.length >= 2 && pa[pa.length - 1] === pb[pb.length - 1]) {
    const fa = pa[0], fb = pb[0];
    if ((fa.length === 1 && fb.startsWith(fa)) || (fb.length === 1 && fa.startsWith(fb))) return 'initial';
  }
  // One word against a fuller name: its first name, or a prefix of it (3+ letters).
  if (pa.length === 1 || pb.length === 1) {
    const [single, full] = pa.length === 1 ? [pa[0], pb] : [pb[0], pa];
    if (single.length >= 3 && full[0].startsWith(single)) return 'short';
    if (single.length >= 3 && single.startsWith(full[0]) && full[0].length >= 3) return 'short';
  }
  if (pa.length >= 2 && pb.length >= 2 && pa[0] === pb[0] && pa[0].length >= 2) return 'first-name';
  return null;
}

export const REASON_TEXT = {
  same: 'the same name',
  spelling: 'a near spelling',
  initial: 'the same surname with an initial',
  short: 'a short form of the name',
  'first-name': 'the same first name',
};

// Candidates in `list` ([{ id, label }]) that may be the person typed, best first.
export function likelyDuplicates(name, list, { exclude = null } = {}) {
  const rank = { same: 0, spelling: 1, initial: 2, short: 3, 'first-name': 4 };
  const out = [];
  for (const x of list) {
    if (exclude && x.id === exclude) continue;
    const r = duplicateReason(name, x.label);
    if (r) out.push({ ...x, reason: r });
  }
  return out.sort((p, q) => rank[p.reason] - rank[q.reason] || p.label.localeCompare(q.label));
}

// Type-ahead: items whose label matches the query, best first. A word that
// starts with the query beats a match inside a word; ties keep list order.
export function matchNames(query, list, { limit = 8 } = {}) {
  const q = normName(query);
  if (!q) return list.slice(0, limit);
  const scored = [];
  list.forEach((x, i) => {
    const l = normName(x.label);
    let score = -1;
    if (l === q) score = 0;
    else if (l.startsWith(q)) score = 1;
    else if (l.split(/\s+/).some(w => w.startsWith(q))) score = 2;
    else if (l.includes(q)) score = 3;
    else if (q.length >= 4 && nearSpelling(q, l)) score = 4;
    if (score >= 0) scored.push({ x, score, i });
  });
  return scored.sort((p, q2) => p.score - q2.score || p.i - q2.i).slice(0, limit).map(s => s.x);
}

// Near spelling for type-ahead (C11): the typed text against the start of the
// name, or word by word, allowing one slip per word (two for long text), where
// swapping two letters ("Deigo" for "Diego") is one slip.
function nearSpelling(q, l) {
  const tol = n => (n >= 7 ? 2 : 1);
  if (osa(q, l.slice(0, q.length)) <= tol(q.length)) return true;
  const qw = q.split(/\s+/).filter(w => w.length >= 3), lw = l.split(/\s+/);
  return qw.length > 0 && qw.every(w => lw.some(x => osa(w, x.slice(0, Math.max(w.length, Math.min(x.length, w.length + 1)))) <= tol(w.length)));
}

// Optimal string alignment distance (Levenshtein plus adjacent transpositions).
function osa(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...new Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) {
    const c = a[i - 1] === b[j - 1] ? 0 : 1;
    d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
    if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
  }
  return d[m][n];
}
