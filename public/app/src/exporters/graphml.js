// GraphML export, plus the column helpers the other exporters share.
//
// Spec: docs/formats/network-files.md section 1. Written to open cleanly in
// networkx (read_graphml), Gephi and igraph: one directedness per file, node
// ids are the dataset node keys (unique strings), key ids equal attr.name
// where that is a plain identifier, only the basic GraphML types, UTF-8, and
// XML-illegal control characters stripped.

import { xmlEscape } from '../importers/xml.js';
import { edgeTieAttributes } from '../analysis/construct.js';

// ---- shared helpers (used by gexf, gml, pajek, ucinet, csv) --------------------

// Contact details (N19): attributes that reach a person (email addresses,
// handles, phone numbers, account and workspace ids). With
// { omitContacts: true } (the Methods & Export default) these columns are left
// out and every id is replaced by p1, p2, ... (keys such as roster:leo-park
// carry the name, and the option promises p1, p2).
const CONTACT = /(^|_)(e_?mail|mail|email_?address|handles?|user_?name|screen_?name|phone|mobile|tel|telephone|team_?id|user_?id|account_?id|platform_?id|slack_?id|did|acct|website|url|address)(_|$)/;
export const isContactAttr = key => CONTACT.test(String(key).toLowerCase().replace(/[^a-z0-9]+/g, '_'));
// Node ids as written to files: the dataset keys, or p1..pn when contact
// details are left out. One array per export, so node and
// edge tables agree.
export function exportIds(ds, net, { omitContacts = false } = {}) {
  const ids = new Array(net.n);
  for (let i = 0; i < net.n; i++) {
    const k = String(ds.nodes.keys[net.nodeIds[i]]);
    ids[i] = omitContacts ? `p${i + 1}` : k;
  }
  return ids;
}

// Distinct contacts per person from degree and node reciprocity (as the People
// view computes them): on a directed network degree is in + out, so a two-way
// tie counts twice and contacts = degree - reciprocity * degree / 2.
function contactsFrom(m, directed) {
  const deg = m.degree;
  if (!deg || (directed && !m.reciprocity)) return null;
  return Float64Array.from(deg, (d, v) => (Number.isFinite(d) ? Math.round(d - (directed ? (Number.isFinite(m.reciprocity[v]) ? m.reciprocity[v] : 0) : 0) * d / 2) : NaN));
}

// Metric column names in files. Never a bare "degree" (decision 4): contacts
// count each person once; on a directed network degree (in + out) is written
// as total_ties_in_out, and on an undirected one it equals contacts.
export function metricColumns(nodeMetrics, directed) {
  const m = { ...(nodeMetrics || {}) };
  const out = [];
  const contacts = m.contacts || contactsFrom(m, directed);
  if (contacts) out.push(['contacts', contacts]);
  for (const [k, arr] of Object.entries(m)) {
    if (!arr || k === 'contacts' || k === 'meta') continue;
    if (k === 'degree') { if (directed || !contacts) out.push([directed ? 'total_ties_in_out' : 'contacts', arr]); continue; }
    out.push([k, arr]);
  }
  return out;
}

// Edge attribute name for a construction rule's evidence, the same in every
// format (N11): evidence_reply, evidence_mention, ...
export const evidenceName = rule => `evidence_${String(rule).replace(/[^A-Za-z0-9]+/g, '_')}`;

