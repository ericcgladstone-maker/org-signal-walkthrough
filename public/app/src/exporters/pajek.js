// Pajek .net export. Spec: docs/formats/network-files.md section 4.
//
// Every vertex line is written (networkx expects exactly N of them) with a
// quoted, unique label, because networkx keys nodes by label. Quotes and
// backslashes are backslash-escaped, which networkx's shlex split undoes;
// Pajek itself may show the backslash [UNVERIFIED]. Newlines and control
// characters are removed. UTF-8, as networkx reads it; classic Pajek expects
// an ANSI code page [UNVERIFIED]. Attributes are not exported (Pajek has no
// general attribute syntax); use GraphML, GEXF or CSV for those.

import { nodeLabel, uniqueLabels, twoModeExport } from './graphml.js';

const CTRL = /[\u0000-\u001F\u007F]/g;

export function pajekQuote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Two-mode view: `*Vertices N N0` with the N0 mode-0 nodes first (spec
// section 4: "first N1 are mode 1"), so Pajek and igraph see the two modes.
export function exportPajek(ds, net, opts = {}) {
  const labels = uniqueLabels(Array.from({ length: net.n }, (_, i) => nodeLabel(ds, net, i)), s => s.replace(CTRL, ' ').replace(/\s+/g, ' ').trim());
  const tm = twoModeExport(net);
  const order = tm ? tm.order : Array.from({ length: net.n }, (_, i) => i);
  const num = new Int32Array(net.n);
  order.forEach((v, k) => { num[v] = k + 1; });
  const out = [tm ? `*Vertices ${net.n} ${tm.n0}` : `*Vertices ${net.n}`];
  for (const v of order) out.push(`${num[v]} ${pajekQuote(labels[v])}`);
  out.push(net.directed ? '*Arcs' : '*Edges');
  const E = net.edges;
  for (let e = 0; e < E.count; e++) {
    let a = num[E.src[e]], b = num[E.dst[e]];
    if (tm && a > b) [a, b] = [b, a];   // actor first
    out.push(`${a} ${b} ${E.w[e]}`);
  }
  return out.join('\n') + '\n';
}

export default exportPajek;
