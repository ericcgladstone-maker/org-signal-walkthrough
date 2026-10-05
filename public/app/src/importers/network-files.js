// Network files: GraphML, GEXF (1.1draft, 1.2draft, 1.3), GML, Pajek .net,
// UCINET DL, Gephi spreadsheet CSVs (edge + node tables, adjacency matrix),
// generic CSV edge lists and headerless whitespace edge lists.
//
// Spec: docs/formats/network-files.md. These are declared-tie formats: every
// edge becomes a 'declared' event from source to target. Each file is its own
// source with view 'full' (the producer decided the boundary; we cannot know
// how it was observed) and a `directed` flag, because an undirected edge is
// stored once (a -> b) and analysis must know not to read direction into it.
//
// Every reader produces the same intermediate graph
//   { directed, nodes: Map(id -> { label, attrs }), edges: [{ s, t, w, times[], relation }], warns[] }
// and one emitter writes it to the DatasetBuilder, so the formats differ only
// in parsing.

import { parseXml, kids, kid, descend, sniffRoot } from './xml.js';
import { parseCSV, headerRow, entryText, parseTimestamp } from './tabular.js';
import { peek } from '../core/fileset.js';
import { MODE_ATTR, DEFAULT_MODE_LABELS, modeValue, declareTwoMode } from '../core/model.js';

const XML_EXT = /\.(graphml|xml|gexf)$/i;
const TEXT_EXT = /\.(gml|net|paj|dl|txt|dat|edgelist|edges|ncol|el|csv|tsv)$/i;
const MAX_SNIFF = 400; // do not peek thousands of files in a big export

// ---- detection ---------------------------------------------------------------

const SRC_ALIASES = ['source', 'from', 'sender', 'ego', 'src', 'node1', 'actor', 'i', 'u'];
const TGT_ALIASES = ['target', 'to', 'receiver', 'recipient', 'alter', 'dst', 'node2', 'j', 'v'];
const W_ALIASES = ['weight', 'value', 'count', 'n', 'strength'];
const T_ALIASES = ['time', 'timestamp', 'date', 'datetime', 'created_at'];
const TYPE_ALIASES = ['type', 'relation', 'tie', 'kind'];

