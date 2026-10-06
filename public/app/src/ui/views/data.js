// Data view: bring sources in, see what each can and cannot show, review
// who is who, join tables of people, and map unknown CSVs.
//
// Flow: drop or pick inputs -> each input is detected separately (with
// progress) and the user may override the importer and its options; a table
// with one row per person defaults to joining its columns to the people in
// the other data -> import (worker, with progress and cancel) -> review: the
// import report, "Are these all you?" when several personal exports name
// owners, merge suggestions plus manual merges, the table join -> load. When
// data is already loaded, new imports are added to it unless the user
// explicitly chooses to replace it.
//
// With nothing loaded the page starts with three equal ways in (decision 3):
// draw or type a small network (Build), explore the sample organization, or
// analyze your own exports (the drop zone below), then a link to Learn and
// the classic datasets library (learn/classic.js). A loaded classic dataset
// shows its card above the sources.
// A dropped Org Signal project file is recognized and opened here too (C9).
//
// Pieces live in ./data/: io.js (reading, detecting, importing, naming),
// inputs.js (the input list and column mapper), report.js (import report),
// identity.js (who is who), join.js (table joins), project.js (project files).

import { html, useState, useEffect, useRef } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { ViewHead, Flag, ErrorLine, Seg } from '../components/common.js';
import { importReport, suggestMatches, applyMerges, mergeDatasets, joinProfiles, pipelineMode, filesForRels } from '../services/pipeline.js';
import { fmtInt, plural } from '../lib/format.js';
import { inputsFromDrop, inputsFromPicker, detect, importGroups, importGroup, tableKindOf, shortName, browserZone, isCSV, blobOf, pathOf, groupSharedResponses } from './data/io.js';
import { InputList, effectiveImporters, isRecognized, inputUse } from './data/inputs.js';
import { ReportView } from './data/report.js';
import { ownersOf, ownerPairs, Owners, MatchList, ManualMerge, IdentityPanel } from './data/identity.js';
import { JoinSetup, ProfileJoin } from './data/join.js';
import { isProjectInput, readProject, projectSummary, openProject } from './data/project.js';
import { rederivableSource, rederiveSurvey, RULE_NAME } from '../../importers/survey-response.js';
import { ClassicList, ClassicCard } from './learn/classic.js';

export { ReportView };

// The note every data state carries: nothing persists (S19).
export const NOT_STORED = 'Loaded data is not kept: reloading or closing this tab erases it. To keep it, save a project under Methods & Export.';
// Suggested text for the shell's leave-page warning (beforeunload).
export const LEAVE_WARNING = 'Leave Org Signal? The loaded data is not stored anywhere, so leaving or reloading erases it.';

// ---- view ---------------------------------------------------------------------

