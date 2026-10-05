// GEXF export in the 1.2draft namespace with 1.2-compatible types only
// (integer/long/double/float/boolean/string), because networkx's reader has
// no mapping for the 1.3 list and big-number types and Gephi reads 1.2draft
// fine. Spec: docs/formats/network-files.md section 2.
//
// { dynamic: true } writes a dynamic graph. 1.2draft has only the interval
// representation, so each dated event between an edge's two endpoints (any
// event type, any role) becomes a point spell start == end. Approximate in one
// way: it does not re-apply the construction settings (rules, time window)
// that produced the network; it takes every dated event between the pair.
// Undated events add no spell.
//   timeformat 'dateTime' (default): exact UTC instants. Gephi reads these;
//     networkx 3.2.1's read_gexf raises KeyError on timeformat="dateTime"
//     spells (verified), so networkx users should export static or use 'date'.
//   timeformat 'date': day resolution (YYYY-MM-DD, one spell per day with
//     activity). networkx reads these spells as strings.

import { xmlEscape } from '../importers/xml.js';
import { nodeColumns, fmtNum, nodeLabel, edgeColumns, exportIds, evidenceName } from './graphml.js';

const GEXF_TYPE = { string: 'string', double: 'double', long: 'long', boolean: 'boolean' };

function isoUTC(ms) { return new Date(ms).toISOString().replace('.000Z', 'Z'); }

// Dated event times per network edge (index), from the dataset.
function edgeTimes(ds, net) {
  const dsToNet = new Int32Array(ds.nodes.count).fill(-1);
  for (let i = 0; i < net.n; i++) dsToNet[net.nodeIds[i]] = i;
  const E = net.edges;
  const pairToEdge = new Map();
  const pk = (a, b) => (net.directed || a < b ? a * net.n + b : b * net.n + a);
  for (let e = 0; e < E.count; e++) { const k = pk(E.src[e], E.dst[e]); if (!pairToEdge.has(k)) pairToEdge.set(k, e); }
  const times = Array.from({ length: E.count }, () => new Set());
  const ev = ds.events;
  for (let i = 0; i < ev.count; i++) {
    const t = ev.t[i];
    if (Number.isNaN(t)) continue;
    const a = dsToNet[ev.actor[i]];
    if (a < 0) continue;
    for (let j = ev.tOff[i]; j < ev.tOff[i + 1]; j++) {
      const b = dsToNet[ev.tgt[j]];
      if (b < 0 || b === a) continue;
      const e = pairToEdge.get(pk(a, b));
      if (e !== undefined) times[e].add(t);
    }
  }
  return times.map(s => [...s].sort((x, y) => x - y));
}

export function exportGEXF(ds, net, opts = {}) {
  const cols = nodeColumns(ds, net, opts);
  const ids = exportIds(ds, net, opts);
  const dynamic = !!opts.dynamic;
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gexf xmlns="http://www.gexf.net/1.2draft" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.gexf.net/1.2draft http://www.gexf.net/1.2draft/gexf.xsd" version="1.2">');
  out.push(`  <meta lastmodifieddate="${today}"><creator>Org Signal</creator></meta>`);
  const tf = opts.timeformat === 'date' ? 'date' : 'dateTime';
  const fmtT = tf === 'date' ? ms => new Date(ms).toISOString().slice(0, 10) : isoUTC;
  out.push(`  <graph mode="${dynamic ? 'dynamic' : 'static'}" defaultedgetype="${net.directed ? 'directed' : 'undirected'}"${dynamic ? ` timeformat="${tf}"` : ''}>`);
  if (cols.length) {
    out.push('    <attributes class="node" mode="static">');
    cols.forEach((c, k) => out.push(`      <attribute id="${k}" title="${xmlEscape(c.name)}" type="${GEXF_TYPE[c.type]}"/>`));
    out.push('    </attributes>');
  }
  // Evidence per construction rule (replies, mentions, ...) on every tie, so a
  // tie can be filtered or styled by what created it in Gephi.
  const rules = Object.keys(net.edges.byRule || {}).filter(r => net.edges.byRule[r]?.length === net.edges.count);
  // Tie fields (survey tie type, strength ...) as further edge attributes.
  const ecols = edgeColumns(ds, net, { taken: rules.map(evidenceName) });
  if (rules.length || ecols.length) {
    out.push('    <attributes class="edge" mode="static">');
    rules.forEach((r, k) => out.push(`      <attribute id="e${k}" title="${xmlEscape(evidenceName(r))}" type="double"/>`));
    ecols.forEach((c, k) => out.push(`      <attribute id="t${k}" title="${xmlEscape(c.name)}" type="${c.type}"/>`));
    out.push('    </attributes>');
  }
  out.push('    <nodes>');
  for (let i = 0; i < net.n; i++) {
    const vals = [];
    cols.forEach((c, k) => {
      const v = c.values[i];
      if (v === undefined) return;
      vals.push(`<attvalue for="${k}" value="${xmlEscape(c.type === 'double' || c.type === 'long' ? fmtNum(v) : String(v))}"/>`);
    });
    const open = `      <node id="${xmlEscape(ids[i])}" label="${xmlEscape(nodeLabel(ds, net, i))}"`;
    out.push(vals.length ? `${open}><attvalues>${vals.join('')}</attvalues></node>` : `${open}/>`);
  }
  out.push('    </nodes>');
  out.push('    <edges>');
  const E = net.edges;
  const times = dynamic ? edgeTimes(ds, net) : null;
  const seen = new Map();
  for (let e = 0; e < E.count; e++) {
    const a = E.src[e], b = E.dst[e];
    const pk = net.directed || a < b ? `${a},${b}` : `${b},${a}`;
    const dup = (seen.get(pk) || 0) + 1;
    seen.set(pk, dup);
    // Gephi needs parallel edges to differ by kind.
    const kind = dup > 1 ? ` kind="parallel-${dup}"` : '';
    const open = `      <edge id="${e}" source="${xmlEscape(ids[a])}" target="${xmlEscape(ids[b])}" weight="${fmtNum(E.w[e])}"${kind}`;
    const ev = rules.map((r, k) => (E.byRule[r][e] ? `<attvalue for="e${k}" value="${fmtNum(E.byRule[r][e])}"/>` : '')).join('')
      + ecols.map((c, k) => (c.values[e] !== undefined ? `<attvalue for="t${k}" value="${xmlEscape(c.type === 'double' ? fmtNum(c.values[e]) : c.values[e])}"/>` : '')).join('');
    const spells = times && times[e].length ? `<spells>${[...new Set(times[e].map(fmtT))].map(v => `<spell start="${v}" end="${v}"/>`).join('')}</spells>` : '';
    out.push(ev || spells ? `${open}>${ev ? `<attvalues>${ev}</attvalues>` : ''}${spells}</edge>` : `${open}/>`);
  }
  out.push('    </edges>');
  out.push('  </graph>');
  out.push('</gexf>');
  return out.join('\n') + '\n';
}

export default exportGEXF;
