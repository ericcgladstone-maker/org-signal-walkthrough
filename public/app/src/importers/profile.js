// Profile / HR attribute join: attach columns from a roster table (department,
// level, location, start date...) to the people already in a Dataset.
//
// Matching is deliberately conservative. A row is applied only when its key
// matches exactly one node and that node is matched by no other row. Exact
// matches are tried first, then a normalised form (case, diacritics,
// whitespace). Anything that matches several candidates is reported as
// ambiguous and left for a person to resolve; nothing is guessed.

import { inferAttributeSchema } from '../core/model.js';
import { normalizeText } from '../core/identity.js';
import { parseCSV, rowsToObjects } from './tabular.js';

export { normalizeText };

const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+$/;

// Values a node can be matched on, per matchOn mode. Each is [exact, normalised].
function nodeValues(ds, i, matchOn) {
  const key = ds.nodes.keys[i];
  const out = [];
  if (matchOn === 'key') out.push(key);
  else if (matchOn === 'platformId') {
    for (const v of Object.values(ds.nodes.platformIds[i] || {})) if (v != null && v !== '') out.push(String(v));
    out.push(key.slice(key.indexOf(':') + 1));
  } else if (matchOn === 'email') {
    const a = ds.nodes.attrs[i] || {};
    const p = ds.nodes.platformIds[i] || {};
    for (const v of [a.email, p.email, key.startsWith('email:') ? key.slice(6) : null]) if (v && EMAIL_RE.test(v)) out.push(String(v));
  } else if (matchOn === 'name') {
    out.push(ds.nodes.labels[i]);
    const a = ds.nodes.attrs[i] || {};
    for (const k of ['name', 'real_name', 'full_name', 'display_name']) if (typeof a[k] === 'string') out.push(a[k]);
  } else throw new Error(`Unknown matchOn "${matchOn}". Use key, platformId, email or name.`);
  return [...new Set(out.filter(Boolean))];
}

// Column type inference over the raw string values of one column.
export function inferColumnType(values) {
  const vals = values.map(v => String(v ?? '').trim()).filter(v => v !== '');
  if (!vals.length) return 'empty';
  if (vals.every(v => /^(true|false|yes|no)$/i.test(v))) return 'boolean';
  if (vals.every(v => /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(v))) return 'numeric';
  if (vals.every(v => /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(v))) return 'date';
  const distinct = new Set(vals).size;
  if (distinct === vals.length && vals.length > 20) return 'id';
  return distinct <= Math.max(12, vals.length * 0.5) ? 'categorical' : 'text';
}

function convert(v, type) {
  const s = String(v ?? '').trim();
  if (s === '') return undefined;
  if (type === 'numeric') return Number(s);
  if (type === 'boolean') return /^(true|yes)$/i.test(s);
  return s;
}

// rows: array of objects, { headers, records }, string[][] with a header row, or CSV text.
function asRecords(rows) {
  if (typeof rows === 'string') return rowsToObjects(parseCSV(rows).rows);
  if (Array.isArray(rows) && Array.isArray(rows[0])) return rowsToObjects(rows);
  if (Array.isArray(rows)) return { headers: [...new Set(rows.flatMap(r => Object.keys(r)))], records: rows };
  if (rows && rows.records) return { headers: rows.headers || [...new Set(rows.records.flatMap(r => Object.keys(r)))], records: rows.records };
  throw new Error('joinProfiles needs rows as objects, a header + rows array, or CSV text.');
}

