// Layout commands for the draw editor ("snap to layout").
//
// Each layout takes the drawing, the node ids to arrange and a target box
// { x, y, w, h } and returns Map id -> { x, y }. Applied to a selection, the
// box is the selection's current bounding box, so arranging part of a drawing
// keeps it where the user put it. All layouts are deterministic (seeded), so
// the same command on the same drawing gives the same picture, and every
// result is finite. Pure; tested in Node.

import { rng } from './common.js';
import { bounds } from './draw.js';

export const LAYOUTS = [
  { id: 'circle', label: 'Circle' },
  { id: 'grid', label: 'Grid' },
  { id: 'tree', label: 'Tree from a root' },
  { id: 'force', label: 'Force-directed' },
  { id: 'concentric', label: 'Concentric by attribute' },
  { id: 'columns', label: 'Two columns (by mode)', twoMode: true },
  { id: 'rows', label: 'Two rows (by mode)', twoMode: true },
];

// The layouts that apply to this drawing: the two-mode arrangements only for
// two-mode drawings.
export function layoutsFor(doc) { return LAYOUTS.filter(l => !l.twoMode || !!doc?.twoMode); }

// Box to lay out into. A selection keeps its own bounding box; a degenerate
// box (one node, or nodes in a line) is grown around its centre so the layout
// has room. The whole drawing gets a box sized to its node count.
export function layoutBox(doc, ids, { all = false } = {}) {
  const set = new Set(ids);
  const ns = doc.nodes.filter(n => set.has(n.id));
  const minSide = Math.max(160, Math.sqrt(ns.length) * (all ? 110 : 70));
  const b = bounds(ns) || { x: 0, y: 0, w: 0, h: 0 };
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  let w = b.w, h = b.h;
  if (all) { w = Math.max(w, minSide); h = Math.max(h, minSide * 0.75); }
  else { if (w < minSide / 2) w = Math.max(w, minSide); if (h < minSide / 2) h = Math.max(h, minSide); }
  return { x: cx - w / 2, y: cy - h / 2, w, h };
}

function adjacency(doc, set) {
  const adj = new Map([...set].map(id => [id, []]));
  for (const e of doc.edges) {
    if (!set.has(e.source) || !set.has(e.target)) continue;
    adj.get(e.source).push(e.target);
    adj.get(e.target).push(e.source);
  }
  return adj;
}

function orderedIds(doc, ids) {
  const set = new Set(ids);
  return doc.nodes.filter(n => set.has(n.id)).map(n => n.id);
}

// Scale and centre raw positions into the box, keeping the aspect ratio.
export function fitInto(raw, box, pad = 0) {
  const pts = [...raw.values()];
  const out = new Map();
  if (!pts.length) return out;
  const b = bounds(pts);
  const iw = Math.max(box.w - 2 * pad, 0), ih = Math.max(box.h - 2 * pad, 0);
  const sx = b.w > 1e-9 ? iw / b.w : Infinity, sy = b.h > 1e-9 ? ih / b.h : Infinity;
  let s = Math.min(sx, sy);
  if (!Number.isFinite(s)) s = 1;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const bx = b.x + b.w / 2, by = b.y + b.h / 2;
  for (const [id, p] of raw) out.set(id, { x: cx + (p.x - bx) * s, y: cy + (p.y - by) * s });
  return out;
}