// Classify one entry from its name and first bytes. Returns { kind, score, reason } or null.
async function classify(entry) {
  const rel = entry.rel;
  if (XML_EXT.test(rel)) {
    const head = await peek(entry, 8192);
    const root = sniffRoot(head);
    if (!root) return null;
    if (root.local === 'graphml') {
      if (/schema\.networkcanvas\.com/.test(head) || /networkCanvasUUID/.test(head)) {
        return { kind: 'graphml', score: 0.3, reason: 'GraphML from Network Canvas (the Network Canvas importer reads these better)' };
      }
      return { kind: 'graphml', score: 0.9, reason: 'GraphML document' };
    }
    if (root.local === 'gexf') return { kind: 'gexf', score: 0.9, reason: 'GEXF document' };
    return null;
  }
  if (!TEXT_EXT.test(rel)) return null;
  const head = (await peek(entry, 4096)).replace(/^﻿/, '');
  const firstLines = head.split(/\r?\n/);
  // Pajek: first non-comment line *Vertices N or *Network.
  const firstReal = firstLines.find(l => l.trim() && !/^\s*%/.test(l)) ?? '';
  if (/^\s*\*(vertices\s+\d+|network\b)/i.test(firstReal)) return { kind: 'pajek', score: 0.9, reason: 'Pajek .net (*Vertices header)' };
  if (/^\s*dl\b/i.test(firstReal) && /\bdata\s*:/i.test(head)) return { kind: 'dl', score: 0.9, reason: 'UCINET DL (starts with DL)' };
  // GML: optional comments / Creator / Version, then "graph [".
  const gmlBody = head.replace(/#[^\n]*/g, '').replace(/^\s*(creator\s+"[^"]*"\s*|version\s+\S+\s*)*/i, '');
  if (/^\s*graph\s*\[/i.test(gmlBody)) return { kind: 'gml', score: 0.9, reason: 'GML (graph [ ... ])' };
  if (/\.(csv|tsv)$/i.test(rel) || /\.txt$/i.test(rel)) {
    const header = (await headerRow(entry)).map(h => String(h).trim());
    const low = header.map(h => h.toLowerCase());
    if (low.includes('source') && low.includes('target')) return { kind: 'gephi-edges', score: 0.8, reason: 'Gephi edge table (Source and Target columns)' };
    if (/\.(csv|tsv)$/i.test(rel) && header.length >= 2 && header[0] === '' && header.slice(1).every(h => h !== '')) {
      return { kind: 'matrix', score: 0.6, reason: 'Adjacency matrix CSV (empty top-left cell)' };
    }
    if (low.includes('id') && (low.includes('label') || low.includes('timeset') || low.length > 1) && !low.some(h => TGT_ALIASES.includes(h))) {
      return { kind: 'gephi-nodes', score: 0.8, reason: 'Gephi node table (Id column)' };
    }
    const si = low.findIndex(h => SRC_ALIASES.includes(h));
    const ti = low.findIndex(h => TGT_ALIASES.includes(h));
    if (si >= 0 && ti >= 0 && si !== ti) return { kind: 'csv-edgelist', score: 0.55, reason: `Edge list CSV (columns "${header[si]}" and "${header[ti]}")` };
  }
  if (/\.(txt|edgelist|edges|ncol|el|dat|tsv)$/i.test(rel) && looksLikeEdgeList(firstLines)) {
    return { kind: 'edgelist', score: 0.5, reason: 'Plain edge list (two or three columns per line)' };
  }
  return null;
}

function looksLikeEdgeList(lines) {
  let n = 0;
  for (const l of lines.slice(0, 30)) {
    const s = l.trim();
    if (!s || s[0] === '#' || s[0] === '%') continue;
    const t = splitEdgeLine(s);
    if (!t || t.length < 2 || t.length > 3) return false;
    n++;
  }
  return n > 0;
}

// "a b", "a b 2", "a,b,2", "a b {'weight': 2}" (networkx write_edgelist default).
function splitEdgeLine(s) {
  let dict = null;
  const brace = s.indexOf('{');
  if (brace >= 0) { dict = s.slice(brace); s = s.slice(0, brace).trim(); }
  const toks = s.split(/[\s,;]+/).filter(Boolean);
  if (dict) {
    const m = /['"]weight['"]\s*:\s*([-+0-9.eE]+)/.exec(dict);
    toks.push(m ? m[1] : '1');
  }
  return toks;
}

// Generic shapes (an edge-list CSV, two-column text, an Id table, a matrix)
// also occur inside platform exports (LinkedIn messages.csv has FROM/TO
// columns, Reddit CSVs have id columns, X archives hold .txt files). They only
// count as a network-file drop when little else is there; a folder full of
// other data files is somebody else's export.
const WEAK = new Set(['csv-edgelist', 'edgelist', 'gephi-nodes', 'matrix']);
const DATA_FILE = /\.(json|js|ndjson|jsonl|html?|csv|tsv|txt|xml|db|sqlite|mbox|ics|car)$/i;

async function detect(fs) {
  const hits = [];
  let sniffed = 0;
  for (const e of fs.entries) {
    if (!XML_EXT.test(e.rel) && !TEXT_EXT.test(e.rel)) continue;
    if (++sniffed > MAX_SNIFF) break;
    const c = await classify(e).catch(() => null);
    if (c) hits.push({ rel: e.rel, ...c });
  }
  // A node table only rides along with a real Gephi edge table (Source/Target).
  const used = hits.filter(h => h.kind !== 'gephi-nodes' || hits.some(x => x.kind === 'gephi-edges'));
  if (!used.length) return { score: 0, reason: 'No network files found', files: [] };
  const claimed = new Set(used.map(h => h.rel));
  const others = fs.entries.filter(e => !claimed.has(e.rel) && DATA_FILE.test(e.rel));
  const platformLike = others.length >= 2 || others.some(e => /\.(json|js|ndjson|jsonl|html?)$/i.test(e.rel));
  if (platformLike) {
    for (const h of used) if (WEAK.has(h.kind)) { h.score = Math.min(h.score, 0.3); h.reason += ' (but the folder holds other data files, so it may be another export)'; }
  }
  const best = used.reduce((a, b) => (b.score > a.score ? b : a));
  const kinds = [...new Set(used.map(h => h.kind))];
  return { score: best.score, reason: `${best.reason}${used.length > 1 ? ` (+${used.length - 1} more file${used.length > 2 ? 's' : ''}: ${kinds.join(', ')})` : ''}`, files: used.map(h => h.rel) };
}

// ---- shared helpers ------------------------------------------------------------

function newGraph(directed = null) { return { directed, nodes: new Map(), edges: [], warns: [], stats: {} }; }

function addNode(g, id, label, attrs) {
  id = String(id);
  let n = g.nodes.get(id);
  if (!n) { n = { label: null, attrs: {} }; g.nodes.set(id, n); }
  if (label != null && label !== '') n.label = String(label);
  if (attrs) Object.assign(n.attrs, attrs);
  return n;
}

function warn(g, code, message, count = 1) {
  const w = g.warns.find(x => x.code === code);
  if (w) w.count += count; else g.warns.push({ code, message, count });
}

function num(v) {
  if (typeof v === 'number') return v;
  const s = String(v ?? '').trim();
  if (!s) return NaN;
  if (/^[-+]?inf(inity)?$/i.test(s)) return s[0] === '-' ? -Infinity : Infinity;
  return /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s) ? Number(s) : NaN;
}

// Value -> number / boolean / string according to a declared type.
function typed(v, type) {
  const t = String(type || 'string').toLowerCase();
  const s = String(v ?? '').trim();
  if (['int', 'integer', 'long', 'short', 'byte', 'biginteger', 'float', 'double', 'bigdecimal'].includes(t)) {
    const n = num(s);
    return Number.isNaN(n) ? s : n;
  }
  if (t === 'boolean') {
    if (/^(true|1)$/i.test(s)) return true;
    if (/^(false|0)$/i.test(s)) return false;
    return s;
  }
  return String(v ?? '');
}

// Infer a column type from string values (CSV). Returns a converter.
function inferConverter(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(v => v !== '');
  if (!vals.length) return v => v;
  if (vals.every(v => !Number.isNaN(num(v)))) return v => { const n = num(v); return Number.isNaN(n) ? v : n; };
  if (vals.every(v => /^(true|false)$/i.test(v))) return v => (/^true$/i.test(String(v).trim()) ? true : /^false$/i.test(String(v).trim()) ? false : v);
  return v => v;
}

// Time value per GEXF timeformat / generic ISO. Numbers are not dates.
function timeValue(v, timeformat) {
  const s = String(v ?? '').trim();
  if (!s) return { ms: NaN, numeric: false };
  const tf = String(timeformat || 'double').toLowerCase();
  if (tf === 'date' || tf === 'datetime') return { ms: parseTimestamp(s, 'iso', 'UTC'), numeric: false };
  if (!Number.isNaN(num(s))) return { ms: NaN, numeric: true, n: num(s) };
  // Some files declare double but write dates anyway.
  return { ms: parseTimestamp(s, 'iso', 'UTC'), numeric: false };
}

function noteNumericTimes(g, nums) {
  if (!nums.length) return;
  const lo = Math.min(...nums), hi = Math.max(...nums);
  warn(g, 'numeric-time-not-dates', `Times in this file are plain numbers (range ${lo} to ${hi}), not dates, so ties are kept without a time.`, nums.length);
}

// Gephi dynamic cell: "<[a, b]>" or "<[a, b]; [c, d]>" or a bare value.
// Returns the list of start (or single) values as strings.
function dynamicCell(s, kind) {
  s = String(s ?? '').trim();
  if (!s) return [];
  if (!/^<\[.*\]>$/s.test(s)) return [s];
  const body = s.slice(1, -1).trim();
  const groups = body.split(';').map(x => x.trim().replace(/^\[|\]$/g, '')).filter(Boolean);
  if (kind === 'timestamp') return groups.flatMap(gr => gr.split(',').map(x => x.trim()).filter(Boolean));
  return groups.map(gr => gr.split(',')[0].trim()); // intervals: start of each
}

function edgeRelationKey(name) { return ['type', 'relation', 'kind', 'relationship', 'tie'].includes(String(name).toLowerCase()); }
function weightKey(name) { return ['weight', 'edge weight'].includes(String(name).toLowerCase()); }
function timeKey(name) { return ['time', 'timestamp', 'date', 'datetime', 'created_at', 'start', 'first_contact'].includes(String(name).toLowerCase()); }

// Undirected unless proven otherwise: a weighted edge list where every a->b has b->a with equal weight.
function symmetricCollapse(edges) {
  const m = new Map();
  for (const e of edges) { const k = e.s + '\u0000' + e.t + '\u0000' + (e.relation ?? ''); m.set(k, (m.get(k) || 0) + 1); }
  for (const e of edges) {
    if (e.s === e.t) continue;
    const k1 = e.s + '\u0000' + e.t + '\u0000' + (e.relation ?? '');
    const k2 = e.t + '\u0000' + e.s + '\u0000' + (e.relation ?? '');
    if (m.get(k1) !== m.get(k2)) return null;
  }
  // Same multiset both ways; also require weights to match pairwise.
  const wsum = new Map();
  for (const e of edges) { const k = e.s + '\u0000' + e.t + '\u0000' + (e.relation ?? ''); wsum.set(k, (wsum.get(k) || 0) + e.w); }
  for (const [k, w] of wsum) {
    const [a, b, r] = k.split('\u0000');
    if (a !== b && Math.abs((wsum.get(b + '\u0000' + a + '\u0000' + r) ?? NaN) - w) > 1e-9) return null;
  }
  return edges.filter(e => e.s <= e.t);
}

// ---- GraphML -------------------------------------------------------------------

export function readGraphML(text) {
  const root = parseXml(text);
  if (!root || root.local !== 'graphml') throw new Error('Not a GraphML document (root element is not <graphml>).');
  const keys = new Map();
  for (const k of kids(root, 'key')) {
    const def = kid(k, 'default');
    keys.set(k.attrs.id, {
      for: k.attrs.for || 'all',
      name: k.attrs['attr.name'],
      type: k.attrs['attr.type'] || 'string',
      default: def ? def.text : undefined,
      yfiles: k.attrs['yfiles.type'] || null,
    });
  }
  const graphs = kids(root, 'graph');
  if (!graphs.length) throw new Error('GraphML file has no <graph> element.');
  const g = newGraph();
  if (graphs.length > 1) warn(g, 'multiple-graphs', `This GraphML file holds ${graphs.length} graphs; only the first was imported.`);
  const graph = graphs[0];
  const ed = graph.attrs.edgedefault;
  if (!ed) warn(g, 'no-edgedefault', 'The file does not say whether edges are directed; treated as undirected (the GraphML and networkx default).');
  g.directed = ed === 'directed';
  if (descend(graph, 'hyperedge').next().value) warn(g, 'hyperedges-ignored', 'Hyperedges are not supported and were skipped.', [...descend(graph, 'hyperedge')].length);

  const undeclared = new Set();
  function decode(el, scope) {
    const out = {};
    let label = null;
    for (const d of kids(el, 'data')) {
      const k = keys.get(d.attrs.key);
      if (!k) {
        undeclared.add(d.attrs.key);
        out[d.attrs.key] = d.text;
        continue;
      }
      if (k.yfiles) {
        // yEd graphics: keep only the visible label, like networkx.
        const nl = descend(d, 'NodeLabel').next().value || descend(d, 'EdgeLabel').next().value;
        if (nl && nl.text.trim()) label = nl.text.trim();
        continue;
      }
      if (!k.name) { undeclared.add(d.attrs.key); continue; }
      out[k.name] = typed(d.text, k.type);
    }
    for (const [, k] of keys) {
      if (k.name && k.default !== undefined && (k.for === scope || k.for === 'all') && !(k.name in out)) out[k.name] = typed(k.default, k.type);
    }
    return { data: out, ylabel: label };
  }

  // Graph-level data (networkx keeps it in G.graph). Mode labels of a
  // two-mode file are our own convention: mode0_label / mode1_label.
  const gdata = decode(graph, 'graph').data;
  if (gdata.mode0_label != null || gdata.mode1_label != null) g.modeLabels = [gdata.mode0_label, gdata.mode1_label].map(x => (x == null || x === '' ? null : String(x)));

  let nested = 0;
  for (const n of kids(graph, 'node')) {
    if (kid(n, 'graph')) nested++;
    const { data, ylabel } = decode(n, 'node');
    let label = ylabel;
    for (const lk of ['label', 'nodelabel', 'Label']) if (lk in data) { label = String(data[lk]); delete data[lk]; break; }
    if (label == null && typeof data.name === 'string') label = data.name;
    addNode(g, n.attrs.id, label, data);
  }
  if (nested) warn(g, 'nested-graphs-ignored', 'Nested graphs inside nodes are not supported; their contents were skipped.', nested);
  const dropped = new Set();
  let mixed = 0;
  for (const e of kids(graph, 'edge')) {
    const { data } = decode(e, 'edge');
    let w = 1, relation = null;
    const times = [];
    for (const [k, v] of Object.entries(data)) {
      if (weightKey(k)) { const n = num(v); if (!Number.isNaN(n)) w = n; else dropped.add(k); }
      else if (edgeRelationKey(k) && v !== '') relation = String(v);
      else if (timeKey(k)) { const ms = parseTimestamp(v, 'iso', 'UTC'); if (!Number.isNaN(ms)) times.push(ms); else dropped.add(k); }
      else dropped.add(k);
    }
    if (e.attrs.directed != null && (e.attrs.directed === 'true') !== g.directed) mixed++;
    if (!g.nodes.has(e.attrs.source)) addNode(g, e.attrs.source);
    if (!g.nodes.has(e.attrs.target)) addNode(g, e.attrs.target);
    g.edges.push({ s: e.attrs.source, t: e.attrs.target, w, times, relation });
  }
  if (mixed) warn(g, 'mixed-directedness', `Some edges override the file's ${g.directed ? 'directed' : 'undirected'} default; all edges were read as ${g.directed ? 'directed' : 'undirected'}.`, mixed);
  if (dropped.size) warn(g, 'edge-attrs-dropped', `Edge attributes that cannot be stored on ties were dropped: ${[...dropped].join(', ')}.`);
  if (undeclared.size) warn(g, 'undeclared-key', `Data elements reference keys that are not declared (kept as text): ${[...undeclared].join(', ')}.`);
  return g;
}

// ---- GEXF ----------------------------------------------------------------------

export function readGEXF(text) {
  const root = parseXml(text);
  if (!root || root.local !== 'gexf') throw new Error('Not a GEXF document (root element is not <gexf>).');
  const graph = kid(root, 'graph');
  if (!graph) throw new Error('GEXF file has no <graph> element.');
  const g = newGraph();
  const det = graph.attrs.defaultedgetype || 'undirected';
  g.directed = det === 'directed';
  const timeformat = graph.attrs.timeformat || 'double';
  const rep = graph.attrs.timerepresentation || 'interval';
  const numericTimes = [];
  const attrDefs = { node: new Map(), edge: new Map() };
  for (const a of kids(graph, 'attributes')) {
    const cls = a.attrs.class === 'edge' ? 'edge' : a.attrs.class === 'node' ? 'node' : null;
    if (!cls) continue;
    for (const at of kids(a, 'attribute')) {
      const def = kid(at, 'default');
      attrDefs[cls].set(at.attrs.id, { title: at.attrs.title || at.attrs.id, type: at.attrs.type || 'string', default: def ? def.text : undefined, dynamic: a.attrs.mode === 'dynamic' });
    }
  }
  let flattened = 0;
  function attvalues(el, cls) {
    const out = {};
    const dyn = [];
    const av = kid(el, 'attvalues');
    if (av) for (const v of kids(av, 'attvalue')) {
      const id = v.attrs.for ?? v.attrs.id;
      const d = attrDefs[cls].get(id);
      const title = d ? d.title : id;
      const type = d ? d.type : 'string';
      let val = typed(v.attrs.value, type);
      if (/^list/.test(type)) val = String(v.attrs.value);
      const at = v.attrs.timestamp ?? v.attrs.start ?? v.attrs.startopen;
      if (at != null || v.attrs.end != null || v.attrs.endopen != null) dyn.push({ title, val, at });
      else out[title] = val;
    }
    for (const [, d] of attrDefs[cls]) if (d.default !== undefined && !(d.title in out)) out[d.title] = typed(d.default, d.type);
    return { out, dyn };
  }

  const nodesEl = kid(graph, 'nodes');
  for (const n of nodesEl ? kids(nodesEl, 'node') : []) {
    const { out, dyn } = attvalues(n, 'node');
    for (const d of dyn) { out[d.title] = d.val; flattened++; } // last in document order wins
    addNode(g, n.attrs.id, n.attrs.label, out);
  }
  if (flattened) warn(g, 'dynamic-attr-flattened', 'Node attributes that change over time were reduced to their last value.', flattened);

  const edgesEl = kid(graph, 'edges');
  const dropped = new Set();
  let intervalEnds = 0;
  for (const e of edgesEl ? kids(edgesEl, 'edge') : []) {
    const { out, dyn } = attvalues(e, 'edge');
    let w = e.attrs.weight != null && !Number.isNaN(num(e.attrs.weight)) ? num(e.attrs.weight) : 1;
    let relation = e.attrs.kind || null;
    for (const [k, v] of Object.entries(out)) {
      if (weightKey(k)) { const n = num(v); if (!Number.isNaN(n)) w = n; }
      else if (edgeRelationKey(k) && v !== '') relation = relation || String(v);
      else dropped.add(k);
    }
    if (e.attrs.label) dropped.add('label');
    // Dynamic weight by time value (the raw string) so spells can pick it up.
    const dynWeight = new Map();
    for (const d of dyn) if (weightKey(d.title) && d.at != null) dynWeight.set(String(d.at).trim(), num(d.val));
    for (const d of dyn) if (!weightKey(d.title)) dropped.add(d.title);

    // Collect occurrence times as raw strings.
    const raw = [];
    if (rep === 'timestamp') {
      if (e.attrs.timestamp != null) raw.push(e.attrs.timestamp);
      if (e.attrs.timestamps) raw.push(...dynamicCell(e.attrs.timestamps, 'timestamp'));
      const sp = kid(e, 'spells');
      if (sp) for (const s of kids(sp, 'spell')) { const v = s.attrs.timestamp ?? s.attrs.start; if (v != null) raw.push(v); }
    } else {
      const st = e.attrs.start ?? e.attrs.startopen;
      if (st != null) raw.push(st);
      if (e.attrs.end != null || e.attrs.endopen != null) intervalEnds++;
      if (e.attrs.intervals) { raw.push(...dynamicCell(e.attrs.intervals, 'interval')); intervalEnds++; }
      const sp = kid(e, 'spells');
      if (sp) for (const s of kids(sp, 'spell')) {
        const v = s.attrs.start ?? s.attrs.startopen;
        raw.push(v ?? '');
        if (s.attrs.end != null || s.attrs.endopen != null) intervalEnds++;
      }
    }
    const times = [];
    const weights = [];
    let numeric = false;
    for (const r of raw) {
      const tv = timeValue(r, timeformat);
      if (tv.numeric) { numeric = true; numericTimes.push(tv.n); }
      times.push(tv.ms);
      weights.push(dynWeight.get(String(r).trim()));
    }
    if (!g.nodes.has(e.attrs.source)) addNode(g, e.attrs.source);
    if (!g.nodes.has(e.attrs.target)) addNode(g, e.attrs.target);
    if (e.attrs.type && (e.attrs.type === 'directed') !== g.directed && e.attrs.type !== 'mutual') warn(g, 'mixed-directedness', `Some edges override the file's ${g.directed ? 'directed' : 'undirected'} default; all edges were read as ${g.directed ? 'directed' : 'undirected'}.`);
    if (!times.length || numeric) {
      // No usable times: one tie carrying the edge weight.
      g.edges.push({ s: e.attrs.source, t: e.attrs.target, w, times: [], relation });
    } else if (weights.some(x => x !== undefined && !Number.isNaN(x))) {
      // Dynamic weights per occurrence.
      times.forEach((t, i) => g.edges.push({ s: e.attrs.source, t: e.attrs.target, w: weights[i] ?? 1, times: [t], relation }));
    } else {
      // The static weight is the edge total; split it so the sum over occurrences equals it.
      times.forEach(t => g.edges.push({ s: e.attrs.source, t: e.attrs.target, w: w / times.length, times: [t], relation }));
    }
  }
  if (intervalEnds && rep !== 'timestamp') warn(g, 'interval-end-dropped', 'Ties are placed at the start of each time interval; interval ends are not kept.', intervalEnds);
  noteNumericTimes(g, numericTimes);
  if (dropped.size) warn(g, 'edge-attrs-dropped', `Edge attributes that cannot be stored on ties were dropped: ${[...dropped].join(', ')}.`);
  g.version = root.attrs.version || null;
  return g;
}

// ---- GML -----------------------------------------------------------------------

const GML_TOKEN = /(\s+|#[^\n]*)|(\[)|(\])|("[^"]*")|([+-]?(?:[0-9]*\.[0-9]+|[0-9]+\.[0-9]*|INF)(?:[Ee][+-]?[0-9]+)?)|([+-]?[0-9]+)|([A-Za-z][0-9A-Za-z_]*)/y;

function gmlUnescape(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e];
  });
}

