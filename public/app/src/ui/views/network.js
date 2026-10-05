// Network view: sigma.js (WebGL) over positions from the engine.
//
// Color by community, any categorical attribute, or a metric (sequential);
// size by a metric; filter ties by construction rule and visibility layer;
// search; hover and click to select with neighborhood highlight; click a tie
// (or pick one from the selected person's list) to see the events that
// created it; export the current view as SVG or PNG (drawn from positions,
// not a screenshot of the canvas).
//
// Figure style (design rules): solid mint-family ties, a ring of the canvas
// ground around every person so dense clusters stay separable, 12px labels
// with a halo, placed by our own pass that skips any label that would collide
// with another or run off the canvas, and community numbers or group names
// at each cluster so groups never rely on color alone.
//
// Groups (communities or an attribute) take the eight hues in fixed order.
// Past eight the map is in highlight mode (lib/grouping.js): the rest share
// "Other groups", the legend lists every group, and choosing one lights it
// up in the accent.

import { html, useState, useEffect, useRef, useMemo, useCallback } from '../../../vendor/preact.js';
import { Sigma, NodeCircleProgram } from '../../../vendor/sigma.js';
import { Graph } from '../../../vendor/graphology.js';
import { store, useStore } from '../store.js';
import { engine } from '../services/engine.js';
import { gloss } from '../services/glossary.js';
import { ViewHead, NeedsData, Loading, ErrorLine, Select, MetricName, Flag, Swatch, ConstructionButton, useEngine, download, Icon, HowToRead, Verdict, Term, nullInWords, chanceWords } from '../components/common.js';
import { RampLegend } from '../components/charts.js';
import { tokens, dim, mixTo } from '../lib/palette.js';
import { preferredAttributes, isBookkeeping, label as nodeLabel, RULE_LABEL, VISIBILITY_LABEL } from '../lib/dsutil.js';
import { groupColoring, groupLabelMin, OTHER, MISSING } from '../lib/grouping.js';
import { fmtNum, fmtInt, fmtDateTime, fmtP, fmtAttr, humanize, plural } from '../lib/format.js';
import { communityWords, communityCounts } from '../lib/rebuild.js';
import { withContacts, metricLabel, displayKey, isDeactivated, distinctMeasures, measureNote, measureFormat, standouts } from '../lib/measures.js';
import { nodeColoring, getColorBy, setColorBy as shareColorBy } from '../lib/coloring.js';
import { departures } from '../lib/departures.js';
import { topShare, whatIf, concentrationWords, DEPENDS_SHARE } from '../lib/fragility.js';
import { requestPeopleSort } from '../lib/viewprefs.js';
import { ClassicFacts } from './learn/classic.js';
import { communityScale, communityNumber } from '../lib/communities.js';
import { orientLayout, labelBudget, overlaps, groupAnchors, hullEdgeSpots, namesFirst } from '../lib/labels.js';
import { VISIBILITY } from '../../core/model.js';
import { cachedRender, getRender, clearRender, tiesOf } from '../lib/render-cache.js';
import { twoModeOfNet, isTwoModeView, layoutOptions, defaultLayout, arrangeFor, projectionSentence, twoModeIntro, perModeStandouts, standoutWords, withoutModeAttr, modeLabelOf, TWO_MODE_KEYS } from '../lib/twomode.js';

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const dur = ms => (reducedMotion() ? 0 : ms);
const coarse = () => typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
const narrow = () => typeof innerWidth === 'number' && innerWidth <= 1060;

// Display choices survive switching views (not reloads); reset per dataset.
let prefs = { ds: null };

// Open Generate at its recovery panel rather than at the top of the form.
function openRecovery() {
  store.actions.setView('generate');
  let tries = 0;
  const go = () => {
    const el = document.getElementById('ob-rec-title');
    if (el) { el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); el.setAttribute('tabindex', '-1'); el.focus({ preventScroll: true }); }
    else if (++tries < 40) setTimeout(go, 50);
  };
  setTimeout(go, 0);
}

export function NetworkView() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  if (!ds || !net) return html`<${NeedsData} title="Network" />`;
  return html`<${NetworkInner} ds=${ds} net=${net} />`;
}

// arrange: the two-mode arrangement ('columns' | 'rows') or null (force).
function useRender(net, arrange = null) {
  const [state, setState] = useState(() => { const d = cachedRender(net.version, arrange); return d ? { data: d } : { loading: true }; });
  useEffect(() => {
    const d = cachedRender(net.version, arrange);
    if (d) { setState({ data: d }); return; }
    let live = true;
    setState({ loading: true });
    getRender(net.version, arrange).then(data => { if (live) setState({ data }); },
      error => { if (live) setState({ error: error.name === 'AbortError' ? new Error('Layout cancelled.') : error }); });
    return () => { live = false; };
  }, [net.version, arrange]);
  return state;
}

// The hand layout a drawn network carries (ds.meta.positions, by dataset
// index), when it still matches the dataset.
function drawnPositions(ds) {
  const p = ds.meta?.positions;
  return Array.isArray(p) && p.length === ds.nodes.count ? p : null;
}

