// Shared building blocks for social contexts: the true-tie table, adjacency,
// planted diffusion cascades and planted affect.

// The true network. Ties carry a strength, a kind (why the tie exists), and an
// active window [from, until) so planted events (a departure, a reorg) can end
// ties and start new ones partway through the timespan.
export class TieTable {
  constructor(n, { directed = false } = {}) {
    this.n = n;
    this.directed = directed;
    this.a = []; this.b = []; this.w = []; this.kind = []; this.from = []; this.until = [];
    this.kinds = [];
    this._kindIdx = new Map();
    this._index = new Map();
  }

  get count() { return this.a.length; }

  _key(a, b) {
    if (!this.directed && a > b) { const t = a; a = b; b = t; }
    return a * this.n + b;
  }

  find(a, b) { return this._index.get(this._key(a, b)) ?? -1; }
  has(a, b) { return this._index.has(this._key(a, b)); }

  // Add a tie; an existing tie between the same pair keeps its kind and takes the larger weight.
  add(a, b, { w = 1, kind = 'tie', from = -Infinity, until = Infinity } = {}) {
    if (a === b || a < 0 || b < 0) return -1;
    const k = this._key(a, b);
    const ex = this._index.get(k);
    if (ex !== undefined) {
      if (w > this.w[ex]) this.w[ex] = w;
      return ex;
    }
    let ki = this._kindIdx.get(kind);
    if (ki === undefined) { ki = this.kinds.length; this.kinds.push(kind); this._kindIdx.set(kind, ki); }
    const i = this.a.length;
    if (!this.directed && a > b) { const t = a; a = b; b = t; }
    this.a.push(a); this.b.push(b); this.w.push(w); this.kind.push(ki); this.from.push(from); this.until.push(until);
    this._index.set(k, i);
    return i;
  }

  kindOf(i) { return this.kinds[this.kind[i]]; }
  activeAt(i, t) { return this.from[i] <= t && t < this.until[i]; }

  // CSR adjacency. Undirected: both directions in `out`. Directed: `out` and `in`.
  adjacency() {
    if (this._adj) return this._adj;
    const n = this.n, m = this.a.length;
    const build = (src, dst) => {
      const off = new Int32Array(n + 1);
      for (let i = 0; i < m; i++) { off[src[i] + 1]++; if (!this.directed) off[dst[i] + 1]++; }
      for (let i = 0; i < n; i++) off[i + 1] += off[i];
      const pos = off.slice(0, n);
      const nbr = new Int32Array(off[n]), tie = new Int32Array(off[n]);
      for (let i = 0; i < m; i++) {
        let p = pos[src[i]]++; nbr[p] = dst[i]; tie[p] = i;
        if (!this.directed) { p = pos[dst[i]]++; nbr[p] = src[i]; tie[p] = i; }
      }
      return { off, nbr, tie };
    };
    this._adj = { out: build(this.a, this.b) };
    this._adj.in = this.directed ? build(this.b, this.a) : this._adj.out;
    return this._adj;
  }

  neighbors(i, dir = 'out') {
    const g = this.adjacency()[dir];
    const out = [];
    for (let p = g.off[i]; p < g.off[i + 1]; p++) out.push(g.nbr[p]);
    return out;
  }

  degree(i, dir = 'out') { const g = this.adjacency()[dir]; return g.off[i + 1] - g.off[i]; }

  // Structured-cloneable columnar copy for ground truth.
  freeze() {
    return {
      directed: this.directed, count: this.a.length, kinds: this.kinds.slice(),
      a: Int32Array.from(this.a), b: Int32Array.from(this.b), w: Float32Array.from(this.w),
      kind: Uint8Array.from(this.kind),
      from: Float64Array.from(this.from, x => (x === -Infinity ? NaN : x)),
      until: Float64Array.from(this.until, x => (x === Infinity ? NaN : x)),
    };
  }
}

// Binary min-heap keyed by time, for cascade simulation.
class Heap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= k[i]) break; [k[p], k[i]] = [k[i], k[p]]; [v[p], v[i]] = [v[i], v[p]]; i = p; }
  }
  pop() {
    const k = this.k, v = this.v;
    const top = [k[0], v[0]];
    const lk = k.pop(), lv = v.pop();
    if (k.length) {
      k[0] = lk; v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]]; [v[m], v[i]] = [v[i], v[m]]; i = m;
      }
    }
    return top;
  }
}

