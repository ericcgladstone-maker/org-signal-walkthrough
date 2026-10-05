// Ego network interview: the session model behind the Ego builder.
//
// A session is one respondent (ego) answering:
//   name generators   questions that elicit names ("who do you discuss important matters with?")
//   name interpreters questions about each named person (alter): closeness, relationship ...
//   alter-alter ties  which of the named people know each other, as ego perceives it
//
// Alter-alter ties are collected in two passes because asking k(k-1)/2 pair
// questions is the slowest part of any ego interview: ego first sorts alters
// into the settings they come from (work, family ...), everyone sharing a
// setting is assumed to know each other, and ego then fixes the exceptions.
// The session stores only those exceptions (ties: 'a|b' -> true|false), so
// moving someone between contexts updates the implied ties without losing
// the explicit corrections.
//
// Tie fields (src/builders/tiefields.js) describe the ego->alter tie itself
// (type, strength, how often) rather than the person; they are stored per
// alter in alter.tie and written as event attributes on ego's ties. When the
// interview runs against a roster, alters carry the roster person's id
// (alter.personId) so many respondents' interviews can be stitched together.
//
// Pure functions; sessions are plain JSON. Every mutating function returns a
// new session (shallow copies) so the UI can use it directly as state.

import { DatasetBuilder } from '../core/model.js';
import { parseCSV, rowsToObjects } from '../importers/tabular.js';
import { uid, uuid, slug, normName, toCSV, coerce } from './common.js';
import { makeTieField, updateTieField as updateField, cleanTieValues, declareTieFields } from './tiefields.js';

export const SESSION_VERSION = 1;

// ---- presets ---------------------------------------------------------------

// The GSS 1985 "important matters" item (Burt 1984), the most used name
// generator in the literature. The GSS recorded up to five names, so 5 is the
// default cap; it can be raised, and caps are known to truncate network size.
export const GENERATOR_PRESETS = [
  { id: 'discuss', name: 'Important matters', cap: 5,
    prompt: 'From time to time, most people discuss important matters with other people. Looking back over the last six months, who are the people with whom you discussed matters important to you?' },
  { id: 'advice', name: 'Advice', cap: 10,
    prompt: 'Who do you go to for advice when you have a problem or a decision to make?' },
  { id: 'social', name: 'Socializing', cap: 10,
    prompt: 'Who do you spend free time with, for example getting together for a meal, going out, or visiting each other?' },
  { id: 'support', name: 'Support', cap: 10,
    prompt: 'If you needed help, such as a loan, a ride, or care when you were ill, who would you ask?' },
  { id: 'work', name: 'Work', cap: 15,
    prompt: 'Who do you work with most closely, inside or outside your organization?' },
];

const opts = list => list.map(([value, label]) => ({ value, label }));

export const INTERPRETER_PRESETS = [
  { id: 'relationship', name: 'relationship', label: 'Relationship type', type: 'categorical',
    options: opts([['partner', 'Partner or spouse'], ['family', 'Family'], ['friend', 'Friend'], ['coworker', 'Coworker'],
      ['neighbor', 'Neighbor'], ['group', 'Group member'], ['adviser', 'Adviser'], ['other', 'Other']]) },
  { id: 'closeness', name: 'closeness', label: 'Closeness (1 to 5)', type: 'ordinal',
    options: opts([['1', '1 Distant'], ['2', '2'], ['3', '3'], ['4', '4'], ['5', '5 Very close']]) },
  { id: 'contact_freq', name: 'contact_freq', label: 'Contact frequency', type: 'ordinal',
    options: opts([['5', 'Daily'], ['4', 'Weekly'], ['3', 'Monthly'], ['2', 'Less than monthly'], ['1', 'Yearly or less']]) },
  { id: 'how_met', name: 'how_met', label: 'How met', type: 'categorical',
    options: opts([['family', 'Family'], ['school', 'School'], ['work', 'Work'], ['neighborhood', 'Neighborhood'],
      ['organization', 'Club or organization'], ['online', 'Online'], ['friend', 'Through a friend'], ['other', 'Other']]) },
  { id: 'years_known', name: 'years_known', label: 'Years known', type: 'number' },
  { id: 'age_band', name: 'age_band', label: 'Age band', type: 'ordinal',
    options: opts([['1', 'Under 18'], ['2', '18 to 29'], ['3', '30 to 44'], ['4', '45 to 64'], ['5', '65 or older']]) },
  { id: 'location', name: 'location', label: 'Location', type: 'categorical',
    options: opts([['household', 'Same household'], ['walking', 'Walking distance'], ['city', 'Same city'],
      ['region', 'Same region'], ['farther', 'Farther']]) },
];

export const CONTEXT_PRESETS = ['Work', 'Family', 'School', 'Neighborhood', 'Other'];

// Plain titles first, the field's terms in parentheses (L12).
export const STEPS = [
  { id: 'generators', label: 'Who comes to mind (name generators)', short: 'Who comes to mind' },
  { id: 'interpreters', label: 'About each person (name interpreters)', short: 'About each person' },
  { id: 'names', label: 'Collect names' },
  { id: 'describe', label: 'Describe' },
  { id: 'ties', label: 'Who knows whom' },
  { id: 'review', label: 'Review and export' },
];

// ---- session ---------------------------------------------------------------

