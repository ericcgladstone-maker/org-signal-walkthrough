// Time view: the network rebuilt per window with the same construction
// settings. Activity and network measures over time (one chart per measure,
// never two scales on one chart), tie formation and dissolution, detected
// shifts with their statistical basis, and a before/after comparison around
// a chosen date with a paired permutation test.
//
// The period defaults to where the data are dense (suggestTimeRange): a few
// LinkedIn connection dates from 2008 would otherwise squash months of
// messages into a sliver. Each source's first and last day is drawn on the
// charts, and shifts are not tested there (see detectShifts).
//
// TimeChart below is this view's own line chart (month and week tick
// boundaries, a legend instead of end labels, faint points for thin windows,
// a text summary and a table view). Content's month and diffusion charts use
// it too.

import { html, useState, useMemo, useRef, useEffect } from '../../../vendor/preact.js';
import * as d3 from '../../../vendor/d3.js';
import { store, useStore } from '../store.js';
import { engine } from '../services/engine.js';
import { gloss } from '../services/glossary.js';
import { ViewHead, NeedsData, Loading, ErrorLine, ConstructionButton, useEngine, Flag, MetricName, Seg, Term, HowToRead, pShort } from '../components/common.js';
import { tokens } from '../lib/palette.js';
import { metricLabel } from '../lib/measures.js';
import { timeExtent, label as nodeLabel } from '../lib/dsutil.js';
import { fmtNum, fmtInt, fmtPct, fmtDate, isoDay, humanize } from '../lib/format.js';
import { suggestTimeRange } from '../../analysis/time.js';
import { defaultGrouping } from '../../analysis/groups.js';
import { withLevelsAfter, shiftSeries } from '../lib/shifts.js';

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// ---- shared helpers (also used by the Content view) -------------------------------

// A CSS custom property as a colour string, for SVG attributes.
const varCache = new Map();
export function cssVar(name, fallback) {
  if (varCache.has(name)) return varCache.get(name);
  let v = '';
  try { v = getComputedStyle(document.documentElement).getPropertyValue(name).trim(); } catch { /* no DOM */ }
  varCache.set(name, v || fallback);
  return v || fallback;
}
// Diverging poles by temperature, not by sign: cool for "more / positive",
// warm for "less / negative", always named in the chart's subtitle.
export const cool = () => cssVar('--div-cool-1', tokens().div[1]);
export const warm = () => cssVar('--div-warm-1', tokens().div[3]);

export function fmtMonth(t) { const d = new Date(t); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`; }
// A window's name in the house date style: "week of 6 Jan 2025", "Jan 2025", "6 Jan 2025".
// A per-person measure's name as People shows it ("Contacts (degree)",
// "Total ties (in + out)"; decision 4), for the network loaded now.
const personMeasure = (k) => metricLabel(k, !!store.get().network?.directed);

// "in the week of 6 Jan 2025", "in Jan 2025", "on 6 Jan 2025".
export function inWindow(start, unit) {
  return unit === 'week' || unit === 'month' ? `in ${unit === 'week' ? 'the ' : ''}${windowName(start, unit)}` : `on ${windowName(start, unit)}`;
}
export function windowName(start, unit) {
  if (!Number.isFinite(start)) return '';
  if (unit === 'week') return `week of ${fmtDate(start)}`;
  if (unit === 'month') return fmtMonth(start);
  return fmtDate(start);
}

// Ticks on calendar boundaries: days or Mondays for short spans, months for
// up to four years (with the year on January and the first tick), then years.
function timeTicks(x0, x1, width, unit = null) {
  const span = x1 - x0;
  // Monthly points get month ticks however short the span.
  if (unit === 'month' && span <= 4 * 366 * DAY) unit = 'force-month';
  const room = Math.max(2, Math.floor(width / 78));
  const pick = (cands) => cands.find(iv => iv.range(new Date(x0), new Date(x1 + 1)).length <= room) || cands[cands.length - 1];
  if (span <= 120 * DAY && unit !== 'force-month') {
    const iv = pick([d3.utcDay, d3.utcMonday, d3.utcMonday.every(2), d3.utcMonth]);
    const ts = iv.range(new Date(x0), new Date(x1 + 1));
    return { ticks: ts, fmt: (d) => (iv === d3.utcMonth ? fmtMonth(+d) : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`) };
  }
  if (span <= 4 * 366 * DAY) {
    const iv = pick([d3.utcMonth, d3.utcMonth.every(2), d3.utcMonth.every(3), d3.utcMonth.every(6)]);
    const ts = iv.range(new Date(x0), new Date(x1 + 1));
    return { ticks: ts, fmt: (d, i) => (i === 0 || d.getUTCMonth() === 0 ? fmtMonth(+d) : MONTHS[d.getUTCMonth()]) };
  }
  const iv = pick([d3.utcYear, d3.utcYear.every(2), d3.utcYear.every(5), d3.utcYear.every(10)]);
  return { ticks: iv.range(new Date(x0), new Date(x1 + 1)), fmt: (d) => String(d.getUTCFullYear()) };
}

let idSeq = 0;
const useUid = (prefix) => useRef(`${prefix}-${++idSeq}`).current;

function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current || typeof ResizeObserver === 'undefined') return;
    // Next frame, and only on a real change: the SVG's height follows its width,
    // so setting it inside the callback looped in WebKit ("ResizeObserver loop").
    let raf = 0;
    const ro = new ResizeObserver(([e]) => {
      const next = Math.max(160, Math.floor(e.contentRect.width));
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setW(p => (p === next ? p : next)));
    });
    ro.observe(ref.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  return w;
}

// A one-sentence text alternative for a series: range, extremes and the last value.
function describeSeries(label, pts, xName, yFormat) {
  const ok = pts.filter(p => Number.isFinite(p.y));
  if (!ok.length) return `${label}: no values.`;
  let lo = ok[0], hi = ok[0];
  for (const p of ok) { if (p.y < lo.y) lo = p; if (p.y > hi.y) hi = p; }
  const last = ok[ok.length - 1];
  return `${label}: ${ok.length} values from ${xName(ok[0].x)} to ${xName(last.x)}. Lowest ${yFormat(lo.y)} (${xName(lo.x)}), highest ${yFormat(hi.y)} (${xName(hi.x)}), last ${yFormat(last.y)}.`;
}