// Plant diffusion: each seed term starts with one person and spreads along
// active true ties as an independent cascade with random delays. Per tie the
// transmission chance rises with strength. For directed (follow) networks the
// term flows from the followed account to its followers.
export function plantCascades(world, rng, { terms, seeds, t0, p0 = 0.25, meanDelayDays = 4, flow = 'out' }) {
  const ties = world.ties;
  const adj = ties.adjacency();
  const g = ties.directed ? (flow === 'in' ? adj.in : adj.out) : adj.out;
  const end = world.span.end;
  const cascades = [];
  for (let k = 0; k < terms.length; k++) {
    const seed = seeds[k];
    const best = new Map([[seed, t0]]);
    const from = new Map([[seed, -1]]);
    const done = new Set();
    const heap = new Heap();
    heap.push(t0, seed);
    const r = rng.fork('cascade:' + terms[k]);
    const adopters = [];
    while (heap.size) {
      const [t, u] = heap.pop();
      if (done.has(u) || t !== best.get(u)) continue;
      done.add(u);
      adopters.push({ node: u, t, from: from.get(u) });
      for (let p = g.off[u]; p < g.off[u + 1]; p++) {
        const v = g.nbr[p], ti = g.tie[p];
        if (done.has(v) || world.isBot?.[v]) continue;
        const pt = 1 - Math.pow(1 - p0, Math.min(4, ties.w[ti]));
        if (!r.chance(pt)) continue;
        const tv = t + (0.5 + r.exp(meanDelayDays)) * 86400000;
        if (tv >= end || !(ties.from[ti] <= tv && tv < ties.until[ti])) continue;
        if (world.leftAt && world.leftAt[v] <= tv) continue;
        if (!(best.get(v) <= tv)) { best.set(v, tv); from.set(v, u); heap.push(tv, v); }
      }
    }
    cascades.push({ term: terms[k], seed, t0, adopters });
  }
  // Per-person adoption lookup used by content generation.
  const adoptedAt = new Map();
  for (const c of cascades) for (const a of c.adopters) {
    if (!adoptedAt.has(a.node)) adoptedAt.set(a.node, []);
    adoptedAt.get(a.node).push([c.term, a.t]);
  }
  return { cascades, adoptedAt };
}

// Planted affect. Valence in [-1, 1] = base for the person's group plus any
// time-bounded rule that matches (group, layer, person, visibility).
export class AffectPlan {
  constructor() { this.base = new Map(); this.rules = []; this.defaultValence = 0.1; }
  setGroup(g, v) { this.base.set(g, v); }
  addRule(rule) { this.rules.push({ from: -Infinity, until: Infinity, ...rule }); }
  valence(world, person, t, visibility) {
    const g = world.group ? world.group[person] : -1;
    let v = this.base.has(g) ? this.base.get(g) : this.defaultValence;
    for (const r of this.rules) {
      if (t < r.from || t >= r.until) continue;
      if (r.group != null && r.group !== g) continue;
      if (r.layer != null && world.layer?.[person] !== r.layer) continue;
      if (r.person != null && r.person !== person) continue;
      if (r.visibility != null && r.visibility !== visibility) continue;
      v += r.delta;
    }
    return Math.max(-0.95, Math.min(0.95, v));
  }
  toJSON(groupNames) {
    return {
      base: [...this.base].map(([g, v]) => ({ group: g, name: groupNames?.[g] ?? String(g), valence: round(v) })),
      rules: this.rules.map(r => ({ ...r, from: Number.isFinite(r.from) ? r.from : null, until: Number.isFinite(r.until) ? r.until : null })),
    };
  }
}

export const round = (x, d = 3) => Math.round(x * 10 ** d) / 10 ** d;

// Clamp a numeric param into [min, max], recording any change.
export function clampParam(params, key, min, max, notes) {
  const v = params[key];
  if (v == null || Number.isNaN(v)) return;
  const c = Math.max(min, Math.min(max, v));
  if (c !== v) { notes.push(`${key} adjusted from ${v} to ${c} to keep the combination realistic`); params[key] = c; }
}

export function mergeParams(schema, defaults, spec, preset) {
  const out = {};
  for (const p of schema) out[p.key] = defaults[p.key];
  if (preset) Object.assign(out, preset.params || {});
  for (const p of schema) if (spec[p.key] !== undefined && spec[p.key] !== null) out[p.key] = spec[p.key];
  if (spec.params) for (const p of schema) if (spec.params[p.key] !== undefined) out[p.key] = spec.params[p.key];
  return out;
}

// Validate numeric params against their schema bounds.
export function applySchemaBounds(schema, params, notes) {
  for (const p of schema) {
    if (p.type === 'int' || p.type === 'number') {
      if (params[p.key] == null) continue;
      let v = Number(params[p.key]);
      if (p.type === 'int') v = Math.round(v);
      params[p.key] = v;
      clampParam(params, p.key, p.min ?? -Infinity, p.max ?? Infinity, notes);
    } else if (p.type === 'enum' && params[p.key] != null && !p.values.includes(params[p.key])) {
      notes.push(`${p.key} "${params[p.key]}" is not one of ${p.values.join(', ')}; using ${p.default}`);
      params[p.key] = p.default;
    }
  }
}

// Index a list of members per space for quick shared-space lookups.
export function spacesByPerson(n, spaces) {
  const by = Array.from({ length: n }, () => []);
  spaces.forEach((s, si) => { if (!s.everyone) for (const m of s.members) by[m].push(si); });
  return by;
}
