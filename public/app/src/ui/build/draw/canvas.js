// SVG canvas for the draw editor: rendering plus pointer gestures.
//
// The editor (index.js) owns all state; this component reads it from props
// for rendering and from ctl.get() inside gesture handlers, so a long drag
// never acts on a stale copy. Gestures:
//   select mode  node: select / shift-toggle, drag (with guides and grid);
//                edge: select; background: marquee (shift adds)
//   node mode    background click places a node; nodes still drag
//   edge mode    drag from node to node, or click one node then another
//   pan mode, space+drag, middle button: pan.  Wheel / two-finger pinch: zoom.

import { html, useRef } from '../../../../vendor/preact.js';
import * as d3 from '../../../../vendor/d3.js';
import { snapPoint } from '../../../builders/draw-snap.js';
import { groupColor } from '../shared.js';

export const NODE_R = 10;
const DRAG_START_PX = 3;
const GUIDE_PX = 6;
export const DASHES = ['', '7 4', '2 3', '9 3 2 3', '4 4', '1 4'];

const hullLine = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));

export function screenToWorld(view, sx, sy) {
  return { x: (sx - view.x) / view.k, y: (sy - view.y) / view.k };
}

export function Canvas(props) {
  const { doc, live, sel, focusId, pending, view, settings, guides, marquee, rubber, size, ctl, mode, dashed } = props;
  const svgRef = useRef(null);
  const g = useRef(null);            // current gesture
  const pointers = useRef(new Map()); // for pinch

  const pos = id => live?.get(id) ?? byId.get(id);
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  const selN = new Set(sel.nodes), selE = new Set(sel.edges);
  const groupIndex = new Map(doc.groups.map((gr, i) => [gr.id, i]));

  const local = e => {
    const r = svgRef.current.getBoundingClientRect();
    return { sx: e.clientX - r.left, sy: e.clientY - r.top };
  };

  function onPointerDown(e) {
    const st = ctl.get();
    const { sx, sy } = local(e);
    const w = screenToWorld(st.view, sx, sy);
    svgRef.current.setPointerCapture?.(e.pointerId);
    svgRef.current.focus({ preventScroll: true });
    pointers.current.set(e.pointerId, { sx, sy });
    if (pointers.current.size === 2) {
      // Second finger: switch any gesture to pinch-zoom, dropping uncommitted moves.
      const [a, b] = [...pointers.current.values()];
      g.current = { kind: 'pinch', d0: Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1, mid0: { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 }, view0: st.view };
      ctl.setLive(null); ctl.setGuides([]); ctl.setMarquee(null); ctl.setRubber(null);
      return;
    }
    const nodeEl = e.target.closest?.('[data-node]');
    const edgeEl = e.target.closest?.('[data-edge]');
    const nodeId = nodeEl?.getAttribute('data-node') ?? null;
    if (st.spaceDown || e.button === 1 || st.mode === 'pan') {
      g.current = { kind: 'pan', sx, sy, view0: st.view };
      return;
    }
    if (st.mode === 'edge') {
      if (nodeId) { g.current = { kind: 'rubber', from: nodeId, sx, sy, moved: false }; ctl.setRubber({ from: nodeId, x: w.x, y: w.y }); }
      else { g.current = { kind: 'pan', sx, sy, view0: st.view }; ctl.setPending(null); }
      return;
    }
    if (nodeId) {
      let nodes = st.sel.nodes;
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        nodes = nodes.includes(nodeId) ? nodes.filter(x => x !== nodeId) : [...nodes, nodeId];
        ctl.setSel({ nodes, edges: st.sel.edges });
      } else if (!nodes.includes(nodeId)) {
        nodes = [nodeId];
        ctl.setSel({ nodes, edges: [] });
      }
      ctl.setFocus(nodeId);
      const moving = nodes.includes(nodeId) ? nodes : [nodeId];
      const orig = new Map(moving.map(id => { const n = st.doc.nodes.find(x => x.id === id); return [id, { x: n.x, y: n.y }]; }));
      const movingSet = new Set(moving);
      const others = st.doc.nodes.filter(n => !movingSet.has(n.id)).map(n => ({ x: n.x, y: n.y }));
      g.current = { kind: 'drag', primary: nodeId, orig, others, sx, sy, w0: w, moved: false };
      return;
    }
    if (edgeEl) {
      const id = edgeEl.getAttribute('data-edge');
      const edges = e.shiftKey ? (st.sel.edges.includes(id) ? st.sel.edges.filter(x => x !== id) : [...st.sel.edges, id]) : [id];
      ctl.setSel({ nodes: e.shiftKey ? st.sel.nodes : [], edges });
      g.current = null;
      return;
    }
    if (st.mode === 'node') { g.current = { kind: 'place', sx, sy, w }; return; }
    g.current = { kind: 'marquee', w0: w, add: e.shiftKey, base: e.shiftKey ? st.sel.nodes : [], sx, sy, moved: false };
  }

  function onPointerMove(e) {
    const gs = g.current;
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, local(e));
    if (!gs) return;
    const st = ctl.get();
    const { sx, sy } = local(e);
    const w = screenToWorld(st.view, sx, sy);
    if (gs.kind === 'pinch') {
      const pts = [...pointers.current.values()];
      if (pts.length < 2) return;
      const [a, b] = pts;
      const d = Math.hypot(a.sx - b.sx, a.sy - b.sy) || 1;
      const mid = { sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 };
      const k = clampK(gs.view0.k * (d / gs.d0));
      const wx = (gs.mid0.sx - gs.view0.x) / gs.view0.k, wy = (gs.mid0.sy - gs.view0.y) / gs.view0.k;
      ctl.setView({ k, x: mid.sx - wx * k, y: mid.sy - wy * k });
      return;
    }
    if (gs.kind === 'pan') { ctl.setView({ ...gs.view0, x: gs.view0.x + sx - gs.sx, y: gs.view0.y + sy - gs.sy }); return; }
    const far = Math.hypot(sx - gs.sx, sy - gs.sy) > DRAG_START_PX;
    if (gs.kind === 'drag') {
      if (!gs.moved && !far) return;
      gs.moved = true;
      const o = gs.orig.get(gs.primary);
      const cand = { x: o.x + w.x - gs.w0.x, y: o.y + w.y - gs.w0.y };
      const s = snapPoint(cand, gs.others, { grid: st.settings.grid, gridSize: st.settings.gridSize, guides: st.settings.guides, threshold: GUIDE_PX / st.view.k });
      const dx = s.x - o.x, dy = s.y - o.y;
      const m = new Map();
      for (const [id, p] of gs.orig) m.set(id, { x: p.x + dx, y: p.y + dy });
      ctl.setLive(m);
      ctl.setGuides(s.guides);
      return;
    }
    if (gs.kind === 'marquee') {
      if (!gs.moved && !far) return;
      gs.moved = true;
      const r = rectOf(gs.w0, w);
      ctl.setMarquee(r);
      const inside = st.doc.nodes.filter(n => n.x >= r.x && n.x <= r.x + r.w && n.y >= r.y && n.y <= r.y + r.h).map(n => n.id);
      ctl.setSel({ nodes: [...new Set([...gs.base, ...inside])], edges: [] });
      return;
    }
    if (gs.kind === 'rubber') {
      if (far) gs.moved = true;
      const over = hitNode(e);
      ctl.setRubber({ from: gs.from, x: w.x, y: w.y, over: over && over !== gs.from ? over : null });
    }
  }

  function onPointerUp(e) {
    pointers.current.delete(e.pointerId);
    const gs = g.current;
    if (!gs) return;
    if (gs.kind === 'pinch') { if (pointers.current.size < 2) g.current = null; return; }
    g.current = null;
    const st = ctl.get();
    if (gs.kind === 'drag') {
      if (gs.moved && st.live) ctl.commitMove(st.live);
      ctl.setLive(null); ctl.setGuides([]);
    } else if (gs.kind === 'marquee') {
      ctl.setMarquee(null);
      if (!gs.moved && !gs.add) ctl.setSel({ nodes: [], edges: [] });
    } else if (gs.kind === 'place') {
      const { sx, sy } = local(e);
      if (Math.hypot(sx - gs.sx, sy - gs.sy) <= DRAG_START_PX * 2) ctl.addNodeAt(gs.w);
    } else if (gs.kind === 'rubber') {
      ctl.setRubber(null);
      const over = hitNode(e);
      if (over && over !== gs.from) { ctl.addEdge(gs.from, over); ctl.setPending(null); }
      else if (!gs.moved && over === gs.from) {
        if (st.pending && st.pending !== gs.from) { ctl.addEdge(st.pending, gs.from); ctl.setPending(null); }
        else ctl.setPending(st.pending === gs.from ? null : gs.from);
      }
    }
  }

  function onPointerCancel(e) {
    pointers.current.delete(e.pointerId);
    g.current = null;
    ctl.setLive(null); ctl.setGuides([]); ctl.setMarquee(null); ctl.setRubber(null);
  }

  function hitNode(e) {
    const el = document.elementFromPoint(e.clientX, e.clientY);
    return el?.closest?.('[data-node]')?.getAttribute('data-node') ?? null;
  }

  function onWheel(e) {
    e.preventDefault();
    const st = ctl.get();
    const { sx, sy } = local(e);
    const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    const k = clampK(st.view.k * factor);
    const wx = (sx - st.view.x) / st.view.k, wy = (sy - st.view.y) / st.view.k;
    ctl.setView({ k, x: sx - wx * k, y: sy - wy * k });
  }

  function onDblClick(e) {
    const id = e.target.closest?.('[data-node]')?.getAttribute('data-node');
    if (id) ctl.startRename(id);
    else if (ctl.get().mode === 'select') ctl.addNodeAt(screenToWorld(ctl.get().view, local(e).sx, local(e).sy));
  }

  // ---- render ----
  const { k } = view;
  // Keep labels readable when zoomed out: never below ~10px on screen.
  const fs = Math.max(12, 10 / k), hfs = Math.max(11, 9 / k);
  const vis = size.w ? { x: -view.x / k, y: -view.y / k, w: size.w / k, h: size.h / k } : { x: -2000, y: -2000, w: 4000, h: 4000 };

  const hulls = doc.groups.map((gr, gi) => {
    const pts = [];
    for (const n of doc.nodes) {
      if (n.group !== gr.id) continue;
      const p = pos(n.id);
      for (let a = 0; a < 8; a++) pts.push([p.x + 26 * Math.cos((a * Math.PI) / 4), p.y + 26 * Math.sin((a * Math.PI) / 4)]);
    }
    if (pts.length < 3) return null;
    const hull = d3.polygonHull(pts);
    if (!hull) return null;
    const top = hull.reduce((m, p) => (p[1] < m[1] ? p : m), hull[0]);
    const col = groupColor(gi);
    return html`<g key=${'h' + gr.id}>
      <path class="hull" d=${hullLine(hull)} style=${`fill:${col};stroke:${col}`} />
      <text class="hull-label" x=${top[0]} y=${top[1] - 6} text-anchor="middle" style=${`fill:${col};font-size:${hfs}px`}>${gr.name}</text>
    </g>`;
  });

  const typeIdx = new Map(doc.edgeTypes.map((t, i) => [t, i]));
  const edges = doc.edges.map(e => {
    const a = pos(e.source), b = pos(e.target);
    if (!a || !b) return null;
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const end = e.directed ? NODE_R + 3 : 0;
    const x2 = b.x - ux * end, y2 = b.y - uy * end;
    const isSel = selE.has(e.id);
    // Solid unless several tie types are in use (dashes also mean "in progress").
    const dash = dashed ? DASHES[(typeIdx.get(e.type) ?? 0) % DASHES.length] : '';
    const sw = 1.5 + Math.min(4, Math.log2(Math.max(1, e.weight)));
    const arrow = e.directed ? `M ${x2} ${y2} L ${x2 - ux * 9 - uy * 4.5} ${y2 - uy * 9 + ux * 4.5} L ${x2 - ux * 9 + uy * 4.5} ${y2 - uy * 9 - ux * 4.5} Z` : null;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    return html`<g key=${e.id} data-edge=${e.id}>
      <line class="edge-hit" x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} />
      <line class=${'edge' + (isSel ? ' sel' : '')} x1=${a.x} y1=${a.y} x2=${x2} y2=${y2} stroke-dasharray=${dash || undefined}
        style=${isSel ? undefined : `stroke-width:${sw}`} />
      ${arrow ? html`<path d=${arrow} class=${'arrow' + (isSel ? ' sel' : '')} />` : null}
      ${e.weight !== 1 ? html`<text class="edge-label" x=${mx + uy * 8} y=${my - ux * 8} text-anchor="middle">${fmt(e.weight)}</text>` : null}
    </g>`;
  });

  const nodes = doc.nodes.map(n => {
    const p = pos(n.id);
    const gi = groupIndex.get(n.group);
    const cls = 'node' + (selN.has(n.id) ? ' sel' : '') + (pending === n.id ? ' pending' : '') + (rubber?.over === n.id ? ' target' : '');
    // Two-mode drawings: the second mode is a square, so the mode never
    // rests on color alone (groups keep their fill colors).
    const square = doc.twoMode && n.mode === 1;
    const fill = gi !== undefined ? `fill:${groupColor(gi)}` : undefined;
    const S = NODE_R * 0.9;
    return html`<g key=${n.id} class=${cls + (square ? ' node--sq' : '')} data-node=${n.id} data-mode=${doc.twoMode ? (n.mode === 1 ? 1 : 0) : undefined} transform=${`translate(${p.x},${p.y})`}>
      ${focusId === n.id ? (square ? html`<rect class="focus-ring" x=${-S - 6} y=${-S - 6} width=${2 * S + 12} height=${2 * S + 12} />` : html`<circle class="focus-ring" r=${NODE_R + 6} />`) : null}
      ${square ? html`<rect class="shape" x=${-S} y=${-S} width=${2 * S} height=${2 * S} style=${fill} />` : html`<circle class="shape" r=${NODE_R} style=${fill} />`}
      <text y=${NODE_R + 4 + fs} text-anchor="middle" style=${`font-size:${fs}px`}>${n.label}</text>
    </g>`;
  });

  let rubberLine = null;
  if (rubber) {
    const a = pos(rubber.from);
    if (a) rubberLine = html`<line class="rubber" x1=${a.x} y1=${a.y} x2=${rubber.x} y2=${rubber.y} />`;
  }

  const guideEls = guides.map((gd, i) => gd.axis === 'x'
    ? html`<line key=${'g' + i} class="guide" x1=${gd.at} x2=${gd.at} y1=${gd.from - 30} y2=${gd.to + 30} />`
    : html`<line key=${'g' + i} class="guide" y1=${gd.at} y2=${gd.at} x1=${gd.from - 30} x2=${gd.to + 30} />`);

  const gsz = settings.gridSize;
  const showGrid = settings.grid || settings.showGrid;
  const selCount = sel.nodes.length;
  const label = `Network drawing canvas, ${doc.nodes.length} people, ${doc.edges.length} ties` +
    (selCount ? `, ${selCount} selected` : '') + '. Press question mark for keyboard shortcuts.';

  return html`<svg ref=${svgRef} tabindex="0" role="application" aria-label=${label} aria-describedby="ob-draw-live"
      onPointerDown=${onPointerDown} onPointerMove=${onPointerMove} onPointerUp=${onPointerUp} onPointerCancel=${onPointerCancel}
      onWheel=${onWheel} onDblClick=${onDblClick} onFocus=${() => ctl.onCanvasFocus()}
      data-mode=${mode}>
    <defs>
      <pattern id="ob-draw-grid" width=${gsz} height=${gsz} patternUnits="userSpaceOnUse">
        <path d=${`M ${gsz} 0 L 0 0 0 ${gsz}`} fill="none" stroke=${settings.grid ? 'rgba(255,255,255,.09)' : 'rgba(255,255,255,.045)'} stroke-width=${1 / k} />
      </pattern>
    </defs>
    <g transform=${`translate(${view.x},${view.y}) scale(${k})`}>
      ${showGrid ? html`<rect x=${Math.floor(vis.x / gsz) * gsz - gsz} y=${Math.floor(vis.y / gsz) * gsz - gsz} width=${vis.w + 3 * gsz} height=${vis.h + 3 * gsz} fill="url(#ob-draw-grid)" />` : null}
      <g class="hulls">${hulls}</g>
      <g class="edges">${edges}</g>
      ${rubberLine}
      <g class="nodes">${nodes}</g>
      <g class="guides">${guideEls}</g>
      ${marquee ? html`<rect class="marquee" x=${marquee.x} y=${marquee.y} width=${marquee.w} height=${marquee.h} />` : null}
    </g>
  </svg>`;
}

// The mode's shape as a small inline icon for keys, toolbars and tables.
export function ModeShape({ mode = 0, size = 12 }) {
  const h = size / 2;
  return html`<svg class="ob-modeshape" width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} aria-hidden="true">
    ${mode === 1 ? html`<rect x="1.5" y="1.5" width=${size - 3} height=${size - 3} />` : html`<circle cx=${h} cy=${h} r=${h - 1.5} />`}</svg>`;
}

export function clampK(k) { return Math.max(0.15, Math.min(5, k)); }

function rectOf(a, b) {
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

function fmt(v) { return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/0+$/, ''); }
