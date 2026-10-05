// Shared surveys without a server: share links, survey files and response files.
//
// The organizer builds a survey (a roster survey from the roster builder, or
// an ego interview, optionally against the roster). The app turns its
// definition into a link whose fragment carries the whole survey:
//
//   https://<app>/#survey=1.<base64url(deflate-raw(JSON definition))>
//
// Browsers never send the part after '#' to a server, so the survey reaches
// the respondent's browser without being uploaded anywhere. Respondents fill
// it in and download a response file (or copy it as a text block to paste
// into an email). The organizer drops every response file into Data, or
// imports them in the builder, and recombine() puts the network back
// together with the roster's merge rules. When a link would be longer than
// LINK_LIMIT (very large rosters), the same definition goes in a survey file
// the respondent opens in the app instead.
//
// Survey definition (format 'orgsignal-survey', version 1):
//   { format, version, id, kind: 'roster' | 'ego', title, intro, createdAt,
//     people: [{ id, label }],                         roster (names only, never attributes)
//     relations: [{ id, name, question, scale, max, fields }],      kind 'roster'
//     combine: 'union' | 'intersection' | 'respondent',             kind 'roster'
//     ego: { generators, interpreters, tieFields, askTies, allowOthers } }  kind 'ego'
//
// Response (format 'orgsignal-response', version 1):
//   { format, version,
//     survey: { id, kind, title, hash },          hash = crc32 of the definition answered
//     respondent: { personId | null, label },
//     created,                                    ISO time the response was made
//     answers:
//       roster: { [relationId]: { [personId]: { value, fields? } } }
//       ego:    { alters: [{ id, label, personId?, generators[], attrs{}, tie{} }],
//                 contexts: [{ name, members: [alterId] }], ties: { 'a|b': bool } }
//     definition,                                 the survey as answered (names only)
//     checksum: 'crc32:<8 hex>' }                 over everything else, canonical JSON
//
// The checksum catches corruption and hand edits (a mangled email paste); it
// is not a signature and does not prove who answered.
//
// Pure functions; Node and browser.

import { deflateSync, inflateSync, strToU8, strFromU8 } from '../../vendor/fflate.js';
import { DatasetBuilder } from '../core/model.js';
import { uid, normName, slug } from './common.js';
import { writeRoster, MERGE_RULES, listNames } from './roster.js';
import { writeEgoSession, newSession, tieList, varName } from './ego.js';
import { declareTieFields, cleanTieValues, describeTieValues } from './tiefields.js';

export const SURVEY_FORMAT = 'orgsignal-survey';
export const RESPONSE_FORMAT = 'orgsignal-response';
export const SHARE_VERSION = 1;
// Links longer than this are unreliable in email clients, chat apps and some
// browsers' address bars; past it the survey file is offered instead.
export const LINK_LIMIT = 8000;
export const FRAGMENT_KEY = 'survey';
const ARMOR_BEGIN = '-----BEGIN ORG SIGNAL RESPONSE-----';
const ARMOR_END = '-----END ORG SIGNAL RESPONSE-----';

// ---- encoding ------------------------------------------------------------------

