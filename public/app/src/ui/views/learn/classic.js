// Classic datasets in the UI: the compact library list (Data start page and
// Learn) and the card a loaded classic dataset carries (description, what the
// study found, reference values, assignment, citation, licence, ethics).
//
// Loading goes through src/core/classic.js and store.actions.loadDataset, then
// opens Network, whose "Who stands out" block shows ds.meta.example (title and
// lookFor) like a worked example. Datasets whose redistribution terms are not
// settled are listed as not included; the address flag ?classic=pending (or
// #...?classic=pending) loads them from data/classic-pending/ on a development
// server, where those files exist. The deployed build never has them.

import { html, useState, useEffect, useRef } from '../../../../vendor/preact.js';
import { store } from '../../store.js';
import { listClassic, loadClassic } from '../../../core/classic.js';
import { fmtInt } from '../../lib/format.js';

export function pendingAllowed() {
  if (typeof location === 'undefined') return false;
  const q = new URLSearchParams(location.search);
  const h = new URLSearchParams(location.hash.split('?')[1] || '');
  return q.get('classic') === 'pending' || h.get('classic') === 'pending';
}

let listPromise = null;
function useClassicList() {
  const [state, setState] = useState({ list: null, error: null });
  useEffect(() => {
    let live = true;
    listPromise ||= listClassic({ pending: pendingAllowed() });
    listPromise.then(list => live && setState({ list, error: null }), error => { listPromise = null; if (live) setState({ list: null, error }); });
    return () => { live = false; };
  }, []);
  return state;
}

// The line under each dataset's title, in the wording of the landing copy
// (docs/ux/copy-landing-eric-2026-10-04.md): year, size, and what the ties are,
// then one-mode or two-mode. Counts come from the manifest, so the line never
// drifts from the data.
const NUM = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const numWord = n => NUM[n] || fmtInt(n);
export function cardLine(e) {
  const n = fmtInt(e.nodes);
  const what = {
    florentine: [`${n} families`, `${fmtInt(e.ties)} ties across ${numWord(e.relations?.length || 1)} relations`],
    krackhardt: [`${n} people`, 'advice, friendship, and reporting ties'],
    sampson: [`${n} people`, `${numWord(e.timePoints?.length || 0)} time points`],
    kapferer: [`${n} people`, `${numWord(e.timePoints?.length || 0)} time points`],
    newcomb: [`${n} people`, 'repeated rankings'],
    wiring: [`${n} people`, 'multiple relations'],
    lesmis: [`${n} characters`, `${fmtInt(e.ties)} ties`],
    dolphins: [`${n} dolphins`, `${fmtInt(e.ties)} ties`],
    enron: [`${n} people`, `${fmtInt(e.ties)} messages`],
  }[e.id];
  const parts = e.mode === 'two' && e.modes
    ? [...Object.entries(e.modes).map(([k, c]) => `${fmtInt(c)} ${k.toLowerCase()}`), `${fmtInt(e.ties)} affiliations`]
    : what || [`${n} people`, `${fmtInt(e.ties)} ${e.ties === 1 ? 'tie' : 'ties'}`];
  // The Enron line carries no year: the headers span 1998 to 2002 (in its description).
  return [e.id === 'enron' ? null : e.year, ...parts, e.mode === 'two' ? 'Two-mode' : 'One-mode'].filter(Boolean).join(' · ');
}

export async function openClassic(entry) {
  const cur = store.get().dataset;
  if (cur && !confirm(`Load ${entry.title}? It replaces the data now loaded (${cur.meta?.name || 'current data'}), which is not kept.`)) return false;
  try {
    const ds = await store.actions.runJob(`Loading ${entry.title}`, async (signal, progress) => {
      progress(0.1, 'Reading the file');
      const d = await loadClassic(entry.id, { pending: pendingAllowed() });
      progress(0.4, 'Analyzing');
      return d;
    });
    await store.actions.loadDataset(ds, { mode: 'replace' });
    store.set({ datasets: [ds] });
    store.actions.notify('info', `Loaded ${entry.title}. What to look for is under "Who stands out".`);
    store.actions.setView('network');
    return true;
  } catch (e) {
    if (e?.name !== 'AbortError') store.actions.notify('error', `Could not load ${entry.title}: ${e.message}`);
    return false;
  }
}

// Krackhardt's managers' perceptions into Build > Perceived, through Build's
// link (#build?perceived=<id>:<relation>; src/ui/build/hash.js). Build asks
// before replacing a study and opens Compare.
export function openPerceived(entry, relation = 'advice') {
  location.hash = `#build?perceived=${entry.id}:${relation}`;
}

function Item({ e }) {
  const [busy, setBusy] = useState(false);
  const load = async () => { setBusy(true); try { await openClassic(e); } finally { setBusy(false); } };
  return html`<li class="example classic" aria-labelledby=${`classic-${e.id}`}>
    <h3 class="example__title" id=${`classic-${e.id}`} tabindex="-1">${e.title}</h3>
    <p class="meta classic__meta">${cardLine(e)}</p>
    <p class="example__what">${e.description}</p>
    ${e.loadable
      ? html`<p class="tlinks"><button type="button" class="tlink tlink--arrow" onClick=${load} disabled=${busy} aria-label=${`Load ${e.title}`}>${busy ? 'Loading' : 'Load'}</button>
          ${e.perceived && e.perceived.relations.map(r => html`<button type="button" class="tlink" onClick=${() => openPerceived(e, r)}>${r[0].toUpperCase() + r.slice(1)} perceptions in Build</button>`)}</p>`
      : html`<p class="small text2">Not included yet: its redistribution terms are not settled. <a class="linkish" href=${e.sourceUrls[0]} target="_blank" rel="noopener">Public source</a></p>`}
  </li>`;
}

