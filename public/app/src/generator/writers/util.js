// Helpers shared by the native-format writers.

import { zipSync, strToU8 } from '../../../vendor/fflate.js';

export const enc = new TextEncoder();
export const u8 = s => enc.encode(s);

// Deterministic zip: every entry gets the same fixed modification time
// (fflate otherwise stamps Date.now(), which would break byte-identical output).
export function zip(entries, mtime) {
  const data = {};
  const opts = { level: 6, mtime: new Date(Math.max(Date.UTC(1981, 0, 1), mtime || Date.UTC(2025, 0, 1))) };
  for (const e of entries) data[e.path] = [typeof e.bytes === 'string' ? strToU8(e.bytes) : e.bytes, opts];
  return zipSync(data, opts);
}

// RFC 4180 CSV: quote when needed, CRLF line ends unless told otherwise.
export function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
export function csv(rows, eol = '\r\n') { return rows.map(r => r.map(csvCell).join(',')).join(eol) + eol; }

export function xmlEscape(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

export function htmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// Group records by a key function, keeping input order inside each group.
export function groupBy(records, keyFn) {
  const m = new Map();
  for (const r of records) {
    const k = keyFn(r);
    if (k === undefined || k === null) continue;
    let a = m.get(k);
    if (!a) m.set(k, (a = []));
    a.push(r);
  }
  return m;
}

export function safeFileName(s) { return String(s).replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_').slice(0, 120); }
