// Roster (bounded network) builder UI: roster -> relations -> collect -> review.

import { html, useState, useMemo } from '../../../../vendor/preact.js';
import { newRoster, makeRelation, RELATION_PRESETS, MERGE_RULES, formTemplate, parseRosterResponses, responsesFromDataset, tiesFor, toDataset, coverage, rosterFromResponses, setTieAttrs, pruneTieAttrs, weightFieldOf } from '../../../builders/roster.js';
import { setTie } from '../../../builders/matrix.js';
import { uid } from '../../../builders/common.js';
import { surveyFromRoster, recombine, recombineNotes, rosterRespondents } from '../../../builders/share.js';
import { ShareLink, ResponsesIn, RecombineNotes } from '../sharing.js';
import { TieFieldsEditor } from '../tiefields.js';
import { Steps, HandOffBar, usePersistentState, downloadText, pickFile, readFileText } from '../shared.js';
import { importRosterResponses } from '../service.js';
import { Matrix, PairEntry } from './Matrix.js';
import { PeopleEditor } from './People.js';

const KEY = 'orgsignal.build.roster';
const STEPS = [
  { id: 'roster', label: 'Roster' },
  { id: 'relations', label: 'Relations' },
  { id: 'collect', label: 'Collect ties' },
  { id: 'review', label: 'Review' },
];

export function RosterBuilder() {
  const [model, setModel] = usePersistentState(KEY, newRoster);
  const [step, setStep] = useState(model.people.length ? (model.relations.length ? 'collect' : 'relations') : 'roster');
  const patch = p => setModel(m => ({ ...m, ...(typeof p === 'function' ? p(m) : p) }));
  const done = [model.people.length > 1 && 'roster', model.relations.length && 'relations',
    model.relations.some(r => Object.keys(tiesFor(model, r.id).ties).length) && 'collect'].filter(Boolean);
  const idx = STEPS.findIndex(s => s.id === step);
  const [surveyMsg, setSurveyMsg] = useState(null);
  // A responses file is a whole roster: people, questions and answers. It
  // replaces the current roster (after asking, if there is one) and opens
  // the collect step, where coverage and the combine rule are shown.
  const fromSurvey = (text, file) => {
    const m = rosterFromResponses(text, { file });
    if (!m) { setSurveyMsg({ err: true, text: 'This file does not look like survey responses (no grid columns such as "Question [Name]").' }); return false; }
    if (model.people.length && !confirm(`Replace the current roster (${model.people.length} people) with the one in ${file || 'this file'}?`)) return false;
    setModel(m);
    const rule = MERGE_RULES.find(r => r.id === m.mergeRule);
    setSurveyMsg({ text: `Read ${m.people.length} people, ${m.relations.length} ${m.relations.length === 1 ? 'question' : 'questions'} and ${m.responses.respondents.length} responses from ${file || 'the file'}. The answers are combined with ${rule.label} (${rule.help.split('.')[0].toLowerCase()}); change it under Combine the self-reports.` });
    setStep('collect');
    return true;
  };

  return html`<div class="ob-stack">
    <div class="ob-row">
      <${Steps} steps=${STEPS} value=${step} onChange=${setStep} done=${done} />
      <span class="ob-spacer"></span>
      <button type="button" class="tlink tlink--quiet" onClick=${() => { if (confirm('Start a new roster? The current one will be cleared.')) { setModel(newRoster()); setStep('roster'); setSurveyMsg(null); } }}>New roster</button>
    </div>
    ${surveyMsg && step !== 'roster' ? html`<p class=${surveyMsg.err ? 'ob-note ob-err' : 'ob-note ob-good'} role="status">${surveyMsg.text}</p>` : null}
    ${step === 'roster' ? html`<div class="ob-stack">
        <${FromSurvey} model=${model} onModel=${fromSurvey} />
        <div class="ob-section">
          <h3>Or list the people yourself</h3>
          <${PeopleEditor} people=${model.people} attrColumns=${model.attrColumns} idPrefix="ob-roster"
            onChange=${(people, attrColumns) => patch({ people, attrColumns })} onSurvey=${(text, file) => fromSurvey(text, file)} />
        </div>
      </div>`
    : step === 'relations' ? html`<${Relations} model=${model} patch=${patch} />`
    : step === 'collect' ? html`<${Collect} model=${model} patch=${patch} />`
    : html`<${Review} model=${model} patch=${patch} />`}
    <div class="ob-navrow">
      ${idx > 0 ? html`<button type="button" class="tlink tlink--quiet" onClick=${() => setStep(STEPS[idx - 1].id)}>Back: ${STEPS[idx - 1].label}</button>` : html`<span></span>`}
      ${idx < STEPS.length - 1 ? html`<button type="button" class="btn btn--primary" onClick=${() => setStep(STEPS[idx + 1].id)}>Next: ${STEPS[idx + 1].label}</button>` : null}
    </div>
  </div>`;
}

