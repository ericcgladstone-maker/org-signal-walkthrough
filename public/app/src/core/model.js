// Org Signal internal data model.
//
// Every source (importers, hand builders, the synthetic generator) writes a
// Dataset through DatasetBuilder. Every analysis reads a Dataset. Nothing else
// is shared, so this file is the contract between the halves of the app.
//
// Shape (after build()):
//   meta        { name, createdAt, sources: SourceInfo[] }
//   nodes       { count, keys[], labels[], attrs[{}], isBot Uint8Array, platformIds[{}] }
//   attributeSchema  [{ key, type, label, values? }]   inferred from node attrs
//   contexts    { count, keys[], names[], kinds[], visibility Uint8Array, medium[], members[] }
//   events      columnar; see EventColumns below
//   eventAttributeSchema  [{ key, type, label, values?, ordered?, coverage }]  tie fields
//                         found on events (see "Tie fields" below)
//
// Events are stored column-wise in typed arrays so a few million of them fit
// in memory and can be handed to a Web Worker without copying.
//
// Tie fields (optional per-event attributes). A survey or hand-built tie can
// carry qualities beyond its weight: tie type, strength, frequency, notes.
// They live in events.attrs, which is null when no event has any (so the
// millions of messages in an export cost nothing), or else an array with one
// entry per event: a plain object of { field: value } or null. Values are
// numbers, strings, booleans or arrays of strings (several choices). A source
// may declare its fields as source.tieFields = [{ key, label, type, options?,
// max?, ordered? }] (type 'choice' | 'scale' | 'number' | 'text'), which gives
// the schema labels and the option order an ordered choice needs. Read one
// event's fields with eventAttrs(ds, i).

// The default broadcast cutoff: a message to more recipients, or a meeting with
// more participants, creates no ties unless the cutoff is raised in Construction
// settings. analysis/construct.js defaultSettings uses the same value
// (test/core/broadcast-cutoff.test.js keeps them equal); importers use it so the
// notices they raise count exactly what the default network leaves out.
export const DEFAULT_BROADCAST_CUTOFF = 25;

export const EVENT_TYPES = ['message', 'copresence', 'declared', 'reaction', 'repost', 'like', 'follow', 'join', 'leave'];
export const ROLES = ['to', 'cc', 'bcc', 'mention', 'reply', 'dm', 'attendee', 'member', 'declared', 'subject'];
export const VISIBILITY = ['public', 'private', 'direct', 'group', 'unknown'];

// What kind of slice of a network a source shows. Measures check this.
export const VIEWS = {
  FULL: 'full',         // a bounded group, everyone's interactions (admin Slack export, roster survey)
  EGO: 'ego',           // one person's interactions with others (mailbox, X archive, LinkedIn)
  CHAT: 'chat',         // one conversation (a single WhatsApp export)
  SAMPLE: 'sample',     // a sample of a larger population (research datasets)
  AUTHORED: 'authored', // only what one account wrote (Bluesky repo, Discord package)
};

export const CONTEXTS = ['workplace', 'online', 'professional', 'personal', 'community', 'survey', 'custom'];

const typeIndex = Object.fromEntries(EVENT_TYPES.map((t, i) => [t, i]));
const roleIndex = Object.fromEntries(ROLES.map((r, i) => [r, i]));
const visIndex = Object.fromEntries(VISIBILITY.map((v, i) => [v, i]));

export class DatasetBuilder {
  constructor({ name = 'Untitled', source } = {}) {
    this.name = name;
    this.sources = [];
    this._source = -1;
    this._nodeIndex = new Map();
    this.nodes = { keys: [], labels: [], attrs: [], isBot: [], platformIds: [] };
    this._ctxIndex = new Map();
    this.contexts = { keys: [], names: [], kinds: [], visibility: [], medium: [], members: [] };
    this.ev = { type: [], t: [], actor: [], context: [], parentKey: [], weight: [], source: [], tOff: [0], tgt: [], role: [], text: [], keys: [] };
    // Tie fields, sparse: event index -> plain object. Most datasets have none.
    this._attrs = new Map();
    this._eventKeyIndex = new Map();
    if (source) this.beginSource(source);
  }

