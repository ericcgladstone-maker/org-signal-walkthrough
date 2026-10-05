// JSON helpers shared by the personal/online importers.
//
// Three problems recur across exports:
//   1. 64-bit ids written as bare JSON numbers (Discord package `ID`, v1.1
//      tweet `id`). JSON.parse silently rounds them, so we quote long integer
//      literals in the raw text before parsing.
//   2. X archive files are a JS assignment (`window.YTD.x.part0 = [...]`).
//   3. Some single-document exports (Telegram result.json, Mastodon outbox,
//      DiscordChatExporter) can be hundreds of MB. streamJSON() walks the text
//      incrementally and materialises only the values at the paths asked for,
//      so the whole tree never exists in memory at once.

// Integer literals with 16+ digits can exceed Number.MAX_SAFE_INTEGER
// (9007199254740991). Strings are matched first and returned untouched, so
// digits inside strings are never quoted. The look-arounds keep fractions and
// exponents (1.2345678901234567e5) intact.
const BIG_RE = /"(?:[^"\\]|\\.)*"|(?<![\w.+-])-?\d{16,}(?![\d.eE])/g;

export function quoteBigInts(text) {
  if (!/\d{16}/.test(text)) return text;
  return text.replace(BIG_RE, m => (m.charCodeAt(0) === 34 ? m : '"' + m + '"'));
}

// JSON.parse that keeps long integers as strings (default) and strips a BOM.
export function parseJSON(text, { bigInts = true } = {}) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return JSON.parse(bigInts ? quoteBigInts(text) : text);
}

// X archive `window.YTD.<type>.partN = [...]` (and `window.__THAR_CONFIG = {...}`).
// The spec's robust rule: everything after the first '=' is JSON. Do not match on
// the global name, which changed between archive versions.
export function parseYTD(text) {
  const i = text.indexOf('=');
  if (i < 0) throw new Error('Not an X archive data file (no "=" assignment found).');
  let body = text.slice(i + 1).trim();
  if (body.endsWith(';')) body = body.slice(0, -1);
  return parseJSON(body);
}

// Match a concrete path against a dotted pattern; '*' matches any key or index.
function matches(pattern, path) {
  if (pattern.length !== path.length) return false;
  for (let i = 0; i < pattern.length; i++) if (pattern[i] !== '*' && pattern[i] !== String(path[i])) return false;
  return true;
}

const WS = new Set([32, 9, 10, 13]);

// Incremental JSON walker.
//   source    ReadableStream<Uint8Array> | ReadableStream<string> | string
//   patterns  ['chats.list.*.messages.*', 'chats.list.*.name', ...]
// Yields { path, pattern, value } in document order for every value whose path
// matches a pattern exactly. Values at non-matching paths are skipped without
// being built. A matched container is not descended into further (patterns are
// not nested inside each other).
//
// The walker trusts the input to be valid JSON; on malformed input it throws
// from JSON.parse of the captured value or stops yielding at the damage.
export async function* streamJSON(source, patterns, { bigInts = true } = {}) {
  const pats = patterns.map(p => (p === '' ? [] : p.split('.')));
  const maxLen = Math.max(...pats.map(p => p.length));
  const w = new Walker(pats, maxLen, bigInts);
  if (typeof source === 'string') {
    yield* w.feed(source.charCodeAt(0) === 0xfeff ? source.slice(1) : source);
  } else {
    const reader = source.getReader();
    const dec = new TextDecoder('utf-8');
    let first = true;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let s = typeof value === 'string' ? value : dec.decode(value, { stream: true });
      if (first && s.charCodeAt(0) === 0xfeff) s = s.slice(1);
      first = false;
      yield* w.feed(s);
    }
    const tail = dec.decode();
    if (tail) yield* w.feed(tail);
  }
  yield* w.end();
}

// States of the structural walker.
const S_VALUE = 0, S_KEY_OR_END = 1, S_KEY = 2, S_COLON = 3, S_AFTER = 4, S_SKIPSTR = 5, S_SKIPSCALAR = 6, S_VALUE_OR_END = 7, S_DONE = 8;

class Walker {
  constructor(pats, maxLen, bigInts) {
    this.pats = pats; this.maxLen = maxLen; this.bigInts = bigInts;
    this.stack = []; // { arr, key, idx }
    this.state = S_VALUE;
    this.keyBuf = ''; this.esc = false;
    // capture
    this.cap = null; // { parts[], depth, inStr, esc, scalar, path, pattern }
  }

  path() { return this.stack.map(f => (f.arr ? f.idx : f.key)); }

  matchHere() {
    if (this.stack.length > this.maxLen) return null;
    const p = this.path();
    for (const pat of this.pats) if (matches(pat, p)) return { path: p, pattern: pat.join('.') };
    return null;
  }

