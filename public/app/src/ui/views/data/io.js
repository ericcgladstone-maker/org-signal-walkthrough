// Data view plumbing: turning a drop or a file picker into inputs, detecting
// and importing each input, and the plain-language bits derived from them
// (why a file was not recognized, a short name for what was loaded).
//
// Detection and import call the import worker directly (src/core/pipeline.js
// importInWorker) so detection can report progress and its result can be
// handed to the import, which then skips a second detection pass. With ?mock
// the services layer's fakes are used, as everywhere else.

import { detectInput as mockableDetect, importInput as mockableImport, pipelineMode, peekCSV, suggestMapping } from '../../services/pipeline.js';
import { sniffShared } from '../../../builders/share.js';

// ---- reading what the user dropped -----------------------------------------

async function readEntry(entry, prefix = '') {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    return [{ blob: file, path: prefix + entry.name }];
  }
  if (entry.isDirectory) {
    const reader = entry.createReader();
    const out = [];
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) out.push(...await readEntry(e, `${prefix}${entry.name}/`));
    }
    return out;
  }
  return [];
}

let seq = 0;
export function makeInput(name, files, kind) {
  const size = files.reduce((s, f) => s + ((f.blob || f).size || 0), 0);
  return { id: `in${++seq}-${Math.random().toString(36).slice(2, 6)}`, name, files, kind, size, detections: null, detecting: true, progress: null, error: null, importerId: 'auto', options: {}, tableKind: null, use: null };
}

export async function inputsFromDrop(dt) {
  const items = [...(dt.items || [])].filter(i => i.kind === 'file');
  const entries = items.map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (entries.length && entries.every(Boolean)) {
    const out = [];
    for (const e of entries) {
      const files = await readEntry(e);
      if (!files.length) continue;
      out.push(makeInput(e.name, files, e.isDirectory ? 'folder' : /\.zip$/i.test(e.name) ? 'zip' : 'file'));
    }
    return out;
  }
  return [...dt.files].map(f => makeInput(f.name, [f], /\.zip$/i.test(f.name) ? 'zip' : 'file'));
}

export function inputsFromPicker(fileList, folder) {
  const files = [...fileList];
  if (!files.length) return [];
  if (folder) {
    const top = (files[0].webkitRelativePath || files[0].name).split('/')[0];
    return [makeInput(top, files, 'folder')];
  }
  return files.map(f => makeInput(f.name, [f], /\.zip$/i.test(f.name) ? 'zip' : 'file'));
}

// Shared-survey response files are recombined as one set (the merge rule
// needs both people's answers; who did not respond needs all of them), so
// loose response files dropped or picked together become one input.
export async function groupSharedResponses(list) {
  const loose = [];
  for (const inp of list) {
    if (inp.kind !== 'file' || inp.files.length !== 1) continue;
    const f = inp.files[0], b = f.blob || f;
    if (!/\.(json|txt)$/i.test(pathOf(f)) || !(b.size < 5e6)) continue;
    try { if (sniffShared(await b.slice(0, 4096).text())) loose.push(inp); } catch { /* unreadable: leave it alone */ }
  }
  if (loose.length < 2) return list;
  const merged = makeInput(`${loose.length} survey responses`, loose.flatMap(i => i.files), 'folder');
  const set = new Set(loose);
  const out = [];
  for (const inp of list) { if (!set.has(inp)) out.push(inp); else if (inp === loose[0]) out.push(merged); }
  return out;
}

export const pathOf = f => f.path || f.webkitRelativePath || f.name || '';
export const isCSV = f => /\.(csv|tsv|txt)$/i.test(pathOf(f));
export const blobOf = f => f.blob || f;

// ---- detection and import ---------------------------------------------------

async function pipeline() { return import('../../../core/pipeline.js'); }

// Ranked importer guesses for one input; onProgress(fraction, message).
export async function detect(input, { onProgress, signal } = {}) {
  if (pipelineMode() === 'mock') return { detections: await mockableDetect(input, { signal }) };
  const { importInWorker } = await pipeline();
  const r = await importInWorker(input.files, { detectOnly: true, signal, name: input.name, progress: onProgress });
  return { detections: r?.detections ?? [], files: r?.files ?? null };
}

// Import one input with its chosen importer and options.
export async function importOne(input, { onProgress, signal } = {}) {
  if (pipelineMode() === 'mock') return mockableImport(input, { onProgress, signal });
  const { importInWorker } = await pipeline();
  const auto = !input.importerId || input.importerId === 'auto';
  return importInWorker(input.files, {
    choices: auto ? undefined : [{ id: input.importerId }],
    options: input.options || {},
    name: input.name.replace(/\.(zip|json|csv|mbox|ics|txt)$/i, ''),
    // The automatic plan is the one detection made; reuse it.
    detections: auto ? input.detections || undefined : undefined,
    progress: onProgress,
    signal,
  });
}