// series: [{ id, label, color, values: [{ x, y, n?, faint? }] }]
// markers: [{ x, label }] (detected shifts); edges: [{ x, label }] (source
// starts and ends); highlight: { x0, x1 } (a window to shade). xName names one
// point's x in the tooltip and table (default: date). Faint points (too few
// messages behind them) are drawn hollow and left out of the line.
export function TimeChart({ series, height = 170, title, sub, yFormat = fmtNum, xName = fmtDate, markers = [], edges = [], highlight = null, area = false, yDomain = null, xDomain = null, tableLabel = 'Show as table', nLabel = null, compact = false, unit = null }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const id = useUid('tchart');
  const t = tokens();
  const m = { t: 12, r: 14, b: 24, l: compact ? 34 : 46 };
  const all = series.flatMap(s => s.values).filter(v => Number.isFinite(v.y) && Number.isFinite(+v.x));
  const head = title || sub ? html`<figcaption>${title && html`<div class="chart__title">${title}</div>`}${sub && html`<div class="chart__sub">${sub}</div>`}</figcaption>` : null;
  if (!all.length) return html`<figure class="chart tchart" ref=${ref} style="margin:0">${head}<p class="muted small">No values to plot.</p></figure>`;
  const xs = xDomain || d3.extent(all, d => +d.x);
  if (xs[1] === xs[0]) xs[1] = xs[0] + DAY;
  const x = d3.scaleUtc().domain(xs).range([m.l, width - m.r]);
  const ext = yDomain || d3.extent(all, d => d.y);
  const y = d3.scaleLinear().domain([Math.min(0, ext[0]), ext[1] === ext[0] ? ext[1] + 1 : Math.max(0, ext[1])]).nice(4).range([height - m.b, m.t]);
  const solid = (v) => Number.isFinite(v.y) && !v.faint;
  const line = d3.line().defined(solid).x(d => x(+d.x)).y(d => y(d.y));
  const areaGen = d3.area().defined(solid).x(d => x(+d.x)).y0(y(Math.max(0, y.domain()[0]))).y1(d => y(d.y));
  const { ticks, fmt } = timeTicks(xs[0], xs[1], width - m.l - m.r, unit);
  const yt = y.ticks(compact ? 3 : 4);
  const allX = [...new Set(all.map(d => +d.x))].sort((a, b) => a - b);
  const inX = (v) => +v >= xs[0] && +v <= xs[1];
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * (width / r.width);
    const i = d3.bisectCenter(allX, +x.invert(px));
    const xv = allX[Math.max(0, Math.min(allX.length - 1, i))];
    setHover({ x: xv, px: x(xv) });
  };
  const summary = series.map(s => describeSeries(s.label, s.values, xName, yFormat)).join(' ');
  const tipLeft = hover ? Math.max(0, Math.min(hover.px - 70, width - 180)) : 0;
  return html`<figure class="chart tchart" ref=${ref} style="margin:0" aria-describedby=${`${id}-sum`}>
    ${head}
    ${series.length > 1 && html`<div class="tchart__legend">${series.map(s => html`<span class="tchart__key"><span class="tchart__swatch" style=${`background:${s.color}`}></span>${s.label}</span>`)}</div>`}
    <svg viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${typeof title === 'string' ? title : series.map(s => s.label).join(', ')} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
      <g class="grid">${yt.map(v => html`<line x1=${m.l} x2=${width - m.r} y1=${y(v)} y2=${y(v)} />`)}</g>
      ${highlight && html`<rect x=${x(Math.max(xs[0], highlight.x0))} y=${m.t} width=${Math.max(2, x(Math.min(xs[1], highlight.x1)) - x(Math.max(xs[0], highlight.x0)))} height=${height - m.b - m.t} fill=${t.text} opacity="0.08" />`}
      <g class="axis">
        <line x1=${m.l} x2=${width - m.r} y1=${height - m.b} y2=${height - m.b} />
        ${ticks.map((d, i) => html`<g><line x1=${x(d)} x2=${x(d)} y1=${height - m.b} y2=${height - m.b + 4} /><text x=${x(d)} y=${height - 7} text-anchor=${x(d) < m.l + 20 ? 'start' : x(d) > width - m.r - 20 ? 'end' : 'middle'}>${fmt(d, i)}</text></g>`)}
        ${yt.map(v => html`<text x=${m.l - 6} y=${y(v) + 3.5} text-anchor="end">${yFormat(v)}</text>`)}
      </g>
      ${edges.filter(e => inX(e.x)).map(e => html`<g class="tchart__edge"><line x1=${x(+e.x)} x2=${x(+e.x)} y1=${m.t} y2=${height - m.b} /><title>${e.label}</title></g>`)}
      ${markers.filter(mk => inX(mk.x)).map(mk => html`<g><line x1=${x(+mk.x)} x2=${x(+mk.x)} y1=${m.t} y2=${height - m.b} stroke=${t.muted} stroke-width="1" /><text x=${x(+mk.x) + 4} y=${m.t + 9} class="tchart__mark">${mk.label}</text></g>`)}
      ${series.map(s => html`<g>
        ${area && html`<path d=${areaGen(s.values)} fill=${s.color} opacity="0.12" />`}
        <path d=${line(s.values)} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${s.values.filter(v => v.faint && Number.isFinite(v.y)).map(v => html`<circle cx=${x(+v.x)} cy=${y(v.y)} r="3.5" fill=${t.bg} stroke=${s.color} stroke-width="1.5" opacity="0.7" />`)}
        ${s.values.filter(v => !v.faint && Number.isFinite(v.y)).length === 1 && s.values.filter(v => !v.faint && Number.isFinite(v.y)).map(v => html`<circle cx=${x(+v.x)} cy=${y(v.y)} r="4" fill=${s.color} />`)}
      </g>`)}
      ${hover && html`<g>
        <line x1=${hover.px} x2=${hover.px} y1=${m.t} y2=${height - m.b} stroke=${t.text2} stroke-width="1" opacity="0.5" />
        ${series.map(s => { const d = s.values.find(v => +v.x === hover.x); return d && Number.isFinite(d.y) ? html`<circle cx=${hover.px} cy=${y(d.y)} r="4" fill=${d.faint ? t.bg : s.color} stroke=${d.faint ? s.color : t.bg} stroke-width="2" />` : null; })}
      </g>`}
    </svg>
    ${hover && html`<div class="chart__tip" style=${`left:${tipLeft}px;top:0`}>
      <div><b>${xName(hover.x)}</b></div>
      ${series.map(s => { const d = s.values.find(v => +v.x === hover.x); return html`<div>${series.length > 1 ? `${s.label}: ` : ''}${d ? yFormat(d.y) : '–'}${d?.n != null && nLabel ? ` (${fmtInt(d.n)} ${nLabel})` : ''}</div>`; })}
    </div>`}
    <p class="visually-hidden" id=${`${id}-sum`}>${summary}</p>
    <details class="disclose tchart__table"><summary>${tableLabel}</summary>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">When</th>${series.map(s => html`<th scope="col" class="num">${s.label}</th>`)}${nLabel && html`<th scope="col" class="num">${humanize(nLabel)}</th>`}</tr></thead>
        <tbody>${allX.map(xv => html`<tr><th scope="row" class="name">${xName(xv)}</th>${series.map(s => { const d = s.values.find(v => +v.x === xv); return html`<td class="num">${d ? yFormat(d.y) : '–'}</td>`; })}${nLabel && html`<td class="num">${fmtInt(series[0].values.find(v => +v.x === xv)?.n)}</td>`}</tr>`)}</tbody>
      </table></div>
    </details>
  </figure>`;
}

