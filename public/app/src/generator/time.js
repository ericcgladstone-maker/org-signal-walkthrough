// Time spans and activity rhythms.
//
// Interactions are not uniform in time: workplace traffic sits in working
// hours on weekdays in each person's local zone, personal chat peaks in the
// evening and at weekends, and online posting comes in news-driven bursts.
// A rhythm is a per-day weight table over the span plus a per-hour weight
// table; sampling a time is two binary searches. Zones are fixed offsets
// (no daylight-saving changes), which is good enough for rhythm analyses.

import { cumulative, drawCum } from './rng.js';

export const DAY = 86400000;
export const HOUR = 3600000;
export const WEEK = 7 * DAY;

export function parseDate(v, fallback) {
  if (v == null) return fallback;
  if (typeof v === 'number') return v;
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(v) ? v + 'T00:00:00Z' : v);
  return Number.isFinite(t) ? t : fallback;
}

// spec.timespan: { start, end } or { start, days } (dates as ISO strings or ms).
export function normalizeTimespan(ts, defaults) {
  const start = parseDate(ts?.start, parseDate(defaults.start));
  let end = parseDate(ts?.end, NaN);
  if (!Number.isFinite(end)) end = start + (ts?.days ?? defaults.days) * DAY;
  if (!(end > start)) throw new Error('timespan end must be after start');
  return { start, end, days: Math.round((end - start) / DAY) };
}

const HOURS = {
  work: [0.01, 0.01, 0.005, 0.005, 0.005, 0.01, 0.04, 0.2, 0.6, 1, 1, 1, 0.6, 0.9, 1, 1, 0.9, 0.6, 0.25, 0.1, 0.08, 0.06, 0.03, 0.02],
  personal: [0.25, 0.12, 0.04, 0.02, 0.02, 0.03, 0.1, 0.35, 0.45, 0.35, 0.3, 0.35, 0.6, 0.5, 0.4, 0.4, 0.5, 0.75, 1, 1.2, 1.3, 1.25, 1, 0.6],
  online: [0.35, 0.25, 0.15, 0.1, 0.08, 0.1, 0.25, 0.5, 0.7, 0.75, 0.75, 0.8, 0.9, 0.85, 0.8, 0.8, 0.85, 0.9, 1, 1.1, 1.15, 1.1, 0.9, 0.6],
  community: [0.5, 0.35, 0.2, 0.1, 0.08, 0.08, 0.15, 0.3, 0.4, 0.45, 0.5, 0.55, 0.65, 0.65, 0.6, 0.6, 0.7, 0.85, 1, 1.15, 1.2, 1.15, 1, 0.75],
  flat: new Array(24).fill(1),
};

const WEEKDAY = { // Sun..Sat
  work: [0.03, 1, 1, 1, 1, 0.95, 0.04],
  personal: [1.35, 0.8, 0.8, 0.8, 0.85, 1.1, 1.45],
  online: [0.9, 1, 1, 1, 1, 1, 0.9],
  community: [1.2, 0.9, 0.9, 0.9, 0.95, 1.05, 1.25],
  flat: [1, 1, 1, 1, 1, 1, 1],
};

// Build a rhythm over [start, end). Online and community rhythms get random
// news bursts (recorded so ground truth can name them).
export function makeRhythm(kind, span, rng, { bursts = kind === 'online' || kind === 'community', dayFactor } = {}) {
  const days = Math.max(1, Math.ceil((span.end - span.start) / DAY));
  const w = new Float64Array(days);
  const burstDays = [];
  const wd = WEEKDAY[kind] || WEEKDAY.flat;
  for (let d = 0; d < days; d++) {
    const dow = new Date(span.start + d * DAY).getUTCDay();
    w[d] = wd[dow] * (dayFactor ? dayFactor(span.start + d * DAY) : 1);
  }
  if (bursts) {
    for (let d = 0; d < days; d++) {
      if (rng.chance(kind === 'online' ? 0.06 : 0.03)) {
        const f = rng.range(2.5, kind === 'online' ? 7 : 3.5);
        burstDays.push({ t: span.start + d * DAY, factor: Math.round(f * 10) / 10 });
        w[d] *= f;
        if (d + 1 < days) w[d + 1] *= 1 + (f - 1) * 0.4;
        if (d + 2 < days) w[d + 2] *= 1 + (f - 1) * 0.15;
      }
    }
  }
  const dayCum = cumulative(w);
  const hourCum = cumulative(HOURS[kind] || HOURS.flat);
  const flatCum = cumulative(HOURS.flat);
  return {
    kind, span, burstDays, dayWeights: w,
    // A time within [from, until) for someone whose local zone is offsetHours from UTC.
    sample(r, from = span.start, until = span.end, offsetHours = 0, flat = false) {
      from = Math.max(from, span.start); until = Math.min(until, span.end);
      if (!(until > from)) return NaN;
      const d0 = Math.floor((from - span.start) / DAY), d1 = Math.min(days - 1, Math.floor((until - 1 - span.start) / DAY));
      const lo = d0 > 0 ? dayCum[d0 - 1] : 0, hi = dayCum[d1];
      for (let tries = 0; tries < 6; tries++) {
        let d;
        if (hi > lo) {
          const x = lo + r.next() * (hi - lo);
          let a = d0, b = d1;
          while (a < b) { const m = (a + b) >> 1; if (dayCum[m] > x) b = m; else a = m + 1; }
          d = a;
        } else d = d0 + r.int(d1 - d0 + 1);
        const h = drawCum(flat ? flatCum : hourCum, r);
        const t = span.start + d * DAY + (h - offsetHours) * HOUR + Math.floor(r.next() * HOUR);
        if (t >= from && t < until) return t;
      }
      return from + Math.floor(r.next() * (until - from));
    },
  };
}

export const pad = (n, w = 2) => String(n).padStart(w, '0');
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const WDAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Wall-clock parts of t shifted by offsetHours.
export function parts(t, offsetHours = 0) {
  const d = new Date(t + offsetHours * HOUR);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds(), dow: d.getUTCDay() };
}

export function isoDate(t, off = 0) { const p = parts(t, off); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; }
export function isoNoZone(t, off = 0) { const p = parts(t, off); return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; }
export function offsetString(off, colon = false) {
  const sign = off < 0 ? '-' : '+';
  const a = Math.abs(off), h = Math.floor(a), m = Math.round((a - h) * 60);
  return `${sign}${pad(h)}${colon ? ':' : ''}${pad(m)}`;
}
