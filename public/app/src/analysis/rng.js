// Seeded random numbers. Every stochastic step in the analysis engine (null
// models, bootstrap, Louvain, layout, LDA, pivot sampling) takes a seed so the
// same inputs always give the same numbers: results the user saw yesterday
// must be reproducible today, and tests must be deterministic.

// mulberry32: small, fast, good enough statistical quality for resampling.
export function createRng(seed = 1) {
  let a = (hashSeed(seed) >>> 0) || 0x9e3779b9;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.int = (n) => Math.floor(next() * n);          // 0 .. n-1
  next.shuffle = (arr) => {                           // in place, Fisher-Yates
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      const tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  };
  next.fork = (k) => createRng(((a ^ Math.imul(k + 1, 0x85ebca6b)) >>> 0) + k);
  return next;
}

// Seeds may be numbers or strings; strings hash so 'run-1' is a valid seed.
function hashSeed(seed) {
  if (typeof seed === 'number' && Number.isFinite(seed)) return Math.floor(seed) ^ 0x5bd1e995;
  const s = String(seed);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h;
}

// Sample k distinct integers from 0..n-1 (k <= n), deterministic for a given rng.
export function sampleWithoutReplacement(n, k, rng) {
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(rng() * (n - i));
    const tmp = idx[i]; idx[i] = idx[j]; idx[j] = tmp;
  }
  return idx.slice(0, k);
}
