// What "Download as native export files" hands the user. No DOM here, so it
// runs in the worker, on the main thread and in Node tests.
//
//   packNative(files, { name }) -> { name, bytes, type, entries }
//     One file (a Slack, Takeout or X zip, a GraphML, a survey CSV) is handed
//     over as it is, so the download is exactly what the platform gives you
//     and loads in Data without unpacking. Several files (WhatsApp chats,
//     Discord channels, Reddit dumps) go into one zip; a file that is itself
//     a zip (a WhatsApp iOS chat) is unpacked into a folder of that name, so
//     the download never holds a zip inside a zip and reads back the same as
//     selecting the separate files.
//   groundTruthJSON(groundTruth) -> string   (typed arrays as arrays, NaN as null)
//   readmeText({ spec, groundTruth, files, description }) -> string

import { zipSync, unzipSync } from '../../../vendor/fflate.js';

const isZipBytes = b => b && b.length > 4 && b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04;

export function packNative(files, { name = 'synthetic-export' } = {}) {
  const list = (files || []).map(f => ({ path: f.path || f.name, bytes: toBytes(f.bytes ?? f.data ?? f.text ?? '') })).filter(f => f.path);
  if (!list.length) throw new Error('The generator returned no native files for this medium.');
  if (list.length === 1) {
    const f = list[0];
    return { name: baseName(f.path), bytes: f.bytes, type: typeFor(f.path), entries: [f.path] };
  }
  const entries = {};
  for (const f of list) {
    if (/\.zip$/i.test(f.path) && isZipBytes(f.bytes)) {
      const folder = f.path.replace(/\.zip$/i, '');
      for (const [p, b] of Object.entries(unzipSync(f.bytes))) if (!p.endsWith('/')) entries[`${folder}/${p}`] = b;
    } else entries[f.path] = f.bytes;
  }
  return { name: `${name}.zip`, bytes: zipSync(entries, { level: 6 }), type: 'application/zip', entries: Object.keys(entries) };
}

function toBytes(d) {
  if (d instanceof Uint8Array) return d;
  if (typeof d === 'string') return new TextEncoder().encode(d);
  return new Uint8Array(d);
}

const baseName = p => String(p).split('/').pop();

function typeFor(path) {
  if (/\.zip$/i.test(path)) return 'application/zip';
  if (/\.json$/i.test(path)) return 'application/json';
  if (/\.csv$/i.test(path)) return 'text/csv';
  if (/\.(graphml|xml)$/i.test(path)) return 'application/xml';
  return 'application/octet-stream';
}

// Ground truth as JSON a script can read: typed arrays become arrays and NaN
// (an open time window) becomes null.
export function groundTruthJSON(gt) {
  return JSON.stringify(gt, (k, v) => {
    if (ArrayBuffer.isView(v)) return Array.from(v, x => (Number.isFinite(x) ? x : null));
    if (typeof v === 'number' && !Number.isFinite(v)) return null;
    return v;
  }, 1);
}

const iso = t => (Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : 'unknown');

export function readmeText({ spec = {}, groundTruth: gt = {}, files = [], description = {}, gtName = 'ground-truth.json' } = {}) {
  const groups = gt.communities?.names || [];
  const lines = [
    'Synthetic export from Org Signal',
    '================================',
    '',
    'Everything in these files is generated: the people, names, messages and',
    'ties are fake. The world was built with known structure (ground truth)',
    'so you can check whether an analysis finds it.',
    '',
    'How it was made',
    '---------------',
    `Setting: ${spec.context}; medium: ${spec.medium}; scenario: ${spec.structure || 'default'}; seed: ${spec.seed}.`,
    `People: ${gt.people?.count ?? spec.size}; time span: ${iso(gt.timespan?.start)} to ${iso(gt.timespan?.end - 1)} (inclusive); message text: ${spec.content || 'light'}.`,
    'The same settings and seed always give the same world.',
    description.what ? `\n${description.what}` : '',
    '',
    'Files',
    '-----',
    ...files.map(f => `  ${f}`),
    '',
    'Open them in Org Signal: Data, Import, then choose the file as downloaded',
    '(do not unzip it first). Other tools that read this platform\'s export',
    'read them the same way.',
    '',
    'What the files show',
    '-------------------',
    `View: ${gt.observation?.view || 'full'}${gt.observation?.egoLabel ? `, the export of ${gt.observation.egoLabel}` : ''}.`,
    description.nativeCaution || 'The files hold every interaction the export format records among the people in the world.',
    '',
    'Ground truth',
    '------------',
    `${gtName} holds what was planted, before any export saw it:`,
    `  communities  ${groups.length} planted groups${groups.length ? ` (${groups.slice(0, 8).join(', ')}${groups.length > 8 ? ', ...' : ''})` : ''}; membership per person, in people.keys order`,
    `  ties         ${gt.ties?.count ?? 0} true ties (a, b, weight, kind, active window)`,
    `  bridges      ${(gt.bridges?.brokers || []).length} planted brokers`,
    `  events       ${(gt.events || []).length} planted events (departures, reorganizations, shifts)`,
    '  affect, topics, diffusion: planted content signals, where the setting has them',
    'People are matched to the exported accounts by people.keys (the key the',
    'importer gives each account) or people.platformIds.',
    '',
  ];
  return lines.join('\n').replace(/\n{3,}/g, '\n\n');
}
