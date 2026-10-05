// Time helpers. Every importer stores ms since epoch UTC, NaN when unknown.

// ISO-8601 / RFC 3339 with an explicit offset or Z. Strings without an offset
// are rejected (NaN) because Date.parse would read them as *local* time of the
// machine running the import, which is never what a source meant.
export function isoMs(s) {
  if (typeof s !== 'string') return NaN;
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(s.trim())) return NaN;
  return Date.parse(s);
}

// ISO-like string with or without an offset; no offset is read as UTC.
// For sources documented to write UTC without a designator.
export function isoUtcMs(s) {
  if (typeof s !== 'string' || !s.trim()) return NaN;
  const t = s.trim();
  if (/(Z|[+-]\d{2}:?\d{2})$/i.test(t)) return Date.parse(t);
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?$/.exec(t);
  if (!m) return NaN;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), +((m[7] || '0').padEnd(3, '0')));
}

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

// Twitter v1.1 `created_at`: "Sun Mar 21 12:53:22 +0000 2021".
export function twitterDateMs(s) {
  const m = /^\w{3} (\w{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/.exec(String(s ?? '').trim());
  if (!m) return NaN;
  const mo = MONTHS[m[1].toLowerCase()];
  if (mo === undefined) return NaN;
  const off = (m[6] === '-' ? -1 : 1) * (+m[7] * 60 + +m[8]) * 60000;
  return Date.UTC(+m[9], mo, +m[2], +m[3], +m[4], +m[5]) - off;
}

// Snowflake id -> creation time. X: epoch 1288834974657; Discord: 1420070400000.
export function snowflakeMs(id, epochMs) {
  try { return Number((BigInt(String(id)) >> 22n) + BigInt(epochMs)); } catch { return NaN; }
}
export const X_EPOCH = 1288834974657;
export const DISCORD_EPOCH = 1420070400000;

// Unix seconds (number or numeric string) -> ms.
export function unixSecMs(v) {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n * 1000 : NaN;
}

// Offset (ms, local minus UTC) of an IANA zone at a UTC instant.
const dtfCache = new Map();
export function tzOffsetMs(utcMs, timeZone) {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
    dtfCache.set(timeZone, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(utcMs)).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

// Wall-clock fields in an IANA zone -> UTC ms. timeZone 'UTC' or null/'unknown'
// means "treat the wall clock as UTC". In a DST gap the result is shifted
// forward by the gap; in an overlap the earlier (first) instant is chosen.
export function zonedToUtc(y, mo, d, h = 0, mi = 0, s = 0, ms = 0, timeZone = 'UTC') {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s, ms);
  if (!timeZone || timeZone === 'UTC' || timeZone === 'unknown') return wall;
  const o1 = tzOffsetMs(wall, timeZone);
  let t = wall - o1;
  const o2 = tzOffsetMs(t, timeZone);
  if (o2 !== o1) {
    const t2 = wall - o2;
    // Overlap: both candidates map back to the wall time; take the earlier.
    if (tzOffsetMs(t2, timeZone) === o2) t = Math.min(t, t2);
  }
  return t;
}

// True when the runtime knows this IANA zone name.
export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}
