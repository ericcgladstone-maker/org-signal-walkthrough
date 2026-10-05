// UCINET DL export. Spec: docs/formats/network-files.md section 5.
//
// Default: edgelist1 with embedded labels, preceded by a LABELS: list of every
// node so isolates are kept (the spec says labels in the data that are not in
// LABELS become extra nodes, so listing them all first is consistent; that
// UCINET accepts LABELS: together with LABELS EMBEDDED is [UNVERIFIED]).
// { format: 'fullmatrix' } writes a full matrix instead (n <= 500).
//
// DL has no direction flag: a symmetric matrix means undirected, so an
// undirected network is written with each tie in both directions. Parallel
// edges are summed (one value per cell). Labels are sanitised: ASCII, no
// spaces, commas, quotes or '=', at most 18 characters, unique. UCINET shows
// them in upper case.

import { nodeLabel, twoModeExport } from './graphml.js';

export function dlLabels(ds, net) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < net.n; i++) {
    let base = String(nodeLabel(ds, net, i)).normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^A-Za-z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
    if (!base || /^[-+]?\d/.test(base)) base = `n${i + 1}${base ? '_' + base : ''}`; // numeric labels would read as indices
    base = base.slice(0, 18);
    let l = base, k = 2;
    while (used.has(l.toUpperCase())) { const suf = `_${k++}`; l = base.slice(0, 18 - suf.length) + suf; }
    used.add(l.toUpperCase());
    out.push(l);
  }
  return out;
}

// Two-mode view: a rectangular matrix, rows = mode 0, columns = mode 1
// (`dl nr= nc= format=fullmatrix`, ROW LABELS / COLUMN LABELS, spec section
// 5), whatever opts.format says, up to 250,000 cells; larger two-mode
// networks fall back to the one-mode edge list (the mode is then lost).
export function exportUCINET(ds, net, opts = {}) {
  const labels = dlLabels(ds, net);
  const tm = twoModeExport(net);
  if (tm && tm.n0 * (net.n - tm.n0) <= 250000) {
    const rows = tm.order.slice(0, tm.n0), cols = tm.order.slice(tm.n0);
    const colPos = new Map(cols.map((v, k) => [v, k]));
    const rowPos = new Map(rows.map((v, k) => [v, k]));
    const M = rows.map(() => new Float64Array(cols.length));
    const E = net.edges;
    for (let e = 0; e < E.count; e++) {
      const a = E.src[e], b = E.dst[e];
      const r = rowPos.has(a) ? rowPos.get(a) : rowPos.get(b), c = colPos.has(b) ? colPos.get(b) : colPos.get(a);
      if (r === undefined || c === undefined) continue;   // same-mode ties are not in the two-mode view
      M[r][c] += E.w[e];
    }
    const out = [`dl nr=${rows.length} nc=${cols.length} format=fullmatrix`, 'row labels:', rows.map(v => labels[v]).join(','), 'column labels:', cols.map(v => labels[v]).join(','), 'data:'];
    for (const row of M) out.push(Array.from(row, String).join(' '));
    return out.join('\n') + '\n';
  }
  const E = net.edges;
  const cell = new Map();
  const add = (a, b, w) => { const k = a * net.n + b; cell.set(k, (cell.get(k) || 0) + w); };
  for (let e = 0; e < E.count; e++) {
    add(E.src[e], E.dst[e], E.w[e]);
    if (!net.directed && E.src[e] !== E.dst[e]) add(E.dst[e], E.src[e], E.w[e]);
  }
  if (opts.format === 'fullmatrix') {
    if (net.n > 500) throw new Error('Full-matrix DL export is limited to 500 nodes; use the edge list format.');
    const out = [`dl n=${net.n} format=fullmatrix`, 'labels:', labels.join(','), 'data:'];
    for (let a = 0; a < net.n; a++) {
      const row = [];
      for (let b = 0; b < net.n; b++) row.push(String(cell.get(a * net.n + b) || 0));
      out.push(row.join(' '));
    }
    return out.join('\n') + '\n';
  }
  const out = [`dl n=${net.n} format=edgelist1`, 'labels:', labels.join(','), 'labels embedded', 'data:'];
  const keys = [...cell.keys()].sort((x, y) => x - y);
  for (const k of keys) out.push(`${labels[Math.floor(k / net.n)]} ${labels[k % net.n]} ${cell.get(k)}`);
  return out.join('\n') + '\n';
}

export default exportUCINET;