// ---- shared with Groups: the windowed series, its shifts, attribute caveats ----

// The windowed networks and the shifts found in them. Groups calls this with
// the Time view's defaults (Auto window, the dense period), so both views
// share one run through the useEngine cache. Shifts are keyed on the series
// they were computed from and wait for it to finish: keyed on the controls
// alone, a window change re-ran detection on the previous window's series
// and kept that stale result (J4).
export function useTimeShifts(ds, { win = 'auto', range = null, enabled = true } = {}) {
  const groupAttr = useMemo(() => defaultGrouping(ds), [ds]);
  const r = range || { start: null, end: null };
  const series = useEngine('ts', () => engine.timeSeries({ window: win, purpose: 'Time view', metrics: ['degree', 'strength'], attr: groupAttr || undefined, start: r.start ?? undefined, end: r.end ?? undefined }), [win, r.start, r.end, groupAttr], { label: 'Building windowed networks', enabled });
  const s = series.data;
  const ready = enabled && !series.loading && !!s?.windows?.length;
  const sKey = ready ? `${s.meta?.window}|${s.windows.length}|${s.windows[0].start}|${s.meta?.end}` : null;
  const shifts = useEngine('shifts', () => engine.shifts(s, { labels: ds.nodes.labels }), [win, r.start, r.end, groupAttr, sKey], { enabled: ready });
  // Each shift also carries the level after it (withLevelsAfter): the first
  // flagged window alone can be a transition window (C2).
  const data = useMemo(() => {
    const d = shifts.data;
    if (!ready || !d) return null;
    if (Array.isArray(d)) return withLevelsAfter(s, d);
    return { ...d, shifts: withLevelsAfter(s, d.shifts) };
  }, [ready, shifts.data, s]);
  return { series, shifts: { ...shifts, data }, groupAttr };
}

// Attributes are one value per person (a snapshot), not a history. When the
// generator moved people, say when and that the value shown is the old one.
export function snapshotNote(ds, attr, name = null) {
  const label = (name || humanize(attr || 'group')).toLowerCase();
  const gen = store.get().generated;
  const reorg = (gen?.groundTruth?.events || []).find(e => e.type === 'reorg' && e.moved?.length);
  const base = `Each person has one ${label} in this data, a snapshot, not a history.`;
  if (reorg) return `${base} The generator moved ${reorg.moved.length} people to another ${label} on ${fmtDate(reorg.t)}; their ${label} here is the one before the move, so after that date their ties inside the new ${label} count as crossing. A rise in crossing ties after a reorganization can come from that alone.`;
  return `${base} If people moved to another ${label} during the period, their ties inside the new one count as crossing, so a change in crossing ties can come from the moves alone.`;
}

// The same caveat in one clause, for a verdict sentence about crossing ties.
export function snapshotClause(attr) {
  const label = humanize(attr || 'group').toLowerCase();
  const reorg = (store.get().generated?.groundTruth?.events || []).find(e => e.type === 'reorg' && e.moved?.length);
  return reorg ? `but ${reorg.moved.length} people moved ${label} on ${fmtDate(reorg.t)} and each person's ${label} here is the one before the move, so this can be the move itself, not more crossing`
    : `as long as nobody moved ${label}: each person's ${label} is one recorded value`;
}

// The shift Groups points to: a change in how much ties cross groups first,
// then tie retention, then the strongest whole-network shift.
// Only a shift that lasted counts (persistentShift): a one-window blip, such
// as one quiet day in a date-restricted network, does not raise the banner.
export function groupShift(list) {
  const net = (list || []).filter(x => x.target === 'network' && Number.isFinite(x.start) && persistentShift(x));
  return net.find(x => x.metric === 'crossGroupShare') || net.find(x => x.metric === 'tieRetention') || net[0] || null;
}

// A shift that lasted: at least two windows at the new level (the flagged
// one included) and most of the windows from it to the end of the data
// (persistence against the pre-shift baseline, J3).
export function persistentShift(x) {
  return Number.isFinite(x?.held) && x.span > 0 && x.held >= 2 && x.held / x.span >= 0.5;
}

// Whether the series came back, from the shift's persistence against its
// pre-shift baseline (J3): each window from the first flagged one to the end
// is nearer either the earlier level or the flagged run's level. A sentence,
// or '' when persistence is unknown.
export function persistWords(x, unit) {
  if (!Number.isFinite(x?.held) || !x.span) return '';
  const w = (k) => `${k} ${unit ? `${unit}${k === 1 ? '' : 's'}` : `window${k === 1 ? '' : 's'}`}`;
  if (x.heldToEnd) return x.span === 1 ? 'This is the last window of the period.' : `It did not return toward the earlier level: all ${w(x.span)} from then to the end of the period sit nearer the changed level than the earlier one.`;
  if (x.held <= 1) return `It returned toward the earlier level after ${w(1)}.`;
  return `${x.held} of the ${w(x.span)} from then to the end of the period sit nearer the changed level than the earlier one.`;
}