export function circleLayout(doc, ids, box) {
  const order = orderedIds(doc, ids);
  const out = new Map();
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const r = Math.min(box.w, box.h) / 2;
  if (order.length === 1) { out.set(order[0], { x: cx, y: cy }); return out; }
  order.forEach((id, i) => {
    const a = -Math.PI / 2 + (2 * Math.PI * i) / order.length;
    out.set(id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
  });
  return out;
}

export function gridLayout(doc, ids, box) {
  const order = orderedIds(doc, ids);
  const n = order.length;
  const out = new Map();
  if (!n) return out;
  const aspect = box.h > 0 ? box.w / box.h : 1;
  const cols = Math.max(1, Math.min(n, Math.round(Math.sqrt(n * aspect)) || 1));
  const rows = Math.ceil(n / cols);
  const dx = cols > 1 ? box.w / (cols - 1) : 0, dy = rows > 1 ? box.h / (rows - 1) : 0;
  order.forEach((id, i) => {
    const c = i % cols, r = Math.floor(i / cols);
    out.set(id, { x: cols > 1 ? box.x + c * dx : box.x + box.w / 2, y: rows > 1 ? box.y + r * dy : box.y + box.h / 2 });
  });
  return out;
}

// Layered tree from a root: breadth-first levels top to bottom, each parent
// centred over its children (leaves get equal slots). Ties are read as
// undirected. Nodes the root cannot reach form further trees to the right,
// each rooted at its first node in drawing order.
export function treeLayout(doc, ids, box, { root } = {}) {
  const order = orderedIds(doc, ids);
  const out = new Map();
  if (!order.length) return out;
  const set = new Set(order);
  const adj = adjacency(doc, set);
  const children = new Map(), depth = new Map();
  const roots = [];
  const bfs = r => {
    roots.push(r); depth.set(r, 0); children.set(r, []);
    const q = [r];
    while (q.length) {
      const u = q.shift();
      for (const v of adj.get(u)) {
        if (depth.has(v)) continue;
        depth.set(v, depth.get(u) + 1); children.set(v, []); children.get(u).push(v); q.push(v);
      }
    }
  };
  bfs(set.has(root) ? root : order[0]);
  for (const id of order) if (!depth.has(id)) bfs(id);
  // Leaf slots by depth-first order; parents centred over children.
  const raw = new Map();
  let slot = 0;
  const place = u => {
    const ch = children.get(u);
    if (!ch.length) { raw.set(u, { x: slot++, y: depth.get(u) }); return; }
    for (const c of ch) place(c);
    const xs = ch.map(c => raw.get(c).x);
    raw.set(u, { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: depth.get(u) });
  };
  for (const r of roots) place(r);
  // Stretch each axis independently: a tree should fill the box's width and
  // height (levels evenly spaced), unlike geometric layouts.
  const maxX = Math.max(...[...raw.values()].map(p => p.x)), maxD = Math.max(...[...raw.values()].map(p => p.y));
  for (const [id, p] of raw) {
    out.set(id, {
      x: maxX > 0 ? box.x + (p.x / maxX) * box.w : box.x + box.w / 2,
      y: maxD > 0 ? box.y + (p.y / maxD) * box.h : box.y + box.h / 2,
    });
  }
  return out;
}

// Fruchterman-Reingold with a seeded start (current positions plus a small
// seeded jitter, so a drawing the user has half-arranged is refined rather
// than scrambled) and a cooling schedule. O(n^2) per iteration, fine for the
// hundreds of nodes anyone draws by hand.
export function forceLayout(doc, ids, box, { seed = 7, iterations = 300 } = {}) {
  const order = orderedIds(doc, ids);
  const n = order.length;
  const out = new Map();
  if (!n) return out;
  if (n === 1) { out.set(order[0], { x: box.x + box.w / 2, y: box.y + box.h / 2 }); return out; }
  const rand = rng(seed);
  const index = new Map(order.map((id, i) => [id, i]));
  const byId = new Map(doc.nodes.map(nd => [nd.id, nd]));
  const X = new Float64Array(n), Y = new Float64Array(n);
  const b = bounds(order.map(id => byId.get(id)));
  const span = Math.max(b.w, b.h, 1);
  order.forEach((id, i) => {
    const nd = byId.get(id);
    X[i] = (nd.x - b.x) / span + (rand() - 0.5) * 0.2;
    Y[i] = (nd.y - b.y) / span + (rand() - 0.5) * 0.2;
  });
  const E = [];
  for (const e of doc.edges) {
    const s = index.get(e.source), t = index.get(e.target);
    if (s !== undefined && t !== undefined) E.push([s, t]);
  }
  const k = 1 / Math.sqrt(n);
  let temp = 0.1;
  const dX = new Float64Array(n), dY = new Float64Array(n);
  for (let it = 0; it < iterations; it++) {
    dX.fill(0); dY.fill(0);
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      let dx = X[i] - X[j], dy = Y[i] - Y[j];
      let d2 = dx * dx + dy * dy;
      if (d2 < 1e-12) { dx = (rand() - 0.5) * 1e-3; dy = (rand() - 0.5) * 1e-3; d2 = dx * dx + dy * dy; }
      const f = (k * k) / d2;
      dX[i] += dx * f; dY[i] += dy * f; dX[j] -= dx * f; dY[j] -= dy * f;
    }
    for (const [s, t] of E) {
      const dx = X[s] - X[t], dy = Y[s] - Y[t];
      const d = Math.sqrt(dx * dx + dy * dy) || 1e-6;
      const f = d / k;
      dX[s] -= dx * f; dY[s] -= dy * f; dX[t] += dx * f; dY[t] += dy * f;
    }
    // Weak gravity keeps disconnected pieces from drifting apart forever.
    for (let i = 0; i < n; i++) { dX[i] -= (X[i] - 0.5) * 0.5 * k; dY[i] -= (Y[i] - 0.5) * 0.5 * k; }
    for (let i = 0; i < n; i++) {
      const d = Math.sqrt(dX[i] * dX[i] + dY[i] * dY[i]) || 1;
      const m = Math.min(d, temp);
      X[i] += (dX[i] / d) * m; Y[i] += (dY[i] / d) * m;
    }
    temp = Math.max(0.002, temp * 0.985);
  }
  const raw = new Map(order.map((id, i) => [id, { x: X[i], y: Y[i] }]));
  return fitInto(raw, box);
}

