// Draw-your-own-network document model.
//
// A drawing is a plain JSON document:
//   { version, name, nodes[{ id, label, x, y, group, attrs{} }],
//     edges[{ id, source, target, type, weight, directed }],
//     groups[{ id, name }], attrColumns[{ key, type }], edgeTypes[],
//     groupKey?, example?, twoMode? }
// groupKey names the attribute the groups become in the Dataset ('group'
// unless set, e.g. 'major'); example is the id of the worked example the
// drawing started from (src/builders/examples.js).
//
// Two-mode drawings (people and the events, clubs or boards they belong to):
// doc.twoMode = { labels: [mode-0 label, mode-1 label] } (default 'People',
// 'Events') and every node carries mode: 0 | 1. Ties may only join the two
// modes; addEdge refuses a same-mode tie (canConnect says why). A drawing
// turned two-mode keeps any same-mode ties it had, toDataset leaves them out
// with a warning, and sameModeEdges lists them for the editor. One-mode
// drawings have neither field, so older drawings are unchanged.
//
// Every edit is a pure function doc -> new doc. Unchanged arrays and objects
// are shared between versions, so the undo history can simply keep the
// previous documents (snapshot history with structural sharing): undo and
// redo are O(1), and a command never needs a hand-written inverse that could
// drift out of sync with its apply. Drags and layout animations commit once
// at the end, so one gesture is one undo step.
//
// Pure module: runs in Node for tests. Snapping lives in draw-snap.js and
// layouts in draw-layout.js.

import { DatasetBuilder, declareTwoMode, addModeNode, addAffiliation } from '../core/model.js';
import { uid, slug, coerce, ATTR_TYPES } from './common.js';
import { exampleById } from './examples.js';

export const DRAW_VERSION = 1;
export const DEFAULT_EDGE_TYPE = 'tie';

export function emptyDoc(name = 'Untitled drawing') {
  return { version: DRAW_VERSION, name, nodes: [], edges: [], groups: [], attrColumns: [], edgeTypes: [DEFAULT_EDGE_TYPE] };
}

// ---- history ---------------------------------------------------------------

const HISTORY_LIMIT = 200;

export function createHistory(doc) {
  return { past: [], present: doc, future: [], labels: { past: [], future: [] } };
}

// Record a new present. A command that returned the same doc (no-op) does not
// create an undo step.
export function commit(h, doc, label = 'Edit') {
  if (doc === h.present) return h;
  const past = [...h.past, h.present];
  const pl = [...h.labels.past, label];
  if (past.length > HISTORY_LIMIT) { past.shift(); pl.shift(); }
  return { past, present: doc, future: [], labels: { past: pl, future: [] } };
}

export function undo(h) {
  if (!h.past.length) return h;
  const label = h.labels.past[h.labels.past.length - 1];
  return {
    past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future],
    labels: { past: h.labels.past.slice(0, -1), future: [label, ...h.labels.future] },
  };
}

export function redo(h) {
  if (!h.future.length) return h;
  const label = h.labels.future[0];
  return {
    past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1),
    labels: { past: [...h.labels.past, label], future: h.labels.future.slice(1) },
  };
}

export const canUndo = h => h.past.length > 0;
export const canRedo = h => h.future.length > 0;
export const undoLabel = h => h.labels.past[h.labels.past.length - 1] ?? null;
export const redoLabel = h => h.labels.future[0] ?? null;

// ---- lookups ---------------------------------------------------------------

export function nodeById(doc, id) { return doc.nodes.find(n => n.id === id) ?? null; }
export function edgeById(doc, id) { return doc.edges.find(e => e.id === id) ?? null; }
export function groupById(doc, id) { return doc.groups.find(g => g.id === id) ?? null; }

// mode: in a two-mode drawing, new names follow the mode ('Event 3').
export function nextLabel(doc, mode = 0) {
  const noun = doc.twoMode ? modeNoun(doc.twoMode.labels[mode === 1 ? 1 : 0]) : 'Person';
  const taken = new Set(doc.nodes.map(n => n.label));
  let i = (doc.twoMode ? doc.nodes.filter(n => (n.mode || 0) === (mode === 1 ? 1 : 0)).length : doc.nodes.length) + 1;
  while (taken.has(`${noun} ${i}`)) i++;
  return `${noun} ${i}`;
}