// "to 0.113 in the week of 17 Mar 2025, and to a median of 0.0483 over the
// 15 weeks that followed": the first flagged window and the level after it
// (lib/shifts.js), never the first window alone as the new level (C2).
export function changeWords(x, unit, fmt = fmtNum) {
  const first = `${fmt(x.value)} ${inWindow(x.start, unit)}`;
  if (!Number.isFinite(x.after) || !x.afterWindows) return `to ${first}`;
  const u = (k) => `${unit || 'window'}${k === 1 ? '' : 's'}`;
  return `to ${first}, and to a median of ${fmt(x.after)} over the ${x.afterWindows === 1 ? u(1) : `${x.afterWindows} ${u(x.afterWindows)}`} that followed${x.afterUntilNext ? ' (up to the next shift in this series)' : ''}`;
}

// ---- view -------------------------------------------------------------------------------

const NET_SERIES = [
  ['activity', 'Events', 'Messages and other actions in the window (bots left out when set).'],
  ['ties', 'Ties', 'Ties in that window’s network.'],
  ['nodes', 'People with ties', 'People with at least one tie in the window.'],
  ['density', 'Density', null],
  ['reciprocity', 'Reciprocity', 'Share of ties returned within the same window; replies that fall into the next window are missed, so it runs below the whole-period value.'],
  ['transitivity', 'Transitivity', null],
];
const WINDOWS = [{ value: 'auto', label: 'Auto' }, { value: 'day', label: 'Day' }, { value: 'week', label: 'Week' }, { value: 'month', label: 'Month' }];

export function TimeView() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  if (!ds || !net) return html`<${NeedsData} title="Time" />`;
  const [t0] = timeExtent(ds);
  if (!Number.isFinite(t0)) return html`<div class="view view--col"><${ViewHead} title="Time" /><div class="empty"><h2>No timestamps</h2><p class="lead">These records contain no event timestamps, so the network cannot be reconstructed by time window. Surveys and standard network files commonly record ties without dates.</p></div></div>`;
  return html`<${TimeInner} ds=${ds} />`;
}

function TimeInner({ ds }) {
  const [full0, full1] = useMemo(() => timeExtent(ds), [ds]);
  const dense = useMemo(() => suggestTimeRange(ds), [ds]);
  const [range, setRange] = useState(() => (dense ? { start: dense.start, end: dense.end } : { start: null, end: null }));
  const [win, setWin] = useState('auto');
  const { series, shifts, groupAttr } = useTimeShifts(ds, { win, range });
  const t = tokens();
  const s = series.data;
  const unit = typeof s?.meta?.window === 'string' ? s.meta.window : null;
  const xName = (v) => windowName(v, unit);
  const xs = s?.windows?.map(w => w.start) || [];
  const valuesOf = (key) => {
    if (!s) return null;
    if (key === 'activity') return s.activity?.total;
    if (key === 'ties') return s.network?.ties || s.windows.map(w => w.ties);
    if (key === 'nodes') return s.network?.nodes || s.windows.map(w => w.nodes);
    return s.network?.[key];
  };
  const shiftList = (shifts.data?.shifts || (Array.isArray(shifts.data) ? shifts.data : []));
  const netShifts = shiftList.filter(x => x.target === 'network' || x.target == null);
  const markersFor = (key) => netShifts.filter(x => (x.metric === key || x.label === key) && Number.isFinite(x.start)).slice(0, 4).map(x => ({ x: x.start, label: x.direction === 'up' ? 'rise' : x.direction === 'down' ? 'drop' : 'shift' }));
  const material = (s?.sources || []).filter(x => x.material);
  const edges = material.flatMap(x => [{ x: x.start, label: `${x.label} starts` }, { x: x.end, label: `${x.label} ends` }]);
  const xDomain = s?.windows?.length ? [s.windows[0].start, s.windows[s.windows.length - 1].start] : null;
  const pts = (v) => xs.map((x, i) => ({ x, y: v[i], faint: (s.windows[i].coverage ?? 1) < 0.6 }));
  const multiSource = (s?.sources || []).length > 1;

  return html`<div class="view">
    <${ViewHead} title="Time" intro="The network is rebuilt separately for each time window using the current construction settings. This keeps the definition of a tie constant while allowing activity, network measures, tie turnover, and group structure to be compared over time. The view can be organized by day, week, or month depending on the data. It also supports detected shifts and before-and-after comparisons around a selected date."
      actions=${html`<${ConstructionButton} />`} />
    <${RangeBar} range=${range} setRange=${setRange} dense=${dense} full=${[full0, full1]} win=${win} setWin=${setWin} meta=${s?.meta} />
    ${series.loading && html`<${Loading}>Building one network per ${unit || (win === 'auto' ? 'window' : win)}</${Loading}>`}
    <${ErrorLine} error=${series.error} onRetry=${series.retry} />
    ${s && !s.windows?.length && html`<p class="text2">No dated events fall in the chosen period.</p>`}
    ${s?.windows?.length > 0 && html`
      ${multiSource && html`<${SourceStrip} sources=${s.sources} domain=${xDomain} />`}
      <section class="section" style="border-top:0;padding-top:0" aria-labelledby="ts-h">
        <h2 id="ts-h" class="section__title">Activity and structure</h2>
        ${edges.length > 0 && html`<p class="small text2 tview__note">Thin vertical lines mark where a source starts or ends; jumps there come from the export, not from behavior.</p>`}
        <div class="tview__grid">
          ${NET_SERIES.map(([key, label, sub]) => {
            const v = valuesOf(key);
            if (!v || !v.some(Number.isFinite)) return null;
            const gk = key === 'reciprocity' ? 'reciprocityNetwork' : key;
            return html`<${TimeChart} title=${key in { density: 1, reciprocity: 1, transitivity: 1 } ? html`<${MetricName} metric=${gk} />` : label} sub=${sub || gloss(gk).meaning}
              series=${[{ id: key, label, color: t.cat[0], values: pts(v) }]} height=${150} markers=${markersFor(key)} edges=${edges} xName=${xName} xDomain=${xDomain} compact=${true} />`;
          })}
        </div>
      </section>
      <section class="section" aria-labelledby="turn-h">
        <h2 id="turn-h" class="section__title">Tie formation and dissolution</h2>
        <${TimeChart} sub="Formed: ties present in a window but not in the one before. Dissolved: present before, absent now. The first window is left out because every tie in it would count as new."
          series=${[{ id: 'f', label: 'Formed', color: cool(), values: pts(s.ties?.formed || []).slice(1) }, { id: 'd', label: 'Dissolved', color: warm(), values: pts(s.ties?.dissolved || []).slice(1) }]} height=${190} edges=${edges} xName=${xName} xDomain=${xDomain} />
      </section>
      <${Shifts} ds=${ds} s=${s} shifts=${shifts} list=${shiftList} unit=${unit} xName=${xName} edges=${edges} xDomain=${xDomain} groupAttr=${groupAttr} />
      <${BeforeAfter} ds=${ds} range=${range} full=${[full0, full1]} netShifts=${netShifts.length ? netShifts : shiftList} groupAttr=${groupAttr} />
    `}
  </div>`;
}