// Step 1's shortcut for a survey that has already run: the responses file
// lists everyone, so it is the roster.
function FromSurvey({ onModel }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const go = async () => {
    const f = await pickFile('.csv,.tsv,text/csv');
    if (!f) return;
    setBusy(true); setErr(null);
    try { if (onModel(await readFileText(f), f.name) === false) setErr(`${f.name} was not used.`); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return html`<div class="ob-stack" style="gap:.5rem">
    <h3>Start from survey responses</h3>
    <p class="ob-note">Already ran the survey? A Google Forms or Qualtrics responses export (grid questions like "Who do you spend free time with? [Name]") holds the whole roster: the people, the questions and every answer. Dropping the same file on Data, Import also reads it.</p>
    <div class="ob-row"><button type="button" class="btn" disabled=${busy} onClick=${go}>${busy ? 'Reading...' : 'Import survey responses'}</button></div>
    ${err ? html`<p class="ob-note ob-err" role="alert">${err}</p>` : null}
  </div>`;
}

function Relations({ model, patch }) {
  const [custom, setCustom] = useState('');
  const has = p => model.relations.some(r => r.name === p.name);
  const togglePreset = p => patch(m => ({ relations: has(p) ? m.relations.filter(r => r.name !== p.name) : [...m.relations, makeRelation(p)] }));
  const update = (id, q) => patch(m => ({ relations: m.relations.map(r => (r.id === id ? { ...r, ...q } : r)) }));
  const remove = id => patch(m => ({ relations: m.relations.filter(r => r.id !== id), ties: Object.fromEntries(Object.entries(m.ties).filter(([k]) => k !== id)) }));
  return html`<div class="ob-stack">
    <fieldset class="ob-fieldset">
      <legend>Common relations</legend>
      <div class="ob-row">${RELATION_PRESETS.map(p => html`<label class="check"><input type="checkbox" checked=${has(p)} onChange=${() => togglePreset(p)} />${p.name}</label>`)}</div>
    </fieldset>
    <form class="ob-row" onSubmit=${e => { e.preventDefault(); if (custom.trim()) { patch(m => ({ relations: [...m.relations, makeRelation({ name: custom.trim(), question: '' })] })); setCustom(''); } }}>
      <label class="visually-hidden" for="ob-rel-custom">Custom relation</label>
      <input id="ob-rel-custom" class="input" style="max-width:18rem" placeholder="Custom relation, e.g. Shares information" value=${custom} onInput=${e => setCustom(e.currentTarget.value)} />
      <button type="submit" class="btn" disabled=${!custom.trim()}>Add relation</button>
    </form>
    ${model.relations.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>Relation</th><th>Question asked</th><th>Answer</th><th class="num">Top of scale</th><th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody>${model.relations.map(r => html`<tr key=${r.id}>
        <td><input class="input" aria-label="Relation name" value=${r.name} onChange=${e => update(r.id, { name: e.currentTarget.value || r.name })} /></td>
        <td style="min-width:16rem"><input class="input" aria-label=${`Question for ${r.name}`} value=${r.question} placeholder="Question text" onChange=${e => update(r.id, { question: e.currentTarget.value })} /></td>
        <td><select class="select" aria-label=${`Answer type for ${r.name}`} value=${r.scale} onChange=${e => update(r.id, { scale: e.currentTarget.value })}>
          <option value="binary">Yes or no</option><option value="valued">Rating</option></select></td>
        <td class="num">${r.scale === 'valued' ? html`<input class="input" type="number" min="2" max="10" style="width:4.5rem" aria-label=${`Top of scale for ${r.name}`} value=${r.max}
          onChange=${e => update(r.id, { max: Math.max(2, Math.min(10, Number(e.currentTarget.value) || 5)) })} />` : html`<span class="muted">—</span>`}</td>
        <td><button type="button" class="btn btn--sm btn--quiet" aria-label=${`Remove ${r.name}`} onClick=${() => remove(r.id)}>Remove</button></td>
      </tr>
      <tr class="ob-subrow" key=${r.id + '-f'}><td colspan="5">
        <details open=${(r.fields || []).length > 0}><summary class="tlink">Tie fields for ${r.name}${(r.fields || []).length ? ` (${r.fields.length})` : ''}: type, strength, how often, notes</summary>
          <${TieFieldsEditor} fields=${r.fields || []} idPrefix=${'ob-tf-' + r.id} onChange=${fields => update(r.id, { fields })}
            intro="Optional details recorded on each tie of this relation. Every one is optional for whoever answers." />
        </details>
        <${WeightChoice} r=${r} onChange=${weightField => update(r.id, { weightField })} /></td></tr>`)}</tbody></table></div>` : html`<p class="ob-empty">Choose at least one relation.</p>`}
  </div>`;
}

// Which answer is the tie's weight (C1): a 1 to N rating asked about every
// tie is, unless the organizer chooses "every tie counts 1".
function WeightChoice({ r, onChange }) {
  if (r.scale === 'valued') return html`<p class="ob-note">Tie weight: the rating (1 to ${r.max}).</p>`;
  const numeric = (r.fields || []).filter(f => f.type === 'scale' || f.type === 'number');
  if (!numeric.length) return null;
  const wf = weightFieldOf(r);
  return html`<div class="ob-row" style="gap:.4rem .75rem;margin-top:.4rem">
    <label class="field__label" for=${'ob-wf-' + r.id}>Tie weight for ${r.name}</label>
    <select id=${'ob-wf-' + r.id} class="select select--sm" style="width:auto" value=${wf?.key || ''} onChange=${e => onChange(e.currentTarget.value)}>
      ${numeric.map(f => html`<option value=${f.key}>${f.label}${f.type === 'scale' ? ` (1 to ${f.max})` : ''}</option>`)}
      <option value="">Every tie counts 1</option></select>
    <span class="ob-note">${wf ? `Each tie weighs its ${wf.label} answer; it goes out with the network in every export.` : 'The ratings are kept on the ties but do not weight them.'}</span>
  </div>`;
}

function Collect({ model, patch }) {
  const [relId, setRelId] = useState(model.relations[0]?.id);
  const [entry, setEntry] = useState(model.people.length > 25 ? 'grid' : 'grid');
  const rel = model.relations.find(r => r.id === relId) || model.relations[0];
  if (!model.people.length || !rel) return html`<p class="ob-empty">Add the roster and at least one relation first.</p>`;
  const values = model.ties[rel.id] || {};
  const attrs = model.tieAttrs?.[rel.id] || {};
  const fields = rel.fields || [];
  // Clearing a tie clears its details too.
  const onSet = (from, to, v) => patch(m => pruneTieAttrs({ ...m, ties: { ...m.ties, [rel.id]: setTie(m.ties[rel.id] || {}, from, to, v) } }));
  const onSetAttrs = (from, to, vals) => patch(m => setTieAttrs(m, rel.id, from, to, vals));
  return html`<div class="ob-stack">
    <fieldset class="ob-fieldset">
      <legend id="ob-roster-mode">Who answers</legend>
      <div class="seg" role="group" aria-labelledby="ob-roster-mode">
        <button type="button" aria-pressed=${String(model.mode === 'single')} onClick=${() => patch({ mode: 'single' })}>One informant fills the grid</button>
        <button type="button" aria-pressed=${String(model.mode === 'multi')} onClick=${() => patch({ mode: 'multi' })}>Each member answers a survey</button>
      </div>
    </fieldset>
    ${model.mode === 'single' ? html`
      <div class="ob-row">
        ${model.relations.length > 1 ? html`<div class="field"><label class="field__label" for="ob-roster-rel">Relation</label>
          <select id="ob-roster-rel" class="select" value=${rel.id} onChange=${e => setRelId(e.currentTarget.value)}>
            ${model.relations.map(r => html`<option value=${r.id}>${r.name}</option>`)}</select></div>` : html`<h3>${rel.name}</h3>`}
        <span class="ob-spacer"></span>
        <div class="seg" role="group" aria-label="Entry method">
          <button type="button" aria-pressed=${String(entry === 'grid')} onClick=${() => setEntry('grid')}>Grid</button>
          <button type="button" aria-pressed=${String(entry === 'pairs')} onClick=${() => setEntry('pairs')}>Pairs</button>
        </div>
      </div>
      ${rel.question ? html`<p class="ob-note">${rel.question}</p>` : null}
      ${entry === 'grid'
        ? html`<${Matrix} people=${model.people} values=${values} onSet=${onSet} scale=${rel.scale} max=${rel.max} caption=${`${rel.name} ties`} rowHeading="Who" colHeading="Names"
            fields=${fields} attrs=${attrs} onSetAttrs=${onSetAttrs} />`
        : html`<${PairEntry} people=${model.people} values=${values} onSet=${onSet} scale=${rel.scale} max=${rel.max} fields=${fields} attrs=${attrs} />`}`
    : html`<${MultiCollect} model=${model} patch=${patch} />`}
  </div>`;
}

function MultiCollect({ model, patch }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  let tpl = null, tplErr = null;
  try { tpl = formTemplate(model); } catch (e) { tplErr = e.message; }
  const resp = model.responses;
  const cov = coverage(model);
  const importResponses = async () => {
    const f = await pickFile('.csv,.tsv,text/csv');
    if (!f) return;
    setBusy(true); setErr(null);
    try {
      // The survey importer (importers-A) gets the first try; if it is not in
      // the build or does not recognise the file, the documented roster-matrix
      // shapes are parsed here.
      const ds = await importRosterResponses(f);
      let r = ds ? responsesFromDataset(ds, model) : null;
      if (!r || !r.respondents.length) r = parseRosterResponses(await readFileText(f), model);
      patch({ responses: { ...r, file: f.name } });
      if (!r.respondents.length) setErr('No responses could be matched to the roster. Check that the file has a "Your name" column and grid columns named "Question [Name]".');
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  };
  return html`<div class="ob-stack">
    <${ShareSection} model=${model} patch=${patch} />
    <details class="ob-section">
      <summary class="tlink">Or use Google Forms or Qualtrics instead of a link</summary>
    <div class="ob-section">
      <h3>1. Build the form</h3>
      ${tplErr ? html`<p class="ob-err">${tplErr}</p>` : html`
        <p class="ob-note">Download a template and the written instructions. The template's columns are exactly what Google Forms or Qualtrics will export, so it also works for typing in paper questionnaires.</p>
        <div class="ob-row" style="gap:.5rem 1.5rem">
          <button type="button" class="tlink tlink--down" onClick=${() => downloadText('roster-template-google-forms.csv', tpl.googleCsv, 'text/csv')}>Template, Google Forms shape</button>
          <button type="button" class="tlink tlink--down" onClick=${() => downloadText('roster-template-qualtrics.csv', tpl.qualtricsCsv, 'text/csv')}>Template, Qualtrics shape</button>
          <button type="button" class="tlink tlink--down" onClick=${() => downloadText('roster-form-instructions.txt', tpl.instructions)}>Instructions</button>
        </div>
        <details><summary class="tlink">Read the instructions here</summary>
          <pre class="ob-instructions">${tpl.instructions}</pre></details>`}
    </div>
    <div class="ob-section">
      <h3>2. Import the responses</h3>
      <div class="ob-row">
        <button type="button" class="btn" disabled=${busy || !!tplErr} onClick=${importResponses}>${busy ? 'Reading...' : 'Import responses CSV'}</button>
        ${resp?.file ? html`<span class="ob-note">${resp.file}${resp.format ? ` (${resp.format})` : ''}</span>` : null}
      </div>
      ${err ? html`<p class="ob-err" role="alert">${err}</p>` : null}
      ${resp ? html`<dl class="ob-kv">
        <dt>Responded</dt><dd>${cov.respondents} of ${cov.of}</dd>
        ${cov.missing.length ? html`<dt>No response</dt><dd>${cov.missing.slice(0, 12).join(', ')}${cov.missing.length > 12 ? ` and ${cov.missing.length - 12} more` : ''}</dd>` : null}
        ${resp.unmatchedNames?.length ? html`<dt>Not on roster</dt><dd class="ob-warn">${resp.unmatchedNames.join(', ')}</dd>` : null}
        ${resp.unmatchedQuestions?.length ? html`<dt>Unused questions</dt><dd class="ob-warn">${resp.unmatchedQuestions.join('; ')}</dd>` : null}
        ${(resp.warnings || []).map(w => html`<dt>Note</dt><dd>${w}</dd>`)}
      </dl>` : null}
    </div>
    </details>
    <fieldset class="ob-fieldset">
      <legend>3. Combine the self-reports</legend>
      <div class="radios">
      ${MERGE_RULES.map(r => html`<label class="radio">
        <input type="radio" name="ob-merge" checked=${model.mergeRule === r.id} onChange=${() => patch({ mergeRule: r.id })} />
        <span>${r.label}${r.id === 'union' ? ' (default)' : ''}</span><span class="radio__desc">${r.help}</span></label>`)}
      </div>
    </fieldset>
  </div>`;
}

function Review({ model, patch }) {
  const [sel, setSel] = useState(() => model.relations.map(r => r.id));
  const rows = useMemo(() => model.relations.map(r => ({ r, ...tiesFor(model, r.id) })), [model]);
  const nTies = rows.filter(x => sel.includes(x.r.id)).reduce((s, x) => s + Object.keys(x.ties).length, 0);
  return html`<div class="ob-stack">
    <div class="field" style="max-width:24rem">
      <label class="field__label" for="ob-roster-name">Network name</label>
      <input id="ob-roster-name" class="input" value=${model.name} onInput=${e => patch({ name: e.currentTarget.value })} />
    </div>
    <div class="table-wrap"><table class="tbl">
      <thead><tr><th>Include</th><th>Relation</th><th class="num">Ties</th><th>Direction</th>${model.mode === 'multi' ? html`<th class="num">Reciprocated pairs</th><th class="num">One-sided pairs</th>` : null}</tr></thead>
      <tbody>${rows.map(x => html`<tr>
        <td><input type="checkbox" aria-label=${`Include ${x.r.name}`} checked=${sel.includes(x.r.id)}
          onChange=${e => setSel(s => (e.currentTarget.checked ? [...s, x.r.id] : s.filter(i => i !== x.r.id)))} /></td>
        <td>${x.r.name}</td><td class="num">${Object.keys(x.ties).length}</td>
        <td>${x.directed ? 'directed' : 'undirected'}</td>
        ${model.mode === 'multi' ? html`<td class="num">${x.stats.reciprocated ?? '—'}</td><td class="num">${x.stats.oneSided ?? '—'}</td>` : null}
      </tr>`)}</tbody></table></div>
    <dl class="ob-kv">
      <dt>People</dt><dd>${model.people.length}</dd>
      <dt>Collected by</dt><dd>${model.mode === 'multi' ? `survey of members, ${MERGE_RULES.find(r => r.id === model.mergeRule)?.label.toLowerCase()}` : 'one informant'}</dd>
      <dt>Kind of network</dt><dd>full (bounded roster), self-reported</dd>
    </dl>
    <${HandOffBar} disabled=${!model.people.length || !sel.length} build=${() => toDataset(model, { relationIds: sel })}
      note=${nTies ? null : 'No ties yet; the network will have isolates only.'} />
  </div>`;
}

// The share-link way of collecting: make the link, then read the response
// files back. Every response read so far is kept (model.shared.items) so
// files can arrive over days; each import recombines the whole set, the
// latest response per person winning.
function ShareSection({ model, patch }) {
  const share = model.share || null;
  const meta = { title: share?.title ?? model.name, intro: share?.intro ?? '' };
  const ensure = p => patch(m => ({ share: { id: m.share?.id || uid('s'), createdAt: m.share?.createdAt || new Date().toISOString(), title: m.share?.title ?? m.name, intro: m.share?.intro ?? '', ...p } }));
  const makeDef = () => surveyFromRoster(model, { id: share?.id || 'pending', title: meta.title, intro: meta.intro, createdAt: share?.createdAt });
  const [notes, setNotes] = useState(model.shared?.notes || null);
  const read = ({ items, surveys, errors }) => {
    const def = surveyFromRoster(model, { id: share.id, title: meta.title, intro: meta.intro, createdAt: share.createdAt });
    const all = [...(model.shared?.items || []), ...items];
    const res = recombine(all, { survey: def });
    res.invalid.push(...errors.map(e => ({ file: e.file, reason: e.reason })));
    const n = recombineNotes(res);
    if (surveys.length) n.push({ level: 'info', text: 'A survey file was among the files; it is the survey itself, not a response, and was skipped.' });
    setNotes(n);
    // Keep only what this survey can use, so a wrong file is not re-reported forever.
    const keep = all.filter(x => x.ok && x.response.survey.id === share.id);
    patch({ shared: { items: keep, notes: n }, responses: { respondents: rosterRespondents(res), file: `${res.accepted.length} response ${res.accepted.length === 1 ? 'file' : 'files'}`, format: 'shared link', unmatchedNames: [], unmatchedQuestions: [], warnings: [] } });
  };
  return html`<div class="ob-section">
    <h3>1. Send a link</h3>
    ${share ? html`<${ShareLink} makeDef=${makeDef} meta=${meta} onMeta=${p => ensure(p)} idPrefix="ob-roster-share" />`
      : html`<p class="ob-note">Each member opens the link on their own computer or phone, finds their own name, answers for themselves, and sends you back a small response file. No form service and no server: nothing anyone enters is uploaded.</p>
        <div class="ob-row"><button type="button" class="btn" onClick=${() => ensure({})} disabled=${!model.people.length || !model.relations.length}>Make a share link</button></div>`}
    ${share ? html`<h3>2. Collect the responses</h3>
      <${ResponsesIn} onRead=${read} idPrefix="ob-roster-resp" />
      <${RecombineNotes} notes=${notes} />
      ${model.shared?.items?.length ? html`<p class="ob-note">Dropping the same response files on Data, Import gives the same network.</p>` : null}` : null}
  </div>`;
}