// ---- two-mode drawings ------------------------------------------------------

export const DEFAULT_TWO_MODE_LABELS = ['People', 'Events'];

// One of a mode, for names and messages: People -> Person, Clubs -> Club,
// Companies -> Company. Labels that are not plural stay as they are.
export function modeNoun(label) {
  const l = String(label || '').trim();
  if (!l) return 'Node';
  if (/^people$/i.test(l)) return l[0] === 'p' ? 'person' : 'Person';
  if (/[^aeiou]ies$/i.test(l)) return l.slice(0, -3) + 'y';
  if (/(ss|us|is)$/i.test(l)) return l;
  if (/s$/i.test(l)) return l.slice(0, -1);
  return l;
}

export const isTwoMode = doc => !!doc?.twoMode;
export const nodeMode = n => (n?.mode === 1 ? 1 : 0);

// Ties joining two nodes of the same mode (kept in the drawing, left out of
// the analysis).
export function sameModeEdges(doc) {
  if (!doc.twoMode) return [];
  const m = new Map(doc.nodes.map(n => [n.id, nodeMode(n)]));
  return doc.edges.filter(e => m.get(e.source) === m.get(e.target));
}

// Two-colour the drawing when its ties allow it (every tie joins the two
// sides): Map id -> 0 | 1, or null when some tie closes an odd cycle. In
// each connected piece the first node in drawing order goes on side 0.
export function twoColouring(doc) {
  const adj = new Map(doc.nodes.map(n => [n.id, []]));
  for (const e of doc.edges) { adj.get(e.source)?.push(e.target); adj.get(e.target)?.push(e.source); }
  const side = new Map();
  for (const n of doc.nodes) {
    if (side.has(n.id)) continue;
    side.set(n.id, 0);
    const q = [n.id];
    while (q.length) {
      const v = q.shift();
      for (const u of adj.get(v)) {
        if (!side.has(u)) { side.set(u, 1 - side.get(v)); q.push(u); }
        else if (side.get(u) === side.get(v)) return null;
      }
    }
  }
  return side;
}

// Turn a drawing two-mode (on) or back to one mode. Turning it on keeps every
// node and tie: if the ties already alternate between two sides (a drawing of
// people and clubs made before the option existed), the sides become the
// modes; otherwise everyone starts in mode 0 and every existing tie is a
// same-mode tie until modes are changed. Returns { doc, assigned:
// 'colouring' | 'all-mode-0' | null, sameMode: number of same-mode ties }.
export function setTwoMode(doc, on, labels = doc.twoMode?.labels || DEFAULT_TWO_MODE_LABELS) {
  if (!on) {
    if (!doc.twoMode) return { doc, assigned: null, sameMode: 0 };
    const { twoMode: _, ...rest } = doc;
    return { doc: { ...rest, nodes: doc.nodes.map(({ mode: __, ...n }) => n) }, assigned: null, sameMode: 0 };
  }
  const lab = [String(labels[0] || DEFAULT_TWO_MODE_LABELS[0]), String(labels[1] || DEFAULT_TWO_MODE_LABELS[1])];
  if (doc.twoMode) return { doc: { ...doc, twoMode: { labels: lab } }, assigned: null, sameMode: sameModeEdges(doc).length };
  const col = doc.edges.length ? twoColouring(doc) : null;
  const nodes = doc.nodes.map(n => ({ ...n, mode: col ? col.get(n.id) : 0 }));
  // Directed ties have no meaning in an affiliation network.
  const edges = doc.edges.some(e => e.directed) ? doc.edges.map(e => (e.directed ? { ...e, directed: false } : e)) : doc.edges;
  const next = { ...doc, twoMode: { labels: lab }, nodes, edges };
  return { doc: next, assigned: col ? 'colouring' : 'all-mode-0', sameMode: sameModeEdges(next).length };
}

