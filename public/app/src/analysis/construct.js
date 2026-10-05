// Network construction: Dataset events -> weighted ties.
//
// Construction is a visible, recorded choice (CONTRACTS principle 4). Each rule
// turns one kind of evidence into ties; every tie keeps per-rule evidence
// amounts and a bitmask of the visibility layers its evidence came from, and
// edgeEvidence() can replay the rules to show the events behind any tie.
//
// The rule engine (forEachEvidence) is shared by buildNetwork, edgeEvidence,
// bootstrap resampling (event multiplicities) and time windows (event subsets),
// so all of them agree exactly on what counts as a tie.

import { EVENT_TYPES, ROLES, VISIBILITY, VIEWS, inferEventAttributeSchema, twoModeOf } from '../core/model.js';

export const RULES = ['reply', 'mention', 'dm', 'to', 'cc', 'bcc', 'adjacency', 'copresence', 'declared', 'repost', 'like', 'follow', 'reaction'];
export const RULE_INFO = {
  reply: 'A replied to a message by B',
  mention: 'A mentioned B (@name)',
  dm: 'A sent B a direct message',
  to: 'A emailed B (To)',
  cc: 'A copied B (Cc)',
  bcc: 'A blind-copied B (Bcc)',
  adjacency: 'A posted right after B in the same conversation (turn-taking, inferred)',
  copresence: 'A and B attended the same meeting or event',
  declared: 'A named B (survey or hand-drawn tie), or A belongs to B (affiliation)',
  repost: 'A reposted something by B',
  like: 'A liked something by B',
  follow: 'A follows B',
  reaction: 'A reacted to a message by B',
};
// Layers are context visibilities; bit i of layerMask = VISIBILITY[i].
export const LAYERS = VISIBILITY;

const T = Object.fromEntries(EVENT_TYPES.map((t, i) => [t, i]));
const R = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const RI = Object.fromEntries(RULES.map((r, i) => [r, i]));
const UNKNOWN_VIS = VISIBILITY.indexOf('unknown');
// Roles that address people directly; used for the broadcast cutoff.
const ADDRESS_ROLES = new Set([R.to, R.cc, R.bcc, R.dm, R.mention]);
// Context kinds where turn-taking is meaningful. Email threads and meetings
// have their own explicit evidence; surveys and canvases have no sequence.
const NO_ADJACENCY_KINDS = new Set(['email_thread', 'meeting', 'survey', 'canvas']);
const DEFAULT_WEIGHT = { adjacency: 0.5 };
const GROUP_CHAT_KINDS = new Set(['group_dm', 'chat']);

// ---- defaults ----------------------------------------------------------------

// How many pieces of evidence each rule has in this dataset, counted as
// forEachEvidence emits them before any filter (bots, time, visibility,
// broadcast cutoff): a target who is the actor makes no tie, and a message
// whose importer named the parent's author as its `reply` target is one reply,
// not two. The parent fallback counts only messages without a reply target
// whose parent was written by someone else. (Counting reply targets plus every
// message with a parent double-counted threaded replies and counted replies in
// one's own thread: 32,183 "replies" in a Slack world whose network is built
// from 13,709.) The settings drawer and the import review show these counts.
export function evidenceCounts(ds) {
  return countEvidence(ds).evidence;
}

function countEvidence(ds) {
  const ev = ds.events;
  const roleCount = new Float64Array(ROLES.length);
  const typeCount = new Float64Array(EVENT_TYPES.length);
  let parentReplies = 0, untargetedShared = 0, untargetedGroupChat = 0, messages = 0, timed = 0;
  // Evidence from sources that declare their ties undirected (source.directed === false).
  const undirectedSource = (ds.meta?.sources || []).map(s => s.directed === false);
  let undirectedEvidence = 0;
  for (let i = 0; i < ev.count; i++) {
    const ty = ev.type[i];
    typeCount[ty]++;
    const a0 = ev.tOff[i], a1 = ev.tOff[i + 1], nT = a1 - a0;
    const actor = ev.actor[i];
    let hasReplyTarget = false;
    for (let j = a0; j < a1; j++) {
      if (ev.role[j] === R.reply) hasReplyTarget = true;
      if (ev.tgt[j] !== actor) roleCount[ev.role[j]]++;
    }
    if (undirectedSource[ev.source[i]] && ty !== T.copresence) undirectedEvidence += nT;
    if (Number.isFinite(ev.t[i])) timed++;
    if (ty !== T.message) continue;
    messages++;
    const p = ev.parent[i];
    if (p >= 0 && !hasReplyTarget && ev.actor[p] !== actor) parentReplies++;
    const c = ev.context[i];
    if (nT === 0 && c >= 0 && !NO_ADJACENCY_KINDS.has(ds.contexts.kinds[c])) {
      untargetedShared++;
      if (GROUP_CHAT_KINDS.has(ds.contexts.kinds[c])) untargetedGroupChat++;
    }
  }
  const evidence = {
    reply: roleCount[R.reply] + parentReplies,
    mention: roleCount[R.mention],
    dm: roleCount[R.dm],
    to: roleCount[R.to], cc: roleCount[R.cc], bcc: roleCount[R.bcc],
    // Turn-taking is inferred when group chats carry no per-message targets
    // (WhatsApp, Telegram, iMessage groups: ties exist only through it), or
    // when many messages in shared spaces name nobody.
    adjacency: timed > 0 && messages > 0 && (untargetedGroupChat > 0 || untargetedShared / messages >= 0.3) ? untargetedShared : 0,
    copresence: typeCount[T.copresence],
    declared: typeCount[T.declared],
    repost: typeCount[T.repost], like: typeCount[T.like], follow: typeCount[T.follow], reaction: typeCount[T.reaction],
  };
  return { evidence, undirectedSource, undirectedEvidence };
}

