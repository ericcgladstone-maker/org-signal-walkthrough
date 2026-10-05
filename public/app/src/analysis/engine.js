// Analysis engine: async front for the analysis host, running in a module
// Web Worker so heavy measurement never freezes the tab.
//
//   const engine = createEngine({ worker: true });
//   await engine.load(dataset);
//   const info = await engine.build(settings);
//   const m = await engine.nodeMetrics({ which: ['betweenness'] }, { onProgress: (f, msg) => ..., signal });
//   engine.cancel();   // terminate the worker; pending calls reject with AbortError
//
// Every method takes its arguments as the pure function does (minus ds/net,
// which live in the worker), plus an optional trailing control object
// { onProgress, signal }. cancel() terminates the worker, starts a fresh one
// and restores the dataset and last settings before the next call.
// worker: false runs the same host inline (Node tests, fallback).

import { createHost, attachWorker } from './host.js';
import { toTransfer } from '../core/model.js';

const METHODS = ['defaultSettings', 'rules', 'glossary', 'build', 'network', 'nodeMetrics', 'networkMetrics', 'communities', 'groups', 'ego',
  'nullModel', 'resampleRanks', 'applicability', 'timeSeries', 'detectShifts', 'compareBeforeAfter',
  'affect', 'keywords', 'topics', 'diffusion', 'edgeEvidence', 'graphForRender', 'resetLayout',
  'info', 'nodeIds', 'groupMetrics', 'egoMetrics'];
// Number of positional arguments each method takes before the control object.
const ARITY = { defaultSettings: 0, rules: 0, glossary: 0, build: 1, network: 1, nodeMetrics: 1, networkMetrics: 1, communities: 1, groups: 2, ego: 2,
  nullModel: 1, resampleRanks: 1, applicability: 0, timeSeries: 1, detectShifts: 2, compareBeforeAfter: 2,
  affect: 1, keywords: 1, topics: 1, diffusion: 1, edgeEvidence: 3, graphForRender: 1, resetLayout: 0,
  info: 0, nodeIds: 0, groupMetrics: 2, egoMetrics: 2 };

function abortError() {
  const e = new Error('Analysis cancelled');
  e.name = 'AbortError';
  return e;
}

// opts: { worker = true, workerFactory: () => Worker-like (tests), transfer = false }
// transfer: true moves the dataset's typed arrays into the worker (no copy);
// the caller's copy is then detached and unusable. Default copies.
export function createEngine(opts = {}) {
  const useWorker = opts.worker !== false && (opts.workerFactory || typeof Worker !== 'undefined');
  return useWorker ? workerEngine(opts) : inlineEngine();
}

function inlineEngine() {
  const host = createHost();
  let generation = 0;
  const engine = {
    mode: 'inline',
    async load(ds) { await null; return host.call('load', [ds]); },
    cancel() { generation++; },
    terminate() { generation++; },
  };
  for (const m of METHODS) {
    engine[m] = async (...a) => {
      const { args, ctl } = split(m, a);
      const gen = generation;
      if (ctl.signal?.aborted) throw abortError();
      await null; // always async, like the worker path
      const result = host.call(m, args, ctl.onProgress || (() => {}));
      if (gen !== generation || ctl.signal?.aborted) throw abortError();
      return result;
    };
  }
  return engine;
}

// Positional args, then an optional control object. onProgress and signal are
// also accepted inside an options argument (functions cannot be posted to a
// worker, so they are always lifted out here).
function split(method, a) {
  const k = ARITY[method];
  const args = a.slice(0, k);
  const ctl = a.length > k && a[k] && typeof a[k] === 'object' ? { ...a[k] } : {};
  args.forEach((x, i) => {
    if (x && typeof x === 'object' && !ArrayBuffer.isView(x) && ('onProgress' in x || 'signal' in x)) {
      const { onProgress, signal, ...rest } = x;
      if (onProgress && !ctl.onProgress) ctl.onProgress = onProgress;
      if (signal && !ctl.signal) ctl.signal = signal;
      args[i] = rest;
    }
  });
  return { args, ctl };
}

function workerEngine(opts) {
  const factory = opts.workerFactory || (() => new Worker(new URL('../workers/analysis.worker.js', import.meta.url), { type: 'module' }));
  let worker = null;
  let nextId = 1;
  const pending = new Map();      // id -> { resolve, reject, onProgress }
  let ds = null, lastSettings = null, restoring = null, needsRestore = false;
  // Bumped by cancel(): a call issued before cancel() but not yet posted must
  // not run on the fresh worker.
  let generation = 0;

  const spawn = () => {
    worker = factory();
    worker.onmessage = (e) => {
      const msg = e.data;
      const p = pending.get(msg.id);
      if (!p) return;
      if (msg.type === 'progress') { p.onProgress?.(msg.fraction, msg.message); return; }
      pending.delete(msg.id);
      if (msg.type === 'result') p.resolve(msg.result);
      else { const err = new Error(msg.error?.message || 'Analysis failed'); err.name = msg.error?.name || 'Error'; err.workerStack = msg.error?.stack; p.reject(err); }
    };
    worker.onerror = (e) => {
      const err = new Error(e.message || 'Analysis worker crashed');
      for (const p of pending.values()) p.reject(err);
      pending.clear();
      needsRestore = true;
      try { worker.terminate(); } catch { /* already gone */ }
      worker = null;
    };
  };

  const post = (method, args, ctl = {}, transfer = []) => new Promise((resolve, reject) => {
    if (!worker) spawn();
    const id = nextId++;
    pending.set(id, { resolve, reject, onProgress: ctl.onProgress });
    if (ctl.signal) {
      if (ctl.signal.aborted) { pending.delete(id); reject(abortError()); return; }
      ctl.signal.addEventListener('abort', () => { if (pending.has(id)) engine.cancel(); }, { once: true });
    }
    worker.postMessage({ id, method, args }, transfer);
  });

  // After cancel(), a fresh worker needs the dataset and settings again.
  const restore = async () => {
    if (!needsRestore) return;
    if (!restoring) {
      restoring = (async () => {
        if (ds) await post('load', [ds]);
        if (ds && lastSettings) await post('build', [lastSettings]);
        needsRestore = false;
      })().finally(() => { restoring = null; });
    }
    await restoring;
  };

  const engine = {
    mode: 'worker',
    async load(dataset, { transfer = opts.transfer ?? false } = {}) {
      if (transfer) {
        // The caller gives the arrays away; there is nothing to restore from after a cancel.
        const t = toTransfer(dataset);
        ds = null; lastSettings = null; needsRestore = false;
        return post('load', [t.payload], {}, t.transfer);
      }
      ds = dataset; lastSettings = null; needsRestore = false;
      return post('load', [dataset]);
    },
    cancel() {
      generation++;
      if (worker) { try { worker.terminate(); } catch { /* ignore */ } }
      worker = null;
      for (const p of pending.values()) p.reject(abortError());
      pending.clear();
      needsRestore = !!ds;
    },
    terminate() { engine.cancel(); needsRestore = false; ds = null; },
  };
  for (const m of METHODS) {
    engine[m] = async (...a) => {
      const { args, ctl } = split(m, a);
      const gen = generation;
      await restore();
      if (gen !== generation) throw abortError();
      const result = await post(m, args, ctl);
      if (m === 'build') lastSettings = result.settings;
      return result;
    };
  }
  return engine;
}

export { attachWorker };