// joinProfiles(ds, rows, { keyColumn, matchOn, columns?, overwrite = true })
// -> { dataset, report: { matched, unmatchedRows, unmatchedNodes, ambiguous, columnTypes, overwritten, emptyColumns } }
// A column with no value in any matched row (an HR export's empty Manager
// column) is not added; it is listed in emptyColumns and in the join record,
// so the report and the methods appendix can say so (N18).
// dataset is a new object sharing everything with ds except node attrs and
// attributeSchema, so the original stays usable (undo).
export function joinProfiles(ds, rows, { keyColumn, matchOn = 'email', columns, overwrite = true } = {}) {
  const { headers, records } = asRecords(rows);
  if (!keyColumn || !headers.includes(keyColumn)) throw new Error(`Key column "${keyColumn}" is not in the table. Columns: ${headers.join(', ')}`);
  const cols = (columns || headers).filter(h => h !== keyColumn);
  const columnTypes = {};
  for (const c of cols) columnTypes[c] = inferColumnType(records.map(r => r[c]));

  // Index nodes by exact and normalised value.
  const exact = new Map(), loose = new Map();
  const add = (m, k, i) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(i); };
  for (let i = 0; i < ds.nodes.count; i++) {
    for (const v of nodeValues(ds, i, matchOn)) { add(exact, v, i); add(loose, normalizeText(v), i); }
  }

  const ambiguous = [];
  const unmatchedRows = [];
  const candidate = []; // [rowIndex, nodeIndex, how]
  records.forEach((r, ri) => {
    const raw = String(r[keyColumn] ?? '').trim();
    if (!raw) { unmatchedRows.push({ row: ri, key: raw, reason: 'empty key' }); return; }
    let hits = exact.get(raw), how = 'exact';
    if (!hits || !hits.size) { hits = loose.get(normalizeText(raw)); how = 'normalized'; }
    if (!hits || !hits.size) { unmatchedRows.push({ row: ri, key: raw, reason: 'no match' }); return; }
    if (hits.size > 1) {
      ambiguous.push({ row: ri, key: raw, how, nodes: [...hits].map(i => ({ index: i, key: ds.nodes.keys[i], label: ds.nodes.labels[i] })), reason: 'row matches several people' });
      return;
    }
    candidate.push([ri, [...hits][0], how]);
  });
  // A node claimed by two rows is ambiguous too (duplicate roster lines, or two people with one name).
  const byNode = new Map();
  for (const c of candidate) { if (!byNode.has(c[1])) byNode.set(c[1], []); byNode.get(c[1]).push(c); }

  const attrs = ds.nodes.attrs.map(a => ({ ...a }));
  const matched = [];
  const filled = Object.fromEntries(cols.map(c => [c, 0]));
  let overwritten = 0;
  for (const [ni, cs] of byNode) {
    if (cs.length > 1) {
      ambiguous.push({ node: { index: ni, key: ds.nodes.keys[ni], label: ds.nodes.labels[ni] }, rows: cs.map(c => ({ row: c[0], key: records[c[0]][keyColumn] })), reason: 'several rows match this person' });
      continue;
    }
    const [ri, , how] = cs[0];
    for (const c of cols) {
      const v = convert(records[ri][c], columnTypes[c]);
      if (v === undefined) continue;
      filled[c]++;
      if (c in attrs[ni] && attrs[ni][c] !== v) { if (!overwrite) continue; overwritten++; }
      attrs[ni][c] = v;
    }
    matched.push({ row: ri, node: ni, key: ds.nodes.keys[ni], how });
  }
  const matchedNodes = new Set(matched.map(m => m.node));
  const unmatchedNodes = [];
  for (let i = 0; i < ds.nodes.count; i++) if (!matchedNodes.has(i)) unmatchedNodes.push({ index: i, key: ds.nodes.keys[i], label: ds.nodes.labels[i], isBot: !!ds.nodes.isBot[i] });

  const dataset = { ...ds, nodes: { ...ds.nodes, attrs }, attributeSchema: inferAttributeSchema(attrs) };
  const emptyColumns = cols.filter(c => !filled[c]);
  dataset.meta = { ...ds.meta, profileJoins: [...(ds.meta.profileJoins || []), { keyColumn, matchOn, columns: cols.filter(c => filled[c]), emptyColumns, matched: matched.length, rows: records.length, at: Date.now() }] };
  return {
    dataset,
    report: {
      matched, unmatchedRows, unmatchedNodes, ambiguous, columnTypes, overwritten, emptyColumns,
      summary: `${matched.length} of ${records.length} rows matched one person each; ${ambiguous.length} ambiguous; ${unmatchedRows.length} rows and ${unmatchedNodes.length} people unmatched.`,
    },
  };
}
