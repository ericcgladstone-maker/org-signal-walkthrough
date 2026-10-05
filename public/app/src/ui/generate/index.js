// Generate view: choose a synthetic world, then analyze it or download it as
// the native export files a real platform would give you.
//
// The form is driven entirely by the generator's listContexts(); only valid
// combinations are selectable (invalid ones stay visible, disabled, with the
// reason in words). Generation runs in a module worker with progress and
// cancel.
//
// "Generate and analyze" loads the dataset and records the world behind it in
// store.generated = { datasetName, spec, groundTruth, recovery, runId, people,
// events }, then runs the recovery check, which compares what the analysis
// finds with what was planted. Both live outside this component (the store,
// and runState below for the job in progress and the last download), so
// leaving the view and coming back keeps the run, its progress and its
// recovery check; the Network view shows a short banner from the same store
// field.

import { html, useState, useEffect } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { options, defaultForm, applyChange, toSpec, describe, sizeNote, friendlyError, fmtDay } from '../../builders/generate-spec.js';
import { ensureBuildCss, Unavailable, downloadBlob, downloadText, storage, ViewHeader } from '../build/shared.js';
import { handOff, notify } from '../build/service.js';
import { loadContexts, startGenerate, startRecovery } from './service.js';
import { groundTruthJSON, readmeText } from './pack.js';
import { RULE_LABEL } from '../actions.js';
import { HowToRead } from '../components/common.js';

const FORM_KEY = 'orgsignal.generate.form';
const cap = t => t.charAt(0).toUpperCase() + t.slice(1);

// ---- run state shared across mounts -----------------------------------------
// job: { output, fraction, message, cancel } while a run is going;
// err: the last failure; native: the last download; check: the recovery
// check's own state ({ busy } | { error } | { missing }) beside the report in
// store.generated.recovery.
const runState = { job: null, err: null, native: null, check: null };
const runSubs = new Set();
function setRun(patch) {
  Object.assign(runState, typeof patch === 'function' ? patch(runState) : patch);
  for (const f of runSubs) f({ ...runState });
}
function useRun() {
  const [s, set] = useState(() => ({ ...runState }));
  useEffect(() => { runSubs.add(set); set({ ...runState }); return () => runSubs.delete(set); }, []);
  return s;
}

// The dataset a recovery check reads when the worker no longer holds the run.
function generatedDataset(g) {
  const st = store.get();
  return [st.dataset, ...(st.datasets || [])].find(d => d && d.meta?.name === g.datasetName) || null;
}

// The construction settings the check uses: those in use now when the
// generated world is what is loaded (so A8 can compare constructions, N24),
// else the defaults.
function checkSettings(g) {
  const st = store.get();
  return st.dataset && st.dataset.meta?.name === g.datasetName && st.settings ? JSON.parse(JSON.stringify(st.settings)) : null;
}

export async function runRecoveryCheck() {
  const g = store.get().generated;
  if (!g) return;
  setRun({ check: { busy: true } });
  const settings = checkSettings(g);
  try {
    const res = await startRecovery({ seed: Number(g.spec?.seed) || 1, runId: g.runId, groundTruth: g.groundTruth, dataset: generatedDataset(g), settings });
    // Only keep it if the same world is still the generated one.
    if (store.get().generated !== g) return;
    if (res.report) { store.set({ generated: { ...store.get().generated, recovery: res.report, recoverySettings: settings } }); setRun({ check: null }); }
    else setRun({ check: res.missing ? { missing: res.missing } : { error: 'The recovery check returned nothing.' } });
  } catch (e) {
    setRun({ check: { error: friendlyError(e.message) } });
  }
}

// Generate a world from a finished spec, load it, record it as the generated
// dataset and run the recovery check. Shared by the Generate form and the Data
// view's sample-organization shortcut, so both behave the same.
export async function generateAndAnalyze(spec) {
  return generateRun(null, 'dataset', spec);
}

