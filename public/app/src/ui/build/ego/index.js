// Ego network builder: a six-step interview (name generators, interpreters,
// names, descriptions, who knows whom, review). The session autosaves to
// localStorage when it can and can be saved or resumed as JSON.
//
// "Send as a survey" turns the same questions into a share link: each
// respondent does their own interview in respondent mode and sends back a
// response file (./share.js); the steps are then the questions and Share.

import { html, useState, useEffect } from '../../../../vendor/preact.js';
import * as E from '../../../builders/ego.js';
import { Steps, storage, usePersistentState } from '../shared.js';
import { EgoShareStep, SHARE_KEY, newEgoShare } from './share.js';
import { GeneratorsStep, InterpretersStep } from './setup.js';
import { NamesStep, DescribeStep } from './collect.js';
import { TiesStep } from './ties.js';
import { ReviewStep } from './review.js';
import { exampleSession, exampleById } from '../../../builders/examples.js';

const KEY = 'orgsignal.build.ego.session';

function load() {
  const saved = storage.get(KEY, null);
  if (saved) { try { return E.sessionFromJSON(saved); } catch { /* corrupt draft: start fresh */ } }
  let s = E.newSession();
  s = E.addGenerator(s, { preset: 'discuss' });
  s = E.addInterpreter(s, { preset: 'relationship' });
  s = E.addInterpreter(s, { preset: 'closeness' });
  return s;
}

const VIEWS = { generators: GeneratorsStep, interpreters: InterpretersStep, names: NamesStep, describe: DescribeStep, ties: TiesStep, review: ReviewStep, share: EgoShareStep };
const SURVEY_STEPS = [E.STEPS[0], E.STEPS[1], { id: 'share', label: 'Share and collect' }];

// example: { id, nonce } from the Build view (a #build?example=<id> link).
export function EgoBuilder({ example = null } = {}) {
  const [s, setS] = useState(load);
  const [share, setShare] = usePersistentState(SHARE_KEY, newEgoShare);
  const survey = share.mode === 'survey';
  const steps = survey ? SURVEY_STEPS : E.STEPS;
  useEffect(() => { storage.set(KEY, s); }, [s]);
  const update = fn => setS(prev => fn(prev));
  const go = step => {
    setS(prev => ({ ...prev, step }));
    // Move focus to the step heading so keyboard and screen-reader users land in the new step.
    requestAnimationFrame(() => document.getElementById('ego-step-title')?.focus());
  };
  const p = E.progress(s);
  const i = Math.max(0, steps.findIndex(x => x.id === s.step));
  const cur = steps[i];
  const done = steps.filter(x => p.steps[x.id] >= 1).map(x => x.id);
  const V = VIEWS[cur.id] || GeneratorsStep;
  const setMode = mode => { setShare(x => ({ ...x, mode })); if (mode === 'survey' && !SURVEY_STEPS.some(x => x.id === s.step)) go('share'); if (mode === 'interview' && s.step === 'share') go('names'); };
  // A worked example replaces the interview on screen (asking first when it
  // holds names) and opens at Review, where the ego measures are.
  const openExample = (id = 'ego-10') => {
    const next = exampleSession(id);
    if (!next) return;
    if (s.alters.length && !s.example && !confirm(`Open the example interview "${exampleById(id).title}"? The interview on screen is replaced; save it first (Review, Save session) to keep it.`)) return;
    if (survey) setShare(x => ({ ...x, mode: 'interview' }));
    setS(next);
    requestAnimationFrame(() => document.getElementById('ego-step-title')?.focus());
  };
  useEffect(() => { if (example?.id) openExample(example.id); }, [example?.nonce]);
  const reset = () => {
    if (!confirm('Start a new interview? The current one is discarded unless you saved it.')) return;
    storage.remove(KEY);
    setS(load());
  };
  return html`<div class="ob-stack ego">
    <div class="seg" role="group" aria-label="How the interview is done">
      <button type="button" aria-pressed=${String(!survey)} onClick=${() => setMode('interview')}>Interview one person here</button>
      <button type="button" aria-pressed=${String(survey)} onClick=${() => setMode('survey')}>Send as a survey to many</button>
    </div>
    <div class="ob-row">
      <span class="meta">Step ${i + 1} of ${steps.length}</span>
      <span class="ob-spacer"></span>
      <button type="button" class="tlink tlink--quiet" onClick=${reset}>${survey ? 'New questions' : 'New interview'}</button>
    </div>
    <${Steps} steps=${steps} value=${cur.id} onChange=${go} done=${done} />
    <h3 id="ego-step-title" tabindex="-1" class="ob-h ego-step-title">${i + 1}. ${cur.label}</h3>
    ${s.example && exampleById(s.example) ? html`<details class="ob-example" open=${cur.id === 'review' || undefined}>
      <summary><span class="label">Worked example</span> <strong>${exampleById(s.example).title}</strong>: what to look for</summary>
      <ul class="ob-notes">${exampleById(s.example).lookFor.map(t => html`<li>${t}</li>`)}</ul>
      <p class="ob-note">Step back through the interview to see how it was answered; New interview starts your own.</p>
    </details>` : null}
    <${V} s=${s} update=${update} replace=${next => setS(next)} survey=${survey} share=${share} setShare=${setShare} onExample=${() => openExample()} />
    <div class="ob-navrow">
      ${i > 0 ? html`<button type="button" class="tlink tlink--quiet" onClick=${() => go(steps[i - 1].id)}>Back: ${steps[i - 1].label}</button>` : html`<span></span>`}
      ${i < steps.length - 1 ? html`<button type="button" class="btn btn--primary" onClick=${() => go(steps[i + 1].id)}>Next: ${steps[i + 1].label}</button>` : null}
    </div>
  </div>`;
}

export default EgoBuilder;