// Values available for concentric rings: 'degree' plus every attribute
// column and 'group'.
export function concentricKeys(doc) {
  return ['degree', 'group', ...doc.attrColumns.map(c => c.key)];
}

// Concentric rings by an attribute: numeric values high-in-the-middle,
// categories by frequency (most common innermost), missing values outermost.
// 'degree' counts ties among the arranged nodes.
export function concentricLayout(doc, ids, box, { key = 'degree' } = {}) {
  const order = orderedIds(doc, ids);
  const out = new Map();
  if (!order.length) return out;
  const set = new Set(order);
  const byId = new Map(doc.nodes.map(nd => [nd.id, nd]));
  const groupName = new Map(doc.groups.map(g => [g.id, g.name]));
  let val;
  if (key === 'degree') {
    const adj = adjacency(doc, set);
    val = id => adj.get(id).length;
  } else if (key === 'group') {
    val = id => groupName.get(byId.get(id).group) ?? null;
  } else {
    val = id => { const v = byId.get(id).attrs?.[key]; return v === undefined || v === '' ? null : v; };
  }
  const vals = new Map(order.map(id => [id, val(id)]));
  const present = [...vals.values()].filter(v => v !== null);
  const numeric = present.length > 0 && present.every(v => Number.isFinite(Number(v)));
  const ringOf = new Map();
  let ringKeys;
  if (numeric) {
    ringKeys = [...new Set(present.map(Number))].sort((a, b) => b - a);
  } else {
    const freq = new Map();
    for (const v of present) freq.set(String(v), (freq.get(String(v)) || 0) + 1);
    ringKeys = [...freq.keys()].sort((a, b) => freq.get(b) - freq.get(a) || a.localeCompare(b));
  }
  for (const id of order) {
    const v = vals.get(id);
    ringOf.set(id, v === null ? ringKeys.length : ringKeys.indexOf(numeric ? Number(v) : String(v)));
  }
  const ringCount = Math.max(...ringOf.values()) + 1;
  const rings = Array.from({ length: ringCount }, () => []);
  for (const id of order) rings[ringOf.get(id)].push(id);
  const nonEmpty = rings.filter(r => r.length);
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  const R = Math.min(box.w, box.h) / 2;
  const centreSingle = nonEmpty[0].length === 1;
  const steps = nonEmpty.length - (centreSingle ? 1 : 0);
  nonEmpty.forEach((ring, i) => {
    const r = centreSingle ? (i === 0 ? 0 : (R * i) / steps) : (R * (i + 1)) / steps;
    ring.forEach((id, j) => {
      const a = -Math.PI / 2 + (2 * Math.PI * j) / ring.length + (i % 2 ? Math.PI / ring.length : 0);
      out.set(id, { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) });
    });
  });
  return out;
}

