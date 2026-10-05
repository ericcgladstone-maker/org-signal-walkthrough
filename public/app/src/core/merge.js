// Combining datasets and collapsing confirmed identities.
//
// mergeDatasets(list)   several Datasets -> one. Nodes and contexts with the same
//                       key are the same thing (email:ann@x.org from a mailbox and
//                       from a calendar); everything else is appended with its
//                       indices remapped. Sources are kept, renumbered.
// applyMerges(ds, pairs) collapse node pairs a person confirmed are one identity
//                       (usually from identity.suggestMatches). Attributes are
//                       unioned, platform ids recorded, and a merge log is kept in
//                       meta.merges so the step can be explained and undone by
//                       re-running without it.
//
// Both return new Datasets in the shape DatasetBuilder.build() produces.

import { inferAttributeSchema, inferEventAttributeSchema } from './model.js';

export function mergeDatasets(list, { name } = {}) {
  if (!list.length) throw new Error('mergeDatasets needs at least one dataset.');
  const nodeIndex = new Map();
  const nodes = { keys: [], labels: [], attrs: [], isBot: [], platformIds: [] };
  const ctxIndex = new Map();
  const ctx = { keys: [], names: [], kinds: [], visibility: [], medium: [], members: [] };
  const sources = [];
  let total = 0, tgtTotal = 0;
  for (const ds of list) { total += ds.events.count; tgtTotal += ds.events.tgt.length; }
  const E = {
    type: new Uint8Array(total), t: new Float64Array(total), actor: new Int32Array(total), context: new Int32Array(total),
    parent: new Int32Array(total), weight: new Float64Array(total), source: new Uint16Array(total),
    tOff: new Int32Array(total + 1), tgt: new Int32Array(tgtTotal), role: new Uint8Array(tgtTotal), text: [], keys: [],
    // Tie fields stay null unless some input carries them.
    attrs: list.some(d => d.events.attrs) ? new Array(total).fill(null) : null,
  };
  let eo = 0, to = 0;
  for (const ds of list) {
    const nmap = new Int32Array(ds.nodes.count);
    for (let i = 0; i < ds.nodes.count; i++) {
      const k = ds.nodes.keys[i];
      let j = nodeIndex.get(k);
      if (j === undefined) {
        j = nodes.keys.length; nodeIndex.set(k, j);
        nodes.keys.push(k); nodes.labels.push(ds.nodes.labels[i]); nodes.attrs.push({ ...ds.nodes.attrs[i] });
        nodes.isBot.push(ds.nodes.isBot[i]); nodes.platformIds.push({ ...ds.nodes.platformIds[i] });
      } else {
        // Same key in two datasets: union attrs (first dataset wins on conflict) and ids.
        const bare = k.slice(k.indexOf(':') + 1);
        if (nodes.labels[j] === bare && ds.nodes.labels[i] !== bare) nodes.labels[j] = ds.nodes.labels[i];
        for (const [a, v] of Object.entries(ds.nodes.attrs[i])) if (!(a in nodes.attrs[j])) nodes.attrs[j][a] = v;
        for (const [p, v] of Object.entries(ds.nodes.platformIds[i])) if (!(p in nodes.platformIds[j])) nodes.platformIds[j][p] = v;
        if (ds.nodes.isBot[i]) nodes.isBot[j] = 1;
      }
      nmap[i] = j;
    }
    const cmap = new Int32Array(ds.contexts.count);
    for (let c = 0; c < ds.contexts.count; c++) {
      const k = ds.contexts.keys[c];
      const mem = ds.contexts.members[c] ? ds.contexts.members[c].map(m => nmap[m]) : null;
      let j = ctxIndex.get(k);
      if (j === undefined) {
        j = ctx.keys.length; ctxIndex.set(k, j);
        ctx.keys.push(k); ctx.names.push(ds.contexts.names[c]); ctx.kinds.push(ds.contexts.kinds[c]);
        ctx.visibility.push(ds.contexts.visibility[c]); ctx.medium.push(ds.contexts.medium[c]); ctx.members.push(mem);
      } else if (mem) {
        ctx.members[j] = [...new Set([...(ctx.members[j] || []), ...mem])];
      }
      cmap[c] = j;
    }
    const soff = sources.length;
    for (const s of ds.meta.sources) sources.push({ ...s, id: sources.length, warnings: s.warnings.map(w => ({ ...w })), counts: { ...s.counts } });
    const e = ds.events;
    for (let i = 0; i < e.count; i++) {
      const k = eo + i;
      E.type[k] = e.type[i]; E.t[k] = e.t[i]; E.actor[k] = nmap[e.actor[i]];
      E.context[k] = e.context[i] >= 0 ? cmap[e.context[i]] : -1;
      E.parent[k] = e.parent[i] >= 0 ? e.parent[i] + eo : -1;
      E.weight[k] = e.weight[i]; E.source[k] = e.source[i] + soff;
      E.tOff[k] = to + e.tOff[i];
      E.text.push(e.text[i]); E.keys.push(e.keys[i]);
      if (E.attrs && e.attrs?.[i]) E.attrs[k] = e.attrs[i];
    }
    for (let j = 0; j < e.tgt.length; j++) { E.tgt[to + j] = nmap[e.tgt[j]]; E.role[to + j] = e.role[j]; }
    eo += e.count; to += e.tgt.length;
    E.tOff[eo] = to;
  }
  if (sources.length > 65535) throw new Error('Too many sources to merge (limit 65535).');
  const out = {
    meta: { name: name || list.map(d => d.meta.name).join(' + '), createdAt: Date.now(), sources, mergedFrom: list.map(d => d.meta.name) },
    nodes: { count: nodes.keys.length, keys: nodes.keys, labels: nodes.labels, attrs: nodes.attrs, isBot: Uint8Array.from(nodes.isBot), platformIds: nodes.platformIds },
    contexts: { count: ctx.keys.length, keys: ctx.keys, names: ctx.names, kinds: ctx.kinds, visibility: Uint8Array.from(ctx.visibility), medium: ctx.medium, members: ctx.members },
    events: { count: total, ...E },
  };
  const merges = list.flatMap(d => d.meta.merges || []);
  if (merges.length) out.meta.merges = merges;
  out.attributeSchema = inferAttributeSchema(out.nodes.attrs);
  out.eventAttributeSchema = inferEventAttributeSchema(out);
  return dedupeSelfTargets(out);
}

