// Network Canvas exports (Interviewer, Interviewer Classic, Fresco): the
// egor-compatible CSV file set and the per-session GraphML.
//
// Spec: docs/formats/network-canvas-and-surveys.md section 1. Column names are
// the ones the exporter source writes (networkCanvasEgoUUID, nodeID, ...), not
// the illustrative ego_id/alter_id of Network Canvas's own docs page.
//
// What this data is: one respondent's declared personal network per session.
// Alter attributes and alter-alter ties are the respondent's report, not
// observed interaction, so every source is an ego view. Alters are keyed by
// ego (nc:<egoUUID>:<alterUUID>) and are never merged across interviews.
//
// Also exports small cell helpers that survey.js reuses.

import { parseXml, kids, kid, attrLocal } from './xml.js';
import { parseCSV, rowsToObjects, entryText, headerRow } from './tabular.js';
import { peek } from '../core/fileset.js';

// ---- shared cell helpers ------------------------------------------------------

// Network Canvas (and many survey tools) prefix cells that start with = + - @ or
// tab with a single quote so spreadsheets do not run them as formulas. Undo it.
export function cleanCell(v) {
  if (v == null) return '';
  const s = String(v);
  return /^'[=+\-@\t]/.test(s) ? s.slice(1) : s;
}

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const COMMA_NUM_RE = /^[+-]?\d+,\d+$/;

// Typed value from a CSV cell: boolean, number, or trimmed string; undefined for empty.
// decimalComma: semicolon-delimited European files write 0,333 for 0.333.
export function typedValue(raw, { decimalComma = false } = {}) {
  const s = cleanCell(raw).trim();
  if (s === '') return undefined;
  if (/^(true|false)$/i.test(s)) return s.toLowerCase() === 'true';
  if (NUM_RE.test(s)) return Number(s);
  if (decimalComma && COMMA_NUM_RE.test(s)) return Number(s.replace(',', '.'));
  return s;
}

export function numericValue(raw, opts) {
  const v = typedValue(raw, opts);
  return typeof v === 'number' && Number.isFinite(v) ? v : NaN;
}

// Name normalisation used for roster matching: diacritics, case and whitespace.
export function normName(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ISO-8601 with an explicit zone -> epoch ms. Date.parse is only well defined for
// this form, so anything else is NaN rather than an implementation guess.
export function isoMs(s) {
  const t = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(t)) return NaN;
  return Date.parse(t);
}

const baseName = rel => rel.slice(rel.lastIndexOf('/') + 1);

// ---- detection ---------------------------------------------------------------

const EGO_FIXED = ['networkCanvasEgoUUID', 'networkCanvasCaseID', 'networkCanvasSessionID', 'networkCanvasProtocolName',
  'sessionStart', 'sessionFinish', 'sessionExported', 'APP_VERSION', 'COMMIT_HASH'];
const ALTER_FIXED = ['nodeID', 'networkCanvasEgoUUID', 'networkCanvasUUID'];
const EDGE_FIXED = ['edgeID', 'from', 'to', 'networkCanvasEgoUUID', 'networkCanvasUUID', 'networkCanvasSourceUUID', 'networkCanvasTargetUUID'];

// Which NC file is this? By header first (survives renamed files), file name second.
function classifyCsv(rel, header) {
  const h = new Set(header.map(x => String(x).trim()));
  const name = baseName(rel);
  if (/_adjacencyMatrix_\w*\.csv$/i.test(name)) return 'matrix';
  if (!h.has('networkCanvasEgoUUID')) return null;
  if (h.has('edgeID') && h.has('from') && h.has('to')) return 'edges';
  if (h.has('nodeID') && h.has('networkCanvasUUID')) return 'alters';
  if (h.has('networkCanvasCaseID') || h.has('networkCanvasSessionID') || /_ego\.csv$/i.test(name)) return 'ego';
  return null;
}

function isNcGraphml(head) {
  return /schema\.networkcanvas\.com\/xmlns/.test(head) || /networkCanvasUUID/.test(head);
}