// Turn on only the rules whose evidence exists in this dataset, with counts so
// the settings drawer can say why each rule is on or off.
export function defaultSettings(ds) {
  const { evidence, undirectedSource, undirectedEvidence } = countEvidence(ds);
  const rules = {};
  for (const r of RULES) rules[r] = { on: evidence[r] > 0, weight: DEFAULT_WEIGHT[r] ?? 1, evidence: evidence[r] };
  rules.adjacency.windowMin = 10;
  rules.copresence.normalize = true;
  // Directed unless most evidence has no direction: co-attendance, or ties
  // from sources that declare themselves undirected (LinkedIn connections,
  // undirected network files, drawn networks). In a directed network those
  // ties are entered in both directions (see forEachEvidence).
  const total = RULES.reduce((s, r) => s + (rules[r].on ? evidence[r] : 0), 0);
  const undirectedShare = (evidence.copresence + undirectedEvidence) / (total || 1);
  // Two-mode data: affiliation has no direction (see twoModeDefaults).
  const tm = twoModeOf(ds);
  const directed = tm ? false : total === 0 ? !undirectedSource.length || !undirectedSource.every(Boolean) : undirectedShare < 0.5;
  const visibility = [...new Set(Array.from(ds.contexts.visibility, v => VISIBILITY[v]))];
  if (!visibility.includes('unknown')) visibility.push('unknown');
  let hasBots = false;
  for (let i = 0; i < ds.nodes.count; i++) if (ds.nodes.isBot[i]) { hasBots = true; break; }
  return {
    rules,
    directed,
    weighting: 'count',
    minWeight: 0,
    maxRecipients: 25,
    time: { start: null, end: null },
    visibility,
    media: null,
    excludeBots: true,
    excludeNodes: [],
    includeIsolates: true,
    // Tie fields (events.attrs): take each tie's amount from a numeric or
    // ordered field, and keep only ties whose fields match. See tieFieldPlan.
    // A source may ask for tie-field filters by default (source.defaultTieFilters):
    // a stitched ego survey leaves out the ties respondents only perceive
    // between other people until the user includes them (ui-build, C2).
    tieFields: { weight: null, filters: defaultTieFilters(ds) },
    // Two-mode data (twoModeOf): which network to build. null for one-mode data.
    twoMode: tm ? twoModeDefaults() : null,
    _hasBots: hasBots,
  };
}

// settings.twoMode for two-mode datasets:
//   view: 'two-mode' (actors and events, ties only across) | 'mode0' (actors
//         tied by shared events) | 'mode1' (events tied by shared actors)
//   projection: how a projection weighs a pair: 'count' of shared
//         affiliations (default), 'newman' (each shared event adds
//         1 / (its size - 1), Newman 2001), 'binary' (1)
//   minShared: a projected pair needs at least this many shared affiliations
export const TWO_MODE_VIEWS = ['two-mode', 'mode0', 'mode1'];
export const PROJECTIONS = ['count', 'newman', 'binary'];
export function twoModeDefaults() { return { view: 'two-mode', projection: 'count', minShared: 1 }; }

function defaultTieFilters(ds) {
  const out = [];
  for (const src of ds.meta?.sources || []) {
    for (const f of src.defaultTieFilters || []) if (f && f.key && !out.some(x => x.key === f.key)) out.push({ ...f, values: Array.isArray(f.values) ? [...f.values] : f.values });
  }
  return out;
}

// Fill missing fields so callers may pass partial settings.
export function normalizeSettings(ds, s = {}) {
  const d = defaultSettings(ds);
  const rules = {};
  for (const r of RULES) rules[r] = { ...d.rules[r], ...(s.rules?.[r] || {}) };
  // twoMode: null (explicitly) builds an ordinary one-mode network of
  // everyone even from two-mode data; otherwise partial settings are filled.
  const twoMode = !d.twoMode || (s && 'twoMode' in s && s.twoMode === null) ? null : { ...d.twoMode, ...(s.twoMode || {}) };
  if (twoMode) {
    if (!TWO_MODE_VIEWS.includes(twoMode.view)) twoMode.view = 'two-mode';
    if (!PROJECTIONS.includes(twoMode.projection)) twoMode.projection = 'count';
    twoMode.minShared = Math.max(1, Math.floor(Number(twoMode.minShared) || 1));
  }
  const out = { ...d, ...s, rules, time: { ...d.time, ...(s.time || {}) }, tieFields: { ...d.tieFields, ...(s.tieFields || {}) }, twoMode };
  if (twoMode) out.directed = false;
  return out;
}

// ---- tie fields -----------------------------------------------------------------

