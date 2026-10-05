// The stateful side of the engine: holds the dataset, the current network and
// small caches, and dispatches method calls to the pure functions. It runs
// inside the analysis worker, or inline on the main thread / in Node
// (createEngine({ worker: false })). Both paths use exactly this code.

import { defaultSettings, normalizeSettings, buildNetwork, edgeEvidence, RULES, RULE_INFO } from './construct.js';
import { computeNodeMetrics } from './metrics.js';
import { computeNetworkMetrics } from './network.js';
import { detectCommunities } from './communities.js';
import { groupMetrics, egoMetrics } from './groups.js';
import { nullModel, resampleRanks } from './uncertainty.js';
import { applicability } from './applicability.js';
import { timeSeries, detectShifts, compareBeforeAfter } from './time.js';
import { affect, keywords, topics, diffusion } from './content/index.js';
import { graphForRender } from './render.js';
import { GLOSSARY } from './glossary.js';

export function createHost() {
  const st = { ds: null, net: null, settings: null, membership: null, positions: new Map(), render: null };
  const needDs = () => { if (!st.ds) throw new Error('No dataset loaded: call load(ds) first.'); return st.ds; };
  const needNet = () => {
    if (!st.net) { needDs(); st.settings = defaultSettings(st.ds); st.net = buildNetwork(st.ds, st.settings); }
    return st.net;
  };
  const withP = (opts, progress) => ({ ...(opts || {}), onProgress: progress });
  const netInfo = (net) => ({ n: net.n, directed: net.directed, nodeIds: net.nodeIds, summary: net.summary, settings: net.settings, ...(net.twoMode ? { twoMode: net.twoMode } : {}) });

  const methods = {
    load(progress, ds) {
      st.ds = ds; st.net = null; st.settings = null; st.membership = null; st.render = null;
      return { nodes: ds.nodes.count, events: ds.events.count, contexts: ds.contexts.count };
    },
    defaultSettings() { return defaultSettings(needDs()); },
    rules() { return { rules: RULES, info: RULE_INFO }; },
    glossary() { return GLOSSARY; },
    build(progress, settings) {
      const ds = needDs();
      st.settings = normalizeSettings(ds, settings || defaultSettings(ds));
      st.net = buildNetwork(ds, st.settings);
      st.membership = null; st.render = null;
      return netInfo(st.net);
    },
    network(progress, { edges = false } = {}) {
      const net = needNet();
      const info = netInfo(net);
      if (edges) info.edges = net.edges;
      return info;
    },
    nodeMetrics(progress, opts) { return computeNodeMetrics(needNet(), withP(opts, progress)); },
    networkMetrics(progress, opts) { return computeNetworkMetrics(needNet(), withP(opts, progress)); },
    communities(progress, opts) { const r = detectCommunities(needNet(), opts); st.membership = r.membership; return r; },
    groups(progress, attr, opts) { return groupMetrics(needNet(), needDs(), attr, opts); },
    ego(progress, node, opts) { return egoMetrics(needNet(), node, { ds: needDs(), ...(opts || {}) }); },
    nullModel(progress, opts = {}) {
      const net = needNet();
      return nullModel(net, { ds: needDs(), membership: opts.membership ?? st.membership ?? undefined, ...withP(opts, progress) });
    },
    resampleRanks(progress, opts) { needNet(); return resampleRanks(needDs(), st.settings, withP(opts, progress)); },
    applicability() { return applicability(needDs(), needNet()); },
    timeSeries(progress, opts) { needNet(); return timeSeries(needDs(), st.settings, withP(opts, progress)); },
    detectShifts(progress, series, opts) { return detectShifts(series, { labels: st.ds?.nodes.labels, ...(opts || {}) }); },
    compareBeforeAfter(progress, date, opts) { needNet(); return compareBeforeAfter(needDs(), st.settings, date, withP(opts, progress)); },
    affect(progress, opts) { return affect(needDs(), withP(opts, progress)); },
    keywords(progress, opts) { return keywords(needDs(), opts); },
    topics(progress, opts) { return topics(needDs(), withP(opts, progress)); },
    diffusion(progress, opts) { return diffusion(needDs(), needNet(), opts); },
    edgeEvidence(progress, a, b, opts) { return edgeEvidence(needDs(), needNet(), a, b, opts); },
    graphForRender(progress, opts = {}) {
      const net = needNet();
      const key = JSON.stringify({ maxNodes: opts.maxNodes, maxEdges: opts.maxEdges, layout: opts.layout, iterations: opts.iterations, seed: opts.seed, arrange: opts.arrange });
      // Same network, same options: return the same picture.
      if (st.render && st.render.net === net && st.render.key === key) return st.render.result;
      const r = graphForRender(net, { ...opts, previous: st.positions, labels: st.ds.nodes.labels });
      if (r.nodes.x) for (let i = 0; i < r.nodes.count; i++) st.positions.set(r.nodes.ids[i], [r.nodes.x[i], r.nodes.y[i]]);
      st.render = { net, key, result: r };
      return r;
    },
    resetLayout() { st.positions.clear(); st.render = null; return true; },
    // Aliases matching the interface src/llm/tools.js expects.
    info() { const net = needNet(); return { n: net.n, directed: net.directed, edges: { count: net.edges.count }, settings: net.settings, summary: net.summary, ...(net.twoMode ? { twoMode: net.twoMode } : {}) }; },
    nodeIds() { return needNet().nodeIds; },
    groupMetrics(progress, attr, opts) { return groupMetrics(needNet(), needDs(), attr, opts); },
    egoMetrics(progress, node, opts) { return egoMetrics(needNet(), node, { ds: needDs(), ...(opts || {}) }); },
  };

  return {
    methods: Object.keys(methods),
    state: st,
    call(method, args = [], progress = () => {}) {
      const fn = methods[method];
      if (!fn) throw new Error(`Unknown analysis method: ${method}`);
      return fn(progress, ...args);
    },
  };
}

// Wire a host to a worker scope (self in a module worker, or a test double).
// Protocol: in  { id, method, args }
//           out { id, type: 'progress', fraction, message } | { id, type: 'result', result } | { id, type: 'error', error: { name, message, stack } }
export function attachWorker(scope) {
  const host = createHost();
  scope.onmessage = (e) => {
    const { id, method, args } = e.data || {};
    let last = 0;
    const progress = (fraction, message) => {
      const now = Date.now();
      if (fraction < 1 && now - last < 50) return;
      last = now;
      scope.postMessage({ id, type: 'progress', fraction, message });
    };
    try {
      const result = host.call(method, args, progress);
      scope.postMessage({ id, type: 'result', result });
    } catch (err) {
      scope.postMessage({ id, type: 'error', error: { name: err.name, message: err.message, stack: err.stack } });
    }
  };
  return host;
}