function gmlParse(text) {
  const toks = [];
  GML_TOKEN.lastIndex = 0;
  let p = 0;
  while (p < text.length) {
    GML_TOKEN.lastIndex = p;
    const m = GML_TOKEN.exec(text);
    if (!m) throw new Error(`GML syntax error near "${text.slice(p, p + 20)}"`);
    p = GML_TOKEN.lastIndex;
    if (m[1]) continue;
    if (m[2]) toks.push({ t: '[' });
    else if (m[3]) toks.push({ t: ']' });
    else if (m[4]) toks.push({ t: 'v', v: gmlUnescape(m[4].slice(1, -1)) });
    else if (m[5]) toks.push({ t: 'v', v: /INF/.test(m[5]) ? (m[5][0] === '-' ? -Infinity : Infinity) : Number(m[5]) });
    else if (m[6]) toks.push({ t: 'v', v: Number(m[6]) });
    else toks.push({ t: 'k', v: m[7] });
  }
  let i = 0;
  function list(close) {
    const out = [];
    while (i < toks.length) {
      const k = toks[i];
      if (k.t === ']') { if (!close) throw new Error('GML: unexpected ]'); i++; return out; }
      if (k.t !== 'k') throw new Error('GML: expected a key');
      i++;
      const v = toks[i++];
      if (!v) throw new Error(`GML: key "${k.v}" has no value`);
      if (v.t === '[') out.push([k.v, list(true)]);
      else if (v.t === 'v') out.push([k.v, v.v]);
      else if (v.t === 'k' && /^(INF|NAN)$/i.test(v.v)) out.push([k.v, /NAN/i.test(v.v) ? NaN : Infinity]);
      else throw new Error(`GML: bad value for "${k.v}"`);
    }
    if (close) throw new Error('GML: missing ]');
    return out;
  }
  return list(false);
}