function NetworkInner({ ds, net }) {
  const positions0 = drawnPositions(ds);
  // Layout choice per dataset and per two-mode view (columns are offered
  // only on the two-mode view itself).
  const tmView = twoModeOfNet(net)?.view ?? null;
  if (prefs.ds !== ds) prefs = { ds, sizeBy: 'contacts', layout: defaultLayout(net, { drawn: !!positions0 }), view: tmView };
  else if (prefs.view !== tmView) { prefs.view = tmView; if (!layoutOptions(net, { drawn: !!positions0 }).some(o => o.value === prefs.layout) || tmView === 'two-mode') prefs.layout = defaultLayout(net, { drawn: !!positions0 }); }
  const r = useRender(net, arrangeFor(prefs.layout));
  const rawMetrics = useStore(s => s.metrics);
  const communities = useStore(s => s.communities);
  const applicability = useStore(s => s.applicability);
  const selection = useStore(s => s.selection);
  const attrs = useMemo(() => withoutModeAttr(preferredAttributes(ds)), [ds]);
  const nodeMetrics = useMemo(() => withContacts(rawMetrics?.node, net.directed), [rawMetrics, net.directed]);
  const positions = positions0;
  const tm = twoModeOfNet(net);
  const twoModeView = isTwoModeView(net);
  // Color by is shared with the People swatches (lib/coloring.js).
  // Read from the shared choices on every render: the view stays mounted
  // when a new dataset loads, so component state would keep the old one.
  const [, redraw] = useState(0);
  const colorBy = getColorBy(ds, communities, attrs, net);
  const { sizeBy, layout } = prefs;
  const setColorBy = v => { shareColorBy(ds, v); redraw(x => x + 1); };
  const setSizeBy = v => { prefs.sizeBy = v; redraw(x => x + 1); };
  const setLayout = v => { prefs.layout = v; redraw(x => x + 1); };
  const [rulesOff, setRulesOff] = useState(new Set());
  const [visOff, setVisOff] = useState(new Set());
  // The legend row chosen (click or Enter) and the one under the pointer or
  // keyboard focus; the second previews over the first.
  const [pinCat, setPinCat] = useState(null);
  const [hoverCat, setHoverCat] = useState(null);
  const focusCat = hoverCat ?? pinCat;
  const [edgeSel, setEdgeSel] = useState(null); // { a, b } dataset indices
  const sigmaRef = useRef(null);
  const sideRef = useRef(null);

  const nodeMetricKeys = distinctMeasures(Object.keys(nodeMetrics || {}).filter(k => applicability?.[k]?.level !== 'na'), net.directed);
  const mlabel = k => metricLabel(k, net.directed);

  // Color assignment, decided over the whole network so filters never repaint
  // (lib/coloring.js, shared with People); the map reads it by render index.
  const coloring = useMemo(() => {
    if (!r.data) return null;
    const ni = r.data.netIndex;
    const c = nodeColoring({ ds, net, communities, colorBy, attrs, nodeMetrics, label: mlabel });
    return { ...c, of: v => c.of(ni[v]), key: c.key ? v => c.key(ni[v]) : undefined };
  }, [r.data, colorBy, communities, nodeMetrics, ds, net]);

  const sizes = useMemo(() => {
    if (!r.data) return null;
    const n = r.data.x.length;
    const arr = sizeBy !== 'none' ? nodeMetrics?.[sizeBy] : null;
    const base = n > 2000 ? 1.6 : n > 500 ? 2.4 : 3.5;
    const span = n > 2000 ? 5 : n > 500 ? 7 : 9;
    const out = new Float32Array(n).fill(base + span * 0.25);
    if (arr) {
      const ni = r.data.netIndex;
      let mx = 0; for (let i = 0; i < n; i++) { const x = arr[ni[i]]; if (Number.isFinite(x) && x > mx) mx = x; }
      for (let i = 0; i < n; i++) { const x = arr[ni[i]]; out[i] = base + span * Math.sqrt(Math.max(0, Number.isFinite(x) ? x : 0) / (mx || 1)); }
    }
    return out;
  }, [r.data, sizeBy, nodeMetrics]);

  const rulesPresent = useMemo(() => (r.data ? Object.keys(r.data.byRule || {}).filter(k => r.data.byRule[k]?.some?.(x => x > 0)) : []), [r.data]);
  const visPresent = useMemo(() => {
    if (!r.data?.layerMask) return [];
    let any = 0; for (const m of r.data.layerMask) any |= m;
    return VISIBILITY.filter((_, i) => any & (1 << i));
  }, [r.data]);

  const selectNode = useCallback((dsIdx, additive = false) => {
    setEdgeSel(null);
    if (dsIdx == null) { store.actions.select([]); return; }
    const cur = store.get().selection;
    store.actions.select(additive ? (cur.includes(dsIdx) ? cur.filter(x => x !== dsIdx) : [...cur, dsIdx]) : [dsIdx]);
  }, []);
  const showDetails = () => sideRef.current?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });

  if (r.error) return html`<div class="view"><${ViewHead} title="Network" /><${ErrorLine} error=${r.error} onRetry=${() => { clearRender(); store.set({ network: { ...net, version: Date.now() } }); }} /></div>`;

  const plainAttrs = attrs.filter(a => !isBookkeeping(a));
  const bookAttrs = attrs.filter(a => isBookkeeping(a));
  const colorOptions = [
    { value: 'none', label: 'Single color' },
    ...(twoModeView ? [{ value: 'mode', label: `Kind of node (${tm.labels.map(x => x.toLowerCase()).join(', ')})` }] : []),
    ...(communities ? [{ value: 'community', label: `Community (${communityCounts(communities).groups})` }] : []),
    ...(plainAttrs.length ? [{ group: 'Attributes', options: plainAttrs.map(a => ({ value: `attr:${a.key}`, label: `${a.label} (${a.values.length})` })) }] : []),
    { group: 'Measure (low to high)', options: nodeMetricKeys.map(k => ({ value: `metric:${k}`, label: mlabel(k) })) },
    ...(bookAttrs.length ? [{ group: 'Data-collection fields', options: bookAttrs.map(a => ({ value: `attr:${a.key}`, label: `${a.label} (${a.values.length})` })) }] : []),
  ];
  const sizeOptions = [{ value: 'none', label: 'Same size' }, ...nodeMetricKeys.map(k => ({ value: k, label: mlabel(k) }))];
  const sel = selection[selection.length - 1];
  const touch = coarse();
  const noun = ds.meta?.nodeNoun || ['person', 'people'];
  const layouts = layoutOptions(net, { drawn: !!positions });
  const arranged = !!arrangeFor(layout) && twoModeView;
  // Copy audit 2026-10-04: counts, what the view shows, then what selecting does.
  // The two-mode view has no random-network comparison, so it does not claim one.
  const intro = tm ? `${twoModeIntro(tm, fmtInt(net.n), fmtInt(net.edgeCount))}${tm.view !== 'two-mode' ? ` ${projectionSentence(tm)}` : ''} Select a node to inspect its neighborhood or a tie to inspect the observations that produced it.`
    : `${fmtInt(net.n)} ${noun[1]} and ${fmtInt(net.edgeCount)} ties${net.directed ? ' (directed: a two-way tie counts as two)' : ''}. This view shows the constructed network, whole-network measures, and comparisons with degree-preserving random networks. Select a ${noun[0]} to inspect their neighborhood or a tie to inspect the observations that produced it.`;

  return html`<div class="view">
    <${ViewHead} title="Network" intro=${intro}
      actions=${html`<div class="tlinks"><${ConstructionButton} /><${ExportMenu} sigmaRef=${sigmaRef} data=${r.data} coloring=${coloring} ds=${ds} /></div>`} />
    <${RecoveryBanner} ds=${ds} />
    ${twoModeView ? html`<${TwoModeStandouts} ds=${ds} net=${net} metrics=${nodeMetrics} onPick=${(i) => { selectNode(i); sigmaRef.current?.focusNode(i); }} />`
      : html`<${Standouts} ds=${ds} net=${net} metrics=${nodeMetrics} applicability=${applicability} onPick=${(i) => { selectNode(i); sigmaRef.current?.focusNode(i); }} />`}
    <div class="toolbar" role="group" aria-label="Network display">
      <${Select} label="Color by" value=${colorBy} onChange=${v => { setColorBy(v); setPinCat(null); setHoverCat(null); }} options=${colorOptions} />
      <${Select} label="Size by" value=${sizeBy} onChange=${setSizeBy} options=${sizeOptions} />
      ${layouts.length > 1 && html`<${Select} label="Layout" value=${layout} onChange=${setLayout} options=${layouts} />`}
      <${Search} ds=${ds} ids=${r.data?.nodeIds} onPick=${(i) => { selectNode(i); sigmaRef.current?.focusNode(i); }} />
    </div>
    <div class="split">
      <div class="split__main">
        ${r.loading || !r.data ? html`<div class="net"><div class="net__empty"><${Loading}>Computing layout</${Loading}></div></div>`
          : html`<${SigmaCanvas} ref_=${sigmaRef} data=${r.data} ds=${ds} coloring=${coloring} sizes=${sizes} selection=${selection} focusCat=${focusCat}
              rulesOff=${rulesOff} visOff=${visOff} edgeSel=${edgeSel} onNode=${selectNode} onEdge=${setEdgeSel}
              positions=${layout === 'drawn' ? positions : null} arranged=${arranged} />`}
        ${selection.length > 0 && html`<div class="net-selbar" aria-live="polite">
          <span class="grow"><strong>${nodeLabel(ds, sel)}</strong>${selection.length > 1 ? html` <span class="muted">and ${selection.length - 1} more</span>` : ''}</span>
          <button type="button" class="tlink tlink--down" onClick=${showDetails}>Details</button>
          <button type="button" class="tlink tlink--quiet" onClick=${() => store.actions.select([])}>Clear</button>
        </div>`}
        ${r.data?.truncated && (r.data.truncated.nodes || r.data.truncated.edges) ? html`<p class="small" style="margin-top:.5rem"><${Flag} level="info">Drawing simplified</${Flag}> <span class="text2">${r.data.truncated.nodes ? `${fmtInt(r.data.truncated.nodes)} least connected people` : ''}${r.data.truncated.nodes && r.data.truncated.edges ? ' and ' : ''}${r.data.truncated.edges ? `${fmtInt(r.data.truncated.edges)} weakest ties` : ''} are not drawn. Every measure still uses the full network.</span></p>` : ''}
        <p class="basis" style="margin-top:.5rem">${layout === 'drawn' && positions ? 'Positions: as drawn in Build.' : arranged ? `Positions: ${tm.labels[0].toLowerCase()} in one ${layout === 'rows' ? 'row' : 'column'}, ${tm.labels[1].toLowerCase()} in the other, each ordered so lines cross less. Order within a side carries no meaning.` : 'Positions: force-directed layout from the engine. Distance on screen is approximate; read structure from the measures, not the picture.'}${twoModeView ? ` Shapes: ${tm.labels[0].toLowerCase()} are circles, ${tm.labels[1].toLowerCase()} squares.` : ''}
          ${touch ? ' Tap a person to select them, tap empty space to clear. Move or zoom the map with two fingers; one finger scrolls the page.'
            : ' Click a person to select them; Shift-click adds people. Keys on the map: arrows move it, plus and minus zoom, 0 fits, Escape clears the selection.'}</p>
      </div>
      <aside class="split__side" aria-label="Details" ref=${sideRef}>
        <div class="section net-legend">
          <${Legend} coloring=${coloring} pinCat=${pinCat} setPinCat=${setPinCat} setHoverCat=${setHoverCat} sizeBy=${sizeBy} directed=${net.directed} small=${namesFirst(net.n, layout === 'drawn' && !!positions)} />
        </div>
        <div class="section">
          ${edgeSel ? html`<${Evidence} ds=${ds} a=${edgeSel.a} b=${edgeSel.b} onClose=${() => setEdgeSel(null)} />`
            : selection.length ? html`<${SelectionPanel} ds=${ds} selection=${selection} data=${r.data} metrics=${nodeMetrics} onEdge=${setEdgeSel} />`
            : html`<${NetworkSummary} />`}
        </div>
        ${(selection.length > 0 || edgeSel) && html`<div class="section"><${NetworkSummary} open=${false} /></div>`}
        ${!selection.length && !edgeSel && r.data && !twoModeView && html`<div class="section"><${Fragility} ds=${ds} net=${net} data=${r.data} metrics=${nodeMetrics} coloring=${coloring} applicability=${applicability} /></div>`}
        ${(rulesPresent.length > 1 || visPresent.length > 1) && html`<div class="section stack">
          <h2 class="label" style="margin:0">Show ties</h2>
          ${rulesPresent.length > 1 && html`<${Filter} label="From these rules" items=${rulesPresent} names=${RULE_LABEL} off=${rulesOff} setOff=${setRulesOff} />`}
          ${visPresent.length > 1 && html`<${Filter} label="In these layers" items=${visPresent} names=${VISIBILITY_LABEL} off=${visOff} setOff=${setVisOff} />`}
          <p class="basis">Hides ties on the map only. To change what counts as a tie in the measures, use the construction settings.</p>
        </div>`}
      </aside>
    </div>
  </div>`;
}

// Decision 6: whenever the loaded data is the generated world, say so and
// point to the recovery check, which lives in Generate.
function RecoveryBanner({ ds }) {
  const gen = useStore(s => s.generated);
  if (!gen || !(gen.dataset === ds || (gen.datasetName && gen.datasetName === ds.meta?.name))) return null;
  const rec = gen.recovery;
  return html`<div class="net-banner" role="note">
    <${Flag} level="info">Generated</${Flag}>
    <span class="grow">${rec?.summary ? `Recovery check: ${rec.summary}` : 'This network was generated with planted structure. The recovery check compares what the analysis finds with what was planted.'}</span>
    <button type="button" class="tlink tlink--arrow" onClick=${openRecovery}>${rec ? 'Full recovery check' : 'Run the recovery check'}</button>
  </div>`;
}

function Filter({ label, items, names = {}, off, setOff }) {
  return html`<fieldset class="field" style="border:0;padding:0;margin:0;min-width:0">
    <legend class="field__label" style="padding:0;margin-bottom:.3rem">${label}</legend>
    <div class="row" style="gap:.15rem .8rem">
      ${items.map(it => html`<label class="check"><input type="checkbox" checked=${!off.has(it)} onChange=${e => { const n = new Set(off); if (e.currentTarget.checked) n.delete(it); else n.add(it); setOff(n); }} />${names[it] || humanize(it)}</label>`)}
    </div>
  </fieldset>`;
}

function Search({ ds, ids, onPick }) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => {
    if (!q.trim() || !ids) return [];
    const s = q.trim().toLowerCase();
    const out = [];
    for (let v = 0; v < ids.length && out.length < 8; v++) {
      const i = ids[v];
      if ((ds.nodes.labels[i] || '').toLowerCase().includes(s) || ds.nodes.keys[i].toLowerCase().includes(s)) out.push(i);
    }
    return out;
  }, [q, ids]);
  const pick = (i) => { onPick(i); setQ(ds.nodes.labels[i]); setOpen(false); };
  return html`<div class="field field--grow" style="position:relative" data-notice-avoid>
    <label for="net-search" class="field__label">Find a person</label>
    <input id="net-search" class="input" type="search" role="combobox" aria-expanded=${String(open && results.length > 0)} aria-controls="net-search-list" aria-autocomplete="list"
      aria-activedescendant=${open && results[active] != null ? `ns-${results[active]}` : undefined}
      placeholder="Name or id" value=${q} onInput=${e => { setQ(e.currentTarget.value); setOpen(true); setActive(0); }}
      onKeyDown=${e => {
        if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(results.length - 1, a + 1)); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)); }
        else if (e.key === 'Enter' && results[active] != null) { e.preventDefault(); pick(results[active]); }
        else if (e.key === 'Escape') setOpen(false);
      }} onBlur=${() => setTimeout(() => setOpen(false), 150)} />
    ${open && results.length > 0 && html`<ul id="net-search-list" role="listbox" class="net-search__list">
      ${results.map((i, k) => { const key = displayKey(ds.nodes.keys[i]); return html`<li id=${`ns-${i}`} role="option" aria-selected=${String(k === active)} class=${k === active ? 'is-active' : ''} onMouseDown=${e => { e.preventDefault(); pick(i); }}>${ds.nodes.labels[i]}${key ? html` <span class="meta">${key}</span>` : ''}</li>`; })}
    </ul>`}
  </div>`;
}

// ---- sigma canvas -----------------------------------------------------------------

