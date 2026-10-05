// Identity matching: which nodes might be the same person seen through
// different sources (Slack user, email address, calendar attendee, HR row)?
//
// This only proposes. Each candidate pair carries a confidence and the
// evidence behind it; merging is a separate, explicit step (merge.js
// applyMerges) that the user confirms. Low-confidence pairs must never be
// merged automatically.
//
// Rules, strongest first:
//   high    same email address (key, attrs.email or any platformIds key with
//           "email" in it), compared lowercased
//   high    same phone number after normalisation (+CC digits); medium when only
//           the national part agrees (one side lacks the country code)
//   high    same id on the same global platform (platformIds), different keys;
//           generic handles (handle, username, acct) only within one namespace,
//           low across platforms (one name, different services)
//   medium  same normalised full name (two or more tokens) in different namespaces
//   medium  email local part spells the other node's full name (ana.ruiz <-> Ana Ruiz)
//   low     single-token names, initial+surname local parts (aruiz), names shared
//           by several people in one namespace, and any name match involving an
//           ego-interview alter (alters are respondent-specific, see
//           docs/formats/network-canvas-and-surveys.md)

// NFKD then drop combining marks: "José  Pérez" -> "jose perez".
export function normalizeText(s) {
  return String(s ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// Name -> sorted-order-preserving token list. "Okafor, Ben" -> ['ben', 'okafor'].
export function nameTokens(s) {
  let t = normalizeText(s);
  if (!t || t.includes('@')) return [];
  // "Last, First" (common in email display names and HR exports).
  const comma = /^([^,]+),\s*([^,]+)$/.exec(t);
  if (comma) t = `${comma[2]} ${comma[1]}`;
  return t.replace(/[^\p{L}\p{N}\s'-]/gu, ' ').replace(/['-]/g, '').split(/\s+/).filter(Boolean);
}

// Platforms whose ids are only meaningful inside one file or one interview.
const LOCAL_PLATFORMS = new Set(['net', 'csv', 'nc', 'survey', 'row', 'canvas', 'tabular', 'gml', 'pajek', 'whatsapp_name']);
// Fields that hold a user-chosen name, not a platform-issued id.
const GENERIC_HANDLES = new Set(['handle', 'username', 'acct', 'screen_name']);
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function namespace(key) { const i = key.indexOf(':'); return i < 0 ? '' : key.slice(0, i); }

function emailsOf(ds, i) {
  const out = new Set();
  const key = ds.nodes.keys[i];
  const a = ds.nodes.attrs[i] || {};
  const p = ds.nodes.platformIds[i] || {};
  const vals = [key.startsWith('email:') ? key.slice(6) : null, a.email];
  for (const [k, v] of Object.entries(p)) if (/email/i.test(k)) vals.push(v);
  for (const v of vals) {
    if (typeof v !== 'string') continue;
    const t = v.trim().replace(/^mailto:/i, '');
    if (EMAIL_RE.test(t)) out.add(t.toLowerCase());
  }
  return [...out];
}

// Phone number -> { full, national } digits. "+1 (415) 555-0123" -> full
// "+14155550123"; "00 44 7700 900123" -> "+447700900123"; "07700 900123" ->
// national "7700900123" (trunk 0 dropped). Without a country code we cannot
// know it, so only the national part is comparable. Under 7 digits: not a phone.
export function normalizePhone(v) {
  let s = String(v ?? '').trim();
  if (!s || /@/.test(s)) return null;
  s = s.replace(/^tel:/i, '').replace(/;.*$/, '').replace(/\s*(ext\.?|x)\s*\d+$/i, '');
  const plus = /^\s*(\+|00)/.test(s);
  let d = s.replace(/\D/g, '');
  if (s.trim().startsWith('00')) d = d.slice(2);
  if (d.length < 7 || d.length > 15) return null;
  if (plus) return { full: '+' + d, digits: d };
  return { full: null, digits: d.replace(/^0+/, '') };
}

function phonesOf(ds, i) {
  const out = [];
  const a = ds.nodes.attrs[i] || {};
  const p = ds.nodes.platformIds[i] || {};
  const vals = [a.phone];
  for (const [k, v] of Object.entries(p)) if (/phone|tel|msisdn/i.test(k)) vals.push(v);
  for (const v of vals) { const n = normalizePhone(v); if (n && !out.some(x => x.digits === n.digits)) out.push(n); }
  return out;
}

// Same number? Both with country codes: must be equal. Otherwise the national
// digits of the code-less one must end the other's digits.
function phoneMatch(x, y) {
  if (x.full && y.full) return x.full === y.full ? 'high' : null;
  if (x.digits === y.digits) return x.full || y.full ? 'medium' : 'high';
  const [short, long] = x.digits.length <= y.digits.length ? [x, y] : [y, x];
  if (short.digits.length >= 7 && long.digits.endsWith(short.digits) && long.digits.length - short.digits.length <= 3) return 'medium';
  return null;
}

function namesOf(ds, i) {
  const out = new Set();
  const a = ds.nodes.attrs[i] || {};
  for (const v of [ds.nodes.labels[i], a.real_name, a.full_name, a.name, a.display_name]) {
    if (typeof v !== 'string') continue;
    const toks = nameTokens(v);
    if (toks.length) out.add(toks.join(' '));
  }
  return [...out];
}

const RANK = { high: 3, medium: 2, low: 1 };

// suggestMatches(ds, { maxBucket = 50 }) -> [{ a, b, keyA, keyB, labelA, labelB, confidence, evidence[] }]
// sorted by confidence then key. a < b are node indices.
export function suggestMatches(ds, { maxBucket = 50 } = {}) {
  const n = ds.nodes.count;
  const pairs = new Map(); // "a|b" -> entry
  const notes = [];
  const isAlter = i => (ds.nodes.attrs[i] || {}).kind === 'alter';
  const isBot = i => !!ds.nodes.isBot[i];

  const propose = (x, y, confidence, evidence) => {
    if (x === y) return;
    if (isBot(x) !== isBot(y)) return; // a bot and a person are never the same identity
    const [a, b] = x < y ? [x, y] : [y, x];
    const id = a + '|' + b;
    let e = pairs.get(id);
    if (!e) {
      e = { a, b, keyA: ds.nodes.keys[a], keyB: ds.nodes.keys[b], labelA: ds.nodes.labels[a], labelB: ds.nodes.labels[b], confidence, evidence: [] };
      pairs.set(id, e);
    }
    if (RANK[confidence] > RANK[e.confidence]) e.confidence = confidence;
    if (!e.evidence.includes(evidence)) e.evidence.push(evidence);
  };

  const buckets = (fn) => {
    const m = new Map();
    for (let i = 0; i < n; i++) for (const v of fn(i)) { if (!m.has(v)) m.set(v, []); m.get(v).push(i); }
    return m;
  };
  const eachPair = (list, f) => { for (let x = 0; x < list.length; x++) for (let y = x + 1; y < list.length; y++) f(list[x], list[y]); };

  // 1. Same email.
  for (const [email, list] of buckets(i => emailsOf(ds, i))) {
    if (list.length < 2) continue;
    if (list.length > maxBucket) { notes.push(`Skipped ${list.length} nodes sharing ${email} (too many to be one person).`); continue; }
    eachPair(list, (x, y) => propose(x, y, 'high', `same email address ${email}`));
  }

  // 1b. Same phone number. Bucketed on the last 7 digits, compared exactly.
  const phoneCache = new Map();
  const phones = i => { if (!phoneCache.has(i)) phoneCache.set(i, phonesOf(ds, i)); return phoneCache.get(i); };
  for (const [tail, list] of buckets(i => phones(i).map(p => p.digits.slice(-7)))) {
    if (list.length < 2 || list.length > maxBucket) continue;
    eachPair(list, (x, y) => {
      for (const px of phones(x)) for (const py of phones(y)) {
        if (px.digits.slice(-7) !== tail || py.digits.slice(-7) !== tail) continue;
        const conf = phoneMatch(px, py);
        if (conf) propose(x, y, conf, conf === 'high' ? `same phone number ${px.full || px.digits}` : `phone numbers ${px.full || px.digits} and ${py.full || py.digits} agree apart from the country code`);
      }
    });
  }

  // 2. Same platform id on a global platform. Generic handle fields are only
  // identifying within one namespace: "ana" on X and "ana" on Discord need not
  // be one person.
  for (const [pid, list] of buckets(i => Object.entries(ds.nodes.platformIds[i] || {})
    .filter(([p, v]) => !LOCAL_PLATFORMS.has(p) && !/email|phone|tel|own_handles/i.test(p) && v != null && String(v).length >= 3)
    // Generic handle fields share one bucket so X 'handle' meets Discord 'username'.
    .map(([p, v]) => (GENERIC_HANDLES.has(p) ? `handle:${String(v).toLowerCase().replace(/^@/, '')}` : `${p}:${v}`)))) {
    if (list.length < 2 || list.length > maxBucket) continue;
    const p = pid.slice(0, pid.indexOf(':')), v = pid.slice(pid.indexOf(':') + 1);
    eachPair(list, (x, y) => {
      if (p === 'handle' && namespace(ds.nodes.keys[x]) !== namespace(ds.nodes.keys[y])) {
        propose(x, y, 'low', `same user name "${v}" on different services`);
      } else propose(x, y, 'high', `same ${p} id ${v}`);
    });
  }

  // 3. Same normalised name.
  const byName = buckets(i => namesOf(ds, i));
  for (const [name, list] of byName) {
    if (list.length < 2) continue;
    if (list.length > maxBucket) { notes.push(`Skipped name "${name}" shared by ${list.length} nodes.`); continue; }
    // Several distinct nodes with this name in one namespace means the name is
    // not unique there, so it cannot identify anyone across namespaces either.
    const perNs = new Map();
    for (const i of list) perNs.set(namespace(ds.nodes.keys[i]), (perNs.get(namespace(ds.nodes.keys[i])) || 0) + 1);
    const tokens = name.split(' ').length;
    eachPair(list, (x, y) => {
      const nsx = namespace(ds.nodes.keys[x]), nsy = namespace(ds.nodes.keys[y]);
      let conf = tokens >= 2 && nsx !== nsy ? 'medium' : 'low';
      let ev = `same name "${name}"`;
      if (perNs.get(nsx) > 1 || perNs.get(nsy) > 1) { conf = 'low'; ev += ' (shared by several people in one source)'; }
      if (isAlter(x) || isAlter(y)) { conf = 'low'; ev += ' (interview alters are specific to one respondent)'; }
      propose(x, y, conf, ev);
    });
  }

  // 4. Email local part vs full name.
  const nameIndex = new Map(); // "ana ruiz" -> [i]
  for (const [name, list] of byName) if (name.includes(' ')) nameIndex.set(name, list);
  const compactIndex = new Map(); // "anaruiz" and "aruiz" -> [{ i, how }]
  for (const [name, list] of nameIndex) {
    const t = name.split(' ');
    const full = t.join('');
    const initial = t[0][0] + t[t.length - 1];
    for (const i of list) {
      if (!compactIndex.has(full)) compactIndex.set(full, []);
      compactIndex.get(full).push({ i, how: 'full' });
      if (initial !== full) {
        if (!compactIndex.has(initial)) compactIndex.set(initial, []);
        compactIndex.get(initial).push({ i, how: 'initial' });
      }
    }
  }
  for (let i = 0; i < n; i++) {
    for (const email of emailsOf(ds, i)) {
      const local = email.slice(0, email.indexOf('@')).replace(/\+.*$/, '');
      const parts = normalizeText(local).split(/[._-]+/).filter(Boolean);
      const seen = new Set();
      if (parts.length >= 2) {
        for (const cand of [parts.join(' '), [...parts].reverse().join(' ')]) {
          const list = nameIndex.get(cand) || [];
          if (list.length > maxBucket) continue;
          // The address owner may carry the name itself (a Slack account with
          // its own email): only other people with the name make it ambiguous.
          const others = list.filter(j => j !== i);
          for (const j of others) if (!seen.has(j)) {
            seen.add(j);
            const ambiguous = others.length > 1;
            propose(i, j, ambiguous || isAlter(j) ? 'low' : 'medium', `email ${email} spells the name "${ds.nodes.labels[j]}"${ambiguous ? ' (several people have that name)' : ''}`);
          }
        }
      }
      const compact = parts.join('');
      const compactOthers = (compactIndex.get(compact) || []).filter(x => x.i !== i);
      const many = new Set(compactOthers.map(x => x.i)).size > 1;
      for (const { i: j, how } of compactOthers) {
        if (seen.has(j)) continue;
        seen.add(j);
        const conf = how === 'full' && !many && !isAlter(j) ? 'medium' : 'low';
        propose(i, j, conf, how === 'full' ? `email ${email} spells the name "${ds.nodes.labels[j]}"` : `email ${email} matches the initial and surname of "${ds.nodes.labels[j]}"`);
      }
    }
  }

  const out = [...pairs.values()].sort((x, y) => RANK[y.confidence] - RANK[x.confidence] || x.keyA.localeCompare(y.keyA) || x.keyB.localeCompare(y.keyB));
  out.notes = notes;
  return out;
}