// settings.tieFields = { weight: key | null, filters: [{ key, values?, min?, max?, keepMissing? }] }
//
// weight: the evidence amount of an event that has this field is the field's
//   value instead of event.weight: a number as is, an ordered choice as its
//   position (first option 1), several choices their highest. Events from
//   sources that carry the field but leave it blank keep event.weight and are
//   counted (weightMissing). Events from other sources are untouched.
// filters: each filter applies only to events from sources that carry its
//   field (declared in source.tieFields or seen on one of their events), so a
//   filter on a survey's tie type leaves a Slack export alongside it alone.
//   Such an event passes when its value is one of `values` (any of them, for
//   several choices) and within [min, max] for numbers. A blank value fails
//   unless keepMissing. Every filter must pass.
// Returns null when nothing is asked, so the common case costs nothing.
export function tieFieldPlan(ds, tf) {
  if (!tf) return null;
  const weightKey = tf.weight || null;
  const filters = (tf.filters || []).filter(f => f && f.key && (Array.isArray(f.values) || Number.isFinite(f.min) || Number.isFinite(f.max)));
  if (!weightKey && !filters.length) return null;
  const ev = ds.events, attrs = ev.attrs || null;
  const sources = ds.meta?.sources || [];
  const schema = new Map((ds.eventAttributeSchema || inferEventAttributeSchema(ds)).map(x => [x.key, x]));
  const carriers = key => {
    const has = new Uint8Array(Math.max(1, sources.length));
    sources.forEach((src, k) => { if ((src.tieFields || []).some(f => f.key === key)) has[k] = 1; });
    if (attrs) for (let i = 0; i < attrs.length; i++) if (attrs[i] && key in attrs[i]) has[ev.source[i]] = 1;
    return has;
  };
  const plan = { weightKey: null, filters: [] };
  if (weightKey) {
    const sc = schema.get(weightKey);
    const order = sc?.type === 'categorical' && sc.values ? new Map(sc.values.map((v, k) => [v, k + 1])) : null;
    const num = x => {
      if (typeof x === 'number') return x;
      if (typeof x === 'boolean') return x ? 1 : 0;
      const n = Number(x);
      if (String(x).trim() !== '' && Number.isFinite(n)) return n;
      return order?.get(String(x)) ?? NaN;
    };
    plan.weightKey = weightKey;
    plan.weightCarriers = carriers(weightKey);
    plan.weightOf = (a) => {
      const v = a?.[weightKey];
      if (v === undefined) return NaN;
      if (Array.isArray(v)) { let best = NaN; for (const x of v) { const n = num(x); if (!(n <= best)) best = n; } return best; }
      return num(v);
    };
  }
  for (const f of filters) {
    plan.filters.push({
      key: f.key, carriers: carriers(f.key), keepMissing: !!f.keepMissing,
      values: Array.isArray(f.values) ? new Set(f.values.map(String)) : null,
      min: Number.isFinite(f.min) ? f.min : -Infinity, max: Number.isFinite(f.max) ? f.max : Infinity,
    });
  }
  plan.pass = (i, a) => {
    for (const f of plan.filters) {
      if (!f.carriers[ev.source[i]]) continue;
      const v = a?.[f.key];
      if (v === undefined) { if (!f.keepMissing) return false; continue; }
      const list = Array.isArray(v) ? v : [v];
      let ok = false;
      for (const x of list) {
        if (f.values && !f.values.has(String(x))) continue;
        if (f.min !== -Infinity || f.max !== Infinity) { const n = Number(x); if (!(n >= f.min && n <= f.max)) continue; }
        ok = true; break;
      }
      if (!ok) return false;
    }
    return true;
  };
  return plan;
}

// ---- rule engine ---------------------------------------------------------------

