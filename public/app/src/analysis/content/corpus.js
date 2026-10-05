// Tokenizer and a cached, integer-coded corpus of message texts.
//
// Keywords, topics and diffusion all read the same tokens, so the corpus is
// built once per dataset (WeakMap cache) and stored as flat typed arrays.

import { STOPWORDS, DOMAIN_NOISE } from './stopwords.js';
import { floorTo } from '../time.js';

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/giu;
const EMAIL_RE = /\b[\w.+-]+@[\w-]+\.[\w.-]+\b/gu;
// Slack-style <@U123>, <#C123|name>, <!channel>, <https://...|label>
const ANGLE_RE = /<[@#!][^>]*>|<https?:[^>]*>/gu;
const MENTION_RE = /(^|[^\w])@[\p{L}\p{N}_.-]+/gu;
const EMOJI_CODE_RE = /:[a-z0-9_+-]{2,40}:/gu;
const EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u{1F3FB}-\u{1F3FF}‍️]/gu;
const WORD_RE = /[\p{L}\p{M}][\p{L}\p{M}\p{N}'’_-]*/gu;

// ---- message cleaning ------------------------------------------------------------

// What the sender wrote, without the text they quoted or their signature.
// Email replies carry the whole thread below an "On <date>, <name> wrote:"
// line; counted as the sender's words, the quoted names, dates and headers
// become the largest "topic" and someone else's tone is scored as theirs.
// Recognised: '>' quoted lines; "On ... wrote:" (also split over two lines,
// and the French, German, Spanish, Italian, Dutch and Portuguese forms);
// Outlook "-----Original Message-----" and "From: / Sent:" header blocks;
// forwarded-message markers; the "-- " signature delimiter and "Sent from my
// phone" lines. Returns { text, quoted, signature }.
const WROTE_RE = /\b(wrote|écrit|schrieb|escribió|scritto|schreef|escreveu)\s*:\s*$/i;
const HEADER_RE = /^(sent|date|to|subject|cc|envoyé|gesendet|enviado)\s*:/i;
export function cleanText(text) {
  const s = String(text ?? '');
  if (!s.includes('\n') && !s.startsWith('>')) return { text: s, quoted: false, signature: false };
  const lines = s.split(/\r?\n/);
  const out = [];
  let quoted = false, signature = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i], t = line.trim();
    if (t.startsWith('>')) { quoted = true; continue; }
    if (WROTE_RE.test(t) && /^(on|le|am|el|il|op|em)\b/i.test(t)) { quoted = true; break; }
    if (/^(on|le|am|el|il|op|em)\b/i.test(t) && i + 1 < lines.length && WROTE_RE.test(lines[i + 1].trim()) && !t.endsWith('.')) { quoted = true; break; }
    if (/^-{2,}\s*(original message|forwarded message|message d'origine|ursprüngliche nachricht|mensaje original)\s*-{2,}$/i.test(t)) { quoted = true; break; }
    if (/^(begin forwarded message|-{5,}\s*forwarded)/i.test(t)) { quoted = true; break; }
    if (/^_{8,}$/.test(t) && /^(from|de|von)\s*:/i.test((lines[i + 1] || '').trim())) { quoted = true; break; }
    if (/^(from|de|von)\s*:\s*\S/i.test(t) && lines.slice(i + 1, i + 4).some(l => HEADER_RE.test(l.trim()))) { quoted = true; break; }
    if (line === '-- ' || t === '--') { signature = true; break; }
    if (/^sent from my \S+/i.test(t) || /^get outlook for /i.test(t)) { signature = true; continue; }
    out.push(line);
  }
  return { text: out.join('\n'), quoted, signature };
}

// Words that name the people in the data: each part of every label, the
// local part of email-like keys and platform ids, and their mail domains.
// In personal exports the owner's own name and domain sit in every message
// (signatures, greetings, "Felipe wrote") and would top every keyword list.
const nameCache = new WeakMap();
export function nameStopwords(ds) {
  if (nameCache.has(ds)) return nameCache.get(ds);
  const out = new Set();
  const addWords = (str) => {
    for (const m of String(str || '').normalize('NFKC').toLowerCase().matchAll(/[\p{L}\p{M}]+/gu)) {
      const w = m[0];
      if ([...w].length >= 2 && !DOMAIN_NOISE.has(w)) out.add(w);
    }
  };
  const addAddress = (str) => {
    const at = String(str).match(/([\w.+-]+)@([\w.-]+)/u);
    if (!at) return;
    addWords(at[1]);
    for (const part of at[2].split('.')) if (!DOMAIN_NOISE.has(part.toLowerCase())) addWords(part);
  };
  const N = ds.nodes?.count ?? 0;
  for (let i = 0; i < N; i++) {
    if (ds.nodes.isBot?.[i]) continue;
    addWords(ds.nodes.labels?.[i]);
    const key = ds.nodes.keys?.[i];
    if (key) addAddress(key);
    const email = ds.nodes.attrs?.[i]?.email;
    if (email) addAddress(email);
  }
  nameCache.set(ds, out);
  return out;
}

// opts: { stopwords: true, minLength: 2, keepEmoji: false, extraStop: Set }
export function tokenize(text, opts = {}) {
  if (!text) return [];
  let s = String(text).normalize('NFKC');
  s = s.replace(ANGLE_RE, ' ').replace(URL_RE, ' ').replace(EMAIL_RE, ' ').replace(MENTION_RE, '$1 ').replace(EMOJI_CODE_RE, ' ');
  const emoji = opts.keepEmoji ? s.match(EMOJI_RE) || [] : [];
  s = s.replace(EMOJI_RE, ' ').toLowerCase();
  const minLen = opts.minLength ?? 2;
  const stop = opts.stopwords === false ? null : STOPWORDS;
  const out = [];
  for (const m of s.matchAll(WORD_RE)) {
    let w = m[0].replace(/[’]/g, "'").replace(/^['_-]+|['_-]+$/g, '');
    if (w.endsWith("'s")) w = w.slice(0, -2);
    if ([...w].length < minLen) continue;
    if (stop && (stop.has(w) || stop.has(w.replace(/'/g, '')))) continue;
    if (opts.extraStop && opts.extraStop.has(w)) continue;
    out.push(w);
  }
  return opts.keepEmoji ? out.concat(emoji) : out;
}

const cache = new WeakMap();
const SOURCE_NAMES = { email: 'Email', slack: 'Slack', teams: 'Teams', linkedin: 'LinkedIn', 'x-archive': 'X', whatsapp: 'WhatsApp', imessage: 'iMessage', telegram: 'Telegram', discord: 'Discord', reddit: 'Reddit', mastodon: 'Mastodon', bluesky: 'Bluesky', threads: 'Threads', meta: 'Facebook/Instagram', synthetic: 'Generated data' };

// { docs Int32Array (event index per doc), off Int32Array, tok Int32Array,
//   terms string[], df Int32Array, termIndex Map, cleaning }. Messages with
// text only, cleaned (cleanText), without stopwords or the names of people
// in the data. cleaning = { messages, quoted, signatures, nameWords }.
export function corpus(ds) {
  let c = cache.get(ds);
  if (c) return c;
  const ev = ds.events;
  const termIndex = new Map(), terms = [];
  const docs = [], off = [0], tok = [];
  const dfArr = [];
  const names = nameStopwords(ds);
  let quoted = 0, signatures = 0, messages = 0;
  for (let i = 0; i < ev.count; i++) {
    const text = ev.text?.[i];
    if (!text || ev.type[i] !== 0) continue;
    const cl = cleanText(text);
    messages++;
    if (cl.quoted) quoted++;
    if (cl.signature) signatures++;
    const words = tokenize(cl.text, { extraStop: names });
    const seen = new Set();
    for (const w of words) {
      let id = termIndex.get(w);
      if (id === undefined) { id = terms.length; termIndex.set(w, id); terms.push(w); dfArr.push(0); }
      tok.push(id);
      if (!seen.has(id)) { seen.add(id); dfArr[id]++; }
    }
    docs.push(i); off.push(tok.length);
  }
  c = { docs: Int32Array.from(docs), off: Int32Array.from(off), tok: Int32Array.from(tok), terms, df: Int32Array.from(dfArr), termIndex,
    cleaning: { messages, quoted, signatures, nameWords: names.size } };
  cache.set(ds, c);
  return c;
}

// Unit (grouping) of each document: node / context / source / visibility / attr / window / overall.
// Returns { unitOf(docIndex) -> key|null, label(key) }.
export function unitResolver(ds, by, opts = {}) {
  const ev = ds.events;
  const VIS = ['public', 'private', 'direct', 'group', 'unknown'];
  if (by === 'node') return { of: (i) => ev.actor[i], label: (k) => ds.nodes.labels[k] };
  if (by === 'context') return { of: (i) => (ev.context[i] >= 0 ? ev.context[i] : null), label: (k) => ds.contexts.names[k] };
  // Source: the kind of export (all WhatsApp chats together, the mailbox, the
  // X archive), the natural comparison for one person's mixed exports.
  if (by === 'source') {
    const S = ds.meta?.sources || [];
    const name = (f) => SOURCE_NAMES[f] || String(f || 'unknown').replace(/^./, ch => ch.toUpperCase());
    return { of: (i) => (S[ev.source[i]] ? name(S[ev.source[i]].format) : null), label: (k) => k };
  }
  if (by === 'visibility') return { of: (i) => (ev.context[i] >= 0 ? VIS[ds.contexts.visibility[ev.context[i]]] : 'unknown'), label: (k) => k };
  if (by === 'group' || by === 'attr') {
    const attr = opts.attr;
    if (!attr) throw new Error('by: group needs opts.attr');
    return { of: (i) => { const v = ds.nodes.attrs[ev.actor[i]]?.[attr]; return v == null || v === '' ? null : String(v); }, label: (k) => `${k}` };
  }
  if (by === 'window') {
    const unit = opts.window ?? 'week';
    if (typeof unit === 'number') return { of: (i) => (Number.isFinite(ev.t[i]) ? Math.floor(ev.t[i] / unit) * unit : null), label: (k) => new Date(k).toISOString().slice(0, 16).replace('T', ' ') };
    return { of: (i) => (Number.isFinite(ev.t[i]) ? floorTo(ev.t[i], unit) : null), label: (k) => new Date(k).toISOString().slice(0, unit === 'month' ? 7 : 10) };
  }
  return { of: () => 'all', label: () => 'All messages' };
}
