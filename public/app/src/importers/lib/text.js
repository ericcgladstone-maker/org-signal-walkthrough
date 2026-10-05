// Text helpers shared by the personal/online importers.

const utf8Fatal = new TextDecoder('utf-8', { fatal: true });

// Meta (Messenger, Instagram, Threads) writes each UTF-8 byte as its own
// \u00XX escape, so after JSON.parse U+00E9 reads as U+00C3 U+00A9 and an emoji becomes four
// junk characters. Re-reading the code units as bytes undoes it.
//
// Idempotent and safe on correct text:
//   - pure ASCII is returned as is;
//   - any code unit above U+00FF means the string was not byte-escaped (or was
//     already fixed), so it is returned as is;
//   - genuine Latin-1 text ('café') is not valid UTF-8 when read as bytes, so
//     the fatal decoder throws and the original is kept.
// The one theoretical false positive is real text that happens to be valid
// UTF-8 when read as bytes (e.g. a literal U+00C3 U+00A9 pair); it is vanishingly
// rare in chat text and is accepted.
export function fixMojibake(s) {
  if (typeof s !== 'string' || !/[\u0080-ÿ]/.test(s) || /[^\u0000-ÿ]/.test(s)) return s;
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  try { return utf8Fatal.decode(bytes); } catch { return s; }
}

// Apply fixMojibake to every string (values and keys) in a parsed JSON tree.
export function fixMojibakeDeep(v) {
  if (typeof v === 'string') return fixMojibake(v);
  if (Array.isArray(v)) return v.map(fixMojibakeDeep);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[fixMojibake(k)] = fixMojibakeDeep(x);
    return out;
  }
  return v;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" };

// Decode HTML character references (X full_text, Mastodon content).
export function decodeEntities(s) {
  if (typeof s !== 'string' || !s.includes('&')) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
}

// HTML to plain text without a DOM (importers must run in workers and Node).
// Block breaks become newlines; tags are dropped; entities decoded.
export function stripHtml(html) {
  if (typeof html !== 'string') return html;
  const t = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|blockquote)>/gi, '\n')
    .replace(/<[^>]*>/g, '');
  return decodeEntities(t).replace(/\n{3,}/g, '\n\n').trim();
}

// Normalise a display name into a node-key fragment (Meta, WhatsApp, LinkedIn
// names when no id exists): NFC, collapsed whitespace, case-folded.
export function nameKey(name) {
  return String(name ?? '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}
