// Charts, drawn as SVG from d3 scales and rendered by Preact.
//
// Conventions (dataviz method): one y-axis per chart, never two; 2px lines,
// hairline recessive grid, thin bars with 4px rounded data ends anchored at
// the baseline, a legend whenever there are two or more series plus direct
// labels for up to four, a hover layer on every chart (crosshair + tooltip on
// lines, per-mark tooltip on bars and cells), and text in ink colours, never
// in the series colour.

import { html, useState, useRef, useEffect } from '../../../vendor/preact.js';
import * as d3 from '../../../vendor/d3.js';
import { fmtNum, fmtDate } from '../lib/format.js';
import { tokens } from '../lib/palette.js';

function useWidth(ref, fallback = 600) {
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
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

// series: [{ id, label, color, values: [{ x: Date|number, y }] }]
export function LineChart({ series, height = 200, yFormat = fmtNum, xFormat = fmtDate, title, sub, yLabel, markers = [], area = false, yDomain }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const m = { t: 10, r: series.length <= 4 && series.length > 1 ? 90 : 12, b: 26, l: 46 };
  const all = series.flatMap(s => s.values).filter(v => Number.isFinite(v.y) && v.x != null);
  if (!all.length) return html`<div class="chart">${title && html`<div class="chart__title">${title}</div>`}<p class="muted small">No values to plot.</p></div>`;
  const xs = d3.extent(all, d => +d.x);
  const x = d3.scaleUtc().domain(xs).range([m.l, width - m.r]);
  const ext = yDomain || d3.extent(all, d => d.y);
  const y = d3.scaleLinear().domain([Math.min(0, ext[0]), ext[1] === ext[0] ? ext[1] + 1 : ext[1]]).nice(4).range([height - m.b, m.t]);
  const line = d3.line().defined(d => Number.isFinite(d.y)).x(d => x(+d.x)).y(d => y(d.y));
  const areaGen = d3.area().defined(d => Number.isFinite(d.y)).x(d => x(+d.x)).y0(y(Math.max(0, y.domain()[0]))).y1(d => y(d.y));
  const xt = x.ticks(Math.max(3, Math.floor(width / 90)));
  const yt = y.ticks(4);
  const allX = [...new Set(all.map(d => +d.x))].sort((a, b) => a - b);
  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) * (width / r.width);
    const t = x.invert(px);
    const i = d3.bisectCenter(allX, +t);
    const xv = allX[Math.max(0, Math.min(allX.length - 1, i))];
    setHover({ x: xv, px: x(xv) });
  };
  const t = tokens();
  return html`<figure class="chart" ref=${ref} style="margin:0">
    ${title && html`<figcaption><div class="chart__title">${title}</div>${sub && html`<div class="chart__sub">${sub}</div>`}</figcaption>`}
    ${series.length > 1 && html`<div class="row small" style="gap:.25rem 1rem;margin-bottom:.35rem">${series.map(s => html`<span class="row" style="gap:.35rem"><span class="swatch" style=${`background:${s.color};border-radius:1px;height:2px;width:14px`}></span><span class="text2">${s.label}</span></span>`)}</div>`}
    <svg viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${typeof title === 'string' ? title : yLabel || 'Line chart'} onMouseMove=${onMove} onMouseLeave=${() => setHover(null)}>
      <g class="grid">${yt.map(v => html`<line x1=${m.l} x2=${width - m.r} y1=${y(v)} y2=${y(v)} />`)}</g>
      <g class="axis">
        <line x1=${m.l} x2=${width - m.r} y1=${height - m.b} y2=${height - m.b} />
        ${xt.map(v => html`<text x=${x(v)} y=${height - 8} text-anchor="middle">${d3.utcFormat(xs[1] - xs[0] > 400 * 864e5 ? '%b %Y' : xs[1] - xs[0] > 60 * 864e5 ? '%b' : '%b %d')(v)}</text>`)}
        ${yt.map(v => html`<text x=${m.l - 6} y=${y(v) + 3.5} text-anchor="end">${yFormat(v)}</text>`)}
      </g>
      ${markers.map(mk => html`<g><line x1=${x(+mk.x)} x2=${x(+mk.x)} y1=${m.t} y2=${height - m.b} stroke=${t.muted} stroke-width="1" /><text x=${x(+mk.x) + 4} y=${m.t + 9} style="fill:var(--text-2)">${mk.label}</text></g>`)}
      ${series.map(s => html`<g>
        ${area && html`<path d=${areaGen(s.values)} fill=${s.color} opacity="0.12" />`}
        <path d=${line(s.values)} fill="none" stroke=${s.color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
        ${series.length > 1 && series.length <= 4 && (() => { const last = [...s.values].reverse().find(d => Number.isFinite(d.y)); return last ? html`<text x=${x(+last.x) + 6} y=${y(last.y) + 3.5} style="fill:var(--text-2)">${s.label}</text>` : null; })()}
      </g>`)}
      ${hover && html`<g>
        <line x1=${hover.px} x2=${hover.px} y1=${m.t} y2=${height - m.b} stroke=${t.text2} stroke-width="1" opacity="0.5" />
        ${series.map(s => { const d = s.values.find(v => +v.x === hover.x); return d && Number.isFinite(d.y) ? html`<circle cx=${hover.px} cy=${y(d.y)} r="4" fill=${s.color} stroke=${t.bg} stroke-width="2" />` : null; })}
      </g>`}
    </svg>
    ${hover && html`<div class="chart__tip" style=${`left:${Math.min(hover.px / width * 100, 70)}%;top:0`}>
      <div><b>${xFormat(hover.x)}</b></div>
      ${series.map(s => { const d = s.values.find(v => +v.x === hover.x); return html`<div>${series.length > 1 ? `${s.label}: ` : ''}${d ? yFormat(d.y) : '–'}</div>`; })}
    </div>`}
  </figure>`;
}

