// FileSet: one uniform view over whatever the user dropped in.
//
// A user may give us one zip, several files, a folder, or a mix. Importers
// should not care, so every input becomes a flat list of entries:
//   { path, rel, size, isDir, text(), bytes(), stream() }
// `path` is the full path; `rel` drops a single shared top folder, which many
// exports wrap around everything (Takeout/, DataExport_2024-01-01/, ...).
// Zips are expanded lazily (only the directory is read up front).

import { openZip, isZip, decodeText } from './zip.js';

function blobEntry(blob, path) {
  return {
    path,
    size: blob.size,
    isDir: false,
    stream: () => blob.stream(),
    bytes: async () => new Uint8Array(await blob.arrayBuffer()),
    text: async () => decodeText(new Uint8Array(await blob.arrayBuffer())),
  };
}

export class FileSet {
  constructor(entries, { names = [] } = {}) {
    this.entries = entries.filter(e => !e.isDir && !isJunk(e.path));
    this.names = names; // original file names the user chose, for the report
    const root = commonRoot(this.entries.map(e => e.path));
    for (const e of this.entries) e.rel = root ? e.path.slice(root.length) : e.path;
    this._byLower = new Map(this.entries.map(e => [e.rel.toLowerCase(), e]));
  }

  // items: Array of { blob, path }. Zips are expanded; their entries keep the zip's
  // name as a prefix only when more than one item was given.
  static async from(items) {
    const entries = [];
    const unwrapped = [];
    const multi = items.length > 1;
    for (const { blob, path } of items) {
      if (/\.zip$/i.test(path) && await isZip(blob)) {
        const prefix = multi ? path.replace(/\.zip$/i, '') + '/' : '';
        entries.push(...await zipEntries(blob, prefix, path, unwrapped));
      } else {
        entries.push(blobEntry(blob, path));
      }
    }
    const fs = new FileSet(entries, { names: items.map(i => i.path) });
    fs.unwrapped = unwrapped;
    return fs;
  }

  // Browser: from an <input type=file> FileList or a drop's files. Folder uploads
  // carry webkitRelativePath.
  static async fromFiles(fileList) {
    return FileSet.from([...fileList].map(f => ({ blob: f, path: f.webkitRelativePath || f.name })));
  }

  // Node (tests): from file paths on disk.
  static async fromPaths(paths) {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const items = [];
    for (const p of paths) {
      const st = fs.statSync(p);
      if (st.isDirectory()) {
        const base = path.dirname(p);
        for (const f of walk(fs, path, p)) items.push({ blob: await fs.openAsBlob(f), path: path.relative(base, f).split(path.sep).join('/') });
      } else {
        items.push({ blob: await fs.openAsBlob(p), path: path.basename(p) });
      }
    }
    return FileSet.from(items);
  }

  // Case-insensitive exact lookup on `rel`.
  get(rel) { return this._byLower.get(rel.toLowerCase()) ?? null; }

  // Entries whose rel path matches a RegExp (tested case-insensitively if the regex has the i flag).
  find(re) { return this.entries.filter(e => re.test(e.rel)); }
  first(re) { return this.entries.find(e => re.test(e.rel)) ?? null; }

  // A sub-view rooted at a folder (rel paths re-based).
  sub(prefix) {
    const p = prefix.endsWith('/') ? prefix : prefix + '/';
    const lower = p.toLowerCase();
    const picked = this.entries.filter(e => e.rel.toLowerCase().startsWith(lower)).map(e => ({ ...e, path: e.rel.slice(p.length) }));
    return new FileSet(picked, { names: this.names });
  }

  get totalSize() { return this.entries.reduce((s, e) => s + (e.size || 0), 0); }
}

// A zip's entries. A zip that holds nothing but other zips (a download that
// wraps the export, such as a generated "native" Slack export, or a folder of
// chat zips zipped again) is opened one level further: nobody means "import
// this zip file" when they hand us a zip of zips. One inner zip is unwrapped
// in place; several keep their names as folders. Records each unwrap in
// `unwrapped` as { outer, inner } so the import can say what it opened.
async function zipEntries(blob, prefix, name, unwrapped, depth = 0) {
  const list = await openZip(blob);
  const real = list.filter(z => !z.isDir && !isJunk(z.path));
  if (depth < 2 && real.length && real.every(z => /\.zip$/i.test(z.path))) {
    const inner = [];
    for (const z of real) {
      const b = new Blob([await z.bytes()]);
      if (!await isZip(b)) { inner.length = 0; break; }
      inner.push({ z, b });
    }
    if (inner.length) {
      const out = [];
      for (const { z, b } of inner) {
        const sub = inner.length > 1 ? prefix + z.path.replace(/\.zip$/i, '') + '/' : prefix;
        unwrapped.push({ outer: name, inner: z.path });
        out.push(...await zipEntries(b, sub, z.path, unwrapped, depth + 1));
      }
      return out;
    }
  }
  return list.map(z => ({ ...z, path: prefix + z.path, stream: z.stream, bytes: z.bytes, text: z.text }));
}

function* walk(fs, path, dir) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) yield* walk(fs, path, f); else yield f;
  }
}

function isJunk(p) {
  return /(^|\/)(__MACOSX\/|\._|\.DS_Store$|Thumbs\.db$|desktop\.ini$|Icon\r?$)/.test(p);
}

function commonRoot(paths) {
  if (!paths.length) return '';
  const first = paths[0].split('/');
  if (first.length < 2) return '';
  const top = first[0] + '/';
  return paths.every(p => p.startsWith(top) && p.length > top.length) ? top : '';
}

// ---- streaming helpers -----------------------------------------------------

// Async iterator of text lines from a byte stream. Handles \n and \r\n, strips
// a leading BOM, and never holds more than one chunk plus a partial line.
export async function* lines(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream('utf-8')).getReader();
  let buf = '';
  let first = true;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += first ? value.replace(/^﻿/, '') : value;
    first = false;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      yield buf.charCodeAt(i - 1) === 13 ? buf.slice(0, i - 1) : buf.slice(0, i);
      buf = buf.slice(i + 1);
    }
  }
  if (buf.length) yield buf.endsWith('\r') ? buf.slice(0, -1) : buf;
}

// First n bytes of an entry, decoded, for format detection without reading it all.
export async function peek(entry, n = 4096) {
  const reader = entry.stream().getReader();
  const chunks = [];
  let got = 0;
  while (got < n) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); got += value.length;
  }
  reader.cancel().catch(() => {});
  const all = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const c of chunks) { const take = Math.min(c.length, all.length - o); all.set(c.subarray(0, take), o); o += take; if (o >= all.length) break; }
  return decodeText(all);
}
