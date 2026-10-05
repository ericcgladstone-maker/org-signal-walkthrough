// Respondent mode: what someone sees when they open a share link
// (#survey=1.<data>) or the app's #respond address with a survey file.
//
// A focused page with no analysis navigation: who the survey is from, a
// plain privacy statement, the questions, and at the end a response file to
// download (or a text block to copy into an email). Nothing is uploaded: the
// survey arrived in the link's fragment, which browsers never send to a
// server, and the answers leave this device only when the respondent sends
// the file themselves. A draft is kept in this browser (best effort) so a
// closed tab does not lose the answers.
//
// The app shell (src/ui/app.js) mounts this instead of itself when the
// address carries a survey; no data from the organizer's session is present
// beyond the survey definition (questions and roster names).

import { html, render, useState, useEffect, useMemo } from '../../../../vendor/preact.js';
import { surveyFromHash, decodeSurvey, parseSurveyFile, makeResponse, responseFileText, responseFileName, responseToText,
  respondentSession, egoAnswers, sessionFromResponse } from '../../../builders/share.js';
import { tieList } from '../../../builders/ego.js';
import { describeTieValues, cleanTieValues } from '../../../builders/tiefields.js';
import { normName } from '../../../builders/common.js';
import { ensureBuildCss, storage, downloadText, pickFile, readFileText } from '../shared.js';
import { Combobox } from '../pick.js';
import { TieFieldInputs } from '../tiefields.js';
import { copyText } from '../sharing.js';
import { NamesStep, DescribeStep } from '../ego/collect.js';
import { TiesStep } from '../ego/ties.js';

export function isRespondentHash(hash) {
  return /^#(survey=|respond\b)/.test(String(hash || ''));
}

export function mountRespondent(el) {
  ensureBuildCss();
  document.title = 'Survey · Org Signal';
  document.documentElement.dataset.mode = 'respond';
  render(html`<${RespondentApp} />`, el);
}

function initial() {
  const v = surveyFromHash(location.hash);
  if (!v) return { def: null, error: null };
  try { return { def: decodeSurvey(v), error: null }; } catch (e) { return { def: null, error: e.message }; }
}

export function RespondentApp() {
  const [{ def, error }, setState] = useState(initial);
  const openFile = async () => {
    const f = await pickFile('.json,application/json');
    if (!f) return;
    try { setState({ def: parseSurveyFile(await readFileText(f)), error: null }); }
    catch (e) { setState({ def: null, error: e.message }); }
  };
  return html`<div class="rs">
    <header class="rs-head"><div class="rs-head__inner"><span class="brand__name">Org Signal</span><span class="meta">Survey</span></div></header>
    <main id="main" tabindex="-1" class="view view--col ob rs-main">
      ${def ? html`<${Survey} def=${def} />` : html`
        <header class="view__head"><div class="grow"><h1 class="view__title">${error ? 'This survey could not be opened' : 'Open a survey'}</h1>
          <p class="view__intro">${error ? `${error} Ask the person who sent it for a new link or the survey file.` : 'The person running this survey sent you a survey file. Open it here to answer.'}</p></div></header>
        <div class="ob-row"><button type="button" class="btn btn--primary" onClick=${openFile}>Open the survey file</button></div>
        <${Privacy} />`}
    </main>
  </div>`;
}

function Privacy() {
  return html`<section class="rs-privacy" aria-labelledby="rs-priv-h">
    <h2 id="rs-priv-h" class="label">Your answers stay with you</h2>
    <ul class="can-list">
      <li>This page has no server behind it. Nothing you enter is uploaded or sent anywhere.</li>
      <li>The survey itself came inside the link (the part after #, which browsers never send to a website).</li>
      <li>When you finish, you download a small response file and send it to the organizer yourself, by email or chat. Until then, your answers exist only in this browser.</li>
      <li>A draft is kept in this browser so you can come back to it; Clear my answers deletes it.</li>
    </ul>
  </section>`;
}

const draftKey = def => `orgsignal.respond.${def.id}`;

