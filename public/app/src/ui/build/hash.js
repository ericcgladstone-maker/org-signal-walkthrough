// Worked-example links into Build (pure; tested in Node):
//   #build?example=<id>      what the Learn view emits; works with the shell's router
//   #build/example/<id>      the same, for a router that passes #build/... here
// Ids and aliases are those of src/builders/examples.js.

import { exampleById } from '../../builders/examples.js';

// The example id in a Build address, or null.
export function exampleFromHash(hash) {
  const h = String(hash || '');
  let id = null;
  if (/^#build\?/.test(h)) id = new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('example');
  else { const m = /^#build\/example\/([\w-]+)/.exec(h); if (m) id = m[1]; }
  return id && exampleById(id) ? id : null;
}

// A classic dataset's perceived networks (Build > Perceived), from
//   #build?perceived=<dataset id>:<relation>     e.g. krackhardt:advice
// -> { id, relation }, or null. Whether the dataset has those perceptions is
// checked when they load (src/core/classic.js loadClassicPerceived).
export function perceivedFromHash(hash) {
  const h = String(hash || '');
  if (!/^#build\?/.test(h)) return null;
  const v = new URLSearchParams(h.slice(h.indexOf('?') + 1)).get('perceived');
  const m = /^([\w-]+):([\w -]+)$/.exec(v || '');
  return m ? { id: m[1], relation: m[2] } : null;
}
