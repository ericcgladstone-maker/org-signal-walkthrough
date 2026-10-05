// Rank stability in plain words (decision 5, L10, J6, N14).
//
// resampleRanks gives each person their observed rank and the 95% range of
// their rank over resamples of the events (lo..hi). The reading for a chosen
// top k:
//   settled    the range is one rank:           "Settled: stays at rank 1"
//   in top k   the whole range is within top k: "In the top 5 every time; place 2 to 4"
//   edge       the range crosses k:             "Could drop out of the top 5: ranks 4 to 9"
//   outside    the range starts after k
// and, separately, people whose values are equal at the precision shown,
// whose order is not a finding however narrow their ranges are.

import { fmtInt } from './format.js';

export const TOP_CHOICES = [3, 5, 10];

export function stabilityReading(r, k) {
  if (!r) return null;
  const range = r.lo === r.hi ? `rank ${fmtInt(r.lo)}` : `ranks ${fmtInt(r.lo)} to ${fmtInt(r.hi)}`;
  if (r.lo === r.hi && r.lo === r.rank) return { level: 'settled', text: `Settled: stays at rank ${fmtInt(r.rank)} in the resamples` };
  if (r.hi <= k) return { level: 'top', text: `In the top ${k} in the resamples; exact place moves (${range})` };
  if (r.lo <= k) return { level: 'edge', text: `Could drop out of the top ${k}: ${range} in the resamples` };
  return { level: 'outside', text: `Outside the top ${k}: ${range} in the resamples` };
}

// Summary over the top k rows (sorted by observed rank): how many are a
// finding, and which places are ties at the shown precision.
//   rows: [{ node, rank, lo, hi, value }]; fmt: the column formatter.
export function stabilitySummary(rows, k, fmt = String) {
  const top = rows.filter(r => r.rank <= k);
  const levels = top.map(r => stabilityReading(r, k).level);
  const settled = levels.filter(l => l === 'settled').length;
  const inTop = levels.filter(l => l === 'settled' || l === 'top').length;
  // Runs of equal displayed values among the top k and the people just
  // after (a tie at rank 5 may run to rank 8).
  const groups = [];
  const shown = rows.slice(0, Math.max(k + 6, k));
  let i = 0;
  while (i < shown.length) {
    const t = fmt(shown[i].value);
    let j = i + 1;
    while (j < shown.length && fmt(shown[j].value) === t) j++;
    if (j - i > 1 && shown[i].rank <= k) groups.push({ from: shown[i].rank, to: shown[j - 1].rank, text: t, nodes: shown.slice(i, j).map(r => r.node) });
    i = j;
  }
  const tiedNodes = new Set(groups.flatMap(g => g.nodes));
  // Only people whose place is both settled-in-top-k and not tied are a finding.
  const findings = top.filter((r, x) => (levels[x] === 'settled' || levels[x] === 'top') && !tiedNodes.has(r.node)).length;
  const allPoint = top.length > 0 && top.every(r => r.lo === r.hi);
  let verdict;
  if (!top.length) verdict = 'No ranking to read.';
  else if (findings === top.length) verdict = `The top ${k} hold: every one stays in the top ${k} in the resamples${settled === top.length ? ', at the same place' : ''}.`;
  else if (findings === 0) verdict = `The top ${k} is not a finding: none of these places holds up in the resamples or at the precision shown.`;
  else verdict = `${fmtInt(findings)} of the top ${k} hold up; the other places are not a finding.`;
  return { k, top, settled, inTop, findings, groups, tiedNodes, allPoint, verdict };
}

// The caveat every reading carries (N14): resampling events moves weights
// but almost never removes a whole tie, so it cannot test whether ties
// exist; for measures that ignore weights (betweenness, closeness, degree)
// a one-rank interval says the rank does not depend on message volume, not
// that it is certain.
export const IGNORES_WEIGHTS = new Set(['betweenness', 'closeness', 'degree', 'contacts', 'clustering', 'coreNumber']);

export function resamplingCaveat(metric, allPoint) {
  const base = 'Resampling redraws the messages behind the ties, so it shows how much a rank depends on message volume. It almost never removes a whole tie, so it cannot test whether a tie exists or what missing ties would do.';
  if (allPoint && IGNORES_WEIGHTS.has(metric)) return `${base} This measure ignores tie weights, so narrow intervals here are expected and are not proof the ranking is certain.`;
  return base;
}