function Survey({ def }) {
  const [draft, setDraft] = useState(() => storage.get(draftKey(def), null) || { personId: null, label: '', answers: {}, session: null, step: 0 });
  useEffect(() => { storage.set(draftKey(def), draft); }, [draft]);
  const patch = p => setDraft(d => ({ ...d, ...(typeof p === 'function' ? p(d) : p) }));
  const startOver = () => { if (!confirm('Clear your answers? Everything you entered in this browser is deleted.')) return; storage.remove(draftKey(def)); setDraft({ personId: null, label: '', answers: {}, session: null, step: 0 }); };
  const steps = def.kind === 'roster' ? rosterSteps(def) : egoSteps(def, draft);
  const step = Math.min(draft.step || 0, steps.length - 1);
  const cur = steps[step];
  const go = k => { patch({ step: k }); requestAnimationFrame(() => { document.getElementById('rs-step')?.focus(); window.scrollTo?.(0, 0); }); };
  const canNext = cur.ready ? cur.ready(draft) : true;
  return html`<header class="view__head"><div class="grow">
      <h1 class="view__title">${def.title}</h1>
      ${def.intro ? html`<p class="view__intro rs-intro">${def.intro}</p>` : null}
    </div></header>
    ${step === 0 ? html`<${Privacy} />` : null}
    <div class="ob-row"><span class="meta">Step ${step + 1} of ${steps.length}</span><span class="ob-spacer"></span>
      <button type="button" class="tlink tlink--quiet" onClick=${startOver}>Clear my answers</button></div>
    <div class="ob-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax=${steps.length} aria-valuenow=${step + 1}><span style=${`width:${((step + 1) / steps.length) * 100}%`}></span></div>
    <h2 id="rs-step" tabindex="-1" class="ob-h">${cur.title}</h2>
    <${cur.C} key=${step} def=${def} draft=${draft} patch=${patch} go=${go} rel=${cur.rel} index=${cur.index} />
    <div class="ob-navrow">
      ${step > 0 ? html`<button type="button" class="tlink tlink--quiet" onClick=${() => go(step - 1)}>Back</button>` : html`<span></span>`}
      ${step < steps.length - 1 ? html`<button type="button" class="btn btn--primary" disabled=${!canNext} onClick=${() => go(step + 1)}>${step === steps.length - 2 ? 'Finish' : 'Next'}</button>` : null}
    </div>
    ${!canNext && cur.why ? html`<p class="ob-note" role="status">${cur.why}</p>` : null}`;
}

// ---- who are you ----------------------------------------------------------------

function WhoStep({ def, draft, patch }) {
  const me = def.people.find(p => p.id === draft.personId);
  if (def.people.length) {
    return html`<div class="ob-stack">
      <p class="ob-note">Find your own name on the list. Your answers are matched to it.</p>
      ${me ? html`<p class="rs-me">You are <strong>${me.label}</strong>. <button type="button" class="tlink tlink--quiet" onClick=${() => patch({ personId: null, label: '' })}>Not you? Choose again</button></p>`
        : html`<div style="max-width:24rem"><${Combobox} id="rs-who" label="Your name" items=${def.people} onPick=${x => patch({ personId: x.id, label: x.label })}
            placeholder="Type your name"
            noMatch=${t => `No one called "${t}" is on the list. Check the spelling, or type just your first name or your surname.`} /></div>`}
    </div>`;
  }
  return html`<div class="field" style="max-width:24rem"><label class="field__label" for="rs-name">Your name</label>
    <input id="rs-name" class="input" value=${draft.label} onInput=${e => patch({ label: e.currentTarget.value })} autocomplete="name" /></div>`;
}

const who = { title: 'Who are you?', C: WhoStep, ready: d => !!(d.personId || d.label.trim()), why: 'Choose your name to continue.' };

// ---- roster surveys -------------------------------------------------------------

function rosterSteps(def) {
  return [
    { ...who, ready: d => !!d.personId },
    ...def.relations.map((rel, i) => ({ title: rel.question || rel.name, C: RelationStep, rel, index: i })),
    { title: 'Send your answers', C: FinishStep },
  ];
}

