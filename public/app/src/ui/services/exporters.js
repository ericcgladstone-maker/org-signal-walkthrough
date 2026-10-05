// Adapter over src/exporters/* (owner: importers-A). Every exporter is
//   exportX(ds, net, { nodeMetrics, communities, attrs, omitContacts }) -> string
// (exportCSV returns { nodes, edges, metrics }). They need the full Network
// object, which normally lives in the analysis worker; we ask the engine for
// it (network()/getNetwork()) and otherwise rebuild it on the main thread
// with the same settings through the pure buildNetwork, which is
// deterministic, so the file matches what the views show.

import { MOCK, tryImport, pickFn } from './modules.js';
import { engine } from './engine.js';

export const FORMATS = [
  { id: 'graphml', label: 'GraphML', ext: 'graphml', mime: 'application/graphml+xml', module: 'graphml.js', fn: 'exportGraphML', note: 'Gephi, networkx, igraph, Cytoscape' },
  { id: 'gexf', label: 'GEXF', ext: 'gexf', mime: 'application/xml', module: 'gexf.js', fn: 'exportGEXF', note: 'Gephi, with attributes' },
  { id: 'gml', label: 'GML', ext: 'gml', mime: 'text/plain', module: 'gml.js', fn: 'exportGML', note: 'igraph, networkx, yEd' },
  { id: 'pajek', label: 'Pajek .net', ext: 'net', mime: 'text/plain', module: 'pajek.js', fn: 'exportPajek', note: 'Pajek, statnet' },
  { id: 'ucinet', label: 'UCINET DL', ext: 'dl', mime: 'text/plain', module: 'ucinet.js', fn: 'exportUCINET', note: 'UCINET, NetDraw' },
  { id: 'nodes', label: 'People CSV (Gephi nodes table)', ext: 'csv', mime: 'text/csv', module: 'csv.js', fn: 'exportNodesCSV', note: 'Id, label, attributes, measures' },
  { id: 'edges', label: 'Ties CSV (Gephi edges table)', ext: 'csv', mime: 'text/csv', module: 'csv.js', fn: 'exportEdgesCSV', note: 'Source, target, weight, evidence per rule' },
  { id: 'metrics', label: 'Metrics CSV', ext: 'csv', mime: 'text/csv', module: 'csv.js', fn: 'exportMetricsCSV', note: 'Measures per person only' },
];

export async function available() {
  const out = {};
  for (const f of FORMATS) out[f.id] = !!pickFn(await tryImport(`../../exporters/${f.module}`), [f.fn]);
  return out;
}

// Full Network object on the main thread.
export async function mainThreadNetwork(ds, settings) {
  const viaEngine = pickFn(engine.impl, ['network', 'getNetwork']);
  if (viaEngine) { const n = await viaEngine({ edges: true }); if (n?.edges?.src && n?.nodeIds) return n; }
  if (MOCK) return (await import('./mock.js')).buildNetwork(ds, settings);
  const c = await tryImport('../../analysis/construct.js');
  const build = pickFn(c, ['buildNetwork']);
  if (!build) throw new Error('Building the network for export needs src/analysis/construct.js.');
  return build(ds, settings);
}

// omitContacts (default on in Methods & Export, N19) leaves out email
// addresses, handles and account ids, and writes p1, p2, ... for ids that
// hold them.
export async function exportAs(id, { ds, settings, nodeMetrics, communities, omitContacts = false }) {
  const f = FORMATS.find(x => x.id === id);
  const fn = pickFn(await tryImport(`../../exporters/${f.module}`), [f.fn]);
  if (!fn) throw new Error(`${f.label} export (src/exporters/${f.module}) is not available in this build.`);
  const net = await mainThreadNetwork(ds, settings);
  const metrics = {};
  for (const [k, v] of Object.entries(nodeMetrics || {})) if (k !== 'meta' && v && v.length === net.n) metrics[k] = v;
  const text = await fn(ds, net, { nodeMetrics: metrics, communities: communities?.membership?.length === net.n ? communities : null, omitContacts });
  const suffix = ['nodes', 'edges', 'metrics'].includes(id) ? `-${id}` : '';
  return { text, filename: `${fileBase(ds)}${suffix}.${f.ext}`, mime: f.mime };
}

// Short file name stem from the dataset name (D17): the parenthetical detail
// goes except a seed ("Synthetic workplace, bridge-dependent (Slack, seed 1)"
// becomes "synthetic-workplace-bridge-dependent-seed1", J14), at most four
// words and 40 characters before it. A survey's
// combine rule stays (C13), so the union and reciprocated saves of one
// survey get different names: "SOC101 A4 friendship (union)" becomes
// "soc101-a4-friendship-union".
const RULE_WORDS = [[/\bunion\b/i, 'union'], [/\breciprocated\b|\bintersection\b/i, 'reciprocated'], [/\bas reported\b/i, 'as-reported']];
export function fileBase(ds, fallback = 'network') {
  const name = String(ds?.meta?.name || '');
  const words = name.replace(/\([^)]*\)/g, ' ').toLowerCase().match(/[a-z0-9]+/g) || [];
  let out = '';
  for (const w of words.slice(0, 4)) { if ((out ? out.length + 1 : 0) + w.length > 40) break; out = out ? `${out}-${w}` : w; }
  const paren = (name.match(/\([^)]*\)/g) || []).join(' ');
  const rule = RULE_WORDS.find(([re]) => re.test(paren))?.[1];
  if (rule && !out.endsWith(rule)) out = out ? `${out}-${rule}` : rule;
  const seed = paren.match(/\bseed (\d+)\b/i)?.[1];
  if (seed && out) out = `${out}-seed${seed}`;
  return out || fallback;
}