export function newSession({ caseId = '', egoLabel = '', protocolName = 'Org Signal ego interview', now = Date.now() } = {}) {
  return {
    version: SESSION_VERSION,
    id: uuid(),
    egoId: uuid(),
    caseId,
    protocolName,
    egoLabel,
    egoAttrs: {},
    startedAt: new Date(now).toISOString(),
    finishedAt: null,
    generators: [],
    interpreters: [],
    tieFields: [],
    alters: [],
    contexts: [],
    ties: {},
    weightBy: null, // interpreter name whose value weights ego->alter ties; null = 1
    step: 'generators',
  };
}

const set = (s, patch) => ({ ...s, ...patch });

export function addGenerator(s, g) {
  const preset = GENERATOR_PRESETS.find(p => p.id === g.preset);
  const base = preset ? { ...preset } : { name: 'Custom question', prompt: '', cap: 10 };
  const gen = { ...base, ...g, id: g.id || (preset && !s.generators.some(x => x.id === preset.id) ? preset.id : uid('g')) };
  delete gen.preset;
  gen.cap = clampCap(Number(gen.cap) || 10);
  return set(s, { generators: [...s.generators, gen] });
}

// Most names one question takes: 1 to MAX_CAP. A typo such as 510 is not a
// limit anyone means, and a long list stalls the who-knows-whom step
// (MAX_CAP people make 4,950 pairs).
export const MAX_CAP = 100;
export const clampCap = v => Math.min(MAX_CAP, Math.max(1, Math.floor(Number(v) || 1)));

export function updateGenerator(s, id, patch) {
  const p = 'cap' in patch ? { ...patch, cap: clampCap(patch.cap) } : patch;
  return set(s, { generators: s.generators.map(g => (g.id === id ? { ...g, ...p } : g)) });
}

// Removing a generator drops it from every alter; alters elicited by no
// remaining generator are removed too (they were never named under any question).
export function removeGenerator(s, id) {
  const alters = s.alters.map(a => ({ ...a, generators: a.generators.filter(g => g !== id) }));
  const keep = alters.filter(a => a.generators.length);
  const gone = new Set(alters.filter(a => !a.generators.length).map(a => a.id));
  let t = set(s, { generators: s.generators.filter(g => g.id !== id), alters: keep });
  for (const a of gone) t = scrubAlter(t, a);
  return t;
}

// Variable names follow Network Canvas: word characters only, so they work as
// CSV column names and R/Stata variable names.
export function varName(s) {
  const v = String(s || '').trim().replace(/\W+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return /^\d/.test(v) ? 'v_' + v : v || 'var';
}

export function addInterpreter(s, it) {
  const preset = INTERPRETER_PRESETS.find(p => p.id === it.preset);
  const base = preset ? structuredClone(preset) : { label: 'Custom question', type: 'text' };
  const out = { ...base, ...it };
  delete out.preset;
  const taken = new Set(s.interpreters.map(x => x.name));
  let name = varName(out.name || out.label);
  for (let i = 2; taken.has(name); i++) name = `${varName(out.name || out.label)}_${i}`;
  out.name = name;
  out.id = it.id || (preset && !s.interpreters.some(x => x.id === preset.id) ? preset.id : uid('i'));
  if ((out.type === 'categorical' || out.type === 'ordinal') && !out.options) out.options = [];
  return set(s, { interpreters: [...s.interpreters, out] });
}

export function updateInterpreter(s, id, patch) {
  const p = { ...patch };
  if (p.name !== undefined) p.name = varName(p.name);
  return set(s, { interpreters: s.interpreters.map(i => (i.id === id ? { ...i, ...p } : i)) });
}

export function removeInterpreter(s, id) {
  const it = s.interpreters.find(i => i.id === id);
  if (!it) return s;
  const alters = s.alters.map(a => { const attrs = { ...a.attrs }; delete attrs[it.name]; return { ...a, attrs }; });
  return set(s, { interpreters: s.interpreters.filter(i => i.id !== id), alters });
}

// ---- tie fields on ego's ties ------------------------------------------------

export function addTieField(s, def) {
  const f = makeTieField(def, [...(s.tieFields || []).map(x => x.key), ...s.interpreters.map(i => i.name)]);
  return set(s, { tieFields: [...(s.tieFields || []), f] });
}

export function updateTieField(s, id, patch) {
  return set(s, { tieFields: (s.tieFields || []).map(f => (f.id === id ? updateField(f, patch) : f)) });
}

export function removeTieField(s, id) {
  const f = (s.tieFields || []).find(x => x.id === id);
  if (!f) return s;
  const alters = s.alters.map(a => { if (!a.tie || !(f.key in a.tie)) return a; const tie = { ...a.tie }; delete tie[f.key]; return { ...a, tie }; });
  return set(s, { tieFields: s.tieFields.filter(x => x.id !== id), alters });
}

// Stored as entered (like interpreter answers); typed on export.
export function setTieValue(s, alterId, key, value) {
  return set(s, {
    alters: s.alters.map(a => {
      if (a.id !== alterId) return a;
      const tie = { ...(a.tie || {}) };
      if (value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length)) delete tie[key]; else tie[key] = value;
      return { ...a, tie };
    }),
  });
}

export function generatorCount(s, genId) {
  return s.alters.filter(a => a.generators.includes(genId)).length;
}