  // Start a new source. Importers call this once per input they read.
  // info: { format, family, medium, view, context, tz, fileNames[], egoKey? }
  beginSource(info) {
    const s = { id: this.sources.length, format: 'unknown', family: 'custom', medium: 'unknown', view: VIEWS.FULL,
      context: 'custom', tz: 'UTC', fileNames: [], egoKey: null, counts: {}, warnings: [], ...info };
    this.sources.push(s);
    this._source = s.id;
    return s.id;
  }

  get source() { return this.sources[this._source]; }

  // Record a problem the import report should show. Repeated codes are counted, not duplicated.
  warn(code, message, count = 1) {
    const w = this.source.warnings.find(x => x.code === code);
    if (w) w.count += count; else this.source.warnings.push({ code, message, count });
  }

  stat(name, inc = 1) { this.source.counts[name] = (this.source.counts[name] || 0) + inc; }

  // Add or update a node. key must be namespaced, e.g. 'slack:U012AB' or 'email:ann@x.org'.
  // Returns the node index. Later calls merge label, attrs and platform ids.
  node(key, { label, attrs, isBot, platformIds } = {}) {
    let i = this._nodeIndex.get(key);
    if (i === undefined) {
      i = this.nodes.keys.length;
      this._nodeIndex.set(key, i);
      this.nodes.keys.push(key);
      this.nodes.labels.push(label ?? key.slice(key.indexOf(':') + 1));
      this.nodes.attrs.push({});
      this.nodes.isBot.push(0);
      this.nodes.platformIds.push({});
    } else if (label && this.nodes.labels[i] === key.slice(key.indexOf(':') + 1)) {
      this.nodes.labels[i] = label;
    }
    if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined && v !== null && v !== '') this.nodes.attrs[i][k] = v;
    if (isBot) this.nodes.isBot[i] = 1;
    if (platformIds) Object.assign(this.nodes.platformIds[i], platformIds);
    return i;
  }

  // Replace a node's label after the fact, e.g. once an importer has seen every
  // display name used for an address and picked the most common one.
  setLabel(i, label) { if (label) this.nodes.labels[i] = label; }

  // Change a context's visibility after creation, for importers that only know
  // it once every message has been read (an email thread that turns out to be 1:1).
  setVisibility(ci, visibility) {
    const v = visIndex[visibility];
    if (v === undefined) throw new Error(`Unknown visibility: ${visibility}`);
    this.contexts.visibility[ci] = v;
  }

  hasNode(key) { return this._nodeIndex.has(key); }
  nodeIndex(key) { return this._nodeIndex.get(key) ?? -1; }

  // Add or update a context (channel, DM, email thread, meeting, chat, subreddit...).
  context(key, { name, kind = 'channel', visibility = 'unknown', medium, members } = {}) {
    let i = this._ctxIndex.get(key);
    if (i === undefined) {
      i = this.contexts.keys.length;
      this._ctxIndex.set(key, i);
      this.contexts.keys.push(key);
      this.contexts.names.push(name ?? key);
      this.contexts.kinds.push(kind);
      this.contexts.visibility.push(visIndex[visibility] ?? visIndex.unknown);
      this.contexts.medium.push(medium ?? this.source?.medium ?? 'unknown');
      this.contexts.members.push(members ? [...members] : null);
    } else {
      if (name) this.contexts.names[i] = name;
      if (members) this.contexts.members[i] = [...new Set([...(this.contexts.members[i] || []), ...members])];
    }
    return i;
  }

  contextIndex(key) { return this._ctxIndex.get(key) ?? -1; }

  // Add an event.
  //   type      one of EVENT_TYPES
  //   t         ms since epoch, UTC. NaN or null when unknown.
  //   actor     node index (who acted)
  //   targets   [[nodeIndex, role], ...]  role one of ROLES
  //   context   context index or -1
  //   key       optional unique string so other events can name this one as parent
  //   parentKey optional key of the event this replies to / reposts / reacts to
  //   text      optional message text
  //   weight    optional, default 1 (e.g. survey closeness, reaction count)
  //   attrs     optional tie fields { field: value }; blank values are dropped
  event({ type = 'message', t = NaN, actor, targets = [], context = -1, key = null, parentKey = null, text = null, weight = 1, attrs = null }) {
    const ty = typeIndex[type];
    if (ty === undefined) throw new Error(`Unknown event type: ${type}`);
    if (!(actor >= 0)) throw new Error('event() needs an actor node index');
    const ev = this.ev;
    const i = ev.type.length;
    ev.type.push(ty);
    ev.t.push(t == null ? NaN : t);
    ev.actor.push(actor);
    ev.context.push(context);
    ev.parentKey.push(parentKey);
    ev.weight.push(weight);
    ev.source.push(this._source);
    for (const [n, r] of targets) {
      const ri = roleIndex[r];
      if (ri === undefined) throw new Error(`Unknown role: ${r}`);
      if (n === actor || !(n >= 0)) continue;
      ev.tgt.push(n); ev.role.push(ri);
    }
    ev.tOff.push(ev.tgt.length);
    ev.text.push(text);
    ev.keys.push(key);
    if (key != null) this._eventKeyIndex.set(key, i);
    if (attrs) {
      const a = cleanEventAttrs(attrs);
      if (a) this._attrs.set(i, a);
    }
    return i;
  }

  eventIndex(key) { return this._eventKeyIndex.get(key) ?? -1; }

  build() {
    const ev = this.ev;
    const n = ev.type.length;
    // Resolve parent keys to indices. Parents missing from the data are counted per source.
    const parent = new Int32Array(n).fill(-1);
    const unresolved = new Map();
    for (let i = 0; i < n; i++) {
      const pk = ev.parentKey[i];
      if (pk == null) continue;
      const p = this._eventKeyIndex.get(pk);
      if (p === undefined) unresolved.set(ev.source[i], (unresolved.get(ev.source[i]) || 0) + 1);
      else parent[i] = p;
    }
    for (const [sid, count] of unresolved) {
      this.sources[sid].warnings.push({ code: 'unresolved-parent', message: 'Replies or reactions whose parent message is not in the data', count });
    }
    // Records an export holds more than once are read once; say so (2026-10-05),
    // unless the importer already explained it in its own words.
    for (const s of this.sources) {
      const dup = (s.counts['duplicates-skipped'] || 0) + (s.counts.duplicates || 0) + (s.counts['duplicates-removed'] || 0);
      if (dup && !s.warnings.some(w => /duplicate/.test(w.code))) {
        s.warnings.push({ code: 'duplicates-skipped', message: 'Messages that appear more than once in the export (the same message id, for example under two labels or in two files) were read once.', count: dup });
      }
    }
    const nodes = {
      count: this.nodes.keys.length,
      keys: this.nodes.keys,
      labels: this.nodes.labels,
      attrs: this.nodes.attrs,
      isBot: Uint8Array.from(this.nodes.isBot),
      platformIds: this.nodes.platformIds,
    };
    const contexts = {
      count: this.contexts.keys.length,
      keys: this.contexts.keys,
      names: this.contexts.names,
      kinds: this.contexts.kinds,
      visibility: Uint8Array.from(this.contexts.visibility),
      medium: this.contexts.medium,
      members: this.contexts.members,
    };
    const events = {
      count: n,
      type: Uint8Array.from(ev.type),
      t: Float64Array.from(ev.t),
      actor: Int32Array.from(ev.actor),
      context: Int32Array.from(ev.context),
      parent,
      weight: Float64Array.from(ev.weight),
      source: Uint16Array.from(ev.source),
      tOff: Int32Array.from(ev.tOff),
      tgt: Int32Array.from(ev.tgt),
      role: Uint8Array.from(ev.role),
      text: ev.text,
      keys: ev.keys,
      attrs: null,
    };
    if (this._attrs.size) {
      events.attrs = new Array(n).fill(null);
      for (const [i, a] of this._attrs) events.attrs[i] = a;
    }
    const out = {
      meta: { name: this.name, createdAt: Date.now(), sources: this.sources },
      nodes,
      attributeSchema: inferAttributeSchema(nodes.attrs),
      contexts,
      events,
    };
    out.eventAttributeSchema = inferEventAttributeSchema(out);
    return out;
  }
}