// The period and window controls: one row above everything they scope.
function RangeBar({ range, setRange, dense, full, win, setWin, meta }) {
  const [from, setFrom] = useState(isoDay(range.start ?? full[0]));
  const [to, setTo] = useState(isoDay((range.end ?? full[1] + 1) - 1));
  useEffect(() => { setFrom(isoDay(range.start ?? full[0])); setTo(isoDay((range.end ?? full[1] + 1) - 1)); }, [range.start, range.end]);
  const apply = (e) => {
    e?.preventDefault();
    const a = Date.parse(`${from}T00:00:00Z`), b = Date.parse(`${to}T00:00:00Z`);
    if (Number.isFinite(a) && Number.isFinite(b) && b >= a) setRange({ start: a, end: b + DAY });
  };
  const isDense = dense && range.start === dense.start && range.end === dense.end;
  const isAll = range.start == null && range.end == null;
  const yrs = (a, b) => (new Date(a).getUTCFullYear() === new Date(b).getUTCFullYear() ? String(new Date(a).getUTCFullYear()) : `${new Date(a).getUTCFullYear()}–${new Date(b).getUTCFullYear()}`);
  return html`<div class="tview__bar">
    <form class="toolbar tview__range" onSubmit=${apply} aria-label="Period">
      <label class="field"><span>From</span><input class="input" type="date" value=${from} min=${isoDay(full[0])} max=${isoDay(full[1])} onInput=${e => setFrom(e.currentTarget.value)} onChange=${apply} /></label>
      <label class="field"><span>To</span><input class="input" type="date" value=${to} min=${isoDay(full[0])} max=${isoDay(full[1])} onInput=${e => setTo(e.currentTarget.value)} onChange=${apply} /></label>
      <${Seg} label="Window" value=${win} onChange=${setWin} options=${WINDOWS.map(o => (o.value === 'auto' && meta?.windowRequested === 'auto' && typeof meta.window === 'string' ? { ...o, label: `Auto (${meta.window})` } : o))} />
    </form>
    <p class="small text2 tview__period">
      ${isDense ? `Showing ${fmtDate(dense.start)} to ${fmtDate(dense.end - DAY)}, where ${fmtPct(dense.share)} of dated events fall. ${dense.outsideBefore ? `${fmtInt(dense.outsideBefore)} earlier event${dense.outsideBefore === 1 ? '' : 's'} (from ${fmtDate(dense.fullStart)})` : ''}${dense.outsideBefore && dense.outsideAfter ? ' and ' : ''}${dense.outsideAfter ? `${fmtInt(dense.outsideAfter)} later` : ''} ${dense.outsideBefore + dense.outsideAfter === 1 ? 'is' : 'are'} outside it. `
        : isAll ? `Showing all dates, ${fmtDate(full[0])} to ${fmtDate(full[1])}. ` : `Showing ${fmtDate(range.start)} to ${fmtDate(range.end - DAY)}. `}
      ${!isAll && html`<button type="button" class="tlink" onClick=${() => setRange({ start: null, end: null })}>Use all dates (${yrs(full[0], full[1])})</button>`}
      ${dense && !isDense && html` <button type="button" class="tlink" onClick=${() => setRange({ start: dense.start, end: dense.end })}>Use the dense period</button>`}
    </p>
    ${meta?.windowReason && html`<p class="small text2"><${Flag} level="info" /> ${meta.windowReason}</p>`}
  </div>`;
}

// When each source starts and ends, on the same axis as the charts.
function SourceStrip({ sources, domain }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  if (!domain) return null;
  const big = [...sources].sort((a, b) => b.eventsInRange - a.eventsInRange);
  const shown = big.filter(x => x.material).slice(0, 8);
  const rest = big.length - shown.length;
  const m = { l: 0, r: 0 };
  const x = d3.scaleUtc().domain([domain[0], Math.max(domain[1], domain[0] + DAY)]).range([m.l, Math.max(m.l + 10, width - m.r)]).clamp(true);
  const pct = (v) => `${(x(v) / Math.max(1, width)) * 100}%`;
  return html`<section class="section tview__sources" style="border-top:0;padding-top:0" aria-labelledby="src-h">
    <h2 id="src-h" class="section__title">Sources over time</h2>
    <p class="small text2">Shifts are not tested in a source's first or last window or the windows either side of them, and the baseline restarts after each.</p>
    <ul class="tview__src-list" ref=${ref}>${shown.map(sc => html`<li class="tview__src">
      <span class="tview__src-name">${sc.label}</span>
      <span class="tview__src-track" aria-hidden="true"><span class="tview__src-bar" style=${`left:${pct(sc.start)};width:calc(${pct(sc.end)} - ${pct(sc.start)} + 2px)`}></span></span>
      <span class="tview__src-dates">${fmtDate(sc.start)} to ${fmtDate(sc.end)} · ${fmtPct(sc.share)} of events</span>
    </li>`)}</ul>
    ${rest > 0 && html`<p class="small muted">${fmtInt(rest)} smaller source${rest === 1 ? '' : 's'} (each under 5% of the events) not shown; their edges are only checked for the people they carry.</p>`}
  </section>`;
}