export function setModeLabels(doc, labels) {
  if (!doc.twoMode) return doc;
  const lab = [0, 1].map(i => String(labels?.[i] ?? '').trim() || doc.twoMode.labels[i]);
  if (lab[0] === doc.twoMode.labels[0] && lab[1] === doc.twoMode.labels[1]) return doc;
  return { ...doc, twoMode: { labels: lab } };
}

export function setNodeMode(doc, ids, mode) {
  if (!doc.twoMode) return doc;
  const s = new Set(ids), m = mode === 1 ? 1 : 0;
  let changed = false;
  const nodes = doc.nodes.map(n => { if (!s.has(n.id) || nodeMode(n) === m) return n; changed = true; return { ...n, mode: m }; });
  return changed ? { ...doc, nodes } : doc;
}

// Why a tie between a and b cannot be drawn, in words, or null when it can.
export function canConnect(doc, a, b) {
  if (!a || !b || a === b) return 'A tie needs two different nodes.';
  const na = nodeById(doc, a), nb = nodeById(doc, b);
  if (!na || !nb) return 'Both ends must be in the drawing.';
  if (doc.twoMode && nodeMode(na) === nodeMode(nb)) {
    const lab = doc.twoMode.labels[nodeMode(na)];
    return `In a two-mode drawing ties only join ${doc.twoMode.labels[0].toLowerCase()} with ${doc.twoMode.labels[1].toLowerCase()}; ${na.label} and ${nb.label} are both ${lab.toLowerCase()}.`;
  }
  return null;
}

// ---- node operations -------------------------------------------------------

export function addNode(doc, { id = uid('n'), label, x = 0, y = 0, group = null, attrs = {}, mode = 0 } = {}) {
  const node = { id, label: label ?? nextLabel(doc, mode), x: +x || 0, y: +y || 0, group: group || null, attrs: { ...attrs } };
  if (doc.twoMode) node.mode = mode === 1 ? 1 : 0;
  return { ...doc, nodes: [...doc.nodes, node] };
}

export function updateNode(doc, id, patch) {
  let changed = false;
  const nodes = doc.nodes.map(n => {
    if (n.id !== id) return n;
    const next = { ...n, ...patch };
    if (patch.attrs) next.attrs = { ...n.attrs, ...patch.attrs };
    changed = Object.keys(patch).some(k => k === 'attrs' ? Object.entries(patch.attrs).some(([a, v]) => n.attrs[a] !== v) : n[k] !== patch[k]);
    return next;
  });
  return changed ? { ...doc, nodes } : doc;
}