export function readGML(text) {
  const top = gmlParse(text);
  const gl = top.find(([k, v]) => k === 'graph' && Array.isArray(v));
  if (!gl) throw new Error('GML file has no graph [ ... ] block.');
  const g = newGraph();
  const body = gl[1];
  const directed = body.find(([k]) => k === 'directed');
  g.directed = !!(directed && Number(directed[1]) === 1);
  const rawNodes = [];
  let nestedDropped = 0;
  for (const [k, v] of body) {
    if (k !== 'node' || !Array.isArray(v)) continue;
    const n = { id: undefined, label: undefined, attrs: {} };
    for (const [nk, nv] of v) {
      if (nk === 'id') n.id = nv;
      else if (nk === 'label') n.label = nv;
      else if (Array.isArray(nv)) { if (nk !== 'graphics') nestedDropped++; }
      else n.attrs[nk] = nv;
    }
    if (n.id === undefined) throw new Error('GML node without an id.');
    rawNodes.push(n);
  }
  // Key by label when every node has a unique one (networkx's default), else by id.
  const labels = rawNodes.map(n => n.label);
  const byLabel = labels.every(l => l !== undefined) && new Set(labels.map(String)).size === labels.length;
  const idToKey = new Map();
  for (const n of rawNodes) {
    const key = byLabel ? String(n.label) : String(n.id);
    idToKey.set(String(n.id), key);
    const node = addNode(g, key, n.label != null ? String(n.label) : null, n.attrs);
    if (byLabel) node.origId = String(n.id);
  }
  if (!byLabel && rawNodes.length) warn(g, 'gml-labels-not-unique', 'Node labels are missing or repeated, so nodes are identified by their GML id.');
  const dropped = new Set();
  for (const [k, v] of body) {
    if (k !== 'edge' || !Array.isArray(v)) continue;
    let s, t, w = 1, relation = null;
    for (const [ek, ev] of v) {
      if (ek === 'source') s = String(ev);
      else if (ek === 'target') t = String(ev);
      else if (ek === 'weight' || ek === 'value') { if (typeof ev === 'number' && !Number.isNaN(ev)) w = ev; }
      else if (edgeRelationKey(ek)) relation = String(ev);
      else if (!Array.isArray(ev)) dropped.add(ek);
    }
    if (s === undefined || t === undefined) { warn(g, 'edge-missing-endpoint', 'Edges without a source or target were skipped.'); continue; }
    const sk = idToKey.get(s) ?? s, tk = idToKey.get(t) ?? t;
    if (!g.nodes.has(sk)) addNode(g, sk);
    if (!g.nodes.has(tk)) addNode(g, tk);
    g.edges.push({ s: sk, t: tk, w, times: [], relation });
  }
  if (nestedDropped) warn(g, 'nested-attrs-dropped', 'Nested (list-valued) node attributes other than graphics were skipped.', nestedDropped);
  if (dropped.size) warn(g, 'edge-attrs-dropped', `Edge attributes that cannot be stored on ties were dropped: ${[...dropped].join(', ')}.`);
  return g;
}

// ---- Pajek ---------------------------------------------------------------------

// Shell-like split as networkx uses (shlex): double quotes with backslash escapes,
// single quotes literal, bare words.
function shsplit(line) {
  const out = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i])) i++;
    if (i >= line.length) break;
    let tok = '';
    while (i < line.length && !/\s/.test(line[i])) {
      const c = line[i];
      if (c === '"') {
        i++;
        while (i < line.length && line[i] !== '"') {
          if (line[i] === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) { tok += line[i + 1]; i += 2; } else tok += line[i++];
        }
        i++;
      } else if (c === "'" && tok === '') {
        const j = line.indexOf("'", i + 1);
        if (j < 0) { tok += line.slice(i); i = line.length; } else { tok += line.slice(i + 1, j); i = j + 1; }
      } else if (c === '\\' && i + 1 < line.length) { tok += line[i + 1]; i += 2; }
      else { tok += c; i++; }
    }
    out.push(tok);
  }
  return out;
}