async function generateRun(form, output, specIn = null) {
  const spec = specIn ? { ...specIn, output } : toSpec(form, { output });
  const { promise, cancel, runId } = startGenerate(spec, { onProgress: (fraction, message) => setRun(r => ({ job: r.job ? { ...r.job, fraction, message } : r.job })) });
  setRun({ job: { output, fraction: 0, message: 'Starting', cancel }, err: null });
  try {
    const res = await promise;
    setRun({ job: null });
    if (output === 'native') {
      const d = res.download;
      downloadBlob(d.name, new Blob([d.bytes], { type: d.type }));
      setRun({ native: { spec, name: d.name, entries: d.entries, files: res.fileList, groundTruth: res.groundTruth } });
      notify('info', `Downloaded ${d.name}.`);
      return;
    }
    const ok = await handOff(res.dataset, { mode: 'replace' });
    if (!ok) return;
    store.set({ generated: { datasetName: res.dataset.meta.name, spec, groundTruth: res.groundTruth, recovery: null, runId, people: res.dataset.nodes.count, events: res.dataset.events.count } });
    runRecoveryCheck();
  } catch (e) {
    setRun({ job: null, err: e.cancelled ? null : friendlyError(e.message, { size: spec.size }) });
  }
}

export function GenerateView() {
  ensureBuildCss();
  const [state, setState] = useState(null); // { contexts, devFallback, error, recoveryAvailable }
  const [form, setForm] = useState(null);
  const [notes, setNotes] = useState([]);
  const run = useRun();
  const generated = useStore(s => s.generated);
  const loaded = useStore(s => s.dataset);

  useEffect(() => {
    let live = true;
    loadContexts().then(s => {
      if (!live) return;
      setState(s);
      const saved = storage.get(FORM_KEY, null);
      const base = saved && s.contexts.some(c => c.id === saved.context) ? applyChange(s.contexts, saved, {}).form : defaultForm(s.contexts);
      setForm(base);
    });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (form) storage.set(FORM_KEY, form); }, [form]);

  const head = html`<${ViewHeader} title="Generate" intro="Generate a synthetic social system with known structure and observe it through a selected communication medium. The resulting records can be analyzed directly in Org Signal or downloaded in the platform’s native export format. The settings specify the social context, communication medium, structural scenario, population size, observation period, message content, and portion of the system visible in the resulting export." />`;
  if (!state || !form) return html`<section class="ob ob-view">${head}<p class="ob-note" role="status">Loading the generator...</p></section>`;
  const { contexts, devFallback } = state;
  const opt = options(contexts, form);
  const desc = describe(contexts, form);
  const ctx = contexts.find(c => c.id === form.context);
  const change = patch => { const r = applyChange(contexts, form, patch); setForm(r.form); setNotes(r.notes); };
  const busy = !!run.job;
  const sn = sizeNote(form.size);
  const nativeOk = desc.nativeAvailable;
  const unavailable = items => items.filter(i => !i.enabled);

  return html`<section class="ob ob-view ob-gen">
    ${head}
    ${devFallback ? html`<${Unavailable} title="The generator is not available yet">
      The form below uses a small built-in outline of the settings for development only, so nothing can be generated. (${state.error})
    </${Unavailable}>` : null}

    <div class="ob-cols side">
      <form class="ob-stack" onSubmit=${e => e.preventDefault()} aria-describedby="ob-gen-summary">
        <fieldset class="ob-fieldset">
          <legend>1. Setting</legend>
          <div class="radios">
            ${opt.contexts.map(c => {
              const d = contexts.find(x => x.id === c.id)?.description;
              return html`<label class=${c.enabled ? 'radio' : 'radio radio--disabled'}>
                <input type="radio" name="ob-gen-context" value=${c.id} checked=${form.context === c.id} disabled=${!c.enabled} onChange=${() => change({ context: c.id })} />
                <span class="radio__name">${c.label}</span>
                ${d || !c.enabled ? html`<span class="radio__desc">${d}${!c.enabled ? ` Not available: ${c.reason}.` : ''}</span>` : null}
              </label>`;
            })}
          </div>
        </fieldset>
        <${SegChoice} legend="2. Medium" name="medium" items=${opt.media} value=${form.medium} onChange=${v => change({ medium: v })}
          why=${unavailable(opt.media)} />
        ${opt.structures.length ? html`<fieldset class="ob-fieldset">
          <legend>3. Scenario</legend>
          <div class="radios">
            ${opt.structures.map(s => {
              // Preset labels read "Name: what it plants"; the name leads.
              const [name, ...rest] = s.label.split(': ');
              return html`<label class="radio">
                <input type="radio" name="ob-gen-structure" value=${s.id} checked=${form.structure === s.id} onChange=${() => change({ structure: s.id })} />
                <span class="radio__name">${name}</span>${rest.length ? html`<span class="radio__desc">${cap(rest.join(': '))}</span>` : null}</label>`;
            })}
          </div>
        </fieldset>` : null}
        <fieldset class="ob-fieldset">
          <legend>4. Size</legend>
          <div class="ob-row">
            <label class="visually-hidden" for="ob-gen-size">${opt.size.label}</label>
            <input id="ob-gen-size" class="input" type="number" style="width:8rem" min=${opt.size.min} max=${opt.size.max} step="1" value=${form.size}
              aria-describedby="ob-gen-sizenote" onChange=${e => change({ size: Number(e.currentTarget.value) })} />
            <span class="ob-note">${opt.size.label.toLowerCase()}</span>
            <input class="ob-range" type="range" aria-label=${`${opt.size.label} (logarithmic slider)`}
              min="0" max="1000" value=${Math.round(1000 * Math.log(form.size / opt.size.min) / Math.log(opt.size.max / opt.size.min))}
              onInput=${e => change({ size: Math.round(opt.size.min * Math.pow(opt.size.max / opt.size.min, Number(e.currentTarget.value) / 1000)) })} />
          </div>
          <p id="ob-gen-sizenote" class=${sn.level === 'warn' ? 'ob-note ob-warn' : 'ob-note'}>${sn.text}</p>
        </fieldset>
        <${SegChoice} legend="5. Message text" name="content" items=${opt.content} value=${form.content} onChange=${v => change({ content: v })}
          help=${opt.content.find(c => c.id === form.content)?.help} />
        <${SegChoice} legend="6. What the export shows" name="observation" items=${opt.observations} value=${form.observation} onChange=${v => change({ observation: v })}
          help=${opt.observations.find(o => o.id === form.observation)?.help} why=${unavailable(opt.observations)} caution=${desc.caution} />
        <fieldset class="ob-fieldset">
          <legend>7. Time and random seed</legend>
          <div class="ob-row" style="align-items:flex-end">
            <div class="field" style="width:8rem"><label class="field__label" for="ob-gen-days">Days</label>
              <input id="ob-gen-days" class="input" type="number" min="1" max="3650" value=${form.days} onChange=${e => change({ days: Math.max(1, Number(e.currentTarget.value) || 1) })} /></div>
            <div class="field" style="width:10.5rem"><label class="field__label" for="ob-gen-start">Start</label>
              <input id="ob-gen-start" class="input" type="date" value=${form.start || ''} onChange=${e => change({ start: e.currentTarget.value || null })} /></div>
            <div class="field" style="width:8rem"><label class="field__label" for="ob-gen-seed">Random seed</label>
              <input id="ob-gen-seed" class="input" type="number" min="1" value=${form.seed} onChange=${e => change({ seed: Math.max(1, Number(e.currentTarget.value) || 1) })} /></div>
            <button type="button" class="tlink ob-gen-newseed" onClick=${() => change({ seed: 1 + Math.floor(Math.random() * 99999) })}>New seed</button>
          </div>
          <p class="ob-note">The random seed makes generation reproducible. Identical settings and seed reproduce the same generated world.</p>
        </fieldset>
        ${opt.params.length ? html`<details class="ob-fieldset ob-advanced">
          <summary class="tlink">Advanced parameters for ${ctx?.label.toLowerCase()}</summary>
          <p class="ob-note">Blank means the scenario's or the generator's default, shown under each field.</p>
          <div class="ob-grid-form">${opt.params.map(p => html`<${Param} p=${p} value=${form.params?.[p.key]}
            preset=${ctx?.presets.find(x => x.id === form.structure)?.params?.[p.key]}
            onChange=${v => change({ params: { ...form.params, [p.key]: v } })} />`)}</div>
          <button type="button" class="tlink" onClick=${() => change({ params: {} })}>Reset to defaults</button>
        </details>` : null}
      </form>

      <aside class="ob-stack ob-gen-aside" aria-label="Summary and actions">
        <div class="ob-stack" id="ob-gen-summary" style="gap:.5rem">
          <h2 class="ob-h">Generated world</h2>
          <p class="ob-text">${desc.what}</p>
          <p class="ob-note">${desc.export}</p>
          ${desc.caution ? html`<p class="ob-note ob-warn">${desc.caution}</p>` : null}
        </div>
        ${notes.length ? html`<p class="ob-note ob-warn" role="status">${notes.join('. ')}.</p>` : null}
        ${generated?.spec && differs(generated.spec, form) ? html`<div class="ob-stack ob-gen-loaded" style="gap:.3rem">
          <p class="ob-note"><strong>Loaded now:</strong> ${worldName(contexts, generated.spec)}. The form above sets up the next world; the recovery check below is about the loaded one.</p>
          <p class="ob-note"><button type="button" class="tlink" onClick=${() => change(specToForm(generated.spec))}>Show the loaded world's settings in the form</button></p>
        </div>` : null}
        <div class="ob-stack" style="gap:.6rem">
          <button type="button" class="btn btn--primary" disabled=${busy || devFallback} onClick=${() => generateRun(form, 'dataset')}>Generate and analyze</button>
          ${loaded ? html`<p class="ob-note">Replaces the data now loaded (${loaded.meta?.name}).</p>` : null}
          <p class="ob-note"><button type="button" class="tlink" disabled=${busy || devFallback || !nativeOk} onClick=${() => generateRun(form, 'native')}
            aria-describedby="ob-gen-native">Download as native export files</button></p>
          <p id="ob-gen-native" class="ob-note">${nativeOk ? desc.native : 'This medium has no native export writer yet; use Generate and analyze.'}</p>
          ${nativeOk && desc.nativeCaution ? html`<p class="ob-note ob-warn">${desc.nativeCaution}</p>` : null}
        </div>
        ${run.job ? html`<div class="ob-stack" style="gap:.35rem" role="status" aria-live="polite">
          <div class="ob-progress" role="progressbar" aria-label="Generation progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow=${Math.round(run.job.fraction * 100)}>
            <span style=${`width:${Math.max(2, run.job.fraction * 100)}%`}></span></div>
          <div class="ob-row"><span class="ob-note">${run.job.message}</span><span class="ob-spacer"></span>
            <button type="button" class="tlink" onClick=${() => run.job.cancel()}>Cancel</button></div>
        </div>` : null}
        ${run.err ? html`<p class="ob-err" role="alert">${run.err}</p>` : null}
        ${run.native ? html`<${NativeRun} last=${run.native} />` : null}
      </aside>
    </div>

    ${generated ? html`<${Recovery} g=${generated} check=${run.check} available=${state.recoveryAvailable} loaded=${loaded} name=${worldName(contexts, generated.spec)} />` : null}
  </section>`;
}