// Calls emit(a, b, rule, amount, eventIndex, visIndex, symmetric) for every
// piece of tie evidence that survives the filters. a and b are dataset node
// indices. symmetric=true (copresence) means the evidence has no direction.
//
// opts.events: optional Int32Array of event indices to consider (time windows).
// opts.mult:   optional per-event multiplicity (bootstrap); 0 drops the event.
// Returns counts of what was dropped and why, for the summary.
export function forEachEvidence(ds, settings, emit, opts = {}) {
  const ev = ds.events, N = ds.nodes.count;
  const s = settings;
  const on = RULES.map(r => !!s.rules[r]?.on);
  const nodeOk = new Uint8Array(N).fill(1);
  if (s.excludeBots) for (let i = 0; i < N; i++) if (ds.nodes.isBot[i]) nodeOk[i] = 0;
  for (const x of s.excludeNodes || []) if (x >= 0 && x < N) nodeOk[x] = 0;
  const visOk = new Uint8Array(VISIBILITY.length);
  for (const v of s.visibility ?? VISIBILITY) { const k = VISIBILITY.indexOf(v); if (k >= 0) visOk[k] = 1; }
  if (!s.visibility) visOk.fill(1);
  const media = s.media && s.media.length ? new Set(s.media) : null;
  const start = s.time?.start ?? null, end = s.time?.end ?? null;
  const timeFiltered = start != null || end != null;
  const maxR = s.maxRecipients > 0 ? s.maxRecipients : Infinity;
  const copMax = s.rules.copresence?.maxSize > 0 ? s.rules.copresence.maxSize : maxR;
  const copNorm = s.rules.copresence?.normalize !== false;
  const mult = opts.mult || null;
  const sources = ds.meta?.sources || [];
  // Ties from a source that declares itself undirected have no direction:
  // they are emitted as symmetric evidence, like co-attendance.
  const symSource = sources.map(x => x.directed === false);

  const tf = tieFieldPlan(ds, s.tieFields);
  const evAttrs = ev.attrs || null;

  const drop = { events: 0, used: 0, bots: 0, time: 0, undated: 0, visibility: 0, media: 0, broadcast: 0, copresenceLarge: 0, excluded: 0, tieField: 0, tieWeightMissing: 0 };
  const adjSeq = on[RI.adjacency] ? [] : null;

  const each = (i) => {
    drop.events++;
    const m = mult ? mult[i] : 1;
    if (m === 0) return;
    const t = ev.t[i];
    if (timeFiltered) {
      if (!Number.isFinite(t)) { drop.undated++; return; }
      if ((start != null && t < start) || (end != null && t >= end)) { drop.time++; return; }
    }
    const actor = ev.actor[i];
    // Count a drop as "bots" only when bots are being excluded; an account
    // removed by hand is "excluded" even if it happens to be a bot.
    if (!nodeOk[actor]) { if (s.excludeBots && ds.nodes.isBot[actor]) drop.bots++; else drop.excluded++; return; }
    const c = ev.context[i];
    const vis = c >= 0 ? ds.contexts.visibility[c] : UNKNOWN_VIS;
    if (!visOk[vis]) { drop.visibility++; return; }
    if (media) {
      const med = c >= 0 ? ds.contexts.medium[c] : sources[ev.source[i]]?.medium;
      if (!media.has(med)) { drop.media++; return; }
    }
    let amt = ev.weight[i] * m;
    if (tf) {
      const a = evAttrs ? evAttrs[i] : null;
      if (tf.filters.length && !tf.pass(i, a)) { drop.tieField++; return; }
      if (tf.weightKey && tf.weightCarriers[ev.source[i]]) {
        const w = tf.weightOf(a);
        if (Number.isFinite(w) && w >= 0) amt = w * m; else drop.tieWeightMissing++;
      }
    }
    drop.used++;
    const ty = ev.type[i];
    const a0 = ev.tOff[i], a1 = ev.tOff[i + 1];

    if (ty === T.copresence) {
      if (!on[RI.copresence]) return;
      const people = [actor];
      for (let j = a0; j < a1; j++) {
        const r = ev.role[j], x = ev.tgt[j];
        if ((r === R.attendee || r === R.member) && nodeOk[x] && !people.includes(x)) people.push(x);
      }
      const k = people.length;
      if (k < 2) return;
      if (k > copMax) { drop.copresenceLarge++; return; }
      const per = copNorm ? amt / (k - 1) : amt;
      for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) emit(people[p], people[q], RI.copresence, per, i, vis, true);
      return;
    }

    // Broadcast cutoff: count distinct addressees.
    let broadcast = false;
    if (maxR !== Infinity && a1 - a0 > maxR) {
      const seen = new Set();
      for (let j = a0; j < a1; j++) if (ADDRESS_ROLES.has(ev.role[j])) seen.add(ev.tgt[j]);
      if (seen.size > maxR) { broadcast = true; drop.broadcast++; }
    }
    let hasReplyTarget = false, hasSubject = false;
    const done = a1 - a0 > 1 ? new Set() : null;
    for (let j = a0; j < a1; j++) {
      const x = ev.tgt[j], role = ev.role[j];
      // Whether the importer named a target decides the parent fallback below,
      // so note it before filtering: a reply to an excluded account must not be
      // redirected to whoever wrote the parent message.
      if (role === R.reply) hasReplyTarget = true;
      else if (role === R.subject || ((role === R.declared || role === R.member) && ty === T.declared)) hasSubject = true;
      if (!nodeOk[x] || x === actor) continue;
      let rule = -1;
      switch (role) {
        case R.reply: rule = RI.reply; break;
        case R.mention: rule = broadcast ? -1 : RI.mention; break;
        case R.dm: rule = broadcast ? -1 : RI.dm; break;
        case R.to: rule = broadcast ? -1 : RI.to; break;
        case R.cc: rule = broadcast ? -1 : RI.cc; break;
        case R.bcc: rule = broadcast ? -1 : RI.bcc; break;
        case R.declared: rule = RI.declared; break;
        // Affiliation (two-mode data, addAffiliation): A belongs to / attended B.
        case R.member: rule = ty === T.declared ? RI.declared : -1; break;
        case R.subject: rule = subjectRule(ty); break;
        default: rule = -1;
      }
      if (rule < 0 || !on[rule]) continue;
      if (done) { const k = rule * N + x; if (done.has(k)) continue; done.add(k); }
      // Membership has no direction: symmetric, like co-attendance.
      emit(actor, x, rule, amt, i, vis, role === R.member || symSource[ev.source[i]] === true);
    }
    // A reply, repost, like or reaction whose parent is in the data but whose
    // importer did not name the parent's author as a target.
    const p = ev.parent[i];
    if (p >= 0 && (ty === T.message ? !hasReplyTarget : !hasSubject)) {
      const rule = ty === T.message ? RI.reply : subjectRule(ty);
      const x = ev.actor[p];
      if (rule >= 0 && on[rule] && x !== actor && nodeOk[x]) emit(actor, x, rule, amt, i, vis, symSource[ev.source[i]] === true);
    }
    if (adjSeq && ty === T.message && a0 === a1 && c >= 0 && Number.isFinite(t) && !NO_ADJACENCY_KINDS.has(ds.contexts.kinds[c])) adjSeq.push(i);
    else if (adjSeq && ty === T.message && c >= 0 && Number.isFinite(t) && !NO_ADJACENCY_KINDS.has(ds.contexts.kinds[c])) adjSeq.push(-1 - i); // addressed: part of the sequence, creates no adjacency tie
  };

  if (opts.events) for (let k = 0; k < opts.events.length; k++) each(opts.events[k]);
  else for (let i = 0; i < ev.count; i++) each(i);

  // Turn-taking: in each context, the first message of a new speaker's run is
  // read as a response to the previous speaker, if it came within windowMin.
  if (adjSeq && adjSeq.length) {
    const win = (s.rules.adjacency.windowMin ?? 10) * 60000;
    const idx = (k) => (k < 0 ? -1 - k : k);
    adjSeq.sort((x, y) => {
      const a = idx(x), b = idx(y);
      return ev.context[a] - ev.context[b] || ev.t[a] - ev.t[b] || a - b;
    });
    for (let k = 1; k < adjSeq.length; k++) {
      if (adjSeq[k] < 0) continue;
      const i = adjSeq[k], prev = idx(adjSeq[k - 1]);
      if (ev.context[prev] !== ev.context[i]) continue;
      const a = ev.actor[i], b = ev.actor[prev];
      if (a === b || ev.t[i] - ev.t[prev] > win) continue;
      const c = ev.context[i];
      emit(a, b, RI.adjacency, ev.weight[i] * (mult ? mult[i] : 1), i, ds.contexts.visibility[c], false);
    }
  }
  return drop;
}