export function DataView() {
  const dataset = useStore(s => s.dataset);
  const report = useStore(s => s.report);
  const hasData = !!dataset;
  const [inputs, setInputs] = useState([]);
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Nothing silently replaces data: with data loaded, imports are added.
  const [mode, setMode] = useState('add');
  const [tab, setTab] = useState(null);
  // Project files dropped here: [{ id, name, file, obj | error }].
  const [projects, setProjects] = useState([]);

  const update = (id, patch) => setInputs(prev => prev.map(x => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)));
  const updateMany = (ids, fn) => { const set = new Set(ids); setInputs(prev => prev.map(x => (set.has(x.id) ? { ...x, ...fn(x) } : x))); };
  const remove = id => setInputs(prev => prev.filter(x => x.id !== id));

  const addInputs = async (list1) => {
    if (!list1.length) return;
    setError(null);
    // Project files are opened, not imported: they hold a built dataset.
    const proj = [], list0 = [];
    for (const inp of list1) (await isProjectInput(inp) ? proj : list0).push(inp);
    if (proj.length) {
      const read = await Promise.all(proj.map(inp => readProject(inp.files[0]).then(obj => ({ id: inp.id, name: inp.name, obj }), e => ({ id: inp.id, name: inp.name, error: e }))));
      setProjects(prev => [...prev, ...read]);
    }
    if (!list0.length) return;
    const list = await groupSharedResponses(list0);
    setInputs(prev => [...prev, ...list]);
    for (const inp of list) {
      detect(inp, { onProgress: (f, msg) => update(inp.id, { progress: msg }) }).then(async ({ detections, files }) => {
        const tableKind = await tableKindOf(inp, detections);
        // Time zones the export does not record start as this computer's zone,
        // shown in the options, rather than as an unexplained UTC.
        const options = { ...inp.options };
        for (const d of effectiveImporters({ ...inp, detections, importerId: 'auto' })) {
          for (const o of d.options || []) if ((o.type === 'timezone') && o.default === 'unknown') options[d.id] = { ...(options[d.id] || {}), [o.key]: browserZone() };
        }
        update(inp.id, { detections, detecting: false, progress: null, fileCount: files, tableKind, options });
      }, err => update(inp.id, { detections: [], detecting: false, progress: null, error: err.message }));
    }
  };

  const uses = new Map(inputs.map(i => [i.id, inputUse(i, inputs, hasData)]));
  const toImport = inputs.filter(i => uses.get(i.id) === 'import' && isRecognized(i));
  const toJoin = inputs.filter(i => uses.get(i.id) === 'join');
  const skipped = inputs.filter(i => !i.detecting && uses.get(i.id) === 'import' && !isRecognized(i));
  const detecting = inputs.some(i => i.detecting);

  const runImports = async () => {
    setError(null);
    // Only a table of people with data already loaded: straight to the join.
    if (!toImport.length && toJoin.length && hasData) {
      store.set({ ui: { ...store.get().ui, profileFile: blobOf(toJoin[0].files[0]) } });
      setInputs([]); setTab('profile');
      return;
    }
    setBusy(true);
    try {
      // Parts of one export and repeated files are read together (io.js importGroups).
      const groups = importGroups(toImport);
      const failed = [];
      const results = await store.actions.runJob(toImport.length > 1 ? `Importing ${toImport.length} inputs` : `Importing ${toImport[0].name}`, async (signal, progress) => {
        const out = [];
        for (let k = 0; k < groups.length; k++) {
          const g = groups[k];
          try {
            out.push(await importGroup(g, { signal, onProgress: (f, msg) => progress((k + (f || 0)) / groups.length, msg) }));
          } catch (e) {
            // One unreadable input (an HTML export, a truncated zip) does not
            // stop the others; it is named in the review instead.
            if (e?.name === 'AbortError' || groups.length === 1) throw e;
            failed.push({ name: g.map(i => i.name).join(', '), message: e?.message || String(e) });
          }
        }
        if (!out.length && failed.length) throw new Error(failed.map(f => `${f.name}: ${f.message}`).join(' '));
        return out;
      });
      const fresh = results.length > 1 ? await mergeDatasets(results.map(r => r.dataset)) : results[0].dataset;
      const freshReport = await importReport(fresh);
      const add = hasData && mode === 'add';
      const newName = shortName(freshReport?.sources, toImport);
      const name = add ? `${dataset.meta.name} + ${newName}` : newName;
      const ds = add ? await mergeDatasets([dataset, fresh], { name }) : fresh;
      const rep = add ? await importReport(ds) : freshReport;
      const unclaimed = results.flatMap(r => r.unclaimed || r.report?.unclaimed || []);
      if (rep) rep.unclaimed = unclaimed.filter(r => !isCSV({ path: r }));
      if (rep && failed.length) rep.notes = [...failed.map(f => `Could not read ${f.name}: ${f.message}`), ...(rep.notes || [])];
      const matches = await suggestMatches(ds).catch(() => null);
      // Tables no importer claimed (an HR export inside the Slack zip) and
      // tables marked "add details to people" are offered for joining.
      const inner = (await filesForRels(toImport.flatMap(i => i.files), unclaimed.filter(r => /\.(csv|tsv|txt)$/i.test(r))).catch(() => [])).filter(isCSV);
      const joinFiles = [...toJoin.map(i => i.files[0]), ...inner];
      setPending({ dataset: ds, fresh, report: rep, matches, mode: hasData ? mode : 'replace', joinFiles, owners: rep ? ownersOf(ds, rep) : [], name });
      setInputs([]);
    } catch (e) {
      if (e.name !== 'AbortError') setError(e); else store.actions.notify('info', 'Import cancelled.');
    } finally { setBusy(false); }
  };

  const loadPending = async ({ pairs, join, name }) => {
    setBusy(true); setError(null);
    try {
      let ds = pending.dataset;
      if (pairs.length) ds = await applyMerges(ds, pairs);
      if (join) ds = (await joinProfiles(ds, join.table, join.opts)).dataset;
      ds = { ...ds, meta: { ...ds.meta, name: name || ds.meta.name } };
      const before = store.get().datasets || [];
      await store.actions.loadDataset(ds, { mode: 'replace' });
      store.set({ datasets: pending.mode === 'add' ? [...before, pending.fresh] : [pending.fresh] });
      store.actions.notify('info', `Loaded: ${plural(ds.nodes.count, 'person', 'people')}, ${plural(ds.events.count, 'event')}.`);
      setPending(null);
      // Same as Build and Generate: loading takes you to the network.
      store.actions.setView('network');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const openProj = async (p) => {
    setBusy(true); setError(null);
    try {
      await openProject(p.obj);
      setProjects([]);
      store.actions.setView('network');
    } catch (e) { setError(e); } finally { setBusy(false); }
  };

  const showInputs = inputs.length > 0 && !pending;
  // The landing page opens with its own orientation ("About Org Signal").
  const landing = !hasData && !inputs.length && !pending && !projects.length;
  return html`<div class="view view--col dv">
    <${ViewHead} title="Data" intro=${landing ? null : DATA_INTRO}
      actions=${hasData && !pending && !showInputs && html`<button type="button" class="btn btn--primary" onClick=${() => store.actions.setView('network')}>Open network</button>`} />
    <p class="visually-hidden" role="status" aria-live="polite">${detectionSummary(inputs)}</p>
    ${projects.length > 0 && !pending && html`<${ProjectInputs} projects=${projects} hasData=${hasData} busy=${busy} onOpen=${openProj} onRemove=${id => setProjects(ps => ps.filter(p => p.id !== id))} />`}
    ${landing && html`<${EmptyState} onFiles=${addInputs} />`}
    ${hasData && !pending && !showInputs && dataset.meta?.example?.classic && html`<${ClassicCard} example=${dataset.meta.example} />`}
    ${hasData && !pending && !showInputs && html`<${CurrentData} dataset=${dataset} report=${report} tab=${tab} onTab=${setTab} />`}
    ${hasData && !pending && !showInputs && html`<section class="section dv-more" aria-label="Add data">
      <${DropLine} onFiles=${addInputs} />
      <p class="small text2 dv-stored">${NOT_STORED} <button type="button" class="tlink tlink--arrow" onClick=${() => store.actions.setView('methods')}>Methods & Export</button></p>
    </section>`}
    ${showInputs && html`<section class="section" aria-labelledby="det-h">
      <h2 id="det-h" class="section__title">${hasData ? 'Data to add' : 'Data to import'}</h2>
      <${DropZone} onFiles=${addInputs} compact />
      <${InputList} inputs=${inputs} uses=${uses} onChange=${update} onChangeMany=${updateMany} onRemove=${remove} />
      <div class="dv-actions" role="group" aria-label="Import">
        ${hasData && html`<${Seg} label="With the loaded data" value=${mode} onChange=${setMode} options=${[{ value: 'add', label: 'Add to it' }, { value: 'replace', label: 'Replace it' }]} />`}
        <p class="small text2 dv-actions__note">${actionNote({ detecting, toImport, toJoin, skipped, hasData, mode })}</p>
        <div class="dv-actions__btns">
          <button type="button" class="tlink" onClick=${() => setInputs([])} disabled=${busy}>Clear</button>
          <button type="button" class="btn btn--primary" onClick=${runImports} disabled=${busy || detecting || (!toImport.length && !(toJoin.length && hasData))}>${importLabel(toImport, toJoin, hasData)}</button>
        </div>
      </div>
    </section>`}
    <${ErrorLine} error=${error} />
    ${pending && html`<${PendingReview} pending=${pending} busy=${busy} hasData=${hasData} onLoad=${loadPending} onDiscard=${() => setPending(null)} />`}
  </div>`;
}

function detectionSummary(inputs) {
  if (!inputs.length) return '';
  const done = inputs.filter(i => !i.detecting);
  if (done.length < inputs.length) return `Detecting ${fmtInt(inputs.length - done.length)} of ${fmtInt(inputs.length)} inputs.`;
  const bad = done.filter(i => !isRecognized(i));
  return bad.length ? `${fmtInt(done.length - bad.length)} recognized; not recognized: ${bad.map(i => i.name).join(', ')}.` : `${plural(done.length, 'input')} recognized.`;
}

function importLabel(toImport, toJoin, hasData) {
  if (!toImport.length && toJoin.length && hasData) return 'Join the table';
  return toImport.length > 1 ? `Import ${fmtInt(toImport.length)} inputs` : 'Import';
}

function actionNote({ detecting, toImport, toJoin, skipped, hasData, mode }) {
  if (detecting) return 'Detecting formats...';
  const parts = [];
  if (hasData) parts.push(mode === 'add' ? 'The new data is added to what is loaded.' : 'The loaded data will be replaced once you confirm.');
  if (toJoin.length) parts.push(`${plural(toJoin.length, 'table')} of people will be joined as details.`);
  if (skipped.length) parts.push(`${plural(skipped.length, 'input')} not recognized ${skipped.length === 1 ? 'is' : 'are'} left out.`);
  if (!toImport.length && !(toJoin.length && hasData)) parts.push('Nothing here can be imported yet.');
  return parts.join(' ');
}

// A preset of Generate: same engine, same recovery check and banner
// (loaded by store.actions.loadSample, which every empty state shares).
const DATA_INTRO = 'Import and review empirical data, open a saved project, or begin with a network constructed in Org Signal. The import review records what each source contains, the ties its records can support, and the limits of the resulting network.';

export const SAMPLE_SPEC = { context: 'workplace', medium: 'slack', structure: 'bridge-dependent', size: 96, seed: 1, content: 'light' };

const HOWTO = [
  ['Slack', 'Workspace owners and admins: Settings & administration > Workspace settings > Import/Export Data > Export. Download the zip.'],
  ['Gmail', 'takeout.google.com: deselect all, select Mail, export. Download the zip.'],
  ['WhatsApp', 'Open a chat > More (or the chat name) > Export chat > Without media. One zip or .txt per chat; drop them all at once.'],
  ['LinkedIn', 'Settings > Data privacy > Get a copy of your data > the larger archive. Download the zip.'],
  ['X', 'Settings > Your account > Download an archive of your data. Download the zip when it is ready.'],
  ['Microsoft Teams, Outlook, Telegram, Discord, Instagram', 'Each app\'s own "download your data" export works; drop the zip or folder as downloaded.'],
];

// Nothing loaded: the landing page, in Eric's wording
// (docs/ux/copy-landing-eric-2026-10-04.md): an orientation with the link to
// the Networks Lab, four ways in, the import area, the classic datasets (the
// first four, then all on request), synthetic networks and About. The sample
// organization stays one click away from every analysis view's empty state
// (store.actions.loadSample) and from Generate.
const LAB = 'https://graystoneindustries.co/lab/';
// The narrated walkthrough talk (full size; also on graystoneindustries.co/talks/).
const WALKTHROUGH = 'https://orgsignalwalkthrough.eric-c-gladstone.workers.dev';
const REPO = 'https://github.com/ericcgladstone-maker/org-signal';
const START = [
  { id: 'build', title: 'Draw or construct a network', text: 'Draw people and ties directly, conduct an ego-network interview, collect a roster or perceived-network survey, or paste a tie list.', action: 'Open Build' },
  { id: 'generate', title: 'Generate a network with known structure', text: 'Create a synthetic organization or online community with specified departments, brokers, silos, change over time, or diffusion processes, then compare the analysis with the structure used to generate it.', action: 'Open Generate' },
  { id: 'import', title: 'Analyze empirical data', text: 'Import communication, calendar, messaging, social-platform, survey, spreadsheet, or standard network files. Org Signal reviews what each source contains and how its records can be used to construct ties.', action: 'Choose files to import' },
  { id: 'classic', title: 'Work with a published network', text: 'Load a classic network with a documented substantive result and reference values that can be reproduced within Org Signal.', action: 'Browse classic datasets' },
];

function EmptyState({ onFiles }) {
  const go = (id) => {
    if (id === 'build' || id === 'generate') store.actions.setView(id);
    else if (id === 'classic') {
      const el = document.getElementById('dv-classic');
      el?.scrollIntoView({ block: 'start' });
      el?.querySelector('#dv-classic-h')?.focus({ preventScroll: true });
    } else {
      // Straight to the file picker (still inside the click, so the browser
      // allows it), with the drop zone in view for a drag instead.
      const el = document.getElementById('dv-import');
      el?.scrollIntoView({ block: 'start' });
      const pick = el?.querySelector('.dv-drop button');
      pick?.focus({ preventScroll: true });
      pick?.click();
    }
  };
  const ext = (href, text, cls = 'tlink') => html`<a class=${cls} href=${href} target="_blank" rel="noopener">${text} <span aria-hidden="true">↗</span><span class="visually-hidden"> (opens in a new tab)</span></a>`;
  return html`<div class="empty dv-empty">
    <section class="dv-orient" aria-labelledby="dv-orient-h">
      <h2 id="dv-orient-h">About Org Signal</h2>
      <div class="prose dv-orient__text">
        <p>I built Org Signal as a browser-based environment for teaching and conducting social network analysis. You can construct a network directly, generate one whose underlying structure is known, work with a published network, or import empirical records and define how those records become ties.</p>
        <p>The same analysis environment then provides network visualization, person- and group-level measures, comparisons with random networks, uncertainty in rankings, change over time, content analysis, and export of networks, figures, tables, and methods documentation.</p>
        <p>The analysis engine is built for research use. Its network measures have been checked against NetworkX, exact calculations, and closed-form reference cases across roughly 21 million comparisons. Statistical procedures are calibrated through simulation, and generated networks can be compared with the known structures from which they were produced.</p>
        <p>Files are read locally in the browser.</p>
      </div>
      <p class="dv-orient__lab">${ext(LAB, 'Research context, validation, and current limits', 'tlink dv-lab')}</p>
      <p class="dv-orient__lab dv-orient__walk">${ext(WALKTHROUGH, 'Interactive walkthrough: Analyzing Social Network Data', 'tlink dv-lab')}</p>
    </section>
    <section class="dv-ways" aria-labelledby="dv-ways-h">
      <h2 id="dv-ways-h" class="section__title">Choose a way in</h2>
      <ul class="dv-start" aria-labelledby="dv-ways-h">
        ${START.map(c => html`<li class="dv-start__item">
          <button type="button" class="dv-start__card" onClick=${() => go(c.id)}>
            <span class="dv-start__title">${c.title}</span>
            <span class="dv-start__text">${c.text}</span>
            <span class="dv-start__go tlink tlink--arrow">${c.action}</span>
          </button>
        </li>`)}
      </ul>
    </section>
    <p class="dv-learn">New to network analysis? <a class="tlink tlink--arrow" href="#learn" onClick=${e => { e.preventDefault(); store.actions.setView('learn'); }}>Learn the ideas</a></p>
    <section class="dv-import" id="dv-import" aria-labelledby="dv-import-h" tabindex="-1">
      <h3 id="dv-import-h" class="dv-h3">Analyze empirical data</h3>
      <p class="dv-privacy">Files are read and analyzed in this browser. Loaded data remain in the current tab unless you save an Org Signal project. Build drafts can be retained in this browser, and an API key is stored only when you explicitly choose to remember it.</p>
      <div class="dv-empty__drop"><${DropZone} onFiles=${onFiles} /></div>
      <p class="small text2 dv-sources">Org Signal reads Slack, Microsoft Teams, email, Gmail Takeout, Google and Outlook calendars, WhatsApp, LinkedIn, X, Telegram, iMessage, Messenger, Instagram, Discord, Reddit, Bluesky, Mastodon, Threads, survey responses, Network Canvas data, GraphML, GEXF, GML, Pajek, UCINET DL, ordinary who-to-whom tables, and Org Signal project files.</p>
      <details class="disclose dv-howto"><summary>How to get an export</summary>
        <dl class="dv-howto__list">${HOWTO.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>
      </details>
    </section>
    <div class="dv-classic" id="dv-classic"><${ClassicList} level=${3} headingId="dv-classic-h" limit=${4}
      intro="Org Signal includes published networks that can be used to learn measures, reproduce documented results, and compare an analysis with a known reference case." /></div>
    <section class="dv-synth" aria-labelledby="dv-synth-h">
      <h3 id="dv-synth-h" class="dv-h3">Synthetic networks</h3>
      <p class="prose">You can also generate organizations and online communities whose underlying structure is specified in advance. Generated worlds can include departments, brokers, silos, reorganizations, departures, communities, content patterns, and diffusion processes.</p>
      <p class="prose">Org Signal can write these worlds into the kinds of records produced by the selected communication medium, which can then be reconstructed through the same import and construction pipeline used for empirical data. The recovery check compares the resulting analysis with the structure used to generate the world.</p>
      <p><button type="button" class="tlink tlink--arrow" onClick=${() => store.actions.setView('generate')}>Open Generate</button></p>
    </section>
    <section class="dv-about" aria-labelledby="dv-about-h">
      <h3 id="dv-about-h" class="dv-h3">Research context and documentation</h3>
      <p class="prose">Org Signal is part of the Networks Lab at Graystone Industries. The Networks Lab page describes the research logic behind the system, validation procedures, current limitations, teaching materials, and source documentation.</p>
      <p class="tlinks">${ext(LAB, 'Read about Org Signal in the Networks Lab')}${ext(REPO, 'Source and documentation')}</p>
    </section>
  </div>`;
}

// Project files dropped on Data: what each holds, then Open (C9).
function ProjectInputs({ projects, hasData, busy, onOpen, onRemove }) {
  return html`<section class="section dv-projects" aria-labelledby="proj-in-h">
    <h2 id="proj-in-h" class="section__title">${projects.length === 1 ? 'Project file' : 'Project files'}</h2>
    ${projects.map(p => {
      if (p.error) return html`<article class="src dv-source"><div class="src__head"><h3 class="src__title">${p.name}</h3></div><p class="small"><${Flag} level="error">Not opened</${Flag}> ${p.error.message}</p><button type="button" class="tlink" onClick=${() => onRemove(p.id)}>Remove</button></article>`;
      const x = projectSummary(p.obj);
      return html`<article class="src dv-source" aria-label=${`Project: ${x.name}`}>
        <div class="src__head"><h3 class="src__title">${x.name} <span class="muted dv-sub">· Org Signal project</span></h3>${x.savedAt && html`<span class="meta">saved ${new Date(x.savedAt).toLocaleString()}</span>`}</div>
        <p class="small text2 dv-files-line">${p.name}</p>
        <dl class="kv dv-kv"><dt>People</dt><dd>${fmtInt(x.people)}</dd><dt>${x.survey ? 'Reported ties and events' : 'Events'}</dt><dd>${fmtInt(x.events)}</dd><dt>Sources</dt><dd>${fmtInt(x.sources)}</dd></dl>
        <p class="small text2 dv-p">${x.nominations ? 'This survey project keeps who named whom: after opening, the import report lets you switch between the union, reciprocated-only and as-reported networks.' : x.survey ? 'This survey project was saved without who named whom, so it opens with the rule it was saved with. To compare union and reciprocated networks, import the response files instead.' : 'Opening it restores the data, the construction settings and every measure.'}</p>
        <div class="dv-actions__btns dv-proj__btns">
          <button type="button" class="tlink" onClick=${() => onRemove(p.id)} disabled=${busy}>Remove</button>
          <button type="button" class="btn btn--primary" onClick=${() => onOpen(p)} disabled=${busy}>${hasData ? 'Open (replaces the loaded data)' : 'Open project'}</button>
        </div>
      </article>`;
    })}
  </section>`;
}

function useDrop(onFiles) {
  const [over, setOver] = useState(false);
  return [over, {
    onDragOver: e => { e.preventDefault(); setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: async e => { e.preventDefault(); setOver(false); onFiles(await inputsFromDrop(e.dataTransfer)); },
  }];
}

function Pickers({ onFiles, primary }) {
  const fileRef = useRef(null);
  const dirRef = useRef(null);
  useEffect(() => { if (dirRef.current) { dirRef.current.setAttribute('webkitdirectory', ''); dirRef.current.setAttribute('directory', ''); } }, []);
  return html`<button type="button" class=${primary ? 'btn btn--primary' : 'tlink'} onClick=${() => fileRef.current.click()}>Choose files</button>
    <button type="button" class="tlink" onClick=${() => dirRef.current.click()}>Choose a folder</button>
    <input type="file" multiple hidden ref=${fileRef} onChange=${e => { onFiles(inputsFromPicker(e.currentTarget.files, false)); e.currentTarget.value = ''; }} />
    <input type="file" multiple hidden ref=${dirRef} onChange=${e => { onFiles(inputsFromPicker(e.currentTarget.files, true)); e.currentTarget.value = ''; }} />`;
}

function DropZone({ onFiles, compact = false }) {
  const [over, drop] = useDrop(onFiles);
  return html`<div class=${`drop dv-drop${compact ? ' dv-drop--compact' : ''}`} data-over=${String(over)} ...${drop}>
    <p class="drop__title">${compact ? 'Drop more files, zips or folders' : 'Drop files, zips, or folders here'}</p>
    ${!compact && html`<p class="drop__hint">You can load an export as downloaded, a folder containing several exports, individual files, or multiple related files at once.</p>`}
    <div class="row dv-drop__row">
      <${Pickers} onFiles=${onFiles} primary=${!compact} />
      ${pipelineMode() === 'mock' && html`<span class="meta">Demo mode: any file shows the demo import</span>`}
    </div>
  </div>`;
}

// Loaded data: adding more is one line, not a second landing page.
function DropLine({ onFiles }) {
  const [over, drop] = useDrop(onFiles);
  return html`<div class="dv-dropline" data-over=${String(over)} ...${drop}>
    <span class="dv-dropline__text">Add more data: drop files here, or</span>
    <${Pickers} onFiles=${onFiles} />
  </div>`;
}

// ---- review after import -----------------------------------------------------------

function PendingReview({ pending, busy, hasData, onLoad, onDiscard }) {
  const ds = pending.dataset;
  const matches = pending.matches || [];
  const [name, setName] = useState(pending.name || ds.meta.name);
  const [accepted, setAccepted] = useState(() => new Set(matches.map((m, i) => (m.confidence === 'high' ? i : -1)).filter(i => i >= 0)));
  const [manual, setManual] = useState([]);
  const [owners, setOwners] = useState(() => new Set(pending.owners.map(o => o.key)));
  const [joinFile, setJoinFile] = useState(pending.joinFiles?.[0] || null);
  const [join, setJoin] = useState(null);
  const [confirm, setConfirm] = useState(false);
  const toggle = (i, v) => setAccepted(prev => { const s = new Set(prev); if (v) s.add(i); else s.delete(i); return s; });
  const pairs = [...(pending.owners.length >= 2 ? ownerPairs(pending.owners, owners) : []), ...matches.filter((_, i) => accepted.has(i)), ...manual];
  const empty = ds.events.count === 0;
  const replacing = hasData && pending.mode === 'replace';
  const load = () => {
    if (replacing && !confirm) { setConfirm(true); return; }
    onLoad({ pairs, join: joinFile && join?.opts?.columns?.length ? { table: join.table, opts: join.opts } : null, name: name.trim() });
  };
  return html`<section class="section dv-review" aria-labelledby="rev-h">
    <h2 id="rev-h" class="section__title">Review before analysis</h2>
    <label class="field dv-name"><span>Name for this data</span><input class="input" value=${name} maxlength="120" onInput=${e => setName(e.currentTarget.value)} /></label>
    ${empty && html`<div class="notice-line" role="alert"><${Flag} level="error">Nothing to analyze</${Flag}><span class="grow">These files produced no messages, ties or other events, so there is no network to build. Check the problems listed below, or choose another importer.</span></div>`}
    ${pending.owners.length >= 2 && html`<${Owners} owners=${pending.owners} checked=${owners} onToggle=${(k, v) => setOwners(prev => { const s = new Set(prev); if (v) s.add(k); else s.delete(k); return s; })} />`}
    <${ReportView} report=${pending.report} pending dataset=${pending.dataset} excludeBots=${store.get().settings?.excludeBots !== false} />
    <div class="section">
      <h3 class="dv-h3">Who is who</h3>
      <${MatchList} matches=${matches} accepted=${accepted} onToggle=${toggle} onAll=${v => setAccepted(new Set(v ? matches.map((_, i) => i) : []))} />
      ${!empty && html`<${ManualMerge} ds=${ds} pairs=${manual} onAdd=${p => setManual(m => [...m, p])} onRemove=${k => setManual(m => m.filter((_, j) => j !== k))} />`}
    </div>
    ${pending.joinFiles?.length > 0 && !empty && html`<div class="section">
      <h3 class="dv-h3">Add details from a table of people</h3>
      <p class="small text2 dv-p">Columns such as department or role are joined to the matching people. The match below is before merging duplicates; it is redone on load.</p>
      ${pending.joinFiles.map(f => html`<label class="check dv-radio"><input type="radio" name="joinfile" checked=${joinFile === f} onChange=${() => { setJoinFile(f); setJoin(null); }} />${pathOf(f)}</label>`)}
      <label class="check dv-radio"><input type="radio" name="joinfile" checked=${!joinFile} onChange=${() => setJoinFile(null)} />Do not join a table</label>
      ${joinFile && html`<${JoinSetup} key=${pathOf(joinFile)} ds=${ds} file=${joinFile} onChange=${setJoin} />`}
    </div>`}
    <div class="dv-actions" role="group" aria-label="Load">
      <p class="small text2 dv-actions__note">${confirm ? html`<${Flag} level="caution">Replace</${Flag}> This removes the loaded data from the analysis. Load anyway?` : summary(pairs, joinFile && join, replacing, pending.mode === 'add')}</p>
      <div class="dv-actions__btns">
        <button type="button" class="tlink" onClick=${confirm ? () => setConfirm(false) : onDiscard} disabled=${busy}>${confirm ? 'Keep the loaded data' : 'Discard'}</button>
        <button type="button" class="btn btn--primary" onClick=${load} disabled=${busy || empty}>${confirm ? 'Replace and load' : pairs.length ? `Merge ${fmtInt(pairs.length)} and load into analysis` : 'Load into analysis'}</button>
      </div>
    </div>
  </section>`;
}

function summary(pairs, join, replacing, adding) {
  const parts = [];
  parts.push(pairs.length ? `${plural(pairs.length, 'merge')} will be applied.` : 'No merges.');
  if (join) {
    const empty = (join.result?.report?.emptyColumns || []).filter(c => join.opts.columns.includes(c));
    parts.push(`${plural(join.opts.columns.length - empty.length, 'column')} will be joined.${empty.length ? ` ${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no values and ${empty.length === 1 ? 'is' : 'are'} left out.` : ''}`);
  }
  if (adding) parts.push('Added to the loaded data.');
  if (replacing) parts.push('Replaces the loaded data.');
  return parts.join(' ');
}

// ---- current data --------------------------------------------------------------------

const TABS = [['report', 'Import report'], ['identity', 'Who is who'], ['profile', 'Join attributes']];

function CurrentData({ dataset, report, tab: forced, onTab }) {
  const settings = useStore(s => s.settings);
  const [tab, setTab] = useState(() => forced || (store.get().ui?.profileFile ? 'profile' : 'report'));
  useEffect(() => { if (forced) { setTab(forced); onTab(null); } }, [forced]);
  const refs = useRef({});
  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onKey = e => {
    const k = TABS.findIndex(([id]) => id === tab);
    const next = e.key === 'ArrowRight' ? (k + 1) % TABS.length : e.key === 'ArrowLeft' ? (k + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    setTab(TABS[next][0]);
    refs.current[TABS[next][0]]?.focus();
  };
  return html`<section class="section dv-current" aria-labelledby="cur-h">
    <h2 id="cur-h" class="section__title dv-current__name">${dataset.meta.name}</h2>
    <div class="tabs" role="tablist" aria-label="Loaded data" onKeyDown=${onKey}>
      ${TABS.map(([id, l]) => html`<button type="button" role="tab" id=${`dv-tab-${id}`} aria-controls="dv-panel" aria-selected=${String(tab === id)} tabindex=${tab === id ? 0 : -1} ref=${el => { refs.current[id] = el; }} onClick=${() => setTab(id)}>${l}</button>`)}
    </div>
    <div role="tabpanel" id="dv-panel" aria-labelledby=${`dv-tab-${tab}`}>
      ${tab === 'report' && html`<${SurveyRule} dataset=${dataset} />`}
      ${tab === 'report' && html`<${ReportView} report=${report} dataset=${dataset} excludeBots=${settings?.excludeBots !== false} />`}
      ${tab === 'identity' && html`<${IdentityPanel} ds=${dataset} />`}
      ${tab === 'profile' && html`<${ProfileJoin} ds=${dataset} />`}
    </div>
  </section>`;
}

// A roster survey that keeps who named whom (C9): the same responses as the
// union, reciprocated-only or as-reported network, switched in place. The
// rule is part of the name, so saves and exports of each differ (C13).
const RULES = [{ value: 'union', label: 'Union' }, { value: 'intersection', label: 'Reciprocated only' }, { value: 'respondent', label: 'As reported' }];
const RULE_HELP = {
  union: 'A tie if either person named the other (undirected).',
  intersection: 'A tie only if both named each other (undirected).',
  respondent: 'Each nomination as a directed tie from the person who named to the person named.',
};
function SurveyRule({ dataset }) {
  const src = rederivableSource(dataset);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  if (!src) return null;
  const rule = src.mergeRule || 'union';
  const change = async (r) => {
    if (r === rule) return;
    setBusy(true); setErr(null);
    try {
      const ds = rederiveSurvey(dataset, r);
      await store.actions.loadDataset(ds, { mode: 'replace' });
      store.set({ datasets: [ds] });
      store.actions.notify('info', `Recombined as ${RULE_NAME[r]}: ${plural(store.get().network?.edgeCount ?? 0, 'tie')}.`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return html`<div class="dv-rule" aria-busy=${String(busy)}>
    <${Seg} label="Combine the two answers about each pair" value=${rule} onChange=${change} options=${RULES} />
    <p class="small text2 dv-rule__help">${RULE_HELP[rule]} The project keeps who named whom, so you can switch and compare; each version is saved and exported under its own name.</p>
    <${ErrorLine} error=${err} />
  </div>`;
}