// The world a spec describes, in words: "Bridge-dependent workplace (Slack), 96 people, seed 1".
function worldName(contexts, spec) {
  if (!spec) return 'the generated world';
  const ctx = contexts.find(c => c.id === spec.context);
  const preset = ctx?.presets?.find(p => p.id === spec.structure);
  const scen = preset ? preset.label.split(': ')[0] : spec.structure;
  const med = ctx?.media?.find(m => (m.id || m) === spec.medium);
  return `${scen ? `${cap(scen)} ` : ''}${(ctx?.label || spec.context || '').toLowerCase()}${med?.label ? ` (${med.label})` : ''}, ${Number(spec.size).toLocaleString('en-US')} people, seed ${spec.seed}`;
}
const FORM_KEYS = ['context', 'medium', 'structure', 'size', 'seed', 'content', 'observation', 'days'];
const differs = (spec, form) => FORM_KEYS.some(k => spec[k] !== undefined && form[k] !== undefined && String(spec[k]) !== String(form[k]));
const specToForm = spec => Object.fromEntries([...FORM_KEYS, 'start', 'params'].filter(k => spec[k] !== undefined).map(k => [k, spec[k]]));

// The construction settings a check used, in words.
function settingsWords(st) {
  if (!st) return 'the default construction settings';
  const rules = Object.entries(st.rules || {}).filter(([, r]) => r.on).map(([k]) => RULE_LABEL[k] || k);
  const w = { count: 'tie weight = count of evidence', log: 'tie weight = log of count', binary: 'every tie counts 1' }[st.weighting || 'count'];
  return `ties from ${rules.join(', ') || 'nothing'}; ${st.directed ? 'directed' : 'undirected'}; ${w}`;
}