// Add a name under a generator. Names are deduplicated across generators by
// normalised spelling: naming "Ana Ruiz" under Advice after naming her under
// Important matters records Advice on the same alter rather than creating a
// second person. Returns { session, alter, status } where status is
//   'added' | 'duplicate-other' (existing alter, generator recorded)
//   | 'duplicate-same' (already named here) | 'cap' (generator full) | 'empty'
//
// opts.personId: a roster person's id when names are picked from a roster;
// the same person is then recognised by id whatever the spelling.
// opts.alterId: name an existing alter under this generator too (the
// one-click "already mentioned" toggles and the "Same person" merge).
export function addAlter(s, name, genId, { personId = null, alterId = null } = {}) {
  const byId = alterId ? s.alters.find(a => a.id === alterId) : null;
  const label = String(byId?.label ?? name ?? '').trim().replace(/\s+/g, ' ');
  if (!label) return { session: s, alter: null, status: 'empty' };
  const gen = s.generators.find(g => g.id === genId);
  if (!gen) throw new Error(`Unknown name generator: ${genId}`);
  const key = normName(label);
  const existing = byId || (personId && s.alters.find(a => a.personId === personId)) || s.alters.find(a => normName(a.label) === key && (!personId || !a.personId));
  if (existing?.generators.includes(genId)) return { session: s, alter: existing, status: 'duplicate-same' };
  if (generatorCount(s, genId) >= gen.cap) return { session: s, alter: existing ?? null, status: 'cap' };
  if (existing) {
    const alter = { ...existing, generators: [...existing.generators, genId] };
    return { session: set(s, { alters: s.alters.map(a => (a.id === existing.id ? alter : a)) }), alter, status: 'duplicate-other' };
  }
  const alter = { id: uid('a'), uuid: uuid(), label, generators: [genId], attrs: {} };
  if (personId) alter.personId = personId;
  return { session: set(s, { alters: [...s.alters, alter] }), alter, status: 'added' };
}

// Two alters are one person (the respondent said "Jon" under one question
// and "Jonathan Reyes" under another). keepId survives with its label; it
// gains the other's generators, answers it lacks, settings and pair
// exceptions. Returns the new session.
export function mergeAlters(s, keepId, dropId) {
  if (keepId === dropId) return s;
  const keep = s.alters.find(a => a.id === keepId), drop = s.alters.find(a => a.id === dropId);
  if (!keep || !drop) return s;
  const merged = {
    ...keep,
    generators: [...new Set([...keep.generators, ...drop.generators])],
    attrs: { ...drop.attrs, ...keep.attrs },
    tie: { ...(drop.tie || {}), ...(keep.tie || {}) },
  };
  if (!merged.personId && drop.personId) merged.personId = drop.personId;
  const contexts = s.contexts.map(c => {
    if (!c.members.includes(dropId)) return c;
    const members = c.members.filter(m => m !== dropId);
    if (!members.includes(keepId)) members.push(keepId);
    return { ...c, members };
  });
  const ties = {};
  for (const [k, v] of Object.entries(s.ties)) {
    const [a, b] = k.split('|');
    const a2 = a === dropId ? keepId : a, b2 = b === dropId ? keepId : b;
    if (a2 === b2) continue;
    const k2 = pairKey(a2, b2);
    if (!(k2 in ties) || k2 === k) ties[k2] = v;
  }
  return set(s, { alters: s.alters.filter(a => a.id !== dropId).map(a => (a.id === keepId ? merged : a)), contexts, ties });
}

// Drop the alter from one generator only (or entirely when genId is omitted
// or it was its last generator).
export function removeAlter(s, alterId, genId) {
  const a = s.alters.find(x => x.id === alterId);
  if (!a) return s;
  if (genId && a.generators.length > 1) {
    return set(s, { alters: s.alters.map(x => (x.id === alterId ? { ...x, generators: x.generators.filter(g => g !== genId) } : x)) });
  }
  return scrubAlter(set(s, { alters: s.alters.filter(x => x.id !== alterId) }), alterId);
}

function scrubAlter(s, alterId) {
  const contexts = s.contexts.map(c => ({ ...c, members: c.members.filter(m => m !== alterId) }));
  const ties = {};
  for (const [k, v] of Object.entries(s.ties)) if (!k.split('|').includes(alterId)) ties[k] = v;
  return set(s, { contexts, ties });
}

export function renameAlter(s, alterId, label) {
  return set(s, { alters: s.alters.map(a => (a.id === alterId ? { ...a, label: String(label).trim() || a.label } : a)) });
}

// Store an interpreter answer as typed by the user (string); typing is applied
// on export so a half-typed number is not lost.
export function setInterpreter(s, alterId, name, value) {
  return set(s, {
    alters: s.alters.map(a => {
      if (a.id !== alterId) return a;
      const attrs = { ...a.attrs };
      if (value === '' || value === null || value === undefined) delete attrs[name]; else attrs[name] = value;
      return { ...a, attrs };
    }),
  });
}

// ---- contexts and alter-alter ties -----------------------------------------

// A new setting starts with the people whose answers already place them in
// it: How met "School" puts them in School, relationship "Coworker" in Work,
// and so on (pass { fromAnswers: false } for an empty one).
export function addContext(s, name, { fromAnswers = true } = {}) {
  const n = String(name || '').trim() || `Context ${s.contexts.length + 1}`;
  const members = fromAnswers ? suggestedMembers(s, n) : [];
  return set(s, { contexts: [...s.contexts, { id: uid('c'), name: n, members }] });
}