// Plain explanation of one detected shift.
function explainShift(ds, s, x, unit) {
  const who = x.target === 'node' ? nodeLabel(ds, x.id) : x.target === 'group' ? x.label : 'The whole network';
  const what = x.target === 'node' ? personMeasure(x.metric).replace(/^./, c => c.toLowerCase()) : x.label === x.metric ? humanize(x.metric).toLowerCase() : x.label;
  const verb = x.direction === 'up' ? 'rose' : 'fell';
  const kept = persistWords(x, unit);
  const lines = [`${who}: ${what} ${verb} from a typical ${fmtNum(x.baseline)} ${changeWords(x, unit)}.${kept ? ` ${kept}` : ''}`];
  if (x.length > 1 || !x.heldToEnd) lines.push(`Flagged for ${x.length} ${unit || 'window'}${x.length === 1 ? '' : 's'}: each window is compared with the ${unit || 'window'}s just before it, so once a new level lasts a few windows it stops being flagged. That is not the change ending.`);
  if (x.target === 'node' && x.direction === 'down') {
    const act = s.activity?.node || [];
    let last = -1;
    for (let k = act.length - 1; k >= 0; k--) if (act[k]?.[x.id] > 0) { last = k; break; }
    const deact = ds.nodes.attrs[x.id]?.deactivated || ds.nodes.attrs[x.id]?.deleted;
    if (last >= 0 && last <= x.window) lines.push(`Stopped appearing: no activity after ${unit === 'week' ? 'the ' : ''}${windowName(s.windows[last].start, unit)}${deact ? '; the account is marked deactivated in the export' : ''}.`);
    else if (deact) lines.push('The account is marked deactivated in the export.');
  }
  return lines;
}

function Shifts({ ds, s, shifts, list, unit, xName, edges, xDomain, groupAttr }) {
  const [open, setOpen] = useState(null);
  const t = tokens();
  const meta = shifts.data?.meta;
  const shown = list.slice(0, 30);
  const keyOf = (x, i) => `${x.target}|${x.id}|${x.metric}|${x.window}|${i}`;
  const seriesOf = (x) => shiftSeries(s, x);
  const unitName = meta?.window || unit;
  const top = shown[0];
  const verdict = !shown.length ? null : `${list.length === 1 ? 'One measure departs from its' : `${fmtInt(list.length)} measures depart from their`} recent level. The largest: ${top.target === 'node' ? nodeLabel(ds, top.id) : top.target === 'group' ? top.label : 'the whole network'}, ${top.direction === 'up' ? 'a rise' : 'a drop'} ${inWindow(top.start, unitName)}${top.heldToEnd ? ' that lasts to the end of the period' : ''}.`;
  const groupRow = shown.some(x => x.metric === 'crossGroupShare' || x.target === 'group');
  return html`<section class="section" aria-labelledby="sh-h">
    <h2 id="sh-h" class="section__title">Detected shifts</h2>
    <p class="small text2">Shift detection compares each period with the periods immediately before it and identifies changes that are large relative to the variability estimated from the series. Sparse periods reduce sensitivity, so the absence of a detected shift provides limited evidence of stability.</p>
    ${shifts.loading && html`<${Loading}>Scanning for shifts</${Loading}>`}<${ErrorLine} error=${shifts.error} />
    ${shifts.data && (shown.length ? html`
      <p class="tview__verdict">${verdict} Select a row for what changed.</p>
      ${meta?.window && html`<p class="small text2">Computed with ${meta.window === 'day' ? 'daily' : meta.window === 'week' ? 'weekly' : 'monthly'} windows${meta.window === 'day' ? (meta.weekendsSkipped ? '; weekends are left out, so each weekday is compared with weekdays' : '; daily counts swing with the weekly rhythm, so read day-level flags with care, or use weeks') : ''}.</p>`}
      <div class="table-wrap"><table class="tbl tview__shifts">
        <thead><tr><th scope="col">What</th><th scope="col">Measure</th><th scope="col">From</th><th scope="col">Change</th><th scope="col">Lasted</th><th scope="col" class="num">Typical before</th><th scope="col" class="num">First ${unitName || 'window'}</th><th scope="col" class="num">New value <span class="muted">(median after)</span></th><th scope="col" class="num">How unusual (<${Term} k="shiftZ">z</${Term}>)</th></tr></thead>
        <tbody>${shown.map((x, i) => { const k = keyOf(x, i); const isOpen = open === k; const v = isOpen ? seriesOf(x) : null; return html`<tr class=${isOpen ? 'is-open' : ''}>
          <td class="name"><button type="button" class="tview__rowbtn" aria-expanded=${String(isOpen)} onClick=${() => setOpen(isOpen ? null : k)}>${x.target === 'node' ? nodeLabel(ds, x.id) : x.target === 'group' ? x.label : 'Whole network'}</button></td>
          <td>${x.target === 'network' && x.label !== x.metric ? humanize(x.label) : x.target === 'node' ? personMeasure(x.metric) : humanize(x.metric)}${(x.metric === 'crossGroupShare' || x.target === 'group') && groupAttr ? html` <${Flag} level="caution" iconOnly=${true} reason=${snapshotNote(ds, groupAttr)} />` : ''}</td><td>${windowName(x.start, unitName)}</td>
          <td>${x.direction === 'up' ? 'Rise' : x.direction === 'down' ? 'Drop' : ''}</td>
          <td>${Number.isFinite(x.held) ? (x.heldToEnd ? 'to the end' : `${x.held} of ${x.span} ${unitName || 'window'}s`) : `${x.length} ${unitName || 'window'}${x.length === 1 ? '' : 's'}`}</td>
          <td class="num">${fmtNum(x.baseline)}</td><td class="num">${fmtNum(x.value)}</td><td class="num">${fmtNum(x.after)}</td>
          <td class="num">${fmtNum(x.z ?? x.statistic, { digits: 2 })}</td>
        </tr>${isOpen && html`<tr class="tview__detail"><td colspan="9">
          ${explainShift(ds, s, x, unitName).map(l => html`<p class="small">${l}</p>`)}
          ${v && html`<div class="tview__detail-chart"><${TimeChart} series=${[{ id: 'v', label: humanize(x.metric), color: t.cat[0], values: s.windows.map((w, j) => ({ x: w.start, y: v[j] })) }]} height=${130} highlight=${{ x0: s.windows[x.window].start, x1: s.windows[Math.min(s.windows.length - 1, x.lastHeld ?? x.end ?? x.window)].end }} edges=${edges} xName=${xName} xDomain=${xDomain} compact=${true} /></div>`}
        </td></tr>`}`; })}</tbody></table></div>
      ${groupRow && groupAttr && html`<p class="small text2"><${Flag} level="caution" /> ${snapshotNote(ds, groupAttr)}</p>`}
      <${HowToRead} means="A shift is a window whose value departs from the windows immediately before it. The first flagged window can be a transition (a change that begins midweek is only partly in it), so the new value is the median of the windows after it, up to the next shift in the same series or the end of the period. The Lasted column compares each later window with the level before the change, showing whether the series stays near the new level or returns to the old one."
        scale="The z statistic is scaled by the typical variation between windows: 3.5 or more is flagged for the whole network, 5 or more for an individual person."
        mistake="The flagged run does not measure how long a change lasted. A step that persists stops being flagged after a few windows, because the preceding windows then share the new level; the Lasted column reports duration." />`
      : html`<p class="tview__verdict">No window departs from its recent level by more than the threshold.</p>`)}
    ${meta && html`<p class="basis">Basis: each window compared with the ${meta.baseline ?? 8} windows before it (${meta.method === 'cusum' ? 'CUSUM' : 'robust z: distance from their median in units of their typical spread, the MAD'}); flagged at ${meta.threshold ?? 3.5} or more (${meta.nodeThreshold ?? 5} for single people). ${fmtInt(meta.seriesScanned)} measures were scanned, so some flags are expected by chance; the before-and-after comparison below provides a check.${meta.weekendsSkipped ? ' Daily windows: Saturdays and Sundays carry far less activity here, so they are left out of the scan and of the baselines (and Mondays out of tie turnover), and each weekday is compared with weekdays.' : ''}${meta.sourceEdges?.length ? ` Not tested near source edges: ${meta.sourceEdges.slice(0, 4).map(e => `${e.label} ${e.kind} ${fmtDate(e.t)}`).join('; ')}${meta.sourceEdges.length > 4 ? `; and ${meta.sourceEdges.length - 4} more` : ''}.` : ''}</p>`}
  </section>`;
}

