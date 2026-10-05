// Adapter over the optional LLM layer (owner: llm).
//
//   src/llm/providers/index.js  providerList: [{ id, label, defaultModel, keyPlaceholder, keyUrl,
//                               listModels({ key, signal }), chat({...}) }]
//   src/llm/keys.js             createKeyStore() -> { get, set(provider, key, { remember }), forget,
//                               isRemembered, canRemember }; maskKey(key)
//   src/llm/analyst.js          createAnalyst({ provider, key, model, engine, dataset })
//                               -> { ask(question, { onText, onToolCall, onToolResult, signal }) }
//                               ask resolves { text, citations, unverifiedNumbers, toolResults, usage }
//   src/llm/reports.js          writeReport({ scope, target, provider, key, model, engine, dataset, onText, signal })
//   src/llm/coding.js           validateCodebook, sampleMessages, estimateCoding, codeMessages
//   src/llm/estimate.js         estimateAsk, formatUSD
//   src/llm/methods.js          buildMethodsAppendix(input) -> markdown (deterministic, no LLM)
//
// The analyst and report writer call analysis tools through an "engine"
// object with the interface documented in src/llm/tools.js. analystEngine()
// below builds it from the UI's engine adapter so the LLM sees exactly the
// numbers the views show. tools.js passes dataset node indices throughout,
// as src/analysis expects; edgeEvidence is unwrapped to the array tools.js reads.

import { MOCK, tryImport, pickFn } from './modules.js';
import { engine } from './engine.js';
import { store } from '../store.js';

let keyStore = null;
const memKeys = new Map();

export async function llmModules() {
  const [providers, keys, analyst, reports, coding, estimate, tools] = await Promise.all([
    tryImport('../../llm/providers/index.js'), tryImport('../../llm/keys.js'), tryImport('../../llm/analyst.js'),
    tryImport('../../llm/reports.js'), tryImport('../../llm/coding.js'), tryImport('../../llm/estimate.js'), tryImport('../../llm/tools.js'),
  ]);
  return { providers, keys, analyst, reports, coding, estimate, tools };
}

export async function providerList() {
  const m = await tryImport('../../llm/providers/index.js');
  const list = m?.providerList ? [...m.providerList] : [];
  // Under ?mock only: an offline provider whose chat() follows the provider
  // contract, so the REAL analyst, citation check, reports and coding run
  // end to end in QA without a network or a key.
  if (MOCK) list.unshift(demoProvider);
  return list;
}

async function ensureKeyStore() {
  if (keyStore) return keyStore;
  const k = await tryImport('../../llm/keys.js');
  const create = pickFn(k, ['createKeyStore']);
  keyStore = create ? create() : {
    canRemember: () => false,
    get: p => memKeys.get(p) ?? null,
    set: (p, key) => { memKeys.set(p, key); return true; },
    forget: p => { memKeys.delete(p); return false; },
    isRemembered: () => false,
  };
  return keyStore;
}

export async function getKey(provider) { return (await ensureKeyStore()).get(provider); }
export async function setKey(provider, key, remember) { return (await ensureKeyStore()).set(provider, key, { remember }); }
export async function forgetKey(provider) { return (await ensureKeyStore()).forget(provider); }
export async function isRemembered(provider) { return (await ensureKeyStore()).isRemembered(provider); }
export async function canRemember() { return (await ensureKeyStore()).canRemember(); }

export async function maskKey(key) {
  const k = await tryImport('../../llm/keys.js');
  const fn = pickFn(k, ['maskKey']);
  if (fn) return fn(key);
  return key ? `${String(key).slice(0, 3)}...${String(key).slice(-4)}` : '';
}

export async function redact(text) {
  const k = await tryImport('../../llm/keys.js');
  const fn = pickFn(k, ['redact']);
  return fn ? fn(text) : text;
}

// ---- names to codes -------------------------------------------------------------------
// The Ask view's "Replace names with codes" option (D8). The LLM layer reads
// people's names and keys from the dataset it is given and message excerpts,
// keywords and topics from the engine, so the swap happens here, at the
// boundary: the model gets a copy of the dataset whose keys and labels are
// codes (P1, P2, ...) with identifying attributes left out, and every free
// text it can receive (tie evidence, content summaries, the question) has the
// dataset's names replaced by codes and email addresses removed. Answers come
// back in codes and are turned into names on this computer (decodeNames).
// Matching is by the names in the data: nicknames, misspellings and people
// outside the data are not caught, which the view says.