// Five or fewer choices: the shared segmented control. Unavailable choices
// stay visible, muted, and the reason is written out below, not struck through.
function SegChoice({ legend, name, items, value, onChange, help, why = [], caution }) {
  const hid = `ob-gen-${name}-help`;
  return html`<fieldset class="ob-fieldset">
    <legend id=${`ob-gen-${name}-legend`}>${legend}</legend>
    <div class="seg" role="group" aria-labelledby=${`ob-gen-${name}-legend`}>
      ${items.map(it => html`<button type="button" aria-pressed=${String(value === it.id)} disabled=${!it.enabled}
        aria-describedby=${help ? hid : undefined} onClick=${() => onChange(it.id)}>${it.label}</button>`)}
    </div>
    ${help ? html`<p id=${hid} class="ob-note">${help}</p>` : null}
    ${why.length ? html`<p class="ob-note">${why.map((it, i) => html`${i ? ' ' : ''}Not available: ${it.label}. ${it.reason}.`)}</p>` : null}
    ${caution ? html`<p class="ob-note ob-warn">${caution}</p>` : null}
  </fieldset>`;
}

function Param({ p, value, preset, onChange }) {
  const id = 'ob-gen-p-' + p.key;
  const shown = value ?? '';
  const dflt = preset !== undefined ? `Scenario: ${preset}` : p.default !== undefined ? `Default: ${p.default === true ? 'yes' : p.default === false ? 'no' : p.default}` : '';
  let input;
  if (p.choices) {
    input = html`<select id=${id} class="select" value=${shown} onChange=${e => onChange(e.currentTarget.value || undefined)}>
      <option value="">Default</option>${p.choices.map(c => html`<option value=${c.id}>${c.label}</option>`)}</select>`;
  } else if (p.type === 'boolean') {
    input = html`<select id=${id} class="select" value=${shown === '' ? '' : String(shown)} onChange=${e => onChange(e.currentTarget.value === '' ? undefined : e.currentTarget.value === 'true')}>
      <option value="">Default</option><option value="true">Yes</option><option value="false">No</option></select>`;
  } else if (p.type === 'int' || p.type === 'number') {
    input = html`<input id=${id} class="input" type="number" min=${p.min} max=${p.max} step=${p.step ?? (p.type === 'int' ? 1 : 'any')} value=${shown}
      aria-describedby=${dflt ? id + '-d' : undefined}
      onChange=${e => { const v = e.currentTarget.value; if (v === '') return onChange(undefined); let n = Number(v); if (p.min != null) n = Math.max(p.min, n); if (p.max != null) n = Math.min(p.max, n); if (p.type === 'int') n = Math.round(n); onChange(n); }} />`;
  } else {
    input = html`<input id=${id} class="input" value=${shown} aria-describedby=${dflt ? id + '-d' : undefined} onChange=${e => onChange(e.currentTarget.value || undefined)} />`;
  }
  return html`<div class="field"><label class="field__label" for=${id}>${p.label}</label>${input}
    ${dflt ? html`<span id=${id + '-d'} class="ob-help">${dflt}</span>` : null}${p.help ? html`<span class="ob-help">${p.help}</span>` : null}</div>`;
}