// Answer values that also mean a setting, beyond the setting's own name.
const SETTING_WORDS = {
  work: ['work', 'coworker', 'colleague', 'job'],
  family: ['family', 'partner', 'spouse', 'relative'],
  school: ['school', 'classmate', 'university', 'college'],
  neighborhood: ['neighborhood', 'neighbourhood', 'neighbor', 'neighbour'],
};

// Alters whose categorical answers (value or option label) name the setting.
export function suggestedMembers(s, name) {
  const key = normName(name);
  const words = new Set([key, ...(SETTING_WORDS[key] || [])]);
  if (key === 'other') return [];
  const out = [];
  for (const a of s.alters) {
    const hit = s.interpreters.some(it => {
      if (it.type !== 'categorical') return false;
      const v = a.attrs[it.name];
      if (v === undefined || v === '') return false;
      const opt = (it.options || []).find(o => String(o.value) === String(v));
      return words.has(normName(v)) || (opt && words.has(normName(opt.label)));
    });
    if (hit) out.push(a.id);
  }
  return out;
}

export function renameContext(s, id, name) {
  return set(s, { contexts: s.contexts.map(c => (c.id === id ? { ...c, name } : c)) });
}

export function removeContext(s, id) {
  return set(s, { contexts: s.contexts.filter(c => c.id !== id) });
}

// An alter may belong to several contexts (a coworker who is also a neighbor).
export function assignContext(s, alterId, contextId, on = true) {
  return set(s, {
    contexts: s.contexts.map(c => {
      if (c.id !== contextId) return c;
      const has = c.members.includes(alterId);
      if (on && !has) return { ...c, members: [...c.members, alterId] };
      if (!on && has) return { ...c, members: c.members.filter(m => m !== alterId) };
      return c;
    }),
  });
}

export function pairKey(a, b) { return a < b ? `${a}|${b}` : `${b}|${a}`; }

// Pairs assumed to know each other because they share a context.
export function impliedTies(s) {
  const out = new Set();
  for (const c of s.contexts) {
    const m = c.members;
    for (let i = 0; i < m.length; i++) for (let j = i + 1; j < m.length; j++) out.add(pairKey(m[i], m[j]));
  }
  return out;
}

export function tie(s, a, b, implied = impliedTies(s)) {
  const k = pairKey(a, b);
  return k in s.ties ? s.ties[k] : implied.has(k);
}

// Flip a pair. If the result equals what the contexts imply, the override is
// dropped so the session holds only real exceptions.
export function toggleTie(s, a, b) {
  if (a === b) return s;
  const implied = impliedTies(s);
  const k = pairKey(a, b);
  const next = !tie(s, a, b, implied);
  const ties = { ...s.ties };
  if (next === implied.has(k)) delete ties[k]; else ties[k] = next;
  return set(s, { ties });
}

export function setTie(s, a, b, value) {
  return tie(s, a, b) === !!value ? s : toggleTie(s, a, b);
}

// Every unordered pair of alters with its state and why.
// source: 'context' (implied), 'added' (override true), 'removed' (override false), 'none'
export function tieList(s) {
  const implied = impliedTies(s);
  const out = [];
  const A = s.alters;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    const k = pairKey(A[i].id, A[j].id);
    const imp = implied.has(k);
    const ov = k in s.ties ? s.ties[k] : undefined;
    const on = ov ?? imp;
    out.push({ a: A[i].id, b: A[j].id, key: k, on, implied: imp, source: ov === undefined ? (imp ? 'context' : 'none') : (ov ? 'added' : 'removed') });
  }
  return out;
}

// ---- progress --------------------------------------------------------------

// Completeness per step (0..1) and overall. Describe counts answered cells;
// who-knows-whom counts alters placed in at least one context, since ego has
// at least considered them (pairs are never "unanswered": absent means no tie).
export function progress(s) {
  const tf = s.tieFields || [];
  const nA = s.alters.length, nI = s.interpreters.length + tf.length;
  let answered = 0;
  for (const a of s.alters) {
    for (const it of s.interpreters) if (a.attrs[it.name] !== undefined && a.attrs[it.name] !== '') answered++;
    for (const f of tf) if (a.tie?.[f.key] !== undefined && a.tie[f.key] !== '') answered++;
  }
  const placed = new Set(s.contexts.flatMap(c => c.members));
  const steps = {
    generators: s.generators.length ? 1 : 0,
    interpreters: s.interpreters.length ? 1 : 0,
    names: s.generators.length ? s.generators.filter(g => generatorCount(s, g.id) > 0).length / s.generators.length : 0,
    describe: nA && nI ? answered / (nA * nI) : (nA && !nI ? 1 : 0),
    ties: nA < 2 ? (nA ? 1 : 0) : s.alters.filter(a => placed.has(a.id)).length / nA,
    review: s.finishedAt ? 1 : 0,
  };
  const vals = Object.values(steps);
  return { steps, fraction: vals.reduce((x, y) => x + y, 0) / vals.length, answered, cells: nA * nI };
}