// ---- schema inference ------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;

export function inferAttributeSchema(attrs) {
  const keys = new Map();
  for (const a of attrs) for (const k of Object.keys(a)) {
    if (!keys.has(k)) keys.set(k, []);
    keys.get(k).push(a[k]);
  }
  const schema = [];
  for (const [key, vals] of keys) {
    const distinct = new Set(vals.map(v => String(v)));
    // The two-mode marker is structural, not a measured quantity: always a
    // two-value choice, whatever the count of nodes (see twoModeOf).
    if (key === MODE_ATTR && [...distinct].every(v => v === '0' || v === '1')) {
      schema.push({ key, type: 'categorical', label: 'Mode (two-mode)', coverage: vals.length / (attrs.length || 1), values: [...distinct].sort() });
      continue;
    }
    let type;
    if (vals.every(v => typeof v === 'boolean' || /^(true|false|yes|no)$/i.test(String(v)))) type = 'boolean';
    else if (vals.every(v => typeof v === 'number' || (String(v).trim() !== '' && !isNaN(Number(v))))) type = distinct.size <= 12 && vals.length > 30 ? 'ordinal' : 'numeric';
    else if (vals.every(v => DATE_RE.test(String(v)))) type = 'date';
    else if (/(^|_)(id|uuid|email|url)$/i.test(key) || distinct.size > Math.max(50, vals.length * 0.9)) type = distinct.size === vals.length ? 'id' : 'text';
    else type = 'categorical';
    const entry = { key, type, label: key.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase()), coverage: vals.length / (attrs.length || 1) };
    if (type === 'categorical' || type === 'boolean' || type === 'ordinal') entry.values = [...distinct].sort();
    schema.push(entry);
  }
  return schema;
}