// Node columns: dataset attributes (typed from attributeSchema), metrics, community.
// Returns [{ name, type: 'string'|'double'|'long'|'boolean', values: Array(n) }]
// with undefined for missing values. Communities are numbered from 1, as in
// the app (N1). { omitContacts } leaves contact-detail attributes out.
export function nodeColumns(ds, net, { nodeMetrics, communities, attrs, omitContacts = false } = {}) {
  const n = net.n;
  const schema = new Map((ds.attributeSchema || []).map(s => [s.key, s]));
  const keys = (attrs || (ds.attributeSchema || []).map(s => s.key)).filter(k => !(omitContacts && isContactAttr(k)));
  const cols = [];
  const taken = new Set(['id', 'label']);
  const uniq = name => { let k = name, i = 2; while (taken.has(k.toLowerCase())) k = `${name}_${i++}`; taken.add(k.toLowerCase()); return k; };
  for (const key of keys) {
    const s = schema.get(key);
    const raw = new Array(n);
    for (let i = 0; i < n; i++) raw[i] = ds.nodes.attrs[net.nodeIds[i]]?.[key];
    let type = 'string';
    const present = raw.filter(v => v !== undefined && v !== null && v !== '');
    if (!present.length) continue;
    const st = s?.type;
    if ((st === 'numeric' || st === 'ordinal' || present.every(v => typeof v === 'number')) && present.every(v => Number.isFinite(Number(v)) && String(v).trim() !== '')) {
      type = present.every(v => Number.isInteger(Number(v)) && Math.abs(Number(v)) < 2 ** 53) ? 'long' : 'double';
    } else if (st === 'boolean' || present.every(v => typeof v === 'boolean')) {
      if (present.every(v => typeof v === 'boolean' || /^(true|false|yes|no)$/i.test(String(v)))) type = 'boolean';
    }
    const values = raw.map(v => {
      if (v === undefined || v === null || v === '') return undefined;
      if (type === 'long' || type === 'double') return Number(v);
      if (type === 'boolean') return typeof v === 'boolean' ? v : /^(true|yes)$/i.test(String(v));
      return typeof v === 'object' ? JSON.stringify(v) : String(v);
    });
    cols.push({ name: uniq(key), source: key, type, values });
  }
  for (const [m, arr] of metricColumns(nodeMetrics, net.directed)) {
    const values = Array.from({ length: n }, (_, i) => (Number.isFinite(arr[i]) ? arr[i] : undefined));
    const whole = m === 'contacts' || m === 'total_ties_in_out' || values.every(v => v === undefined || Number.isInteger(v));
    cols.push({ name: uniq(m), source: m, type: whole && /^(contacts|total_ties_in_out|inDegree|outDegree|coreNumber)$/.test(m) ? 'long' : 'double', values });
  }
  const memb = communities ? (communities.membership || communities) : null;
  if (memb) cols.push({ name: uniq('community'), source: 'community', type: 'long', values: Array.from({ length: n }, (_, i) => (memb[i] >= 0 ? memb[i] + 1 : undefined)) });
  return cols;
}

// Plain-number text that every reader parses: no exponent surprises for integers.
export function fmtNum(x) {
  if (!Number.isFinite(x)) return x > 0 ? 'INF' : x < 0 ? '-INF' : 'NaN';
  return String(x);
}

export function nodeLabel(ds, net, i) {
  const di = net.nodeIds[i];
  return ds.nodes.labels[di] ?? ds.nodes.keys[di];
}
export function nodeKey(ds, net, i) { return ds.nodes.keys[net.nodeIds[i]]; }

// Labels made unique by suffix (" (2)", " (3)" ...), used where a reader keys nodes by label.
export function uniqueLabels(labels, clean = s => s) {
  const seen = new Map();
  const used = new Set();
  return labels.map(l => {
    let base = clean(String(l ?? '')) || 'node';
    let out = base;
    let k = seen.get(base) || 1;
    while (used.has(out)) out = `${base} (${++k})`;
    seen.set(base, k);
    used.add(out);
    return out;
  });
}

// The two-mode view of two-mode data (net.twoMode from buildNetwork), or null.
// Its nodes carry the dataset attribute `bipartite` (0 / 1), which every
// attribute-carrying format writes like any other attribute; Pajek and UCINET
// DL use their own two-mode layouts (mode-0 nodes first).
export function twoModeExport(net) {
  const t = net?.twoMode;
  if (!t || t.view !== 'two-mode' || !t.mode) return null;
  const order = [];
  for (let k = 0; k < 2; k++) for (let i = 0; i < net.n; i++) if (t.mode[i] === k) order.push(i);
  let n0 = 0;
  for (let i = 0; i < net.n; i++) if (t.mode[i] === 0) n0++;
  if (!n0 || n0 === net.n) return null;
  return { labels: t.labels || ['Actors', 'Events'], mode: t.mode, order, n0 };
}

export function edgeRules(net) {
  return net.edges.byRule ? Object.keys(net.edges.byRule).filter(r => net.edges.byRule[r]) : [];
}

