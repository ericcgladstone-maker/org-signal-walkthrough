// Ego-network and roster survey exports other than Network Canvas:
//   egor-long   egor's "three files" (egos, alters, alter-alter ties): EgoWeb 2.0
//               (EgoID, Alter.Number, Alter.1.Number, Alter.2.Number) and openeddi
//               (puid, nameid, targetid) header variants
//   egor-wide   one row per ego with alter slots (alter.sex.1 ...) and pair
//               columns (X1.to.2 ...), classic GSS/ALLBUS style
//   qualtrics   CSV with three header rows; roster matrices and free-recall
//               name slots
//   google-forms  one header row; grid questions as "Question [Row]"
//
// Spec: docs/formats/network-canvas-and-surveys.md section 2.
//
// Two kinds of network come out of these files and are kept apart:
//   ego interviews (egor, free recall): view 'ego', alters keyed by ego and
//     never merged across respondents; alter-alter ties are ego's perception.
//   roster surveys (fixed list of names in the question): view 'full', the
//     roster bounds the population, so respondents and roster members share one
//     namespace (survey:<normalised name>) and become one network.

import { parseCSV, entryText, detectTimeFormat, parseTimestamp } from './tabular.js';
import { peek } from '../core/fileset.js';
import { cleanCell, typedValue, numericValue, normName } from './network-canvas.js';

const baseName = rel => rel.slice(rel.lastIndexOf('/') + 1);
const hnorm = h => String(h ?? '').toLowerCase().replace(/[\s._-]+/g, '');

// Header aliases, compared after hnorm(). egor's read_egoweb() names come from R's
// read.csv mangling (Alter.1.Number); raw EgoWeb headers probably have spaces
// (Alter 1 Number) [UNVERIFIED], which hnorm() makes equal.
const EGO_ID = ['egoid', 'puid', 'ego'];
const ALTER_ID = ['alterid', 'alternumber', 'nameid', 'alter'];
const TIE_SRC = ['source', 'alter1number', 'alter1', 'nameid', 'from'];
const TIE_TGT = ['target', 'alter2number', 'alter2', 'targetid', 'to'];
const TIME_COLS = ['enddate', 'timestamp', 'sessionstart', 'interviewdate', 'date'];
const WEIGHT_RE = /closeness|close|tie.?strength|strength/i;

function findCol(header, aliases) {
  const n = header.map(hnorm);
  for (const a of aliases) { const i = n.indexOf(a); if (i >= 0) return i; }
  return -1;
}

// ---- classification ------------------------------------------------------------

// Parse only the head of a file: enough rows to see Qualtrics' three header rows.
async function headRows(entry) {
  const text = await peek(entry, 16384);
  const full = entry.size != null && entry.size <= 16384;
  const { rows, delimiter } = parseCSV(text);
  if (!full && rows.length > 1) rows.pop(); // last row may be cut mid-way
  return { rows, delimiter };
}

const DEFAULT_AA_REGEX = '^X?(?<src>\\d+)\\.to\\.(?<tgt>\\d+)$';

function aaRe(option) {
  try { return new RegExp(option || DEFAULT_AA_REGEX, 'i'); } catch { return new RegExp(DEFAULT_AA_REGEX, 'i'); }
}

// Slot columns: <stem>.<k> or <stem>_<k> sharing a stem across >= 2 slots.
function slotGroups(header, exclude) {
  const groups = new Map();
  header.forEach((h, i) => {
    if (exclude.has(i)) return;
    const m = /^(.+?)[._](\d+)$/.exec(String(h).trim());
    if (!m) return;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ col: i, k: Number(m[2]) });
  });
  for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
  return groups;
}