// positions: Map or plain object id -> { x, y }
export function moveNodes(doc, positions) {
  const get = positions instanceof Map ? k => positions.get(k) : k => positions[k];
  let changed = false;
  const nodes = doc.nodes.map(n => {
    const p = get(n.id);
    if (!p || (p.x === n.x && p.y === n.y) || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return n;
    changed = true;
    return { ...n, x: p.x, y: p.y };
  });
  return changed ? { ...doc, nodes } : doc;
}

// Removing a node removes every tie that touches it; undo brings both back
// because the previous document is kept whole.
export function removeNodes(doc, ids) {
  const s = new Set(ids);
  if (!doc.nodes.some(n => s.has(n.id))) return doc;
  return {
    ...doc,
    nodes: doc.nodes.filter(n => !s.has(n.id)),
    edges: doc.edges.filter(e => !s.has(e.source) && !s.has(e.target)),
  };
}

// ---- edge operations -------------------------------------------------------

export function findEdge(doc, source, target, type) {
  return doc.edges.find(e => e.type === type && ((e.source === source && e.target === target) ||
    (!e.directed && e.source === target && e.target === source))) ?? null;
}

// Self-loops and exact duplicates (same pair, same type) are refused: a drawn
// tie is a declared relation, and drawing it twice should not double its weight.
// In a two-mode drawing a tie must join the two modes and is never directed.
export function addEdge(doc, { id = uid('e'), source, target, type = doc.edgeTypes[0] || DEFAULT_EDGE_TYPE, weight = 1, directed = false } = {}) {
  if (canConnect(doc, source, target)) return doc;
  if (doc.twoMode) directed = false;
  if (findEdge(doc, source, target, type) || (!directed && findEdge(doc, target, source, type))) return doc;
  const w = Number(weight);
  const edge = { id, source, target, type, weight: Number.isFinite(w) && w > 0 ? w : 1, directed: !!directed };
  const edgeTypes = doc.edgeTypes.includes(type) ? doc.edgeTypes : [...doc.edgeTypes, type];
  return { ...doc, edges: [...doc.edges, edge], edgeTypes };
}

export function updateEdge(doc, id, patch) {
  let changed = false;
  const edges = doc.edges.map(e => {
    if (e.id !== id) return e;
    const next = { ...e, ...patch };
    if ('weight' in patch) { const w = Number(patch.weight); next.weight = Number.isFinite(w) && w > 0 ? w : e.weight; }
    if ('directed' in patch) next.directed = !!patch.directed && !doc.twoMode;
    changed = Object.keys(patch).some(k => next[k] !== e[k]);
    return next;
  });
  if (!changed) return doc;
  const t = patch.type;
  const edgeTypes = t && !doc.edgeTypes.includes(t) ? [...doc.edgeTypes, t] : doc.edgeTypes;
  return { ...doc, edges, edgeTypes };
}

export function reverseEdge(doc, id) {
  const e = edgeById(doc, id);
  return e ? updateEdge(doc, id, { source: e.target, target: e.source }) : doc;
}

export function removeEdges(doc, ids) {
  const s = new Set(ids);
  if (!doc.edges.some(e => s.has(e.id))) return doc;
  return { ...doc, edges: doc.edges.filter(e => !s.has(e.id)) };
}

// Connect nodes in the given order (a path a-b-c...). Used by the keyboard
// "connect selected" command.
export function connectPath(doc, ids, opts = {}) {
  let d = doc;
  for (let i = 0; i + 1 < ids.length; i++) d = addEdge(d, { ...opts, id: undefined, source: ids[i], target: ids[i + 1] });
  return d;
}

export function addEdgeType(doc, type) {
  const t = String(type ?? '').trim();
  if (!t || doc.edgeTypes.includes(t)) return doc;
  return { ...doc, edgeTypes: [...doc.edgeTypes, t] };
}

// ---- groups ----------------------------------------------------------------

export function addGroup(doc, { id = uid('g'), name } = {}) {
  const nm = String(name ?? '').trim() || `Group ${doc.groups.length + 1}`;
  return { ...doc, groups: [...doc.groups, { id, name: nm }] };
}

export function renameGroup(doc, id, name) {
  const nm = String(name ?? '').trim();
  if (!nm) return doc;
  return { ...doc, groups: doc.groups.map(g => (g.id === id ? { ...g, name: nm } : g)) };
}

export function removeGroup(doc, id) {
  if (!groupById(doc, id)) return doc;
  return {
    ...doc,
    groups: doc.groups.filter(g => g.id !== id),
    nodes: doc.nodes.map(n => (n.group === id ? { ...n, group: null } : n)),
  };
}

export function setGroup(doc, ids, groupId) {
  const s = new Set(ids);
  let changed = false;
  const nodes = doc.nodes.map(n => {
    if (!s.has(n.id) || n.group === (groupId || null)) return n;
    changed = true;
    return { ...n, group: groupId || null };
  });
  return changed ? { ...doc, nodes } : doc;
}

// ---- attribute columns -----------------------------------------------------

export function addAttrColumn(doc, { key, type = 'text' }) {
  const k = String(key ?? '').trim();
  if (!k || doc.attrColumns.some(c => c.key === k) || k === 'group' || k === 'label') return doc;
  return { ...doc, attrColumns: [...doc.attrColumns, { key: k, type: ATTR_TYPES.includes(type) ? type : 'text' }] };
}

export function setAttrColumnType(doc, key, type) {
  if (!ATTR_TYPES.includes(type)) return doc;
  return { ...doc, attrColumns: doc.attrColumns.map(c => (c.key === key ? { ...c, type } : c)) };
}

export function removeAttrColumn(doc, key) {
  if (!doc.attrColumns.some(c => c.key === key)) return doc;
  return {
    ...doc,
    attrColumns: doc.attrColumns.filter(c => c.key !== key),
    nodes: doc.nodes.map(n => {
      if (!(key in n.attrs)) return n;
      const { [key]: _, ...rest } = n.attrs;
      return { ...n, attrs: rest };
    }),
  };
}

export function setNodeAttr(doc, id, key, value) {
  return updateNode(doc, id, { attrs: { [key]: value } });
}

// ---- copy / paste ------------------------------------------------------------

// Clipboard keeps the selected nodes and only the ties among them.
export function copySelection(doc, ids) {
  const s = new Set(ids);
  return {
    nodes: doc.nodes.filter(n => s.has(n.id)).map(n => ({ ...n, attrs: { ...n.attrs } })),
    edges: doc.edges.filter(e => s.has(e.source) && s.has(e.target)).map(e => ({ ...e })),
  };
}

// Paste with fresh ids, shifted by offset. Groups referenced by the clip but
// missing from the doc (pasting into a new drawing) are dropped.
export function paste(doc, clip, { offset = 30 } = {}) {
  if (!clip?.nodes?.length) return { doc, ids: [] };
  const map = new Map(clip.nodes.map(n => [n.id, uid('n')]));
  const groups = new Set(doc.groups.map(g => g.id));
  const nodes = clip.nodes.map(n => {
    const { mode, ...rest } = n;
    const out = { ...rest, id: map.get(n.id), x: n.x + offset, y: n.y + offset, group: groups.has(n.group) ? n.group : null, attrs: { ...n.attrs } };
    if (doc.twoMode) out.mode = mode === 1 ? 1 : 0;
    return out;
  });
  const modeOf = new Map(nodes.map(n => [n.id, n.mode]));
  // Into a two-mode drawing only cross-mode ties come along.
  const edges = clip.edges.filter(e => map.has(e.source) && map.has(e.target)).map(e => ({ ...e, id: uid('e'), source: map.get(e.source), target: map.get(e.target), ...(doc.twoMode ? { directed: false } : {}) }))
    .filter(e => !doc.twoMode || modeOf.get(e.source) !== modeOf.get(e.target));
  const edgeTypes = [...doc.edgeTypes];
  for (const e of edges) if (!edgeTypes.includes(e.type)) edgeTypes.push(e.type);
  return { doc: { ...doc, nodes: [...doc.nodes, ...nodes], edges: [...doc.edges, ...edges], edgeTypes }, ids: nodes.map(n => n.id) };
}

// ---- align / distribute ----------------------------------------------------

// how: left | center | right | top | middle | bottom. Aligns node centres
// (nodes are drawn as same-size circles, so edges and centres coincide up to r).
export function align(doc, ids, how) {
  const ns = doc.nodes.filter(n => ids.includes(n.id));
  if (ns.length < 2) return doc;
  const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
  const target = {
    left: ['x', Math.min(...xs)], right: ['x', Math.max(...xs)], center: ['x', (Math.min(...xs) + Math.max(...xs)) / 2],
    top: ['y', Math.min(...ys)], bottom: ['y', Math.max(...ys)], middle: ['y', (Math.min(...ys) + Math.max(...ys)) / 2],
  }[how];
  if (!target) return doc;
  const [axis, v] = target;
  const pos = new Map(ns.map(n => [n.id, axis === 'x' ? { x: v, y: n.y } : { x: n.x, y: v }]));
  return moveNodes(doc, pos);
}

// Equal spacing between the outermost nodes along an axis ('h' or 'v'),
// keeping their order.
export function distribute(doc, ids, axis = 'h') {
  const k = axis === 'v' ? 'y' : 'x';
  const ns = doc.nodes.filter(n => ids.includes(n.id)).sort((a, b) => a[k] - b[k]);
  if (ns.length < 3) return doc;
  const lo = ns[0][k], hi = ns[ns.length - 1][k];
  const step = (hi - lo) / (ns.length - 1);
  const pos = new Map(ns.map((n, i) => [n.id, k === 'x' ? { x: lo + i * step, y: n.y } : { x: n.x, y: lo + i * step }]));
  return moveNodes(doc, pos);
}

// ---- bounds ------------------------------------------------------------------

export function bounds(nodes) {
  if (!nodes.length) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const n of nodes) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x); y1 = Math.max(y1, n.y); }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