function NativeRun({ last }) {
  const base = last.name.replace(/\.[^.]+$/, '');
  const gtName = `${base}.ground-truth.json`;
  const readme = () => downloadText(`${base}.README.txt`, readmeText({ spec: last.spec, groundTruth: last.groundTruth, files: last.entries, gtName,
    description: { nativeCaution: null } }));
  const gt = () => downloadText(gtName, groundTruthJSON(last.groundTruth), 'application/json');
  return html`<div class="ob-stack ob-section" style="gap:.45rem">
    <h2 class="ob-h">Downloaded</h2>
    <p class="ob-note">${last.name}${last.entries.length > 1 ? `, ${last.entries.length} files` : ''}. Open it in Data, Import, as it is: no need to unzip it.</p>
    ${last.entries.length > 1 ? html`<ul class="ob-inline ob-mono" style="font-size:.75rem">${last.entries.slice(0, 12).map(f => html`<li>${f}</li>`)}${last.entries.length > 12 ? html`<li>and ${last.entries.length - 12} more</li>` : null}</ul>` : null}
    <p class="ob-row" style="gap:.4rem 1.25rem">
      <button type="button" class="tlink tlink--down" onClick=${readme}>README (what the files are)</button>
      <button type="button" class="tlink tlink--down" onClick=${gt}>Ground truth (JSON)</button>
    </p>
  </div>`;
}