function subjectRule(ty) {
  switch (ty) {
    case T.repost: return RI.repost;
    case T.like: return RI.like;
    case T.follow: return RI.follow;
    case T.reaction: return RI.reaction;
    case T.declared: return RI.declared;
    default: return -1;
  }
}

// ---- buildNetwork ------------------------------------------------------------------

// opts (internal): { events, mult } passed through to forEachEvidence.
export function buildNetwork(ds, settingsIn, opts = {}) {
  const s = normalizeSettings(ds, settingsIn);
  const N = ds.nodes.count;
  // Two-mode data: ties only between the modes, undirected; nodes whose
  // mode is unknown stay out (see twoModeOf).
  const tm = s.twoMode ? twoModeOf(ds) : null;
  const directed = tm ? false : !!s.directed;
  const ruleW = RULES.map(r => (s.rules[r]?.on ? Number(s.rules[r].weight ?? 1) : 0));
  const activeRules = RULES.filter(r => s.rules[r]?.on);
  const ruleSlot = RULES.map(r => activeRules.indexOf(r));
  const R_ = activeRules.length;

  const key = new Map();
  const ea = [], eb = [], raw = [], ev = [], mask = [];
  const add = (a, b, rule, amt, vis) => {
    const k = a * N + b;
    let e = key.get(k);
    if (e === undefined) {
      e = ea.length; key.set(k, e);
      ea.push(a); eb.push(b); raw.push(0); mask.push(0);
      for (let r = 0; r < R_; r++) ev.push(0);
    }
    raw[e] += amt * ruleW[rule];
    ev[e * R_ + ruleSlot[rule]] += amt;
    mask[e] |= 1 << vis;
  };
  let sameMode = 0, unknownMode = 0;
  const drop = forEachEvidence(ds, s, (a, b, rule, amt, i, vis, sym) => {
    if (tm) {
      const ma = tm.mode[a], mb = tm.mode[b];
      if (ma < 0 || mb < 0) { unknownMode++; return; }
      if (ma === mb) { sameMode++; return; }
    }
    if (!directed) { if (a < b) add(a, b, rule, amt, vis); else add(b, a, rule, amt, vis); }
    else { add(a, b, rule, amt, vis); if (sym) add(b, a, rule, amt, vis); }
  }, opts);

  // Keep ties with positive weight above the threshold.
  const minW = Number(s.minWeight) || 0;
  let keep = [];
  for (let e = 0; e < ea.length; e++) if (raw[e] > 0 && raw[e] >= minW) keep.push(e);
  const droppedWeak = ea.length - keep.length;

  // Network nodes: every eligible person (includeIsolates) or only those with ties.
  const inNet = new Uint8Array(N);
  if (s.includeIsolates) {
    for (let i = 0; i < N; i++) inNet[i] = 1;
    if (s.excludeBots) for (let i = 0; i < N; i++) if (ds.nodes.isBot[i]) inNet[i] = 0;
    for (const x of s.excludeNodes || []) if (x >= 0 && x < N) inNet[x] = 0;
    if (tm) for (let i = 0; i < N; i++) if (tm.mode[i] < 0) inNet[i] = 0;
  }

  // One-mode projection: the ties become pairs of same-mode nodes sharing
  // affiliations, and the network keeps only that mode.
  const view = tm ? s.twoMode.view : null;
  const basis = view === 'mode0' ? 0 : view === 'mode1' ? 1 : -1;
  let proj = null;
  if (basis >= 0) {
    proj = projectTies(ea, eb, raw, mask, keep, tm.mode, basis, N, s.twoMode);
    for (let i = 0; i < N; i++) if (tm.mode[i] !== basis) inNet[i] = 0;
    for (let k = 0; k < proj.a.length; k++) { inNet[proj.a[k]] = 1; inNet[proj.b[k]] = 1; }
  } else {
    for (const e of keep) { inNet[ea[e]] = 1; inNet[eb[e]] = 1; }
  }
  const index = new Int32Array(N).fill(-1);
  let n = 0;
  for (let i = 0; i < N; i++) if (inNet[i]) index[i] = n++;
  const nodeIds = new Int32Array(n);
  for (let i = 0; i < N; i++) if (index[i] >= 0) nodeIds[index[i]] = i;

  const transform = s.weighting === 'log' ? (x) => Math.log1p(x) : s.weighting === 'binary' ? () => 1 : (x) => x;
  let edges;
  if (proj) {
    const m = proj.a.length;
    const order = Array.from({ length: m }, (_, k) => k).sort((x, y) => index[proj.a[x]] - index[proj.a[y]] || index[proj.b[x]] - index[proj.b[y]]);
    edges = { count: m, src: new Int32Array(m), dst: new Int32Array(m), w: new Float64Array(m), raw: new Float64Array(m), byRule: {}, layerMask: new Uint8Array(m), shared: new Float64Array(m) };
    order.forEach((k, j) => {
      edges.src[j] = index[proj.a[k]]; edges.dst[j] = index[proj.b[k]];
      edges.raw[j] = proj.w[k]; edges.w[j] = transform(proj.w[k]);
      edges.layerMask[j] = proj.mask[k]; edges.shared[j] = proj.shared[k];
    });
  } else {
    // Canonical edge order (src, dst) so results never depend on event order.
    keep.sort((x, y) => index[ea[x]] - index[ea[y]] || index[eb[x]] - index[eb[y]]);
    const m = keep.length;
    const src = new Int32Array(m), dst = new Int32Array(m), w = new Float64Array(m), rawW = new Float64Array(m), layerMask = new Uint8Array(m);
    const byRule = {};
    for (const r of activeRules) byRule[r] = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const e = keep[k];
      src[k] = index[ea[e]]; dst[k] = index[eb[e]];
      rawW[k] = raw[e]; w[k] = transform(raw[e]); layerMask[k] = mask[e];
      for (let r = 0; r < R_; r++) byRule[activeRules[r]][k] = ev[e * R_ + r];
    }
    edges = { count: m, src, dst, w, raw: rawW, byRule, layerMask };
  }

  const net = {
    n, nodeIds, index, directed,
    edges,
    settings: s,
    summary: null,
  };
  if (tm) {
    // Per network node: its mode (0 / 1). counts: nodes of each mode in the network.
    const mode = new Uint8Array(n);
    const counts = [0, 0];
    for (let v = 0; v < n; v++) { mode[v] = tm.mode[nodeIds[v]]; counts[mode[v]]++; }
    net.twoMode = {
      view, labels: tm.labels, mode, counts, basis,
      projection: basis >= 0 ? s.twoMode.projection : null, minShared: basis >= 0 ? s.twoMode.minShared : null,
      affiliations: keep.length, sameModeEvidence: sameMode, unknownModeEvidence: unknownMode,
      belowMinShared: proj ? proj.belowMinShared : 0,
    };
  }
  net.summary = summarize(net, drop, droppedWeak);
  if (tm) {
    const t = net.twoMode;
    net.summary.twoMode = { view: t.view, labels: t.labels, counts: t.counts, projection: t.projection, minShared: t.minShared, affiliations: t.affiliations, sameModeEvidence: t.sameModeEvidence, unknownModeEvidence: t.unknownModeEvidence, belowMinShared: t.belowMinShared };
  }
  return net;
}