function BeforeAfter({ ds, range, full, netShifts, groupAttr }) {
  const t0 = range.start ?? full[0], t1 = (range.end ?? full[1] + 1) - 1;
  // Default date: the strongest whole-network shift, if any; else the middle of the period.
  const suggested = useMemo(() => {
    // Whole-network shifts come first in the list passed here; else any shift.
    const sh = netShifts.find(x => Number.isFinite(x.start) && x.start > t0 && x.start < t1);
    return sh ? sh.start : t0 + (t1 - t0) / 2;
  }, [netShifts, t0, t1]);
  const [date, setDate] = useState(() => isoDay(suggested));
  const [touched, setTouched] = useState(false);
  useEffect(() => { if (!touched) setDate(isoDay(suggested)); }, [suggested]);
  const [ran, setRan] = useState(null);
  const ms = Date.parse(`${date}T00:00:00Z`);
  const q = useEngine('ba', () => engine.beforeAfter(ran, { metrics: ['degree', 'strength', 'betweenness'], attr: groupAttr || undefined, start: range.start ?? undefined, end: range.end ?? undefined }), [ran, range.start, range.end, groupAttr], { enabled: ran != null, label: 'Comparing before and after' });
  const r = q.data;
  const netKeys = ['nodes', 'ties', 'density', 'reciprocity', 'transitivity', 'avgClustering', 'components', 'largestComponentShare'];
  const netFmt = (k, v) => (k === 'largestComponentShare' ? fmtPct(v) : fmtNum(v));
  const netName = { nodes: 'People with ties', ties: 'Ties', components: 'Components', largestComponentShare: 'Largest component (share of people)' };
  const fromShift = netShifts.some(x => isoDay(x.start) === date);
  const mix = r?.mixing;
  const gName = groupAttr ? humanize(groupAttr).toLowerCase() : 'group';
  return html`<section class="section" aria-labelledby="ba-h">
    <h2 id="ba-h" class="section__title">Before and after a date</h2>
    <p class="small text2" style="margin-bottom:.6rem">The before-and-after analysis compares the same measure on either side of a selected date. The permutation test evaluates whether the observed change is larger than expected under random reassignment of the events in the two periods to before and after.</p>
    <form class="toolbar" onSubmit=${e => { e.preventDefault(); if (Number.isFinite(ms)) setRan(ms); }}>
      <label class="field"><span>Date</span><input class="input" type="date" value=${date} min=${isoDay(t0)} max=${isoDay(t1)} onInput=${e => { setTouched(true); setDate(e.currentTarget.value); }} /></label>
      <button class="btn btn--primary" type="submit">Compare</button>
      ${fromShift && html`<span class="small muted tview__hint">Preset to the start of the strongest detected shift.</span>`}
    </form>
    ${q.loading && html`<${Loading}>Building both networks</${Loading}>`}<${ErrorLine} error=${q.error} />
    ${r && html`
      ${(r.cautions || []).length > 0 && html`<div class="notice-line tview__caution"><${Flag} level="caution" /><span class="grow">${r.cautions.map(c => `${c.label} ${c.kind} on ${fmtDate(c.t)}, inside the ${c.period} period.`).join(' ')} Changes for people seen mostly in ${r.cautions.length === 1 ? 'that source' : 'those sources'} reflect the export, not behavior; they are marked below.</span></div>`}
      <${BaVerdict} r=${r} gName=${gName} />
      <div class="grid-2">
      <div>
        <p class="label">${fmtDate(r.before?.start)} to ${fmtDate(r.date - DAY)} vs ${fmtDate(r.date)} to ${fmtDate(r.after?.end - DAY)}</p>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Whole network</th><th scope="col" class="num">Before</th><th scope="col" class="num">After</th></tr></thead>
          <tbody>${netKeys.filter(k => r.network?.[k]).map(k => html`<tr><td>${netName[k] || (gloss(k).label === humanize(k) ? humanize(k) : html`<${MetricName} metric=${k} showFlag=${false} />`)}</td><td class="num">${netFmt(k, r.network[k].before)}</td><td class="num">${netFmt(k, r.network[k].after)}</td></tr>`)}
          ${mix && html`<tr><td><${Term} k="eiIndex">E-I index</${Term}> by ${gName}</td><td class="num">${fmtNum(mix.before.eiIndex)}</td><td class="num">${fmtNum(mix.after.eiIndex)}</td></tr>
            <tr><td>Ties crossing ${gName} lines</td><td class="num">${fmtPct(mix.before.crossShare)}</td><td class="num">${fmtPct(mix.after.crossShare)}</td></tr>`}</tbody>
        </table></div>
        ${r.ties && html`<p class="small text2" style="margin-top:.5rem">${fmtInt(r.ties.persisted)} ties persisted, ${fmtInt(r.ties.formed)} formed and ${fmtInt(r.ties.dissolved)} dissolved (overlap ${fmtNum(r.ties.jaccard, { digits: 2 })}).</p>`}
        ${mix && html`<p class="small text2"><${Flag} level="caution" /> ${snapshotNote(ds, mix.attr)}</p>`}
        <p class="basis">Whole-network rows other than the E-I index are description, with no test attached. Messages on the date itself count as after, so someone who left on that day still appears after it.${mix && Number.isFinite(mix.p) ? ` E-I change: ${pShort(mix.p, mix.reps)} (${fmtInt(mix.reps)} random splits).` : ''}</p>
      </div>
      <div>
        <div class="table-wrap"><table class="tbl">
          <thead><tr><th scope="col">Per person</th><th scope="col" class="num">Mean before</th><th scope="col" class="num">Mean after</th><th scope="col" class="num">Effect size (<${Term} k="dz">d<sub>z</sub></${Term}>)</th><th scope="col" class="num"><${Term} k="nullP">p</${Term}></th></tr></thead>
          <tbody>${Object.entries(r.node || {}).filter(([, x]) => x?.n).map(([k, x]) => html`<tr><td><${MetricName} metric=${k} label=${personMeasure(k)} showFlag=${false} /></td><td class="num">${fmtNum(x.meanBefore)}</td><td class="num">${fmtNum(x.meanAfter)}</td><td class="num">${fmtNum(x.dz, { digits: 2 })}</td><td class="num">${pShort(x.p, x.reps).replace(/^p\s*/, '').replace(/^= /, '')}</td></tr>`)}</tbody>
        </table></div>
        <p class="basis">Randomization test: each message of the two periods reassigned to before or after at random, ${fmtInt(r.meta?.reps)} times (${fmtInt(r.meta?.metricReps)} for measures that need the networks rebuilt), and the mean change per person recomputed. Effect size d<sub>z</sub>: mean change divided by its spread across people (0.2 small, 0.5 moderate, 0.8 large).</p>
        ${['topIncreases', 'topDecreases'].map(which => { const l = r.node?.degree?.[which] || []; return l.length > 0 && html`<p class="small text2" style="margin-top:.5rem">Largest ${which === 'topIncreases' ? 'increases' : 'decreases'} in ${personMeasure('degree').replace(/^./, c => c.toLowerCase())}: ${l.slice(0, 5).map((p, i) => html`${i ? ', ' : ''}${p.label ?? nodeLabel(ds, p.node)} (${p.diff > 0 ? '+' : ''}${fmtNum(p.diff)}${p.sourceEdge ? html`; <span class="tview__edge-note">${p.sourceEdge} export edge</span>` : ''})`)}.</p>`; })}
      </div>
    </div>`}
  </section>`;
}