// CRC-32 (IEEE), for the integrity checksum.
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(str) {
  const bytes = strToU8(str);
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

// JSON with object keys sorted, so the same content always hashes the same.
export function canonicalJSON(v) {
  if (Array.isArray(v)) return '[' + v.map(canonicalJSON).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonicalJSON(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}

function b64urlFromBytes(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function bytesFromB64url(s) {
  const t = String(s).replace(/[^A-Za-z0-9_-]/g, '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(t + '='.repeat((4 - (t.length % 4)) % 4));
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}
export function pack(obj) { return b64urlFromBytes(deflateSync(strToU8(JSON.stringify(obj)), { level: 9 })); }
export function unpack(text) {
  let bytes;
  try { bytes = inflateSync(bytesFromB64url(text)); } catch { throw new Error('The survey data is damaged or incomplete (it may have been cut off when the link was copied).'); }
  try { return JSON.parse(strFromU8(bytes)); } catch { throw new Error('The survey data is damaged.'); }
}

// ---- survey definitions ----------------------------------------------------------

export function surveyHash(def) {
  const { format, version, id, kind, title, intro, people, relations, combine, ego } = def;
  return crc32(canonicalJSON({ format, version, id, kind, title, intro, people, relations, combine, ego }));
}

const peopleOnly = people => (people || []).map(p => ({ id: String(p.id), label: String(p.label) }));

// A roster survey from the roster builder's model. Attribute columns are left
// out on purpose: respondents see names only, never the organizer's data.
export function surveyFromRoster(model, { title, intro = '', id, createdAt } = {}) {
  if (!model.people.length) throw new Error('Add the people on the roster first.');
  if (!model.relations.length) throw new Error('Add at least one relation first.');
  return {
    format: SURVEY_FORMAT, version: SHARE_VERSION,
    id: id || model.share?.id || uid('s'),
    kind: 'roster',
    title: String(title || model.name || 'Roster survey'),
    intro: String(intro || ''),
    createdAt: createdAt || model.share?.createdAt || new Date().toISOString(),
    people: peopleOnly(model.people),
    relations: model.relations.map(r => ({ id: r.id, name: r.name, question: r.question || '', scale: r.scale, max: r.max || 5, fields: (r.fields || []).map(f => ({ ...f })),
      ...(typeof r.weightField === 'string' ? { weightField: r.weightField } : {}) })),
    combine: MERGE_RULES.some(m => m.id === model.mergeRule) ? model.mergeRule : 'union',
  };
}

// An ego survey from an ego session's questions (none of its answers).
// roster: optional [{ id, label }]; then respondents pick themselves and the
// people they name from it, and the interviews can be stitched together.
export function surveyFromEgo(session, { title, intro = '', id, createdAt, roster = null, askTies = true, allowOthers = true } = {}) {
  if (!session.generators.length) throw new Error('Choose at least one question that asks for names first.');
  return {
    format: SURVEY_FORMAT, version: SHARE_VERSION,
    id: id || uid('s'),
    kind: 'ego',
    title: String(title || session.protocolName || 'Ego network survey'),
    intro: String(intro || ''),
    createdAt: createdAt || new Date().toISOString(),
    people: roster ? peopleOnly(roster) : [],
    ego: {
      generators: session.generators.map(g => ({ id: g.id, name: g.name, prompt: g.prompt || '', cap: g.cap })),
      interpreters: session.interpreters.map(i => { const o = { id: i.id, name: i.name, label: i.label, type: i.type }; if (i.options) o.options = i.options; return o; }),
      tieFields: (session.tieFields || []).map(f => ({ ...f })),
      askTies: !!askTies,
      allowOthers: roster ? !!allowOthers : true,
    },
  };
}

// Check a parsed definition; returns it (normalised) or throws with a reason.
export function validateSurvey(def) {
  if (!def || typeof def !== 'object' || def.format !== SURVEY_FORMAT) throw new Error('This is not an Org Signal survey.');
  if ((def.version ?? 1) > SHARE_VERSION) throw new Error('This survey was made by a newer version of Org Signal. Ask the organizer for a link from the current version.');
  if (!def.id || !['roster', 'ego'].includes(def.kind)) throw new Error('The survey is incomplete.');
  def.people = Array.isArray(def.people) ? def.people : [];
  if (def.kind === 'roster') {
    if (!def.people.length || !Array.isArray(def.relations) || !def.relations.length) throw new Error('The survey has no roster or no questions.');
    for (const r of def.relations) r.fields = Array.isArray(r.fields) ? r.fields : [];
  } else {
    if (!def.ego || !Array.isArray(def.ego.generators) || !def.ego.generators.length) throw new Error('The survey has no questions.');
    def.ego.interpreters = def.ego.interpreters || [];
    def.ego.tieFields = def.ego.tieFields || [];
  }
  return def;
}

// ---- links and survey files ------------------------------------------------------------

export function encodeSurvey(def) { return `${SHARE_VERSION}.${pack(def)}`; }

export function decodeSurvey(fragmentValue) {
  const m = /^(\d+)\.(.+)$/.exec(String(fragmentValue || '').trim());
  if (!m) throw new Error('The survey link is incomplete.');
  if (Number(m[1]) > SHARE_VERSION) throw new Error('This survey link was made by a newer version of Org Signal.');
  return validateSurvey(unpack(m[2]));
}

// The share link for a definition. base: the app's address (no fragment).
// Returns { url, length, tooLong }; tooLong means offer the survey file.
export function surveyLink(def, base) {
  const clean = String(base).replace(/#.*$/, '');
  const url = `${clean}#${FRAGMENT_KEY}=${encodeSurvey(def)}`;
  return { url, length: url.length, tooLong: url.length > LINK_LIMIT };
}

// The survey value from a location hash ('#survey=1.xxx'), or null.
export function surveyFromHash(hash) {
  const m = new RegExp(`^#?${FRAGMENT_KEY}=(.+)$`).exec(String(hash || ''));
  return m ? decodeURIComponent(m[1]) : null;
}

export function surveyFileText(def) { return JSON.stringify(def, null, 1); }

export function parseSurveyFile(text) {
  let o;
  try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch { throw new Error('This file is not an Org Signal survey file.'); }
  return validateSurvey(o);
}

export function fileStem(s) { return slug(s).slice(0, 40) || 'survey'; }

// ---- responses -------------------------------------------------------------------------

// answers: see the format above. respondent: { personId, label }.
export function makeResponse(def, respondent, answers, { now = Date.now() } = {}) {
  const label = String(respondent?.label || '').trim();
  if (!label) throw new Error('Say who you are first.');
  if (def.kind === 'roster' && !def.people.some(p => p.id === respondent.personId)) throw new Error('Choose your own name from the list first.');
  const r = {
    format: RESPONSE_FORMAT, version: SHARE_VERSION,
    survey: { id: def.id, kind: def.kind, title: def.title, hash: surveyHash(def) },
    respondent: { personId: respondent.personId || null, label },
    created: new Date(now).toISOString(),
    answers: def.kind === 'roster' ? cleanRosterAnswers(def, respondent.personId, answers) : cleanEgoAnswers(def, answers),
    definition: def,
  };
  r.checksum = 'crc32:' + crc32(canonicalJSON(r));
  return r;
}

function cleanRosterAnswers(def, me, answers) {
  const out = {};
  const ids = new Set(def.people.map(p => p.id));
  for (const rel of def.relations) {
    const a = answers?.[rel.id] || {};
    const o = {};
    for (const [pid, ans] of Object.entries(a)) {
      if (!ids.has(pid) || pid === me) continue;
      const v = Number(ans?.value);
      if (!(v > 0)) continue;
      const value = rel.scale === 'valued' ? Math.min(rel.max || 5, Math.round(v)) : 1;
      const fields = cleanTieValues(rel.fields, ans.fields);
      o[pid] = fields ? { value, fields } : { value };
    }
    out[rel.id] = o;
  }
  return out;
}

function cleanEgoAnswers(def, answers) {
  const gens = new Set(def.ego.generators.map(g => g.id));
  const roster = new Set(def.people.map(p => p.id));
  const alters = (answers?.alters || []).map(a => {
    const x = { id: String(a.id), label: String(a.label || '').trim(), generators: (a.generators || []).filter(g => gens.has(g)), attrs: { ...(a.attrs || {}) } };
    if (a.personId && roster.has(a.personId)) x.personId = a.personId;
    const tie = cleanTieValues(def.ego.tieFields, a.tie);
    if (tie) x.tie = tie;
    return x;
  }).filter(a => a.label && a.generators.length);
  const ids = new Set(alters.map(a => a.id));
  const contexts = (answers?.contexts || []).map(c => ({ name: String(c.name || ''), members: (c.members || []).filter(m => ids.has(m)) })).filter(c => c.name);
  const ties = {};
  for (const [k, v] of Object.entries(answers?.ties || {})) { const [a, b] = k.split('|'); if (ids.has(a) && ids.has(b) && a !== b) ties[k] = !!v; }
  return { alters, contexts, ties };
}

export function responseFileText(r) { return JSON.stringify(r, null, 1); }

// Named for the survey, the respondent and the time, so a second response
// from the same person sits beside the first instead of replacing it.
export function responseFileName(r) {
  const t = String(r.created || '').replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `${fileStem(r.survey.title)}-response-${fileStem(r.respondent.label)}${t ? '-' + t : ''}.json`;
}

// The response as a block of text that survives being pasted into an email.
// A readable account of the answers goes first, outside the block, so the
// respondent can see what they are sending (C17); readers ignore it.
export function responseToText(r) {
  const body = pack(r).match(/.{1,64}/g).join('\n');
  const said = responseSummary(r);
  return `${said.length ? `My answers to "${oneLine(r.survey.title)}":\n${said.map(l => `  ${l}`).join('\n')}\n\n` : ''}${ARMOR_BEGIN}\nSurvey: ${oneLine(r.survey.title)}\nRespondent: ${oneLine(r.respondent.label)}\n${body}\n${ARMOR_END}\n`;
}

// The answers in words, one line per question: "Friendship: Leo Park (Closeness 4); Sam Whitfield".
export function responseSummary(r) {
  const def = r.definition;
  if (!def) return [];
  const name = id => def.people?.find(p => p.id === id)?.label || id;
  if (def.kind === 'roster') {
    return (def.relations || []).map(rel => {
      const list = Object.entries(r.answers?.[rel.id] || {}).map(([pid, x]) => {
        const f = x.fields ? describeTieValues(rel.fields, cleanTieValues(rel.fields, x.fields)) : '';
        return `${name(pid)}${rel.scale === 'valued' ? ` ${x.value}` : ''}${f ? ` (${f})` : ''}`;
      });
      return `${rel.name}: ${list.length ? list.join('; ') : 'no one'}`;
    });
  }
  const al = r.answers?.alters || [];
  const out = (def.ego?.generators || []).map(g => `${g.name}: ${al.filter(a => a.generators.includes(g.id)).map(a => a.label).join('; ') || 'no one'}`);
  if (def.ego?.askTies) {
    const pairs = tieList(sessionFromResponse(def, r)).filter(p => p.on).map(p => `${al.find(a => a.id === p.a)?.label} and ${al.find(a => a.id === p.b)?.label}`);
    out.push(`Pairs who know each other: ${pairs.length ? pairs.join('; ') : 'none'}`);
  }
  return out;
}
const oneLine = s => String(s).replace(/[\r\n]+/g, ' ').slice(0, 120);

// Verify a parsed response: format and checksum. Returns { ok, reason }.
export function verifyResponse(r) {
  if (!r || typeof r !== 'object' || r.format !== RESPONSE_FORMAT) return { ok: false, reason: 'not an Org Signal response' };
  if ((r.version ?? 1) > SHARE_VERSION) return { ok: false, reason: 'made by a newer version of Org Signal' };
  if (!r.survey?.id || !r.respondent?.label || !r.answers) return { ok: false, reason: 'incomplete' };
  const { checksum, ...rest } = r;
  if (!checksum || checksum !== 'crc32:' + crc32(canonicalJSON(rest))) return { ok: false, reason: 'its checksum does not match (the file was changed or damaged)' };
  try { validateSurvey(structuredClone(r.definition)); } catch (e) { return { ok: false, reason: e.message }; }
  return { ok: true };
}

// Read every response (and survey file) in a text: a response JSON file, a
// survey JSON file, or any number of pasted text blocks (an email thread, a
// text file of pastes). Returns { responses: [{ response, ok, reason, file }], surveys: [def], errors: [] }.
export function parseResponses(text, { file = null } = {}) {
  const out = { responses: [], surveys: [], errors: [] };
  const t = String(text ?? '').replace(/^﻿/, '');
  const trimmed = t.trim();
  if (trimmed.startsWith('{')) {
    let o;
    try { o = JSON.parse(trimmed); } catch { out.errors.push({ file, reason: 'not valid JSON' }); return out; }
    if (o?.format === SURVEY_FORMAT) { try { out.surveys.push(validateSurvey(o)); } catch (e) { out.errors.push({ file, reason: e.message }); } return out; }
    const v = verifyResponse(o);
    out.responses.push({ response: o, ok: v.ok, reason: v.reason, file });
    return out;
  }
  const re = new RegExp(`${escapeRe(ARMOR_BEGIN)}([\\s\\S]*?)${escapeRe(ARMOR_END)}`, 'g');
  let m, k = 0;
  while ((m = re.exec(t))) {
    k++;
    // Email clients quote with '> ' and may wrap; keep only the data lines.
    const lines = m[1].split(/\r?\n/).map(l => l.replace(/^[>\s]+/, '').trim()).filter(l => l && !/^[A-Za-z][\w ]*:\s/.test(l));
    try {
      const o = unpack(lines.join(''));
      const v = verifyResponse(o);
      out.responses.push({ response: o, ok: v.ok, reason: v.reason, file: file ? `${file} (block ${k})` : `pasted block ${k}` });
    } catch (e) {
      out.errors.push({ file: file ? `${file} (block ${k})` : `pasted block ${k}`, reason: 'the text block is incomplete or damaged' });
    }
  }
  if (!k && trimmed) out.errors.push({ file, reason: 'no Org Signal response found' });
  return out;
}
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Cheap check for detect(): does this text start like a response or survey file?
export function sniffShared(head) {
  const h = String(head || '');
  if (h.includes(ARMOR_BEGIN)) return 'response';
  if (/"format"\s*:\s*"orgsignal-response"/.test(h)) return 'response';
  if (/"format"\s*:\s*"orgsignal-survey"/.test(h)) return 'survey';
  return null;
}

// ---- recombining ------------------------------------------------------------------------

// items: [{ response, ok, reason, file }] from parseResponses (any number of files).
// opts.survey: the organizer's own definition (the builder's), the reference;
//   otherwise a survey file among the inputs, else the survey most responses answered.
// Returns {
//   survey,                       the reference definition (the latest version answered)
//   accepted: [response],         one per respondent, the latest
//   duplicates: [{ label, used, dropped: [created] }],
//   rejected: [{ file, label, title, id }],   answered a different survey
//   invalid: [{ file, reason }],              unreadable or failed the checksum
//   earlier: n,                   answered an earlier version of this survey (same id)
//   responded: [label], missing: [label] (roster people with no response) }
export function recombine(items, { survey = null, surveys = [] } = {}) {
  const invalid = items.filter(x => !x.ok).map(x => ({ file: x.file, reason: x.reason }));
  const good = items.filter(x => x.ok).map(x => ({ ...x }));
  let ref = survey || surveys[0] || null;
  if (!ref) {
    const counts = new Map();
    for (const x of good) {
      const c = counts.get(x.response.survey.id) || { n: 0, last: '' , def: null };
      c.n++;
      if (x.response.created >= c.last) { c.last = x.response.created; c.def = x.response.definition; }
      counts.set(x.response.survey.id, c);
    }
    const best = [...counts.values()].sort((a, b) => b.n - a.n || (b.last > a.last ? 1 : -1))[0];
    ref = best?.def || null;
  }
  if (!ref) return { survey: null, accepted: [], duplicates: [], rejected: [], invalid, earlier: 0, responded: [], missing: [] };
  const rejected = [];
  const mine = [];
  for (const x of good) {
    if (x.response.survey.id === ref.id) mine.push(x);
    else rejected.push({ file: x.file, label: x.response.respondent.label, title: x.response.survey.title, id: x.response.survey.id });
  }
  // Without the organizer's definition, use the version the most recent
  // response answered: it has the roster and questions as they stood last.
  if (!survey && !surveys.length) {
    let last = '';
    for (const x of mine) if (x.response.created >= last) { last = x.response.created; ref = x.response.definition; }
  }
  const refHash = surveyHash(ref);
  const byId = new Map(ref.people.map(p => [p.id, p]));
  const byName = new Map(ref.people.map(p => [normName(p.label), p]));
  // Who is this respondent: roster id, else roster name, else their own label.
  const who = r => {
    const p = (r.respondent.personId && byId.get(r.respondent.personId)) || byName.get(normName(r.respondent.label));
    return p ? { key: 'p:' + p.id, personId: p.id, label: p.label } : { key: 'n:' + normName(r.respondent.label), personId: null, label: r.respondent.label };
  };
  const latest = new Map();
  const dups = new Map();
  for (const x of mine) {
    const w = who(x.response);
    const cur = latest.get(w.key);
    if (cur) {
      const [keep, drop] = x.response.created > cur.x.response.created ? [x, cur.x] : [cur.x, x];
      latest.set(w.key, { w, x: keep });
      const d = dups.get(w.key) || { label: w.label, used: null, dropped: [] };
      d.dropped.push(drop.response.created);
      d.used = keep.response.created;
      dups.set(w.key, d);
    } else latest.set(w.key, { w, x });
  }
  const accepted = [...latest.values()].map(({ w, x }) => ({ ...x.response, _who: w, _file: x.file }));
  const earlier = accepted.filter(r => r.survey.hash !== refHash).length;
  const responded = accepted.map(r => r._who.label);
  const respondedIds = new Set(accepted.map(r => r._who.personId).filter(Boolean));
  const missing = ref.people.filter(p => !respondedIds.has(p.id)).map(p => p.label);
  return { survey: ref, accepted, duplicates: [...dups.values()], rejected, invalid, earlier, responded, missing };
}

// Accepted roster responses -> respondents in the roster builder's shape.
export function rosterRespondents(result) {
  const def = result.survey;
  return result.accepted.filter(r => r._who.personId).map(r => {
    const me = r._who.personId;
    const ties = {}, attrs = {};
    for (const rel of def.relations) {
      ties[rel.id] = {}; attrs[rel.id] = {};
      for (const [pid, ans] of Object.entries(r.answers?.[rel.id] || {})) {
        if (pid === me || !def.people.some(p => p.id === pid)) continue;
        const k = `${me}|${pid}`;
        ties[rel.id][k] = Number(ans.value) || 1;
        const f = cleanTieValues(rel.fields, ans.fields);
        if (f) attrs[rel.id][k] = f;
      }
    }
    return { personId: me, label: r._who.label, ties, attrs };
  });
}

// The plain-language account of a recombination, one line each, for the
// builder and for the import report.
export function recombineNotes(result) {
  const notes = [];
  const def = result.survey;
  if (!def) return notes;
  const N = def.people.length;
  notes.push({ code: 'survey-responded', level: 'info', count: result.responded.length,
    text: N ? `${result.responded.length} of ${N} people responded: ${listNames(result.responded)}.` : `${result.responded.length} people responded: ${listNames(result.responded)}.` });
  if (N && result.missing.length) notes.push({ code: 'survey-nonrespondents', level: 'info', count: result.missing.length, text: `No response from ${listNames(result.missing)}. They can still be named by others.` });
  for (const d of result.duplicates) notes.push({ code: 'survey-duplicates', level: 'warn', count: d.dropped.length, text: `${d.label} sent ${d.dropped.length + 1} responses; the latest (${fmtTime(d.used)}) is used and ${d.dropped.length === 1 ? 'the earlier one is' : 'the earlier ones are'} ignored.` });
  if (result.rejected.length) {
    const titles = [...new Set(result.rejected.map(r => `"${r.title}"`))].join(', ');
    notes.push({ code: 'survey-other-survey', level: 'warn', count: result.rejected.length,
      text: `${result.rejected.length} ${result.rejected.length === 1 ? 'response answers' : 'responses answer'} a different survey (${titles}) and ${result.rejected.length === 1 ? 'was' : 'were'} not used: ${listNames(result.rejected.map(r => `${r.label}${r.file ? ` (${r.file})` : ''}`), 6)}. Import ${result.rejected.length === 1 ? 'it' : 'them'} on ${result.rejected.length === 1 ? 'its' : 'their'} own.` });
  }
  for (const x of result.invalid) notes.push({ code: 'survey-invalid', level: 'error', count: 1, text: `${x.file || 'A response'} could not be used: ${x.reason}.` });
  if (result.earlier) notes.push({ code: 'survey-earlier-version', level: 'info', count: result.earlier, text: `${result.earlier} ${result.earlier === 1 ? 'response answers' : 'responses answer'} an earlier version of this survey (the roster or questions changed since). Answers are matched by person and question, so they still count.` });
  return notes;
}
// In the reader's own time zone (C16), "3 Oct 2026, 14:26".
const fmtTime = iso => { const d = new Date(iso); return Number.isNaN(+d) ? String(iso) : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); };

// ---- dataset from a recombination ---------------------------------------------------------

// Write the recombined network into a builder. Roster surveys go through the
// roster builder's writer with its merge rules; ego surveys are stitched into
// one bounded network when they were run against a roster, else written as
// one ego network per respondent. opts: { mergeRule, people (organizer's
// roster with attributes), name }.
export function writeRecombined(b, result, { mergeRule = null, people = null, fileNames = [] } = {}) {
  const def = result.survey;
  if (!def) throw new Error('No usable responses.');
  const notes = recombineNotes(result);
  const surveyInfo = { id: def.id, title: def.title, kind: def.kind, responded: result.responded, missing: result.missing,
    duplicates: result.duplicates.map(d => d.label), rejected: result.rejected.length, invalid: result.invalid.length };
  const warnAll = () => { for (const n of notes) { b.warn(n.code, n.text, n.count || 1); if (n.level === 'error' || n.level === 'info') b.source.warnings.find(w => w.code === n.code).severity = n.level; } };
  if (def.kind === 'roster') {
    const attrs = new Map((people || []).map(p => [p.id, p]));
    const model = {
      name: def.title,
      people: def.people.map(p => ({ id: p.id, label: attrs.get(p.id)?.label || p.label, attrs: attrs.get(p.id)?.attrs || {} })),
      attrColumns: [],
      relations: def.relations,
      mode: 'multi', ties: {}, tieAttrs: {},
      responses: { respondents: rosterRespondents(result), file: null },
      mergeRule: mergeRule || def.combine || 'union',
    };
    writeRoster(b, model, { source: { format: 'shared-survey', fileNames, survey: surveyInfo } });
    // The roster writer's own non-respondent line is replaced by the fuller notes.
    b.source.warnings = b.source.warnings.filter(w => w.code !== 'roster-nonrespondents');
    const rule = MERGE_RULES.find(m => m.id === model.mergeRule);
    b.warn('combine-rule', `Combined with ${rule.label}: ${rule.help}`);
    warnAll();
    return;
  }
  if (!def.people.length) {
    // Plain ego interviews: one ego network per respondent.
    let first = true;
    for (const r of result.accepted) {
      const s = sessionFromResponse(def, r);
      writeEgoSession(b, s, { source: { format: 'shared-survey', fileNames: r._file ? [r._file] : [], survey: surveyInfo, title: r._who.label } });
      if (first) { warnAll(); first = false; }
    }
    if (first) { b.beginSource({ format: 'shared-survey', family: 'survey', medium: 'survey', view: 'ego', context: 'survey', fileNames, survey: surveyInfo }); warnAll(); }
    return;
  }
  stitchEgo(b, result, { people, fileNames, surveyInfo, warnAll });
}

export function recombinedDataset(result, opts = {}) {
  const b = new DatasetBuilder({ name: opts.name || result.survey?.title || 'Survey responses' });
  writeRecombined(b, result, opts);
  return b.build();
}

// An ego response as an ego session (for writeEgoSession and for review).
export function sessionFromResponse(def, r) {
  const s = newSession({ egoLabel: r._who?.label || r.respondent.label, protocolName: def.title, now: Date.parse(r.created) || Date.now() });
  s.id = `${def.id}:${r._who?.key || r.respondent.label}`;
  // A stable ego id per respondent, so re-importing gives the same node keys.
  s.egoId = 'r' + crc32(`${def.id}|${r._who?.key || normName(r.respondent.label)}`);
  s.generators = def.ego.generators.map(g => ({ ...g }));
  s.interpreters = def.ego.interpreters.map(i => ({ ...i }));
  s.tieFields = def.ego.tieFields.map(f => ({ ...f }));
  s.alters = r.answers.alters.map(a => ({ id: a.id, uuid: 'u' + crc32(`${s.egoId}|${a.id}`), label: a.label, generators: [...a.generators], attrs: { ...a.attrs }, tie: a.tie ? { ...a.tie } : undefined, personId: a.personId }));
  s.contexts = r.answers.contexts.map((c, i) => ({ id: `c${i}`, name: c.name, members: [...c.members] }));
  s.ties = { ...r.answers.ties };
  s.finishedAt = r.created;
  s.step = 'review';
  return s;
}

// Interpreter answers become tie fields in a stitched network: they are one
// respondent's view of one person, so they belong on that respondent's tie,
// not on the person (several respondents may describe the same person).
function interpreterFields(def) {
  return def.ego.interpreters.map(i => {
    const f = { key: i.name, label: i.label, type: i.type === 'number' ? 'number' : i.type === 'text' || i.type === 'date' ? 'text' : 'choice' };
    if (f.type === 'choice') { f.options = (i.options || []).map(o => o.label); if (i.type === 'ordinal') f.ordered = true; if (i.type === 'boolean') f.options = ['Yes', 'No']; }
    return f;
  });
}
function interpreterValue(i, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (i.type === 'number') { const n = Number(raw); return Number.isFinite(n) ? n : undefined; }
  if (i.type === 'boolean') return /^(true|yes|1)$/i.test(String(raw)) ? 'Yes' : 'No';
  if (i.type === 'categorical' || i.type === 'ordinal') return (i.options || []).find(o => String(o.value) === String(raw))?.label ?? String(raw);
  return String(raw);
}

export const REPORT_FIELD = { key: 'report', label: 'Reported as', type: 'choice', options: ['own', 'perceived'] };

// Ego interviews against a roster -> one bounded network. Every roster
// person is a node (roster:<slug>, the roster builder's keys, so this merges
// with a roster survey of the same people). Ego's ties run from the
// respondent to each person named, in one context per question, with the tie
// fields and interpreter answers on the event and report = 'own'. The pairs a
// respondent says know each other are perceived ties, undirected, in a
// context of their own per respondent, with report = 'perceived' and
// perceived_by. They are a separate relation, left out by default
// (source.defaultTieFilters keeps "Reported as: own"), because guesses about
// who knows whom are not friendship nominations (C2); the construction
// settings' Reported as filter brings them in.
function stitchEgo(b, result, { people, fileNames, surveyInfo, warnAll }) {
  const def = result.survey;
  const attrsById = new Map((people || []).map(p => [p.id, p.attrs || {}]));
  const ifields = interpreterFields(def);
  const tieDefs = [REPORT_FIELD, ...declareTieFields(def.ego.tieFields), ...ifields];
  const ownOnly = def.ego.askTies ? [{ key: 'report', values: ['own'] }] : [];
  b.beginSource({ format: 'shared-survey', family: 'survey', medium: 'survey', view: 'full', context: 'survey', directed: true,
    fileNames, survey: surveyInfo, title: 'Own ties', tieFields: tieDefs, stitched: true, defaultTieFilters: ownOnly });
  warnAll();
  const keyOf = new Map(), used = new Set();
  const responded = new Set(result.accepted.map(r => r._who.personId).filter(Boolean));
  for (const p of def.people) {
    let k = 'roster:' + slug(p.label);
    while (used.has(k)) k += '_';
    used.add(k); keyOf.set(p.id, k);
    b.node(k, { label: p.label, attrs: { ...attrsById.get(p.id), responded: responded.has(p.id) } });
  }
  const members = def.people.map(p => b.nodeIndex(keyOf.get(p.id)));
  const genCtx = new Map(def.ego.generators.map(g => [g.id, b.context(`survey:${def.id}:gen:${slug(g.name)}`, { name: g.name, kind: 'survey', visibility: 'private', medium: 'survey', members })]));
  let offList = 0;
  const perceived = [];
  for (const r of result.accepted) {
    const t = Date.parse(r.created);
    const egoKey = r._who.personId ? keyOf.get(r._who.personId) : `ego:${def.id}:${slug(r._who.label)}`;
    const ego = b.node(egoKey, { label: r._who.label, attrs: r._who.personId ? undefined : { responded: true, offRoster: true } });
    const idx = new Map();
    for (const a of r.answers.alters) {
      let i;
      if (a.personId && keyOf.has(a.personId)) i = b.nodeIndex(keyOf.get(a.personId));
      else { i = b.node(`alter:${def.id}:${slug(r._who.label)}:${slug(a.label)}`, { label: a.label, attrs: { offRoster: true, namedBy: r._who.label } }); offList++; }
      if (i === ego) continue;
      idx.set(a.id, i);
      const at = { report: 'own', ...(cleanTieValues(def.ego.tieFields, a.tie) || {}) };
      for (const it of def.ego.interpreters) { const v = interpreterValue(it, a.attrs?.[it.name]); if (v !== undefined) at[it.name] = v; }
      // One event per question, sharing one tie's weight (as writeEgoSession).
      const gens = a.generators.filter(g => genCtx.has(g));
      for (const g of gens) {
        b.event({ type: 'declared', t, actor: ego, targets: [[i, 'declared']], context: genCtx.get(g), weight: 1 / gens.length, attrs: at });
        b.stat('own ties');
      }
    }
    if (def.ego.askTies) perceived.push({ r, idx, t });
  }
  if (offList) b.warn('survey-off-roster', 'People named who are not on the roster (kept as their own nodes, named by one respondent each)', offList);
  if (!perceived.length) return;
  b.beginSource({ format: 'shared-survey', family: 'survey', medium: 'survey', view: 'full', context: 'survey', directed: false,
    fileNames, survey: surveyInfo, title: 'Perceived ties', perceived: true, defaultTieFilters: ownOnly,
    tieFields: [REPORT_FIELD, { key: 'perceived_by', label: 'Perceived by', type: 'choice', options: perceived.map(p => p.r._who.label) }] });
  b.warn('survey-perceived', 'Each respondent also said which of the people they named know each other. Those answers are guesses about other people\'s ties, so they are kept as a separate relation and left out of the network by default. To include them, tick "perceived" under Reported as in the construction settings.', perceived.length);
  b.source.warnings[b.source.warnings.length - 1].severity = 'info';
  for (const { r, idx, t } of perceived) {
    const s = sessionFromResponse(def, r);
    const ctx = b.context(`survey:${def.id}:perceived:${slug(r._who.label)}`, { name: `Perceived by ${r._who.label}`, kind: 'survey', visibility: 'private', medium: 'survey' });
    for (const p of tieList(s)) {
      if (!p.on) continue;
      const x = idx.get(p.a), y = idx.get(p.b);
      if (x === undefined || y === undefined || x === y) continue;
      b.event({ type: 'declared', t, actor: x, targets: [[y, 'declared']], context: ctx, weight: 1, attrs: { report: 'perceived', perceived_by: r._who.label } });
      b.stat('perceived ties');
    }
  }
}

// Respondent ego answers from an ego session the respondent filled in.
export function egoAnswers(session) {
  return {
    alters: session.alters.map(a => ({ id: a.id, label: a.label, personId: a.personId, generators: a.generators, attrs: a.attrs, tie: a.tie })),
    contexts: session.contexts.map(c => ({ name: c.name, members: c.members })),
    ties: session.ties,
  };
}

// A blank ego session for a respondent, from an ego survey.
export function respondentSession(def, { label = '', personId = null } = {}) {
  const s = newSession({ egoLabel: label, protocolName: def.title });
  s.generators = def.ego.generators.map(g => ({ ...g }));
  s.interpreters = def.ego.interpreters.map(i => ({ ...i, name: i.name || varName(i.label) }));
  s.tieFields = def.ego.tieFields.map(f => ({ ...f }));
  if (personId) s.egoPersonId = personId;
  s.step = 'names';
  return s;
}