async function scan(fs) {
  const csv = [], graphml = [];
  for (const e of fs.entries) {
    if (/\.csv$/i.test(e.rel)) {
      const header = await headerRow(e);
      const role = classifyCsv(e.rel, header);
      if (role) csv.push({ entry: e, role });
    } else if (/\.graphml$/i.test(e.rel)) {
      if (isNcGraphml(await peek(e, 8192))) graphml.push(e);
    }
  }
  // An adjacency matrix only counts when the rest of an NC CSV export is there too;
  // its header (uuids) carries nothing NC-specific.
  const hasNcCsv = csv.some(c => c.role !== 'matrix');
  return { csv: hasNcCsv ? csv : [], graphml };
}

async function detect(fs) {
  const { csv, graphml } = await scan(fs);
  if (!csv.length && !graphml.length) return { score: 0 };
  return {
    score: 0.95,
    reason: `Network Canvas export: ${csv.length} CSV file(s), ${graphml.length} GraphML file(s)`,
    files: [...csv.map(c => c.entry.rel), ...graphml.map(e => e.rel)],
  };
}

// ---- shared session assembly ---------------------------------------------------

// Collects one or more ego interviews, then writes them to the builder.
class Sessions {
  constructor() { this.egos = new Map(); this.alterEgo = new Map(); }

  ego(uuid) {
    let e = this.egos.get(uuid);
    if (!e) {
      e = { uuid, attrs: {}, t: NaN, label: null, alters: new Map(), byNodeId: new Map(), edges: [], fromEgoFile: false };
      this.egos.set(uuid, e);
    }
    return e;
  }

  alter(egoUuid, uuid, { nodeId, type, label, attrs }) {
    const e = this.ego(egoUuid);
    const a = { uuid, type, label, attrs };
    e.alters.set(uuid, a);
    if (nodeId != null && nodeId !== '') e.byNodeId.set(String(nodeId), uuid);
    this.alterEgo.set(uuid, egoUuid);
    return a;
  }
}

// Pick the column used as ego->alter tie weight: an explicit option, else the
// first numeric alter variable whose name says closeness or strength.
function pickWeightColumn(alters, option) {
  if (option) return option;
  const cols = new Set();
  for (const a of alters) for (const k of Object.keys(a.attrs)) cols.add(k);
  for (const c of cols) {
    if (!/closeness|close|tie.?strength|strength/i.test(c)) continue;
    const vals = alters.map(a => a.attrs[c]).filter(v => v !== undefined);
    if (vals.length && vals.every(v => typeof v === 'number')) return c;
  }
  return null;
}

function pickEdgeWeightColumn(edges, option) {
  if (option) return option;
  const cols = new Set();
  for (const ed of edges) for (const k of Object.keys(ed.attrs)) cols.add(k);
  for (const c of cols) {
    const vals = edges.map(ed => ed.attrs[c]).filter(v => v !== undefined);
    if (vals.length && vals.every(v => typeof v === 'number')) return c;
  }
  return null;
}

