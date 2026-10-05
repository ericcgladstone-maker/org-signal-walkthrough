// GraphML network file, per docs/formats/network-files.md section 1.
//
// Written for networkx/Gephi compatibility: every <data> key is declared,
// key ids equal their attr.name (Gephi may match on either), attribute types
// are from the GraphML set (boolean, int, long, double, string), no nested
// graphs or hyperedges, and XML-illegal control characters are stripped.
// Nodes are every person in the world (isolates included, as an authored
// network file would list them); edges are the declared-tie records.

import { u8, xmlEscape } from './util.js';

export function write({ world, records, ident, spec }) {
  const n = world.n;
  const nodeId = i => ident.key[i].slice(ident.key[i].indexOf(':') + 1);
  // Node attribute keys and types, inferred over all people.
  const attrTypes = new Map();
  for (let i = 0; i < n; i++) {
    for (const [k, v] of Object.entries(world.people.attrs[i] || {})) {
      if (v === null || v === undefined || typeof v === 'object') continue;
      const t = typeof v === 'boolean' ? 'boolean' : typeof v === 'number' ? (Number.isInteger(v) && Math.abs(v) < 2 ** 31 ? 'int' : 'double') : 'string';
      const prev = attrTypes.get(k);
      attrTypes.set(k, !prev || prev === t ? t : (prev === 'int' && t === 'double') || (prev === 'double' && t === 'int') ? 'double' : 'string');
    }
  }
  const reserved = new Set(['label', 'weight', 'tie_kind', 'first_contact', 'last_contact']);
  const nodeKeys = [...attrTypes].filter(([k]) => !reserved.has(k) && /^[A-Za-z_][\w.-]*$/.test(k)).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const directed = world.ties.directed;
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
  lines.push('  <key id="label" for="node" attr.name="label" attr.type="string"/>');
  for (const [k, t] of nodeKeys) lines.push(`  <key id="${xmlEscape(k)}" for="node" attr.name="${xmlEscape(k)}" attr.type="${t}"/>`);
  lines.push('  <key id="weight" for="edge" attr.name="weight" attr.type="double"/>');
  lines.push('  <key id="tie_kind" for="edge" attr.name="tie_kind" attr.type="string"/>');
  lines.push('  <key id="first_contact" for="edge" attr.name="first_contact" attr.type="string"/>');
  lines.push('  <key id="last_contact" for="edge" attr.name="last_contact" attr.type="string"/>');
  lines.push(`  <graph id="G" edgedefault="${directed ? 'directed' : 'undirected'}">`);
  const fmtVal = (v, t) => (t === 'boolean' ? (v ? 'true' : 'false') : xmlEscape(String(v)));
  for (let i = 0; i < n; i++) {
    const a = world.people.attrs[i] || {};
    let s = `    <node id="${xmlEscape(nodeId(i))}"><data key="label">${xmlEscape(world.people.label[i])}</data>`;
    for (const [k, t] of nodeKeys) {
      const v = a[k];
      if (v === null || v === undefined || v === '' || typeof v === 'object') continue;
      s += `<data key="${xmlEscape(k)}">${fmtVal(t === 'string' ? String(v) : v, t)}</data>`;
    }
    lines.push(s + '</node>');
  }
  let e = 0;
  for (const rec of records) {
    if (rec.kind !== 'declared' || rec.actor < 0) continue;
    for (const b of rec.to || []) {
      let s = `    <edge id="e${e++}" source="${xmlEscape(nodeId(rec.actor))}" target="${xmlEscape(nodeId(b))}"><data key="weight">${round(rec.weight ?? 1)}</data>`;
      if (rec.meta?.tieKind) s += `<data key="tie_kind">${xmlEscape(rec.meta.tieKind)}</data>`;
      // The tie's start is known only when it began inside or before the span on record;
      // ties present for the whole span carry the span start, which is not a real first contact.
      if (Number.isFinite(rec.t) && rec.t !== world.span.start) s += `<data key="first_contact">${new Date(rec.t).toISOString()}</data>`;
      const until = rec.meta?.until;
      if (Number.isFinite(until)) s += `<data key="last_contact">${new Date(until).toISOString()}</data>`;
      lines.push(s + '</edge>');
    }
  }
  lines.push('  </graph>');
  lines.push('</graphml>');
  return [{ path: `${spec.context || world.context}-network.graphml`, bytes: u8(lines.join('\n') + '\n') }];
}

const round = x => Math.round(x * 1000) / 1000;