// Horizontal bars in HTML (accessible, wraps labels). rows: [{ label, value, color?, note? }]
export function BarList({ rows, format = fmtNum, title, sub, color, max, diverging = false }) {
  const t = tokens();
  const mx = max ?? Math.max(1e-12, ...rows.map(r => Math.abs(r.value)).filter(Number.isFinite));
  return html`<figure class="chart" style="margin:0">
    ${title && html`<figcaption><div class="chart__title">${title}</div>${sub && html`<div class="chart__sub">${sub}</div>`}</figcaption>`}
    <div role="list">
      ${rows.map(r => {
        const v = r.value;
        const w = Number.isFinite(v) ? Math.abs(v) / mx * (diverging ? 50 : 100) : 0;
        const c = r.color || color || t.cat[0];
        return html`<div role="listitem" class="barrow" title=${`${r.label}: ${format(v)}`} style="display:grid;grid-template-columns:minmax(6rem,34%) minmax(0,1fr) auto;gap:.6rem;align-items:center;padding:.22rem 0;font-size:.8125rem">
          <span class="text2" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.label}</span>
          <span style="position:relative;height:10px;display:block">
            ${diverging && html`<span style="position:absolute;left:50%;top:-3px;bottom:-3px;width:1px;background:var(--rule-strong)"></span>`}
            <span style=${`position:absolute;top:0;height:10px;background:${c};${diverging ? (v >= 0 ? `left:50%;width:${w}%;border-radius:0 4px 4px 0` : `right:50%;width:${w}%;border-radius:4px 0 0 4px`) : `left:0;width:${w}%;border-radius:0 4px 4px 0`}`}></span>
          </span>
          <span class="tnum" style="color:var(--text);min-width:3.5rem;text-align:right">${format(v)}${r.note ? html`<span class="muted"> ${r.note}</span>` : ''}</span>
        </div>`;
      })}
    </div>
  </figure>`;
}