function emit(sessions, builder, { options, fileNames, format }) {
  const egos = [...sessions.egos.values()];
  const egoKeys = egos.map(e => `nc:${e.uuid}`);
  builder.beginSource({
    format, family: 'survey', medium: 'survey', view: 'ego', context: 'survey', tz: 'UTC', fileNames,
    egoKey: egoKeys.length === 1 ? egoKeys[0] : null, egoKeys, directed: false,
  });
  if (egos.length > 1) {
    builder.warn('multiple-egos', `${egos.length} separate ego interviews: a sample of independent personal networks, not one connected network. Alters are kept per interview and never merged across respondents.`, 1);
  }
  const allAlters = egos.flatMap(e => [...e.alters.values()]);
  const wcol = pickWeightColumn(allAlters, options.weightColumn);
  const ecol = pickEdgeWeightColumn(egos.flatMap(e => e.edges), options.edgeWeightColumn);
  let encrypted = 0;
  const countEnc = attrs => { for (const v of Object.values(attrs)) if (v === 'ENCRYPTED') encrypted++; };

  for (const e of egos) {
    const egoKey = `nc:${e.uuid}`;
    if (!e.fromEgoFile) builder.warn('missing-ego-record', 'Alters or ties refer to an ego with no ego record; the ego node has no attributes.', 1);
    countEnc(e.attrs);
    const interview = e.attrs.caseId ?? e.uuid;
    const ego = builder.node(egoKey, { label: e.label || `Ego ${interview}`, attrs: { ...e.attrs, kind: 'ego', interview } });
    builder.stat('egos');
    const alterIdx = new Map();
    for (const a of e.alters.values()) {
      countEnc(a.attrs);
      const i = builder.node(`${egoKey}:${a.uuid}`, {
        label: a.label || `${a.type || 'Alter'} ${a.uuid.slice(0, 8)}`,
        attrs: { ...a.attrs, kind: 'alter', nodeType: a.type, interview },
      });
      alterIdx.set(a.uuid, i);
      builder.stat('alters');
    }
    const ctx = builder.context(egoKey, { name: `Interview ${interview}`, kind: 'canvas', visibility: 'private', medium: 'survey', members: [ego, ...alterIdx.values()] });
    // Network Canvas stores ego-alter tie data (closeness, contact frequency) on the
    // alter itself, and the GraphML has no ego node at all, so every alter gets a
    // declared tie from the ego that named it.
    for (const a of e.alters.values()) {
      const w = wcol ? a.attrs[wcol] : undefined;
      builder.event({ type: 'declared', t: e.t, actor: ego, targets: [[alterIdx.get(a.uuid), 'declared']], context: ctx, weight: typeof w === 'number' ? w : 1 });
      builder.stat('egoAlterTies');
    }
    // Alter-alter ties are the respondent's perception. One context per edge type so
    // that, e.g., "knows" and "dislikes" ties stay separable when building networks.
    const typeCtx = new Map();
    for (const ed of e.edges) {
      const s = alterIdx.get(ed.src), t = alterIdx.get(ed.dst);
      if (s === undefined || t === undefined) {
        builder.warn('unresolved-edge-endpoint', 'Alter-alter ties whose endpoints are not among the interview\'s alters (skipped)', 1);
        continue;
      }
      const ty = ed.type || 'edge';
      if (!typeCtx.has(ty)) {
        typeCtx.set(ty, builder.context(`${egoKey}#${ty}`, { name: `Interview ${interview}: ${ty} (as perceived by ego)`, kind: 'canvas', visibility: 'private', medium: 'survey', members: [...alterIdx.values()] }));
      }
      const w = ecol ? ed.attrs[ecol] : undefined;
      builder.event({ type: 'declared', t: e.t, actor: s, targets: [[t, 'declared']], context: typeCtx.get(ty), weight: typeof w === 'number' ? w : 1 });
      builder.stat('alterAlterTies');
    }
  }
  // Alters but no alter-alter ties anywhere: the export carried no edge list
  // or adjacency matrix (not ticked in the export options, or no tie question
  // was asked). The network is then a star around each ego.
  const nAlters = egos.reduce((n, e) => n + e.alters.size, 0);
  if (nAlters >= 2 && !egos.some(e => e.edges.length)) {
    builder.warn('nc-no-alter-ties', `No ties between alters came with ${egos.length === 1 ? 'this interview' : `these ${egos.length} interviews`} (no edgeList or adjacencyMatrix file, or none with rows), so each personal network is a star around its ego: density, clustering, effective size and constraint cannot be computed from it. If the protocol asked who knows whom, export again from Network Canvas with the edge list (or adjacency matrix) option selected.`);
  }
  if (encrypted) builder.warn('encrypted-values', 'Some variables were anonymised in Network Canvas and exported as the literal text ENCRYPTED; their values are not available.', encrypted);
}