  *finishCapture(text) {
    const c = this.cap;
    this.cap = null;
    const raw = c.parts.join('') + text;
    const value = JSON.parse(this.bigInts ? quoteBigInts(raw) : raw);
    yield { path: c.path, pattern: c.pattern, value };
    this.afterValue();
  }

  afterValue() { this.state = this.stack.length ? S_AFTER : S_DONE; }

  *feed(s) {
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (this.cap) {
        // Fast scan inside a captured value: track only strings and depth.
        const c = this.cap;
        const start = i;
        let done = false;
        for (; i < n; i++) {
          const ch = s.charCodeAt(i);
          if (c.inStr) {
            if (c.esc) c.esc = false;
            else if (ch === 92) c.esc = true;
            else if (ch === 34) { c.inStr = false; if (c.scalar) { i++; done = true; break; } }
          } else if (c.scalar) {
            if (ch === 44 || ch === 93 || ch === 125 || WS.has(ch)) { done = true; break; }
          } else if (ch === 34) c.inStr = true;
          else if (ch === 123 || ch === 91) c.depth++;
          else if (ch === 125 || ch === 93) { if (--c.depth === 0) { i++; done = true; break; } }
        }
        if (done) yield* this.finishCapture(s.slice(start, i));
        else c.parts.push(s.slice(start));
        continue;
      }
      const ch = s.charCodeAt(i);
      switch (this.state) {
        case S_DONE: i = n; break;
        case S_VALUE_OR_END:
          if (WS.has(ch)) { i++; break; }
          if (ch === 93) { this.stack.pop(); this.afterValue(); i++; break; }
          this.state = S_VALUE; break;
        case S_VALUE: {
          if (WS.has(ch)) { i++; break; }
          const m = this.matchHere();
          if (m) {
            const scalar = ch !== 123 && ch !== 91;
            this.cap = { parts: [], depth: 0, inStr: false, esc: false, scalar, path: m.path, pattern: m.pattern };
            if (scalar && ch === 34) { this.cap.inStr = true; this.cap.parts.push('"'); i++; }
            break; // containers: the capture loop consumes the opening bracket
          }
          if (ch === 123) { this.stack.push({ arr: false, key: null, idx: 0 }); this.state = S_KEY_OR_END; }
          else if (ch === 91) { this.stack.push({ arr: true, key: null, idx: 0 }); this.state = S_VALUE_OR_END; }
          else if (ch === 34) { this.state = S_SKIPSTR; this.esc = false; }
          else this.state = S_SKIPSCALAR;
          i++;
          break;
        }
        case S_SKIPSTR:
          for (; i < n; i++) {
            const c = s.charCodeAt(i);
            if (this.esc) this.esc = false;
            else if (c === 92) this.esc = true;
            else if (c === 34) { i++; this.afterValue(); break; }
          }
          break;
        case S_SKIPSCALAR:
          if (ch === 44 || ch === 93 || ch === 125 || WS.has(ch)) this.afterValue();
          else i++;
          break;
        case S_KEY_OR_END:
          if (WS.has(ch)) { i++; break; }
          if (ch === 125) { this.stack.pop(); this.afterValue(); i++; break; }
          if (ch === 34) { this.state = S_KEY; this.keyBuf = ''; this.esc = false; i++; break; }
          throw new Error(`Malformed JSON: expected a key, found '${s[i]}'`);
        case S_KEY: {
          const start = i;
          let closed = false;
          for (; i < n; i++) {
            const c = s.charCodeAt(i);
            if (this.esc) this.esc = false;
            else if (c === 92) this.esc = true;
            else if (c === 34) { closed = true; break; }
          }
          this.keyBuf += s.slice(start, i);
          if (closed) {
            i++;
            const k = this.keyBuf;
            this.stack[this.stack.length - 1].key = k.includes('\\') ? JSON.parse('"' + k + '"') : k;
            this.state = S_COLON;
          }
          break;
        }
        case S_COLON:
          if (WS.has(ch)) { i++; break; }
          if (ch === 58) { this.state = S_VALUE; i++; break; }
          throw new Error(`Malformed JSON: expected ':', found '${s[i]}'`);
        case S_AFTER: {
          if (WS.has(ch)) { i++; break; }
          const top = this.stack[this.stack.length - 1];
          if (ch === 44) { if (top.arr) { top.idx++; this.state = S_VALUE; } else this.state = S_KEY_OR_END; i++; break; }
          if (ch === 93 || ch === 125) { this.stack.pop(); this.afterValue(); i++; break; }
          throw new Error(`Malformed JSON: unexpected '${s[i]}'`);
        }
      }
    }
  }

  *end() {
    // A top-level scalar match (e.g. a lone number) ends at EOF.
    if (this.cap && this.cap.scalar && !this.cap.inStr) yield* this.finishCapture('');
    else if (this.cap) throw new Error('Unexpected end of JSON input inside a value.');
  }
}

// Read a FileSet entry as JSON, keeping long ids as strings.
export async function readJSON(entry, opts) {
  return parseJSON(await entry.text(), opts);
}
