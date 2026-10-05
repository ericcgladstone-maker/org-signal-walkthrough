// Tools the analyst model may call, over the analysis engine.
//
// The model never sees raw metrics in its prompt. It asks for them through
// these tools, and every number it may cite has to come back from one of them.
// Each result carries an id (T1, T2, ...) so the UI can trace any sentence of
// an answer to the exact call and arguments that produced its numbers.
//
// Handlers take an `engine` object (interface below) plus the Dataset for
// labels and attributes. All engine methods may return values or promises.
// Results are compact JSON: floats rounded to 4 significant digits (so the
// model quotes the same digits the citation check sees), lists capped, long
// strings cut.
//
// Engine interface used here (see docs/api/llm.md; engineFromAnalysis() below
// builds it from the pure functions in src/analysis/index.js):
//   info()                         -> { n, directed, edges: { count }, settings, summary }
//   nodeIds()                      -> Int32Array: network node -> dataset node index
//   networkMetrics()               -> computeNetworkMetrics(net)
//   nodeMetrics({ which })         -> { [metric]: Float64Array by network node }
//   communities({ resolution, seed }) -> { membership, modularity, count }
//   groupMetrics(attrKey)          -> { groups[], mixing, assortativity, eiIndex }
//   egoMetrics(node, { attr })     -> { size, density, effectiveSize, constraint, diversity, homophily }   (node = dataset index)
//   nullModel({ stats, reps, seed }) -> { [stat]: { observed, mean, sd, z, p } }
//   resampleRanks({ metric, reps, top, seed }) -> [{ node, rank, lo, hi, topShare }]
//   applicability()                -> { [metric]: { level, reason } }
//   timeSeries({ window, metrics }) -> { windows[], node{}, network{}, ties{} }
//   affect({ by }) / keywords({ by, k }) / topics({ k, seed })
//   edgeEvidence(a, b, { limit })  -> [event summaries]   (a, b dataset node indices)

export const NODE_METRICS = ['degree', 'inDegree', 'outDegree', 'strength', 'inStrength', 'outStrength', 'betweenness',
  'closeness', 'eigenvector', 'pagerank', 'clustering', 'coreNumber', 'reciprocity', 'constraint', 'effectiveSize', 'egoDensity',
  // Two-mode (affiliation) networks: Borgatti-Everett normalized, per mode.
  'twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering'];
export const NETWORK_STATS = ['density', 'reciprocity', 'transitivity', 'avgClustering', 'components', 'largestComponentShare',
  'avgPathLength', 'degreeCentralization', 'strengthGini', 'modularity', 'assortativity',
  'twoModeDensity', 'robinsAlexander', 'twoModeAvgClustering'];

const MAX_LIST = 50;
const MAX_STR = 240;

// ---- compaction --------------------------------------------------------------

export function round(x) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return Number.isNaN(x) ? null : x;
  if (Number.isInteger(x)) return x;
  return Number(x.toPrecision(4));
}

// Deep copy to plain JSON: typed arrays to arrays, floats rounded, strings and
// lists capped, NaN/undefined to null.
export function compact(v, depth = 0) {
  if (v == null) return null;
  if (typeof v === 'number') return round(v);
  if (typeof v === 'string') return v.length > MAX_STR ? v.slice(0, MAX_STR - 3) + '...' : v;
  if (typeof v === 'boolean') return v;
  if (depth > 6) return '[nested]';
  if (ArrayBuffer.isView(v)) v = Array.from(v);
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_LIST).map(x => compact(x, depth + 1));
    if (v.length > MAX_LIST) out.push(`[${v.length - MAX_LIST} more]`);
    return out;
  }
  if (v instanceof Map) v = Object.fromEntries(v);
  if (typeof v === 'object') {
    const o = {};
    for (const [k, x] of Object.entries(v)) if (x !== undefined && typeof x !== 'function') o[k] = compact(x, depth + 1);
    return o;
  }
  return String(v);
}

// ---- argument validation -----------------------------------------------------

