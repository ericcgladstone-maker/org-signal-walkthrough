// Import pipeline: files in, one Dataset plus its import report out.
//
//   detectImports(fs)             every importer's opinion of the drop, as plain data
//   planImports(detections, choices)   which importer reads which files
//   runImport(input, opts)        detection + chosen importers into one DatasetBuilder
//   importInWorker(files, opts)   the same, in the module worker, with progress and cancel
//
// When several importers match one drop (a Takeout zip holds mail and
// calendars; a folder holds a Slack export and an HR CSV), each file goes to
// the highest-scoring importer that claims it. Importers claim files by
// returning `files` (entry.rel paths) from detect(); an importer that returns
// no list gets every file nobody else claimed. Scores below 0.5 are only used
// when nothing else matched (the spreadsheet mapper is the usual fallback).
//
// Runs in Node (tests) and in browsers; nothing here touches the DOM.

import { FileSet } from './fileset.js';
import { DatasetBuilder } from './model.js';
import { importReport } from './report.js';
import { UploadError, partOf, partsNotice, sameContent } from './upload.js';
import { IMPORTERS } from '../importers/registry.js';

const CLAIM = 0.5;

function abortError() {
  const e = new Error('Import cancelled.');
  e.name = 'AbortError';
  return e;
}

// Anything the user can hand us -> FileSet.
//   FileSet | File[] | FileList | [{ blob, path }]
export async function toFileSet(input) {
  if (input instanceof FileSet) return input;
  const list = [...(input || [])];
  if (!list.length) throw new Error('No files to import.');
  return FileSet.from(list.map(x => (x && x.blob ? x : { blob: x, path: x.webkitRelativePath || x.name || 'file' })));
}

// A FileSet over some of fs's entries that keeps their rel paths as they are
// (the FileSet constructor would strip a newly common top folder, and importers
// match on rel paths).
export function subsetFileSet(fs, rels) {
  const want = new Set(rels.map(r => r.toLowerCase()));
  return makeFileSet(fs.entries.filter(e => want.has(e.rel.toLowerCase())), fs.names);
}

// The entries under folder `root` ('slack-export/'), re-based so importers see
// the export as if it had been dropped alone.
export function rootedFileSet(fs, root) {
  if (!root) return fs;
  const lower = root.toLowerCase();
  return makeFileSet(fs.entries.filter(e => e.rel.toLowerCase().startsWith(lower)).map(e => ({ ...e, rel: e.rel.slice(root.length) })), fs.names);
}

function makeFileSet(entries, names) {
  const s = Object.create(FileSet.prototype);
  s.entries = entries;
  s.names = names;
  s._byLower = new Map(entries.map(e => [e.rel.toLowerCase(), e]));
  return s;
}

// When several items are dropped together (two zips, a folder and a CSV), each
// sits under its own top folder, and exports whose layout is anchored at their
// root (Slack, Takeout parts) would not be recognised from the combined view.
// So detection also runs once per dropped item's folder.
function itemRoots(fs) {
  if (!fs.names || fs.names.length < 2) return [];
  const dirs = new Set();
  for (const e of fs.entries) { const i = e.rel.indexOf('/'); if (i > 0) dirs.add(e.rel.slice(0, i + 1)); }
  const roots = new Set();
  // FileSet.from records each dropped item's folder; older callers built the
  // FileSet themselves, so fall back to the item names.
  const cands = Array.isArray(fs.roots) ? fs.roots : fs.names.map(n => String(n).replace(/\.zip$/i, '').split('/')[0] + '/');
  for (const seg of cands) if (dirs.has(seg)) roots.add(seg);
  return roots.size > 1 || (roots.size === 1 && fs.entries.some(e => !e.rel.startsWith([...roots][0]))) ? [...roots].slice(0, 32) : [];
}