function RelationStep({ def, draft, patch, rel, index }) {
  const [q, setQ] = useState('');
  const [onlyMine, setOnlyMine] = useState(false);
  const ans = draft.answers?.[rel.id] || {};
  const others = def.people.filter(p => p.id !== draft.personId);
  const shown = others.filter(p => (!q.trim() || normName(p.label).includes(normName(q))) && (!onlyMine || ans[p.id]));
  // a: the new answer, null to clear, or a function of the current one (so
  // quick successive edits of one person's details never overwrite each other).
  const setAns = (pid, a) => patch(d => {
    const cur = { ...(d.answers?.[rel.id] || {}) };
    const next = typeof a === 'function' ? a(cur[pid]) : a;
    if (!next) delete cur[pid]; else cur[pid] = next;
    return { answers: { ...d.answers, [rel.id]: cur } };
  });
  const count = Object.keys(ans).length;
  return html`<div class="ob-stack">
    <p class="ob-note">${rel.scale === 'valued' ? `Rate each person who applies from 1 to ${rel.max}; leave the rest blank.` : 'Tick everyone who applies; leave the rest.'}${rel.fields?.length ? ' For each person you choose, a few optional details follow.' : ''}</p>
    <div class="ob-row">
      <div class="field" style="flex:1 1 14rem;max-width:22rem"><label class="field__label" for=${`rs-find-${index}`}>Find a name</label>
        <input id=${`rs-find-${index}`} class="input" type="search" value=${q} onInput=${e => setQ(e.currentTarget.value)} placeholder="Type to filter the list" /></div>
      <label class="check"><input type="checkbox" checked=${onlyMine} onChange=${e => setOnlyMine(e.currentTarget.checked)} />Only people I chose (${count})</label>
    </div>
    <ul class="rs-people" aria-label=${rel.name}>
      ${shown.map(p => {
        const a = ans[p.id];
        return html`<li key=${p.id} class=${a ? 'on' : ''}>
          ${rel.scale === 'valued'
            ? html`<div class="rs-person"><span class="rs-person__name" id=${`rs-n-${index}-${p.id}`}>${p.label}</span>
                <div class="seg seg--scale" role="group" aria-labelledby=${`rs-n-${index}-${p.id}`}>
                  ${Array.from({ length: rel.max }, (_, k) => k + 1).map(v => html`<button type="button" aria-pressed=${String(a?.value === v)}
                    aria-label=${`${p.label}: ${v}`} onClick=${() => setAns(p.id, a?.value === v ? null : { ...(a || {}), value: v })}>${v}</button>`)}
                </div></div>`
            : html`<label class="check rs-person"><input type="checkbox" checked=${!!a} onChange=${e => setAns(p.id, e.currentTarget.checked ? { value: 1 } : null)} />
                <span class="rs-person__name">${p.label}</span></label>`}
          ${a && rel.fields?.length ? html`<div class="rs-fields">
            <${TieFieldInputs} fields=${rel.fields} values=${a.fields || {}} idPrefix=${`rs-f-${index}-${p.id}`} labelFor=${f => f.label}
              onChange=${(k, v) => setAns(p.id, x => (x ? { ...x, fields: { ...(x.fields || {}), [k]: v } } : x))} /></div>` : null}
        </li>`;
      })}
      ${!shown.length ? html`<li class="ob-note">No one matches.</li>` : null}
    </ul>
  </div>`;
}

// ---- ego surveys ----------------------------------------------------------------

function egoSteps(def, draft) {
  const steps = [who];
  steps.push({ title: 'The people you know', C: EgoNames, ready: d => (d.session?.alters?.length || 0) > 0, why: 'Name at least one person to continue.' });
  if (def.ego.interpreters.length || def.ego.tieFields.length) steps.push({ title: 'About each person', C: EgoDescribe });
  // Always present when asked, so the step count does not change mid-survey (C16).
  if (def.ego.askTies) steps.push({ title: 'Who knows whom', C: EgoTies });
  steps.push({ title: 'Send your answers', C: FinishStep });
  return steps;
}

function useSession(def, draft, patch) {
  const s = useMemo(() => {
    const base = respondentSession(def, { label: draft.label, personId: draft.personId });
    return draft.session ? { ...base, ...draft.session, generators: base.generators, interpreters: base.interpreters, tieFields: base.tieFields } : base;
  }, [def, draft.session, draft.label, draft.personId]);
  const update = fn => patch(d => {
    const cur = d.session ? { ...respondentSession(def, d), ...d.session } : respondentSession(def, d);
    const next = fn(cur);
    return { session: { alters: next.alters, contexts: next.contexts, ties: next.ties, distinct: next.distinct || [] } };
  });
  return [s, update];
}