// One entry point for the editor. opts: { root, key, seed, all }
export function runLayout(doc, id, ids, opts = {}) {
  const box = opts.box || layoutBox(doc, ids, { all: !!opts.all });
  switch (id) {
    case 'circle': return circleLayout(doc, ids, box);
    case 'grid': return gridLayout(doc, ids, box);
    case 'tree': return treeLayout(doc, ids, box, opts);
    case 'force': return forceLayout(doc, ids, box, opts);
    case 'concentric': return concentricLayout(doc, ids, box, opts);
    case 'columns': return twoModeLayout(doc, ids, box, 'columns', { grow: !opts.box && !!opts.all });
    case 'rows': return twoModeLayout(doc, ids, box, 'rows', { grow: !opts.box && !!opts.all });
    default: throw new Error(`Unknown layout: ${id}`);
  }
}

// Two-mode drawings: mode 0 in the left column (or top row), mode 1 in the
// right column (bottom row). The order inside each side comes from a few
// barycenter sweeps, so each node moves toward the average position of the
// nodes it is tied to and lines cross less. One-mode drawings (no modes) get
// everyone on side 0. Deterministic.
// grow: the whole drawing may extend past the box so neighbours along a side
// keep 56 px for their labels; a selection stays inside its own box.
export function twoModeLayout(doc, ids, box, arrange = 'columns', { grow = false } = {}) {
  const order = orderedIds(doc, ids);
  const out = new Map();
  if (!order.length) return out;
  const set = new Set(order);
  const adj = adjacency(doc, set);
  const byId = new Map(doc.nodes.map(n => [n.id, n]));
  const sides = [[], []];
  for (const id of order) sides[byId.get(id).mode === 1 ? 1 : 0].push(id);
  const pos = new Map();
  const place = side => side.forEach((id, k) => pos.set(id, side.length > 1 ? k / (side.length - 1) : 0.5));
  place(sides[0]); place(sides[1]);
  for (let sweep = 0; sweep < 8; sweep++) {
    const side = sides[sweep % 2 === 0 ? 1 : 0];
    const bary = new Map(side.map(id => { const nb = adj.get(id); return [id, nb.length ? nb.reduce((t, u) => t + pos.get(u), 0) / nb.length : pos.get(id)]; }));
    const idx = new Map(side.map((id, k) => [id, k]));
    side.sort((a, b) => bary.get(a) - bary.get(b) || idx.get(a) - idx.get(b));
    place(side);
  }
  const longest = Math.max(sides[0].length, sides[1].length);
  const columns = arrange !== 'rows';
  const along = grow ? Math.max(columns ? box.h : box.w, (longest - 1) * 56) : columns ? box.h : box.w;
  const across = grow ? Math.max(columns ? box.w : box.h, 160) : columns ? box.w : box.h;
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  for (const [id, t] of pos) {
    const a = (t - 0.5) * along, c = (byId.get(id).mode === 1 ? 0.5 : -0.5) * across;
    out.set(id, columns ? { x: cx + c, y: cy + a } : { x: cx + a, y: cy + c });
  }
  return out;
}
