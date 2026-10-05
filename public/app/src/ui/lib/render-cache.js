// One layout per network build, shared by the Network view (drawing) and the
// People profile (a person's ties and weights), so the layout is computed once.

import { store } from '../store.js';
import { engine } from '../services/engine.js';

let cache = { version: null, promise: null, data: null };

// version: the network build; arrange: the two-mode arrangement ('columns' |
// 'rows'), or null for the force layout. One layout is kept at a time; the
// People profile asks for the network version only and takes whatever
// layout is cached (ties and weights do not depend on it).
const keyOf = (version, arrange) => `${version}|${arrange || ''}`;

export function cachedRender(version, arrange) {
  if (arrange === undefined) return cache.version === version ? cache.data : null;
  return cache.key === keyOf(version, arrange) ? cache.data : null;
}

export function getRender(version, arrange) {
  if (arrange === undefined && cache.version === version && cache.promise) return cache.promise;
  const key = keyOf(version, arrange);
  if (cache.key === key && cache.promise) return cache.promise;
  const p = store.actions.runJob('Laying out the network', (signal, progress) => engine.render({ signal, onProgress: progress, ...(arrange ? { arrange } : {}) }))
    .then(data => { if (cache.promise === p) cache.data = data; return data; }, e => { if (cache.promise === p) cache = { version: null, promise: null, data: null }; throw e; });
  cache = { version, key, promise: p, data: null };
  return p;
}

export function clearRender() { cache = { version: null, promise: null, data: null }; }

// One person's ties from the render data (dataset index in, dataset indices
// out), strongest first: { other, w, dir, rules[] }. The render keeps every
// tie of a drawn network; over the drawing budget the weakest ties are
// missing here, which callers state.
export function tiesOf(d, dsIdx, directed) {
  if (!d) return [];
  const rv = Array.prototype.indexOf.call(d.nodeIds, dsIdx);
  if (rv < 0) return [];
  const out = new Map();
  for (let k = 0; k < d.src.length; k++) {
    const a = d.src[k], b = d.dst[k];
    if (a !== rv && b !== rv) continue;
    const o = a === rv ? b : a;
    const e = out.get(o) || { other: d.nodeIds[o], w: 0, out: false, in: false, rules: new Set() };
    e.w += d.w ? d.w[k] : 1;
    if (a === rv) e.out = true; else e.in = true;
    for (const r in d.byRule || {}) if (d.byRule[r][k] > 0) e.rules.add(r);
    out.set(o, e);
  }
  return [...out.values()].map(e => ({ ...e, rules: [...e.rules], dir: !directed ? 'undirected' : e.out && e.in ? 'both ways' : e.out ? 'outgoing' : 'incoming' })).sort((a, b) => b.w - a.w || a.other - b.other);
}
