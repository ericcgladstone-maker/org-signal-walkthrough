// Adapter over the import-side modules (owner: importers-A).
//
//   src/core/pipeline.js
//     importInWorker(files, { choices, options, name, progress, signal, detectOnly })
//       -> Promise<{ dataset, report, detections, plan, unclaimed }> (or { detections } with detectOnly)
//       detections: [{ id, label, family, score, reason, files|null, options[] }]
//       choices:    undefined (automatic) | [{ id, files? }]
//       options:    { [importerId]: { key: value } }
//   src/core/report.js     importReport(ds) -> { totals, sources[], notes[] }
//   src/core/identity.js   suggestMatches(ds) -> [{ a, b, keyA, keyB, labelA, labelB, confidence, evidence[] }]
//   src/core/merge.js      mergeDatasets(list, { name }) -> ds; applyMerges(ds, pairs) -> ds
//   src/importers/tabular.js  suggestMapping(headers, sampleRows) -> { kind, mapping, columns[], notes[] }
//   src/importers/profile.js  joinProfiles(ds, rows, { keyColumn, matchOn, columns }) -> { dataset, report }
//
// An "input" in the UI is one thing the user gave us: a file, a zip, or a
// folder. Each input is detected and imported separately so the user can
// choose the importer per input; several inputs are combined with
// mergeDatasets afterwards.
//
// The Data view (views/data/io.js) calls importInWorker directly for real
// runs, so detection can report progress and hand its result to the import;
// it uses detectInput/importInput below for ?mock (and they remain a complete
// real-pipeline path for any other caller).
//
// With ?mock, detection and import are faked (services/mock.js); report,
// identity, merge, mapping and profile join use the real pure modules when
// they load, because they need no worker and keep the demo honest.

import { MOCK, tryImport, pickFn } from './modules.js';

async function mock() { return import('./mock.js'); }

export function pipelineMode() { return MOCK ? 'mock' : 'real'; }

async function real(path, names) {
  const m = await tryImport(path);
  return pickFn(m, names);
}

// Ranked importer guesses for one input.
export async function detectInput(input, { signal } = {}) {
  if (MOCK) {
    const r = await (await mock()).mockDetect(input);
    return r.map(d => ({ id: d.importer.id, label: d.importer.label, family: d.importer.family, score: d.score, reason: d.reason, files: null, options: d.importer.options }));
  }
  const run = await real('../../core/pipeline.js', ['importInWorker']);
  if (!run) throw new Error('The import pipeline (src/core/pipeline.js) is not available in this build.');
  const r = await run(input.files, { detectOnly: true, signal, name: input.name });
  return r?.detections ?? [];
}

// Every importer, so the user can force one detection did not rank.
export async function listImporters() {
  if (MOCK) return (await mock()).mockImporters.map(i => ({ id: i.id, label: i.label, family: i.family, options: i.options }));
  try {
    const { IMPORTERS } = await import('../../importers/registry.js');
    return IMPORTERS.map(i => ({ id: i.id, label: i.label, family: i.family, options: i.options || [] }));
  } catch { return []; }
}

// input: { name, files, importerId ('auto' or an id), options }
export async function importInput(input, { onProgress, signal } = {}) {
  if (MOCK) return (await mock()).mockImport([input], { onProgress, signal });
  const run = await real('../../core/pipeline.js', ['importInWorker']);
  if (!run) throw new Error('The import pipeline (src/core/pipeline.js) is not available in this build.');
  const auto = !input.importerId || input.importerId === 'auto';
  const options = {};
  for (const [id, o] of Object.entries(input.options || {})) options[id] = o;
  return run(input.files, {
    choices: auto ? undefined : [{ id: input.importerId }],
    options,
    name: input.name.replace(/\.(zip|json|csv|mbox|ics)$/i, ''),
    progress: onProgress,
    signal,
  });
}

export async function importReport(ds) {
  const fn = await real('../../core/report.js', ['importReport', 'buildReport']);
  try { return fn ? fn(ds) : null; } catch (e) { console.warn('[org-signal] import report failed', e); return null; }
}

export async function suggestMatches(ds) {
  const fn = await real('../../core/identity.js', ['suggestMatches']);
  if (fn) return fn(ds);
  if (MOCK) return (await mock()).mockSuggestMatches(ds);
  return null;
}

export async function applyMerges(ds, pairs) {
  const fn = await real('../../core/merge.js', ['applyMerges']);
  if (fn) return fn(ds, pairs);
  if (MOCK) return (await mock()).mockApplyMerges(ds, pairs);
  throw new Error('Identity merging (src/core/merge.js) is not available in this build.');
}

export async function mergeDatasets(list, opts = {}) {
  const fn = await real('../../core/merge.js', ['mergeDatasets']);
  if (fn) return fn(list, opts);
  if (MOCK) return (await mock()).mockMergeDatasets(list);
  throw new Error('Adding a dataset to the current one needs src/core/merge.js, which is not available in this build.');
}

export async function suggestMapping(headers, sampleRows) {
  const fn = await real('../../importers/tabular.js', ['suggestMapping']);
  if (fn) return fn(headers, sampleRows);
  return { kind: 'events', mapping: { namespace: 'csv' }, columns: headers.map(h => ({ header: h, role: 'ignore', confidence: 0, reason: '' })), notes: [] };
}

export async function joinProfiles(ds, rows, opts) {
  const fn = await real('../../importers/profile.js', ['joinProfiles']);
  if (fn) return fn(ds, rows, opts);
  if (MOCK) return (await mock()).mockJoinProfiles(ds, rows.records || rows, opts);
  throw new Error('Profile join (src/importers/profile.js) is not available in this build.');
}

// Header and first rows of a CSV, for the mapping steps. Rows stay string[][].
export async function peekCSV(file, maxRows = 50) {
  const { parseCSV, uniqueHeaders } = await import('../../importers/tabular.js');
  const text = await file.slice(0, 1024 * 1024).text();
  const { rows } = parseCSV(text);
  return { headers: uniqueHeaders(rows[0] || []), rows: rows.slice(1, maxRows + 1), more: rows.length > maxRows + 1 };
}

export async function readCSV(file) {
  const { parseCSV, rowsToObjects } = await import('../../importers/tabular.js');
  const { rows } = parseCSV(await file.text());
  return rowsToObjects(rows);
}

// Files no importer claimed, as Files the UI can hand to the profile join.
// rels come from the pipeline's own FileSet (zip entries expanded, a shared
// top folder stripped), so we rebuild the same FileSet to find them.
export async function filesForRels(files, rels) {
  if (!rels?.length) return [];
  const { FileSet } = await import('../../core/fileset.js');
  const items = files.map(f => (f && f.blob ? { blob: f.blob, path: f.path } : { blob: f, path: f.webkitRelativePath || f.name || 'file' }));
  const fs = await FileSet.from(items);
  const out = [];
  for (const rel of rels) {
    const e = fs.get(rel);
    if (!e) continue;
    const bytes = await e.bytes();
    const name = rel.split('/').pop();
    out.push(typeof File === 'function' ? new File([bytes], name, { type: 'text/csv' }) : new Blob([bytes]));
  }
  return out;
}