// Project two-mode ties onto one mode. Inputs are buildNetwork's tie arrays
// (dataset node ids) and the kept tie indices. Each affiliation counts once
// however strong it is (as networkx's projections): a pair's `shared` is the
// number of mode-(1 - basis) nodes both belong to.
//   count:  weight = shared                       (weighted_projected_graph)
//   newman: weight = sum over shared y of 1 / (deg(y) - 1)
//                                     (collaboration_weighted_projected_graph)
//   binary: weight = 1                            (projected_graph)
// Pairs with shared < minShared are dropped (counted in belowMinShared).
function projectTies(ea, eb, raw, mask, keep, mode, basis, N, tmSettings) {
  const members = new Map();   // other-mode node -> [[basis node, tie]]
  for (const e of keep) {
    const a = ea[e], b = eb[e];
    const x = mode[a] === basis ? a : b, y = x === a ? b : a;
    let L = members.get(y);
    if (!L) members.set(y, (L = []));
    L.push(x, e);
  }
  const pair = new Map();
  const A = [], B = [], S = [], W = [], M = [];
  const ys = [...members.keys()].sort((p, q) => p - q);
  for (const y of ys) {
    const L = members.get(y);
    const k = L.length / 2;
    if (k < 2) continue;
    const inv = 1 / (k - 1);
    for (let p = 0; p < k; p++) for (let q = p + 1; q < k; q++) {
      let a = L[2 * p], b = L[2 * q];
      const mk = mask[L[2 * p + 1]] | mask[L[2 * q + 1]];
      if (a > b) { const t = a; a = b; b = t; }
      const key = a * N + b;
      let j = pair.get(key);
      if (j === undefined) { j = A.length; pair.set(key, j); A.push(a); B.push(b); S.push(0); W.push(0); M.push(0); }
      S[j] += 1; W[j] += inv; M[j] |= mk;
    }
  }
  const minShared = tmSettings.minShared || 1;
  const how = tmSettings.projection;
  const out = { a: [], b: [], w: [], shared: [], mask: [], belowMinShared: 0 };
  for (let j = 0; j < A.length; j++) {
    if (S[j] < minShared) { out.belowMinShared++; continue; }
    out.a.push(A[j]); out.b.push(B[j]); out.shared.push(S[j]); out.mask.push(M[j]);
    out.w.push(how === 'newman' ? W[j] : how === 'binary' ? 1 : S[j]);
  }
  return out;
}

