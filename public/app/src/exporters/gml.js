// GML export. Spec: docs/formats/network-files.md section 3.
//
// Written for networkx's strict reader: integer ids 0..n-1, a unique string
// label per node (deduplicated by suffix), 7-bit ASCII with everything else as
// &#N; character references (networkx unescapes them; igraph keeps them as
// literal text, which the spec accepts as the lesser loss), attribute keys
// sanitised to [A-Za-z][A-Za-z0-9_]* (networkx and igraph accept the
// underscore, so rule evidence keeps its evidence_<rule> name), NaN values omitted, reals always written
// with a decimal point so they are not misread as integers, booleans as 1/0
// (GML has no boolean), and `multigraph 1` when there are parallel edges.

import { nodeColumns, nodeLabel, uniqueLabels, edgeRules, edgeColumns, exportIds, evidenceName } from './graphml.js';

const CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export function gmlString(s) {
  let out = '';
  for (const ch of String(s).replace(CTRL, '').replace(/[\r\n\t]+/g, ' ')) {
    const cp = ch.codePointAt(0);
    if (ch === '"' || ch === '&' || cp > 126) out += `&#${cp};`;
    else out += ch;
  }
  return `"${out}"`;
}

function gmlReal(x) {
  if (x === Infinity) return 'INF';
  if (x === -Infinity) return '-INF';
  let s = String(x);
  if (!/[.e]/i.test(s)) s += '.0';
  else if (/e/i.test(s) && !s.includes('.')) s = s.replace(/e/i, '.0e');
  return s;
}

const RESERVED = new Set(['id', 'label', 'source', 'target', 'graphics', 'node', 'edge', 'graph', 'directed', 'multigraph', 'weight']);

export function exportGML(ds, net, opts = {}) {
  const cols = nodeColumns(ds, net, opts);
  const ids = exportIds(ds, net, opts);
  const taken = new Set([...RESERVED, 'key']);
  const gmlKey = (name) => {
    let k = String(name).normalize('NFD').replace(/[^A-Za-z0-9_]/g, '');
    if (!/^[A-Za-z]/.test(k)) k = 'a' + k;
    let out = k, i = 2;
    while (taken.has(out)) out = `${k}${i++}`;
    taken.add(out);
    return out;
  };
  const keyNames = cols.map(c => gmlKey(c.name));
  const rules = edgeRules(net);
  const ruleNames = rules.map(r => gmlKey(evidenceName(r)));
  // Tie fields (survey closeness, tie type ...) as in GraphML and GEXF.
  const ecols = edgeColumns(ds, net, { taken: rules.map(evidenceName) });
  const ecolNames = ecols.map(c => gmlKey(c.name));
  const labels = uniqueLabels(Array.from({ length: net.n }, (_, i) => nodeLabel(ds, net, i)), s => s.replace(CTRL, '').trim());
  const E = net.edges;
  const pairs = new Set();
  let multi = false;
  for (let e = 0; e < E.count; e++) {
    const a = E.src[e], b = E.dst[e];
    const k = net.directed || a < b ? `${a},${b}` : `${b},${a}`;
    if (pairs.has(k)) { multi = true; break; }
    pairs.add(k);
  }
  const out = ['graph ['];
  out.push(`  directed ${net.directed ? 1 : 0}`);
  if (multi) out.push('  multigraph 1');
  for (let i = 0; i < net.n; i++) {
    out.push('  node [');
    out.push(`    id ${i}`);
    out.push(`    label ${gmlString(labels[i])}`);
    out.push(`    key ${gmlString(ids[i])}`);
    cols.forEach((c, k) => {
      const v = c.values[i];
      if (v === undefined || (typeof v === 'number' && Number.isNaN(v))) return;
      let s;
      if (c.type === 'double') s = gmlReal(v);
      else if (c.type === 'long') s = String(v);
      else if (c.type === 'boolean') s = v ? '1' : '0';
      else s = gmlString(v);
      out.push(`    ${keyNames[k]} ${s}`);
    });
    out.push('  ]');
  }
  for (let e = 0; e < E.count; e++) {
    let s = `  edge [ source ${E.src[e]} target ${E.dst[e]} weight ${gmlReal(E.w[e])}`;
    rules.forEach((r, k) => { const v = E.byRule[r][e]; if (v) s += ` ${ruleNames[k]} ${gmlReal(v)}`; });
    ecols.forEach((c, k) => { const v = c.values[e]; if (v !== undefined && !(typeof v === 'number' && Number.isNaN(v))) s += ` ${ecolNames[k]} ${c.type === 'double' ? gmlReal(v) : gmlString(v)}`; });
    out.push(s + ' ]');
  }
  out.push(']');
  return out.join('\n') + '\n';
}

export default exportGML;