function classify(rows, options) {
  const h = rows[0] || [];
  if (!h.length) return null;
  if (rows.length >= 3 && rows[2].some(c => /^\{"ImportId":/.test(String(c).trim()))
      && h.some(x => /^(StartDate|ResponseId)$/.test(String(x).trim()))) return { kind: 'qualtrics', score: 0.85 };
  if (String(h[0]).trim() === 'Timestamp' && h.some(x => / \[.+\]$/.test(String(x).trim()))) return { kind: 'google-forms', score: 0.75 };
  const ego = findCol(h, EGO_ID);
  if (ego >= 0) {
    const tgt = findCol(h, TIE_TGT);
    if (tgt >= 0 && tgt !== ego) return { kind: 'long-ties', score: 0.85 };
    const alt = findCol(h, ALTER_ID);
    if (alt >= 0 && alt !== ego) return { kind: 'long-alters', score: 0.85 };
  }
  const re = aaRe(options?.aaRegex);
  const pairs = new Set();
  h.forEach((x, i) => { if (re.test(String(x).trim())) pairs.add(i); });
  if (pairs.size && slotGroups(h, pairs).size) return { kind: 'wide', score: 0.7 };
  if (ego >= 0) return { kind: 'long-egos', score: 0.3 };
  return null;
}

async function scan(fs, options = {}) {
  const found = [];
  for (const e of fs.entries) {
    if (!/\.(csv|tsv|txt)$/i.test(e.rel)) continue;
    const { rows } = await headRows(e);
    const c = classify(rows, options);
    if (c) found.push({ entry: e, ...c });
  }
  // egor long needs an alters file; ego and tie files only count alongside it.
  const hasAlters = found.some(f => f.kind === 'long-alters');
  return found.filter(f => !f.kind.startsWith('long-') || hasAlters);
}

async function detect(fs) {
  const found = await scan(fs);
  if (!found.length) return { score: 0 };
  const kinds = [...new Set(found.map(f => f.kind.replace(/^long-.*/, 'egor-long')))];
  return {
    score: Math.max(...found.map(f => f.score)),
    reason: `Survey export (${kinds.join(', ')})`,
    files: found.map(f => f.entry.rel),
  };
}

// ---- helpers ---------------------------------------------------------------------

async function readRows(entry) {
  const { rows, delimiter } = parseCSV(await entryText(entry));
  // Semicolon-separated files come from European spreadsheet locales, which use
  // a decimal comma (egor's examples: 0,333).
  return { rows: rows.map(r => r.map(cleanCell)), decimalComma: delimiter === ';' };
}

function timeOf(values, tz) {
  const fmt = detectTimeFormat(values);
  return v => (fmt.format ? parseTimestamp(v, fmt.format, tz) : NaN);
}

function startSource(builder, info) {
  builder.beginSource({ family: 'survey', medium: 'survey', context: 'survey', tz: 'UTC', egoKey: null, ...info });
}

function pickWeightAttr(attrSets, option) {
  if (option) return option;
  const cols = new Set();
  for (const a of attrSets) for (const k of Object.keys(a)) cols.add(k);
  for (const c of cols) {
    if (!WEIGHT_RE.test(c)) continue;
    const vals = attrSets.map(a => a[c]).filter(v => v !== undefined);
    if (vals.length && vals.every(v => typeof v === 'number')) return c;
  }
  return null;
}

function finishEgoSource(builder, egoKeys) {
  const src = builder.source;
  src.egoKeys = egoKeys;
  src.egoKey = egoKeys.length === 1 ? egoKeys[0] : null;
  if (egoKeys.length > 1) {
    builder.warn('multiple-egos', `${egoKeys.length} separate ego interviews: a sample of independent personal networks, not one connected network. Alters are kept per respondent and never merged across respondents.`, 1);
  }
}

// Ego interviews in a common shape, then written once.
//   egos: [{ id, attrs, t, alters: [{ id, label, attrs }], ties: [{ src, tgt, w }] }]
function writeEgoInterviews(builder, egos, { options, fmt }) {
  const wattr = pickWeightAttr(egos.flatMap(e => e.alters.map(a => a.attrs)), options.weightColumn);
  const egoKeys = [];
  for (const e of egos) {
    const egoKey = `survey:${e.id}`;
    egoKeys.push(egoKey);
    const ego = builder.node(egoKey, { label: e.label || `Respondent ${e.id}`, attrs: { ...e.attrs, kind: 'ego', interview: e.id } });
    builder.stat('egos');
    const idx = new Map();
    for (const a of e.alters) {
      idx.set(a.id, builder.node(`${egoKey}:${a.id}`, { label: a.label || `Alter ${a.id} of ${e.id}`, attrs: { ...a.attrs, kind: 'alter', interview: e.id } }));
      builder.stat('alters');
    }
    const ctx = builder.context(egoKey, { name: `Interview ${e.id}`, kind: 'survey', visibility: 'private', medium: 'survey', members: [ego, ...idx.values()] });
    for (const a of e.alters) {
      const w = wattr ? a.attrs[wattr] : undefined;
      builder.event({ type: 'declared', t: e.t, actor: ego, targets: [[idx.get(a.id), 'declared']], context: ctx, weight: typeof w === 'number' ? w : 1 });
      builder.stat('egoAlterTies');
    }
    for (const t of e.ties) {
      const s = idx.get(t.src), d = idx.get(t.tgt);
      if (s === undefined || d === undefined) { builder.warn('unresolved-edge-endpoint', 'Alter-alter ties naming alters the respondent did not list (skipped)', 1); continue; }
      builder.event({ type: 'declared', t: e.t, actor: s, targets: [[d, 'declared']], context: ctx, weight: t.w });
      builder.stat('alterAlterTies');
    }
  }
  finishEgoSource(builder, egoKeys);
  if (fmt === 'egor-wide') {
    builder.warn('pair-values-as-weights', 'Alter-alter pair columns: any positive number is read as a tie with that value as weight; 0 or empty means no tie. Check the study codebook (some scales code "do not know each other" as 1).', 1);
  }
}

// ---- egor long -------------------------------------------------------------------

async function importLong(found, builder, options) {
  const files = found.filter(f => f.kind.startsWith('long-'));
  const egos = new Map();
  const ego = id => {
    if (!egos.has(id)) egos.set(id, { id, attrs: {}, t: NaN, alters: [], ties: [], fromEgoFile: false });
    return egos.get(id);
  };
  const attrsOf = (header, row, skip, dc) => {
    const a = {};
    header.forEach((h, i) => { if (!skip.includes(i)) { const v = typedValue(row[i], { decimalComma: dc }); if (v !== undefined) a[String(h).trim()] = v; } });
    return a;
  };
  const tz = options.timeZone || 'UTC';
  let zonedTime = true;
  for (const f of files.filter(x => x.kind === 'long-egos')) {
    const { rows, decimalComma } = await readRows(f.entry);
    const h = rows[0], ei = findCol(h, EGO_ID), ti = findCol(h, TIME_COLS);
    const toT = ti >= 0 ? timeOf(rows.slice(1).map(r => r[ti]), tz) : () => NaN;
    if (ti >= 0 && !detectTimeFormat(rows.slice(1).map(r => r[ti])).zoned) zonedTime = false;
    for (const r of rows.slice(1)) {
      const id = String(r[ei] ?? '').trim();
      if (!id) continue;
      const e = ego(id);
      e.fromEgoFile = true;
      Object.assign(e.attrs, attrsOf(h, r, [ei], decimalComma));
      if (ti >= 0) e.t = toT(r[ti]);
    }
  }
  for (const f of files.filter(x => x.kind === 'long-alters')) {
    const { rows, decimalComma } = await readRows(f.entry);
    const h = rows[0], ei = findCol(h, EGO_ID), ai = findCol(h.map((x, i) => (i === ei ? '' : x)), ALTER_ID);
    for (const r of rows.slice(1)) {
      const id = String(r[ei] ?? '').trim(), aid = String(r[ai] ?? '').trim();
      if (!id || !aid) continue;
      const attrs = attrsOf(h, r, [ei, ai], decimalComma);
      const label = ['name', 'alter.name', 'altername', 'label'].map(k => Object.keys(attrs).find(x => hnorm(x) === hnorm(k))).find(Boolean);
      ego(id).alters.push({ id: aid, label: label ? String(attrs[label]) : null, attrs });
    }
  }
  for (const f of files.filter(x => x.kind === 'long-ties')) {
    const { rows, decimalComma } = await readRows(f.entry);
    const h = rows[0], ei = findCol(h, EGO_ID);
    const masked = h.map((x, i) => (i === ei ? '' : x));
    const ti = findCol(masked, TIE_TGT);
    const si = findCol(masked.map((x, i) => (i === ti ? '' : x)), TIE_SRC);
    const wi = findCol(h, ['weight', 'value', 'strength']);
    for (const r of rows.slice(1)) {
      const id = String(r[ei] ?? '').trim();
      const s = String(r[si] ?? '').trim(), t = String(r[ti] ?? '').trim();
      if (!id || !s || !t) continue;
      const w = wi >= 0 ? numericValue(r[wi], { decimalComma }) : NaN;
      // A tie row with value 0 is an explicit "not connected" in some exports.
      if (w === 0) continue;
      ego(id).ties.push({ src: s, tgt: t, w: Number.isFinite(w) ? w : 1 });
    }
  }
  startSource(builder, { format: 'egor-long', view: 'ego', fileNames: files.map(f => f.entry.rel), directed: false });
  const list = [...egos.values()];
  if (list.some(e => !e.fromEgoFile) && files.some(f => f.kind === 'long-egos')) builder.warn('missing-ego-record', 'Alters or ties refer to an ego with no ego record; the ego node has no attributes.', list.filter(e => !e.fromEgoFile).length);
  writeEgoInterviews(builder, list, { options, fmt: 'egor-long' });
  if (!zonedTime) builder.warn('tz-assumed', `Interview times have no time zone; read as ${tz}.`, 1);
}

// ---- egor wide -----------------------------------------------------------------------

async function importWide(f, builder, options) {
  const { rows, decimalComma } = await readRows(f.entry);
  const h = rows[0].map(x => String(x).trim());
  const re = aaRe(options.aaRegex);
  const pairs = [];
  h.forEach((x, i) => { const m = re.exec(x); if (m?.groups) pairs.push({ col: i, src: Number(m.groups.src), tgt: Number(m.groups.tgt) }); });
  const pairCols = new Set(pairs.map(p => p.col));
  const groups = slotGroups(h, pairCols);
  const slotCols = new Set([...groups.values()].flat().map(s => s.col));
  let ei = findCol(h, EGO_ID);
  if (ei < 0) ei = h.findIndex(x => hnorm(x) === 'id');
  const ni = h.findIndex(x => hnorm(x) === 'netsize');
  const ti = findCol(h, TIME_COLS);
  const tz = options.timeZone || 'UTC';
  const toT = ti >= 0 ? timeOf(rows.slice(1).map(r => r[ti]), tz) : () => NaN;
  const slots = [...new Set([...groups.values()].flat().map(s => s.k))].sort((a, b) => a - b);
  const egos = [];
  let outside = 0;
  rows.slice(1).forEach((r, ri) => {
    const id = ei >= 0 && String(r[ei] ?? '').trim() ? String(r[ei]).trim() : String(ri + 1);
    const attrs = {};
    h.forEach((x, i) => {
      if (i === ei || pairCols.has(i) || slotCols.has(i)) return;
      const v = typedValue(r[i], { decimalComma }); if (v !== undefined) attrs[x] = v;
    });
    const netsize = ni >= 0 ? numericValue(r[ni], { decimalComma }) : NaN;
    const alters = [];
    for (const k of slots) {
      const a = {};
      for (const [stem, cols] of groups) {
        const c = cols.find(s => s.k === k);
        if (!c) continue;
        const v = typedValue(r[c.col], { decimalComma });
        if (v !== undefined) a[stem.replace(/^alter[._]/i, '')] = v;
      }
      // netsize says how many slots the respondent filled; later slots are blank
      // or carry placeholder codes and must not become alters.
      const used = Number.isFinite(netsize) ? k <= netsize : Object.keys(a).length > 0;
      if (used) alters.push({ id: String(k), label: typeof a.name === 'string' ? a.name : null, attrs: { ...a, slot: k } });
    }
    const have = new Set(alters.map(a => a.id));
    const ties = [];
    for (const p of pairs) {
      const v = numericValue(r[p.col], { decimalComma });
      if (!(v > 0)) continue;
      if (!have.has(String(p.src)) || !have.has(String(p.tgt))) { outside++; continue; }
      ties.push({ src: String(p.src), tgt: String(p.tgt), w: v });
    }
    egos.push({ id, attrs, t: ti >= 0 ? toT(r[ti]) : NaN, alters, ties });
  });
  startSource(builder, { format: 'egor-wide', view: 'ego', fileNames: [f.entry.rel], directed: false });
  writeEgoInterviews(builder, egos, { options, fmt: 'egor-wide' });
  if (outside) builder.warn('pair-outside-netsize', 'Alter-alter values for slots beyond the respondent\'s network size (skipped)', outside);
}

// ---- roster surveys (Qualtrics, Google Forms) ------------------------------------------

const DEFAULT_NO_TIE = '0,false,no,not selected,none,never';

// Cell -> tie weight, or 0 for no tie. Numbers are ratings (weight); any other
// non-empty answer means "selected" (checkbox grids write the chosen labels).
function tieWeight(raw, noTie) {
  const s = String(raw ?? '').trim();
  if (!s || noTie.has(s.toLowerCase())) return 0;
  const n = numericValue(s);
  if (Number.isFinite(n)) return n > 0 ? n : 0;
  return 1;
}

// respondents: [{ key, label, attrs, t }]; questions: [{ id, text, cols: [{ name, values[] per respondent }] }]
// How the two answers about a pair become a tie: the same rules, labels and
// default as the Roster builder (src/builders/roster.js MERGE_RULES), so a
// form dropped on Data and the same form imported in Build give one network.
// Nominations stay as reported events (so every tie traces to who named whom);
// the rule decides which are kept and whether the source is undirected.
export const COMBINE_RULES = [
  { value: 'union', label: 'Union: a tie if either person names the other (undirected)', text: 'a tie exists if either person named the other; ties are undirected, a valued tie takes the larger of the two answers, and a pair who named each other has two reports behind its tie' },
  { value: 'intersection', label: 'Reciprocated only: both name each other (undirected)', text: 'a tie exists only if both people named each other; ties are undirected and a valued tie takes the smaller of the two answers' },
  { value: 'respondent', label: 'As reported: directed from respondent to the person named', text: 'each tie runs from the respondent to the person they named, exactly as answered' },
];

function writeRoster(builder, { format, fileName, respondents, questions, respondentUnmatched, options }) {
  const rule = COMBINE_RULES.find(r => r.value === options.combine) || COMBINE_RULES[0];
  startSource(builder, { format, view: 'full', fileNames: [fileName], directed: rule.value === 'respondent', combine: rule.value });
  const noTie = new Set(String(options.noTieValues ?? DEFAULT_NO_TIE).split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const roster = new Map(); // normalised name -> node index
  for (const q of questions) for (const c of q.cols) {
    const k = normName(c.name);
    if (!roster.has(k)) roster.set(k, builder.node(`survey:${k}`, { label: c.name, attrs: { roster: true } }));
  }
  const resp = respondents.map(r => builder.node(r.key, { label: r.label, attrs: { ...r.attrs, respondent: true } }));
  builder.stat('rosterSize', roster.size);
  builder.stat('respondents', respondents.length);
  const inRoster = respondents.filter(r => roster.has(r.key.slice('survey:'.length))).length;
  if (!respondentUnmatched && respondents.length - inRoster > 0) {
    builder.warn('respondent-not-in-roster', 'Respondents whose identity does not match any roster name: their nominations are kept, but nobody can nominate them.', respondents.length - inRoster);
  }
  const all = [...new Set([...roster.values(), ...resp])];
  builder.context(`survey:${fileName}`, { name: fileName, kind: 'survey', visibility: 'private', medium: 'survey', members: all });
  let self = 0, nominations = 0, ties = 0, mutual = 0, dropped = 0;
  for (const q of questions) {
    const ctx = builder.context(`survey:${fileName}#${q.id}`, { name: q.text || q.id, kind: 'survey', visibility: 'private', medium: 'survey', members: all });
    const noms = [];
    respondents.forEach((r, ri) => {
      for (const c of q.cols) {
        const w = tieWeight(c.values[ri], noTie);
        if (!w) continue;
        const target = roster.get(normName(c.name));
        if (target === resp[ri]) { self++; continue; }
        noms.push({ t: r.t, actor: resp[ri], target, w });
      }
    });
    const said = new Map(noms.map(n => [n.actor + '|' + n.target, n.w]));
    const pairs = new Set();
    for (const n of noms) {
      const back = said.has(n.target + '|' + n.actor);
      const pair = Math.min(n.actor, n.target) + '|' + Math.max(n.actor, n.target);
      if (back) { if (!pairs.has(pair)) mutual++; }
      if (!pairs.has(pair) && (back || rule.value !== 'intersection')) ties++;
      pairs.add(pair);
      nominations++;
      if (rule.value === 'intersection' && !back) { dropped++; continue; }
      // Undirected rules: the pair's value (the larger answer for union, the
      // smaller for reciprocated) shared by the reports behind it, as the
      // Roster builder writes it, so the tie's total weight is that value.
      let w = n.w;
      if (rule.value !== 'respondent' && back) {
        const g = said.get(n.target + '|' + n.actor);
        w = (rule.value === 'union' ? Math.max(n.w, g) : Math.min(n.w, g)) / 2;
      }
      builder.event({ type: 'declared', t: n.t, actor: n.actor, targets: [[n.target, 'declared']], context: ctx, weight: w });
      builder.stat('declaredTies');
    }
  }
  if (rule.value === 'respondent') ties = nominations;
  builder.stat('nominations', nominations);
  builder.stat('reciprocatedPairs', mutual);
  builder.stat('ties', ties);
  const label = rule.label.split(':')[0];
  const n = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;
  builder.warn('combine-rule', `Answers about each pair were combined with the "${label}" rule: ${rule.text}. ${n(nominations, 'nomination')}, ${n(mutual, 'pair')} named each other, ${n(ties, 'tie')}${dropped ? `; ${n(dropped, 'one-sided nomination')} left out` : ''}. Change "Combine the two answers about each pair" in the import options to use another rule.`, ties);
  if (self) builder.warn('self-nominations', 'Respondents who picked themselves in a roster question (ignored)', self);
  if (respondentUnmatched) {
    builder.warn('respondents-unmatched', 'No respondent name column was found, so respondents are identified by response id and cannot be matched to roster names; the network has nominations out of respondents but none into them. Set the respondent column option if one exists.', 1);
  }
}

// Free-recall name slots: an ego view, written as its own source.
function writeFreeRecall(builder, { format, fileName, respondents, slotsQ, followUps, options }) {
  startSource(builder, { format, view: 'ego', fileNames: [fileName], directed: false });
  const egos = [];
  respondents.forEach((r, ri) => {
    const alters = [];
    for (const q of slotsQ) for (const c of q.cols) {
      const name = String(c.values[ri] ?? '').trim();
      if (!name) continue;
      const attrs = { nameGiven: name, question: q.id, slot: c.k };
      for (const fu of followUps.filter(x => x.k === c.k)) {
        const v = typedValue(fu.values[ri]);
        if (v !== undefined) attrs[fu.q] = v;
      }
      alters.push({ id: `${q.id}_${c.k}`, label: name, attrs });
    }
    if (alters.length) egos.push({ id: r.key.slice('survey:'.length), label: r.label, attrs: r.attrs, t: r.t, alters, ties: [] });
  });
  writeEgoInterviews(builder, egos, { options, fmt: format });
}

const Q_META = new Set(['StartDate', 'EndDate', 'Status', 'IPAddress', 'Progress', 'Duration (in seconds)', 'Finished', 'RecordedDate',
  'ResponseId', 'RecipientLastName', 'RecipientFirstName', 'RecipientEmail', 'ExternalReference', 'LocationLatitude',
  'LocationLongitude', 'DistributionChannel', 'UserLanguage']);

// Respondent identity column: the option, else a column whose id or text says name
// (preferred, since rosters are names) or e-mail, filled for at least half the rows.
function pickRespondentCol(ids, texts, data, candidates, option) {
  if (option) {
    const i = ids.findIndex((x, j) => String(x).trim() === option || String(texts[j] ?? '').trim() === option);
    if (i >= 0) return i;
  }
  const filled = i => data.filter(r => String(r[i] ?? '').trim()).length >= data.length / 2;
  for (const re of [/\bname\b/i, /e-?mail/i]) {
    const i = candidates.find(j => (re.test(ids[j]) || re.test(texts[j] ?? '')) && filled(j));
    if (i !== undefined) return i;
  }
  return -1;
}

async function importQualtrics(f, builder, options) {
  const { rows } = await readRows(f.entry);
  const ids = rows[0].map(x => String(x).trim());
  const texts = rows[1].map(x => String(x).trim());
  // Row 3 is JSON per column, e.g. {"ImportId":"endDate","timeZone":"America/Denver"}.
  // The timeZone key on date columns is from memory of real exports [UNVERIFIED].
  const imports = rows[2].map(x => { try { return JSON.parse(x); } catch { return {}; } });
  const data = rows.slice(3).filter(r => r.some(c => String(c).trim()));
  const col = name => ids.indexOf(name);

  // Matrix / slot groups: <id>_<k>. Loop & merge follow-ups: <k>_<id>.
  const used = new Set();
  const groups = new Map();
  ids.forEach((id, i) => {
    if (Q_META.has(id) || /_TEXT$/i.test(id)) return;
    const m = /^(.+)_(\d+)$/.exec(id);
    if (!m || /^\d+$/.test(m[1])) return;
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push({ col: i, k: Number(m[2]) });
  });
  const roster = [], slotsQ = [];
  for (const [qid, cols] of groups) {
    if (cols.length < 2) continue;
    // Roster matrix: row 2 reads "<question> - <choice>" with a different choice per column.
    const parts = cols.map(c => { const t = texts[c.col] ?? ''; const j = t.lastIndexOf(' - '); return j > 0 ? [t.slice(0, j), t.slice(j + 3).trim()] : null; });
    const names = parts.map(p => p && p[1]);
    // Free recall first: cells hold names typed by the respondent, so they are text
    // and mostly distinct. (Form-field questions also have per-column labels such
    // as "Person 1", so labels alone cannot tell the two apart.) Roster cells come
    // from a small answer set ("Yes", "1", a rating).
    const vals = cols.flatMap(c => data.map(r => String(r[c.col] ?? '').trim())).filter(Boolean);
    const textual = vals.length && vals.filter(v => !Number.isFinite(numericValue(v))).length / vals.length >= 0.8;
    if (textual && new Set(vals.map(normName)).size / vals.length >= 0.5) {
      slotsQ.push({ id: qid, text: texts[cols[0].col], cols: cols.map(c => ({ k: c.k, values: data.map(r => r[c.col]) })) });
      cols.forEach(c => used.add(c.col));
      continue;
    }
    if (names.every(Boolean) && new Set(names.map(normName)).size === names.length) {
      roster.push({ id: qid, text: parts[0][0], cols: cols.map((c, j) => ({ name: names[j], values: data.map(r => r[c.col]) })) });
      cols.forEach(c => used.add(c.col));
      continue;
    }
  }
  const followUps = [];
  ids.forEach((id, i) => {
    const m = /^(\d+)_(.+)$/.exec(id);
    if (m && slotsQ.length) { followUps.push({ k: Number(m[1]), q: m[2], values: data.map(r => r[i]) }); used.add(i); }
  });

  const candidates = ids.map((_, i) => i).filter(i => !used.has(i) && !Q_META.has(ids[i]));
  let ri = pickRespondentCol(ids, texts, data, candidates, options.respondentColumn);
  const fn = col('RecipientFirstName'), ln = col('RecipientLastName');
  const recipientNames = ri < 0 && fn >= 0 && ln >= 0 && data.filter(r => String(r[fn]).trim() && String(r[ln]).trim()).length >= data.length / 2;
  const ei = col('EndDate'), rid = col('ResponseId');
  const tzImport = ei >= 0 ? imports[ei]?.timeZone : null;
  const tz = tzImport || options.timeZone || 'UTC';
  const toT = ei >= 0 ? timeOf(data.map(r => r[ei]), tz) : () => NaN;
  const unmatched = ri < 0 && !recipientNames;
  const respondents = data.map((r, j) => {
    let label = ri >= 0 ? String(r[ri]).trim() : recipientNames ? `${String(r[fn]).trim()} ${String(r[ln]).trim()}` : '';
    const rId = rid >= 0 ? String(r[rid]).trim() : String(j + 1);
    const key = label ? `survey:${normName(label)}` : `survey:resp:${rId}`;
    const attrs = { responseId: rId };
    for (const i of candidates) {
      if (i === ri) continue;
      const v = typedValue(r[i]);
      if (v !== undefined) attrs[ids[i]] = v;
    }
    return { key, label: label || `Response ${rId}`, attrs, t: toT(r[ei]) };
  });
  const fileName = f.entry.rel;
  if (roster.length) {
    writeRoster(builder, { format: 'qualtrics', fileName, respondents, questions: roster, respondentUnmatched: unmatched, options });
    if (ei >= 0 && !tzImport) builder.warn('tz-assumed', `Response times have no time zone; read as ${tz}.`, 1);
  }
  if (slotsQ.length) {
    writeFreeRecall(builder, { format: 'qualtrics', fileName, respondents, slotsQ, followUps, options });
    if (ei >= 0 && !tzImport) builder.warn('tz-assumed', `Response times have no time zone; read as ${tz}.`, 1);
  }
  if (!roster.length && !slotsQ.length) {
    startSource(builder, { format: 'qualtrics', view: 'full', fileNames: [fileName] });
    for (const r of respondents) builder.node(r.key, { label: r.label, attrs: { ...r.attrs, respondent: true } });
    builder.warn('no-network-questions', 'No roster matrix or name-slot question was recognized; only respondents were imported. Use the CSV column mapper for other layouts.', 1);
  }
}

async function importForms(f, builder, options) {
  const { rows } = await readRows(f.entry);
  const h = rows[0].map(x => String(x).trim());
  const data = rows.slice(1).filter(r => r.some(c => String(c).trim()));
  const qs = new Map();
  h.forEach((x, i) => {
    const m = /^(.*) \[(.+)\]$/.exec(x);
    if (!m) return;
    if (!qs.has(m[1])) qs.set(m[1], []);
    qs.get(m[1]).push({ name: m[2].trim(), values: data.map(r => r[i]) , col: i });
  });
  const used = new Set([...qs.values()].flat().map(c => c.col));
  const candidates = h.map((_, i) => i).filter(i => i > 0 && !used.has(i));
  const ri = pickRespondentCol(h, h, data, candidates, options.respondentColumn);
  // Forms timestamps are wall-clock in the spreadsheet's zone, which the CSV omits.
  const tz = options.timeZone || 'UTC';
  const toT = timeOf(data.map(r => r[0]), tz);
  const respondents = data.map((r, j) => {
    const label = ri >= 0 ? String(r[ri]).trim() : '';
    const key = label ? `survey:${normName(label)}` : `survey:resp:${j + 1}`;
    const attrs = {};
    for (const i of candidates) { if (i === ri) continue; const v = typedValue(r[i]); if (v !== undefined) attrs[h[i]] = v; }
    return { key, label: label || `Response ${j + 1}`, attrs, t: toT(r[0]) };
  });
  const questions = [...qs].map(([text, cols], i) => ({ id: `q${i + 1}`, text, cols }));
  writeRoster(builder, { format: 'google-forms', fileName: f.entry.rel, respondents, questions, respondentUnmatched: ri < 0, options });
  builder.warn('tz-assumed', `Form timestamps have no time zone; read as ${tz}.`, 1);
}

// ---- import ---------------------------------------------------------------------------

async function importSurvey(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const found = await scan(fs, options);
  const steps = found.filter(f => !f.kind.startsWith('long-'));
  const hasLong = found.some(f => f.kind.startsWith('long-'));
  const total = steps.length + (hasLong ? 1 : 0);
  let done = 0;
  const tick = msg => progress(++done / total, msg);
  if (hasLong) { await importLong(found, builder, options); tick('egor files read'); }
  for (const f of steps) {
    if (signal?.aborted) throw new Error('Import cancelled');
    if (f.kind === 'qualtrics') await importQualtrics(f, builder, options);
    else if (f.kind === 'google-forms') await importForms(f, builder, options);
    else if (f.kind === 'wide') await importWide(f, builder, options);
    tick(`Read ${baseName(f.entry.rel)}`);
  }
}

export default {
  id: 'survey',
  label: 'Ego-network or roster survey (egor, EgoWeb, Qualtrics, Google Forms)',
  family: 'survey',
  detect,
  options: [
    { key: 'respondentColumn', label: 'Column identifying the respondent (blank: a name or e-mail column)', type: 'string', default: '' },
    { key: 'weightColumn', label: 'Alter variable used as ego-alter tie weight (blank: closeness/strength if present)', type: 'string', default: '' },
    { key: 'aaRegex', label: 'Pattern for alter-alter pair columns in one-row-per-ego files (named groups src, tgt)', type: 'string', default: DEFAULT_AA_REGEX },
    { key: 'timeZone', label: 'Time zone of survey timestamps that carry none (IANA name)', type: 'string', default: 'UTC' },
    { key: 'noTieValues', label: 'Roster answers meaning "no tie" (comma-separated)', type: 'string', default: DEFAULT_NO_TIE },
    { key: 'combine', label: 'Combine the two answers about each pair', type: 'choice', default: 'union', choices: COMBINE_RULES.map(({ value, label }) => ({ value, label })) },
  ],
  import: importSurvey,
};