// Labels that must not overlap (setting names around the who-knows-whom
// circle): items [{ x, y, w, anchor: 'start'|'middle'|'end' }] in drawing
// units, w the label's width. Later labels that would overlap an earlier one
// move down (or up, when below the middle line) in steps of lineH until they
// are clear. Returns the new y for each item, in input order.
export function placeLabels(items, { lineH = 14, midY = null } = {}) {
  const box = (it, y) => {
    const x0 = it.anchor === 'end' ? it.x - it.w : it.anchor === 'middle' ? it.x - it.w / 2 : it.x;
    return { x0, x1: x0 + it.w, y0: y - lineH * 0.8, y1: y + lineH * 0.2 };
  };
  const hit = (a, b) => a.x0 < b.x1 + 4 && b.x0 < a.x1 + 4 && a.y0 < b.y1 && b.y0 < a.y1;
  const placed = [];
  return items.map(it => {
    const dir = midY !== null && it.y < midY ? -1 : 1;
    let y = it.y;
    for (let k = 0; k < 40 && placed.some(p => hit(p, box(it, y))); k++) y += dir * lineH;
    placed.push(box(it, y));
    return y;
  });
}

// What is left to do, in words, for the review step.
export function todo(s) {
  const p = progress(s);
  const out = [];
  if (!s.generators.length) out.push('choose at least one question that asks for names');
  const empty = s.generators.filter(g => generatorCount(s, g.id) === 0);
  if (empty.length) out.push(`no names yet for ${empty.map(g => `"${g.name}"`).join(', ')}`);
  if (p.cells && p.answered < p.cells) out.push(`${p.cells - p.answered} of ${p.cells} descriptions still blank`);
  if (s.alters.length >= 2) {
    const placed = new Set(s.contexts.flatMap(c => c.members));
    const loose = s.alters.filter(a => !placed.has(a.id)).length;
    if (loose) out.push(`${loose} ${loose === 1 ? 'person is' : 'people are'} not in any setting (their ties come only from the pairs you set by hand)`);
  }
  return out;
}

// ---- Dataset ---------------------------------------------------------------

function typedValue(it, raw) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (it.type === 'ordinal') { const n = Number(raw); return Number.isFinite(n) ? n : String(raw); }
  if (it.type === 'number') return coerce(raw, 'number');
  if (it.type === 'boolean') return coerce(raw, 'boolean');
  return String(raw);
}

export function toDataset(s, { name } = {}) {
  if (!s.alters.length) throw new Error('Name at least one person before analyzing.');
  const b = new DatasetBuilder({ name: name || `Ego network: ${s.egoLabel || s.caseId || 'respondent'}` });
  writeEgoSession(b, s);
  return b.build();
}

// One interview into a DatasetBuilder as its own ego source. Shared with the
// survey-response importer, which writes one source per respondent when the
// interviews were not run against a roster. source: extra source fields.
export function writeEgoSession(b, s, { source = {} } = {}) {
  const t = Date.parse(s.startedAt);
  const egoKey = `ego:${s.egoId}`;
  const tf = s.tieFields || [];
  b.beginSource({ format: 'ego-interview', family: 'survey', medium: 'survey', view: 'ego', context: 'survey', egoKey, tz: 'UTC',
    fileNames: [], directed: false, sessionId: s.id, protocolName: s.protocolName,
    ...(tf.length ? { tieFields: declareTieFields(tf) } : {}), ...source });
  const ego = b.node(egoKey, { label: s.egoLabel || 'Ego', attrs: { kind: 'ego', caseId: s.caseId || undefined, ...s.egoAttrs } });
  const genCtx = new Map();
  const usedSlugs = new Set();
  for (const g of s.generators) {
    let sl = slug(g.name);
    for (let i = 2; usedSlugs.has(sl); i++) sl = `${slug(g.name)}-${i}`;
    usedSlugs.add(sl);
    genCtx.set(g.id, b.context(`ego:${s.egoId}:gen:${sl}`, { name: g.name, kind: 'survey', visibility: 'direct', medium: 'survey' }));
  }
  const aaCtx = b.context(`ego:${s.egoId}:alter-ties`, { name: 'perceived ties', kind: 'survey', visibility: 'direct', medium: 'survey' });
  const idx = new Map();
  const weightIt = s.weightBy ? s.interpreters.find(i => i.name === s.weightBy) : null;
  for (const a of s.alters) {
    const attrs = { kind: 'alter', generators: a.generators.map(g => s.generators.find(x => x.id === g)?.name).filter(Boolean).join(';') };
    for (const it of s.interpreters) { const v = typedValue(it, a.attrs[it.name]); if (v !== undefined) attrs[it.name] = v; }
    const i = b.node(`alter:${s.egoId}:${a.uuid}`, { label: a.label, attrs });
    idx.set(a.id, i);
    b.stat('alters');
    const w0 = weightIt ? Number(typedValue(weightIt, a.attrs[weightIt.name])) : 1;
    const w = Number.isFinite(w0) && w0 > 0 ? w0 : 1;
    const tieAttrs = cleanTieValues(tf, a.tie);
    // One event per question that named this person, so each question stays a
    // context of its own; the tie's weight is shared out among them, so a
    // person named under two questions is still one tie of weight w (1 when
    // "every tie counts 1"), as in Burt's binary measures (C4).
    const gens = a.generators.filter(g => genCtx.has(g));
    for (const g of gens) {
      b.event({ type: 'declared', t, actor: ego, targets: [[i, 'declared']], context: genCtx.get(g), weight: w / gens.length, attrs: tieAttrs });
      b.stat('ego-alter ties');
    }
  }
  // Alter-alter ties: one event per unordered pair, written in alter order.
  // They are undirected (ego reports that two people know each other) and
  // perceived by ego, not observed; the context name says so.
  for (const p of tieList(s)) {
    if (!p.on) continue;
    b.event({ type: 'declared', t, actor: idx.get(p.a), targets: [[idx.get(p.b), 'declared']], context: aaCtx, weight: 1 });
    b.stat('alter-alter ties');
  }
  return ego;
}

