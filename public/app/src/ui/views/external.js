// Mounts for the views owned by ui-build: BuildView (src/ui/build/index.js)
// and GenerateView (src/ui/generate/index.js). They are imported lazily so a
// missing or broken module only affects its own view, and they hand results
// back through store.actions.loadDataset.

import { html, useState, useEffect } from '../../../vendor/preact.js';
import { ViewHead, Loading, Unavailable } from '../components/common.js';

function Mount({ title, intro, load }) {
  const [state, setState] = useState({ C: null, error: null });
  useEffect(() => {
    let live = true;
    load().then(C => { if (live) setState({ C, error: C ? null : new Error('missing export') }); },
      error => { console.info('[org-signal] view not loaded:', error.message); if (live) setState({ C: null, error }); });
    return () => { live = false; };
  }, []);
  if (state.error) {
    return html`<div class="view view--col">
      <${ViewHead} title=${title} intro=${intro} />
      <${Unavailable}>${title} is not available in this build yet. Everything else works; import data from the Data view in the meantime.</${Unavailable}>
    </div>`;
  }
  if (!state.C) return html`<div class="view"><${ViewHead} title=${title} hiddenTitle=${true} /><${Loading}>Opening ${title.toLowerCase()}</${Loading}></div>`;
  const C = state.C;
  // The mounted view renders the shared ViewHead (a focusable h1.view__title),
  // so the shell adds no heading of its own: the page keeps exactly one h1.
  return html`<div class="view view--bare"><${C} /></div>`;
}

export function BuildMount() {
  return html`<${Mount} title="Build" intro="Construct a network directly from a drawing, ego-network interview, roster, perceived-network reports, or pasted tie list."
    load=${() => import('../build/index.js').then(m => m.BuildView || m.default)} />`;
}

export function GenerateMount() {
  return html`<${Mount} title="Generate" intro="Generate a synthetic social system with known structure and observe it through a selected communication medium. The resulting records can be analyzed directly in Org Signal or downloaded in the platform’s native export format."
    load=${() => import('../generate/index.js').then(m => m.GenerateView || m.default)} />`;
}