export function readPajek(text) {
  const g = newGraph();
  const lines = text.replace(/^﻿/, '').split(/\r?\n/);
  let section = null, relation = null;
  let nVert = 0, n1 = 0;
  const vlabel = new Map(); // vertex number -> label
  const vattrs = new Map();
  const edges = [];
  let sawArcs = false, sawEdges = false;
  let matrixRow = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '%') continue;
    if (line[0] === '*') {
      const m = /^\*(\w+)\s*(.*)$/.exec(line);
      const kw = m ? m[1].toLowerCase() : '';
      const rest = m ? m[2] : '';
      relation = null;
      if (kw === 'vertices') {
        const nums = rest.split(/\s+/).map(Number);
        nVert = nums[0] || 0; n1 = nums[1] || 0;
        section = 'v';
      } else if (['arcs', 'edges', 'arcslist', 'edgeslist', 'matrix'].includes(kw)) {
        section = kw;
        if (kw.startsWith('arcs') || kw === 'matrix') sawArcs = true; else sawEdges = true;
        // Multi-relational Pajek: *Arcs :2 "advice"
        const rm = /^:\s*\d+\s*(.*)$/.exec(rest);
        if (rm) { const t = shsplit(rm[1]); relation = t[0] || rest.trim(); }
        matrixRow = 0;
      } else section = null; // *Network and unknown sections
      continue;
    }
    const tok = shsplit(line);
    if (section === 'v') {
      const id = tok[0];
      vlabel.set(id, tok[1] ?? id);
      const a = {};
      const x = num(tok[2]), y = num(tok[3]), z = num(tok[4]);
      if (!Number.isNaN(x) && !Number.isNaN(y)) { a.x = x; a.y = y; if (!Number.isNaN(z)) a.z = z; }
      // Two-mode: *Vertices N N1, the first N1 are the first mode (spec section 4).
      if (n1) a.bipartite = Number(id) <= n1 ? 0 : 1;
      vattrs.set(id, a);
    } else if (section === 'arcs' || section === 'edges') {
      if (tok.length < 2) continue;
      const w = num(tok[2]);
      edges.push({ s: tok[0], t: tok[1], w: Number.isNaN(w) ? 1 : w, times: [], relation, und: section === 'edges' });
    } else if (section === 'arcslist' || section === 'edgeslist') {
      for (const t of tok.slice(1)) edges.push({ s: tok[0], t, w: 1, times: [], relation, und: section === 'edgeslist' });
    } else if (section === 'matrix') {
      matrixRow++;
      tok.forEach((v, j) => { const w = num(v); if (w && !Number.isNaN(w)) edges.push({ s: String(matrixRow), t: String(j + 1), w, times: [], relation, matrix: true }); });
    }
  }
  for (let i = 1; i <= nVert; i++) if (!vlabel.has(String(i))) { vlabel.set(String(i), String(i)); if (n1) vattrs.set(String(i), { bipartite: i <= n1 ? 0 : 1 }); }
  if (n1 > 0 && n1 < nVert) g.twoMode = true;
  if (vlabel.size > nVert && nVert) warn(g, 'pajek-vertex-count', `The header says ${nVert} vertices but more were listed.`);
  const labels = [...vlabel.values()];
  const useLabel = new Set(labels).size === labels.length;
  const keyOf = id => (useLabel ? vlabel.get(id) ?? id : id);
  // networkx also accepts labels in edge lines.
  const labelToId = new Map([...vlabel].map(([id, l]) => [l, id]));
  for (const [id, l] of vlabel) {
    const node = addNode(g, keyOf(id), l, vattrs.get(id));
    node.origId = id;
  }
  if (!useLabel) warn(g, 'pajek-labels-not-unique', 'Vertex labels repeat, so vertices are identified by their number.');
  if (sawArcs && sawEdges) warn(g, 'mixed-directedness', 'The file has both *Arcs (directed) and *Edges (undirected); all ties were read as directed.');
  g.directed = sawArcs || !sawEdges;
  let list = edges.map(e => {
    const sid = vlabel.has(e.s) ? e.s : labelToId.get(e.s) ?? e.s;
    const tid = vlabel.has(e.t) ? e.t : labelToId.get(e.t) ?? e.t;
    if (!vlabel.has(sid)) addNode(g, keyOf(sid));
    if (!vlabel.has(tid)) addNode(g, keyOf(tid));
    return { ...e, s: keyOf(sid), t: keyOf(tid) };
  });
  if (!sawEdges && list.length && list.every(e => e.matrix)) {
    const und = symmetricCollapse(list);
    if (und) { list = und; g.directed = false; }
  }
  g.edges = list.map(({ s, t, w, times, relation }) => ({ s, t, w, times, relation }));
  return g;
}

// ---- UCINET DL -----------------------------------------------------------------

const DL_FORMATS = { fm: 'fullmatrix', fullmatrix: 'fullmatrix', uh: 'upperhalf', upperhalf: 'upperhalf', lh: 'lowerhalf', lowerhalf: 'lowerhalf',
  el1: 'edgelist1', edgelist1: 'edgelist1', nl1: 'nodelist1', nodelist1: 'nodelist1', el2: 'edgelist2', edgelist2: 'edgelist2',
  nl1b: 'nodelist1b', nodelist1b: 'nodelist1b', nl2: 'nodelist2', nodelist2: 'nodelist2', bm: 'blockmatrix', blockmatrix: 'blockmatrix' };

