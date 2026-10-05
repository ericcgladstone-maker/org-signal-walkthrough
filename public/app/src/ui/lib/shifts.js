// What a detected shift changed to (C2). A shift's `value` is the series in
// its first flagged window, which for a step is often a transition window
// (a silo planted midweek gives that week a value halfway down). Reporting it
// as "the new value" misstates the change, so every place that states a
// shift's size also gives the level after it: the median of the windows that
// follow the first flagged one, up to the next shift in the same series or
// the end of the period. Windows the scan left out for thin coverage are left
// out here too. This is a summary of the series the charts draw; it changes
// nothing the detector computes.

// Plain functions, testable in Node.

const MIN_COVERAGE = 0.6;

// The values a shift was found in, from a timeSeries() result.
export function shiftSeries(s, x) {
  if (!s || !x) return null;
  if (x.target === 'node') return s.node?.[x.metric]?.map(a => a?.[x.id]);
  if (x.target === 'group') { const g = s.activity?.group; const gi = g?.values.indexOf(x.id); return gi >= 0 ? g.counts[gi] : null; }
  if (x.metric === 'activity') return s.activity?.total;
  if (x.metric === 'tiesFormed') return s.ties?.formed;
  if (x.metric === 'tiesDissolved') return s.ties?.dissolved;
  if (x.metric === 'tieRetention') return s.ties?.jaccard;
  return s.network?.[x.metric];
}

function median(v) {
  if (!v.length) return NaN;
  const a = [...v].sort((p, q) => p - q);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

// values: the series; x: the shift (window index); next: the window index of
// the next shift in the same series, or null. coverage: optional per-window
// coverage. -> { after, afterWindows, afterFrom, afterTo } (after NaN when no
// window follows).
export function levelAfter(values, x, next = null, coverage = null) {
  const from = (x?.window ?? -1) + 1;
  const to = Math.min(values?.length ?? 0, Number.isInteger(next) ? next : Infinity) - 1;
  const v = [];
  for (let t = from; t <= to; t++) {
    if (coverage && (coverage[t] ?? 1) < MIN_COVERAGE) continue;
    if (Number.isFinite(values[t])) v.push(values[t]);
  }
  return { after: median(v), afterWindows: v.length, afterFrom: from, afterTo: to, afterUntilNext: Number.isInteger(next) };
}

// Each shift with its level after (see levelAfter). The next shift is the
// next one in the same series (target, person or group, measure).
export function withLevelsAfter(s, list) {
  if (!s || !Array.isArray(list)) return list;
  const cov = (s.windows || []).map(w => w.coverage ?? 1);
  const keyOf = (x) => `${x.target}|${x.id}|${x.metric}`;
  return list.map(x => {
    if (!Number.isInteger(x?.window)) return x;
    const values = shiftSeries(s, x);
    if (!values) return x;
    const later = list.filter(y => y !== x && keyOf(y) === keyOf(x) && Number.isInteger(y.window) && y.window > x.window).map(y => y.window);
    const next = later.length ? Math.min(...later) : null;
    return { ...x, ...levelAfter(values, x, next, cov) };
  });
}
