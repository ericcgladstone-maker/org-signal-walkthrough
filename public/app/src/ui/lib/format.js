// Number and date formatting shared by every view. Numbers are shown with as
// many significant digits as the measure can defend, not as many as a
// Float64 holds; dates are UTC unless the source says otherwise, because the
// model stores UTC ms.

export function fmtNum(v, { digits = 3 } = {}) {
  if (v == null || Number.isNaN(v)) return '–';
  if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
  if (Number.isInteger(v) && Math.abs(v) < 1e7) return v.toLocaleString('en-US');
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return Math.round(v).toLocaleString('en-US');
  if (a >= 1) return Number(v.toFixed(Math.max(0, digits - 1 - Math.floor(Math.log10(a))))).toString();
  // Never scientific notation in the interface: below a millionth the value
  // is zero for every reading the measures support.
  if (a < 1e-6) return '~0';
  return Number(v.toPrecision(digits)).toString();
}

// One formatter for a whole table column, with the same number of decimals on
// every row so values line up (0.174 / 0.088 / 0.007, not 0.174 / 0.0878 /
// 0.00692). Decimals follow the largest magnitude in the column; a nonzero
// value that rounds to zero shows as ~0. `digits` fixes the decimals instead
// (measures on a 0-1 scale always show three, so a star's center reads 1.000
// beside a path's 0.400 rather than "1" in one table and "0.400" in another).
export function columnFormat(values, { digits: fixed = null } = {}) {
  let mx = 0, allInt = true, any = false;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    any = true;
    const a = Math.abs(v);
    if (a > mx) mx = a;
    if (allInt && !Number.isInteger(v)) allInt = false;
  }
  const digits = fixed != null ? fixed : !any || allInt || mx >= 100 ? 0 : mx >= 10 ? 1 : mx >= 1 ? 2 : 3;
  const fmt = (v) => {
    if (v == null || Number.isNaN(v)) return '–';
    if (!Number.isFinite(v)) return v > 0 ? '∞' : '-∞';
    const s = v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    if (v !== 0 && Number(s.replace(/,/g, '')) === 0) return '~0';
    return s;
  };
  fmt.digits = digits;
  return fmt;
}

export function fmtInt(v) {
  if (v == null || Number.isNaN(v)) return '–';
  return Math.round(v).toLocaleString('en-US');
}

export function fmtPct(v, digits = 0) {
  if (v == null || Number.isNaN(v)) return '–';
  return `${(v * 100).toFixed(digits)}%`;
}

export function fmtP(p) {
  if (p == null || Number.isNaN(p)) return '–';
  if (p < 0.001) return 'p < 0.001';
  return `p = ${p.toFixed(3)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function fmtDate(t) {
  if (t == null || !Number.isFinite(t)) return 'unknown';
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function fmtDateTime(t) {
  if (t == null || !Number.isFinite(t)) return 'unknown time';
  const d = new Date(t);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${fmtDate(t)}, ${hh}:${mm} UTC`;
}

export function isoDay(t) {
  if (!Number.isFinite(t)) return '';
  return new Date(t).toISOString().slice(0, 10);
}

export function fmtRange(a, b) {
  if (!Number.isFinite(a) && !Number.isFinite(b)) return 'no timestamps';
  return `${fmtDate(a)} – ${fmtDate(b)}`;
}

export function plural(n, one, many = `${one}s`) {
  return `${fmtInt(n)} ${n === 1 ? one : many}`;
}

export function fmtBytes(b) {
  if (!(b >= 0)) return '';
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

// Attribute values for display. Time zone offsets arrive in seconds from
// several exports (Slack tz_offset); show them as UTC+5:30.
export function fmtAttr(key, v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'yes' : 'no';
  if (typeof v === 'object') return JSON.stringify(v);
  if (/(tz|utc|timezone)[ _-]?offset/i.test(String(key))) {
    const x = Number(v);
    if (Number.isFinite(x) && Math.abs(x) <= 14 * 3600 && x % 900 === 0) {
      const m = Math.abs(x) / 60;
      return `UTC${x < 0 ? '-' : '+'}${Math.floor(m / 60)}${m % 60 ? `:${String(m % 60).padStart(2, '0')}` : ''}`;
    }
  }
  return String(v);
}

// Turn "inDegree" / "largest_component_share" into "In degree" / "Largest component share".
export function humanize(key) {
  return String(key)
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .replace(/^\w/, c => c.toUpperCase())
    .replace(/\b([A-Z])([a-z]+)/g, (m, a, b, i) => (i === 0 ? m : m.toLowerCase()));
}