function dlTokens(s) {
  return s.match(/"[^"]*"|'[^']*'|[=:]|[^\s,=:"']+/g) || [];
}
const unq = t => t.replace(/^["']|["']$/g, '');

export function readDL(text) {
  const g = newGraph(true);
  const t = text.replace(/^﻿/, '');
  const dm = /\bdata\s*:/i.exec(t);
  if (!dm) throw new Error('UCINET DL file has no DATA: section.');
  const toks = dlTokens(t.slice(0, dm.index));
  const dataText = t.slice(dm.index + dm[0].length);
  const h = { n: 0, nr: 0, nc: 0, nm: 1, format: 'fullmatrix', diagonal: 'present', labels: [], rowLabels: [], colLabels: [], matrixLabels: [], embedded: false };
  const KW = new Set(['n', 'nr', 'nc', 'nm', 'format', 'labels', 'row', 'col', 'column', 'matrix', 'diagonal', 'dl', 'embedded']);
  let i = 0;
  if (toks[0] && toks[0].toLowerCase() === 'dl') i = 1;
  const isKwAt = j => j < toks.length && KW.has(toks[j].toLowerCase()) && (toks[j + 1] === '=' || toks[j + 1] === ':' || /^(labels|embedded)$/i.test(toks[j + 1] || '') || /^(labels|embedded)$/i.test(toks[j]));
  function readList() {
    const out = [];
    while (i < toks.length && !isKwAt(i)) { if (toks[i] !== '=' && toks[i] !== ':') out.push(unq(toks[i])); i++; }
    return out;
  }
  while (i < toks.length) {
    const w = toks[i].toLowerCase();
    if (['n', 'nr', 'nc', 'nm', 'format', 'diagonal'].includes(w) && toks[i + 1] === '=') {
      const v = toks[i + 2] || '';
      if (w === 'format') h.format = DL_FORMATS[v.toLowerCase()] || v.toLowerCase();
      else if (w === 'diagonal') h.diagonal = v.toLowerCase();
      else h[w] = Number(v);
      i += 3; continue;
    }
    let target = null;
    if (w === 'labels') target = 'labels';
    else if ((w === 'row' || w === 'col' || w === 'column' || w === 'matrix') && /^labels$/i.test(toks[i + 1] || '')) {
      target = w === 'row' ? 'rowLabels' : w === 'matrix' ? 'matrixLabels' : 'colLabels';
      i++;
    }
    if (target) {
      i++;
      if (/^embedded$/i.test(toks[i] || '')) { if (target !== 'matrixLabels') h.embedded = true; i++; if (toks[i] === ':') i++; continue; }
      if (toks[i] === ':') i++;
      h[target] = readList();
      continue;
    }
    i++; // unknown token in header: skip
  }
  if (!h.n && h.nr && h.nc && h.nr === h.nc) h.n = h.nr;
  // Two-mode (affiliation) DL: a rectangular matrix (NR != NC), a square one
  // whose row and column labels differ, or EDGELIST2 (the spec's 2-mode edge
  // list). Rows become mode 0, columns mode 1 (node attribute `bipartite`).
  const twoMode = h.format === 'edgelist2' || !!(h.nr && h.nc && (h.nr !== h.nc || (h.rowLabels.length && h.colLabels.length && h.rowLabels.some((l, k) => l !== h.colLabels[k]))));
  if (twoMode) {
    warn(g, 'dl-two-mode', 'This is a two-mode DL file: rows were imported as one kind of node (actors) and columns as the other (events), with ties only between the two.');
    g.twoMode = true;
  }
  const n = h.n || h.nr || 0;
  const rowL = h.rowLabels.length ? h.rowLabels : h.labels;
  const colL = h.colLabels.length ? h.colLabels : h.labels;
  const rel = k => (h.nm > 1 ? (h.matrixLabels[k] ?? `matrix ${k + 1}`) : (h.matrixLabels[0] ?? null));
  const edges = [];
  const nodeOrder = [];
  // One-mode: a node per label. Two-mode: rows and columns are different
  // kinds, so a column whose label is also a row label gets its own id.
  const see = (id, mode = -1) => {
    if (twoMode && mode === 1 && g.nodes.has(id) && g.nodes.get(id).attrs.bipartite === 0) id = `${id} (column)`;
    if (!g.nodes.has(id)) { addNode(g, id, id.replace(/ \(column\)$/, ''), twoMode && mode >= 0 ? { bipartite: mode } : null); nodeOrder.push(id); }
    return id;
  };
  for (const l of rowL) see(l, 0);
  if (!twoMode || h.colLabels.length) for (const l of colL) see(l, 1);
  const dataLines = dataText.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  if (h.format === 'fullmatrix' || h.format === 'upperhalf' || h.format === 'lowerhalf') {
    const nr = h.nr || n, nc = h.nc || n;
    let rLab = rowL.slice(), cLab = colL.slice();
    let vals = [];
    if (h.embedded) {
      // Column-label line, then rows starting with their label. Repeated per matrix [UNVERIFIED for NM>1].
      const rows = [];
      for (const l of dataLines) {
        const tk = dlTokens(l).filter(x => x !== '=' && x !== ':').map(unq);
        if (tk.length && tk.every(x => Number.isNaN(num(x)))) { if (!cLab.length || cLab.length !== tk.length) cLab = tk; continue; }
        rows.push(tk);
      }
      rLab = [];
      for (const r of rows) { if (Number.isNaN(num(r[0]))) { if (rLab.length < nr) rLab.push(r[0]); vals.push(...r.slice(1)); } else vals.push(...r); }
      for (const l of rLab) see(l, 0); for (const l of cLab) see(l, 1);
    } else {
      vals = dataLines.flatMap(l => dlTokens(l).filter(x => x !== '=' && x !== ':'));
    }
    // Ids per row and column (see() resolves a column id clashing with a row).
    const rowIds = Array.from({ length: nr }, (_, k) => see(rLab[k] ?? String(k + 1), 0));
    const colIds = Array.from({ length: nc }, (_, k) => see(cLab[k] ?? String(k + 1), 1));
    const label = (arr, k) => (arr === rLab ? rowIds[k] : colIds[k]);
    let p = 0;
    for (let m = 0; m < h.nm; m++) {
      for (let r = 0; r < nr; r++) {
        let c0 = 0, c1 = nc;
        if (h.format === 'upperhalf') c0 = h.diagonal === 'absent' ? r + 1 : r;
        if (h.format === 'lowerhalf') c1 = h.diagonal === 'absent' ? r : r + 1;
        for (let c = c0; c < c1; c++) {
          const w = num(String(vals[p++] ?? '').replace(',', '.'));
          if (w && !Number.isNaN(w)) edges.push({ s: label(rLab, r), t: label(cLab, c), w, times: [], relation: rel(m) });
        }
      }
    }
    if (p < vals.length) warn(g, 'dl-extra-values', `The DL data had ${vals.length - p} more values than the declared matrix size; they were ignored.`);
    if (h.format !== 'fullmatrix') g.directed = false;
  } else if (h.format === 'edgelist1' || h.format === 'nodelist1' || h.format === 'edgelist2' || h.format === 'nodelist2') {
    // EDGELIST2: first column refers to rows, second to columns [UNVERIFIED:
    // the spec names the format as 2-mode without showing an example].
    const ref = (tk, mode = -1) => {
      if (h.embedded) return see(tk, mode);
      const k = Number(tk);
      if (Number.isInteger(k) && k >= 1) return see((mode === 1 ? h.colLabels[k - 1] : null) ?? h.labels[k - 1] ?? (h.rowLabels[k - 1] ?? String(k)), mode);
      return see(tk, mode);
    };
    let m = 0;
    for (const l of dataLines) {
      if (l === '!' || /^!/.test(l)) { m++; continue; } // matrix separator in stacked lists [UNVERIFIED]
      const tk = dlTokens(l).filter(x => x !== '=' && x !== ':').map(unq);
      if (h.format.startsWith('edgelist')) {
        if (tk.length < 2) continue;
        const w = tk.length > 2 ? num(tk[2].replace(',', '.')) : 1;
        edges.push({ s: ref(tk[0], twoMode ? 0 : -1), t: ref(tk[1], twoMode ? 1 : -1), w: Number.isNaN(w) ? 1 : w, times: [], relation: rel(m) });
      } else {
        const ego = ref(tk[0]);
        for (const x of tk.slice(1)) edges.push({ s: ego, t: ref(x), w: 1, times: [], relation: rel(m) });
      }
    }
  } else {
    throw new Error(`UCINET DL format "${h.format}" is not supported (fullmatrix, upperhalf, lowerhalf, edgelist1, nodelist1 are).`);
  }
  if (twoMode) { g.directed = false; g.edges = edges; } else if (h.format === 'fullmatrix' || h.format.startsWith('edgelist') || h.format.startsWith('nodelist')) {
    const und = !(h.nr && h.nc && h.nr !== h.nc) ? symmetricCollapse(edges) : null;
    if (und && edges.length) { g.directed = false; g.edges = und; } else g.edges = edges;
  } else g.edges = edges;
  return g;
}

// ---- CSV tables ------------------------------------------------------------------

function colIndex(header, names) {
  const low = header.map(h => String(h).trim().toLowerCase());
  for (const n of names) { const i = low.indexOf(n); if (i >= 0) return i; }
  return -1;
}

export function readGephiNodes(rows, g) {
  const header = rows[0].map(h => String(h).trim());
  const low = header.map(h => h.toLowerCase());
  const idI = low.indexOf('id'), labI = low.indexOf('label');
  const skip = new Set([idI, labI]);
  low.forEach((h, i) => { if (h === 'timeset' || h.includes('interval') || h.includes('timestamp')) skip.add(i); });
  const conv = header.map((_, j) => inferConverter(rows.slice(1).map(r => r[j])));
  let auto = 0;
  for (const r of rows.slice(1)) {
    let id = idI >= 0 ? String(r[idI] ?? '').trim() : '';
    if (!id) id = labI >= 0 && String(r[labI] ?? '').trim() ? String(r[labI]).trim() : `auto-${++auto}`;
    const attrs = {};
    header.forEach((h, j) => { if (!skip.has(j) && h && r[j] != null && String(r[j]).trim() !== '') attrs[h] = conv[j](String(r[j]).trim()); });
    addNode(g, id, labI >= 0 ? String(r[labI] ?? '').trim() || null : null, attrs);
  }
  if ([...skip].some(j => j !== idI && j !== labI && j >= 0)) warn(g, 'node-times-dropped', 'Node time columns (Timeset, Interval, Timestamp) are not used; only tie times are kept.');
}

function readEdgeTable(rows, g, { gephi, defaultDirected }) {
  const header = rows[0].map(h => String(h).trim());
  const low = header.map(h => h.toLowerCase());
  const sI = gephi ? low.indexOf('source') : colIndex(header, SRC_ALIASES);
  const tI = gephi ? low.indexOf('target') : colIndex(header, TGT_ALIASES);
  const wI = colIndex(header, gephi ? ['weight'] : W_ALIASES);
  const typeI = gephi ? low.indexOf('type') : -1;
  const kindI = gephi ? colIndex(header, ['kind']) : colIndex(header, TYPE_ALIASES);
  let timeI = -1, timeKind = 'timestamp';
  if (gephi) {
    low.forEach((h, j) => {
      if (timeI >= 0) return;
      if (h.includes('timestamp')) { timeI = j; timeKind = 'timestamp'; }
      else if (h.includes('interval') || h === 'timeset') { timeI = j; timeKind = 'interval'; }
    });
  } else timeI = colIndex(header, T_ALIASES);
  const used = new Set([sI, tI, wI, typeI, kindI, timeI, gephi ? low.indexOf('id') : -1, gephi ? low.indexOf('label') : -1]);
  const dropped = header.filter((h, j) => !used.has(j) && h);
  let und = 0, dir = 0, bad = 0;
  const numeric = [];
  let epochFmt = null;
  if (!gephi && timeI >= 0) {
    const sample = rows.slice(1, 200).map(r => String(r[timeI] ?? '').trim()).filter(Boolean);
    if (sample.length && sample.every(v => /^\d{10}$/.test(v))) epochFmt = 'epoch-s';
    else if (sample.length && sample.every(v => /^\d{13}$/.test(v))) epochFmt = 'epoch-ms';
    if (epochFmt) warn(g, 'epoch-time-assumed', `The ${header[timeI]} column holds ${epochFmt === 'epoch-s' ? '10-digit' : '13-digit'} numbers; they were read as Unix time in ${epochFmt === 'epoch-s' ? 'seconds' : 'milliseconds'}.`);
  }
  for (const r of rows.slice(1)) {
    const s = String(r[sI] ?? '').trim(), t = String(r[tI] ?? '').trim();
    if (!s || !t) { bad++; continue; }
    let w = wI >= 0 ? num(String(r[wI] ?? '').replace(/^(-?\d+),(\d+)$/, '$1.$2')) : 1;
    if (Number.isNaN(w)) w = 1;
    if (typeI >= 0) { if (/^undirected$/i.test(String(r[typeI] ?? '').trim())) und++; else dir++; }
    const relation = kindI >= 0 && String(r[kindI] ?? '').trim() ? String(r[kindI]).trim() : null;
    const times = [];
    if (timeI >= 0) {
      for (const v of gephi ? dynamicCell(r[timeI], timeKind) : [r[timeI]]) {
        if (epochFmt) { times.push(parseTimestamp(v, epochFmt)); continue; }
        const tv = timeValue(v, 'datetime-or-number');
        if (tv.numeric) { numeric.push(tv.n); continue; }
        const ms = parseTimestamp(v, 'iso', 'UTC');
        if (!Number.isNaN(ms)) times.push(ms);
      }
    }
    if (!g.nodes.has(s)) addNode(g, s);
    if (!g.nodes.has(t)) addNode(g, t);
    if (times.length > 1) times.forEach(tm => g.edges.push({ s, t, w: w / times.length, times: [tm], relation }));
    else g.edges.push({ s, t, w, times, relation });
  }
  if (bad) warn(g, 'edge-missing-endpoint', 'Rows without both a source and a target were skipped.', bad);
  if (gephi && timeKind === 'interval' && timeI >= 0) warn(g, 'interval-end-dropped', 'Ties are placed at the start of each time interval; interval ends are not kept.');
  noteNumericTimes(g, numeric);
  if (dropped.length) warn(g, 'edge-attrs-dropped', `Edge columns that cannot be stored on ties were dropped: ${dropped.join(', ')}.`);
  const directed = gephi ? !(und && !dir) : defaultDirected;
  if (gephi && und && dir) warn(g, 'mixed-directedness', 'Some rows are Undirected and some Directed; all ties were read as directed.');
  return directed;
}

export function readMatrixCSV(rows) {
  const g = newGraph(true);
  const cols = rows[0].slice(1).map(c => String(c).trim());
  // No row label among the column labels: an incidence matrix (two-mode,
  // rows = people, columns = events), not an adjacency matrix.
  const rowLabels = rows.slice(1).map(r => String(r[0] ?? '').trim()).filter(Boolean);
  const colSet = new Set(cols);
  if (rowLabels.length && cols.length && !rowLabels.some(l => colSet.has(l))) return readIncidenceCSV(rows, cols);
  for (const c of cols) addNode(g, c, c);
  const edges = [];
  let selfLoops = 0;
  for (const r of rows.slice(1)) {
    const rl = String(r[0] ?? '').trim();
    if (!rl) continue;
    addNode(g, rl, rl);
    cols.forEach((c, j) => {
      const w = num(String(r[j + 1] ?? '').trim().replace(/^(-?\d+),(\d+)$/, '$1.$2'));
      if (!w || Number.isNaN(w)) return;
      if (rl === c) { selfLoops++; return; }
      edges.push({ s: rl, t: c, w, times: [], relation: null });
    });
  }
  if (selfLoops) warn(g, 'self-loops', 'Diagonal cells (a node tied to itself) were ignored.', selfLoops);
  const und = symmetricCollapse(edges);
  if (und) { g.directed = false; g.edges = und; } else g.edges = edges;
  return g;
}

function readIncidenceCSV(rows, cols) {
  const g = newGraph(false);
  g.twoMode = true;
  warn(g, 'incidence-matrix', 'Row names and column names do not overlap, so this was read as a two-mode incidence matrix: rows are one kind of node (actors), columns the other (events).');
  for (const r of rows.slice(1)) { const rl = String(r[0] ?? '').trim(); if (rl) addNode(g, rl, rl, { bipartite: 0 }); }
  for (const c of cols) addNode(g, c, c, { bipartite: 1 });
  for (const r of rows.slice(1)) {
    const rl = String(r[0] ?? '').trim();
    if (!rl) continue;
    cols.forEach((c, j) => {
      const w = num(String(r[j + 1] ?? '').trim().replace(/^(-?\d+),(\d+)$/, '$1.$2'));
      if (w && !Number.isNaN(w)) g.edges.push({ s: rl, t: c, w, times: [], relation: null });
    });
  }
  return g;
}

export function readEdgeListText(text, directed) {
  const g = newGraph(directed);
  let bad = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const s = raw.trim();
    if (!s || s[0] === '#' || s[0] === '%') continue;
    const t = splitEdgeLine(s);
    if (t.length < 2) { bad++; continue; }
    const w = t.length > 2 ? num(t[2]) : 1;
    addNode(g, t[0]); addNode(g, t[1]);
    g.edges.push({ s: t[0], t: t[1], w: Number.isNaN(w) ? 1 : w, times: [], relation: null });
  }
  if (bad) warn(g, 'edge-missing-endpoint', 'Lines with fewer than two node names were skipped.', bad);
  return g;
}

// ---- emitting into the dataset -----------------------------------------------------

const FORMAT_OF = { graphml: 'graphml', gexf: 'gexf', gml: 'gml', pajek: 'pajek', dl: 'ucinet-dl', 'gephi-edges': 'gephi-csv', 'csv-edgelist': 'edgelist', edgelist: 'edgelist', matrix: 'gephi-csv' };

// Two-mode (affiliation) graph? A reader may say so (a rectangular DL
// matrix, Pajek *Vertices N N1); otherwise, as networkx's bipartite files,
// when every node has `bipartite` 0 or 1 and both occur. Returns the mode per
// node id, or null.
function graphModes(g) {
  const mode = new Map();
  let c0 = 0, c1 = 0;
  for (const [id, n] of g.nodes) {
    const m = modeValue(n.attrs?.[MODE_ATTR]);
    if (m < 0) return null;
    mode.set(id, m);
    if (m) c1++; else c0++;
  }
  return c0 && c1 ? mode : null;
}

function emit(builder, g, { format, rel, fileNames, signal }) {
  const modes = graphModes(g);
  builder.beginSource({ format, family: 'network', medium: 'declared', view: 'full', context: 'custom', tz: 'UTC', fileNames, directed: modes ? false : !!g.directed });
  if (modes) {
    declareTwoMode(builder, [0, 1].map(k => g.modeLabels?.[k] || DEFAULT_MODE_LABELS[k]));
    // The mode is stored as the number 0 / 1 whatever the file wrote (a
    // string, a boolean), so twoModeOf and the exporters agree.
    for (const [id, n] of g.nodes) n.attrs = { ...n.attrs, [MODE_ATTR]: modes.get(id) };
    if (g.directed) builder.warn('two-mode-undirected', 'A two-mode (affiliation) network has no direction; ties were read as undirected.');
  }
  for (const w of g.warns) builder.warn(w.code, w.message, w.count);
  const base = builder.context(`net:${rel}`, { name: rel, kind: 'network', visibility: 'unknown', medium: 'declared' });
  const idx = new Map();
  for (const [id, n] of g.nodes) {
    const platformIds = { net: n.origId ?? id };
    idx.set(id, builder.node(`net:${id}`, { label: n.label ?? undefined, attrs: n.attrs, platformIds }));
    builder.stat('nodes');
  }
  const relCtx = new Map();
  let self = 0, timed = 0, k = 0, sameMode = 0;
  for (const e of g.edges) {
    if ((++k & 0xffff) === 0 && signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    if (e.s === e.t) { self++; continue; }
    let c = base;
    if (e.relation) {
      c = relCtx.get(e.relation);
      if (c === undefined) {
        c = builder.context(`net:${rel}#${e.relation}`, { name: e.relation, kind: 'network', visibility: 'unknown', medium: 'declared' });
        relCtx.set(e.relation, c);
        builder.stat('relations');
      }
    }
    const t = e.times.length ? e.times[0] : NaN;
    if (!Number.isNaN(t)) timed++;
    if (modes) {
      const ms = modes.get(e.s), mt = modes.get(e.t);
      if (ms !== mt) {
        // An affiliation: from the actor (mode 0) to the event (mode 1).
        const [a, b] = ms === 0 ? [e.s, e.t] : [e.t, e.s];
        builder.event({ type: 'declared', t, actor: idx.get(a), targets: [[idx.get(b), 'member']], context: c, weight: e.w });
        builder.stat('affiliations');
        builder.stat('edges');
        continue;
      }
      sameMode++;
    }
    builder.event({ type: 'declared', t, actor: idx.get(e.s), targets: [[idx.get(e.t), 'declared']], context: c, weight: e.w });
    builder.stat('edges');
  }
  if (self) { builder.stat('self-loops', self); builder.warn('self-loops', 'Ties from a node to itself cannot be represented and were skipped.', self); }
  if (timed) builder.stat('timed-edges', timed);
  if (sameMode) builder.warn('same-mode-ties', 'Some ties join two nodes of the same kind in this two-mode file; they are kept, but the two-mode view and its projections leave them out (switch the two-mode view off in the construction settings to see them).', sameMode);
  if (!g.edges.length) builder.warn('no-edges', 'This file has no ties.');
}

async function importFiles(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const claimed = [];
  for (const e of fs.entries) {
    if (!XML_EXT.test(e.rel) && !TEXT_EXT.test(e.rel)) continue;
    const c = await classify(e).catch(() => null);
    if (c) claimed.push({ entry: e, ...c });
  }
  const nodeTables = claimed.filter(c => c.kind === 'gephi-nodes');
  const others = claimed.filter(c => c.kind !== 'gephi-nodes');
  const edgeTable = others.find(c => c.kind === 'gephi-edges' || c.kind === 'csv-edgelist');
  const defaultDirected = (options.edgeListDirection || 'directed') !== 'undirected';
  let i = 0;
  for (const c of others) {
    if (signal?.aborted) throw new DOMException('Import cancelled', 'AbortError');
    progress(i++ / others.length, `Reading ${c.entry.rel}`);
    let g;
    const fileNames = [c.entry.rel];
    try {
      if (c.kind === 'graphml') g = readGraphML(await c.entry.text());
      else if (c.kind === 'gexf') g = readGEXF(await c.entry.text());
      else if (c.kind === 'gml') g = readGML(await c.entry.text());
      else if (c.kind === 'pajek') g = readPajek(await c.entry.text());
      else if (c.kind === 'dl') g = readDL(await c.entry.text());
      else if (c.kind === 'edgelist') g = readEdgeListText(await c.entry.text(), defaultDirected);
      else if (c.kind === 'matrix') g = readMatrixCSV(parseCSV(await entryText(c.entry)).rows);
      else {
        g = newGraph();
        if (c === edgeTable) for (const nt of nodeTables) { readGephiNodes(parseCSV(await entryText(nt.entry)).rows, g); fileNames.push(nt.entry.rel); }
        g.directed = readEdgeTable(parseCSV(await entryText(c.entry)).rows, g, { gephi: c.kind === 'gephi-edges', defaultDirected });
        if (c.kind === 'csv-edgelist' && !g.warns.some(w => w.code === 'mixed-directedness')) {
          g.warns.push({ code: 'direction-assumed', message: `A plain edge list does not say whether ties are directed; read as ${defaultDirected ? 'directed' : 'undirected'} (change in import options).`, count: 1 });
        }
      }
    } catch (err) {
      builder.beginSource({ format: FORMAT_OF[c.kind], family: 'network', medium: 'declared', view: 'full', context: 'custom', tz: 'UTC', fileNames });
      builder.warn('parse-error', `Could not read ${c.entry.rel}: ${err.message}`);
      continue;
    }
    if (c.kind === 'edgelist') g.warns.push({ code: 'direction-assumed', message: `A plain edge list does not say whether ties are directed; read as ${defaultDirected ? 'directed' : 'undirected'} (change in import options).`, count: 1 });
    emit(builder, g, { format: FORMAT_OF[c.kind], rel: c.entry.rel, fileNames, signal });
  }
  if (nodeTables.length && !edgeTable) {
    // Node tables alone: import nodes so attributes are not lost.
    for (const nt of nodeTables) {
      const g = newGraph(true);
      readGephiNodes(parseCSV(await entryText(nt.entry)).rows, g);
      emit(builder, g, { format: 'gephi-csv', rel: nt.entry.rel, fileNames: [nt.entry.rel], signal });
    }
  }
  progress(1, 'Network files read');
}

export default {
  id: 'network-files',
  label: 'Network file (GraphML, GEXF, GML, Pajek, UCINET DL, Gephi CSV, edge list)',
  family: 'network',
  detect,
  options: [
    { key: 'edgeListDirection', label: 'Plain edge lists without a direction column are', type: 'choice', default: 'directed', choices: ['directed', 'undirected'] },
  ],
  import: importFiles,
};