function summarize(net, drop, droppedWeak) {
  const { n, edges } = net;
  const deg = new Int32Array(n);
  for (let e = 0; e < edges.count; e++) { deg[edges.src[e]]++; deg[edges.dst[e]]++; }
  let isolates = 0;
  for (let i = 0; i < n; i++) if (!deg[i]) isolates++;
  const byRule = {};
  for (const [r, arr] of Object.entries(edges.byRule)) {
    let ties = 0, evidence = 0;
    for (let e = 0; e < arr.length; e++) if (arr[e] > 0) { ties++; evidence += arr[e]; }
    byRule[r] = { ties, evidence };
  }
  const layers = {};
  LAYERS.forEach((l, b) => {
    let c = 0;
    for (let e = 0; e < edges.count; e++) if (edges.layerMask[e] & (1 << b)) c++;
    if (c) layers[l] = c;
  });
  let wMin = Infinity, wMax = -Infinity, wSum = 0;
  for (let e = 0; e < edges.count; e++) { const x = edges.w[e]; if (x < wMin) wMin = x; if (x > wMax) wMax = x; wSum += x; }
  return {
    nodes: n, edges: edges.count, isolates, directed: net.directed, weighting: net.settings.weighting,
    events: { considered: drop.events, used: drop.used, dropped: { bots: drop.bots, excluded: drop.excluded, time: drop.time, undated: drop.undated, visibility: drop.visibility, media: drop.media, broadcast: drop.broadcast, largeMeetings: drop.copresenceLarge, tieField: drop.tieField } },
    tieFields: { weight: net.settings.tieFields?.weight || null, filters: (net.settings.tieFields?.filters || []).length, filtered: drop.tieField, weightMissing: drop.tieWeightMissing },
    tiesBelowMinWeight: droppedWeak,
    byRule, layers,
    weight: edges.count ? { min: wMin, max: wMax, mean: wSum / edges.count } : { min: 0, max: 0, mean: 0 },
  };
}

// ---- edgeEvidence ----------------------------------------------------------------

// The events that created the tie between dataset nodes a and b, under the
// network's own settings. For directed networks only a->b evidence is returned
// unless opts.bothDirections. Copresence evidence matches either direction.
// Returns an array of event summaries, oldest first, at most `limit`.
export function edgeEvidence(ds, net, a, b, { limit = 50, bothDirections = false } = {}) {
  const out = [];
  // A projected tie (two-mode data) has no events of its own: it stands for
  // the affiliations a and b share. Return the evidence of those, each with
  // `via` = the shared node (dataset index).
  const tm = net.twoMode;
  if (tm && tm.basis >= 0) {
    const mode = twoModeOf(ds)?.mode;
    const seenA = new Map(), seenB = new Map();
    if (mode) forEachEvidence(ds, net.settings, (x, y, rule, amt, i) => {
      for (const [p, q] of [[x, y], [y, x]]) {
        if (mode[q] !== 1 - tm.basis || mode[p] !== tm.basis) continue;
        if (p === a) { if (!seenA.has(q)) seenA.set(q, []); seenA.get(q).push({ i, rule: RULES[rule], amount: amt, from: x, to: y, via: q }); }
        if (p === b) { if (!seenB.has(q)) seenB.set(q, []); seenB.get(q).push({ i, rule: RULES[rule], amount: amt, from: x, to: y, via: q }); }
      }
    });
    for (const [q, list] of seenA) if (seenB.has(q)) out.push(...list, ...seenB.get(q));
    out.sort((p, q) => (ds.events.t[p.i] || 0) - (ds.events.t[q.i] || 0) || p.i - q.i);
    return out.slice(0, limit).map(o => ({ ...summarizeEvent(ds, o), via: o.via, viaLabel: ds.nodes.labels[o.via] }));
  }
  const any = !net.directed || bothDirections;
  forEachEvidence(ds, net.settings, (x, y, rule, amt, i, vis, sym) => {
    const fwd = x === a && y === b, rev = x === b && y === a;
    if (!(fwd || ((any || sym) && rev))) return;
    out.push({ i, rule: RULES[rule], amount: amt, from: x, to: y });
  });
  out.sort((p, q) => (ds.events.t[p.i] || 0) - (ds.events.t[q.i] || 0) || p.i - q.i);
  return out.slice(0, limit).map(o => summarizeEvent(ds, o));
}

export function summarizeEvent(ds, o) {
  const ev = ds.events, i = o.i, c = ev.context[i];
  const text = ev.text?.[i];
  return {
    event: i,
    t: ev.t[i],
    type: EVENT_TYPES[ev.type[i]],
    rule: o.rule,
    amount: o.amount,
    from: o.from, to: o.to,
    actor: ev.actor[i],
    actorLabel: ds.nodes.labels[ev.actor[i]],
    context: c >= 0 ? ds.contexts.names[c] : null,
    visibility: c >= 0 ? VISIBILITY[ds.contexts.visibility[c]] : 'unknown',
    text: text ? (text.length > 280 ? text.slice(0, 277) + '...' : text) : null,
    // Tie fields of the event (tie type, strength, notes ...), or null.
    attrs: ev.attrs?.[i] || null,
  };
}