// Node discs with a thin ring of the canvas ground, so touching people in a
// dense cluster stay separate shapes (sigma's own circle program has no
// border). The triangle that carries each disc is grown by 2px so the ring
// sits outside the disc and the visible size of a node is unchanged.
function borderedNodeProgram(ringHex, { square = false } = {}) {
  const c = ringHex.replace('#', '');
  const rgb = [0, 2, 4].map(i => (parseInt(c.slice(i, i + 2), 16) / 255).toFixed(4));
  const FRAG = `
precision highp float;
varying vec4 v_color;
varying vec2 v_diffVector;
varying float v_radius;
uniform float u_correctionRatio;
const vec4 transparent = vec4(0.0, 0.0, 0.0, 0.0);
const vec4 ring = vec4(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, 1.0);
void main(void) {
  float px = u_correctionRatio * 2.0;
  float dist = ${square ? 'max(abs(v_diffVector.x), abs(v_diffVector.y)) - v_radius * 0.886' : 'length(v_diffVector) - v_radius'};
  #ifdef PICKING_MODE
  if (dist > 0.0) gl_FragColor = transparent; else gl_FragColor = v_color;
  #else
  vec4 c = mix(v_color, ring, smoothstep(-0.5 * px, 0.5 * px, dist));
  float outer = 1.5 * px;
  gl_FragColor = mix(c, transparent, smoothstep(outer - 0.5 * px, outer + 0.5 * px, dist));
  #endif
}
`;
  return class BorderedNodeProgram extends NodeCircleProgram {
    getDefinition() {
      const d = super.getDefinition();
      const sizeLine = 'float size = a_size * u_correctionRatio / u_sizeRatio * 4.0;';
      const radiusLine = 'v_radius = size / 2.0;';
      // Fall back to plain discs if a sigma update changes the shader text.
      if (!d.VERTEX_SHADER_SOURCE.includes(sizeLine) || !d.VERTEX_SHADER_SOURCE.includes(radiusLine)) return d;
      return {
        ...d,
        VERTEX_SHADER_SOURCE: d.VERTEX_SHADER_SOURCE
          // Squares (two-mode networks) reach further out at the corners: a
          // larger carrying triangle keeps them whole. 0.886 gives a square
          // the area of the disc of the same size.
          .replace(sizeLine, square ? 'float size = (a_size / u_sizeRatio * 1.35 + 3.0) * u_correctionRatio * 4.0;' : 'float size = (a_size / u_sizeRatio + 2.0) * u_correctionRatio * 4.0;')
          .replace(radiusLine, 'v_radius = a_size / u_sizeRatio * u_correctionRatio * 2.0;'),
        FRAGMENT_SHADER_SOURCE: FRAG,
      };
    }
  };
}

const LABEL_FONT = 'Geist Variable, Geist, system-ui, sans-serif';

function drawHover(ctx, data, settings) {
  // Dark label box for hover, in place of sigma's default white one; flips
  // to the left of the node near the right edge so it never leaves the map.
  const size = settings.labelSize;
  ctx.font = `600 ${size}px ${LABEL_FONT}`;
  const label = data.label || '';
  const w = ctx.measureText(label).width + 12;
  const W = ctx.canvas.clientWidth || ctx.canvas.width;
  let x = data.x + data.size + 4;
  if (x + w > W - 4) x = Math.max(4, data.x - data.size - 4 - w);
  const y = data.y - size / 2 - 5;
  ctx.fillStyle = 'rgba(5,21,33,0.94)';
  ctx.strokeStyle = 'rgba(255,255,255,0.26)';
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.rect(x, y, w, size + 10); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(data.x, data.y, data.size + 2, 0, Math.PI * 2); ctx.strokeStyle = '#F6FAFD'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = '#F6FAFD';
  ctx.fillText(label, x + 6, data.y + size / 3);
}

function SigmaCanvas({ ref_, data, ds, coloring, sizes, selection, focusCat, rulesOff, visOff, edgeSel, onNode, onEdge, positions, arranged = false }) {
  const box = useRef(null);
  const outer = useRef(null);
  const sig = useRef(null);
  const graph = useRef(null);
  const state = useRef({});
  state.current = { coloring, sizes, selection, focusCat, rulesOff, visOff, edgeSel };
  const focus = useRef({ set: null, core: null });
  const [hovered, setHovered] = useState(null);
  const hoverRef = useRef(null);
  hoverRef.current = hovered;

  // Build the graph once per layout.
  useEffect(() => {
    const t = tokens();
    const g = new Graph({ type: data.directed ? 'directed' : 'undirected', multi: false, allowSelfLoops: false });
    const n = data.x.length;
    let X = data.x, Y = data.y;
    if (positions) {
      X = Float32Array.from(data.nodeIds, i => positions[i]?.[0] ?? 0);
      Y = Float32Array.from(data.nodeIds, i => positions[i]?.[1] ?? 0);
    } else if (!arranged) {
      // Columns and rows (two-mode) keep their orientation; a force layout is
      // turned to fit the frame.
      const rect = box.current.getBoundingClientRect();
      ({ x: X, y: Y } = orientLayout(data.x, data.y, rect.width >= rect.height));
    } else {
      // Columns and rows: spread the two sides apart to about 70% of the
      // frame's shape, so the ties between them can be told apart (the
      // engine's spacing is in layout units and knows nothing of the frame).
      const rect = box.current.getBoundingClientRect();
      const span = a => { let lo = Infinity, hi = -Infinity; for (const x of a) { if (x < lo) lo = x; if (x > hi) hi = x; } return hi - lo || 1; };
      const want = Math.max(0.3, (rect.width || 1) / (rect.height || 1)) * 0.7;
      const sx = span(data.x), sy = span(data.y);
      const k = (want * sy) / sx;
      if (sx < sy) X = Float32Array.from(data.x, x => x * Math.max(1, k));
      else Y = Float32Array.from(data.y, y => y * Math.max(1, sx / (want * sy)));
    }
    // Two-mode networks: mode-1 nodes (events, groups) are squares, so the
    // kind of node never rests on color alone.
    const shapeOf = v => (data.mode && data.mode[v] === 1 ? 'square' : 'circle');
    for (let v = 0; v < n; v++) {
      const i = data.nodeIds[v];
      g.addNode(String(v), { x: X[v], y: -Y[v], size: 3, color: t.node, label: ds.nodes.labels[i] || ds.nodes.keys[i], ds: i, type: shapeOf(v) });
    }
    const m = data.src.length;
    const maxW = Math.max(1e-9, ...Array.from(data.w || []).slice(0, 200000));
    for (let k = 0; k < m; k++) {
      const a = String(data.src[k]), b = String(data.dst[k]);
      if (a === b || g.hasEdge(a, b)) continue;
      const w = data.w ? data.w[k] : 1;
      g.addEdgeWithKey(String(k), a, b, { size: 0.4 + 1.6 * Math.sqrt(w / maxW), k });
    }
    graph.current = g;
    // Solid colors mixed toward the canvas ground instead of alpha: WebGL
    // blending of thousands of translucent lines washes out to near-white.
    // Up to a few thousand ties the lines stay in the mint family.
    const edgeMix = m > 20000 ? 0.86 : m > 3000 ? 0.78 : 0.55;
    const edgeBase = mixTo(t.edge, t.bgDeep, edgeMix);
    const edgeHi = mixTo('#A8E4D2', t.bgDeep, 0.15);
    const renderer = new Sigma(g, box.current, {
      // Labels are placed by drawLabels() below (halo, collision culling,
      // canvas edges); sigma draws only the hover box.
      renderLabels: false,
      labelFont: LABEL_FONT,
      labelSize: 12,
      labelWeight: '500',
      defaultEdgeType: 'line',
      defaultEdgeColor: edgeBase,
      defaultNodeType: 'circle',
      nodeProgramClasses: { circle: borderedNodeProgram(t.bgDeep), square: borderedNodeProgram(t.bgDeep, { square: true }) },
      enableEdgeEvents: m < 60000,
      hideEdgesOnMove: m > 30000,
      zIndex: true,
      minCameraRatio: 0.03,
      maxCameraRatio: 8,
      stagePadding: 28,
      // The container can be momentarily zero-width while views switch; the
      // ResizeObserver below refits it once it has a size.
      allowInvalidContainer: true,
      defaultDrawNodeHover: drawHover,
      nodeReducer: (key, attr) => {
        const s = state.current;
        const v = +key;
        const res = { ...attr };
        res.color = s.coloring ? s.coloring.of(v) : attr.color;
        res.size = s.sizes ? s.sizes[v] : attr.size;
        const sel = s.selection;
        const hv = hoverRef.current;
        const focusSet = focus.current.set;
        if (focusSet) {
          if (!focusSet.has(v)) { res.color = dim(res.color, 0.82); res.dimmed = true; res.zIndex = 0; }
          else { res.zIndex = 2; if (sel.includes(attr.ds)) { res.highlighted = true; res.forceLabel = true; } }
        } else if (s.focusCat != null && s.coloring?.gc) {
          // Highlight mode lights the chosen group in the accent (it may be
          // one of the gray "Other groups"); otherwise it keeps its own hue.
          const many = s.coloring.gc.many;
          if (!s.coloring.gc.matches(s.coloring.key(v), s.focusCat)) { res.color = dim(res.color, many ? 0.88 : 0.8); res.dimmed = true; res.zIndex = 0; }
          else { res.zIndex = 2; if (many) res.color = t.accent; }
        }
        if (hv === key) res.highlighted = true;
        return res;
      },
      edgeReducer: (key, attr) => {
        const s = state.current;
        const k = attr.k;
        const res = { ...attr, color: edgeBase };
        if (s.rulesOff.size && data.byRule) {
          let any = false;
          for (const r in data.byRule) if (!s.rulesOff.has(r) && data.byRule[r][k] > 0) { any = true; break; }
          if (!any) { res.hidden = true; return res; }
        }
        if (s.visOff.size && data.layerMask) {
          let mask = 0; VISIBILITY.forEach((v, i) => { if (!s.visOff.has(v)) mask |= 1 << i; });
          if (!(data.layerMask[k] & mask)) { res.hidden = true; return res; }
        }
        const focusSet = focus.current.set;
        if (focusSet) {
          const [a, b] = g.extremities(key);
          const sel = focus.current.core;
          if (sel.has(+a) || sel.has(+b)) { res.color = edgeHi; res.size = Math.max(1, attr.size); res.zIndex = 2; }
          else { res.hidden = true; }
        } else if (s.focusCat != null && s.coloring?.gc) {
          const [a, b] = g.extremities(key);
          const gc = s.coloring.gc;
          if (!gc.matches(s.coloring.key(+a), s.focusCat) && !gc.matches(s.coloring.key(+b), s.focusCat)) res.hidden = true;
        }
        if (s.edgeSel) {
          const [a, b] = g.extremities(key);
          const da = data.nodeIds[+a], db = data.nodeIds[+b];
          if ((da === s.edgeSel.a && db === s.edgeSel.b) || (da === s.edgeSel.b && db === s.edgeSel.a)) { res.color = '#F6FAFD'; res.size = 2.5; res.hidden = false; res.zIndex = 3; }
        }
        return res;
      },
    });
    sig.current = renderer;

    // Our label layer sits above sigma's node and label layers and below the
    // hover box.
    renderer.createCanvasContext('f2labels', { afterLayer: 'labels' });
    const placed = { labels: [], badges: [], groups: [] };
    const centres = groupCentres(g, state);
    // Columns and rows leave room to name everyone in a classroom-sized network.
    const nameAll = arranged && n <= 150;
    const small = namesFirst(n, !!positions) || nameAll;
    renderer.on('afterRender', () => {
      try { drawLabels(renderer, g, data, state.current, focus.current, hoverRef.current, centres, placed, small, nameAll); } catch { /* killed mid-frame */ }
    });
    renderer.refresh();

    renderer.on('enterNode', ({ node }) => { setHovered(node); box.current.style.cursor = 'pointer'; });
    renderer.on('leaveNode', () => { setHovered(null); box.current.style.cursor = ''; });
    renderer.on('clickNode', ({ node, event }) => onNode(data.nodeIds[+node], event?.original?.shiftKey));
    renderer.on('clickStage', () => { onNode(null); });
    renderer.on('clickEdge', ({ edge }) => { const [a, b] = g.extremities(edge); onEdge({ a: data.nodeIds[+a], b: data.nodeIds[+b] }); });
    renderer.on('enterEdge', () => { box.current.style.cursor = 'pointer'; });
    renderer.on('leaveEdge', () => { box.current.style.cursor = ''; });

    // Phones: one finger scrolls the page (the map took 60% of the screen
    // and swallowed every swipe), a tap still selects through the mouse
    // events the browser synthesises, and two fingers move or zoom the map.
    const wrap = outer.current;
    let multi = false;
    const onTouch = (e) => {
      if (e.type === 'touchstart') multi = e.touches.length > 1;
      if (!multi && e.touches.length <= 1) e.stopPropagation();
    };
    if (coarse()) {
      const mouse = renderer.getContainer().querySelector('.sigma-mouse');
      if (mouse) mouse.style.touchAction = 'pan-y';
      for (const ev of ['touchstart', 'touchmove', 'touchend']) wrap.addEventListener(ev, onTouch, { capture: true });
    }

    ref_.current = {
      sigma: renderer,
      graph: g,
      placed,
      // Frame a person picked by name with their neighbors, so their ties
      // stay on the canvas (a fixed zoom ran most of a broker's ties off it).
      focusNode(dsIdx) {
        const v = data.nodeIds.indexOf(dsIdx);
        if (v < 0) return;
        const cam = renderer.getCamera();
        const view = focusFrame(renderer, g, String(v));
        if (view) cam.animate({ ...view, angle: cam.getState().angle }, { duration: dur(400) });
      },
    };
    // The canvas height follows the viewport and the status bar; keep sigma's
    // idea of its size in step so the graph stays fitted.
    // On the next frame, so the resize cannot loop inside the observer (WebKit).
    let raf = 0;
    const ro = new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { try { renderer.resize(); renderer.refresh(); } catch { /* killed */ } }); });
    ro.observe(box.current);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      for (const ev of ['touchstart', 'touchmove', 'touchend']) wrap.removeEventListener(ev, onTouch, { capture: true });
      renderer.kill(); sig.current = null; ref_.current = null;
    };
  }, [data, positions, arranged]);

  // Recompute highlight sets and refresh when display state changes.
  useEffect(() => {
    const g = graph.current;
    if (!g || !sig.current) return;
    const s = state.current;
    const core = new Set();
    const toNet = new Map();
    for (let v = 0; v < data.nodeIds.length; v++) toNet.set(data.nodeIds[v], v);
    for (const i of s.selection) { const v = toNet.get(i); if (v != null) core.add(v); }
    if (hovered != null && !core.size) core.add(+hovered);
    if (core.size) {
      const set = new Set(core);
      for (const v of core) g.forEachNeighbor(String(v), u => set.add(+u));
      focus.current = { set, core };
    } else focus.current = { set: null, core: null };
    sig.current.refresh({ skipIndexation: false });
  }, [coloring, sizes, selection, focusCat, rulesOff, visOff, edgeSel, hovered]);

  const onKey = (e) => {
    const r = sig.current; if (!r) return;
    const cam = r.getCamera();
    const st = cam.getState();
    const step = 0.12 * st.ratio;
    const pan = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (pan) { e.preventDefault(); cam.animate({ x: st.x + pan[0], y: st.y + pan[1] }, { duration: dur(120) }); }
    else if (e.key === '+' || e.key === '=') { e.preventDefault(); cam.animatedZoom({ duration: dur(200) }); }
    else if (e.key === '-' || e.key === '_') { e.preventDefault(); cam.animatedUnzoom({ duration: dur(200) }); }
    else if (e.key === '0') { e.preventDefault(); cam.animatedReset({ duration: dur(300) }); }
    else if (e.key === 'Escape') { onNode(null); onEdge(null); }
  };

  return html`<div class="net" ref=${outer} tabindex="0" role="application" aria-label="Network map. Arrow keys move the map, plus and minus zoom, 0 fits. Select people with the search box; their ties are listed beside the map." onKeyDown=${onKey}>
    <div class="net__canvas" ref=${box}></div>
    <div class="net__zoom">
      <button type="button" class="btn" aria-label="Zoom in" onClick=${() => sig.current?.getCamera().animatedZoom({ duration: dur(200) })}>+</button>
      <button type="button" class="btn" aria-label="Zoom out" onClick=${() => sig.current?.getCamera().animatedUnzoom({ duration: dur(200) })}>−</button>
      <button type="button" class="btn" aria-label="Fit the whole network" onClick=${() => sig.current?.getCamera().animatedReset({ duration: dur(300) })} style="font-size:.7rem">Fit</button>
    </div>
  </div>`;
}