// Small JSON Schema subset validator for our own tool schemas. Tool inputs can
// arrive truncated or malformed (streamed tool arguments are not validated by
// every provider), so nothing runs on input that fails this.
export function validate(schema, value, path = 'input') {
  if (!schema) return null;
  const t = schema.type;
  if (t === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `${path} must be an object`;
    for (const r of schema.required || []) if (value[r] === undefined) return `${path}.${r} is required`;
    for (const [k, v] of Object.entries(value)) {
      const ps = schema.properties?.[k];
      if (!ps) { if (schema.additionalProperties === false) return `${path}.${k} is not a known parameter`; continue; }
      if (v === null && !ps.required) continue;
      const e = validate(ps, v, `${path}.${k}`);
      if (e) return e;
    }
    return null;
  }
  if (t === 'string' && typeof value !== 'string') return `${path} must be a string`;
  if (t === 'integer' && !Number.isInteger(value)) return `${path} must be an integer`;
  if (t === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) return `${path} must be a number`;
  if (t === 'boolean' && typeof value !== 'boolean') return `${path} must be true or false`;
  if (t === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array`;
    if (schema.maxItems != null && value.length > schema.maxItems) return `${path} has too many items`;
    for (let i = 0; i < value.length; i++) { const e = validate(schema.items, value[i], `${path}[${i}]`); if (e) return e; }
  }
  if (schema.enum && !schema.enum.includes(value)) return `${path} must be one of: ${schema.enum.join(', ')}`;
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  return null;
}

// ---- node lookup -------------------------------------------------------------

function netIndexMap(nodeIds) {
  const m = new Map();
  for (let i = 0; i < nodeIds.length; i++) m.set(nodeIds[i], i);
  return m;
}

// Resolve a node reference (namespaced key, exact label, or unique partial
// label) to a dataset index. Ambiguity is an error with candidates, never a guess.
export function resolveNode(ds, ref) {
  const q = String(ref ?? '').trim();
  if (!q) return { error: 'Empty node reference' };
  const keys = ds.nodes.keys;
  const labels = ds.nodes.labels;
  let i = keys.indexOf(q);
  if (i >= 0) return { index: i };
  const lq = q.toLowerCase();
  const exact = [];
  const partial = [];
  for (let j = 0; j < keys.length; j++) {
    const l = String(labels[j] ?? '').toLowerCase();
    if (l === lq || keys[j].toLowerCase() === lq) exact.push(j);
    else if (l.includes(lq) || keys[j].toLowerCase().includes(lq)) partial.push(j);
  }
  if (exact.length === 1) return { index: exact[0] };
  const cands = (exact.length ? exact : partial);
  if (cands.length === 1) return { index: cands[0] };
  if (!cands.length) return { error: `No node matches "${q}". Use search_nodes to find the right key.` };
  return { error: `"${q}" is ambiguous`, candidates: cands.slice(0, 10).map(j => ({ key: keys[j], label: labels[j] })) };
}

function nodeRef(ds, dsIndex) {
  return { key: ds.nodes.keys[dsIndex], label: ds.nodes.labels[dsIndex] };
}

// ---- definitions -------------------------------------------------------------

const nodeParam = { type: 'string', description: 'Node key (e.g. "slack:U012") or exact display label. Use search_nodes first if unsure.' };

export const TOOL_DEFINITIONS = [
  {
    name: 'network_summary',
    description: 'Size, direction, construction settings, data sources and their views (full / ego / chat / sample / authored), and whole-network statistics (density, reciprocity, transitivity, components, path length, centralization). Call this first for any question about the network as a whole.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needs: ['info', 'networkMetrics'],
  },
  {
    name: 'top_nodes',
    description: 'The k highest-ranked nodes on one node metric, optionally restricted to nodes whose attribute equals a value. With uncertainty: true also returns resampled rank intervals and how often each node stays in the top k, which says whether the ranking is stable.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', enum: NODE_METRICS },
        k: { type: 'integer', minimum: 1, maximum: 50, description: 'How many nodes (default 10).' },
        filter: { type: 'object', properties: { attribute: { type: 'string' }, value: { type: 'string' } }, required: ['attribute', 'value'], additionalProperties: false },
        ascending: { type: 'boolean', description: 'Lowest first (e.g. for constraint, where low means brokerage).' },
        uncertainty: { type: 'boolean' },
      },
      required: ['metric'],
      additionalProperties: false,
    },
    needs: ['nodeIds', 'nodeMetrics'],
  },
  {
    name: 'node_profile',
    description: 'One node: attributes, every node metric with its percentile in this network, ego-network measures, and community. Describes structural position only.',
    parameters: { type: 'object', properties: { node: nodeParam }, required: ['node'], additionalProperties: false },
    needs: ['nodeIds', 'nodeMetrics'],
  },
  {
    name: 'group_comparison',
    description: 'Compare groups defined by a node attribute (e.g. department, location): group sizes, within/between tie mixing, attribute assortativity, and the Krackhardt-Stern E-I index.',
    parameters: { type: 'object', properties: { attribute: { type: 'string', description: 'Attribute key from the dataset attribute schema.' } }, required: ['attribute'], additionalProperties: false },
    needs: ['groupMetrics'],
  },
  {
    name: 'communities',
    description: 'Community detection (Louvain): number of communities, modularity, sizes and the most connected members of each.',
    parameters: { type: 'object', properties: { resolution: { type: 'number', minimum: 0.1, maximum: 10 }, seed: { type: 'integer' } }, additionalProperties: false },
    needs: ['communities'],
  },
  {
    name: 'null_model',
    description: 'Compare observed network statistics with degree-preserving randomized networks: observed value, null mean and standard deviation, z-score and p-value. Use before calling any statistic high, low or surprising.',
    parameters: {
      type: 'object',
      properties: { stats: { type: 'array', items: { type: 'string', enum: NETWORK_STATS }, maxItems: 8 }, reps: { type: 'integer', minimum: 10, maximum: 1000 } },
      required: ['stats'],
      additionalProperties: false,
    },
    needs: ['nullModel'],
  },
  {
    name: 'time_series',
    description: 'A metric over time windows, for the whole network or one node, plus how many ties formed and dissolved per window.',
    parameters: {
      type: 'object',
      properties: {
        metric: { type: 'string', description: 'A network statistic or node metric name.' },
        window: { type: 'string', enum: ['day', 'week', 'month', 'quarter', 'year'] },
        node: nodeParam,
      },
      required: ['metric', 'window'],
      additionalProperties: false,
    },
    needs: ['timeSeries'],
  },
  {
    name: 'content_summary',
    description: 'Content measures from message text: affect (VADER sentiment), keywords, or topics, for the whole network or broken down by node, group attribute, context or time.',
    parameters: {
      type: 'object',
      properties: {
        measure: { type: 'string', enum: ['affect', 'keywords', 'topics'] },
        by: { type: 'string', enum: ['network', 'node', 'group', 'context', 'visibility', 'time'] },
        target: { type: 'string', description: 'For by=group: the attribute key to group by (defaults to the first categorical attribute). For by=node: a node to focus on.' },
        window: { type: 'string', enum: ['day', 'week', 'month'], description: 'For by=time: window size (default week).' },
        k: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['measure'],
      additionalProperties: false,
    },
    needs: [],
  },
  {
    name: 'edge_evidence',
    description: 'The events behind the tie between two nodes (time, type, rule, context, short text excerpt), so a tie can be traced to its evidence.',
    parameters: { type: 'object', properties: { a: nodeParam, b: nodeParam, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['a', 'b'], additionalProperties: false },
    needs: ['edgeEvidence'],
  },
  {
    name: 'applicability',
    description: 'Which measures are meaningful for this kind of data (ok / caution / not applicable) and why, given the source views. Check before interpreting centrality on ego, chat, sample or authored data.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    needs: ['applicability'],
  },
  {
    name: 'search_nodes',
    description: 'Find nodes by part of their key, label or an attribute value. Returns keys to use in other tools.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 50 } }, required: ['query'], additionalProperties: false },
    needs: [],
  },
];

const CONTENT_METHODS = { affect: 'affect', keywords: 'keywords', topics: 'topics' };

// Tools whose engine methods exist; the model is never offered a dead tool.
export function availableTools(engine) {
  return TOOL_DEFINITIONS.filter(t => {
    if (t.name === 'content_summary') return Object.values(CONTENT_METHODS).some(m => typeof engine?.[m] === 'function');
    return t.needs.every(m => typeof engine?.[m] === 'function');
  });
}

// Strip internal fields: what a provider adapter sends.
export function publicDefinitions(defs) {
  return defs.map(({ name, description, parameters }) => ({ name, description, parameters }));
}

// ---- handlers ----------------------------------------------------------------

// The engine's result also carries a `meta` key (approximation flags); keep only metric arrays.
async function metricsFor(engine, which) {
  const m = (await engine.nodeMetrics({ which })) || {};
  return Object.fromEntries(Object.entries(m).filter(([, v]) => ArrayBuffer.isView(v) || Array.isArray(v)));
}

function percentile(arr, v) {
  if (!Number.isFinite(v)) return null;
  let le = 0, n = 0;
  for (const x of arr) { if (!Number.isFinite(x)) continue; n++; if (x <= v) le++; }
  return n ? le / n : null;
}

const HANDLERS = {
  async network_summary({ engine, ds }) {
    const info = (await engine.info()) || {};
    const metrics = (await engine.networkMetrics()) || {};
    const sources = (ds?.meta?.sources || []).map(s => ({
      format: s.format, medium: s.medium, view: s.view, context: s.context, egoKey: s.egoKey || undefined,
      warnings: (s.warnings || []).reduce((a, w) => a + (w.count || 1), 0),
    }));
    const views = [...new Set(sources.map(s => s.view))];
    return {
      nodes: info.n, edges: info.edges?.count ?? info.edgeCount, directed: !!info.directed,
      datasetNodes: ds?.nodes?.count, events: ds?.events?.count,
      views, sources,
      settings: info.settings ? summarizeSettings(info.settings) : undefined,
      metrics,
    };
  },

  async top_nodes({ engine, ds }, { metric, k = 10, filter, ascending = false, uncertainty = false }) {
    const nodeIds = await engine.nodeIds();
    const vals = (await metricsFor(engine, [metric]))[metric];
    if (!vals) return { error: `Metric ${metric} is not available for this network.` };
    let idx = [];
    for (let i = 0; i < vals.length; i++) {
      if (!Number.isFinite(vals[i])) continue;
      if (filter) {
        const a = ds.nodes.attrs[nodeIds[i]]?.[filter.attribute];
        if (a == null || String(a).toLowerCase() !== String(filter.value).toLowerCase()) continue;
      }
      idx.push(i);
    }
    idx.sort((x, y) => (ascending ? vals[x] - vals[y] : vals[y] - vals[x]));
    const eligible = idx.length;
    idx = idx.slice(0, k);
    const out = {
      metric, order: ascending ? 'ascending' : 'descending', eligibleNodes: eligible, filter: filter || undefined,
      nodes: idx.map((i, r) => ({ rank: r + 1, ...nodeRef(ds, nodeIds[i]), value: vals[i] })),
    };
    if (typeof engine.applicability === 'function') {
      const ap = (await engine.applicability())?.[metric];
      if (ap) out.applicability = ap;
    }
    if (uncertainty && typeof engine.resampleRanks === 'function' && !filter) {
      const rr = await engine.resampleRanks({ metric, top: k, reps: 100, seed: 1 });
      const byNode = new Map((rr || []).map(r => [r.node, r]));
      for (const n of out.nodes) {
        const di = ds.nodes.keys.indexOf(n.key);
        const r = byNode.get(di) ?? byNode.get(n.key);
        if (r) Object.assign(n, { rankLow: r.lo, rankHigh: r.hi, topShare: r.topShare });
      }
      out.uncertaintyMethod = 'resampled ranks, 100 replicates';
    }
    return out;
  },

  async node_profile({ engine, ds }, { node }) {
    const r = resolveNode(ds, node);
    if (r.error) return r;
    const nodeIds = await engine.nodeIds();
    const ni = netIndexMap(nodeIds).get(r.index);
    const base = { ...nodeRef(ds, r.index), attributes: ds.nodes.attrs[r.index], isBot: !!ds.nodes.isBot?.[r.index] };
    if (ni === undefined) return { ...base, inNetwork: false, note: 'This node is in the data but not in the current network (filtered out or isolated).' };
    const all = await metricsFor(engine, NODE_METRICS);
    const metrics = {};
    for (const [m, arr] of Object.entries(all)) {
      if (!arr || arr.length <= ni) continue;
      metrics[m] = { value: arr[ni], percentile: percentile(arr, arr[ni]) };
    }
    const out = { ...base, inNetwork: true, metrics };
    if (typeof engine.egoMetrics === 'function') out.ego = await engine.egoMetrics(r.index); // dataset index
    if (typeof engine.communities === 'function') {
      const c = await engine.communities({});
      if (c?.membership) out.community = c.membership[ni];
    }
    return out;
  },

  async group_comparison({ engine, ds }, { attribute }) {
    const schema = ds?.attributeSchema || [];
    if (schema.length && !schema.some(a => a.key === attribute)) {
      return { error: `Unknown attribute "${attribute}".`, attributes: schema.map(a => a.key) };
    }
    const g = await engine.groupMetrics(attribute);
    return { attribute, ...g };
  },

  async communities({ engine, ds }, { resolution = 1, seed = 1 }) {
    const c = await engine.communities({ resolution, seed });
    const nodeIds = await engine.nodeIds();
    const sizes = new Map();
    const members = new Map();
    let deg = null;
    try { deg = (await metricsFor(engine, ['degree'])).degree; } catch { deg = null; }
    for (let i = 0; i < c.membership.length; i++) {
      const k = c.membership[i];
      sizes.set(k, (sizes.get(k) || 0) + 1);
      if (!members.has(k)) members.set(k, []);
      members.get(k).push(i);
    }
    const list = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([id, size]) => {
      const ms = members.get(id);
      if (deg) ms.sort((a, b) => deg[b] - deg[a]);
      return { community: id, size, share: size / c.membership.length, topMembers: ms.slice(0, 5).map(i => nodeRef(ds, nodeIds[i]).label) };
    });
    return { method: 'Louvain', resolution, seed, count: c.count ?? sizes.size, modularity: c.modularity, communities: list.slice(0, 20) };
  },

  // Without an explicit count the engine's default (200) is used, so the
  // analyst shares the cached run the views show instead of computing a
  // second, different one.
  async null_model({ engine }, { stats, reps }) {
    const r = await engine.nullModel({ stats, ...(reps ? { reps } : {}), seed: 1 });
    return { method: 'degree-preserving rewiring', reps: r?.meta?.reps ?? reps ?? null, results: r };
  },

  async time_series({ engine, ds }, { metric, window, node }) {
    const ts = await engine.timeSeries({ window, metrics: [metric] });
    const windows = (ts?.windows || []).map(w => (typeof w === 'object' ? { start: iso(w.start), end: iso(w.end) } : w));
    const out = { metric, window, windows };
    if (node) {
      const r = resolveNode(ds, node);
      if (r.error) return r;
      const series = ts?.node?.[metric];
      let values = null;
      if (series && !Array.isArray(series) && typeof series === 'object' && !ArrayBuffer.isView(series)) {
        values = series[ds.nodes.keys[r.index]] ?? series[r.index] ?? null;
      } else if (Array.isArray(series)) {
        // Per-window arrays indexed by dataset node.
        values = series.map(w => (w ? w[r.index] : null));
      }
      out.node = nodeRef(ds, r.index);
      out.values = values;
      if (values == null) out.note = 'No per-node series for this metric.';
    } else {
      out.values = ts?.network?.[metric] ?? null;
      if (out.values == null) out.note = 'No network-level series for this metric.';
    }
    const t = ts?.ties || {};
    const count = x => (Array.isArray(x) || ArrayBuffer.isView(x) ? Array.from(x, y => (Array.isArray(y) ? y.length : y)) : undefined);
    out.tiesFormed = count(t.formed);
    out.tiesDissolved = count(t.dissolved);
    return out;
  },

  async content_summary({ engine, ds }, { measure, by = 'network', target, window = 'week', k = 10 }) {
    const fn = engine[CONTENT_METHODS[measure]];
    if (typeof fn !== 'function') return { error: `${measure} is not available.` };
    // Map the tool's vocabulary onto the analysis API's `by` units.
    const opts = { by: { network: 'overall', node: 'node', group: 'group', context: 'context', visibility: 'visibility', time: 'window' }[by] };
    if (by === 'group') {
      const attr = target || (ds.attributeSchema || []).find(a => a.type === 'categorical')?.key;
      if (!attr) return { error: 'Grouping needs a categorical node attribute, and this dataset has none.' };
      opts.attr = attr;
    }
    if (by === 'time') opts.window = window;
    let r;
    if (measure === 'topics') r = await fn.call(engine, { k, seed: 1, ...(opts.attr ? { attr: opts.attr } : {}), ...(opts.window ? { window: opts.window } : {}) });
    else if (measure === 'keywords') r = await fn.call(engine, { ...opts, k });
    else r = await fn.call(engine, opts);
    let out = r;
    // Narrow to one node when asked. Node rows are keyed by dataset index.
    if (by === 'node' && target && r && typeof r === 'object') {
      const n = resolveNode(ds, target);
      if (n.error) return n;
      const rows = r.groups || r.by?.node || r.units || r.byNode || [];
      const hit = rows.find(x => x.key === n.index);
      out = hit ? { node: nodeRef(ds, n.index), value: hit } : { node: nodeRef(ds, n.index), note: 'No text from this node in the data.' };
    }
    return { measure, by, target: opts.attr || target, method: measure === 'affect' ? 'VADER (Hutto & Gilbert 2014); lexicon-based, approximate' : undefined, result: out };
  },

  async edge_evidence({ engine, ds }, { a, b, limit = 10 }) {
    const ra = resolveNode(ds, a); if (ra.error) return ra;
    const rb = resolveNode(ds, b); if (rb.error) return rb;
    const ev = await engine.edgeEvidence(ra.index, rb.index, { limit });
    return { a: nodeRef(ds, ra.index), b: nodeRef(ds, rb.index), shown: Math.min(limit, ev?.length || 0), events: (ev || []).slice(0, limit).map(e => ({ ...e, t: e.t != null ? iso(e.t) : undefined })) };
  },

  async applicability({ engine, ds }) {
    const ap = await engine.applicability();
    const views = [...new Set((ds?.meta?.sources || []).map(s => s.view))];
    return { views, measures: ap };
  },

  async search_nodes({ ds }, { query, limit = 10 }) {
    const q = String(query).toLowerCase();
    const hits = [];
    for (let i = 0; i < ds.nodes.count && hits.length < limit; i++) {
      const key = ds.nodes.keys[i], label = String(ds.nodes.labels[i] ?? '');
      const attrs = ds.nodes.attrs[i] || {};
      const attrHit = Object.entries(attrs).find(([, v]) => String(v).toLowerCase().includes(q));
      if (key.toLowerCase().includes(q) || label.toLowerCase().includes(q) || attrHit) {
        hits.push({ key, label, matched: attrHit ? `${attrHit[0]}=${attrHit[1]}` : undefined });
      }
    }
    return { query, matches: hits };
  },
};

function iso(t) {
  if (typeof t !== 'number' || !Number.isFinite(t)) return t ?? null;
  return new Date(t).toISOString().slice(0, 10);
}

export function summarizeSettings(s) {
  const rules = Object.entries(s.rules || {}).filter(([, r]) => r?.on).map(([k, r]) => (r.weight != null && r.weight !== 1 ? `${k} x${r.weight}` : k));
  return {
    rules, directed: s.directed, weighting: s.weighting, minWeight: s.minWeight, maxRecipients: s.maxRecipients,
    time: s.time ? { start: iso(s.time.start), end: iso(s.time.end) } : undefined,
    excludeBots: s.excludeBots, includeIsolates: s.includeIsolates,
  };
}

// ---- runner ------------------------------------------------------------------

// createToolRunner({ engine, dataset }) -> { definitions, run(name, args), results, resetTurn() }
// Ids keep increasing for the life of the runner so a citation in any earlier
// answer still points at a unique result.
export function createToolRunner({ engine, dataset, idPrefix = 'T' }) {
  const defs = availableTools(engine);
  const byName = new Map(defs.map(d => [d.name, d]));
  let n = 0;
  const all = [];
  let turn = [];
  return {
    definitions: publicDefinitions(defs),
    get results() { return all; },
    get turnResults() { return turn; },
    resetTurn() { turn = []; },
    // Returns { id, name, args, result, error, content } where content is the
    // JSON text handed back to the model.
    async run(name, args, { invalidArguments } = {}) {
      n += 1;
      const id = `${idPrefix}${n}`;
      const rec = { id, name, args: args || {}, result: null, error: null };
      const def = byName.get(name);
      if (!def) rec.error = `Unknown tool ${name}`;
      else if (invalidArguments != null) rec.error = `Arguments were not valid JSON: ${String(invalidArguments).slice(0, 200)}`;
      else {
        const e = validate(def.parameters, args || {});
        if (e) rec.error = e;
      }
      if (!rec.error) {
        try {
          const r = await HANDLERS[name]({ engine, ds: dataset }, args || {});
          if (r && r.error) rec.error = r.error, rec.result = compact(r);
          else rec.result = compact(r);
        } catch (err) {
          rec.error = `Tool failed: ${err?.message || err}`;
        }
      }
      rec.content = JSON.stringify(rec.error ? { result_id: id, error: rec.error, ...(rec.result || {}) } : { result_id: id, ...rec.result });
      all.push(rec);
      turn.push(rec);
      return rec;
    },
  };
}

// ---- adapter from the pure analysis API --------------------------------------

// Builds the engine interface above from src/analysis/index.js functions and a
// Dataset + Network already in hand (main thread or inside a worker). Results
// that do not depend on arguments are memoized for the life of the adapter.
export function engineFromAnalysis(analysis, ds, net) {
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, f()); return memo.get(k); };
  const a = analysis;
  const e = {
    info: () => ({ n: net.n, directed: net.directed, edges: { count: net.edges?.count }, settings: net.settings, summary: net.summary }),
    nodeIds: () => net.nodeIds,
    networkMetrics: () => once('net', () => a.computeNetworkMetrics(net)),
    nodeMetrics: ({ which }) => {
      const out = {};
      const missing = which.filter(m => !memo.has('m:' + m));
      if (missing.length) {
        const r = a.computeNodeMetrics(net, { which: missing });
        for (const m of missing) memo.set('m:' + m, r?.[m]);
      }
      for (const m of which) if (memo.get('m:' + m)) out[m] = memo.get('m:' + m);
      return out;
    },
  };
  if (a.detectCommunities) e.communities = (o = {}) => once(`c:${o.resolution ?? 1}:${o.seed ?? 1}`, () => a.detectCommunities(net, { resolution: o.resolution ?? 1, seed: o.seed ?? 1 }));
  if (a.groupMetrics) e.groupMetrics = attr => a.groupMetrics(net, ds, attr);
  if (a.egoMetrics) e.egoMetrics = (node, o = {}) => a.egoMetrics(net, node, { ds, ...o });
  if (a.nullModel) e.nullModel = o => a.nullModel(net, { ds, ...o });
  if (a.resampleRanks) e.resampleRanks = o => a.resampleRanks(ds, net.settings, o);
  if (a.applicability) e.applicability = () => once('ap', () => a.applicability(ds, net));
  if (a.timeSeries) e.timeSeries = o => a.timeSeries(ds, net.settings, o);
  if (a.affect) e.affect = o => a.affect(ds, o);
  if (a.keywords) e.keywords = o => a.keywords(ds, o);
  if (a.topics) e.topics = o => a.topics(ds, o);
  if (a.edgeEvidence) e.edgeEvidence = (x, y, o) => a.edgeEvidence(ds, net, x, y, o);
  return e;
}