// ---- recovery check ------------------------------------------------------------

const VERDICT = {
  recovered: { cls: 'ok', text: 'Recovered' },
  partly: { cls: 'caution', text: 'Partly' },
  missed: { cls: 'error', text: 'Missed' },
  'not checked': { cls: 'na', text: 'Not checked' },
};
const AREA = { observation: 'What the data shows', structure: 'Structure', survey: 'Survey answers', content: 'Content', diffusion: 'Spread of new terms', time: 'Change over time' };

function Recovery({ g, check, available, loaded, name }) {
  const rep = g.recovery;
  const stale = loaded && loaded.meta?.name !== g.datasetName;
  const span = g.groundTruth?.timespan;
  const now = useStore(s => s.settings);
  // The check was run with other construction settings than those in use now.
  const changed = rep && !stale && now && JSON.stringify(now) !== JSON.stringify(g.recoverySettings || null) && g.recoverySettings !== undefined;
  const mp = rep?.mapping;
  const accounts = g.people ?? mp?.datasetNodes;
  const inNet = mp?.networkPeople;
  return html`<section class="ob-section ob-recovery" id="ob-recovery" aria-labelledby="ob-rec-title">
    <div class="ob-row">
      <h2 id="ob-rec-title" class="ob-h">Recovery check: ${name}</h2>
      <span class="ob-spacer"></span>
      ${!stale ? html`<button type="button" class="tlink tlink--arrow" onClick=${() => store.actions.setView?.('network')}>Open network</button>` : null}
    </div>
    <p class="ob-text">${accounts?.toLocaleString('en-US') ?? '?'} accounts${mp?.bots ? `, ${mp.bots} ${mp.bots === 1 ? 'bot' : 'bots'} left out of the network` : ''}${inNet != null && inNet !== accounts - (mp?.bots || 0) ? ` (${inNet.toLocaleString('en-US')} people in the network)` : ''}; ${g.events?.toLocaleString('en-US') ?? '?'} events${span ? `, ${fmtDay(new Date(span.start).toISOString())} to ${fmtDay(new Date(span.end - 1).toISOString())}` : ''}.
      ${stale ? ' Other data has been loaded since; this check still refers to the generated world.' : ' Loaded for analysis.'}</p>
    <p class="ob-note">The recovery check compares the network reconstructed from the generated records with the ground-truth structure used to create them. It evaluates recovery of communities, brokers, content patterns, and change over time using the construction settings shown here.</p>
    <p class="ob-note">Construction settings: ${rep && g.recoverySettings ? 'those in use when the check ran' : rep ? 'the defaults' : 'those in use now'}${rep ? ` (${settingsWords(g.recoverySettings)})` : ''}.</p>
    <p class="ob-note">Changing the construction settings and running the check again provides a direct way to examine how measurement choices affect recovery.</p>
    ${changed ? html`<p class="ob-note ob-warn" role="status">The construction settings have changed since this check ran. <button type="button" class="tlink" onClick=${runRecoveryCheck}>Run it again with the current settings</button></p>` : null}
    ${!available ? html`<p class="ob-note">The generator has no recovery check in this build.</p>` : null}
    ${check?.busy ? html`<p class="ob-note" role="status">Checking what the analysis recovers...</p>` : null}
    ${check?.error ? html`<p class="ob-err" role="alert">${check.error}</p>` : null}
    ${check?.missing ? html`<${Unavailable} title="The recovery check needs parts that are not in this build yet">Missing: ${check.missing.join('; ')}.</${Unavailable}>` : null}
    ${rep ? html`<${Report} report=${rep} />` : null}
    ${available && !check?.busy ? html`<p><button type="button" class="tlink" onClick=${runRecoveryCheck}>${rep ? 'Run the check again' : 'Run recovery check'}</button></p>` : null}
  </section>`;
}