export async function detectImports(fs, { importers = IMPORTERS, signal, progress } = {}) {
  const out = [];
  const roots = ['', ...itemRoots(fs)];
  const views = roots.map(r => [r, rootedFileSet(fs, r)]);
  const nFiles = fs.entries.length;
  for (let k = 0; k < importers.length; k++) {
    const imp = importers[k];
    // Big exports take seconds to check; say what is happening and how far along.
    progress?.(k / importers.length, `Checking ${nFiles.toLocaleString('en-US')} file${nFiles === 1 ? '' : 's'}: ${imp.label} (${k + 1} of ${importers.length} formats)`);
    for (const [root, view] of views) {
      if (signal?.aborted) throw abortError();
      let r;
      try { r = await imp.detect(view); } catch (e) { r = { score: 0, reason: `detect failed: ${e.message}` }; }
      if (!r || !(r.score > 0)) continue;
      out.push({
        id: imp.id, label: imp.label, family: imp.family, score: r.score, reason: r.reason || '', root,
        // Claimed files are kept as full rel paths so claims from different roots compare.
        files: Array.isArray(r.files) ? r.files.map(f => root + f) : null,
        options: (imp.options || []).map(o => ({ ...o })),
        // The importer can tell parts of one export apart from separate
        // exports (importer.partKey); the Data view imports such inputs together.
        parts: typeof imp.partKey === 'function',
      });
    }
  }
  // Best first; on equal scores the narrower root wins, so a per-item match is
  // preferred to the same importer matching the whole drop.
  return out.sort((a, b) => b.score - a.score || b.root.length - a.root.length);
}

// choices: undefined (automatic) | ['slack', ...] | [{ id, files? }] | { slack: true, ... }
// Returns { plan: [{ id, root, files|null }], unclaimed: [rel] }. files are
// rel paths in the whole drop; root is the dropped item's folder the importer
// matched under ('' for the whole drop).
export function planImports(detections, choices, allRels = []) {
  const byId = new Map(detections.map(d => [d.id, d]));
  const plan = [];
  const claimed = new Set();
  if (choices && !(Array.isArray(choices) && !choices.length)) {
    const list = Array.isArray(choices)
      ? choices.map(c => (typeof c === 'string' ? { id: c } : c))
      : Object.entries(choices).filter(([, v]) => v).map(([id, v]) => (typeof v === 'object' ? { id, ...v } : { id }));
    for (const c of list) {
      const det = byId.get(c.id);
      const files = c.files || det?.files || null;
      plan.push({ id: c.id, root: c.root ?? det?.root ?? '', files });
      for (const f of files || allRels) claimed.add(f.toLowerCase());
    }
  } else {
    for (const d of detections) {
      if (d.score < CLAIM) continue;
      const root = d.root || '';
      const pool = d.files || allRels.filter(r => r.toLowerCase().startsWith(root.toLowerCase()));
      const rem = pool.filter(f => !claimed.has(f.toLowerCase()));
      if (!rem.length) continue;
      plan.push({ id: d.id, root, files: !d.files && !claimed.size && !root ? null : rem });
      for (const f of rem) claimed.add(f.toLowerCase());
    }
    if (!plan.length) {
      const fallback = detections.find(d => d.id === 'tabular') || detections[0];
      if (fallback) {
        plan.push({ id: fallback.id, root: fallback.root || '', files: fallback.files });
        for (const f of fallback.files || allRels) claimed.add(f.toLowerCase());
      }
    }
  }
  return { plan, unclaimed: allRels.filter(r => !claimed.has(r.toLowerCase())) };
}