// Event-count histogram with an optional selected range [a, b] (ms).
export function Histogram({ hist, range, height = 56, label = 'Activity over time', onPick }) {
  const ref = useRef(null);
  const width = useWidth(ref, 400);
  const [hover, setHover] = useState(null);
  const t = tokens();
  if (!hist || !hist.step) return html`<p class="muted small">No timestamps to plot.</p>`;
  const n = hist.bins.length;
  const bw = width / n;
  const mx = Math.max(1, ...hist.bins);
  const inRange = (i) => {
    if (!range) return true;
    const s = hist.lo + i * hist.step, e = s + hist.step;
    return (range[0] == null || e > range[0]) && (range[1] == null || s < range[1]);
  };
  return html`<div class="chart" ref=${ref}>
    <svg viewBox=${`0 0 ${width} ${height + 14}`} role="img" aria-label=${label} onMouseLeave=${() => setHover(null)}>
      ${Array.from(hist.bins, (c, i) => {
        const h = c ? Math.max(1, c / mx * height) : 0;
        return html`<rect x=${i * bw + 0.5} y=${height - h} width=${Math.max(1, bw - 1)} height=${h} rx="1" fill=${inRange(i) ? t.seq[3] : t.seq[0]}
          onMouseEnter=${() => setHover(i)} onClick=${onPick ? () => onPick(hist.lo + i * hist.step) : undefined} />`;
      })}
      <line x1="0" x2=${width} y1=${height + 0.5} y2=${height + 0.5} stroke=${t.muted} stroke-opacity="0.4" />
      <text x="0" y=${height + 12}>${fmtDate(hist.lo)}</text>
      <text x=${width} y=${height + 12} text-anchor="end">${fmtDate(hist.hi)}</text>
    </svg>
    ${hover != null && html`<div class="chart__tip" style=${`left:${Math.min(hover / n * 100, 65)}%;top:-1.6rem`}><b>${fmtNum(hist.bins[hover])}</b> events from ${fmtDate(hist.lo + hover * hist.step)}</div>`}
  </div>`;
}

// Matrix heatmap. rows/cols: labels; values[r][c]; color(v) -> css colour.
export function Heatmap({ rows, cols, values, color, format = fmtNum, title, sub, cellLabel }) {
  const ref = useRef(null);
  const width = useWidth(ref);
  const [hover, setHover] = useState(null);
  const k = cols.length;
  const labelW = Math.min(140, Math.max(60, width * 0.22));
  const cell = Math.max(14, Math.min(44, (width - labelW) / Math.max(1, k)));
  const showText = cell >= 34;
  const h = rows.length * cell + 4;
  const topH = 0;
  const t = tokens();
  return html`<figure class="chart" ref=${ref} style="margin:0">
    ${title && html`<figcaption><div class="chart__title">${title}</div>${sub && html`<div class="chart__sub">${sub}</div>`}</figcaption>`}
    <svg viewBox=${`0 0 ${Math.min(width, labelW + k * cell + 2)} ${h + topH + 18}`} style=${`max-width:${labelW + k * cell + 2}px`} role="img" aria-label=${typeof title === 'string' ? title : 'Mixing matrix'} onMouseLeave=${() => setHover(null)}>
      ${rows.map((r, i) => html`<text x=${labelW - 8} y=${topH + i * cell + cell / 2 + 4} text-anchor="end" style="fill:var(--text-2)">${String(r).slice(0, 18)}</text>`)}
      ${rows.map((r, i) => cols.map((c, j) => {
        const v = values[i][j];
        return html`<g onMouseEnter=${() => setHover({ i, j })}>
          <rect x=${labelW + j * cell + 1} y=${topH + i * cell + 1} width=${cell - 2} height=${cell - 2} rx="1" fill=${color(v)} stroke=${hover && hover.i === i && hover.j === j ? t.text : 'none'} stroke-width="1.5" />
          ${showText && html`<text x=${labelW + j * cell + cell / 2} y=${topH + i * cell + cell / 2 + 4} text-anchor="middle" style=${`fill:${inkOn(color(v))};font-size:10px`}>${cellLabel ? cellLabel(v) : format(v)}</text>`}
        </g>`;
      }))}
      ${cols.map((c, j) => html`<text x=${labelW + j * cell + cell / 2} y=${h + topH + 12} text-anchor="middle">${k <= 10 ? String(c).slice(0, 6) : j + 1}</text>`)}
    </svg>
    ${hover && html`<div class="chart__tip" style="right:0;top:0"><b>${rows[hover.i]}</b> to <b>${cols[hover.j]}</b>: ${format(values[hover.i][hover.j])}</div>`}
  </figure>`;
}

