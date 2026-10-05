// CSV export in Gephi's spreadsheet conventions (docs/formats/network-files.md
// section 6): a node table (Id, Label, attributes, metrics, community), an
// edge table (Source, Target, Type, Weight, one evidence_<rule> column per
// active construction rule) and a metrics-only table. Ids are dataset node
// keys, or p1..pn when contact details are left out (exportIds).
// RFC 4180 quoting; no formula-injection prefix is added, because that would
// change ids that Gephi must match between the two tables.

import { nodeColumns, fmtNum, nodeLabel, edgeRules, edgeColumns, exportIds, evidenceName } from './graphml.js';

export function csvCell(v) {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? fmtNum(v) : String(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const row = cells => cells.map(csvCell).join(',');

export function exportNodesCSV(ds, net, opts = {}) {
  const cols = nodeColumns(ds, net, opts);
  const ids = exportIds(ds, net, opts);
  const out = [row(['Id', 'Label', ...cols.map(c => c.name)])];
  for (let i = 0; i < net.n; i++) out.push(row([ids[i], nodeLabel(ds, net, i), ...cols.map(c => c.values[i])]));
  return out.join('\r\n') + '\r\n';
}

// Tie fields follow the rule columns, one column each (see edgeColumns).
export function exportEdgesCSV(ds, net, opts = {}) {
  const rules = edgeRules(net);
  const ids = exportIds(ds, net, opts);
  const ecols = edgeColumns(ds, net, { taken: rules.map(evidenceName) });
  const out = [row(['Source', 'Target', 'Type', 'Weight', ...rules.map(evidenceName), ...ecols.map(c => c.name)])];
  const E = net.edges;
  const type = net.directed ? 'Directed' : 'Undirected';
  for (let e = 0; e < E.count; e++) {
    out.push(row([ids[E.src[e]], ids[E.dst[e]], type, E.w[e], ...rules.map(r => net.edges.byRule[r][e] || 0), ...ecols.map(c => c.values[e])]));
  }
  return out.join('\r\n') + '\r\n';
}

export function exportMetricsCSV(ds, net, { nodeMetrics, communities, omitContacts } = {}) {
  const cols = nodeColumns(ds, net, { nodeMetrics, communities, attrs: [] });
  const ids = exportIds(ds, net, { omitContacts });
  const out = [row(['Id', 'Label', ...cols.map(c => c.name)])];
  for (let i = 0; i < net.n; i++) out.push(row([ids[i], nodeLabel(ds, net, i), ...cols.map(c => c.values[i])]));
  return out.join('\r\n') + '\r\n';
}

export function exportCSV(ds, net, opts = {}) {
  return { nodes: exportNodesCSV(ds, net, opts), edges: exportEdgesCSV(ds, net, opts), metrics: exportMetricsCSV(ds, net, opts) };
}

export default exportCSV;