// A place for a new node at or near p that keeps clear of every node and its
// label (drawn below the circle), so a new node never hides a name. Tries p,
// then rings of candidates around it (right first), nearest first.
//   r       node radius
//   clearX  horizontal clearance from another node's centre (label width)
//   clearY  vertical clearance (circle plus label line)
export function freeSpot(nodes, p, { r = 10, clearX = 56, clearY = 44, step = null } = {}) {
  const free = q => nodes.every(n => Math.abs(n.x - q.x) >= clearX || Math.abs(n.y - q.y) >= clearY);
  if (free(p)) return { x: p.x, y: p.y };
  const s = step || Math.max(r * 2, clearY);
  for (let ring = 1; ring <= 12; ring++) {
    const cands = [];
    for (let i = -ring; i <= ring; i++) for (let j = -ring; j <= ring; j++) {
      if (Math.max(Math.abs(i), Math.abs(j)) !== ring) continue;
      cands.push({ x: p.x + i * clearX, y: p.y + j * s });
    }
    // Nearest first; ties prefer the right, then below.
    cands.sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y) || b.x - a.x || b.y - a.y);
    const hit = cands.find(free);
    if (hit) return hit;
  }
  return { x: p.x + clearX, y: p.y };
}

// ---- JSON import / export ------------------------------------------------------