// The library list. `heading`: the section heading level and text are the
// caller's (h2 in Learn, h3 on the Data start page). `intro`: true for the
// standard sentence, or the caller's own. `limit`: show only the first few,
// with a control to show all (the Data landing page shows four).
const INTRO = 'Published networks with source citations, substantive context, and reference results that can be reproduced in Org Signal.';
export function ClassicList({ headingId = 'classic-h', level = 2, intro = true, limit = 0 } = {}) {
  const { list, error } = useClassicList();
  const [all, setAll] = useState(false);
  const listRef = useRef(null);
  const H = level === 2 ? 'h2' : 'h3';
  const cut = limit > 0 && !all && list && list.length > limit;
  const shown = cut ? list.slice(0, limit) : list;
  const showAll = () => {
    setAll(true);
    // Keyboard and screen-reader users land on the first newly shown dataset.
    requestAnimationFrame(() => listRef.current?.querySelectorAll('.classic .example__title')[limit]?.focus());
  };
  return html`<section class="section classic-lib" aria-labelledby=${headingId}>
    <${H} id=${headingId} class=${level === 2 ? '' : 'dv-h3'} tabindex="-1">Classic datasets</${H}>
    ${intro && html`<p class="prose small text2">${intro === true ? INTRO : intro}</p>`}
    ${error ? html`<p class="small text2">The classic datasets could not be listed (${error.message}).</p>`
      : !list ? html`<p class="small text2">Loading the list.</p>`
      : html`<ul class="examples classic__list" ref=${listRef}>${shown.map(e => html`<${Item} e=${e} key=${e.id} />`)}</ul>
        ${cut && html`<p><button type="button" class="tlink classic__all" aria-expanded="false" onClick=${showAll}>Show all ${list.length} datasets</button></p>`}`}
  </section>`;
}

// The card of a loaded classic dataset (ds.meta.example from loadClassic).
export function ClassicCard({ example: x, title = 'About this dataset' }) {
  if (!x?.classic) return null;
  const pending = x.distribution === 'pending';
  return html`<section class="section classic-card" aria-labelledby="classic-card-h">
    <h2 class="section__title" id="classic-card-h">${title}: ${x.title}</h2>
    <p class="prose">${x.description}</p>
    <dl class="concept__dl">
      <dt>What the study found</dt><dd>${x.findings}</dd>
      ${x.knownAnswers?.length > 0 && html`<dt>Reference values</dt><dd>${x.knownAnswers.map(k => html`<p>${k.key ? html`<span class="concept__k">${k.key}</span>: ` : ''}${k.meaning}</p>`)}</dd>`}
      ${x.lookFor?.length > 0 && html`<dt>What to look for</dt><dd><ul class="classic-card__list" style="margin:0;padding-left:1.1rem">${x.lookFor.map(l => html`<li>${l}</li>`)}</ul></dd>`}
      ${x.assignment && html`<dt>Suggested assignment</dt><dd>${x.assignment.text}${x.assignment.a?.length ? html` <span class="small text2">(Networks 101: ${x.assignment.a.join(', ')}; <a class="linkish" href="#learn" onClick=${ev => { ev.preventDefault(); store.actions.setView('learn'); requestAnimationFrame(() => requestAnimationFrame(() => document.getElementById('learn-tasks')?.scrollIntoView({ block: 'start' }))); }}>Find it in the app</a>)</span>` : ''}</dd>`}
      <dt>Citation</dt><dd>${x.citation} ${x.sourceUrls?.map((u, i) => html`${i ? ' · ' : ''}<a class="linkish" href=${u} target="_blank" rel="noopener">${i ? `Source ${i + 1}` : 'Source'}</a>`)}</dd>
      <dt>License</dt><dd>${x.license}${pending ? ' Loaded here from the development server only.' : ''}</dd>
      ${x.ethics && html`<dt>Ethics</dt><dd>${x.ethics}</dd>`}
    </dl>
  </section>`;
}

// The checkable part of a classic dataset's card, folded under Network's "Who
// stands out" (where students look): the reference values, the ethics note, the
// citation and the license, with a link to the whole card on Data.
export function ClassicFacts({ example: x }) {
  if (!x?.classic) return null;
  return html`<details class="classic-facts">
    <summary class="small">Reference values, citation and license</summary>
    <dl class="concept__dl small">
      ${x.knownAnswers?.length > 0 && html`<dt>Reference values</dt><dd>${x.knownAnswers.map(k => html`<p>${k.key ? html`<span class="concept__k">${k.key}</span>: ` : ''}${k.meaning}</p>`)}</dd>`}
      ${x.ethics && html`<dt>Ethics</dt><dd>${x.ethics}</dd>`}
      <dt>Citation</dt><dd>${x.citation} ${x.sourceUrls?.[0] && html`<a class="linkish" href=${x.sourceUrls[0]} target="_blank" rel="noopener">Source</a>`}</dd>
      <dt>License</dt><dd>${x.license}</dd>
    </dl>
    <p class="small"><a class="linkish" href="#data" onClick=${ev => { ev.preventDefault(); store.actions.setView('data'); }}>The whole card, with what the study found and an assignment, is on Data</a></p>
  </details>`;
}