// ---- CSV -----------------------------------------------------------------------------

function rowAttrs(rec, fixed) {
  const attrs = {};
  for (const [k, v] of Object.entries(rec)) {
    if (fixed.includes(k)) continue;
    const tv = typedValue(v);
    if (tv !== undefined) attrs[k] = tv;
  }
  return attrs;
}

const LABEL_COLS = ['name', 'label', 'nickname', 'first_name'];
function labelOf(attrs) {
  for (const c of LABEL_COLS) if (typeof attrs[c] === 'string' && attrs[c] !== 'ENCRYPTED') return attrs[c];
  return null;
}

async function readCsvSet(files, sessions, builderWarn) {
  const read = async e => rowsToObjects(parseCSV(await entryText(e)).rows).records;
  // Egos first, then alters (they define nodeID -> UUID per session), then ties.
  for (const { entry } of files.filter(f => f.role === 'ego')) {
    for (const rec of await read(entry)) {
      const uuid = cleanCell(rec.networkCanvasEgoUUID).trim();
      if (!uuid) continue;
      const e = sessions.ego(uuid);
      e.fromEgoFile = true;
      e.t = isoMs(rec.sessionStart);
      const attrs = rowAttrs(rec, EGO_FIXED);
      if (rec.networkCanvasCaseID) attrs.caseId = cleanCell(rec.networkCanvasCaseID).trim();
      if (rec.networkCanvasSessionID) attrs.sessionId = cleanCell(rec.networkCanvasSessionID).trim();
      if (rec.networkCanvasProtocolName) attrs.protocol = cleanCell(rec.networkCanvasProtocolName).trim();
      Object.assign(e.attrs, attrs);
      e.label = labelOf(attrs);
    }
  }
  for (const { entry } of files.filter(f => f.role === 'alters')) {
    const type = (/_attributeList_(\w+)\.csv$/i.exec(baseName(entry.rel)) || [])[1] || 'Node';
    for (const rec of await read(entry)) {
      const ego = cleanCell(rec.networkCanvasEgoUUID).trim();
      const uuid = cleanCell(rec.networkCanvasUUID).trim();
      if (!ego || !uuid) { builderWarn('missing-uuid', 'Alter rows without an ego or alter UUID (skipped)'); continue; }
      const attrs = rowAttrs(rec, ALTER_FIXED);
      sessions.alter(ego, uuid, { nodeId: cleanCell(rec.nodeID).trim(), type, label: labelOf(attrs), attrs });
    }
  }
  const edgeTypes = new Set();
  for (const { entry } of files.filter(f => f.role === 'edges')) {
    const type = (/_edgeList_(\w+)\.csv$/i.exec(baseName(entry.rel)) || [])[1] || 'edge';
    edgeTypes.add(type.toLowerCase());
    for (const rec of await read(entry)) {
      const egoUuid = cleanCell(rec.networkCanvasEgoUUID).trim();
      if (!egoUuid) continue;
      const e = sessions.ego(egoUuid);
      // Join by alter UUID; nodeID restarts at 1 in every session, so it is only a
      // fallback within this ego's own session.
      const src = cleanCell(rec.networkCanvasSourceUUID).trim() || e.byNodeId.get(cleanCell(rec.from).trim());
      const dst = cleanCell(rec.networkCanvasTargetUUID).trim() || e.byNodeId.get(cleanCell(rec.to).trim());
      e.edges.push({ src, dst, type, attrs: rowAttrs(rec, EDGE_FIXED) });
    }
  }
  // Adjacency matrices: used only for edge types that have no edge list, since
  // the edge list carries the same ties plus their variables.
  for (const { entry } of files.filter(f => f.role === 'matrix')) {
    const type = (/_adjacencyMatrix_(\w+)\.csv$/i.exec(baseName(entry.rel)) || [])[1] || 'edge';
    if (edgeTypes.has(type.toLowerCase())) { builderWarn('matrix-duplicate', `Adjacency matrix for "${type}" ignored because its edge list is present`, 'info'); continue; }
    const { rows } = parseCSV(await entryText(entry));
    if (!rows.length) continue;
    const cols = rows[0].map(x => cleanCell(x).trim());
    let used = 0;
    for (let r = 1; r < rows.length; r++) {
      const ru = cleanCell(rows[r][0]).trim();
      for (let c = 1; c < cols.length; c++) {
        // The exporter writes both directions of each undirected tie: read the upper triangle only.
        const cu = cols[c];
        if (!ru || !cu || ru === cu || cols.indexOf(ru) >= c) continue;
        const v = numericValue(rows[r][c]);
        if (!(v > 0)) continue;
        const egoUuid = sessions.alterEgo.get(ru);
        if (!egoUuid || sessions.alterEgo.get(cu) !== egoUuid) { builderWarn('unresolved-edge-endpoint-matrix', 'Adjacency matrix cells naming alters not found in any alter file (skipped)'); continue; }
        sessions.ego(egoUuid).edges.push({ src: ru, dst: cu, type, attrs: {} });
        used++;
      }
    }
    if (used) builderWarn('matrix-symmetrised', `Ties of type "${type}" came from an adjacency matrix, which Network Canvas symmetrises and binarises: direction and edge variables are not available.`);
  }
}