// ---- tie fields ------------------------------------------------------------------

// Keep only values a field can hold; null when nothing is left.
export function cleanEventAttrs(attrs) {
  let out = null;
  for (const [k, v0] of Object.entries(attrs || {})) {
    let v = v0;
    if (Array.isArray(v)) { v = v.filter(x => x !== null && x !== undefined && x !== '').map(String); if (!v.length) continue; if (v.length === 1) v = v[0]; }
    else if (v === undefined || v === null || v === '' || (typeof v === 'number' && !Number.isFinite(v))) continue;
    else if (typeof v === 'object') v = JSON.stringify(v);
    (out ||= {})[k] = v;
  }
  return out;
}

// Tie fields of event i (an empty object when it has none). Works on datasets
// saved before events.attrs existed.
const NO_ATTRS = Object.freeze({});
export function eventAttrs(ds, i) {
  return ds.events.attrs?.[i] || NO_ATTRS;
}

// Schema of the tie fields: declared ones (source.tieFields) first, in their
// order and with their labels and options, then any others found on events.
//   type 'numeric'      numbers (weights can be taken from it)
//        'categorical'  choices; values[] in declared order when declared,
//                       ordered: true when the order means low to high
//        'text'         free text (notes)
//        'boolean'
export function inferEventAttributeSchema(ds) {
  const attrs = ds.events?.attrs;
  const seen = new Map();
  let withAttrs = 0;
  if (attrs) for (let i = 0; i < attrs.length; i++) {
    const a = attrs[i];
    if (!a) continue;
    withAttrs++;
    for (const [k, v] of Object.entries(a)) {
      if (!seen.has(k)) seen.set(k, { n: 0, vals: new Set(), num: true, bool: true, multi: false });
      const e = seen.get(k);
      e.n++;
      const list = Array.isArray(v) ? v : [v];
      if (Array.isArray(v)) e.multi = true;
      for (const x of list) {
        if (e.vals.size < 500) e.vals.add(String(x));
        if (typeof x !== 'number' && !(typeof x === 'string' && x.trim() !== '' && Number.isFinite(Number(x)))) e.num = false;
        if (typeof x !== 'boolean') e.bool = false;
      }
    }
  }
  const declared = new Map();
  for (const s of ds.meta?.sources || []) for (const f of s.tieFields || []) if (f && f.key && !declared.has(f.key)) declared.set(f.key, f);
  const out = [];
  const label = k => k.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
  const add = (key, d, e) => {
    let type;
    if (d) type = d.type === 'choice' ? 'categorical' : d.type === 'scale' || d.type === 'number' ? 'numeric' : d.type === 'boolean' ? 'boolean' : 'text';
    else if (e.bool) type = 'boolean';
    else if (e.num) type = 'numeric';
    else type = e.vals.size <= Math.max(12, e.n * 0.5) && !e.multi ? 'categorical' : e.multi ? 'categorical' : 'text';
    const entry = { key, type, label: d?.label || label(key), coverage: withAttrs ? (e?.n || 0) / withAttrs : 0 };
    if (type === 'categorical') {
      const found = e ? [...e.vals] : [];
      const opts = d?.options ? d.options.map(String) : [];
      entry.values = [...opts, ...found.filter(v => !opts.includes(v)).sort()];
      entry.ordered = !!d?.ordered;
    }
    if (type === 'numeric' && d?.max) entry.max = d.max;
    if (d) entry.declared = true;
    out.push(entry);
  };
  for (const [k, d] of declared) add(k, d, seen.get(k));
  for (const [k, e] of seen) if (!declared.has(k)) add(k, null, e);
  return out;
}

