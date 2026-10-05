// Fragility evidence (J8). Two numbers a student can defend:
//
// - concentration: the share of all betweenness held by the top k people,
//   against k / n, the share an even spread would give them;
// - a "what if these people left" rebuild: remove them and their ties and
//   compare ties, ties across groups, pieces, the largest piece and the
//   average number of steps between people.
//
// Plain functions over an edge list, so they run on the main thread for the
// networks the map draws in full, and can be tested in Node.

// values: one number per person (network order). Returns { k, share, even, people }.
export function topShare(values, k) {
  const order = Array.from(values.keys()).filter(v => Number.isFinite(values[v])).sort((a, b) => values[b] - values[a] || a - b);
  let total = 0;
  for (const v of order) total += Math.max(0, values[v]);
  const kk = Math.max(0, Math.min(k, order.length));
  let top = 0;
  for (let i = 0; i < kk; i++) top += Math.max(0, values[order[i]]);
  return { k: kk, share: total > 0 ? top / total : NaN, even: order.length ? kk / order.length : NaN, people: order.slice(0, kk) };
}

// Words for a topShare result, relative to an even spread. "Account for most
// of the brokerage" is said only above a stated threshold: they hold at least
// half of all betweenness (DEPENDS_SHARE) and at least three times an even
// share. Below that the ratio to an even share is given, not a verdict. The
// words claim no share of routes: summed betweenness counts a route through
// several of these people once for each of them (M6).
export const DEPENDS_SHARE = 0.5;
export function concentrationWords({ k, share, even }) {
  const ratio = share / (even || 1);
  const pct = x => `${Math.round(x * 100)}%`;
  if (!Number.isFinite(ratio)) return { level: 'na', text: '' };
  const times = `${ratio >= 10 ? Math.round(ratio) : Math.round(ratio * 10) / 10} times the ${pct(even)} an even spread gives`;
  if (share >= DEPENDS_SHARE && ratio >= 3) return { level: 'depends', ratio, text: `${times}: these ${k} people account for most of the brokerage` };
  if (ratio >= 1.8) return { level: 'concentrated', ratio, text: `${times}: concentrated, though they hold under half of it` };
  return { level: 'even', ratio, text: `close to the ${pct(even)} an even spread gives` };
}

// n people, ties src[k] - dst[k] (direction ignored), `removed` a Set of
// people, groupOf(v) a group key or null. Average steps over pairs that can
// reach each other: exact up to `exactMax` people, from `samples` evenly
// spread sources above that.
export function structure(n, src, dst, { removed = new Set(), groupOf = null, exactMax = 2500, samples = 400 } = {}) {
  const adj = Array.from({ length: n }, () => []);
  const seen = new Set();
  let ties = 0, cross = 0, grouped = 0;
  for (let k = 0; k < src.length; k++) {
    const a = src[k], b = dst[k];
    if (a === b || removed.has(a) || removed.has(b)) continue;
    const key = a < b ? a * n + b : b * n + a;
    if (seen.has(key)) continue;
    seen.add(key);
    adj[a].push(b); adj[b].push(a);
    ties++;
    if (groupOf) {
      const ga = groupOf(a), gb = groupOf(b);
      if (ga != null && ga !== '' && gb != null && gb !== '') { grouped++; if (ga !== gb) cross++; }
    }
  }
  const alive = [];
  for (let v = 0; v < n; v++) if (!removed.has(v)) alive.push(v);
  // Components (isolates count as pieces of one).
  const comp = new Int32Array(n).fill(-1);
  let pieces = 0, largest = 0;
  const queue = new Int32Array(n);
  for (const s of alive) {
    if (comp[s] >= 0) continue;
    let head = 0, tail = 0, size = 0;
    queue[tail++] = s; comp[s] = pieces;
    while (head < tail) { const u = queue[head++]; size++; for (const w of adj[u]) if (comp[w] < 0) { comp[w] = pieces; queue[tail++] = w; } }
    if (size > largest) largest = size;
    pieces++;
  }
  // Average steps between people who can reach each other.
  const sources = alive.length <= exactMax ? alive : Array.from({ length: samples }, (_, i) => alive[Math.floor((i * alive.length) / samples)]);
  const dist = new Int32Array(n);
  let sum = 0, pairs = 0;
  for (const s of sources) {
    dist.fill(-1);
    let head = 0, tail = 0;
    queue[tail++] = s; dist[s] = 0;
    while (head < tail) { const u = queue[head++]; for (const w of adj[u]) if (dist[w] < 0) { dist[w] = dist[u] + 1; sum += dist[w]; pairs++; queue[tail++] = w; } }
  }
  return { people: alive.length, ties, cross: groupOf ? cross : null, grouped: groupOf ? grouped : null, pieces, largestShare: alive.length ? largest / alive.length : NaN, avgSteps: pairs ? sum / pairs : NaN, sampled: sources.length < alive.length };
}

export function whatIf(n, src, dst, removedList, opts = {}) {
  return { before: structure(n, src, dst, opts), after: structure(n, src, dst, { ...opts, removed: new Set(removedList) }) };
}