// ---- tie fields per network edge ---------------------------------------------------

// The tie fields behind each network edge, for exports and tie panels: the
// events that built the edge (under the network's own settings) are replayed
// and their fields combined per edge. Numbers are averaged; choices and text
// keep their distinct values, joined by '; ' in first-seen order.
// Returns { fields: [{ key, label, type }], values: Array(edges) of { key: value } | null }.
export function edgeTieAttributes(ds, net) {
  const m = net.edges?.count || 0;
  const empty = { fields: [], values: new Array(m).fill(null) };
  if (!ds.events?.attrs || !m || !net.settings?.rules || !net.index) return empty;
  const schema = ds.eventAttributeSchema || inferEventAttributeSchema(ds);
  if (!schema.length) return empty;
  const type = new Map(schema.map(f => [f.key, f.type]));
  const n = net.n;
  const lookup = new Map();
  for (let e = 0; e < m; e++) lookup.set(net.edges.src[e] * n + net.edges.dst[e], e);
  const acc = new Array(m).fill(null);
  const take = (e, a) => {
    const slot = acc[e] || (acc[e] = {});
    for (const [k, v] of Object.entries(a)) {
      const t = type.get(k);
      const c = slot[k] || (slot[k] = t === 'numeric' ? { sum: 0, n: 0 } : { set: [] });
      for (const x of Array.isArray(v) ? v : [v]) {
        if (t === 'numeric') { const num = Number(x); if (Number.isFinite(num)) { c.sum += num; c.n++; } }
        else if (!c.set.includes(String(x))) c.set.push(String(x));
      }
    }
  };
  const lastEvent = new Int32Array(m).fill(-1);
  forEachEvidence(ds, net.settings, (a, b, rule, amt, i, vis, sym) => {
    const at = ds.events.attrs[i];
    if (!at) return;
    const x = net.index[a], y = net.index[b];
    if (x < 0 || y < 0) return;
    const pairs = !net.directed ? [[Math.min(x, y), Math.max(x, y)]] : sym ? [[x, y], [y, x]] : [[x, y]];
    for (const [p, q] of pairs) {
      const e = lookup.get(p * n + q);
      // One event counts once per edge, even when several of its targets map there.
      if (e === undefined || lastEvent[e] === i) continue;
      lastEvent[e] = i;
      take(e, at);
    }
  });
  const used = new Set();
  const values = acc.map(slot => {
    if (!slot) return null;
    const o = {};
    for (const [k, c] of Object.entries(slot)) {
      if (c.n !== undefined) { if (c.n) o[k] = c.sum / c.n; }
      else if (c.set.length) o[k] = c.set.join('; ');
      if (k in o) used.add(k);
    }
    return o;
  });
  const fields = schema.filter(f => used.has(f.key)).map(f => ({ key: f.key, label: f.label, type: f.type }));
  return { fields, values };
}

// Which views the dataset's sources record (for applicability).
export function sourceViews(ds) {
  const views = new Set((ds.meta?.sources || []).map(s => s.view || VIEWS.FULL));
  return views;
}

// ---- networks from plain edge lists --------------------------------------------------

// Build a Network directly from [a, b, weight] triples over nodes 0..n-1, for
// reference graphs, generator ground truth and tests. Duplicate ties are summed;
// in undirected networks a-b and b-a are the same tie.
export function networkFromEdges(n, edgeList, { directed = false, nodeIds = null, settings = {} } = {}) {
  const key = new Map();
  const ea = [], eb = [], ew = [];
  for (const [a0, b0, w0 = 1] of edgeList) {
    if (!(Number.isInteger(a0) && Number.isInteger(b0) && a0 >= 0 && b0 >= 0 && a0 < n && b0 < n)) {
      throw new RangeError(`networkFromEdges: edge (${a0}, ${b0}) names a node outside 0..${n - 1}.`);
    }
    if (a0 === b0) continue;
    const a = directed ? a0 : Math.min(a0, b0), b = directed ? b0 : Math.max(a0, b0);
    const k = a * n + b;
    const e = key.get(k);
    if (e === undefined) { key.set(k, ea.length); ea.push(a); eb.push(b); ew.push(w0); } else ew[e] += w0;
  }
  const order = ea.map((_, i) => i).sort((x, y) => ea[x] - ea[y] || eb[x] - eb[y]);
  const m = order.length;
  const src = Int32Array.from(order, i => ea[i]), dst = Int32Array.from(order, i => eb[i]);
  const w = Float64Array.from(order, i => ew[i]);
  const ids = nodeIds ? Int32Array.from(nodeIds) : Int32Array.from({ length: n }, (_, i) => i);
  let maxId = n - 1;
  for (const d of ids) if (d > maxId) maxId = d;
  const index = new Int32Array(maxId + 1).fill(-1);
  ids.forEach((d, i) => { index[d] = i; });
  const net = {
    n, nodeIds: ids, index, directed,
    edges: { count: m, src, dst, w, raw: Float64Array.from(w), byRule: {}, layerMask: new Uint8Array(m) },
    settings: { directed, weighting: 'count', rules: {}, ...settings },
    summary: null,
  };
  net.summary = { nodes: n, edges: m, directed, weighting: 'count', fromEdgeList: true };
  return net;
}