// ---- ego measures for the review step ------------------------------------------

// Size, density, effective size and constraint of ego's own network, every
// tie counting 1 (Burt 1992; the formulas networkx uses on an unweighted
// graph). Alters are the people named; ties among them are the session's
// alter-alter ties. Also the range constraint can take for this size:
// 1/n when no two people know each other, (2n - 1)^2 / n^3 when all do.
export function egoMeasures(s) {
  const ids = s.alters.map(a => a.id);
  const n = ids.length;
  const pos = new Map(ids.map((id, k) => [id, k]));
  const adj = ids.map(() => new Set());
  let ties = 0;
  for (const p of tieList(s)) {
    if (!p.on) continue;
    adj[pos.get(p.a)].add(pos.get(p.b)); adj[pos.get(p.b)].add(pos.get(p.a));
    ties++;
  }
  const possible = (n * (n - 1)) / 2;
  let constraint = 0;
  for (let j = 0; j < n; j++) {
    // p_iq = 1/n for ego's ties; an alter q's own ties are ego plus its alter ties.
    let indirect = 0;
    for (const q of adj[j]) indirect += (1 / n) * (1 / (adj[q].size + 1));
    constraint += (1 / n + indirect) ** 2;
  }
  return {
    size: n, ties, possible,
    density: possible ? ties / possible : NaN,
    effectiveSize: n ? n - (2 * ties) / n : NaN,
    efficiency: n ? (n - (2 * ties) / n) / n : NaN,
    constraint: n ? constraint : NaN,
    constraintMin: n ? 1 / n : NaN,
    constraintMax: n ? (2 * n - 1) ** 2 / n ** 3 : NaN,
    reading: egoReading(possible ? ties / possible : NaN),
  };
}

// One stated rule for reading an ego network, used by every line of the
// review: by density, the share of pairs of people named who know each
// other. Constraint is not part of it (it also rises when the people named
// form close-knit clusters that do not know each other).
export const EGO_READING_RULE = 'Read from density, the share of pairs of people named who know each other: below 1/3 brokering, above 2/3 closed, in between mixed.';
export function egoReading(density) {
  if (!Number.isFinite(density)) return null;
  return density < 1 / 3 - 1e-12 ? 'brokering' : density > 2 / 3 + 1e-12 ? 'closed' : 'mixed';
}

// ---- JSON save / resume ----------------------------------------------------

export function sessionToJSON(s) { return JSON.stringify({ kind: 'orgsignal-ego-session', ...s }, null, 2); }

export function sessionFromJSON(text) {
  let o;
  try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw new Error('This file is not valid JSON.'); }
  if (!o || typeof o !== 'object') throw new Error('This file is not an ego session.');
  if (o.kind && o.kind !== 'orgsignal-ego-session') throw new Error('This file is not an ego session.');
  for (const k of ['generators', 'interpreters', 'alters']) if (!Array.isArray(o[k])) throw new Error(`Session file is missing "${k}".`);
  if ((o.version ?? 1) > SESSION_VERSION) throw new Error('This session was saved by a newer version of Org Signal.');
  const base = newSession();
  const s = { ...base, ...o };
  delete s.kind;
  s.contexts = Array.isArray(o.contexts) ? o.contexts : [];
  s.ties = o.ties && typeof o.ties === 'object' ? o.ties : {};
  const ids = new Set(s.alters.map(a => a.id));
  s.tieFields = Array.isArray(o.tieFields) ? o.tieFields : [];
  s.alters = s.alters.map(a => {
    const x = { id: a.id || uid('a'), uuid: a.uuid || uuid(), label: String(a.label ?? ''), generators: a.generators || [], attrs: a.attrs || {} };
    if (a.tie && typeof a.tie === 'object') x.tie = a.tie;
    if (a.personId) x.personId = String(a.personId);
    return x;
  });
  s.contexts = s.contexts.map(c => ({ ...c, members: (c.members || []).filter(m => ids.has(m)) }));
  if (!STEPS.some(x => x.id === s.step) && s.step !== 'share') s.step = 'generators';
  return s;
}

// ---- Network Canvas CSV export / import --------------------------------------
//
// Column names follow the Network Canvas exporter source as recorded in
// docs/formats/network-canvas-and-surveys.md. Categorical variables are
// written the way NC writes them, one `<name>_<optionValue>` true/false
// column per option, even though our interpreters are single-choice. One
// extra boolean column per generator (`gen_<slug>`) keeps which question
// elicited each alter, which NC would keep as separate name-generator stages.

export const NC = {
  egoFixed: ['networkCanvasEgoUUID', 'networkCanvasCaseID', 'networkCanvasSessionID', 'networkCanvasProtocolName',
    'sessionStart', 'sessionFinish', 'sessionExported', 'APP_VERSION', 'COMMIT_HASH'],
  alterFixed: ['nodeID', 'networkCanvasEgoUUID', 'networkCanvasUUID', 'name'],
  edgeFixed: ['edgeID', 'from', 'to', 'networkCanvasEgoUUID', 'networkCanvasUUID', 'networkCanvasSourceUUID', 'networkCanvasTargetUUID'],
};

export const APP_VERSION = 'org-signal-2';

