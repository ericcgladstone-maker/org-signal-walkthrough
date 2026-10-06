// Upload checks: what was wrong with the files themselves, before any
// importer looks at them, and how parts of one export are recognized.
//
// People upload what the platform or the browser gave them: a download that
// stopped early (a truncated zip, a .crdownload), a zip renamed by the browser
// ("export.zip (1)"), a web page saved in place of the export, a .tgz Takeout,
// a password-protected package, the same file twice, or one part of a split
// archive. Each such case is recorded as an upload problem
//   { code, severity: 'error' | 'warn' | 'info', message, item, root? }
// on FileSet.problems (src/core/fileset.js). The pipeline copies problems into
// the import report as warnings, or throws an UploadError carrying the code
// when nothing readable is left. Messages say what is wrong and what to do.
//
// Runs in Node and in browsers; no DOM.

// An error the import can explain: `code` is stable (tests and the report
// key on it), `message` is the text the person sees.
export class UploadError extends Error {
  constructor(code, message, { cause } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'UploadError';
    this.code = code;
  }
}

const baseName = p => String(p || '').split('/').pop();

// Containers that are zips inside but are read as files of their own
// (spreadsheets, documents, packages). Never expanded.
const ZIP_DOCUMENT = /\.(xlsx|xlsm|xltx|docx|dotx|pptx|potx|ods|odt|odp|numbers|pages|key|epub|jar|apk|ipa|aar|nupkg|vsix|whl|kmz|3mf|sketch|xpi)$/i;

// Unfinished browser downloads: Chrome .crdownload, Firefox .part, Safari
// .download (a folder on disk, a file when dragged out), Opera .opdownload.
const UNFINISHED = /\.(crdownload|part|partial|download|opdownload)$/i;

// Archives the browser cannot open here. Plain .tar (Teams Free) and single
// .gz files (research datasets) are read by their importers, so they pass.
const UNSUPPORTED_ARCHIVE = /\.(tgz|tar\.gz|tar\.bz2|tbz2?|tar\.xz|txz|7z|rar|zipx)$/i;

// What the first bytes of a file say it is.
export function sniffMagic(b) {
  if (!b || !b.length) return 'empty';
  if (b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5 || b[2] === 7) && (b[3] === 4 || b[3] === 6 || b[3] === 8)) return 'zip';
  if (b[0] === 0x1f && b[1] === 0x8b) return 'gzip';
  if (b[0] === 0x52 && b[1] === 0x61 && b[2] === 0x72 && b[3] === 0x21) return 'rar';
  if (b[0] === 0x37 && b[1] === 0x7a && b[2] === 0xbc && b[3] === 0xaf) return '7z';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'pdf';
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && (b[i] === 0x20 || b[i] === 0x09 || b[i] === 0x0a || b[i] === 0x0d)) i++;
  if (b[i] === 0x3c) return 'html';
  if (b[i] === 0x7b || b[i] === 0x5b) return 'json';
  return 'other';
}

const MAGIC_WORDS = {
  html: 'it holds a web page (often a sign-in or error page saved in place of the export)',
  gzip: 'it is a gzip archive (.tgz or .gz) with a .zip name',
  rar: 'it is a RAR archive with a .zip name', '7z': 'it is a 7-Zip archive with a .zip name',
  pdf: 'it is a PDF document', json: 'it holds JSON text', empty: 'it is empty (0 bytes)', other: 'its contents are not a zip archive',
};

// Problems that can be told from the name and the first bytes alone.
// Returns { problem } (the item is skipped), { zip: true } (read as a zip,
// perhaps with a problem to note), or {} (an ordinary file).
export function classifyItem(path, size, head) {
  const name = baseName(path);
  if (UNFINISHED.test(name)) {
    return { problem: { code: 'download-unfinished', severity: 'error', item: path,
      message: `${name} is an unfinished browser download (the browser adds .${name.split('.').pop()} while a file is still downloading, and leaves it there when a download stops). Download the export again and load the finished file.` } };
  }
  if (UNSUPPORTED_ARCHIVE.test(name)) {
    const takeout = /^takeout-/i.test(name);
    return { problem: { code: 'archive-unsupported', severity: 'error', item: path,
      message: takeout
        ? `${name} is a Google Takeout archive in .tgz form, which cannot be opened here. Unpack it on your computer (double-click on a Mac; 7-Zip on Windows) and load the unpacked folder, or create a new export with File type: .zip.`
        : `${name} cannot be opened here: only .zip archives are read. Unpack it on your computer and load the unpacked folder or files.` } };
  }
  if (!size) {
    // Loose files only: an empty file inside an export folder is the importer's business.
    if (path.includes('/')) return {};
    return { problem: { code: 'empty-upload', severity: 'error', item: path,
      message: `${name} is empty (0 bytes), so there is nothing to read. The download or copy did not finish; download the export again.` } };
  }
  const magic = sniffMagic(head);
  const zipName = /\.zip$/i.test(name);
  if (magic === 'zip' && !ZIP_DOCUMENT.test(name)) {
    if (zipName) return { zip: true };
    return { zip: true, problem: { code: 'zip-renamed', severity: 'info', item: path,
      message: `${name} was opened as a zip archive although its name does not end in .zip (browsers rename repeated downloads, for example "export.zip (1)").` } };
  }
  if (zipName) {
    return { problem: { code: 'not-a-zip', severity: 'error', item: path,
      message: `${name} is named .zip but is not a zip archive: ${MAGIC_WORDS[magic] || MAGIC_WORDS.other}. Download the export again from the platform.` } };
  }
  return {};
}

