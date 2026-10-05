// Draw your own network: the editor shell.
//
// State lives here (document history, selection, view, snapping settings,
// transient drag/animation positions); canvas.js renders and turns pointer
// gestures into calls on `ctl`; inspector.js and table.js edit through
// apply(fn, label). The document model and all geometry are pure functions
// in src/builders/draw*.js, tested in Node.

import { html, useState, useEffect, useRef, useMemo, useLayoutEffect } from '../../../../vendor/preact.js';
import * as D from '../../../builders/draw.js';
import { runLayout, LAYOUTS, layoutsFor, concentricKeys } from '../../../builders/draw-layout.js';
import { snapPoint } from '../../../builders/draw-snap.js';
import { uid, slug } from '../../../builders/common.js';
import { storage, downloadText, pickFile, readFileText, prefersReducedMotion, useHandOff, HandOffBar } from '../shared.js';
import { notify } from '../service.js';
import { Canvas, clampK, NODE_R, DASHES, ModeShape } from './canvas.js';
import { Inspector } from './inspector.js';
import { TableEditor } from './table.js';
import { HelpOverlay } from './help.js';
import { EXAMPLES, exampleById, exampleDoc } from './example.js';

const DRAFT_KEY = 'orgsignal.build.draw.draft';
const SETTINGS_KEY = 'orgsignal.build.draw.settings';
const ANIM_MS = 400;
const MODES = [['select', 'Select', 'V'], ['node', 'Add person', 'B'], ['edge', 'Connect', 'C'], ['pan', 'Pan', 'H']];

// The editor's working state outside the drawing itself (undo history, zoom
// and pan, mode, panels) is kept here when the editor unmounts, so leaving
// the Build view and coming back resumes where you were. The drawing is also
// autosaved to storage; this only lives as long as the page.
let kept = null;

function loadDraft() {
  const raw = storage.get(DRAFT_KEY, null);
  if (!raw) return null;
  const { doc } = D.validateDoc(raw);
  return doc;
}