export function exportJSON(doc) {
  return JSON.stringify({ format: 'org-signal-drawing', ...doc }, null, 2);
}

// Validate and normalise an untrusted object. Returns { doc, errors, warnings };
// doc is null when the input cannot be used at all.
export function validateDoc(obj) {
  const errors = [], warnings = [];
  if (!obj || typeof obj !== 'object') return { doc: null, errors: ['Not a drawing: expected a JSON object.'], warnings };
  if (!Array.isArray(obj.nodes)) return { doc: null, errors: ['Not a drawing: no "nodes" list.'], warnings };
  if (obj.version != null && obj.version > DRAW_VERSION) warnings.push(`Drawing version ${obj.version} is newer than this app (${DRAW_VERSION}); some fields may be ignored.`);
  const doc = emptyDoc(typeof obj.name === 'string' && obj.name.trim() ? obj.name : 'Imported drawing');
  if (typeof obj.groupKey === 'string' && /^[A-Za-z_][\w]*$/.test(obj.groupKey)) doc.groupKey = obj.groupKey;
  if (typeof obj.example === 'string' && obj.example) doc.example = obj.example;
  if (obj.twoMode && typeof obj.twoMode === 'object') {
    const l = Array.isArray(obj.twoMode.labels) ? obj.twoMode.labels : [];
    doc.twoMode = { labels: [0, 1].map(i => (typeof l[i] === 'string' && l[i].trim() ? l[i].trim() : DEFAULT_TWO_MODE_LABELS[i])) };
  }
  doc.groups = (Array.isArray(obj.groups) ? obj.groups : []).filter(g => g && g.id != null).map(g => ({ id: String(g.id), name: String(g.name ?? g.id) }));
  const groupIds = new Set(doc.groups.map(g => g.id));
  doc.attrColumns = (Array.isArray(obj.attrColumns) ? obj.attrColumns : []).filter(c => c && c.key)
    .map(c => ({ key: String(c.key), type: ATTR_TYPES.includes(c.type) ? c.type : 'text' }));
  const ids = new Set();
  obj.nodes.forEach((n, i) => {
    if (!n || n.id == null) { errors.push(`Person ${i + 1} has no id; skipped.`); return; }
    const id = String(n.id);
    if (ids.has(id)) { errors.push(`Duplicate person id "${id}"; second copy skipped.`); return; }
    ids.add(id);
    const x = Number(n.x), y = Number(n.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) warnings.push(`Person "${id}" had no position; placed at the origin.`);
    let group = n.group == null || n.group === '' ? null : String(n.group);
    if (group && !groupIds.has(group)) { doc.groups.push({ id: group, name: group }); groupIds.add(group); }
    const node = { id, label: String(n.label ?? id), x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0, group,
      attrs: n.attrs && typeof n.attrs === 'object' ? { ...n.attrs } : {} };
    if (doc.twoMode) {
      const m = n.mode === 1 || n.mode === '1' ? 1 : n.mode === 0 || n.mode === '0' ? 0 : null;
      if (m === null) warnings.push(`"${node.label}" had no mode; placed among the ${doc.twoMode.labels[0].toLowerCase()}.`);
      node.mode = m ?? 0;
    }
    doc.nodes.push(node);
  });
  const types = new Set(Array.isArray(obj.edgeTypes) ? obj.edgeTypes.map(String) : []);
  (Array.isArray(obj.edges) ? obj.edges : []).forEach((e, i) => {
    if (!e) return;
    const s = String(e.source), t = String(e.target);
    if (!ids.has(s) || !ids.has(t)) { errors.push(`Tie ${i + 1} refers to a missing person; skipped.`); return; }
    if (s === t) { errors.push(`Tie ${i + 1} is a self-loop; skipped.`); return; }
    const w = Number(e.weight ?? 1);
    const type = String(e.type ?? DEFAULT_EDGE_TYPE);
    types.add(type);
    doc.edges.push({ id: String(e.id ?? uid('e')), source: s, target: t, type, weight: Number.isFinite(w) && w > 0 ? w : 1, directed: !!e.directed && !doc.twoMode });
  });
  const same = sameModeEdges(doc).length;
  if (same) warnings.push(`${same} ${same === 1 ? 'tie joins' : 'ties join'} two nodes of the same mode; ${same === 1 ? 'it is' : 'they are'} kept in the drawing but left out of the analysis.`);
  doc.edgeTypes = types.size ? [...types] : [DEFAULT_EDGE_TYPE];
  // Attribute keys present on nodes but not declared become text columns.
  const declared = new Set(doc.attrColumns.map(c => c.key));
  for (const n of doc.nodes) for (const k of Object.keys(n.attrs)) if (!declared.has(k)) { declared.add(k); doc.attrColumns.push({ key: k, type: 'text' }); }
  return { doc, errors, warnings };
}