// Three decimals, as the check computes them, so a value never reads
// differently from the same number in a sentence (N15).
const fmtVal = v => (v === null || v === undefined ? '' : typeof v === 'number' ? (Number.isInteger(v) ? v.toLocaleString('en-US') : v.toFixed(3)) : String(v));

// The generator owns the report's shape ({ summary, checks[] }, see
// src/generator/recovery.js). Each check reads as a verdict and a plain
// sentence first, the numbers after; anything else falls back to key-value
// pairs so a new field never breaks the view.
function Report({ report }) {
  const rows = Array.isArray(report?.checks) ? report.checks : null;
  if (!rows) return html`<${KV} obj=${report} depth=${0} />`;
  const areas = [...new Set(rows.map(r => r.area || 'other'))];
  return html`<div class="ob-stack" style="gap:1rem">
    ${report.summary ? html`<p class="ob-text"><strong>${report.summary}</strong></p>` : null}
    ${report.rule ? html`<p class="ob-note"><strong>How verdicts are given.</strong> ${report.rule}</p>` : null}
    <${HowToRead} means="Each row compares one planted feature with the corresponding result from the reconstructed network, reported as a verdict, a reading, and the underlying values."
      scale="Agreement and share scores run from 0 (no correspondence with the planted structure) to 1 (exact correspondence). Where a chance value is shown, it is the score expected without any recovery of the planted structure, in the same units."
      mistake="A Recovered verdict applies to this planted structure, this export format, this population size, and these construction settings. It does not establish comparable performance on empirical data." />
    ${areas.map(a => html`<div class="ob-stack" style="gap:0">
      <h3 class="label">${AREA[a] || a}</h3>
      <ul class="ob-checks">${rows.filter(r => (r.area || 'other') === a).map(r => {
        const v = VERDICT[r.verdict] || VERDICT['not checked'];
        const nums = [r.planted && `Planted: ${r.planted}`, r.recovered && `Found: ${r.recovered}`,
          r.value !== null && r.value !== undefined && `${r.metric || 'Value'} ${fmtVal(r.value)}${r.baseline !== null && r.baseline !== undefined ? ` (chance ${fmtVal(r.baseline)})` : ''}`].filter(Boolean);
        return html`<li>
          <div class="ob-checks__head"><span class=${`flag flag--${v.cls}`}>${v.text}</span><span class="ob-checks__name">${r.name}</span></div>
          ${r.says ? html`<p class="ob-text">${r.says}</p>` : null}
          ${nums.length ? html`<p class="ob-note">${nums.join(' · ')}</p>` : null}
          ${Array.isArray(r.brokers) && r.brokers.length ? html`<div class="table-wrap ob-brokers"><table class="tbl">
            <caption class="visually-hidden">Planted brokers and their measured betweenness rank</caption>
            <thead><tr><th scope="col">Planted broker</th><th scope="col" class="num">Betweenness rank</th></tr></thead>
            <tbody>${r.brokers.map(b => html`<tr><td>${b.name}</td><td class="num">${b.rank ?? 'not in the network'}</td></tr>`)}</tbody></table></div>` : null}
        </li>`;
      })}</ul>
    </div>`)}
  </div>`;
}

function KV({ obj, depth }) {
  const entries = Object.entries(obj || {});
  return html`<dl class="ob-kv" style=${depth ? 'margin-left:1rem' : ''}>
    ${entries.map(([k, v]) => v && typeof v === 'object' && !Array.isArray(v) && depth < 2
      ? html`<dt>${k}</dt><dd><${KV} obj=${v} depth=${depth + 1} /></dd>`
      : html`<dt>${k}</dt><dd>${Array.isArray(v) ? `${v.length} items` : fmtVal(v)}</dd>`)}
  </dl>`;
}

export default GenerateView;