// Tiny line for small multiples; values: [{ x, y }]. Shares a y-domain when given.
export function Spark({ values, domain, height = 46, color, label, valueLabel }) {
  const ref = useRef(null);
  const width = useWidth(ref, 180);
  const [hover, setHover] = useState(null);
  const t = tokens();
  const pts = values.filter(v => Number.isFinite(v.y));
  if (!pts.length) return html`<div class="small muted">${label}: no data</div>`;
  const x = d3.scaleLinear().domain(d3.extent(values, d => +d.x)).range([2, width - 2]);
  const dom = domain || d3.extent(pts, d => d.y);
  const y = d3.scaleLinear().domain([Math.min(0, dom[0]), dom[1] || 1]).range([height - 3, 3]);
  const line = d3.line().defined(d => Number.isFinite(d.y)).x(d => x(+d.x)).y(d => y(d.y));
  return html`<div class="chart" ref=${ref}>
    <div class="row row--between small"><span class="text2">${label}</span><span class="tnum">${valueLabel ?? ''}</span></div>
    <svg viewBox=${`0 0 ${width} ${height}`} role="img" aria-label=${label} onMouseMove=${e => { const r = e.currentTarget.getBoundingClientRect(); const xv = x.invert((e.clientX - r.left) * width / r.width); const i = d3.bisectCenter(values.map(v => +v.x), xv); setHover(values[Math.max(0, Math.min(values.length - 1, i))]); }} onMouseLeave=${() => setHover(null)}>
      <line x1="0" x2=${width} y1=${height - 2.5} y2=${height - 2.5} stroke=${t.muted} stroke-opacity="0.3" />
      <path d=${line(values)} fill="none" stroke=${color || t.cat[0]} stroke-width="1.6" />
      ${hover && Number.isFinite(hover.y) && html`<circle cx=${x(+hover.x)} cy=${y(hover.y)} r="3" fill=${color || t.cat[0]} stroke=${t.bg} stroke-width="1.5" />`}
    </svg>
    ${hover && html`<div class="chart__tip" style="right:0;top:-1.4rem">${fmtDate(+hover.x)}: <b>${fmtNum(hover.y)}</b></div>`}
  </div>`;
}

export function RampLegend({ scale, label, format = fmtNum }) {
  const ramp = scale.ramp;
  return html`<div>
    ${label && html`<p class="label">${label}</p>`}
    <div class="ramp" style=${`background:linear-gradient(90deg,${ramp.join(',')})`}></div>
    <div class="ramp-labels"><span>${format(scale.domain[0])}</span><span>${format(scale.domain[1])}</span></div>
  </div>`;
}

// Text colour with the higher WCAG contrast on a given fill.
function lum(c) {
  const { r, g, b } = d3.rgb(c);
  const f = x => { x /= 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
export function inkOn(fill) {
  const L = lum(fill);
  const dark = (L + 0.05) / (lum('#071A2B') + 0.05), light = (lum('#F6FAFD') + 0.05) / (L + 0.05);
  return dark >= light ? '#071A2B' : '#F6FAFD';
}