export function importJSON(text) {
  let obj;
  try { obj = JSON.parse(text); } catch (e) { return { doc: null, errors: [`Not valid JSON: ${e.message}`], warnings: [] }; }
  return validateDoc(obj);
}

// ---- Dataset ---------------------------------------------------------------------

// A drawing becomes a 'full' view of a bounded network the user declared.
// Every tie is a declared event (no time). Edge types become contexts of kind
// 'canvas', so the analysis can filter or weight them like any other context.
//
// Direction: a drawing with no directed ties is undirected; each tie emits one
// event and the analysis symmetrises it when directed=false (source.directed
// says so). In a mixed drawing an undirected tie emits both directions, so a
// directed analysis reads it as the mutual tie the user drew rather than as a
// one-way tie in an arbitrary direction.
//
// Two-mode drawings become two-mode datasets (src/core/model.js): each node
// keeps its mode, each cross-mode tie is an affiliation (declared event from
// the mode-0 node with the mode-1 node as member), undirected, weighted, in
// its tie type's context. Same-mode ties are skipped with a warning.
export function toDataset(doc, { name } = {}) {
  if (!doc.nodes.length) throw new Error('The drawing has no people yet.');
  if (doc.twoMode) return toTwoModeDataset(doc, { name });
  const directed = doc.edges.some(e => e.directed);
  const b = new DatasetBuilder({ name: name || doc.name || 'Drawing' });
  b.beginSource({ format: 'draw', family: 'custom', medium: 'canvas', view: 'full', context: 'custom', directed, fileNames: [] });
  const attrsOf = nodeAttrs(doc);
  const idx = new Map();
  for (const n of doc.nodes) {
    idx.set(n.id, b.node(`draw:${n.id}`, { label: n.label || n.id, attrs: attrsOf(n) }));
    b.stat('nodes');
  }
  const ctx = new Map();
  const ctxFor = type => {
    if (!ctx.has(type)) ctx.set(type, b.context(`draw:type:${slug(type)}`, { name: type, kind: 'canvas', visibility: 'unknown', medium: 'canvas' }));
    return ctx.get(type);
  };
  for (const e of doc.edges) {
    const s = idx.get(e.source), t = idx.get(e.target);
    if (s === undefined || t === undefined) { b.warn('dangling-tie', 'Ties to people who are no longer in the drawing were skipped'); continue; }
    const c = ctxFor(e.type || DEFAULT_EDGE_TYPE);
    b.event({ type: 'declared', actor: s, targets: [[t, 'declared']], context: c, weight: e.weight ?? 1, key: `draw:${e.id}` });
    if (directed && !e.directed) b.event({ type: 'declared', actor: t, targets: [[s, 'declared']], context: c, weight: e.weight ?? 1, key: `draw:${e.id}:rev` });
    b.stat('ties');
  }
  return finish(doc, b);
}