export function ncPrefix(s) {
  // NC sanitises caseId_sessionId for file names; we keep word chars and dashes.
  return `${s.caseId || 'case'}_${s.id}`.replace(/[^\w-]+/g, '_');
}

export function generatorColumn(g) { return 'gen_' + varName(g.name); }
export function settingColumn(c) { return 'setting_' + varName(c.name); }

export function toNetworkCanvasCSV(s, { exportedAt = new Date().toISOString() } = {}) {
  const prefix = ncPrefix(s);
  // The respondent's name goes in a `name` ego variable (as Network Canvas
  // protocols usually ask it); an unfinished session counts as finished when
  // it is exported, so sessionFinish is never blank.
  const egoVars = Object.keys(s.egoAttrs || {}).filter(k => k !== 'name');
  const egoRows = [[...NC.egoFixed, 'name', ...egoVars],
    [s.egoId, s.caseId || '', s.id, s.protocolName || '', s.startedAt || '', s.finishedAt || exportedAt, exportedAt, APP_VERSION, '', s.egoLabel || '', ...egoVars.map(k => s.egoAttrs[k])]];

  const attrCols = [];
  for (const it of s.interpreters) {
    if (it.type === 'categorical') for (const o of it.options || []) attrCols.push({ col: `${it.name}_${o.value}`, it, opt: o.value });
    else attrCols.push({ col: it.name, it });
  }
  const genCols = s.generators.map(g => ({ col: generatorColumn(g), g }));
  // Settings from the who-knows-whom step, one true/false column each.
  const setCols = s.contexts.map(c => ({ col: settingColumn(c), c }));
  const alterRows = [[...NC.alterFixed, ...attrCols.map(c => c.col), ...genCols.map(c => c.col), ...setCols.map(c => c.col)]];
  const nodeID = new Map();
  s.alters.forEach((a, i) => {
    nodeID.set(a.id, i + 1);
    alterRows.push([i + 1, s.egoId, a.uuid, a.label,
      ...attrCols.map(c => {
        const raw = a.attrs[c.it.name];
        if (c.opt !== undefined) return raw === undefined ? false : String(raw) === String(c.opt);
        if (raw === undefined) return '';
        return c.it.type === 'boolean' ? coerce(raw, 'boolean') : raw;
      }),
      ...genCols.map(c => a.generators.includes(c.g.id)),
      ...setCols.map(c => c.c.members.includes(a.id))]);
  });
  const byId = new Map(s.alters.map(a => [a.id, a]));
  const edgeRows = [[...NC.edgeFixed]];
  let e = 0;
  for (const p of tieList(s)) {
    if (!p.on) continue;
    e++;
    edgeRows.push([e, nodeID.get(p.a), nodeID.get(p.b), s.egoId, uuid(), byId.get(p.a).uuid, byId.get(p.b).uuid]);
  }
  return [
    { name: `${prefix}_ego.csv`, text: toCSV(egoRows) },
    { name: `${prefix}_attributeList_Person.csv`, text: toCSV(alterRows) },
    { name: `${prefix}_edgeList_knows.csv`, text: toCSV(edgeRows) },
  ];
}