// A CSV that only the spreadsheet mapper claims, and whose rows look like one
// person each (an HR export, a roster), is usually meant to add attributes
// to the people in the other sources rather than to be a network itself.
export async function tableKindOf(input, detections) {
  const best = detections.find(d => d.score >= 0.5);
  if (best || !detections.some(d => d.id === 'tabular')) return null;
  const files = input.files.filter(isCSV);
  if (files.length !== 1 || input.files.length !== 1) return null;
  try {
    const { headers, rows } = await peekCSV(blobOf(files[0]), 50);
    if (!headers.length || !rows.length) return null;
    // Only when a column is named like a person (name, email, id): a table of
    // anything else (or unreadable bytes) is not offered as people.
    const m = await suggestMapping(headers, rows);
    const named = (m.columns || []).some(c => (c.role === 'id' || c.role === 'label') && c.reason === 'header name');
    return m.kind === 'nodes' && !named ? null : m.kind || null;
  } catch { return null; }
}

// ---- plain-language helpers ----------------------------------------------------

const UNSUPPORTED = [
  [/\.pdf$/i, 'PDF files hold pages, not records. Export the data itself (CSV, JSON or the app\'s own export) and import that.'],
  [/\.(docx?|pages|odt|rtf)$/i, 'Word-processor documents cannot be read. Export the data as CSV and import that.'],
  [/\.(pptx?|key)$/i, 'Presentations cannot be read. Export the underlying data as CSV and import that.'],
  [/\.(png|jpe?g|gif|heic|webp|tiff?|bmp)$/i, 'Images cannot be read. Import the export the picture was made from.'],
  [/\.(mp4|mov|m4a|mp3|wav|opus|ogg)$/i, 'Audio and video files cannot be read; chat exports include them only as attachments.'],
  [/\.(rar|7z|tar|gz|tgz|zst)$/i, 'Only .zip archives can be opened here. Unpack this archive and import the folder or its files.'],
];

// Why nothing recognized this input, as specifically as the files allow.
export function whyUnrecognized(input) {
  const files = input.files.map(f => ({ name: pathOf(f), size: blobOf(f).size || 0 }));
  if (files.length && files.every(f => f.size === 0)) return files.length === 1 ? 'This file is empty (0 bytes).' : 'These files are all empty (0 bytes).';
  for (const [re, msg] of UNSUPPORTED) if (files.length === 1 && re.test(files[0].name)) return msg;
  if (input.kind === 'zip' || input.kind === 'folder') return 'Nothing inside matched a known export. Check that it is the export as downloaded (not a part of it), or import the files you need one by one.';
  return 'No importer recognized this file. If it is a table of who-to-whom, choose "Spreadsheet" as the importer and map the columns.';
}

// "Gmail + LinkedIn + X archive + 56 WhatsApp chats" from the report's sources,
// falling back to the input name. Long single names are shortened.
export function shortName(sources, inputs) {
  const counts = new Map();
  for (const s of sources || []) {
    const k = s.label || 'Source';
    const e = counts.get(k) || { n: 0, chat: s.view === 'chat' };
    e.n++; counts.set(k, e);
  }
  if (counts.size > 1 || [...counts.values()].some(e => e.n > 1)) {
    const parts = [...counts].map(([label, e]) => (e.n > 1 ? `${e.n} ${label} ${e.chat ? 'chats' : 'sources'}` : label));
    return clip(parts.join(' + '), 80);
  }
  // One source: the input's own name when it says what it is ("Halcyoncrest
  // Energy Slack export ..."), else the source kind and its owner or title
  // ("Gmail (Felipe Ferreira)") rather than "takeout-20250406T000000Z-001".
  const s = sources?.[0];
  // A recombined survey: its title and combine rule (C13), so the union and
  // reciprocated versions are named apart.
  if (s?.family === 'survey' && s.title && s.combine) return clip(`${s.title} (${RULE_WORDS[s.combine] || s.combine})`, 80);
  const one = inputs?.length === 1 ? inputs[0].name.replace(/\.(zip|json|csv|tsv|mbox|ics|txt)$/i, '') : null;
  if (s && (s.ego || inputs?.[0]?.kind !== 'file') && !(one && s.label && one.toLowerCase().includes(s.label.split(' ')[0].toLowerCase()))) {
    const who = s.ego?.label || s.title;
    return clip(who ? `${s.label} (${who})` : s.label, 80);
  }
  return clip(one || 'Imported data', 80);
}

const RULE_WORDS = { union: 'union', intersection: 'reciprocated', respondent: 'as reported' };

export function clip(s, n) {
  s = String(s || '');
  return s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s;
}

// IANA zones for the time zone picker, with the browser's own first.
export function browserZone() {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
let zones = null;
export function timeZones() {
  if (zones) return zones;
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = []; }
  if (!zones.includes('UTC')) zones = ['UTC', ...zones];
  return zones;
}