// ---- GraphML -----------------------------------------------------------------------

function graphmlValue(text, type) {
  const s = text.trim();
  if (s === '') return undefined;
  switch (type) {
    case 'int': case 'integer': case 'long': case 'float': case 'double': {
      const n = Number(s); return Number.isFinite(n) ? n : s;
    }
    case 'boolean': return /^(true|1)$/i.test(s);
    default: return cleanCell(s);
  }
}

function readGraphml(root, sessions, warn) {
  const keys = new Map();
  for (const k of kids(root, 'key')) {
    keys.set(k.attrs.id, { name: k.attrs['attr.name'] || k.attrs.id, type: k.attrs['attr.type'] || 'string' });
  }
  const dataOf = el => {
    const out = {};
    for (const d of kids(el, 'data')) {
      const k = keys.get(d.attrs.key);
      if (!k) { warn('undeclared-key', 'GraphML <data> referencing an undeclared key (kept under the raw key id)'); }
      const name = k ? k.name : d.attrs.key;
      const v = graphmlValue(d.text, k ? k.type : 'string');
      if (v !== undefined) out[name] = v;
    }
    return out;
  };
  // Interviewer Classic's "merge sessions" wrote several <graph>s in one file; each is one ego.
  for (const g of kids(root, 'graph')) {
    const gdata = dataOf(g);
    const uuid = String(gdata.networkCanvasUUID ?? attrLocal(g, 'sessionUUID') ?? '').trim();
    if (!uuid) { warn('missing-uuid', 'GraphML graph without an ego UUID (skipped)'); continue; }
    const e = sessions.ego(uuid);
    e.fromEgoFile = true;
    const attrs = {};
    for (const [k, v] of Object.entries(gdata)) if (!/^networkCanvas/.test(k)) attrs[k] = v;
    const caseId = attrLocal(g, 'caseId');
    if (caseId) attrs.caseId = caseId;
    const sess = attrLocal(g, 'sessionUUID');
    if (sess) attrs.sessionId = sess;
    const proto = attrLocal(g, 'protocolName');
    if (proto) attrs.protocol = proto;
    Object.assign(e.attrs, attrs);
    e.label = labelOf(attrs);
    e.t = isoMs(attrLocal(g, 'sessionStartTime'));
    const idToUuid = new Map();
    for (const n of kids(g, 'node')) {
      const d = dataOf(n);
      const au = String(d.networkCanvasUUID ?? '').trim() || `node-${n.attrs.id}`;
      idToUuid.set(n.attrs.id, au);
      const type = d.networkCanvasType != null ? String(d.networkCanvasType) : 'Node';
      const label = d.label != null ? String(d.label) : null;
      const a = {};
      for (const [k, v] of Object.entries(d)) if (!/^networkCanvas/.test(k) && k !== 'label') a[k] = v;
      sessions.alter(uuid, au, { nodeId: n.attrs.id, type, label: label ?? labelOf(a), attrs: a });
    }
    for (const ed of kids(g, 'edge')) {
      const d = dataOf(ed);
      const a = {};
      for (const [k, v] of Object.entries(d)) if (!/^networkCanvas/.test(k) && k !== 'label') a[k] = v;
      e.edges.push({
        src: String(d.networkCanvasSourceUUID ?? idToUuid.get(ed.attrs.source) ?? ''),
        dst: String(d.networkCanvasTargetUUID ?? idToUuid.get(ed.attrs.target) ?? ''),
        type: d.networkCanvasType != null ? String(d.networkCanvasType) : 'edge',
        attrs: a,
      });
    }
  }
}