// example: { id, nonce } from the Build view (a #build?example=<id> link); a
// new nonce loads that worked example.
export function DrawEditor({ example = null } = {}) {
  const [hist, setHist] = useState(() => kept?.hist || D.createHistory(loadDraft() || D.emptyDoc()));
  const doc = hist.present;
  const [sel, setSel] = useState(() => kept?.sel || { nodes: [], edges: [] });
  const [focusId, setFocus] = useState(null);
  const [mode, setMode] = useState(() => kept?.mode || 'select');
  const [view, setView] = useState(() => kept?.view || { x: 0, y: 0, k: 1 });
  const [size, setSize] = useState({ w: 0, h: 0 });
  const [settings, setSettings] = useState(() => ({ grid: false, gridSize: 20, guides: true, showGrid: true, ...storage.get(SETTINGS_KEY, {}) }));
  const [live, setLive] = useState(null);
  const [guides, setGuides] = useState([]);
  const [marquee, setMarquee] = useState(null);
  const [rubber, setRubber] = useState(null);
  const [pending, setPending] = useState(null);
  const [editing, setEditing] = useState(null);
  const [table, setTable] = useState(() => kept?.table || false);
  const [help, setHelp] = useState(false);
  const [layout, setLayout] = useState(() => kept?.layout || { id: 'force', root: '', key: 'degree', scope: 'auto' });
  const [edgeDefaults, setEdgeDefaults] = useState(() => kept?.edgeDefaults || { type: D.DEFAULT_EDGE_TYPE, directed: false });
  // Two-mode drawings: which mode a new node gets (0 or 1).
  const [addMode, setAddMode] = useState(() => kept?.addMode || 0);
  const [announce, setAnnounce] = useState('');
  const [saved, setSaved] = useState(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const wrapRef = useRef(null), canvasRef = useRef(null), layoutSel = useRef(null), clip = useRef(null), anim = useRef(0), pasteCount = useRef(0);
  // Keyboard multi-select: once Space is used, Tab moves focus without
  // replacing the selection, so Tab-Space-Tab-Space builds a selection.
  const pinned = useRef(false);

  // Latest state for gesture and key handlers (avoids stale closures).
  const st = useRef();
  st.current = { doc, sel, view, mode, settings, live, pending, focusId, spaceDown, size, edgeDefaults, addMode };

  const apply = (fn, label) => setHist(h => D.commit(h, fn(h.present), label));
  const say = t => setAnnounce(t);
  useEffect(() => { kept = { hist, sel, mode, view, table, layout, edgeDefaults, addMode }; });

  // ---- autosave ----
  useEffect(() => {
    const t = setTimeout(() => setSaved(storage.set(DRAFT_KEY, doc)), 300);
    return () => clearTimeout(t);
  }, [doc]);
  useEffect(() => { storage.set(SETTINGS_KEY, settings); }, [settings]);

  // Drop selection entries that no longer exist (after undo, delete, import).
  useEffect(() => {
    const nodeIds = new Set(doc.nodes.map(n => n.id)), edgeIds = new Set(doc.edges.map(e => e.id));
    if (sel.nodes.some(id => !nodeIds.has(id)) || sel.edges.some(id => !edgeIds.has(id))) {
      setSel({ nodes: sel.nodes.filter(id => nodeIds.has(id)), edges: sel.edges.filter(id => edgeIds.has(id)) });
    }
    if (focusId && !nodeIds.has(focusId)) setFocus(null);
    if (pending && !nodeIds.has(pending)) setPending(null);
    if (edgeDefaults.type && !doc.edgeTypes.includes(edgeDefaults.type)) setEdgeDefaults({ ...edgeDefaults, type: doc.edgeTypes[0] });
    if (!layoutsFor(doc).some(l => l.id === layout.id)) setLayout(x => ({ ...x, id: 'force' }));
  }, [doc]);

  // ---- canvas size, initial fit ----
  useEffect(() => {
    const el = canvasRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      setSize(s => (s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [table]);
  const fitted = useRef(!!kept?.view);
  useEffect(() => {
    if (!fitted.current && size.w) { fitted.current = true; fit(); }
  }, [size.w]);

  // The canvas fills the window below its own top edge (P10: the whole
  // drawing, its zoom controls and the toolbar fit on a laptop screen).
  useLayoutEffect(() => {
    const el = canvasRef.current;
    if (table) el?.parentElement?.style.removeProperty('--ob-canvas-h');
    if (!el || table) return;
    const size = () => {
      const top = el.getBoundingClientRect().top + window.scrollY;
      const statusH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--status-h')) || 0;
      const min = window.innerWidth < 600 ? 300 : 360;
      const h = Math.max(min, Math.round(window.innerHeight - top - statusH - 16));
      el.style.height = `${h}px`;
      // The inspector beside it scrolls within the same height.
      el.parentElement?.style.setProperty('--ob-canvas-h', `${h}px`);
    };
    size();
    window.addEventListener('resize', size);
    return () => window.removeEventListener('resize', size);
  }, [table]);

  function fit(d = st.current.doc) {
    const { w, h } = st.current.size.w ? st.current.size : size;
    if (!w) return;
    const b0 = D.bounds(d.nodes);
    if (!b0) { setView({ x: w / 2, y: h / 2, k: 1 }); return; }
    // Group outlines and their names are drawn around the people, so frame
    // those too (the worked example's second team was cut off at the edge).
    const g = d.groups?.length ? 48 : 0;
    const b = { x: b0.x - g, y: b0.y - g - (g ? 18 : 0), w: b0.w + 2 * g, h: b0.h + 2 * g + (g ? 18 : 0) };
    const pad = w < 600 ? 36 : 60;
    // Names sit under each person, and the status line and zoom buttons along
    // the bottom edge, so leave more room below than above.
    const below = 34;
    const k = clampK(Math.min((w - 2 * pad) / Math.max(b.w, 1), (h - 2 * pad - below) / Math.max(b.h, 1), 1.5));
    setView({ k, x: w / 2 - (b.x + b.w / 2) * k, y: (h - below) / 2 - (b.y + b.h / 2) * k });
  }

  function zoomBy(f) {
    const { w, h } = size;
    setView(v => { const k = clampK(v.k * f); const cx = w / 2, cy = h / 2; return { k, x: cx - ((cx - v.x) / v.k) * k, y: cy - ((cy - v.y) / v.k) * k }; });
  }

  function viewCentre() {
    const { w, h } = st.current.size;
    const v = st.current.view;
    return { x: (w / 2 - v.x) / v.k, y: (h / 2 - v.y) / v.k };
  }

  // ---- commands ----
  // New people start in rename mode (type the name, Enter), and never land on
  // another person or their label.
  function addNodeAt(p, { rename = true } = {}) {
    const s = st.current;
    let q = s.settings.grid || s.settings.guides
      ? snapPoint(p, s.doc.nodes, { grid: s.settings.grid, gridSize: s.settings.gridSize, guides: s.settings.guides, threshold: 6 / s.view.k }) : p;
    const g = s.settings.grid ? s.settings.gridSize : 0;
    const up = v => (g ? Math.ceil(v / g) * g : v);
    q = D.freeSpot(s.doc.nodes, { x: q.x, y: q.y }, { r: NODE_R, clearX: up(56), clearY: up(44) });
    const id = uid('n');
    const m = s.doc.twoMode ? s.addMode : 0;
    const label = D.nextLabel(s.doc, m);
    apply(d => D.addNode(d, { id, x: q.x, y: q.y, label, mode: m }), s.doc.twoMode ? `Add ${D.modeNoun(s.doc.twoMode.labels[m]).toLowerCase()}` : 'Add person');
    setSel({ nodes: [id], edges: [] });
    setFocus(id);
    say(`Added ${label}${s.doc.twoMode ? ` (${D.modeNoun(s.doc.twoMode.labels[m]).toLowerCase()})` : ''}. Type a name and press Enter.`);
    if (rename && !table) setTimeout(() => setEditing({ id, value: label }), 0);
    return id;
  }

  function addEdge(source, target) {
    const s = st.current;
    // Two-mode drawings: a tie must join the two modes; say why not, visibly.
    const why = D.canConnect(s.doc, source, target);
    if (why) { say(why); notify('warn', why); return; }
    const before = s.doc.edges.length;
    const d2 = D.addEdge(s.doc, { source, target, type: s.edgeDefaults.type, directed: s.edgeDefaults.directed });
    if (d2.edges.length === before) { say('That tie already exists.'); return; }
    const e = d2.edges[d2.edges.length - 1];
    apply(d => D.addEdge(d, { id: e.id, source, target, type: e.type, directed: e.directed }), 'Add tie');
    setSel({ nodes: [], edges: [e.id] });
    say(`Connected ${D.nodeById(s.doc, source)?.label} ${e.directed ? 'to' : 'and'} ${D.nodeById(s.doc, target)?.label}.`);
  }

  function deleteSelection() {
    const s = st.current;
    const nodes = s.sel.nodes.length || s.sel.edges.length ? s.sel.nodes : s.focusId ? [s.focusId] : [];
    const edges = s.sel.edges;
    if (!nodes.length && !edges.length) return;
    apply(d => D.removeEdges(D.removeNodes(d, nodes), edges), 'Delete');
    setSel({ nodes: [], edges: [] });
    say(`Deleted ${nodes.length} ${nodes.length === 1 ? 'person' : 'people'}${edges.length ? ` and ${edges.length} tie${edges.length === 1 ? '' : 's'}` : ''}.`);
  }

  function startRename(id) {
    const n = D.nodeById(st.current.doc, id);
    if (!n) return;
    if (table) return;
    setEditing({ id, value: n.label });
  }

  function commitRename(save) {
    if (editing && save) {
      const v = editing.value.trim();
      if (v) apply(d => D.updateNode(d, editing.id, { label: v }), 'Rename');
    }
    setEditing(null);
    canvasRef.current?.querySelector('svg')?.focus({ preventScroll: true });
  }

  function copy() {
    const s = st.current;
    if (!s.sel.nodes.length) return;
    clip.current = D.copySelection(s.doc, s.sel.nodes);
    pasteCount.current = 0;
    say(`Copied ${s.sel.nodes.length} ${s.sel.nodes.length === 1 ? 'person' : 'people'}.`);
  }

  function pasteClip(c = clip.current) {
    if (!c?.nodes?.length) return;
    pasteCount.current += 1;
    const res = D.paste(st.current.doc, c, { offset: 30 * pasteCount.current });
    // Re-run paste inside apply on the same ids so history gets exactly this result.
    apply(() => res.doc, 'Paste');
    setSel({ nodes: res.ids, edges: [] });
    say(`Pasted ${res.ids.length} ${res.ids.length === 1 ? 'person' : 'people'}.`);
  }

  function nudge(dx, dy) {
    const s = st.current;
    const ids = s.sel.nodes.length ? s.sel.nodes : s.focusId ? [s.focusId] : [];
    if (!ids.length) { setView(v => ({ ...v, x: v.x - dx * 2, y: v.y - dy * 2 })); return; }
    const m = new Map(ids.map(id => { const n = D.nodeById(s.doc, id); return [id, { x: n.x + dx, y: n.y + dy }]; }));
    apply(d => D.moveNodes(d, m), 'Nudge');
  }

  // Animate to target positions, then commit once (one undo step).
  function animateTo(target, label) {
    cancelAnimationFrame(anim.current);
    const d0 = st.current.doc;
    if (prefersReducedMotion()) { apply(d => D.moveNodes(d, target), label); return; }
    const from = new Map([...target.keys()].map(id => { const n = D.nodeById(d0, id); return [id, { x: n.x, y: n.y }]; }));
    const t0 = performance.now();
    const step = now => {
      const t = Math.min(1, (now - t0) / ANIM_MS);
      const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
      const m = new Map();
      for (const [id, p] of target) { const f = from.get(id); m.set(id, { x: f.x + (p.x - f.x) * e, y: f.y + (p.y - f.y) * e }); }
      setLive(m);
      if (t < 1) anim.current = requestAnimationFrame(step);
      else { setLive(null); apply(d => D.moveNodes(d, target), label); }
    };
    anim.current = requestAnimationFrame(step);
  }

  const useSelection = layout.scope === 'all' ? false : sel.nodes.length >= 2;
  function applyLayout() {
    const s = st.current;
    const all = !useSelection;
    const ids = all ? s.doc.nodes.map(n => n.id) : s.sel.nodes;
    if (!ids.length) { say('Nothing to lay out yet.'); return; }
    const root = layout.root && ids.includes(layout.root) ? layout.root : (s.sel.nodes[0] && ids.includes(s.sel.nodes[0]) ? s.sel.nodes[0] : undefined);
    const target = runLayout(s.doc, layout.id, ids, { all, root, key: layout.key, seed: 7 });
    if (s.settings.grid) for (const [id, p] of target) target.set(id, { x: Math.round(p.x / s.settings.gridSize) * s.settings.gridSize, y: Math.round(p.y / s.settings.gridSize) * s.settings.gridSize });
    const name = LAYOUTS.find(l => l.id === layout.id).label;
    animateTo(target, `Layout: ${name}`);
    say(`${name} layout applied to ${all ? 'the whole drawing' : `${ids.length} selected people`}.`);
  }

  function doUndo() { setHist(h => { if (D.canUndo(h)) say(`Undid ${D.undoLabel(h)}.`); return D.undo(h); }); }
  function doRedo() { setHist(h => { if (D.canRedo(h)) say(`Redid ${D.redoLabel(h)}.`); return D.redo(h); }); }

  function loadDoc(d, label) {
    apply(() => d, label);
    setSel({ nodes: [], edges: [] });
    setFocus(null);
    // Fit now, and again once the canvas has settled to its final size.
    setTimeout(() => fit(d), 0);
    setTimeout(() => fit(d), 300);
  }

  // Replacing a drawing asks first (Undo also brings it back, M12).
  const replaceOk = what => !st.current.doc.nodes.length
    || confirm(`${what} The current drawing (${st.current.doc.nodes.length} ${st.current.doc.nodes.length === 1 ? 'person' : 'people'}) is cleared; Undo brings it back.`);
  function newDrawing() {
    if (!replaceOk('Start a new drawing?')) return;
    loadDoc(D.emptyDoc(), 'New drawing');
    say('New drawing. Undo brings the previous one back.');
  }
  function loadExample(id) {
    const ex = exampleById(id), d = exampleDoc(id);
    if (!ex || !d) { notify('warn', `There is no drawing example called "${id}".`); return; }
    const cur = st.current.doc;
    if (cur.example === ex.id && cur.nodes.length === d.nodes.length && cur.edges.length === d.edges.length) return;
    if (!replaceOk(`Open the example "${ex.title}"?`)) return;
    loadDoc(d, `Example: ${ex.title}`);
    say(`Loaded the example ${ex.title}: ${d.nodes.length} people, ${d.edges.length} ties.`);
  }
  useEffect(() => { if (example?.id) loadExample(example.id); }, [example?.nonce]);

  // Turn the drawing two-mode or back; say what happened to existing ties.
  function toggleTwoMode(on, labels) {
    const r = D.setTwoMode(st.current.doc, on, labels);
    if (r.doc === st.current.doc) return;
    apply(() => r.doc, on ? 'Two-mode drawing' : 'One-mode drawing');
    let msg;
    if (!on) msg = 'The drawing is one-mode again: everyone is one kind of node and every tie counts.';
    else if (!st.current.doc.nodes.length) msg = `Two-mode drawing: place ${r.doc.twoMode.labels[0].toLowerCase()} and ${r.doc.twoMode.labels[1].toLowerCase()} (choose which in the toolbar, or press M) and tie them across.`;
    else if (r.assigned === 'colouring') msg = `Two-mode drawing: the ties already alternate between two sides, so those became ${r.doc.twoMode.labels[0].toLowerCase()} and ${r.doc.twoMode.labels[1].toLowerCase()}. Change any node's mode in the panel.`;
    else msg = `Two-mode drawing: everyone starts as ${r.doc.twoMode.labels[0].toLowerCase()}. ${r.sameMode ? `The ${r.sameMode} existing ${r.sameMode === 1 ? 'tie joins' : 'ties join'} two of the same mode, so ${r.sameMode === 1 ? 'it is' : 'they are'} kept but left out of the analysis until you change modes or delete ${r.sameMode === 1 ? 'it' : 'them'}.` : ''} Set each node's mode in the panel or the table.`;
    notify('info', msg);
    say(msg);
  }

  async function importFile() {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    const { doc: d, errors, warnings } = D.importJSON(await readFileText(f));
    if (!d) { notify('error', `Could not import ${f.name}: ${errors.join(' ')}`); return; }
    loadDoc(d, 'Import drawing');
    const extra = [...errors, ...warnings];
    notify(extra.length ? 'warn' : 'info', `Imported ${f.name}: ${d.nodes.length} people, ${d.edges.length} ties.${extra.length ? ' ' + extra.slice(0, 3).join(' ') + (extra.length > 3 ? ` (+${extra.length - 3} more)` : '') : ''}`);
  }

  // ---- keyboard ----
  function onKeyDown(e) {
    const t = e.target;
    if (t.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    if (help) return;
    const s = st.current;
    const mod = e.metaKey || e.ctrlKey;
    const key = e.key;
    const onCanvas = t.closest?.('.ob-canvas');
    const handled = () => { e.preventDefault(); e.stopPropagation(); };
    if (mod) {
      const k = key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { handled(); doUndo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { handled(); doRedo(); }
      else if (k === 'c' && onCanvas) { handled(); copy(); }
      else if (k === 'v' && onCanvas) { handled(); pasteClip(); }
      else if (k === 'd' && onCanvas) { handled(); if (s.sel.nodes.length) { pasteCount.current = 0; pasteClip(D.copySelection(s.doc, s.sel.nodes)); } }
      else if (k === 'a' && onCanvas) { handled(); setSel({ nodes: s.doc.nodes.map(n => n.id), edges: [] }); say(`Selected all ${s.doc.nodes.length} people.`); }
      return;
    }
    if (key === '?') { handled(); setHelp(true); return; }
    if (key === 't' || key === 'T') { handled(); setTable(x => !x); return; }
    if (key === 'l' || key === 'L') { handled(); layoutSel.current?.focus(); return; }
    if (!onCanvas) return;
    switch (key) {
      case 'v': case 'V': handled(); setMode('select'); say('Select mode.'); break;
      case 'b': case 'B': handled(); setMode('node'); say(s.doc.twoMode ? `Add mode: click the canvas to place a ${D.modeNoun(s.doc.twoMode.labels[s.addMode]).toLowerCase()}.` : 'Add-person mode: click the canvas to place a person.'); break;
      case 'm': case 'M': if (s.doc.twoMode) { handled(); const m = 1 - s.addMode; setAddMode(m); say(`New nodes are now ${s.doc.twoMode.labels[m].toLowerCase()}.`); } break;
      case 'c': case 'C': handled(); setMode('edge'); say('Connect mode: drag from one person to another.'); break;
      case 'h': case 'H': handled(); setMode('pan'); say('Pan mode.'); break;
      case 'n': case 'N': handled(); addNodeAt(viewCentre()); break;
      case 'g': case 'G': handled(); setSettings(x => ({ ...x, grid: !x.grid })); say(`Snap to grid ${s.settings.grid ? 'off' : 'on'}.`); break;
      case '+': case '=': handled(); zoomBy(1.25); break;
      case '-': case '_': handled(); zoomBy(0.8); break;
      case '0': handled(); fit(); break;
      case 'Escape': handled(); pinned.current = false; setSel({ nodes: [], edges: [] }); setFocus(null); setPending(null); setMode('select'); break;
      case 'Delete': case 'Backspace': handled(); deleteSelection(); break;
      case 'Enter': case 'F2': { const id = s.focusId || s.sel.nodes[0]; if (id) { handled(); startRename(id); } break; }
      case 'e': case 'E': {
        handled();
        let ids = s.sel.nodes;
        if (ids.length === 1 && s.focusId && s.focusId !== ids[0]) ids = [ids[0], s.focusId];
        if (ids.length < 2) { say('Select two or more people to connect (Space adds the focused person).'); break; }
        if (ids.length === 2) addEdge(ids[0], ids[1]);
        else if (s.doc.twoMode) { const n0 = s.doc.edges.length; const d2 = D.connectPath(s.doc, ids, { type: s.edgeDefaults.type }); apply(() => d2, 'Connect'); say(`Connected ${d2.edges.length - n0} pairs in order; pairs of the same mode were skipped.`); }
        else { apply(d => D.connectPath(d, ids, { type: s.edgeDefaults.type, directed: s.edgeDefaults.directed }), 'Connect'); say(`Connected ${ids.length} people in order.`); }
        break;
      }
      case ' ': {
        handled();
        if (!s.focusId) break;
        const has = s.sel.nodes.includes(s.focusId);
        const label = D.nodeById(s.doc, s.focusId).label;
        if (!pinned.current) {
          // First Space keeps what Tab selected and starts a multi-selection.
          pinned.current = true;
          if (!has) setSel({ nodes: [...s.sel.nodes, s.focusId], edges: [] });
          say(`${label} kept in the selection; Tab moves on, Space adds or removes.`);
          break;
        }
        setSel({ nodes: has ? s.sel.nodes.filter(x => x !== s.focusId) : [...s.sel.nodes, s.focusId], edges: [] });
        say(`${label} ${has ? 'removed from' : 'added to'} the selection.`);
        break;
      }
      case 'Tab': {
        const ns = s.doc.nodes;
        if (!ns.length) break;
        const i = ns.findIndex(n => n.id === s.focusId);
        const j = e.shiftKey ? (i < 0 ? ns.length - 1 : i - 1) : i + 1;
        if (j < 0 || j >= ns.length) { setFocus(null); break; } // let focus leave the canvas
        handled();
        const n = ns[j];
        setFocus(n.id);
        if (!pinned.current) setSel({ nodes: [n.id], edges: [] });
        ensureVisible(n);
        say(`${n.label}, ${s.doc.twoMode ? D.modeNoun(s.doc.twoMode.labels[D.nodeMode(n)]).toLowerCase() : 'person'} ${j + 1} of ${ns.length}${n.group ? ', group ' + (D.groupById(s.doc, n.group)?.name ?? '') : ''}, ${s.doc.edges.filter(x => x.source === n.id || x.target === n.id).length} ties.`);
        break;
      }
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        handled();
        const stepPx = (s.settings.grid ? s.settings.gridSize : 10) * (e.shiftKey ? 5 : 1);
        nudge(key === 'ArrowLeft' ? -stepPx : key === 'ArrowRight' ? stepPx : 0, key === 'ArrowUp' ? -stepPx : key === 'ArrowDown' ? stepPx : 0);
        break;
      }
      default:
    }
  }

  function ensureVisible(n) {
    const { w, h } = st.current.size;
    const v = st.current.view;
    const sx = n.x * v.k + v.x, sy = n.y * v.k + v.y;
    if (sx < 40 || sx > w - 40 || sy < 40 || sy > h - 40) setView({ ...v, x: w / 2 - n.x * v.k, y: h / 2 - n.y * v.k });
  }

  // Space held = temporary pan (like design tools). Tracked on the window so
  // releasing outside the canvas still clears it.
  useEffect(() => {
    const down = e => {
      if (e.key === ' ' && e.target.closest?.('.ob-canvas') && !st.current.focusId) setSpaceDown(true);
      // Undo and redo also work when focus has fallen back to the page or the
      // view heading (after a row or a button that had focus was removed), as
      // long as the editor is on screen.
      const ae = document.activeElement;
      if ((e.metaKey || e.ctrlKey) && (!ae || ae === document.body || ae.classList?.contains('view__title'))) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
        else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); doRedo(); }
      }
    };
    const up = e => { if (e.key === ' ') setSpaceDown(false); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); cancelAnimationFrame(anim.current); };
  }, []);

  const ctl = useMemo(() => ({}), []);
  Object.assign(ctl, {
    get: () => st.current,
    setView, setSel: v => { pinned.current = false; setSel(v); }, setLive, setGuides, setMarquee, setRubber, setPending, setFocus,
    commitMove: m => apply(d => D.moveNodes(d, m), 'Move'),
    addNodeAt, addEdge, startRename,
    onCanvasFocus: () => {},
  });

  // ---- render ----
  const nodeIds = doc.nodes.map(n => n.id);
  const keys = concentricKeys(doc);
  const editPos = editing && (() => { const n = D.nodeById(doc, editing.id); return n ? { left: n.x * view.k + view.x - 64, top: n.y * view.k + view.y + 12 } : null; })();
  const modeLabel = MODES.find(m => m[0] === mode)[1];
  const handoff = useHandOff(() => D.toDataset(doc, { name: doc.name }));
  // Tie types are drawn with dashes only when there is more than one in use,
  // and then the key below names them (V17).
  const usedTypes = doc.edgeTypes.filter(t => doc.edges.some(e => e.type === t));
  // One-way and two-way ties together make a directed network that counts
  // each two-way tie twice (L1); the note under the canvas says so.
  const mixed = !doc.twoMode && doc.edges.some(e => e.directed) && doc.edges.some(e => !e.directed);
  const sameMode = D.sameModeEdges(doc);
  const tm = doc.twoMode;
  const nouns = tm ? tm.labels.map(D.modeNoun) : null;
  const modeCount = m => doc.nodes.filter(n => D.nodeMode(n) === m).length;
  const fileMenu = useRef(null);
  const fileAction = fn => () => { if (fileMenu.current) fileMenu.current.open = false; fn(); };

  const arrange = html`<div class="ob-stack ob-arrange" style="gap:.6rem">
    <h3 class="label">Arrange</h3>
    <div class="ob-row" role="group" aria-label="Layout" style="gap:.4rem">
      <label class="visually-hidden" for="ob-draw-layout">Layout (L)</label>
      <select id="ob-draw-layout" class="select select--sm" style="width:auto" ref=${layoutSel} value=${layout.id} onChange=${e => setLayout({ ...layout, id: e.currentTarget.value })}>
        ${layoutsFor(doc).map(l => html`<option value=${l.id}>${l.label}</option>`)}</select>
      ${layout.id === 'tree' ? html`<select class="select select--sm" style="width:auto;max-width:9rem" aria-label="Tree root" value=${layout.root} onChange=${e => setLayout({ ...layout, root: e.currentTarget.value })}>
        <option value="">Root: first selected</option>${doc.nodes.map(n => html`<option value=${n.id}>${n.label}</option>`)}</select>` : null}
      ${layout.id === 'concentric' ? html`<select class="select select--sm" style="width:auto" aria-label="Rings by" value=${layout.key} onChange=${e => setLayout({ ...layout, key: e.currentTarget.value })}>
        ${keys.map(k => html`<option value=${k}>By ${k}</option>`)}</select>` : null}
      ${sel.nodes.length >= 2 ? html`<select class="select select--sm" style="width:auto" aria-label="Apply layout to" value=${layout.scope === 'all' ? 'all' : 'auto'} onChange=${e => setLayout({ ...layout, scope: e.currentTarget.value })}>
        <option value="auto">Selection (${sel.nodes.length})</option><option value="all">Whole drawing</option></select>` : null}
      <button type="button" class="btn btn--sm" disabled=${!doc.nodes.length} onClick=${applyLayout}>Apply layout</button>
    </div>
    <div class="ob-row" style="gap:.4rem 1rem">
      <label class="check"><input type="checkbox" checked=${settings.grid} onChange=${e => setSettings(x => ({ ...x, grid: e.currentTarget.checked }))} /> Snap to grid (G)</label>
      <label class="visually-hidden" for="ob-draw-gridsize">Grid size</label>
      <select id="ob-draw-gridsize" class="select select--sm" style="width:auto" value=${settings.gridSize} onChange=${e => setSettings(x => ({ ...x, gridSize: +e.currentTarget.value }))}>
        ${[10, 20, 25, 40, 50].map(v => html`<option value=${v}>${v} px</option>`)}</select>
      <label class="check"><input type="checkbox" checked=${settings.guides} onChange=${e => setSettings(x => ({ ...x, guides: e.currentTarget.checked }))} /> Snap to other people</label>
    </div>
  </div>`;

  return html`<div class="ob-stack ob-draw" ref=${wrapRef} onKeyDown=${onKeyDown}>
    <div class="ob-toolbar" role="toolbar" aria-label="Drawing tools">
      ${table ? null : html`<div class="seg" role="group" aria-label="Mode">
        ${MODES.map(([id, label, k]) => html`<button type="button" aria-pressed=${String(mode === id)} title=${`${label} (${k})`}
          onClick=${() => { setMode(id); setPending(null); }}>${id === 'node' && tm ? 'Add' : label}</button>`)}
      </div>`}
      ${tm ? html`<div class="seg ob-addmode" role="group" aria-label="Kind of node to add (M switches)">
        ${[0, 1].map(m => html`<button type="button" aria-pressed=${String(addMode === m)} title=${`New nodes are ${tm.labels[m].toLowerCase()} (M switches)`}
          onClick=${() => { setAddMode(m); if (!table) setMode('node'); say(`New nodes are now ${tm.labels[m].toLowerCase()}.`); }}><${ModeShape} mode=${m} /> ${nouns[m]}</button>`)}
      </div>` : null}
      <div class="ob-row ob-iconrow" style="gap:.25rem">
        <button type="button" class="btn btn--sm ob-icon" disabled=${!D.canUndo(hist)} onClick=${doUndo}
          aria-label=${D.undoLabel(hist) ? 'Undo ' + D.undoLabel(hist) : 'Undo'} title=${(D.undoLabel(hist) ? 'Undo ' + D.undoLabel(hist) : 'Undo') + ' (Cmd/Ctrl+Z)'}>${ICON.undo}</button>
        <button type="button" class="btn btn--sm ob-icon" disabled=${!D.canRedo(hist)} onClick=${doRedo}
          aria-label=${D.redoLabel(hist) ? 'Redo ' + D.redoLabel(hist) : 'Redo'} title=${(D.redoLabel(hist) ? 'Redo ' + D.redoLabel(hist) : 'Redo') + ' (Cmd/Ctrl+Shift+Z)'}>${ICON.redo}</button>
        ${table ? null : html`<button type="button" class="btn btn--sm" disabled=${!sel.nodes.length && !sel.edges.length} onClick=${deleteSelection}>Delete</button>`}
      </div>
      <span class="ob-spacer"></span>
      <div class="seg" role="group" aria-label="Edit as">
        <button type="button" aria-pressed=${String(!table)} onClick=${() => setTable(false)}>Canvas</button>
        <button type="button" aria-pressed=${String(table)} onClick=${() => setTable(true)} title="Table (T)">Table</button>
      </div>
      <details class="ob-menu" ref=${fileMenu}>
        <summary class="btn btn--sm">File</summary>
        <div class="ob-menu__list" role="group" aria-label="File">
          <button type="button" class="tlink" onClick=${fileAction(newDrawing)}>New drawing</button>
          <span class="label ob-menu__label">Start from an example</span>
          ${DRAW_EXAMPLES.map(x => html`<button type="button" class="tlink" onClick=${fileAction(() => loadExample(x.id))}>${x.title}</button>`)}
          <span class="label ob-menu__label">Kind of drawing</span>
          <button type="button" class="tlink" onClick=${fileAction(() => toggleTwoMode(!tm))}>${tm ? 'Make it one-mode' : 'Two-mode drawing (people and events)'}</button>
          <span class="label ob-menu__label">Files</span>
          <button type="button" class="tlink" onClick=${fileAction(importFile)}>Import JSON</button>
          <button type="button" class="tlink" disabled=${!doc.nodes.length} onClick=${fileAction(() => downloadText(`${slug(doc.name)}.drawing.json`, D.exportJSON(doc), 'application/json'))}>Export JSON</button>
        </div>
      </details>
      <button type="button" class="btn btn--sm btn--quiet" onClick=${() => setHelp(true)} aria-label="How to draw, and keyboard shortcuts" title="How to draw (?)">?</button>
      <button type="button" class="btn btn--primary" disabled=${!nodeIds.length || handoff.busy} onClick=${() => handoff.run('replace')}>Analyze this network</button>
    </div>

    ${doc.example && exampleById(doc.example) ? html`<${ExampleNote} ex=${exampleById(doc.example)} />` : null}
    <div class="ob-editor">
      ${table
        ? html`<div class="ob-draw-tablecol" key="table" ref=${canvasRef}><${TableEditor} doc=${doc} apply=${apply} edgeDefaults=${edgeDefaults} say=${say} /></div>`
        : html`<div class=${'ob-canvas mode-' + mode + (spaceDown ? ' panning' : '')} key="canvas" ref=${canvasRef}>
          <${Canvas} doc=${doc} live=${live} sel=${sel} focusId=${focusId} pending=${pending} view=${view} size=${size}
            settings=${settings} guides=${guides} marquee=${marquee} rubber=${rubber} ctl=${ctl} mode=${mode} dashed=${usedTypes.length > 1} />
          ${doc.nodes.length ? null : html`<div class="ob-hint"><div class="ob-stack" style="gap:.6rem;align-items:center">
            <p>Choose Add person and click here (or double-click, or press N) to place a person; type the name and press Enter. Then choose Connect and click two people to tie them.</p>
            <p class="ob-hint__examples">Or start from an example:${DRAW_EXAMPLES.slice(0, 3).map(x => html` <button type="button" class="tlink" onClick=${() => loadExample(x.id)}>${x.title}</button>`)}; more in File.</p>
          </div></div>`}
          ${editPos ? html`<input class="input ob-label-edit" style=${`left:${Math.max(4, editPos.left)}px;top:${editPos.top}px;width:8rem`} aria-label="Name"
            value=${editing.value} ref=${el => el && document.activeElement !== el && (el.focus(), el.select())}
            onInput=${e => setEditing({ ...editing, value: e.currentTarget.value })}
            onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); commitRename(true); } else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); commitRename(false); } }}
            onBlur=${() => commitRename(true)} />` : null}
          ${usedTypes.length > 1 ? html`<${TypeKey} types=${doc.edgeTypes} used=${usedTypes} />` : null}
          ${tm ? html`<div class="ob-modekey" aria-label="Key: shapes show the mode">${[0, 1].map(m => html`<span><${ModeShape} mode=${m} /> ${tm.labels[m]} (${modeCount(m)})</span>`)}</div>` : null}
          <div class="ob-status" aria-hidden="true">${mode === 'node' && tm ? `Add ${nouns[addMode].toLowerCase()}` : modeLabel}${pending ? ' · from ' + (D.nodeById(doc, pending)?.label ?? '') : ''} · ${Math.round(view.k * 100)}%${settings.grid ? ' · grid ' + settings.gridSize : ''}</div>
          <div class="ob-zoom">
            <button type="button" class="btn btn--sm" aria-label="Zoom out" onClick=${() => zoomBy(0.8)}>−</button>
            <button type="button" class="btn btn--sm" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
            <button type="button" class="btn btn--sm" onClick=${() => fit()}>Fit</button>
          </div>
        </div>`}
      <aside class="ob-inspector" aria-label="Selection details">
        <${Inspector} doc=${doc} sel=${sel} apply=${apply} setSel=${setSel} edgeDefaults=${edgeDefaults} setEdgeDefaults=${setEdgeDefaults} onRename=${startRename} onTwoMode=${toggleTwoMode} />
        ${table ? null : arrange}
      </aside>
    </div>

    <p id="ob-draw-live" class="visually-hidden" aria-live="polite">${announce}</p>
    <p class="ob-note">${tm ? `${modeCount(0)} ${tm.labels[0].toLowerCase()}, ${modeCount(1)} ${tm.labels[1].toLowerCase()}` : `${doc.nodes.length} ${doc.nodes.length === 1 ? 'person' : 'people'}`}, ${doc.edges.length} ${doc.edges.length === 1 ? 'tie' : 'ties'}. ${saved === false ? 'Autosave is not available in this browser; export the drawing to keep it.' : 'Draft saved in this browser.'}
      ${doc.nodes.length ? (tm ? ` Analyzing makes a two-mode network: ${tm.labels[0].toLowerCase()} tied to the ${tm.labels[1].toLowerCase()} they belong to; the construction settings also offer each projection.` : ' Analyzing makes a full network of declared ties.') : ''}</p>
    ${sameMode.length ? html`<p class="ob-note ob-warn" role="status">${sameMode.length} ${sameMode.length === 1 ? 'tie joins' : 'ties join'} two nodes of the same mode (${sameMode.slice(0, 3).map(e => `${D.nodeById(doc, e.source)?.label} and ${D.nodeById(doc, e.target)?.label}`).join('; ')}${sameMode.length > 3 ? '; ...' : ''}). A two-mode network ties only ${tm.labels[0].toLowerCase()} to ${tm.labels[1].toLowerCase()}, so ${sameMode.length === 1 ? 'it is' : 'they are'} left out of the analysis. Change a node's mode or delete the tie.</p>` : null}
    ${mixed ? html`<p class="ob-note ob-warn" role="status">This drawing mixes one-way ties (arrows) and two-way ties, so it is analyzed as a directed network in which each two-way tie counts as two: the ${doc.edges.length} ties drawn here become ${doc.edges.length + doc.edges.filter(e => !e.directed).length} in Network. Make every tie two-way (or every tie one-way) to keep the counts the same.</p>` : null}
    <${HandOffBar} compact=${true} handoff=${handoff} disabled=${!nodeIds.length} build=${() => D.toDataset(doc, { name: doc.name })} />
    ${help ? html`<${HelpOverlay} onClose=${() => setHelp(false)} />` : null}
  </div>`;
}

const DRAW_EXAMPLES = EXAMPLES.filter(x => x.kind === 'draw');

// What a worked example is for, above the canvas while it is loaded.
function ExampleNote({ ex }) {
  return html`<details class="ob-example" open>
    <summary><span class="label">Worked example</span> <strong>${ex.title}</strong>: what to look for</summary>
    <p class="ob-note">${ex.summary} Choose Analyze this network, then check:</p>
    <ul class="ob-notes">${ex.lookFor.map(t => html`<li>${t}</li>`)}</ul>
  </details>`;
}

const ICON = {
  undo: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5.5 4 L2.5 7 L5.5 10" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M2.5 7 H10 a3.5 3.5 0 0 1 0 7 H7" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  redo: html`<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M10.5 4 L13.5 7 L10.5 10" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M13.5 7 H6 a3.5 3.5 0 0 0 0 7 H9" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
};

// Key for tie types, shown on the canvas when more than one type is in use.
function TypeKey({ types, used }) {
  return html`<div class="ob-typekey">
    ${used.map(t => html`<span><svg width="26" height="8" aria-hidden="true"><line x1="1" y1="4" x2="25" y2="4" stroke-dasharray=${DASHES[types.indexOf(t) % DASHES.length] || undefined} /></svg>${t}</span>`)}
  </div>`;
}

export default DrawEditor;
