// Seeded random numbers for the synthetic generator.
//
// Everything the generator does must be reproducible: the same spec and seed
// give byte-identical output. Math.random is never used. Each stage takes its
// own stream from fork(label), derived from the root seed and the label rather
// than from the parent's current state, so adding content generation (which
// draws many numbers) never changes the structure that was drawn before it.

// 32-bit string hash (cyrb53 folded to 32 bits). Stable across engines.
export function hashString(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (h1 ^ h2) >>> 0;
}

function splitmix32(a) {
  return () => {
    a = (a + 0x9e3779b9) | 0;
    let t = a ^ (a >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0);
  };
}

export class Rng {
  constructor(seed = 1) {
    this.seed = String(seed);
    const sm = splitmix32(hashString(this.seed));
    // sfc32 state
    this.a = sm(); this.b = sm(); this.c = sm(); this.d = sm();
    for (let i = 0; i < 12; i++) this.u32();
  }

  // A child stream that depends only on (root seed, label).
  fork(label) { return new Rng(this.seed + '/' + label); }

  u32() {
    let { a, b, c, d } = this;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    this.a = a; this.b = b; this.c = c; this.d = d;
    return t >>> 0;
  }

  next() { return this.u32() / 4294967296; }
  int(n) { return Math.floor(this.next() * n); }
  range(lo, hi) { return lo + this.next() * (hi - lo); }
  intRange(lo, hi) { return lo + this.int(hi - lo + 1); } // inclusive
  chance(p) { return this.next() < p; }
  pick(arr) { return arr[this.int(arr.length)]; }

  pickWeighted(items, weights) {
    let total = 0;
    for (const w of weights) total += w;
    let r = this.next() * total;
    for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
    return items[items.length - 1];
  }

  normal(mu = 0, sd = 1) {
    // Box-Muller without caching the second value, so the draw count is fixed per call.
    const u = 1 - this.next(), v = this.next();
    return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  lognormal(mu = 0, sigma = 1) { return Math.exp(this.normal(mu, sigma)); }
  exp(mean = 1) { return -Math.log(1 - this.next()) * mean; }

  poisson(lambda) {
    if (!(lambda > 0)) return 0;
    if (lambda > 40) return Math.max(0, Math.round(this.normal(lambda, Math.sqrt(lambda))));
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= this.next(); } while (p > L);
    return k - 1;
  }

  // Geometric-ish heavy tail for counts (Pareto with minimum xm).
  pareto(xm, alpha) { return xm / Math.pow(1 - this.next(), 1 / alpha); }

  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = this.int(i + 1);
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  // k distinct items (k <= arr.length), order random.
  sample(arr, k) {
    k = Math.min(k, arr.length);
    if (k * 4 < arr.length) {
      const seen = new Set(), out = [];
      while (out.length < k) { const i = this.int(arr.length); if (!seen.has(i)) { seen.add(i); out.push(arr[i]); } }
      return out;
    }
    return this.shuffle(arr.slice()).slice(0, k);
  }

  hex(n) {
    let s = '';
    while (s.length < n) s += this.u32().toString(16).padStart(8, '0');
    return s.slice(0, n);
  }

  // Upper-case base-36 string of length n (Slack-style ids).
  b36(n) {
    const al = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let s = '';
    for (let i = 0; i < n; i++) s += al[this.int(36)];
    return s;
  }

  digits(n) {
    let s = String(1 + this.int(9));
    for (let i = 1; i < n; i++) s += this.int(10);
    return s;
  }

  uuid() {
    const h = this.hex(32);
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${'89ab'[this.int(4)]}${h.slice(17, 20)}-${h.slice(20, 32)}`;
  }
}

// Weighted sampler over a fixed weight array: O(log n) per draw.
export function cumulative(weights) {
  const cum = new Float64Array(weights.length);
  let s = 0;
  for (let i = 0; i < weights.length; i++) { s += Math.max(0, weights[i]); cum[i] = s; }
  return cum;
}

export function drawCum(cum, rng) {
  const total = cum[cum.length - 1];
  if (!(total > 0)) return rng.int(cum.length);
  const r = rng.next() * total;
  let lo = 0, hi = cum.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] > r) hi = mid; else lo = mid + 1; }
  return lo;
}
