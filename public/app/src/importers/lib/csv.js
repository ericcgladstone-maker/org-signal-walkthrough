// CSV helpers over vendor/papaparse.js.

import Papa from '../../../vendor/papaparse.js';

// Parse CSV text with a header row into objects. Strips a BOM and trims header
// names (exports sometimes pad them). Returns { rows, fields, errors }.
export function parseCSV(text, { header = true } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const r = Papa.parse(text, { header, skipEmptyLines: 'greedy', transformHeader: h => h.trim() });
  return { rows: r.data, fields: r.meta.fields || [], errors: r.errors };
}

// First line of a text (for header sniffing), BOM stripped.
export function firstLine(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const i = text.search(/\r?\n/);
  return i < 0 ? text : text.slice(0, i);
}

export { Papa };