// The plain reading first, numbers after (decision 5): "rose ... a large
// change, unlikely by chance (p < 0.001)" (J10).
function BaVerdict({ r, gName }) {
  const parts = [];
  for (const [k, x] of Object.entries(r.node || {})) {
    if (!x?.n) continue;
    const name = personMeasure(k).replace(/^./, c => c.toLowerCase());
    const size = Math.abs(x.dz) < 0.2 ? 'a small change' : Math.abs(x.dz) < 0.5 ? 'a moderate change' : 'a large change';
    const pw = pShort(x.p, x.reps);
    if (Number.isFinite(x.p) && x.p < 0.05) parts.push(`${name} ${x.meanDiff > 0 ? 'rose' : 'fell'} on average from ${fmtNum(x.meanBefore)} to ${fmtNum(x.meanAfter)} per person, ${size}, unlikely by chance (${pw})`);
    else parts.push(`${name} did not change clearly (${fmtNum(x.meanBefore)} to ${fmtNum(x.meanAfter)}; ${pw})`);
  }
  const mix = r.mixing;
  if (mix && Number.isFinite(mix.diff)) {
    const clear = Number.isFinite(mix.p) && mix.p < 0.05;
    parts.push(clear
      ? `ties ${mix.diff < 0 ? 'stayed inside' : 'crossed'} ${gName} lines more after the date (E-I ${fmtNum(mix.before.eiIndex)} to ${fmtNum(mix.after.eiIndex)}, crossing ties ${fmtPct(mix.before.crossShare)} to ${fmtPct(mix.after.crossShare)}, unlikely by chance, ${pShort(mix.p, mix.reps)}), ${snapshotClause(mix.attr)}`
      : `the share of ties crossing ${gName} lines did not change clearly (${fmtPct(mix.before.crossShare)} to ${fmtPct(mix.after.crossShare)})`);
  }
  if (!parts.length) return null;
  const cap = (x) => x.replace(/^./, c => c.toUpperCase());
  return html`<div class="tview__verdict">${parts.map(x => html`<p>${cap(x)}.</p>`)}${r.cautions?.length ? html`<p>Some of this is a source starting or ending (see the caution above).</p>` : ''}</div>`;
}