function nodeAttrs(doc) {
  const types = new Map(doc.attrColumns.map(c => [c.key, c.type]));
  const groupName = new Map(doc.groups.map(g => [g.id, g.name]));
  return n => {
    const attrs = {};
    for (const [k, v] of Object.entries(n.attrs || {})) {
      const c = coerce(v, types.get(k) || 'text');
      if (c !== undefined) attrs[k] = c;
    }
    if (n.group && groupName.has(n.group)) attrs[doc.groupKey || 'group'] = groupName.get(n.group);
    return attrs;
  };
}

function toTwoModeDataset(doc, { name } = {}) {
  const b = new DatasetBuilder({ name: name || doc.name || 'Drawing' });
  b.beginSource({ format: 'draw', family: 'custom', medium: 'canvas', view: 'full', context: 'custom', directed: false, fileNames: [] });
  declareTwoMode(b, doc.twoMode.labels);
  const attrsOf = nodeAttrs(doc);
  const mode = new Map();
  for (const n of doc.nodes) {
    addModeNode(b, `draw:${n.id}`, nodeMode(n), { label: n.label || n.id, attrs: attrsOf(n) });
    mode.set(n.id, nodeMode(n));
    b.stat(nodeMode(n) === 0 ? 'mode0' : 'mode1');
  }
  const ctx = new Map();
  const ctxFor = type => {
    if (!ctx.has(type)) ctx.set(type, b.context(`draw:type:${slug(type)}`, { name: type, kind: 'canvas', visibility: 'unknown', medium: 'canvas' }));
    return ctx.get(type);
  };
  for (const e of doc.edges) {
    if (!mode.has(e.source) || !mode.has(e.target)) { b.warn('dangling-tie', 'Ties to people who are no longer in the drawing were skipped'); continue; }
    if (mode.get(e.source) === mode.get(e.target)) { b.warn('same-mode-tie', `Ties between two ${doc.twoMode.labels[0].toLowerCase()} or two ${doc.twoMode.labels[1].toLowerCase()} were left out (a two-mode network ties only across the modes)`); continue; }
    const [a, x] = mode.get(e.source) === 0 ? [e.source, e.target] : [e.target, e.source];
    addAffiliation(b, `draw:${a}`, `draw:${x}`, { weight: e.weight ?? 1, context: ctxFor(e.type || DEFAULT_EDGE_TYPE), key: `draw:${e.id}` });
    b.stat('ties');
  }
  return finish(doc, b);
}

function finish(doc, b) {
  const ds = b.build();
  // The hand layout travels with the dataset (by node index) so a network
  // view can start from the user's own drawing. Optional extension of meta;
  // readers that do not know it ignore it.
  ds.meta.positions = doc.nodes.map(n => [n.x, n.y]);
  // A worked example carries its title and what to look for, so a view can
  // repeat them next to the results.
  if (doc.example) {
    const ex = exampleById(doc.example);
    if (ex) ds.meta.example = { id: doc.example, title: ex.title, lookFor: [...ex.lookFor] };
  }
  return ds;
}