// ---- import ------------------------------------------------------------------------------

async function importNC(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const { csv, graphml } = await scan(fs);
  // Warnings collected before beginSource are replayed once the source exists.
  const early = [];
  const warn = (code, message) => early.push([code, message]);
  const flush = () => { for (const [c, m] of early) builder.warn(c, m, 1); early.length = 0; };

  // Interviewer exports usually contain the CSV set AND a GraphML per session,
  // describing the same interviews. Sessions already read from the CSVs are
  // skipped in the GraphML so no tie is counted twice.
  const seen = new Set();
  let duplicateSessions = 0;
  if (csv.length) {
    const sessions = new Sessions();
    await readCsvSet(csv, sessions, warn);
    for (const uuid of sessions.egos.keys()) seen.add(uuid);
    if (signal?.aborted) throw new Error('Import cancelled');
    emit(sessions, builder, { options, fileNames: csv.map(c => c.entry.rel), format: 'network-canvas' });
    flush();
    progress(graphml.length ? 0.5 : 1, 'Network Canvas CSV read');
  }
  // GraphML files are separate sources: they are often the same sessions as the
  // CSVs exported side by side, and the report should show them separately.
  for (let i = 0; i < graphml.length; i++) {
    if (signal?.aborted) throw new Error('Import cancelled');
    const entry = graphml[i];
    const sessions = new Sessions();
    let root;
    try { root = parseXml(await entry.text()); }
    catch (err) {
      builder.beginSource({ format: 'network-canvas', family: 'survey', medium: 'survey', view: 'ego', context: 'survey', tz: 'UTC', fileNames: [entry.rel] });
      builder.warn('xml-error', `${entry.rel}: ${err.message}`, 1);
      continue;
    }
    readGraphml(root, sessions, warn);
    for (const uuid of [...sessions.egos.keys()]) {
      if (seen.has(uuid)) { sessions.egos.delete(uuid); duplicateSessions++; } else seen.add(uuid);
    }
    if (sessions.egos.size) {
      emit(sessions, builder, { options, fileNames: [entry.rel], format: 'network-canvas' });
      flush();
    }
    progress((i + 1) / graphml.length, `Read ${entry.rel}`);
  }
  if (duplicateSessions && builder.sources.length) {
    builder.stat('duplicate-sessions-skipped', duplicateSessions);
    builder.warn('duplicate-sessions-skipped', 'Interviews present in both the CSV and the GraphML export were read once, from the CSV', duplicateSessions);
  }
}

export default {
  id: 'network-canvas',
  label: 'Network Canvas export (CSV or GraphML)',
  family: 'survey',
  detect,
  options: [
    { key: 'weightColumn', label: 'Alter variable used as ego-alter tie weight (blank: closeness/strength if present)', type: 'string', default: '' },
    { key: 'edgeWeightColumn', label: 'Edge variable used as alter-alter tie weight (blank: first numeric edge variable)', type: 'string', default: '' },
  ],
  import: importNC,
};
