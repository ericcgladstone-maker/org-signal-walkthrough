// FileSet: one uniform view over whatever the user dropped in.
//
// A user may give us one zip, several files, a folder, or a mix. Importers
// should not care, so every input becomes a flat list of entries:
//   { path, rel, size, isDir, text(), bytes(), stream() }
// `path` is the full path; `rel` drops a single shared top folder, which many
// exports wrap around everything (Takeout/, DataExport_2024-01-01/, ...).
// Zips are expanded lazily (only the directory is read up front).

import { openZip, isZip, decodeText } from './zip.js';
import { classifyItem, truncatedZipProblem, encryptedZipProblem, fingerprint, sameContent, duplicateProblem } from './upload.js';

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
  //
  // What cannot be read is skipped and recorded in `fs.problems` (see
  // src/core/upload.js): unfinished downloads, truncated or encrypted zips,
  // files named .zip that are not zips, unsupported archives, empty files,
  // and a second copy of an item already given. Zips are recognised by their
  // first bytes, so a browser-renamed "export.zip (1)" still opens.
  static async from(items) {
    const problems = [];
    const unwrapped = [];
    // 1. What each item is, from its name and first bytes.
    const readable = [];
    for (const it of items) {
      const size = it.blob.size || 0;
      const head = size ? new Uint8Array(await it.blob.slice(0, 64).arrayBuffer()) : new Uint8Array(0);
      const c = classifyItem(it.path, size, head);
      if (c.problem) problems.push(c.problem);
      if (c.problem && !c.zip) continue;
      readable.push({ ...it, zip: !!c.zip });
    }
    // 2. Open the zips (directory only). A zip whose directory cannot be read
    // was cut off; one with password-protected entries keeps the rest.
    const units = []; // one per dropped item: a zip, a loose file, or a folder
    const folders = new Map();
    for (const it of readable) {
      if (it.zip) {
        let list;
        try { list = await zipEntries(it.blob, '', it.path, unwrapped); }
        catch (e) { problems.push(truncatedZipProblem(it.path, e)); continue; }
        const files = list.filter(z => !z.isDir && !isJunk(z.path));
        const locked = files.filter(z => z.encrypted);
        if (locked.length) problems.push(encryptedZipProblem(it.path, locked.length, files.length));
        units.push({ name: it.path, zip: true, files: files.filter(z => !z.encrypted), all: list.filter(z => !z.encrypted) });
      } else if (it.path.includes('/')) {
        const top = it.path.slice(0, it.path.indexOf('/'));
        if (!folders.has(top)) { const u = { name: top, folder: true, files: [] }; folders.set(top, u); units.push(u); }
        folders.get(top).files.push({ path: it.path, size: it.blob.size, blob: it.blob });
      } else {
        units.push({ name: it.path, files: [{ path: it.path, size: it.blob.size, blob: it.blob }] });
      }
    }
    // 3. The same item given twice (a repeated download, a zip next to its
    // unzipped folder) is read once. Names and sizes first; content (CRC-32
    // or a hash) only when those agree.
    const keep = [];
    const seen = new Map();
    // The copy the browser renamed ("export (1).zip") is the one dropped.
    const copyMark = n => (/ \(\d+\)(\.[^./]+)*$|\.[^./]+ \(\d+\)$/.test(n) ? 1 : 0);
    const ordered = units.map((u, i) => [u, i]).sort((a, b) => copyMark(a[0].name) - copyMark(b[0].name) || a[1] - b[1]).map(x => x[0]);
    for (const u of ordered) {
      if (!u.files.length) { keep.push(u); continue; }
      const quick = fingerprint(u.files);
      let dup = null;
      for (const prev of seen.get(quick) || []) if (await sameContent(prev.files, u.files)) { dup = prev; break; }
      if (dup) { problems.push(duplicateProblem(u.name, dup.name)); continue; }
      if (!seen.has(quick)) seen.set(quick, []);
      seen.get(quick).push(u);
      keep.push(u);
    }
    keep.sort((a, b) => units.indexOf(a) - units.indexOf(b));
    // 4. Entries. A zip's name becomes its folder only when other items sit
    // beside it; when that folder name is taken (the zip dropped next to the
    // folder macOS unzipped it into), the zip keeps its full name.
    const entries = [];
    const multi = keep.length > 1;
    const taken = new Set(keep.filter(u => u.folder).map(u => u.name.toLowerCase()));
    const roots = [];
    for (const u of keep) {
      if (u.zip) {
        let prefix = '';
        if (multi) {
          let p = u.name.replace(/\.zip$/i, '');
          if (taken.has(p.toLowerCase())) p = u.name;
          taken.add(p.toLowerCase());
          prefix = p + '/';
          if (!u.name.includes('/')) roots.push(prefix);
        }
        for (const z of u.all) entries.push({ ...z, path: prefix + z.path, stream: z.stream, bytes: z.bytes, text: z.text });
      } else {
        if (u.folder) roots.push(u.name + '/');
        for (const f of u.files) entries.push(blobEntry(f.blob, f.path));
      }
    }
    const kept = new Set(keep.flatMap(u => (u.zip || !u.folder ? [u.name] : u.files.map(f => f.path))));
    const fs = new FileSet(entries, { names: items.map(i => i.path).filter(p => kept.has(p)) });
    fs.unwrapped = unwrapped;
    fs.problems = problems;
    // The folder each dropped item occupies in `rel` (src/core/pipeline.js itemRoots).
    fs.roots = multi ? roots : [];
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