// The camera that frames a person and their neighbors: centered on the
// neighborhood's box, zoomed until the box and a margin fill the canvas and
// no further. The box is measured at ratio 1 around that center (sigma's
// viewport scales as 1 / ratio); a person with no neighbors, or neighbors
// sitting on top of them, stops at FOCUS_MIN_RATIO rather than zooming
// into empty space.
const FOCUS_MIN_RATIO = 0.25;
const FOCUS_MARGIN = 48; // px on each side, room for the neighbors' discs and names
function focusFrame(renderer, g, node) {
  const pts = [];
  const add = k => { const d = renderer.getNodeDisplayData(k); if (d && !d.hidden) pts.push(d); };
  add(node);
  if (!pts.length) return null;
  g.forEachNeighbor(node, add);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const d of pts) { if (d.x < x0) x0 = d.x; if (d.x > x1) x1 = d.x; if (d.y < y0) y0 = d.y; if (d.y > y1) y1 = d.y; }
  const x = (x0 + x1) / 2, y = (y0 + y1) / 2;
  const cameraState = { x, y, ratio: 1, angle: 0 };
  const a = renderer.framedGraphToViewport({ x: x0, y: y0 }, { cameraState });
  const b = renderer.framedGraphToViewport({ x: x1, y: y1 }, { cameraState });
  const { width: W, height: H } = renderer.getDimensions();
  const fit = Math.max(Math.abs(b.x - a.x) / Math.max(1, W - 2 * FOCUS_MARGIN), Math.abs(b.y - a.y) / Math.max(1, H - 2 * FOCUS_MARGIN));
  return { x, y, ratio: Math.max(FOCUS_MIN_RATIO, fit) };
}

// Where each group sits on the map (lib/labels.js groupAnchors), for the
// community numbers and the group names. Read lazily so a new coloring needs
// no graph rebuild.
function groupCentres(g, state) {
  let cacheFor = null, cache = null;
  return () => {
    const c = state.current.coloring;
    if (!c?.gc) return null;
    if (cacheFor === c) return cache;
    const n = g.order;
    const x = new Float64Array(n), y = new Float64Array(n);
    g.forEachNode((key, a) => { x[+key] = a.x; y[+key] = a.y; });
    cache = groupAnchors(x, y, v => c.key(v));
    cacheFor = c;
    return cache;
  };
}