export function truncatedZipProblem(path, err) {
  const name = baseName(path);
  return { code: 'zip-truncated', severity: 'error', item: path,
    message: `${name} is incomplete: the end of the zip, which holds its list of files, is missing. This usually means the download stopped early. Download the export again and compare the file size with the size the platform states.`,
    detail: err?.message };
}

export function encryptedZipProblem(path, nEncrypted, nTotal) {
  const name = baseName(path);
  const all = nEncrypted >= nTotal;
  return { code: 'zip-encrypted', severity: all ? 'error' : 'warn', item: path,
    message: `${name} is password-protected (${all ? `all ${nTotal}` : `${nEncrypted} of ${nTotal}`} files are encrypted). Encrypted files cannot be read here. Unzip it with its password (7-Zip on Windows, Keka or The Unarchiver on a Mac) and load the unzipped folder.` };
}

// ---- duplicates ------------------------------------------------------------------

// A fingerprint of one dropped item: the files it holds (path below its own
// top folder, and size) or, for a loose file, its size. Equal fingerprints
// are only a candidate (a zip and its unzipped folder match too):
// sameContent() confirms.
export function fingerprint(files) {
  if (files.length === 1 && !files[0].path.includes('/')) return `file:${files[0].size}`;
  const root = commonTop(files.map(f => f.path));
  return 'tree:' + files.map(f => `${f.path.slice(root.length).toLowerCase()}|${f.size}`).sort().join('\n');
}

// Two items with the same fingerprint hold the same bytes: zip entries
// compare by CRC-32 (already in the zip's directory), other files by a
// hash of their content.
export async function sameContent(a, b) {
  const order = list => { const root = commonTop(list.map(f => f.path)); return [...list].sort((x, y) => x.path.slice(root.length).localeCompare(y.path.slice(root.length))); };
  const xs = order(a), ys = order(b);
  if (xs.length !== ys.length) return false;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i], y = ys[i];
    if (x.size !== y.size) return false;
    if (x.crc != null && y.crc != null) { if (x.crc !== y.crc) return false; continue; }
    if (await hashEntry(x) !== await hashEntry(y)) return false;
  }
  return true;
}

function commonTop(paths) {
  const first = paths[0]?.split('/') || [];
  if (first.length < 2) return '';
  const top = first[0] + '/';
  return paths.every(p => p.startsWith(top)) ? top : '';
}

// Whole-content hash for files up to 64 MB; beyond that the first and last
// MB, which is enough to tell two different exports apart.
async function hashEntry(e) {
  const LIMIT = 64 * 1024 * 1024, EDGE = 1024 * 1024;
  let bytes;
  if (e.blob) {
    const b = e.blob;
    bytes = b.size <= LIMIT ? new Uint8Array(await b.arrayBuffer())
      : concat(new Uint8Array(await b.slice(0, EDGE).arrayBuffer()), new Uint8Array(await b.slice(b.size - EDGE).arrayBuffer()));
  } else bytes = await e.bytes();
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map(x => x.toString(16).padStart(2, '0')).join('');
}

function concat(a, b) { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; }

export function duplicateProblem(path, firstPath) {
  const a = baseName(path), b = baseName(firstPath);
  return { code: 'duplicate-upload', severity: 'info', item: path,
    message: a === b ? `${a} was given twice; it was read once.` : `${a} is the same as ${b}, so it was read once.` };
}

// ---- parts of one export ------------------------------------------------------------

// Split exports number their parts in the file name: Google Takeout
// "takeout-20261004T101500Z-001.zip", X "...-part1.zip", archives split by
// hand "... - part 2.zip". Returns { stem, n } or null. The browser's own
// " (1)" suffix for a repeated download is not a part number.
export function partOf(name) {
  const base = baseName(String(name || '').replace(/\/+$/, '')).replace(/\.zip$/i, '');
  const m = /^(.*?)(?:[\s._-]*part[\s._-]*(\d{1,3})(?:[\s._-]*of[\s._-]*\d+)?|[\s._-]+(\d{3}))$/i.exec(base);
  if (!m || !m[1]) return null;
  const n = Number(m[2] ?? m[3]);
  if (!Number.isFinite(n)) return null;
  return { stem: m[1].toLowerCase().replace(/[\s._-]+$/, ''), n };
}

// The notice for a split export when not every part was loaded. `numbers`
// are the part numbers present for one stem.
export function partsNotice(names, numbers) {
  const ns = [...new Set(numbers)].sort((a, b) => a - b);
  const max = ns[ns.length - 1];
  const missing = [];
  for (let i = 1; i < max; i++) if (!ns.includes(i)) missing.push(i);
  const list = names.map(baseName).join(', ');
  const takeout = names.some(n => /^takeout-/i.test(baseName(n)));
  if (missing.length) {
    return { code: 'export-parts-missing', severity: 'warn',
      message: `${list} ${names.length === 1 ? 'is one part' : 'are parts'} of an export split into numbered files, and part${missing.length === 1 ? '' : 's'} ${missing.join(', ')} ${missing.length === 1 ? 'was' : 'were'} not loaded. Each part holds different files, so the network lacks whatever ${missing.length === 1 ? 'that part holds' : 'those parts hold'}. Load all the parts together.` };
  }
  if (ns.length === 1 && max === 1) {
    return { code: 'export-part-one', severity: 'info',
      message: `${list} is part 1 of a numbered export${takeout ? ' (Google Takeout numbers every export, -001, -002, ...)' : ''}. If the download page listed more parts, load them all together: each part holds different files.` };
  }
  return null;
}