// Edge columns from tie fields (survey tie type, strength, notes ...): the
// fields of the events behind each tie, combined per tie (numbers averaged,
// choices and text as distinct values joined by '; '). Column names avoid the
// fixed edge columns. Returns [{ name, source, type: 'double'|'string', values: Array(edges) }].
export function edgeColumns(ds, net, { taken = [] } = {}) {
  const { fields, values } = edgeTieAttributes(ds, net);
  const used = new Set(['id', 'source', 'target', 'weight', 'type', 'label', ...taken].map(x => x.toLowerCase()));
  return fields.map(f => {
    let name = f.key;
    for (let i = 2; used.has(name.toLowerCase()); i++) name = `${f.key}_${i}`;
    used.add(name.toLowerCase());
    const numeric = f.type === 'numeric';
    return { name, source: f.key, label: f.label, type: numeric ? 'double' : 'string', values: values.map(v => (v && v[f.key] !== undefined ? (numeric ? Number(v[f.key]) : String(v[f.key])) : undefined)) };
  });
}

// ---- GraphML -----------------------------------------------------------------------

const SAFE_ID = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

export function exportGraphML(ds, net, opts = {}) {
  const cols = nodeColumns(ds, net, opts);
  const ids = exportIds(ds, net, opts);
  const rules = edgeRules(net);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
  const keyIds = new Set(['label', 'weight']);
  const keyId = (name, k) => { const id = SAFE_ID.test(name) && !keyIds.has(name) ? name : `d${k}`; keyIds.add(id); return id; };
  out.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  const colIds = cols.map((c, k) => keyId(c.name, k));
  cols.forEach((c, k) => out.push(`  <key id="${xmlEscape(colIds[k])}" for="node" attr.name="${xmlEscape(c.name)}" attr.type="${c.type}"/>`));
  out.push('  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>');
  const ruleIds = rules.map((r, k) => keyId(evidenceName(r), `r${k}`));
  rules.forEach((r, k) => out.push(`  <key id="${xmlEscape(ruleIds[k])}" for="edge" attr.name="${xmlEscape(evidenceName(r))}" attr.type="double"/>`));
  const ecols = edgeColumns(ds, net, { taken: rules.map(evidenceName) });
  const ecolIds = ecols.map((c, k) => keyId(`e_${c.name}`, `t${k}`));
  ecols.forEach((c, k) => out.push(`  <key id="${xmlEscape(ecolIds[k])}" for="edge" attr.name="${xmlEscape(c.name)}" attr.type="${c.type}"/>`));
  // Two-mode view: the mode is the node attribute `bipartite` (long, which
  // networkx reads back as int, its bipartite convention); the mode labels go
  // in graph-level data (our convention; networkx keeps them in G.graph).
  const tm = twoModeExport(net);
  if (tm) {
    out.push('  <key id="mode0_label" for="graph" attr.name="mode0_label" attr.type="string"/>');
    out.push('  <key id="mode1_label" for="graph" attr.name="mode1_label" attr.type="string"/>');
  }
  out.push(`  <graph id="G" edgedefault="${net.directed ? 'directed' : 'undirected'}">`);
  if (tm) out.push(`    <data key="mode0_label">${xmlEscape(tm.labels[0])}</data>`, `    <data key="mode1_label">${xmlEscape(tm.labels[1])}</data>`);
  for (let i = 0; i < net.n; i++) {
    let s = `    <node id="${xmlEscape(ids[i])}"><data key="label">${xmlEscape(nodeLabel(ds, net, i))}</data>`;
    cols.forEach((c, k) => {
      const v = c.values[i];
      if (v === undefined) return;
      s += `<data key="${xmlEscape(colIds[k])}">${xmlEscape(c.type === 'double' || c.type === 'long' ? fmtNum(v) : String(v))}</data>`;
    });
    out.push(s + '</node>');
  }
  const E = net.edges;
  for (let e = 0; e < E.count; e++) {
    let s = `    <edge id="e${e}" source="${xmlEscape(ids[E.src[e]])}" target="${xmlEscape(ids[E.dst[e]])}"><data key="weight">${fmtNum(E.w[e])}</data>`;
    rules.forEach((r, k) => { const v = E.byRule[r][e]; if (v) s += `<data key="${xmlEscape(ruleIds[k])}">${fmtNum(v)}</data>`; });
    ecols.forEach((c, k) => { const v = c.values[e]; if (v !== undefined) s += `<data key="${xmlEscape(ecolIds[k])}">${xmlEscape(c.type === 'double' ? fmtNum(v) : v)}</data>`; });
    out.push(s + '</edge>');
  }
  out.push('  </graph>');
  out.push('</graphml>');
  return out.join('\n') + '\n';
}

export default exportGraphML;