// NC guards cells starting = + - @ tab with a leading quote; strip it.
const unguard = v => (typeof v === 'string' && /^'[=+\-@\t]/.test(v) ? v.slice(1) : v);

// Rebuild a session from Network Canvas CSVs: files [{ name, text }]. The ego
// and attribute-list files are required; the edge list is optional. Only the
// first ego in the files is read (one session per interview). Interpreter
// definitions are recovered from the columns: `<name>_<value>` groups become
// categorical, `gen_*` booleans become generators, numeric columns numbers.
// Pass `template` (a session) to reuse its question wording and option labels.
export function fromNetworkCanvasCSV(files, { template } = {}) {
  const read = re => {
    const f = files.find(x => re.test(x.name)) || files.find(x => re.test(firstLine(x.text)));
    return f ? rowsToObjects(parseCSV(f.text).rows) : null;
  };
  const egoT = read(/_ego\.csv$|networkCanvasCaseID/);
  const altT = read(/_attributeList_[^/]*\.csv$|^nodeID,|nodeID.*networkCanvasUUID/);
  const edgeT = read(/_edgeList_[^/]*\.csv$|^edgeID,/);
  if (!altT) throw new Error('No Network Canvas attribute list (alters) file found.');
  const egoRow = egoT?.records[0];
  const egoId = egoRow?.networkCanvasEgoUUID || altT.records[0]?.networkCanvasEgoUUID;
  const s = newSession();
  s.egoId = egoId || s.egoId;
  if (egoRow) {
    s.caseId = unguard(egoRow.networkCanvasCaseID) || '';
    s.id = egoRow.networkCanvasSessionID || s.id;
    s.protocolName = unguard(egoRow.networkCanvasProtocolName) || s.protocolName;
    s.startedAt = egoRow.sessionStart || s.startedAt;
    s.finishedAt = egoRow.sessionFinish || null;
    for (const k of egoT.headers) if (!NC.egoFixed.includes(k) && k !== 'name' && egoRow[k] !== '') s.egoAttrs[k] = unguard(egoRow[k]);
  }
  s.egoLabel = unguard(egoRow?.name || '') || s.caseId || 'Respondent';
  const records = altT.records.filter(r => !r.networkCanvasEgoUUID || r.networkCanvasEgoUUID === s.egoId);
  const extra = altT.headers.filter(h => !NC.alterFixed.includes(h));

  const tGen = new Map((template?.generators || []).map(g => [generatorColumn(g), g]));
  const tInt = new Map((template?.interpreters || []).map(i => [i.name, i]));
  const genCols = extra.filter(h => /^gen_/.test(h));
  for (const col of genCols) {
    const t = tGen.get(col);
    s.generators.push(t ? { ...t } : { id: uid('g'), name: col.slice(4).replace(/_/g, ' ').replace(/^\w/, c => c.toUpperCase()), prompt: '', cap: Math.max(10, records.length) });
  }
  if (!s.generators.length) s.generators.push({ id: uid('g'), name: 'Named', prompt: '', cap: Math.max(10, records.length) });
  const genByCol = new Map(genCols.map((c, i) => [c, s.generators[i]]));
  const tCtx = new Map((template?.contexts || []).map(c => [settingColumn(c), c.name]));
  const setCols = extra.filter(h => /^setting_/.test(h));
  const ctxByCol = new Map(setCols.map(c => [c, { id: uid('c'), name: tCtx.get(c) || c.slice(8).replace(/_/g, ' ').replace(/^\w/, x => x.toUpperCase()), members: [] }]));

  // Categorical groups: a template interpreter claims its own columns; other
  // columns whose values are all true/false and share a stem form a group.
  const rest = extra.filter(h => !genByCol.has(h) && !ctxByCol.has(h));
  const claimed = new Set();
  for (const it of template?.interpreters || []) {
    if (it.type === 'categorical') {
      const cols = (it.options || []).map(o => `${it.name}_${o.value}`).filter(c => rest.includes(c));
      if (cols.length) { s.interpreters.push(structuredClone(it)); cols.forEach(c => claimed.add(c)); }
    } else if (rest.includes(it.name)) { s.interpreters.push(structuredClone(it)); claimed.add(it.name); }
  }
  const isBool = h => records.every(r => r[h] === '' || /^(true|false)$/i.test(r[h]));
  const groups = new Map();
  for (const h of rest) {
    if (claimed.has(h) || /_(x|y|screenSpaceX|screenSpaceY)$/.test(h)) continue;
    const m = /^(.+)_([^_]+)$/.exec(h);
    if (m && isBool(h)) { if (!groups.has(m[1])) groups.set(m[1], []); groups.get(m[1]).push({ col: h, value: m[2] }); }
  }
  for (const [stem, cols] of groups) {
    if (cols.length < 2) continue;
    cols.forEach(c => claimed.add(c.col));
    s.interpreters.push({ id: uid('i'), name: stem, label: stem.replace(/_/g, ' '), type: 'categorical', options: cols.map(c => ({ value: c.value, label: c.value })) });
  }
  for (const h of rest) {
    if (claimed.has(h) || /_(x|y|screenSpaceX|screenSpaceY)$/.test(h)) continue;
    const vals = records.map(r => r[h]).filter(v => v !== '');
    const type = vals.length && vals.every(v => /^(true|false)$/i.test(v)) ? 'boolean' : vals.length && vals.every(v => Number.isFinite(Number(v))) ? 'number' : 'text';
    s.interpreters.push({ id: uid('i'), name: h, label: h.replace(/_/g, ' '), type });
  }

  const byNodeID = new Map();
  for (const r of records) {
    const a = { id: uid('a'), uuid: r.networkCanvasUUID || uuid(), label: unguard(r.name) || `Alter ${r.nodeID}`, generators: [], attrs: {} };
    for (const [col, g] of genByCol) if (/^true$/i.test(r[col])) a.generators.push(g.id);
    if (!a.generators.length) a.generators.push(s.generators[0].id);
    for (const it of s.interpreters) {
      if (it.type === 'categorical') {
        const hit = (it.options || []).find(o => /^true$/i.test(r[`${it.name}_${o.value}`] ?? ''));
        if (hit) a.attrs[it.name] = hit.value;
      } else if (r[it.name] !== undefined && r[it.name] !== '') a.attrs[it.name] = unguard(r[it.name]);
    }
    for (const [col, c] of ctxByCol) if (/^true$/i.test(r[col] ?? '')) c.members.push(a.id);
    byNodeID.set(String(r.nodeID), a);
    s.alters.push(a);
  }
  s.contexts = [...ctxByCol.values()];
  const byUUID = new Map(s.alters.map(a => [a.uuid, a]));
  const present = new Set();
  if (edgeT) for (const r of edgeT.records) {
    if (r.networkCanvasEgoUUID && r.networkCanvasEgoUUID !== s.egoId) continue;
    const a = byUUID.get(r.networkCanvasSourceUUID) || byNodeID.get(String(r.from));
    const b = byUUID.get(r.networkCanvasTargetUUID) || byNodeID.get(String(r.to));
    if (a && b && a !== b) present.add(pairKey(a.id, b.id));
  }
  // The edge list is the final answer; with settings restored, only the pairs
  // that differ from what the settings imply are kept as exceptions.
  const implied = impliedTies(s);
  for (let i = 0; i < s.alters.length; i++) for (let j = i + 1; j < s.alters.length; j++) {
    const k = pairKey(s.alters[i].id, s.alters[j].id);
    if (present.has(k) !== implied.has(k)) s.ties[k] = present.has(k);
  }
  s.step = 'review';
  return s;
}

function firstLine(t) { const i = t.indexOf('\n'); return i < 0 ? t : t.slice(0, i); }