// runImport(input, { choices, options: { [importerId]: {...} }, progress, signal, name, importers, detections })
// -> { dataset, report, detections, plan, unclaimed }
// detections: the result of an earlier detectImports over the same files (the
// Data view detects first, then imports); passing it skips a second pass.
export async function runImport(input, { choices, options = {}, progress, signal, name, importers = IMPORTERS, detections: known } = {}) {
  const prog = typeof progress === 'function' ? progress : () => {};
  const fs = await toFileSet(input);
  const problems = fs.problems || [];
  // Nothing readable at all: say why, from the upload checks (src/core/upload.js).
  if (!fs.entries.length) throw uploadFailure(problems);
  prog(0, 'Detecting formats');
  const detections = Array.isArray(known) && known.length ? known
    : await detectImports(fs, { importers, signal, progress: (f, m) => prog(0.1 * f, m) });
  const allRels = fs.entries.map(e => e.rel);
  const planned = planImports(detections, choices, allRels);
  const { unclaimed } = planned;
  if (!planned.plan.length) throw notRecognized(fs, allRels, problems);
  // Parts of one export dropped together (Takeout -001/-002, the two LinkedIn
  // zips, a split X or Facebook archive) are read as one export.
  const plan = await combineParts(fs, planned.plan, importers, problems);
  const builder = new DatasetBuilder({ name: name || defaultName(fs) });
  const errors = [];
  const sourcesOf = []; // per plan step: [first source index, end)
  for (let k = 0; k < plan.length; k++) {
    if (signal?.aborted) throw abortError();
    const step = plan[k];
    const imp = importers.find(i => i.id === step.id);
    if (!imp) throw new Error(`Unknown importer "${step.id}".`);
    // Files are full rel paths; the importer sees them relative to its root.
    const root = step.root || '';
    const base0 = step.files ? subsetFileSet(fs, step.files) : fs;
    const overlay = step.roots ? overlayFileSet(base0, step.roots) : null;
    const sub = overlay ? overlay.fs : rootedFileSet(base0, root);
    const opts = {};
    for (const o of imp.options || []) opts[o.key] = o.default;
    Object.assign(opts, options[imp.id] || {});
    const base = k / plan.length, span = 1 / plan.length;
    const before = builder.sources.length;
    try {
      await imp.import(sub, {
        builder, options: opts, signal,
        progress: (f, msg) => prog(base + span * Math.max(0, Math.min(1, f || 0)), `${imp.label}: ${msg || ''}`.trim()),
      });
    } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw abortError();
      errors.push({ id: imp.id, error: e });
      // Keep the failure visible in the report rather than losing it in a console.
      if (builder.sources.length === before) {
        builder.beginSource({ format: imp.id, family: imp.family, fileNames: step.files || allRels });
      }
      // An importer that knows why it cannot read the files says so with a
      // code (UploadError); anything else is an unexpected failure.
      if (e?.code && e.name === 'UploadError') builder.warn(e.code, e.message);
      else builder.warn('import-failed', `${imp.label} could not finish: ${e.message}`);
      builder.source.severity = 'error';
    }
    if (overlay && builder.sources.length > before) {
      const names = step.roots.map(r => r.replace(/\/$/, '')).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
      for (let s = before; s < builder.sources.length; s++) {
        builder.sources[s].warnings.push({ code: 'parts-combined', count: names.length,
          message: `Read as one export from ${names.length} parts: ${names.join(', ')}.${overlay.repeated ? ` ${overlay.repeated === 1 ? '1 file that is' : `${overlay.repeated} files that are`} in more than one part ${overlay.repeated === 1 ? 'was' : 'were'} read once.` : ''}` });
      }
    }
    sourcesOf.push([before, builder.sources.length]);
    prog(base + span, `${imp.label}: done`);
  }
  if (errors.length === plan.length) {
    const e = errors[0].error;
    const msg = plan.length === 1 ? e.message : `Every importer failed. First error (${errors[0].id}): ${e.message}`;
    if (e?.code && e.name === 'UploadError') throw new UploadError(e.code, msg, { cause: e });
    throw new Error(msg, { cause: e });
  }
  // Say which inner zips were opened, so a zip-in-zip download is not a mystery.
  for (const u of fs.unwrapped || []) {
    for (const src of builder.sources) {
      if (!src.warnings.some(w => w.code === 'nested-zip')) src.warnings.push({ code: 'nested-zip', message: `${u.inner} was opened from inside ${u.outer.split('/').pop()}.`, count: 1 });
    }
  }
  // A numbered part loaded without its siblings. Part numbers are counted
  // over the whole drop: Takeout's -001 may hold mail and -002 calendars.
  const dropped = fs.names.length === 1 ? [fs.names[0]] : itemRoots(fs).map(r => r.replace(/\/$/, ''));
  const numbersOf = new Map();
  for (const n of dropped) { const p = partOf(n); if (p) numbersOf.set(p.stem, [...(numbersOf.get(p.stem) || []), p.n]); }
  for (const [k, step] of plan.entries()) {
    const names = step.roots ? step.roots.map(r => r.replace(/\/$/, '')) : [step.root ? step.root.replace(/\/$/, '') : (fs.names.length === 1 ? fs.names[0] : '')];
    const parts = names.map(partOf);
    if (!names[0] || parts.some(p => !p) || new Set(parts.map(p => p.stem)).size > 1) continue;
    const notice = partsNotice(names, numbersOf.get(parts[0].stem) || parts.map(p => p.n));
    if (!notice) continue;
    for (let s = sourcesOf[k][0]; s < sourcesOf[k][1]; s++) {
      // The importer may have said it more precisely already (X manifest, Meta thread files).
      if (builder.sources[s].warnings.some(w => IMPORTER_PART_CODES.has(w.code))) continue;
      builder.sources[s].warnings.push({ ...notice, count: 1 });
    }
  }
  // Upload problems (a truncated zip beside a good one, a duplicate, a
  // password-protected part) go on the sources read from the same item, or
  // on every source when the item fed none of them.
  for (const p of problems) {
    const root = p.root || String(p.item || '').replace(/\.zip$/i, '') + '/';
    const near = plan.flatMap((step, k) => ((step.roots || [step.root]).includes(root) ? [k] : []));
    const targets = near.length ? near.flatMap(k => range(...sourcesOf[k])) : builder.sources.map((_, i) => i);
    for (const s of targets) builder.sources[s].warnings.push({ code: p.code, message: p.message, count: 1, severity: p.severity });
  }
  prog(1, 'Building dataset');
  const dataset = builder.build();
  const report = importReport(dataset);
  report.unclaimed = unclaimed;
  return { dataset, report, detections, plan, unclaimed };
}