const IDENTIFYING_ATTR = /(^|_|\b)(name|first|last|full|email|e-mail|mail|phone|mobile|manager|reports?_?to|supervisor|address|login|user(name)?|handle|ssn|employee_?id|id)(\b|_|$)/i;
const EMAIL_RE = /[\w.+-]+@[\w-]+(\.[\w-]+)+/g;
const coded = new WeakMap();

const esc = x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function codeFor(i) { return `P${i + 1}`; }

// { ds (coded copy), scrub(text), encodeQuestion(text), codeKey(dsIndex), labels }
export function pseudonymize(ds) {
  if (coded.has(ds)) return coded.get(ds);
  const n = ds.nodes.count;
  const codes = Array.from({ length: n }, (_, i) => codeFor(i));
  // Full names (case-insensitive) map to their person; single name parts
  // (case-sensitive, as written in the data) map to their person when only one
  // person has that part, otherwise to a neutral "[name]".
  const full = new Map(), parts = new Map();
  for (let i = 0; i < n; i++) {
    const label = String(ds.nodes.labels[i] ?? '').trim();
    const key = String(ds.nodes.keys[i] ?? '');
    const local = key.slice(key.indexOf(':') + 1);
    for (const f of [label, local]) if (f.length >= 3 && !/^P\d+$/.test(f)) full.set(f.toLowerCase(), full.has(f.toLowerCase()) && full.get(f.toLowerCase()) !== codes[i] ? '[name]' : codes[i]);
    for (const w of label.split(/[^\p{L}'-]+/u)) {
      if (w.length < 3) continue;
      parts.set(w, parts.has(w) && parts.get(w) !== codes[i] ? '[name]' : codes[i]);
    }
  }
  const fullRe = full.size ? new RegExp(`(?<![\\p{L}\\p{N}])(${[...full.keys()].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'giu') : null;
  const partRe = parts.size ? new RegExp(`(?<![\\p{L}\\p{N}])(${[...parts.keys()].sort((a, b) => b.length - a.length).map(esc).join('|')})(?![\\p{L}\\p{N}])`, 'gu') : null;
  const memo = new Map();
  const scrub = (text) => {
    if (typeof text !== 'string' || !text) return text;
    if (memo.has(text)) return memo.get(text);
    let t = text.replace(EMAIL_RE, '[email]');
    if (fullRe) t = t.replace(fullRe, m => full.get(m.toLowerCase()) || '[name]');
    if (partRe) t = t.replace(partRe, m => parts.get(m) || '[name]');
    if (memo.size < 50000) memo.set(text, t);
    return t;
  };
  const schema = (ds.attributeSchema || []).filter(a => !IDENTIFYING_ATTR.test(a.key));
  const keep = new Set(schema.map(a => a.key));
  const attrs = Array.from({ length: n }, (_, i) => {
    const o = {};
    for (const [k, v] of Object.entries(ds.nodes.attrs?.[i] || {})) if (keep.has(k) && !(typeof v === 'string' && v.includes('@'))) o[k] = v;
    return o;
  });
  const keyIndex = new Map(ds.nodes.keys.map((k, i) => [k, i]));
  const sources = (ds.meta?.sources || []).map(src => ({
    ...src, fileNames: [], warnings: [],
    egoKey: src.egoKey && keyIndex.has(src.egoKey) ? codes[keyIndex.get(src.egoKey)] : undefined,
    egoKeys: undefined,
  }));
  // Message text is scrubbed lazily, on the few events the LLM layer reads
  // (content coding samples), not across the whole dataset.
  const text = ds.events?.text ? new Proxy(ds.events.text, { get: (t, p) => (typeof p === 'string' && /^\d+$/.test(p) ? scrub(t[p]) : Reflect.get(t, p)) }) : ds.events?.text;
  const out = {
    ds: {
      ...ds,
      meta: { ...ds.meta, name: 'Dataset', sources },
      nodes: { ...ds.nodes, keys: codes, labels: codes, attrs, platformIds: codes.map(() => ({})) },
      attributeSchema: schema,
      contexts: ds.contexts ? { ...ds.contexts, names: (ds.contexts.names || []).map(scrub) } : ds.contexts,
      events: ds.events ? { ...ds.events, text } : ds.events,
    },
    scrub,
    encodeQuestion: scrub,
    codeKey: i => codes[i],
    labels: ds.nodes.labels,
  };
  coded.set(ds, out);
  return out;
}

// Codes in an answer back to the names they stand for (local only).
export function decodeNames(text, ds) {
  if (!text || !ds) return text;
  return String(text).replace(/\bP(\d{1,7})\b/g, (m, d) => { const l = ds.nodes.labels[Number(d) - 1]; return l != null ? String(l) : m; });
}

// Deep copy with every string scrubbed (content summaries: terms, topics).
function scrubDeep(v, scrub, depth = 0) {
  if (typeof v === 'string') return scrub(v);
  if (v == null || typeof v !== 'object' || depth > 8 || ArrayBuffer.isView(v)) return v;
  if (Array.isArray(v)) return v.map(x => scrubDeep(x, scrub, depth + 1));
  const o = {};
  for (const [k, x] of Object.entries(v)) o[k] = scrubDeep(x, scrub, depth + 1);
  return o;
}

// The tools.js engine interface, built over the UI engine adapter.
// With `codes` (from pseudonymize), every text the engine returns is scrubbed
// and per-person series keyed by real keys are re-keyed by code.
export function analystEngine(codes = null) {
  const base = plainAnalystEngine();
  if (!codes) return base;
  const ds = store.get().dataset;
  const keyIndex = ds ? new Map(ds.nodes.keys.map((k, i) => [k, i])) : new Map();
  const content = fn => async o => scrubDeep(await fn(o), codes.scrub);
  return {
    ...base,
    affect: content(base.affect), keywords: content(base.keywords), topics: content(base.topics),
    edgeEvidence: async (a, b, o) => (await base.edgeEvidence(a, b, o)).map(e => ({
      ...e, actorLabel: Number.isInteger(e.actor) ? codes.codeKey(e.actor) : codes.scrub(e.actorLabel), context: codes.scrub(e.context), text: codes.scrub(e.text),
    })),
    timeSeries: async o => {
      const ts = await base.timeSeries(o);
      if (!ts?.node) return ts;
      const node = {};
      for (const [m, series] of Object.entries(ts.node)) {
        if (series && typeof series === 'object' && !Array.isArray(series) && !ArrayBuffer.isView(series)) {
          const re = {};
          for (const [k, v] of Object.entries(series)) re[keyIndex.has(k) ? codes.codeKey(keyIndex.get(k)) : k] = v;
          node[m] = re;
        } else node[m] = series;
      }
      return { ...ts, node };
    },
  };
}

function plainAnalystEngine() {
  const memo = new Map();
  const once = (k, f) => { if (!memo.has(k)) memo.set(k, Promise.resolve(f())); return memo.get(k); };
  return {
    info: () => {
      const net = store.get().network;
      return { n: net?.n, directed: net?.directed, edges: { count: net?.edgeCount }, settings: store.get().settings, summary: net?.summary };
    },
    nodeIds: () => store.get().network?.nodeIds,
    networkMetrics: () => once('net', () => engine.networkMetrics()),
    nodeMetrics: async ({ which }) => {
      const have = store.get().metrics?.node || {};
      const missing = which.filter(m => !have[m]);
      const extra = missing.length ? await engine.nodeMetrics({ which: missing }) : {};
      const out = {};
      for (const m of which) if (have[m] || extra[m]) out[m] = have[m] || extra[m];
      return out;
    },
    communities: (o = {}) => once(`c:${o.resolution ?? 1}:${o.seed ?? 1}`, () => engine.communities(o)),
    groupMetrics: attr => engine.groups(attr),
    egoMetrics: (dsNode, o = {}) => engine.ego(dsNode, o),
    nullModel: o => engine.nullModel(o),
    resampleRanks: async o => { const r = await engine.resampleRanks(o); return Array.isArray(r) ? r : r?.nodes ?? []; },
    applicability: () => once('ap', () => engine.applicability()),
    timeSeries: o => engine.timeSeries(o),
    affect: o => engine.affect(o),
    keywords: o => engine.keywords(o),
    topics: o => engine.topics(o),
    edgeEvidence: async (a, b, o) => { const r = await engine.edgeEvidence(a, b, o); return r?.events ?? r ?? []; },
  };
}

// With codes: true the session sees the coded dataset; ask() encodes names in
// the question, and results carry `codes` so the view can decode them.
export async function createAnalystSession({ provider, key, model, dataset, codes = false }) {
  const m = await tryImport('../../llm/analyst.js');
  const create = pickFn(m, ['createAnalyst']);
  if (!create) throw new Error('The analyst (src/llm/analyst.js) is not available in this build.');
  const pc = codes ? pseudonymize(dataset) : null;
  const session = create({ provider, key, model, engine: analystEngine(pc), dataset: pc ? pc.ds : dataset });
  if (!pc) return session;
  return {
    ...session,
    ask: (question, opts) => session.ask(pc.encodeQuestion(question), opts),
    reset: () => session.reset(),
    codes: true,
  };
}

// target: a node's dataset index for scope 'node', an attribute key for 'group'.
export async function writeReport({ scope, target, provider, key, model, dataset, onText, signal, codes = false }) {
  const m = await tryImport('../../llm/reports.js');
  const fn = pickFn(m, ['writeReport']);
  if (!fn) throw new Error('Reports (src/llm/reports.js) are not available in this build.');
  const pc = codes ? pseudonymize(dataset) : null;
  const ds = pc ? pc.ds : dataset;
  const t = scope === 'node' && Number.isInteger(target) ? ds.nodes.keys[target] : target;
  return fn({ scope, target: t, provider, key, model, engine: analystEngine(pc), dataset: ds, onText, signal });
}

export async function codingModule() { return tryImport('../../llm/coding.js'); }
export async function estimateModule() { return tryImport('../../llm/estimate.js'); }

export async function methodsAppendix(input) {
  const m = await tryImport('../../llm/methods.js');
  const fn = pickFn(m, ['buildMethodsAppendix', 'buildMethods']);
  if (fn) return fn(input);
  if (MOCK) return (await import('./mock.js')).mockMethods(input.dataset, input.settings);
  return null;
}

// Offline demo provider (only under ?mock). It honours the provider
// contract: first turn asks for the network summary tool, second turn writes
// an answer citing it, with one deliberately uncited number so the
// unverified-number highlighting can be checked. Reports (no tools) get the
// requested headings; coding (json) gets the first code for every message.
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function stream(text, onText, signal) {
  for (const w of text.split(/(\s+)/)) { await sleep(5); if (signal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError', code: 'aborted' }); onText?.(w); }
}
function enumsIn(schema, out = []) {
  if (!schema || typeof schema !== 'object') return out;
  if (Array.isArray(schema.enum)) out.push(...schema.enum);
  for (const v of Object.values(schema)) if (v && typeof v === 'object') enumsIn(v, out);
  return out;
}
export const demoProvider = {
  id: 'demo', label: 'Offline demo (no network)', defaultModel: 'demo-1', defaultMaxTokens: 2000,
  keyPlaceholder: 'any text', keyUrl: null, browser: 'Runs locally; nothing leaves the machine.',
  async listModels() { return [{ id: 'demo-1', label: 'Demo model' }]; },
  async chat({ messages, tools = [], onText, signal, json }) {
    const usage = { inputTokens: 0, outputTokens: 0 };
    if (json) {
      const prompt = String(messages[messages.length - 1]?.content || '');
      const ids = [...prompt.matchAll(/\b(m\d+)\b/g)].map(x => x[1]);
      const code = enumsIn(json.schema)[0];
      const text = JSON.stringify({ items: [...new Set(ids)].map(id => ({ id, codes: code ? [code] : [] })) });
      return { text, toolCalls: [], stopReason: 'end', usage, model: 'demo-1', message: { role: 'assistant', content: text } };
    }
    const last = messages[messages.length - 1];
    if (tools.length && last?.role === 'user') {
      const call = { id: 'demo-call-1', name: tools.some(t => t.name === 'network_summary') ? 'network_summary' : tools[0].name, arguments: {} };
      await stream('Checking the network summary first. ', onText, signal);
      return { text: 'Checking the network summary first. ', toolCalls: [call], stopReason: 'tool_use', usage, model: 'demo-1', message: { role: 'assistant', content: 'Checking the network summary first. ', toolCalls: [call] } };
    }
    let text;
    if (last?.role === 'tool') {
      let r = {}; try { r = JSON.parse(last.content); } catch { /* keep empty */ }
      const res = r.result || r;
      const id = r.result_id || 'T1';
      const d = res.density ?? res.metrics?.density ?? res.network?.density;
      const n = res.nodes ?? res.n ?? res.info?.n;
      text = `The network has ${n ?? 'several'} people${d != null ? ` and a density of ${d}` : ''} [${id}]. Roughly 42% of ties cross departments, which is a number this demo did not compute.`;
    } else {
      const heads = [...String(last?.content || '').matchAll(/Sections, in order: ([^\n]+)/g)][0]?.[1]?.replace(/\.$/, '').split('; ') || ['Overview'];
      text = heads.map(h => `## ${h}\n\nThe offline demo provider writes placeholder text. With a real provider, this section is written only from the computed results listed in the result index.`).join('\n\n');
    }
    await stream(text, onText, signal);
    return { text, toolCalls: [], stopReason: 'end', usage, model: 'demo-1', message: { role: 'assistant', content: text } };
  },
};
