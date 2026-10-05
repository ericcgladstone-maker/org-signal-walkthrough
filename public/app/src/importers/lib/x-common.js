// Helpers shared by the X personal-archive and X research-dataset importers.

// `full_text` / `text` of a retweet starts "RT @handle:" (x-archive.md section 4,
// x-research-datasets.md section 3a). Handles are 1-15 word characters.
export const RT_RE = /^RT @([A-Za-z0-9_]{1,15}):/;

// A quote has no field in the archive; it shows up as a status URL in
// urls[].expanded_url (x-archive.md section 4). `i/web/status/<id>` carries no
// handle, so it is excluded by the caller.
export const STATUS_URL_RE = /^https?:\/\/(?:www\.|mobile\.)?(?:twitter|x)\.com\/([A-Za-z0-9_]{1,15})\/status(?:es)?\/(\d+)/i;

export function statusUrl(url) {
  const m = STATUS_URL_RE.exec(String(url ?? ''));
  if (!m || m[1].toLowerCase() === 'i') return null;
  return { handle: m[1], id: m[2] };
}

// Ids arrive as strings, or as numbers already rounded by an earlier tool.
// "-1" marks an unresolved mention in the archive (spec: skip).
export function idStr(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  return s === '-1' ? null : s;
}

// Node for an X account known only by handle (deleted/unknown id). Handles are
// case-insensitive on X, so the key is lowercased; the importer warns.
export function handleKey(handle) { return 'x:@' + String(handle).toLowerCase(); }

// Ids Excel has turned into scientific notation ("1.8E+18") are unrecoverable.
export const EXCEL_ID_RE = /^-?\d+(?:[.,]\d+)?E\+?\d+$/i;