function EgoNames({ def, draft, patch }) {
  const [s, update] = useSession(def, draft, patch);
  const ctx = def.people.length ? { roster: def.people, selfId: draft.personId, allowOthers: def.ego.allowOthers, respondent: true } : { respondent: true };
  return html`<div class="ego"><${NamesStep} s=${s} update=${update} ctx=${ctx} /></div>`;
}
function EgoDescribe({ def, draft, patch }) {
  const [s, update] = useSession(def, draft, patch);
  return html`<div class="ego"><${DescribeStep} s=${s} update=${update} /></div>`;
}
function EgoTies({ def, draft, patch }) {
  const [s, update] = useSession(def, draft, patch);
  return html`<div class="ego"><${TiesStep} s=${s} update=${update} /></div>`;
}

// ---- finish ----------------------------------------------------------------------

function FinishStep({ def, draft }) {
  const [copied, setCopied] = useState(null);
  // Made fresh at each download or copy, so its time is when it was sent:
  // the organizer keeps the latest response from each person.
  const make = () => {
    const answers = def.kind === 'roster' ? draft.answers : egoAnswers({ alters: [], contexts: [], ties: {}, ...(draft.session || {}) });
    return makeResponse(def, { personId: draft.personId, label: draft.label }, answers);
  };
  let response = null, err = null;
  try { response = make(); } catch (e) { err = e.message; }
  if (err) return html`<p class="ob-err" role="alert">${err}</p>`;
  const text = responseToText(response);
  const [saved, setSaved] = useState(null);
  const download = () => { const r = make(); const name = responseFileName(r); downloadText(name, responseFileText(r), 'application/json'); setSaved(`Saved ${name} to your downloads folder. Now send it to the organizer.`); };
  const copy = async () => { const ok = await copyText(responseToText(make())); setCopied(ok ? 'Copied. Paste it into an email to the organizer.' : 'Copying is blocked here; select the text below and copy it.'); };
  return html`<div class="ob-stack">
    <${Summary} def=${def} response=${response} />
    <p>Download your response and send the file to the person who sent you this survey, the way they asked (for example a course dropbox, email or chat). It holds only your answers, shown above, and the survey's questions and names.</p>
    <div class="ob-row" style="gap:.75rem 1.5rem">
      <button type="button" class="btn btn--primary" onClick=${download}>Download my response</button>
      <button type="button" class="tlink" onClick=${copy}>Copy it as text instead</button>
    </div>
    ${saved ? html`<p class="ob-good" role="status">${saved}</p>` : null}
    ${copied ? html`<p class="ob-note" role="status">${copied}</p>` : null}
    <details><summary class="tlink">Show the text</summary>
      <p class="ob-note">The first lines say what you answered in words; the block of letters after them is the same answers packed so they arrive intact.</p>
      <label class="visually-hidden" for="rs-text">Your response as text</label>
      <textarea id="rs-text" class="input rs-text" rows="8" readonly value=${text} onFocus=${e => e.currentTarget.select()}></textarea></details>
    <p class="ob-note">You can change your answers and download again; the organizer uses the latest response from each person.</p>
  </div>`;
}

function Summary({ def, response }) {
  const name = id => def.people.find(p => p.id === id)?.label || id;
  if (def.kind === 'roster') {
    return html`<dl class="ob-kv">
      <dt>You</dt><dd>${response.respondent.label}</dd>
      ${def.relations.map(rel => {
        const a = response.answers[rel.id] || {};
        const list = Object.entries(a).map(([pid, x]) => `${name(pid)}${rel.scale === 'valued' ? ` (${x.value})` : ''}${x.fields ? `: ${describeTieValues(rel.fields, cleanTieValues(rel.fields, x.fields))}` : ''}`);
        return html`<dt>${rel.name}</dt><dd>${list.length ? list.join('; ') : 'no one'}</dd>`;
      })}
    </dl>`;
  }
  const al = response.answers.alters;
  return html`<dl class="ob-kv">
    <dt>You</dt><dd>${response.respondent.label}</dd>
    <dt>People named</dt><dd>${al.length ? al.map(a => a.label).join(', ') : 'no one'}</dd>
    ${def.ego.askTies ? html`<dt>Pairs who know each other</dt><dd>${countTies(response)}</dd>` : null}
  </dl>`;
}

function countTies(r) {
  return tieList(sessionFromResponse(r.definition, r)).filter(p => p.on).length;
}
