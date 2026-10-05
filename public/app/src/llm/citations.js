// Citation check: is every number in a model's answer one the tools returned?
//
// The analyst may only cite numbers the analysis engine computed. After each
// answer we extract every number from the text and look for it among the
// numbers in that turn's tool results (and the tool arguments, and the user's
// question). A number matches when it equals a computed value after rounding
// to the precision the answer wrote it with, or as a percentage of a
// proportion (0.234 cited as "23%" or "23.4%"). Anything else is reported as
// unverified so the UI can flag it; we do not try to guess what arithmetic
// the model did, because derived numbers are exactly what should be flagged.

// Numbers in the text, with the precision they were written at.
// Handles 1,234  -0.12  (unicode minus)  1.2e-3  .5  45%
const NUM_RE = /(?<![\w.])([-−]?)(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(?:[eE]([-+]?\d+))?(\s?%|\s?percent\b)?/g;

export function extractNumbers(text) {
  const out = [];
  if (!text) return out;
  const s = String(text);
  for (const m of s.matchAll(NUM_RE)) {
    const [whole, sign, int, frac, exp, pct] = m;
    if (!int && !frac) continue;
    const start = m.index;
    const raw = `${sign ? '-' : ''}${(int || '0').replace(/,/g, '')}${frac || ''}${exp != null ? `e${exp}` : ''}`;
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const decimals = frac ? frac.length - 1 : 0;
    out.push({ text: whole.trim(), value, decimals: exp != null ? decimals - Number(exp) : decimals, percent: !!pct, index: start, end: start + whole.length });
  }
  return out;
}

// Numbers that are not claims: markdown list markers, citation ids like [T3],
// heading numbers, and author-year citations such as "Burt (1992)" or
// "Blondel et al. 2008" from the model's labelled general knowledge.
function isExempt(text, n) {
  const before = text.slice(Math.max(0, n.index - 24), n.index);
  const after = text.slice(n.end, n.end + 3);
  // List marker: at line start followed by "." or ")" and a space.
  if (/(^|\n)\s*$/.test(before) && /^[.)]\s/.test(after) && Number.isInteger(n.value)) return true;
  // Inside a citation marker [T3] or [T3, T4].
  if (/\[(?:T\d+,\s*)*T$/.test(before)) return true;
  // Heading level digits like "## 2 Results" are rare; years in author-year cites are common.
  if (Number.isInteger(n.value) && n.value >= 1900 && n.value <= 2099 && !n.percent) {
    if (/(?:et al\.?|&|and|[A-Z][a-z]+),?\s*\(?$/.test(before)) return true;
  }
  return false;
}

// Collect numbers from any JSON-ish value, including numbers embedded in
// strings (dates "2024-03-01", labels like "Team 3").
export function collectNumbers(v, out = []) {
  if (v == null) return out;
  if (typeof v === 'number') { if (Number.isFinite(v)) out.push(v); return out; }
  if (typeof v === 'string') { for (const n of extractNumbers(v)) { out.push(n.value); if (n.value < 0) out.push(-n.value); } return out; }
  if (typeof v === 'boolean') return out;
  if (Array.isArray(v)) { for (const x of v) collectNumbers(x, out); return out; }
  if (typeof v === 'object') for (const x of Object.values(v)) collectNumbers(x, out);
  return out;
}

// Does an answer number match a computed value?
export function matches(n, y) {
  const tol = 0.5 * 10 ** -Math.max(0, n.decimals) + 1e-9;
  const close = (a, b, t) => Math.abs(a - b) <= t * (1 + 1e-9);
  // Signs must agree: a dropped minus ("z of 2.1" for -2.1) is a different claim.
  if (close(n.value, y, tol)) return true;
  // A proportion cited as a percentage: "23.4%" or "23 percent" for 0.2341.
  if (n.percent && close(n.value / 100, y, tol / 100)) return true;
  return false;
}

// checkCitations(text, results, { question }) ->
//   { citations: [{ id, tool, args, numbers: [text], cited }], unverifiedNumbers: [{ text, value, index }], verifiedCount }
// results: tool records from the runner ({ id, name, args, result, error }).
export function checkCitations(text, results = [], { question = '' } = {}) {
  const pools = results.map(r => ({ r, nums: collectNumbers([r.result, r.args]) }));
  const questionNums = collectNumbers(question);
  const cited = new Set([...String(text || '').matchAll(/\[(T\d+(?:\s*,\s*T\d+)*)\]/g)].flatMap(m => m[1].split(/\s*,\s*/)));
  const byId = new Map(results.map(r => [r.id, { id: r.id, tool: r.name, args: r.args, numbers: [], cited: cited.has(r.id) }]));
  const unverified = [];
  let verified = 0;
  for (const n of extractNumbers(text)) {
    if (isExempt(text, n)) continue;
    let found = false;
    for (const { r, nums } of pools) {
      if (nums.some(y => matches(n, y))) { byId.get(r.id).numbers.push(n.text); found = true; }
    }
    if (!found && questionNums.some(y => matches(n, y))) found = true;
    if (found) verified++;
    else unverified.push({ text: n.text, value: n.value, index: n.index });
  }
  const unknownIds = [...cited].filter(id => !byId.has(id));
  return {
    citations: [...byId.values()].filter(c => c.cited || c.numbers.length),
    unverifiedNumbers: unverified,
    unknownCitationIds: unknownIds,
    verifiedCount: verified,
  };
}