// ---- helpers for readers of a Dataset ---------------------------------------

export function eventTargets(ds, i) {
  const { tOff, tgt, role } = ds.events;
  const out = [];
  for (let j = tOff[i]; j < tOff[i + 1]; j++) out.push([tgt[j], ROLES[role[j]]]);
  return out;
}

export function eventType(ds, i) { return EVENT_TYPES[ds.events.type[i]]; }
export function contextVisibility(ds, c) { return c < 0 ? 'unknown' : VISIBILITY[ds.contexts.visibility[c]]; }

// Dataset -> structured-cloneable payload plus the list of buffers to transfer to a worker.
export function toTransfer(ds) {
  const e = ds.events;
  const transfer = [e.type, e.t, e.actor, e.context, e.parent, e.weight, e.source, e.tOff, e.tgt, e.role, ds.nodes.isBot, ds.contexts.visibility].map(a => a.buffer);
  return { payload: ds, transfer };
}

// Plain JSON round trip for project files. Typed arrays become tagged objects.
export function toJSON(ds) {
  return JSON.stringify(ds, (k, v) => {
    if (ArrayBuffer.isView(v)) return { __ta: v.constructor.name, d: Array.from(v, x => (Number.isNaN(x) ? null : x)) };
    return v;
  });
}

const TA = { Uint8Array, Uint16Array, Int32Array, Float32Array, Float64Array };
export function fromJSON(str) {
  return JSON.parse(str, (k, v) => {
    if (v && typeof v === 'object' && v.__ta) return TA[v.__ta].from(v.d, x => (x === null ? NaN : x));
    return v;
  });
}

export const MODEL_VERSION = 1;

// ---- two-mode (affiliation) data ---------------------------------------------------
//
// A two-mode network ties two kinds of node: actors (people, mode 0) and the
// things they belong to or attend (events, groups, boards, mode 1), and ties
// run only between the kinds (Davis's Southern Women: 18 women x 14 events).
// The representation is deliberately small, so every existing path (toJSON,
// toTransfer, merge, identity merges, the import worker, exporters) carries
// it without change:
//
//   - each node's mode is the node attribute `bipartite` (MODE_ATTR): 0 or 1,
//     the attribute networkx uses, so GraphML / GEXF files round-trip;
//   - a source declares itself two-mode with source.twoMode = { labels:
//     [mode-0 label, mode-1 label] } (e.g. ['Women', 'Events']);
//   - an affiliation is a `declared` event from the actor with the mode-1
//     node as a `member` target (addAffiliation), optionally weighted, dated
//     and carrying tie fields. Any other tie between the modes (a `declared`
//     tie read from a network file) also counts as an affiliation.
//
// twoModeOf(ds) reads it back; the analysis engine builds the two-mode network
// or a one-mode projection from it (settings.twoMode, src/analysis/construct.js).