// Merging can make an event's actor equal one of its targets (two aliases that
// mailed each other). The builder never stores self targets, so neither do we.
function dedupeSelfTargets(ds) {
  const e = ds.events;
  let dropped = 0;
  const tgt = [], role = [];
  const tOff = new Int32Array(e.count + 1);
  for (let i = 0; i < e.count; i++) {
    const seen = new Set();
    for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) {
      const k = e.tgt[j] + ':' + e.role[j];
      if (e.tgt[j] === e.actor[i] || seen.has(k)) { dropped++; continue; }
      seen.add(k); tgt.push(e.tgt[j]); role.push(e.role[j]);
    }
    tOff[i + 1] = tgt.length;
  }
  if (!dropped) return ds;
  ds.events = { ...e, tOff, tgt: Int32Array.from(tgt), role: Uint8Array.from(role) };
  ds.meta.droppedSelfTargets = (ds.meta.droppedSelfTargets || 0) + dropped;
  return ds;
}

// pairs: [[a, b], ...] or [{ a, b }] (node indices) or [{ keyA, keyB }] (keys).
// The representative of each group is the node that appears in the most events'
// actor field, ties broken by lower index, so the best-attested identity keeps
// its key. Returns a new Dataset.
export function applyMerges(ds, pairs, { note } = {}) {
  const n = ds.nodes.count;
  const idx = new Map(ds.nodes.keys.map((k, i) => [k, i]));
  const resolve = v => (typeof v === 'number' ? v : idx.get(v) ?? -1);
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = x => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const applied = [];
  for (const p of pairs) {
    const a = resolve(Array.isArray(p) ? p[0] : (p.a ?? p.keyA));
    const b = resolve(Array.isArray(p) ? p[1] : (p.b ?? p.keyB));
    if (!(a >= 0 && a < n && b >= 0 && b < n)) throw new Error(`Merge pair refers to an unknown node: ${JSON.stringify(p)}`);
    if (a === b) continue;
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
    applied.push({ a: ds.nodes.keys[a], b: ds.nodes.keys[b], confidence: p.confidence, evidence: p.evidence });
  }
  if (!applied.length) return ds;

  const activity = new Int32Array(n);
  for (let i = 0; i < ds.events.count; i++) activity[ds.events.actor[i]]++;
  const groups = new Map();
  for (let i = 0; i < n; i++) { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); }
  const rep = new Int32Array(n);
  for (const members of groups.values()) {
    let best = members[0];
    for (const m of members) if (activity[m] > activity[best] || (activity[m] === activity[best] && m < best)) best = m;
    for (const m of members) rep[m] = best;
  }
  // New compact numbering, in original order of the representatives.
  const newIndex = new Int32Array(n).fill(-1);
  const keep = [];
  for (let i = 0; i < n; i++) if (rep[i] === i) { newIndex[i] = keep.length; keep.push(i); }
  const map = i => newIndex[rep[i]];

  const nodes = { count: keep.length, keys: [], labels: [], attrs: [], isBot: new Uint8Array(keep.length), platformIds: [] };
  const log = [];
  for (const r of keep) {
    const members = groups.get(find(r)).slice().sort((x, y) => (x === r ? -1 : y === r ? 1 : x - y));
    const attrs = {}, pids = {}, conflicts = [];
    let bot = 0;
    for (const m of members) {
      for (const [k, v] of Object.entries(ds.nodes.attrs[m] || {})) {
        if (!(k in attrs)) attrs[k] = v;
        else if (attrs[k] !== v) conflicts.push({ attr: k, kept: attrs[k], dropped: v, from: ds.nodes.keys[m] });
      }
      for (const [p, v] of Object.entries(ds.nodes.platformIds[m] || {})) {
        if (!(p in pids)) pids[p] = v;
        else if (pids[p] !== v) {
          // Two ids on one platform (two Slack workspaces, two addresses): keep all.
          let s = 2; while (`${p}_${s}` in pids) s++;
          pids[`${p}_${s}`] = v;
        }
      }
      if (ds.nodes.isBot[m]) bot = 1;
    }
    if (members.length > 1) {
      attrs.merged_keys = members.map(m => ds.nodes.keys[m]).join(' | ');
      log.push({ into: ds.nodes.keys[r], from: members.filter(m => m !== r).map(m => ds.nodes.keys[m]), labels: members.map(m => ds.nodes.labels[m]), conflicts });
    }
    const j = nodes.keys.length;
    nodes.keys.push(ds.nodes.keys[r]); nodes.labels.push(ds.nodes.labels[r]); nodes.attrs.push(attrs);
    nodes.platformIds.push(pids); nodes.isBot[j] = bot;
  }

  const e = ds.events;
  const actor = Int32Array.from(e.actor, map);
  const tgt = Int32Array.from(e.tgt, map);
  const contexts = { ...ds.contexts, members: ds.contexts.members.map(m => (m ? [...new Set(m.map(map))] : m)) };
  const sources = ds.meta.sources.map(s => {
    if (!s.egoKey || !idx.has(s.egoKey)) return s;
    return { ...s, egoKey: nodes.keys[map(idx.get(s.egoKey))] };
  });
  const out = {
    ...ds,
    meta: { ...ds.meta, sources, merges: [...(ds.meta.merges || []), { at: Date.now(), note: note || null, pairs: applied, groups: log }] },
    nodes,
    attributeSchema: inferAttributeSchema(nodes.attrs),
    contexts,
    events: { ...e, actor, tgt },
  };
  return dedupeSelfTargets(out);
}
