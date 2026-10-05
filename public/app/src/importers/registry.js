// Importer registry. Each importer module exports a default object:
//
//   {
//     id: 'slack',                       // stable id, also used in Dataset source.format
//     label: 'Slack export',             // shown to the user
//     family: 'workplace',               // workplace | online | professional | personal | community | network | survey | tabular
//     detect: async (fs) => ({ score, reason }),   // 0..1; >= 0.5 means "this is mine"
//     options: [{ key, label, type, default, choices? }],  // optional user options (e.g. time zone)
//     import: async (fs, { builder, options, progress, signal }) => void,
//   }
//
// import() calls builder.beginSource({...}) itself, then adds nodes, contexts and
// events. It reports problems with builder.warn() and counts with builder.stat().
// progress(fraction, message) may be called often; signal is an AbortSignal.
//
// The importer lists live in separate files so different people can add to
// them without touching this one.

import workplace from './index.workplace.js';
import personal from './index.personal.js';

export const IMPORTERS = [...workplace, ...personal];

export function importerById(id) {
  return IMPORTERS.find(i => i.id === id) ?? null;
}

// Rank every importer against a FileSet. Returns [{ importer, score, reason }], best first.
export async function detectAll(fs) {
  const results = [];
  for (const importer of IMPORTERS) {
    try {
      const r = await importer.detect(fs);
      if (r && r.score > 0) results.push({ importer, score: r.score, reason: r.reason || '' });
    } catch (e) {
      results.push({ importer, score: 0, reason: `detect failed: ${e.message}` });
    }
  }
  return results.sort((a, b) => b.score - a.score);
}