// Label placement over the current frame. Candidates in priority order:
// selected people, the hovered person, their neighbors, then everyone by
// size. Each label goes right of its node, or left near the right edge, and
// is skipped if it would overlap a label or badge already placed or leave
// the canvas. Small networks label everyone who fits.
//
// Group names and community numbers are the non-color cue for groups. On a
// large map they go where most of each group sits (on each part of a group
// split across the map), before the people. On a small or hand-drawn map
// (L5) people's names come first and the group cue goes on the edge of the
// group (lib/labels.js hullEdgeSpots), so it never covers a person.
function drawLabels(renderer, g, data, s, focus, hovered, centres, placed, small, nameAll = false) {
  const ctx = renderer.canvasContexts?.f2labels;
  if (!ctx) return;
  const { width: W, height: H } = renderer.getDimensions();
  // Sigma does not resize layers added after it starts; keep ours in step.
  const pr = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1;
  const cv = ctx.canvas;
  if (cv.width !== Math.round(W * pr) || cv.height !== Math.round(H * pr)) {
    cv.width = Math.round(W * pr); cv.height = Math.round(H * pr);
    cv.style.width = `${W}px`; cv.style.height = `${H}px`;
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  ctx.setTransform(pr, 0, 0, pr, 0, 0);
  const t = tokens();
  const rects = [];
  placed.labels = []; placed.badges = []; placed.groups = [];
  const ratio = renderer.getCamera().getState().ratio;
  const gc = s.coloring?.gc;
  const shownKey = k => s.focusCat == null || gc.matches(k, s.focusCat);
  const inside = b => b.x >= 2 && b.y >= 2 && b.x + b.w <= W - 2 && b.y + b.h <= H - 2;
  const fits = b => inside(b) && !overlaps(b, rects);

  // Every drawn person's disc, so no label is placed over one.
  const discs = [];
  const members = new Map();
  g.forEachNode((key) => {
    const d = renderer.getNodeDisplayData(key);
    if (!d || d.hidden) return;
    const p = renderer.framedGraphToViewport({ x: d.x, y: d.y });
    const r = renderer.scaleSize(d.size);
    if (small) discs.push({ x: p.x - r, y: p.y - r, w: 2 * r, h: 2 * r });
    if (small && gc && s.coloring.key) {
      const k = s.coloring.key(+key);
      if (k != null && k !== '') { if (!members.has(k)) members.set(k, []); members.get(k).push({ x: p.x, y: p.y, r }); }
    }
  });
  rects.push(...discs);

  const drawBadge = (box, text, color) => {
    const cx = box.x + box.w / 2, cy = box.y + box.h / 2, rad = box.w / 2;
    ctx.font = `600 11px ${LABEL_FONT}`;
    ctx.beginPath(); ctx.arc(cx, cy, rad, 0, Math.PI * 2);
    ctx.fillStyle = t.bgDeep; ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = color; ctx.stroke();
    ctx.fillStyle = t.text; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(text, cx, cy + 0.5);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    rects.push(box);
    placed.badges.push({ x: cx, y: cy, r: rad, text, color });
  };
  const drawGroupName = (box, label, color) => {
    const y = box.y + box.h / 2;
    ctx.font = `600 13px ${LABEL_FONT}`;
    ctx.lineJoin = 'round';
    ctx.beginPath(); ctx.arc(box.x + 4, y, 4.5, 0, Math.PI * 2);
    ctx.fillStyle = color; ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = t.bgDeep; ctx.stroke();
    ctx.lineWidth = 4; ctx.strokeStyle = t.bgDeep;
    ctx.strokeText(label, box.x + 12, y + 4);
    ctx.fillStyle = t.text;
    ctx.fillText(label, box.x + 12, y + 4);
    rects.push(box);
    placed.groups.push({ x: box.x, y, text: label, color });
  };

  const placeGroups = () => {
    const cs = centres();
    // Kinds of node (two-mode) are told apart by shape and the legend; a
    // name in the middle of each column would only cover nodes.
    if (!cs || focus.set || s.coloring?.mode) return;
    if (s.coloring.community) {
      for (const c of cs) {
        if ((c.n < 3 && !small) || !shownKey(c.key) || (small && c.part)) continue;
        const text = String(Number(c.key) + 1);
        const color = gc.many && s.focusCat != null ? t.accent : gc.color(c.key);
        const rad = 9;
        let box;
        if (small) box = hullEdgeSpots(members.get(c.key) || [], rad * 2, rad * 2).find(fits);
        else {
          const p = renderer.graphToViewport({ x: c.x, y: c.y });
          box = { x: p.x - rad, y: p.y - rad, w: rad * 2, h: rad * 2 };
          if (!fits(box)) box = null;
        }
        if (box) drawBadge(box, text, color);
      }
      return;
    }
    // Attribute groups above the size threshold are named (a dot in the
    // group's color, the name in ink with a halo), largest first, skipping
    // any name that would collide or leave the map. A group in two or more
    // separate clusters is named on each (groupAnchors), except on a small
    // map, where the name goes once on the edge of the whole group.
    const min = small ? 1 : groupLabelMin(g.order);
    const byKey = new Map(gc.entries.map(e => [e.value, e]));
    ctx.font = `600 13px ${LABEL_FONT}`;
    for (const c of cs) {
      const e = byKey.get(c.key);
      if (!e || !shownKey(c.key) || (c.n < min && s.focusCat == null) || (small && c.part)) continue;
      const w = ctx.measureText(e.label).width + 12, h = 17;
      let box;
      if (small) box = hullEdgeSpots(members.get(c.key) || [], w, h).find(fits);
      else {
        const p = renderer.graphToViewport({ x: c.x, y: c.y });
        box = { x: p.x - w / 2, y: p.y - h / 2, w, h };
        if (!fits(box)) box = null;
      }
      if (box) drawGroupName(box, e.label, s.focusCat != null && gc.many ? t.accent : e.color);
      ctx.font = `600 13px ${LABEL_FONT}`;
    }
  };

  const placePeople = () => {
    const n = g.order;
    const cand = [];
    g.forEachNode((key, attr) => {
      const d = renderer.getNodeDisplayData(key);
      if (!d || d.hidden || d.dimmed || !attr.label) return;
      const p = renderer.framedGraphToViewport({ x: d.x, y: d.y });
      if (p.x < -10 || p.y < -10 || p.x > W + 10 || p.y > H + 10) return;
      const v = +key;
      const forced = d.forceLabel || (focus.core && focus.core.has(v));
      const pri = forced ? 0 : key === hovered ? 1 : focus.set?.has(v) ? 2 : 3;
      cand.push({ key, label: attr.label, x: p.x, y: p.y, r: renderer.scaleSize(d.size), pri, size: d.size });
    });
    cand.sort((a, b) => a.pri - b.pri || b.size - a.size || a.key - b.key);
    const budget = nameAll ? Infinity : labelBudget({ n, width: W, ratio, focus: !!focus.set });
    ctx.lineJoin = 'round';
    let count = 0;
    for (const c of cand) {
      if (count >= budget && c.pri > 1) break;
      const strong = c.pri === 0;
      ctx.font = `${strong ? 600 : 500} 12px ${LABEL_FONT}`;
      const w = ctx.measureText(c.label).width, h = 14;
      const y = c.y - h / 2;
      // A person's own disc is not an obstacle to their own label.
      const own = { x: c.x - c.r, y: c.y - c.r, w: 2 * c.r, h: 2 * c.r };
      const others = small ? rects.filter(b => !(b.x === own.x && b.y === own.y && b.w === own.w)) : rects;
      let box = { x: c.x + c.r + 4, y, w, h };
      if (box.x + w > W - 4 || overlaps(box, others)) {
        const left = { x: c.x - c.r - 4 - w, y, w, h };
        const above = { x: c.x - w / 2, y: c.y - c.r - 3 - h, w, h };
        const below = { x: c.x - w / 2, y: c.y + c.r + 3, w, h };
        const alt = [left, ...(small ? [above, below] : [])].find(b => b.x >= 4 && b.x + w <= W - 4 && b.y >= 2 && b.y + h <= H - 2 && !overlaps(b, others));
        if (alt) box = alt;
        else if (strong || small) box = { x: Math.max(4, Math.min(box.x, W - 4 - w)), y, w, h };
        else continue;
      }
      if (box.y < 2 || box.y + h > H - 2) { if (!strong && !small) continue; box.y = Math.max(2, Math.min(box.y, H - h - 2)); }
      // Halo in the canvas ground, then the text.
      ctx.lineWidth = 4; ctx.strokeStyle = t.bgDeep;
      ctx.strokeText(c.label, box.x, box.y + 11);
      ctx.fillStyle = strong ? t.text : t.text2;
      ctx.fillText(c.label, box.x, box.y + 11);
      rects.push(box);
      placed.labels.push({ x: box.x, y: box.y + 11, text: c.label, strong });
      count++;
    }
  };

  if (small) { placePeople(); placeGroups(); } else { placeGroups(); placePeople(); }
}

// ---- side panel -----------------------------------------------------------------

// Legend rows are buttons: hover or keyboard focus previews a group, click or
// Enter pins it (again to unpin), arrow keys move between rows. In highlight
// mode every group is listed (the list scrolls) under the eight colored ones
// and the "Other groups" row; "Not recorded" always has its own row.
const LEGEND_MAX = 200;

function Legend({ coloring, pinCat, setPinCat, setHoverCat, sizeBy, directed, small = false }) {
  if (!coloring) return null;
  const gc = coloring.gc;
  const row = (value, color, label, count, { sub = false, missing = false, title, square = false } = {}) => html`<button type="button" class=${`legend__item${sub ? ' legend__item--sub' : ''}`} aria-pressed=${String(pinCat === value)} title=${title}
      onClick=${() => setPinCat(pinCat === value ? null : value)} onMouseEnter=${() => setHoverCat(value)} onMouseLeave=${() => setHoverCat(null)}
      onFocus=${() => setHoverCat(value)} onBlur=${() => setHoverCat(null)}>
    <span class=${`swatch${missing ? ' swatch--missing' : ''}${square ? ' swatch--sq' : ''}`} style=${`background:${color}`} aria-hidden="true"></span><span class="grow">${label}</span><span class="legend__count">${fmtInt(count)}</span></button>`;
  const onKey = (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...e.currentTarget.querySelectorAll('.legend__item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    items[Math.max(0, Math.min(items.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))].focus();
  };
  const listed = gc ? gc.others.slice(0, LEGEND_MAX) : [];
  const unlisted = gc ? gc.others.slice(LEGEND_MAX) : [];
  return html`<div>
    ${coloring.kind === 'cat' && html`<h2 class="label">Color: ${coloring.title}</h2>
      ${gc.many && html`<p class="small text2 net-legend__lead">${fmtInt(gc.entries.length)} groups: the eight largest in color, the rest gray. Choose any group to light it up.</p>`}
      <div class=${`legend${gc.many ? ' legend--scroll' : ''}`} onKeyDown=${onKey} role="group" aria-label=${`Groups by ${coloring.title}`}>
        ${gc.colored.map(e => (coloring.mode ? row(e.value, e.color, `${e.label} (${e.value === '1' ? 'squares' : 'circles'})`, e.count, { square: e.value === '1' }) : row(e.value, e.color, e.label, e.count)))}
        ${gc.many && row(OTHER, gc.otherColor, gc.otherLabel, gc.otherPeople, { title: 'All groups after the eight largest; they share gray' })}
        ${listed.map(e => row(e.value, e.color, e.label, e.count, { sub: true }))}
        ${unlisted.length > 0 && html`<p class="legend__more small muted">and ${plural(unlisted.length, coloring.community ? 'smaller community' : 'smaller group', coloring.community ? 'smaller communities' : 'smaller groups')} (${plural(unlisted.reduce((a, e) => a + e.count, 0), 'person', 'people')})</p>`}
        ${gc.missing > 0 && row(MISSING, gc.missingColor, gc.missingLabel, gc.missing, { missing: true, title: `No ${coloring.title.toLowerCase()} in the data` })}
      </div>
      <p class="basis">${coloring.mode ? `Two kinds of node: ${coloring.labels[0].toLowerCase()} (circles) and ${coloring.labels[1].toLowerCase()} (squares). Every tie joins one of each; none joins two of the same kind. Hover or select a kind to pick it out.` : small
        ? `Everyone is named on the map; ${coloring.community ? 'community numbers' : 'group names'} sit at the edge of each group.${gc.many ? '' : ' Hover or select a group to pick it out.'}`
        : coloring.community
        ? `Numbers on the map mark each community of three or more people.${gc.many ? ' Communities after the eighth share gray; choose one to light it up.' : ' Hover or select a community to pick it out.'}`
        : `Groups of 1% of the people or more are named on the map where most of their members sit.${gc.many ? '' : ' Hover or select a group to pick it out.'}`}${gc.missing > 0 && !coloring.community ? ` Not recorded: people with no ${coloring.title.toLowerCase()} in the data, not a group.` : ''}${coloring.community && gc.alignedTo ? ` Each community takes the color of the ${gc.alignedLabel} most of its members share, the color that ${gc.alignedLabel} has when the map is colored by ${gc.alignedLabel}; the others take colors no ${gc.alignedLabel} uses.` : ''} Colors stay fixed while you filter and are the same in every view.</p>`}
    ${coloring.kind === 'seq' && html`<${RampLegend} scale=${coloring.scale} label=${`Color: ${coloring.title}`} />`}
    ${sizeBy !== 'none' && html`<h2 class="label" style="margin-top:1rem">Size: ${metricLabel(sizeBy, directed)}</h2><p class="basis" style="margin-top:0">Area grows with the value (square-root scale).</p>`}
  </div>`;
}

const SUMMARY_KEYS = ['density', 'reciprocity', 'transitivity', 'avgClustering', 'components', 'largestComponentShare', 'avgPathLength', 'degreeCentralization', 'strengthGini'];
const NULL_STATS = ['reciprocity', 'transitivity', 'avgClustering', 'modularity'];
// The verdict sentence per statistic: subject, and the words for more / less.
const NULL_WORDS = {
  transitivity: ['Friends of friends are tied', 'more often', 'less often', 'about as often as chance gives'],
  avgClustering: ['People\'s contacts know each other', 'more often', 'less often', 'about as often as chance gives'],
  reciprocity: ['Ties are returned', 'more often', 'less often', 'about as often as chance gives'],
  modularity: ['The network splits into communities', 'more cleanly', 'less cleanly', 'about as cleanly as chance gives'],
};

// One comparison with random networks, verdict first (decision 5): the plain
// sentence, the number in plain words, then the details.
// shown: the value displayed above the verdict. The modularity test scores
// the best unweighted split (it re-runs the search on each random network,
// which keeps no weights), so when that differs from the weighted modularity
// shown, one line says why there are two numbers (as Groups does).
function NullVerdict({ stat, x, reps, shown = null }) {
  const [subject, more, less, same] = NULL_WORDS[stat] || ['This value is', 'higher', 'lower', 'about what chance gives'];
  const flat = !(x.sd > 0);
  const near = flat ? x.observed === x.mean : !(x.p < 0.05) || !(Math.abs(x.z) >= 2);
  const verdict = `${subject} ${near ? same : chanceWords(x.z, { more, less })}.`;
  const twoQ = stat === 'modularity' && Number.isFinite(shown) && fmtNum(shown) !== fmtNum(x.observed);
  const plain = `${twoQ ? `On the ties alone, ignoring weights, the best split found scores ${fmtNum(x.observed)} (the ${fmtNum(shown)} above counts tie weights; random networks have none, so the test compares unweighted splits)` : `Observed ${fmtNum(x.observed)}`}; random networks in which every person keeps their number of ties average ${fmtNum(x.mean)}${Number.isFinite(x.lo) && Number.isFinite(x.hi) ? ` (95% of them between ${fmtNum(x.lo)} and ${fmtNum(x.hi)})` : ''}.`;
  const details = `${nullInWords(x.p, reps)}${Number.isFinite(x.z) ? `; z ${fmtNum(x.z, { digits: 2 })}` : ''}.${stat === 'modularity' ? ' Communities are found again in each random network.' : ''}`;
  return html`<${Verdict} className="net-verdict" verdict=${verdict} plain=${plain} details=${details} />`;
}

function NetworkSummary({ open = null }) {
  const m = useStore(s => s.metrics?.network);
  const net = useStore(s => s.network);
  const communities = useStore(s => s.communities);
  const ap = useStore(s => s.applicability) || {};
  const [nm, setNm] = useState(null);
  const [busy, setBusy] = useState(false);
  if (!m) return null;
  const twoModeView = isTwoModeView(net);
  const apKey = k => (k === 'reciprocity' ? 'reciprocityNetwork' : k);
  // On a two-mode network the one-mode measures that cannot apply (density,
  // clustering, centralization) are replaced by their two-mode versions.
  const keys = SUMMARY_KEYS.filter(k => Number.isFinite(m[k]) && !(twoModeView && ap[apKey(k)]?.level === 'na'));
  const nullNa = ap.nullModel?.level === 'na';
  // One run per network, shared with Groups and the reports: the engine
  // caches each statistic's random networks (analysis NULL_REPS).
  const runNull = async () => {
    setBusy(true);
    try {
      const r = await store.actions.runJob('Comparing with random networks', (signal, progress) => engine.nullModel({ stats: NULL_STATS, seed: 1, membership: communities?.membership, signal, onProgress: progress }));
      setNm(r);
    } catch (e) { if (e.name !== 'AbortError') store.actions.notify('error', e.message); } finally { setBusy(false); }
  };
  const reps = nm?.meta?.reps;
  const tiny = communities && net && net.n <= 15 && communities.count > 1;
  const tr = nm?.transitivity;
  // Closed under a selection (N22: the whole-network numbers stay one click
  // away instead of disappearing).
  return html`<details class="net-summary" open=${open ?? !narrow()}>
    <summary><h2 class="label" style="display:inline;margin:0">Whole network</h2></summary>
    ${twoModeView && html`<${TwoModeSummary} m=${m} net=${net} communities=${communities} />`}
    ${communities && html`<div class="metric-row"><span><${MetricName} metric="modularity" gloss=${true} /></span><span class="metric-row__val">${fmtNum(communities.modularity)}</span>
      <span class="metric-row__sub">${communityWords(communities)}.
        ${tiny && html`<br />With only ${fmtInt(net.n)} people, community detection still partitions the network, whether or not it has groups. These communities are provisional until modularity exceeds the random-network comparison.`}</span>
      ${nm?.modularity && html`<${NullVerdict} stat="modularity" x=${nm.modularity} reps=${reps} shown=${communities.modularity} />`}</div>`}
    ${keys.map(k => html`<div class="metric-row"><span><${MetricName} metric=${k === 'reciprocity' ? 'reciprocityNetwork' : k} gloss=${true} /></span><span class="metric-row__val">${k === 'largestComponentShare' ? `${Math.round(m[k] * 100)}%` : fmtNum(m[k])}</span>
      ${nm?.[k] && html`<${NullVerdict} stat=${k} x=${nm[k]} reps=${reps} />`}</div>`)}
    ${nullNa ? html`<p class="basis" style="margin-top:.8rem">No comparison with random networks here: ${(ap.nullModel.reason || '').replace(/^./, c => c.toLowerCase())}</p>`
      : !nm ? html`<div style="margin-top:.8rem"><button type="button" class="tlink" onClick=${runNull} disabled=${busy}>${busy ? 'Comparing' : 'Compare with random networks'}</button>
      <p class="basis">Clustering, reciprocity, and modularity are interpreted relative to random networks in which every person keeps their number of ties.</p></div>`
      : html`<p class="basis">Random networks: ${nm.meta?.model || 'degree-preserving rewiring'}, ${fmtInt(reps)} networks, seed ${nm.meta?.seed ?? 1}; two-sided empirical p. The same run is quoted in Groups and the reports.</p>`}
    <${HowToRead}
      means="Each comparison preserves every person’s number of ties while rewiring the endpoints. The resulting distribution shows what the network measures would look like under that constraint."
      scale="Interpret the observed value relative to the simulated distribution. The distance from the random-network mean describes the size of the departure. The empirical p value describes how unusual that departure is under the null model."
      example=${tr ? `Observed transitivity is ${fmtNum(tr.observed)}; the random-network mean is ${fmtNum(tr.mean)}${Number.isFinite(tr.lo) && Number.isFinite(tr.hi) ? `, and the observed value lies ${tr.observed > tr.hi ? 'above' : tr.observed < tr.lo ? 'below' : 'within'} the central 95% of the simulated values (${fmtNum(tr.lo)} to ${fmtNum(tr.hi)})` : ''}.`
        : m.transitivity != null ? `Observed transitivity is ${fmtNum(m.transitivity)}. The comparison with random networks places it relative to the simulated distribution.` : null}
      mistake="Measures such as clustering and modularity can take positive values in randomized networks. Their magnitude is interpretable relative to the relevant comparison distribution." />
  </details>`;
}

// Whole-network two-mode measures: how many of each kind, two-mode density,
// bipartite clustering, and Barber's modularity of the communities.
function TwoModeSummary({ m, net, communities }) {
  const [a, b] = net.twoMode.labels;
  const counts = m.modeCounts || net.twoMode.counts;
  return html`<div class="twomode-summary">
    <div class="metric-row"><span><${Term} k="twoMode">Two-mode network</${Term}></span><span class="metric-row__val">${fmtInt(counts[0])} + ${fmtInt(counts[1])}</span>
      <span class="metric-row__sub">${fmtInt(counts[0])} ${a.toLowerCase()} and ${fmtInt(counts[1])} ${b.toLowerCase()}; ties run only between the two kinds.</span></div>
    ${Number.isFinite(m.twoModeDensity) && html`<div class="metric-row"><span><${MetricName} metric="twoModeDensity" gloss=${true} /></span><span class="metric-row__val">${fmtNum(m.twoModeDensity)}</span>
      <span class="metric-row__sub">${fmtInt(net.edgeCount)} of the ${fmtInt(counts[0] * counts[1])} possible ${a.toLowerCase()}-${b.toLowerCase()} ties.</span></div>`}
    ${Number.isFinite(m.robinsAlexander) && html`<div class="metric-row"><span><${MetricName} metric="robinsAlexander" gloss=${true} /></span><span class="metric-row__val">${fmtNum(m.robinsAlexander)}</span></div>`}
    ${Number.isFinite(m.twoModeAvgClustering) && html`<div class="metric-row"><span><${MetricName} metric="twoModeClustering" label="Average two-mode clustering (Latapy)" gloss=${true} /></span><span class="metric-row__val">${fmtNum(m.twoModeAvgClustering)}</span>
      ${Array.isArray(m.twoModeAvgClusteringByMode) && html`<span class="metric-row__sub">${a}: ${fmtNum(m.twoModeAvgClusteringByMode[0])}; ${b.toLowerCase()}: ${fmtNum(m.twoModeAvgClusteringByMode[1])}.</span>`}</div>`}
    ${Number.isFinite(communities?.barberModularity) && html`<div class="metric-row"><span><${MetricName} metric="barberModularity" gloss=${true} /></span><span class="metric-row__val">${fmtNum(communities.barberModularity)}</span>
      <span class="metric-row__sub">Communities are found among the ${a.toLowerCase()} (tied by shared ${b.toLowerCase()}); each of the ${b.toLowerCase()} joins the community most of its ${a.toLowerCase()} are in. Modularity below is that projection's.</span></div>`}
  </div>`;
}

// "Who stands out" (decision 1, L8): the direct answers to "who has the
// most ties, who connects the groups, who is closest to everyone", each with
// its value, the runner-up when it is close, and a link to the full ranking
// in People. People tied at the precision shown are named together.
const STANDOUT_WORDS = {
  contacts: ['Most contacts', 'contacts'],
  betweenness: ['Most often on the route between others', 'betweenness'],
  closeness: ['Closest to everyone', 'closeness'],
};

function Standouts({ ds, net, metrics, applicability, onPick }) {
  const keys = ['contacts', 'betweenness', 'closeness'].filter(k => metrics?.[k] && applicability?.[k]?.level !== 'na');
  const rows = useMemo(() => standouts(metrics, keys), [metrics, keys.join()]);
  if (!rows.length || net.n < 3) return null;
  const who = v => net.nodeIds[v];
  const name = v => html`<button type="button" class="linkish standout__name" onClick=${() => onPick(who(v))}>${nodeLabel(ds, who(v))}</button>`;
  const glue = list => list.map((v, i) => html`${i ? (i === list.length - 1 ? ' and ' : ', ') : ''}${name(v)}`);
  return html`<section class="standout" aria-labelledby="standout-h">
    <h2 class="label" id="standout-h">Who stands out</h2>
    <ul class="standout__list">
      ${rows.map(r => html`<li class="standout__item">
        <span class="standout__q"><${Term} k=${r.key}>${STANDOUT_WORDS[r.key][0]}</${Term}></span>
        <span class="standout__a">${r.allSame ? html`<span class="text2">Everyone has the same value (${r.value})</span>`
          : html`${glue(r.top)}${r.tied > r.top.length ? ` and ${fmtInt(r.tied - r.top.length)} more` : ''} <span class="standout__v">${r.value}${r.tied > 1 ? ' each' : ''}</span>`}</span>
        <span class="standout__sub">${metricLabel(r.key, net.directed)}${r.tied > 1 ? ' · tied at the precision shown' : r.next ? ` · next: ${nodeLabel(ds, who(r.next.v))} ${r.next.value}` : ''}
${' · '}<button type="button" class="tlink tlink--arrow" onClick=${() => { requestPeopleSort(r.key); store.actions.setView('people'); }}>Full ranking</button></span>
      </li>`)}
    </ul>
    ${ds.meta?.example?.lookFor?.length && html`<div class="standout__example">
      <p class="small text2"><strong>${ds.meta.example.title}: what to look for</strong></p>
      <ul class="small text2">${ds.meta.example.lookFor.map(x => html`<li>${x}</li>`)}</ul>
      <${ClassicFacts} example=${ds.meta.example} />
    </div>`}
  </section>`;
}

// Who stands out on a two-mode network: each kind of node ranked among its
// own kind, by the two-mode measures (normalized per mode, Borgatti and
// Everett), so the busiest woman and the best-attended event are both named.
function TwoModeStandouts({ ds, net, metrics, onPick }) {
  const tm = net.twoMode;
  const groups = useMemo(() => perModeStandouts(metrics, tm.mode), [metrics, tm]);
  if (!groups.some(g => g.rows.length)) return null;
  const who = v => net.nodeIds[v];
  const name = v => html`<button type="button" class="linkish standout__name" onClick=${() => onPick(who(v))}>${nodeLabel(ds, who(v))}</button>`;
  const glue = list => list.map((v, i) => html`${i ? (i === list.length - 1 ? ' and ' : ', ') : ''}${name(v)}`);
  return html`<section class="standout standout--twomode" aria-labelledby="standout-h">
    <h2 class="label" id="standout-h">Who stands out, ${tm.labels[0].toLowerCase()} and ${tm.labels[1].toLowerCase()} each among their own kind</h2>
    ${groups.map(g => g.rows.length > 0 && html`<div class="standout__mode">
      <h3 class="standout__modeh">${tm.labels[g.mode]} <span class="meta">${g.mode === 1 ? 'squares' : 'circles'}</span></h3>
      <ul class="standout__list">
        ${g.rows.map(r => html`<li class="standout__item">
          <span class="standout__q"><${Term} k=${r.key}>${standoutWords(r.key, tm.labels, g.mode)}</${Term}></span>
          <span class="standout__a">${r.allSame ? html`<span class="text2">All the same (${r.value})</span>`
            : html`${glue(r.top)}${r.tied > r.top.length ? ` and ${fmtInt(r.tied - r.top.length)} more` : ''} <span class="standout__v">${r.value}${r.tied > 1 ? ' each' : ''}</span>`}</span>
          <span class="standout__sub">${metricLabel(r.key, false)}${r.tied > 1 ? ' · tied at the precision shown' : r.next ? ` · next: ${nodeLabel(ds, who(r.next.v))} ${r.next.value}` : ''}
${' · '}<button type="button" class="tlink tlink--arrow" onClick=${() => { requestPeopleSort(r.key); store.actions.setView('people'); }}>Full ranking</button></span>
        </li>`)}
      </ul>
    </div>`)}
    <p class="basis">Two-mode measures (<${Term} k="borgattiEverett">Borgatti-Everett normalization</${Term}>): each value is a share of what is possible for that kind of node, so read each kind on its own.</p>
    ${ds.meta?.example?.lookFor?.length && html`<div class="standout__example">
      <p class="small text2"><strong>${ds.meta.example.title}: what to look for</strong></p>
      <ul class="small text2">${ds.meta.example.lookFor.map(x => html`<li>${x}</li>`)}</ul>
      <${ClassicFacts} example=${ds.meta.example} />
    </div>`}
  </section>`;
}

// Fragility evidence (J8): how much of the brokerage a few people hold, and
// what the network looks like without them.
const FRAGILITY_K = [3, 5, 10];

function Fragility({ ds, net, data, metrics, coloring, applicability }) {
  const [k0, setK] = useState(5);
  const [res, setRes] = useState(null);
  const btw = metrics?.betweenness;
  // A top k is a few people only in a network several times larger.
  const choices = FRAGILITY_K.filter(x => x <= net.n / 4);
  if (!btw || applicability?.betweenness?.level === 'na' || !choices.length) return null;
  const k = choices.includes(k0) ? k0 : choices[choices.length - 1];
  const share = topShare(btw, k);
  const run = () => {
    const inv = new Map();
    for (let v = 0; v < data.netIndex.length; v++) inv.set(data.netIndex[v], v);
    const removed = share.people.map(v => inv.get(v)).filter(v => v != null);
    const groupOf = coloring?.kind === 'cat' && coloring.key ? coloring.key : null;
    setRes({ k, people: share.people, groupTitle: groupOf ? coloring.short : null, ...whatIf(data.x.length, data.src, data.dst, removed, { groupOf }) });
  };
  const truncated = data?.truncated && (data.truncated.nodes || data.truncated.edges);
  const names = list => list.map(v => nodeLabel(ds, net.nodeIds[v])).join(', ');
  const row = (label, a, b, f) => html`<tr><th scope="row">${label}</th><td>${f(a)}</td><td>${f(b)}</td></tr>`;
  const pct = x => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '–');
  const words = concentrationWords(share);
  return html`<div class="net-frag">
    <h2 class="label">Dependence on highly central people</h2>
    <div class="row" style="gap:.4rem 1rem;align-items:flex-end">
      <${Select} label="Top" value=${String(k)} onChange=${v => { setK(Number(v)); setRes(null); }} options=${choices.map(x => ({ value: String(x), label: `${x} by betweenness` }))} />
    </div>
    <${Verdict} verdict=${`The top ${share.k} people hold ${pct(share.share)} of all betweenness, ${words.text}.`}
      plain=${`They are ${names(share.people)}.`}
      details=${`"Account for most of the brokerage" is said only when they hold at least ${pct(DEPENDS_SHARE)} of all betweenness and at least three times an even share; 1.8 times or more reads as concentrated. The share is of summed betweenness, which counts a shortest path through several of these people once for each of them, so it is not the share of paths that pass through them; the what-if below shows what the network loses without them.`} />
    ${truncated ? html`<p class="basis">The map is simplified for this network, so the what-if is not available.</p>`
      : html`<button type="button" class="tlink" onClick=${run}>What if these ${share.k} people left?</button>`}
    ${res && res.k === k && html`<table class="net-frag__table">
      <caption class="small text2">Without ${names(res.people)} and their ties</caption>
      <thead><tr><th scope="col"></th><th scope="col">Now</th><th scope="col">Without them</th></tr></thead>
      <tbody>
        ${row('Ties', res.before.ties, res.after.ties, fmtInt)}
        ${res.groupTitle && row(`Ties across ${res.groupTitle} groups`, res.before.cross, res.after.cross, fmtInt)}
        ${row('Separate pieces', res.before.pieces, res.after.pieces, fmtInt)}
        ${row('People in the largest piece', res.before.largestShare, res.after.largestShare, pct)}
        ${row('Average steps between people', res.before.avgSteps, res.after.avgSteps, x => fmtNum(x))}
      </tbody>
    </table>
    <p class="basis">Direction ignored; steps averaged over the pairs of people who remain connected${res.after.sampled ? ' (sampled)' : ''}. Removal is a static sensitivity analysis of this network, not a forecast.</p>`}
    <${HowToRead}
      means="Betweenness identifies people who frequently lie on shortest paths between others. Removing highly ranked people provides a sensitivity analysis of the observed network."
      scale="Changes in cross-group ties, component size, and path length show how strongly observed connectivity depends on those people."
      example=${res ? `Without these ${fmtInt(res.k)} people, ${res.groupTitle ? `ties across ${res.groupTitle} groups change from ${fmtInt(res.before.cross)} to ${fmtInt(res.after.cross)}, ` : ''}the largest component changes from ${pct(res.before.largestShare)} to ${pct(res.after.largestShare)} of people, and the average path length changes from ${fmtNum(res.before.avgSteps)} to ${fmtNum(res.after.avgSteps)} steps.` : null}
      mistake="This is a static sensitivity analysis. An actual departure can be followed by new ties, role substitution, or other organizational change." />
  </div>`;
}

const PANEL_METRICS = ['contacts', 'degree', 'strength', 'betweenness', 'closeness', 'pagerank', 'clustering', 'constraint'];

function SelectionPanel({ ds, selection, data, metrics, onEdge }) {
  const net = useStore(s => s.network);
  const communities = useStore(s => s.communities);
  const ap = useStore(s => s.applicability);
  const [allTies, setAllTies] = useState(false);
  const i = selection[selection.length - 1];
  const v = net.nodeIds ? Array.prototype.indexOf.call(net.nodeIds, i) : -1;
  const panelKeys = isTwoModeView(net) ? [...TWO_MODE_KEYS, ...PANEL_METRICS] : PANEL_METRICS;
  const show = panelKeys.filter(k => metrics?.[k] && ap?.[k]?.level !== 'na' && !(k === 'degree' && !net.directed));
  const kind = v >= 0 ? modeLabelOf(net, v) : null;
  const ties = useMemo(() => tiesOf(data, i, net.directed), [data, i]);
  const shownTies = allTies ? ties : ties.slice(0, 8);
  const sc = communities ? communityScale(communities) : null;
  const key = displayKey(ds.nodes.keys[i]);
  const attrs = Object.entries(ds.nodes.attrs[i]).filter(([k]) => k !== 'deactivated' && k !== 'bipartite');
  const dep = departures(ds).get(i);
  return html`<div>
    <div class="row row--between" style="gap:.3rem 1rem">
      <h2 class="label" style="margin:0">${selection.length > 1 ? `${selection.length} selected` : 'Selected'}</h2>
      <button type="button" class="tlink tlink--quiet" onClick=${() => store.actions.select([])}>Back to the whole network</button>
    </div>
    <p class="net-sel__name">${nodeLabel(ds, i)}</p>
    <p class="meta" style="margin:.2rem 0 .6rem">${key || ''}${ds.nodes.isBot[i] ? `${key ? ' · ' : ''}bot` : ''}${isDeactivated(ds, i) ? html` <${Flag} level="caution">Deactivated account</${Flag}>` : ''}</p>
    ${dep && dep.kind === 'silent' && html`<p class="small"><${Flag} level="caution">Left?</${Flag}> <span class="text2">No activity after ${fmtDateTime(dep.last).split(',')[0]} (the last ${fmtInt(dep.quietDays)} days of the data). Whole-period measures mix the time before and after.</span></p>`}
    ${v < 0 ? html`<p class="small text2">Not in the current network (filtered out or without ties).</p>` : html`
      ${kind && html`<div class="metric-row"><span>Kind</span><span class="metric-row__val">${kind}</span></div>`}
      ${communities && html`<div class="metric-row"><span>Community</span><span class="metric-row__val">${communityNumber(communities, v) == null ? html`<span class="text2">None (no ties)</span>` : html`<${Swatch} color=${sc.color(String(communities.membership[v]))} /> ${communityNumber(communities, v)}`}</span></div>`}
      ${show.map(k => html`<div class="metric-row"><span><${MetricName} metric=${k} label=${metricLabel(k, net.directed)} note=${measureNote(k, { n: net.n, directed: net.directed, twoMode: net.twoMode })} gloss=${true} /></span><span class="metric-row__val">${measureFormat(k, metrics[k])(metrics[k][v])}</span></div>`)}
    `}
    ${v >= 0 && html`<h3 class="label" style="margin-top:1.1rem">Ties (${fmtInt(ties.length)})</h3>
      ${ties.length ? html`<ul class="net-ties">
        ${shownTies.map(tie => html`<li><button type="button" class="linkish net-ties__btn" onClick=${() => onEdge({ a: i, b: tie.other })} aria-label=${`Evidence for the tie with ${nodeLabel(ds, tie.other)}`}>
          <span class="grow">${nodeLabel(ds, tie.other)}</span><span class="tnum">${fmtNum(tie.w)}</span></button>
          <span class="metric-row__sub">${tie.dir}${tie.rules.length ? ` · ${tie.rules.map(r => (RULE_LABEL[r] || r).toLowerCase()).join(', ')}` : ''}</span></li>`)}
      </ul>
      ${ties.length > 8 && html`<button type="button" class="tlink" onClick=${() => setAllTies(x => !x)}>${allTies ? 'Show the strongest 8' : `Show all ${fmtInt(ties.length)} ties`}</button>`}
      <p class="basis">Weight under the current construction rules. Select a tie to see the events behind it.${data?.truncated?.edges ? ' The weakest ties are not drawn and not listed.' : ''}</p>`
      : html`<p class="small text2">No ties drawn.</p>`}`}
    ${attrs.length > 0 && html`<dl class="kv" style="margin-top:.8rem">${attrs.slice(0, 8).map(([k, x]) => html`<dt>${humanize(k)}</dt><dd>${fmtAttr(k, x)}</dd>`)}</dl>`}
    <div class="tlinks" style="margin-top:.9rem">
      <button type="button" class="btn btn--sm btn--primary" onClick=${() => { store.set({ ui: { ...store.get().ui, profile: i } }); store.actions.setView('people'); }}>Full profile</button>
      <button type="button" class="tlink tlink--quiet" onClick=${() => store.actions.select([])}>Clear selection</button>
    </div>
  </div>`;
}

const EVIDENCE_PAGE = 60;

// Tie fields recorded with an event (survey answers such as type of tie or
// strength), labeled from the dataset's tie-field schema: "Type of tie: Advice; Strength: 4".
function tieFields(ds, attrs) {
  if (!attrs) return '';
  const schema = new Map((ds.eventAttributeSchema || []).map(f => [f.key, f.label || f.key]));
  return Object.entries(attrs).filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => `${schema.get(k) || k}: ${v}`).join('; ');
}

export function Evidence({ ds, a, b, onClose }) {
  const [limit, setLimit] = useState(EVIDENCE_PAGE);
  // Ask for one more than shown, to know whether there is more.
  const q = useEngine('evidence', () => engine.edgeEvidence(a, b, { limit: limit + 1, bothDirections: true }), [a, b, limit]);
  const head = useRef(null);
  useEffect(() => { head.current?.focus({ preventScroll: true }); }, [a, b]);
  const events = q.data ? q.data.events.slice(0, limit) : [];
  const more = q.data ? q.data.events.length > limit : false;
  const exportCSV = async () => {
    try {
      const all = await engine.edgeEvidence(a, b, { limit: 1e7, bothDirections: true });
      const esc = x => { const s = x == null ? '' : String(x); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = ['time_utc,actor,rule,type,context,visibility,weight,tie_fields,text'];
      for (const e of all.events) lines.push([Number.isFinite(e.t) ? new Date(e.t).toISOString() : '', e.actorLabel || nodeLabel(ds, e.actor), e.rule, e.type, e.context, e.visibility, e.amount, tieFields(ds, e.attrs) || '', e.text].map(esc).join(','));
      download(lines.join('\n'), 'tie-evidence.csv', 'text/csv');
    } catch (e) { store.actions.notify('error', e.message); }
  };
  const parentText = (e) => {
    const p = ds.events.parent?.[e.event];
    if (!(p >= 0) || !['reaction', 'like', 'repost'].includes(e.type)) return null;
    const tx = ds.events.text?.[p];
    return tx ? (tx.length > 160 ? `${tx.slice(0, 157)}...` : tx) : null;
  };
  return html`<div>
    <div class="row row--between"><h2 class="label" style="margin:0" tabindex="-1" ref=${head}>Evidence for this tie</h2><button type="button" class="btn btn--quiet btn--sm" onClick=${onClose} aria-label="Close evidence">${Icon.close}</button></div>
    <p class="net-sel__name" style="margin-top:.3rem">${nodeLabel(ds, a)} <span class="muted" style="font-weight:400">and</span> ${nodeLabel(ds, b)}</p>
    ${q.loading && html`<${Loading}>Finding the events</${Loading}>`}
    <${ErrorLine} error=${q.error} />
    ${q.data && html`<p class="small text2" style="margin:.4rem 0 .6rem">${more ? `The first ${fmtInt(events.length)} pieces of evidence` : events.length === 1 ? 'One piece of evidence' : `${fmtInt(events.length)} pieces of evidence`} under the current construction rules, oldest first.</p>
      <ol class="net-evidence">
        ${events.map(e => { const pt = parentText(e); return html`<li>
          <div class="row row--between" style="gap:.2rem .6rem"><span style="color:var(--text)">${e.actorLabel || nodeLabel(ds, e.actor)} <span class="muted">· ${RULE_LABEL[e.rule] || e.rule}</span></span><span class="meta">${fmtDateTime(e.t)}</span></div>
          ${e.viaLabel && html`<div class="small text2" style="margin-top:.15rem">Shared: ${e.viaLabel}</div>`}
          <div class="meta" style="margin-top:.15rem">${humanize(e.type)}${e.context ? ` in ${e.context}` : ''}${e.visibility && e.visibility !== 'unknown' ? ` · ${(VISIBILITY_LABEL[e.visibility] || e.visibility).toLowerCase()}` : ''}${e.amount != null ? ` · weight ${fmtNum(e.amount)}` : ''}</div>
          ${pt && html`<p class="text2" style="margin-top:.25rem"><span class="muted">On:</span> ${pt}</p>`}
          ${tieFields(ds, e.attrs) && html`<p class="small text2" style="margin-top:.25rem">${tieFields(ds, e.attrs)}</p>`}
          ${e.text && html`<p class="text2" style="margin-top:.25rem">${e.text}</p>`}
        </li>`; })}
      </ol>
      <div class="tlinks" style="margin-top:.6rem">
        ${more && html`<button type="button" class="tlink" onClick=${() => setLimit(1e6)}>Show all</button>`}
        <button type="button" class="tlink tlink--down" onClick=${exportCSV}>Download as CSV</button>
      </div>`}
  </div>`;
}

// ---- export ------------------------------------------------------------------------

function ExportMenu({ sigmaRef, data, coloring, ds }) {
  const svg = () => buildSVG(sigmaRef.current, coloring, ds);
  const doSVG = () => { const s = svg(); if (s) download(s, 'network.svg', 'image/svg+xml'); };
  const doPNG = async () => {
    const s = svg(); if (!s) return;
    const img = new Image();
    const url = URL.createObjectURL(new Blob([s], { type: 'image/svg+xml' }));
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const scale = 2;
    const c = document.createElement('canvas'); c.width = img.width * scale; c.height = img.height * scale;
    const ctx = c.getContext('2d'); ctx.scale(scale, scale); ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    c.toBlob(b => download(b, 'network.png', 'image/png'), 'image/png');
  };
  return html`<span class="net-export"><span class="muted small">Export figure:</span> <button type="button" class="tlink tlink--down" onClick=${doSVG} disabled=${!data}>SVG</button> <button type="button" class="tlink tlink--down" onClick=${doPNG} disabled=${!data}>PNG</button></span>`;
}

// Redraw the current viewport as SVG from node positions, the reducers'
// output and the labels and badges placed on screen.
function buildSVG(ref, coloring, ds) {
  if (!ref?.sigma) return null;
  const r = ref.sigma, g = ref.graph;
  const t = tokens();
  const { width, height } = r.getDimensions();
  const nodes = [];
  const pos = new Map();
  g.forEachNode((key) => {
    const d = r.getNodeDisplayData(key);
    if (!d || d.hidden) return;
    const p = r.framedGraphToViewport({ x: d.x, y: d.y });
    const rad = r.scaleSize(d.size);
    pos.set(key, p);
    if (p.x < -20 || p.y < -20 || p.x > width + 20 || p.y > height + 20) return;
    nodes.push({ key, x: p.x, y: p.y, r: Math.max(1, rad), color: d.color, z: d.zIndex || 0, square: g.getNodeAttribute(key, 'type') === 'square' });
  });
  nodes.sort((a, b) => a.z - b.z);
  const edges = [];
  g.forEachEdge((key, attr, a, b) => {
    const d = r.getEdgeDisplayData(key);
    if (!d || d.hidden) return;
    const pa = pos.get(a), pb = pos.get(b);
    if (!pa || !pb) return;
    edges.push(`<line x1="${pa.x.toFixed(1)}" y1="${pa.y.toFixed(1)}" x2="${pb.x.toFixed(1)}" y2="${pb.y.toFixed(1)}" stroke="${d.color}" stroke-width="${Math.max(0.3, r.scaleSize(d.size) * 0.5).toFixed(2)}"/>`);
  });
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const placed = ref.placed || { labels: [], badges: [] };
  const gc = coloring?.kind === 'cat' ? coloring.gc : null;
  const items = gc ? [...gc.colored.map(e => ({ color: e.color, label: coloring.mode ? `${e.label} (${e.value === '1' ? 'squares' : 'circles'})` : e.label, square: coloring.mode && e.value === '1' })),
    ...(gc.many ? [{ color: gc.otherColor, label: coloring.community ? `${gc.otherLabel}, numbered on the map` : gc.otherLabel }] : []),
    ...(gc.missing > 0 ? [{ color: gc.missingColor, label: `${gc.missingLabel} (${plural(gc.missing, 'person', 'people')})`, missing: true }] : [])] : [];
  const legend = items.map((e, i) => `<g transform="translate(16,${height - 16 - (items.length - i) * 16})">${e.square ? `<rect x="0.5" y="-8.5" width="9" height="9" fill="${e.color}"/>` : `<circle r="5" cx="5" cy="-4" fill="${e.color}"${e.missing ? ` stroke="${t.muted}" stroke-width="1.2"` : ''}/>`}<text x="16" y="0" fill="${t.text2}" font-size="11">${esc(e.label)}</text></g>`).join('');
  const groupNames = (placed.groups || []).map(l => `<circle cx="${(l.x + 4).toFixed(1)}" cy="${l.y.toFixed(1)}" r="4.5" fill="${l.color}" stroke="${t.bgDeep}" stroke-width="1.5"/><text x="${(l.x + 12).toFixed(1)}" y="${(l.y + 4).toFixed(1)}" fill="${t.text}" font-weight="600" stroke="${t.bgDeep}" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${esc(l.text)}</text>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="Geist, system-ui, sans-serif">
<rect width="100%" height="100%" fill="${t.bgDeep}"/>
<g>${edges.join('')}</g>
<g stroke="${t.bgDeep}" stroke-width="1.5">${nodes.map(n => (n.square ? `<rect x="${(n.x - n.r * 0.886 - 0.75).toFixed(1)}" y="${(n.y - n.r * 0.886 - 0.75).toFixed(1)}" width="${(2 * n.r * 0.886 + 1.5).toFixed(2)}" height="${(2 * n.r * 0.886 + 1.5).toFixed(2)}" fill="${n.color}"/>` : `<circle cx="${n.x.toFixed(1)}" cy="${n.y.toFixed(1)}" r="${(n.r + 0.75).toFixed(2)}" fill="${n.color}"/>`)).join('')}</g>
<g font-size="11" font-weight="600">${placed.badges.map(b => `<circle cx="${b.x.toFixed(1)}" cy="${b.y.toFixed(1)}" r="${b.r}" fill="${t.bgDeep}" stroke="${b.color}" stroke-width="2"/><text x="${b.x.toFixed(1)}" y="${(b.y + 4).toFixed(1)}" text-anchor="middle" fill="${t.text}">${esc(b.text)}</text>`).join('')}</g>
<g font-size="13">${groupNames}</g>
<g font-size="12" stroke="${t.bgDeep}" stroke-width="4" stroke-linejoin="round" paint-order="stroke">${placed.labels.map(l => `<text x="${l.x.toFixed(1)}" y="${l.y.toFixed(1)}" fill="${l.strong ? t.text : t.text2}"${l.strong ? ' font-weight="600"' : ''}>${esc(l.text)}</text>`).join('')}</g>
${legend}
<text x="${width - 12}" y="${height - 10}" text-anchor="end" font-size="10" fill="${t.muted}">${esc(ds.meta.name)} · Org Signal</text>
</svg>`;
}