const IMPORTER_PART_CODES = new Set(['missing-part', 'meta-thread-part-missing', 'linkedin-profile-only']);

const range = (a, b) => Array.from({ length: Math.max(0, b - a) }, (_, i) => a + i);

// Nothing in the upload could be opened: the most serious upload problem
// becomes the error, with every problem's message.
export function uploadFailure(problems) {
  if (!problems.length) return new UploadError('no-files', 'No files to import.');
  const main = problems.find(p => p.severity === 'error') || problems[0];
  const msg = problems.length === 1 ? main.message : problems.map(p => p.message).join(' ');
  return new UploadError(main.code, msg);
}

// Files were readable but no importer claimed them.
function notRecognized(fs, allRels, problems) {
  const shown = `${allRels.slice(0, 5).join(', ')}${allRels.length > 5 ? ', ...' : ''}`;
  const empties = fs.entries.filter(e => !e.size);
  let why = 'If it is a table, choose the spreadsheet importer and map the columns.';
  if (empties.length === fs.entries.length) why = `${empties.length === 1 ? 'The file is' : 'All the files are'} empty (0 bytes), so there is nothing to read. Download or copy ${empties.length === 1 ? 'it' : 'them'} again.`;
  const extra = problems.length ? ' ' + problems.map(p => p.message).join(' ') : '';
  return new UploadError(empties.length === fs.entries.length ? 'empty-upload' : 'not-recognized', `No importer recognized these files (${shown}). ${why}${extra}`);
}

// ---- parts of one export ------------------------------------------------------------
//
// Plan steps of the same importer under different dropped items are parts of
// one export when their item names carry the same numbered stem
// ("takeout-...-001" / "-002", "...-part1" / "-part2") or when the importer's
// partKey(view, { root }) gives both the same key (LinkedIn: the profile name;
// X: the account of a partial archive; Meta: the export's name). Such steps
// become one step with `roots`, read through an overlay of the parts.

async function combineParts(fs, plan, importers, problems = []) {
  const roots = new Set(itemRoots(fs));
  if (roots.size < 2) return plan;
  const topOf = rel => { const i = rel.indexOf('/'); const r = i > 0 ? rel.slice(0, i + 1) : ''; return roots.has(r) ? r : ''; };
  // A whole-drop step whose files all sit under one dropped item is that item's step.
  const steps0 = plan.map(s => {
    if (s.root || !s.files?.length) return { ...s };
    const tops = new Set(s.files.map(topOf));
    return tops.size === 1 && !tops.has('') ? { ...s, root: [...tops][0] } : { ...s };
  });
  // The same export under two dropped items (a zip beside the folder it was
  // unzipped into, with other files added): the importer claims the same
  // files, by path below each item's folder and size, with the same content.
  // Read once.
  const steps = [];
  const sig = s => s.files.map(f => `${f.slice(s.root.length).toLowerCase()}|${fs.get(f)?.size ?? ''}`).sort().join('\n');
  for (const s of steps0) {
    const twin = s.root && s.files?.length ? steps.find(t => t.id === s.id && t.root && t.files?.length === s.files.length && sig(t) === sig(s)) : null;
    if (twin && await sameContent(twin.files.map(f => fs.get(f)), s.files.map(f => fs.get(f)))) {
      const a = s.root.replace(/\/$/, ''), b = twin.root.replace(/\/$/, '');
      problems.push({ code: 'duplicate-upload', severity: 'info', item: a, root: twin.root,
        message: `${a} holds the same ${s.files.length === 1 ? 'file' : `${s.files.length} files`} as ${b}, so ${s.files.length === 1 ? 'it was' : 'they were'} read once.` });
      continue;
    }
    steps.push(s);
  }
  const out = [];
  const used = new Set();
  for (let i = 0; i < steps.length; i++) {
    if (used.has(i)) continue;
    const a = steps[i];
    const group = [i];
    if (a.root) {
      const imp = importers.find(x => x.id === a.id);
      const keyOf = async s => {
        const p = partOf(s.root);
        let k = null;
        if (imp?.partKey) {
          try { k = await imp.partKey(rootedFileSet(s.files ? subsetFileSet(fs, s.files) : fs, s.root), { root: s.root }); } catch { k = null; }
        }
        return { stem: p ? p.stem : null, key: k };
      };
      const ka = await keyOf(a);
      for (let j = i + 1; j < steps.length; j++) {
        const b = steps[j];
        if (used.has(j) || b.id !== a.id || !b.root || b.root === a.root) continue;
        const kb = await keyOf(b);
        if ((ka.stem && ka.stem === kb.stem) || (ka.key && ka.key === kb.key)) { group.push(j); used.add(j); }
      }
    }
    if (group.length === 1) { out.push(a); continue; }
    const members = group.map(g => steps[g]);
    const files = members.flatMap(s => s.files || fs.entries.filter(e => e.rel.startsWith(s.root)).map(e => e.rel));
    out.push({ id: a.id, root: '', roots: members.map(s => s.root), files });
  }
  return out;
}

