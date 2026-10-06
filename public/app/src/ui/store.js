// App-wide state. One small observable store shared by every view.
//
// Views read with useStore(selector) and write with store.set(patch) or through
// store.actions, which the app shell registers at startup (src/ui/app.js).
// Builders and the generator hand finished datasets to the app with
//   store.actions.loadDataset(dataset, { mode: 'replace' | 'add' })
// and never touch the analysis engine themselves.

import { useState, useEffect } from '../../vendor/preact.js';

// The Interpretive notes switch (decision 1): Interpretation blocks and inline
// glosses. On for a first visit; the reader's choice is kept in localStorage
// (as are Build drafts and the Generate form, in their own modules). Storage can be missing or throw (private windows,
// blocked site data, Node tests), so every access is guarded.
const EXPLAIN_KEY = 'orgsignal.explain';
export function readExplainPref() {
  try {
    const v = globalThis.localStorage?.getItem(EXPLAIN_KEY);
    return v === 'off' ? false : true;
  } catch { return true; }
}
export function writeExplainPref(on) {
  try { globalThis.localStorage?.setItem(EXPLAIN_KEY, on ? 'on' : 'off'); } catch { /* not kept; the switch still works for this tab */ }
}

const initial = {
  view: 'data',          // data | build | generate | network | people | groups | content | time | methods | ask | learn
  learnKey: null,        // concept open in Learn (#learn/<key>), or null
  explain: readExplainPref(), // Interpretive notes switch: true shows Interpretation blocks and glosses
  datasets: [],          // every Dataset loaded this session (before merging)
  dataset: null,         // the active, merged Dataset
  settings: null,        // ConstructionSettings for the active network
  network: null,         // summary of the active Network (the full object lives in the engine worker)
  metrics: null,         // latest node and network metrics returned by the engine
  selection: [],         // selected node indices (dataset node index), shared across views
  jobs: [],              // [{ id, label, progress, cancel }] long-running work shown in the status bar
  llm: { provider: 'anthropic', model: null, key: null, remember: false },
  notice: null,          // { level: 'info'|'warn'|'error', text }
  // Ground truth of the generated world behind the active dataset, if any:
  // { datasetName, spec, groundTruth, recovery } where recovery is the last
  // recoveryCheck report (null until computed). Set by the Generate view;
  // cleared by loadDataset when a different dataset replaces it. Lets any view
  // show the recovery check after the user leaves Generate.
  generated: null,
  // Set by the shell and views during the UX pass (see docs/api/ui-core.md):
  //   lastRebuild  { at, ...before/after summary } of the last settings rebuild (actions.js)
  //   methodsLog   { [analysis kind]: [{ options }] } runs feeding the methods appendix (services/engine.js)
  //   stability    { version, byMetric } rank-stability results shown in People (views/people.js)
  lastRebuild: null,
  methodsLog: {},
  stability: null,
};

function createStore(state) {
  const subs = new Set();
  return {
    get: () => state,
    set(patch) {
      state = { ...state, ...(typeof patch === 'function' ? patch(state) : patch) };
      for (const fn of subs) fn(state);
    },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn); },
    actions: {},
  };
}

export const store = createStore(initial);

// Re-renders the calling component when the selected slice changes (by ===).
export function useStore(selector = s => s) {
  const [value, setValue] = useState(() => selector(store.get()));
  useEffect(() => store.subscribe(s => {
    const next = selector(s);
    setValue(prev => (prev === next ? prev : next));
  }), []);
  return value;
}