export const MODE_ATTR = 'bipartite';
export const DEFAULT_MODE_LABELS = ['Actors', 'Events'];

// Normalise a mode value as it arrives from attributes or files: 0 / 1,
// '0' / '1', true / false. Anything else is unknown (-1).
export function modeValue(v) {
  if (v === 0 || v === 1) return v;
  if (v === '0' || v === '1') return Number(v);
  if (v === false || v === 'false') return 0;
  if (v === true || v === 'true') return 1;
  return -1;
}

// Add (or update) a node of a given mode. Returns the node index.
export function addModeNode(builder, key, mode, { label, attrs, ...rest } = {}) {
  if (mode !== 0 && mode !== 1) throw new Error(`addModeNode: mode must be 0 or 1, got ${mode}`);
  return builder.node(key, { label, attrs: { ...(attrs || {}), [MODE_ATTR]: mode }, ...rest });
}

// Record that actorKey (mode 0) belongs to / attended eventKey (mode 1).
//   opts: { weight = 1, t = NaN, attrs (tie fields), context = -1,
//           actorLabel, eventLabel, actorAttrs, eventAttrs, key }
// Creates both nodes if needed and declares the current source two-mode
// (keeping labels it already has). Returns the event index.
export function addAffiliation(builder, actorKey, eventKey, opts = {}) {
  const { weight = 1, t = NaN, attrs = null, context = -1, actorLabel, eventLabel, actorAttrs, eventAttrs, key = null } = opts;
  if (!builder.source) builder.beginSource({ format: 'two-mode', family: 'custom', view: VIEWS.FULL, directed: false });
  const src = builder.source;
  if (!src.twoMode) src.twoMode = { labels: [...DEFAULT_MODE_LABELS] };
  const a = addModeNode(builder, actorKey, 0, { label: actorLabel, attrs: actorAttrs });
  const e = addModeNode(builder, eventKey, 1, { label: eventLabel, attrs: eventAttrs });
  return builder.event({ type: 'declared', t, actor: a, targets: [[e, 'member']], context, weight, attrs, key });
}

// Declare the current source two-mode with mode labels, e.g.
// declareTwoMode(builder, ['Women', 'Events']). Undirected by nature.
export function declareTwoMode(builder, labels = DEFAULT_MODE_LABELS) {
  const src = builder.source;
  if (!src) throw new Error('declareTwoMode: call beginSource first');
  src.twoMode = { labels: [String(labels[0] ?? DEFAULT_MODE_LABELS[0]), String(labels[1] ?? DEFAULT_MODE_LABELS[1])] };
  if (src.directed === undefined) src.directed = false;
  return src.twoMode;
}

// Is this dataset two-mode, and which node is which?
// Returns null for one-mode data, else
//   { mode: Int8Array(ds.nodes.count) (0, 1, or -1 unknown), labels: [l0, l1],
//     counts: [n0, n1], unknown, declared }
// Two-mode when a source declares twoMode, or (networkx-style files with no
// declaration) every non-bot node has `bipartite` 0 or 1 and both occur.
export function twoModeOf(ds) {
  const N = ds?.nodes?.count || 0;
  const sources = ds?.meta?.sources || [];
  const decl = sources.find(s => s && s.twoMode);
  const mode = new Int8Array(N).fill(-1);
  const counts = [0, 0];
  let unknown = 0, unknownNonBot = 0;
  for (let i = 0; i < N; i++) {
    const m = modeValue(ds.nodes.attrs[i]?.[MODE_ATTR]);
    mode[i] = m;
    if (m >= 0) counts[m]++;
    else { unknown++; if (!ds.nodes.isBot?.[i]) unknownNonBot++; }
  }
  if (!decl && (unknownNonBot > 0 || !counts[0] || !counts[1])) return null;
  if (decl && !counts[0] && !counts[1]) return null;
  const labels = decl?.twoMode?.labels ? [String(decl.twoMode.labels[0] ?? DEFAULT_MODE_LABELS[0]), String(decl.twoMode.labels[1] ?? DEFAULT_MODE_LABELS[1])] : [...DEFAULT_MODE_LABELS];
  return { mode, labels, counts, unknown, declared: !!decl };
}