// One view of several parts: each part's files relative to its own root, so
// the importer sees one export tree. A file present in more than one part
// (the same path) is kept once.
export function overlayFileSet(fs, roots) {
  const lowerRoots = roots.map(r => r.toLowerCase());
  const byRel = new Map();
  let repeated = 0;
  for (const e of fs.entries) {
    const k = lowerRoots.findIndex(r => e.rel.toLowerCase().startsWith(r));
    if (k < 0) continue;
    const rel = e.rel.slice(roots[k].length);
    const key = rel.toLowerCase();
    if (byRel.has(key)) { repeated++; continue; }
    byRel.set(key, { ...e, rel });
  }
  return { fs: makeFileSet([...byRel.values()], fs.names), repeated };
}

function defaultName(fs) {
  const n = fs.names?.[0] || fs.entries[0]?.path || 'Import';
  return String(n).split('/').pop().replace(/\.(zip|json|csv|mbox|ics|tar)$/i, '') || 'Import';
}

// ---- worker front end (browser) --------------------------------------------------
//
// files: File[] or [{ blob, path }] (structured-cloneable; a FileSet is not).
// opts: { choices, options, name, progress(fraction, message), signal, detectOnly, detections }
// Returns a Promise of { dataset, report, detections, plan, unclaimed }
// (or { detections } with detectOnly), with .cancel() which terminates the worker.
export function importInWorker(files, { choices, options, name, progress, signal, detectOnly = false, workerUrl, detections } = {}) {
  if (files instanceof FileSet) throw new Error('importInWorker needs File objects or { blob, path } items, not a FileSet.');
  const items = [...files].map(x => (x && x.blob ? { blob: x.blob, path: x.path } : { blob: x, path: x.webkitRelativePath || x.name || 'file' }));
  const worker = new Worker(workerUrl || new URL('../workers/import.worker.js', import.meta.url), { type: 'module' });
  let done = false;
  let rejectFn;
  const finish = () => { done = true; worker.terminate(); };
  const promise = new Promise((resolve, reject) => {
    rejectFn = reject;
    worker.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'progress') { progress?.(m.fraction, m.message); return; }
      if (m.type === 'done') { finish(); resolve(m.result); return; }
      if (m.type === 'error') {
        finish();
        const e = new Error(m.message);
        e.name = m.name || 'Error';
        if (m.code) e.code = m.code;
        if (m.stack) e.workerStack = m.stack;
        reject(e);
      }
    };
    worker.onerror = (ev) => { if (!done) { finish(); reject(new Error(ev.message || 'The import worker crashed.')); } };
    worker.onmessageerror = () => { if (!done) { finish(); reject(new Error('The import result could not be transferred from the worker.')); } };
  });
  const cancel = () => { if (!done) { finish(); rejectFn(abortError()); } };
  if (signal) { if (signal.aborted) cancel(); else signal.addEventListener('abort', cancel, { once: true }); }
  if (!done) worker.postMessage({ type: detectOnly ? 'detect' : 'run', files: items, opts: { choices, options, name, detections } });
  promise.cancel = cancel;
  return promise;
}
