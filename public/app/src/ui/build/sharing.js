// Shared surveys in the builders: the organizer's side. ShareLink makes the
// link (and the survey file for rosters too large for a link); ResponsesIn
// reads response files and pasted response text; RecombineNotes says who
// responded, who did not, duplicates and rejected responses. The formats
// and the recombining are in src/builders/share.js.

import { html, useState } from '../../../vendor/preact.js';
import { surveyLink, surveyFileText, fileStem, parseResponses, LINK_LIMIT } from '../../builders/share.js';
import { downloadText, readFileText, DraftInput } from './shared.js';

// The app's own address (index.html's folder), wherever the builder is mounted.
export function appBase() {
  return new URL('../../../', import.meta.url).href;
}

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

function pickFiles(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = true; input.style.display = 'none';
    input.onchange = () => { resolve([...(input.files || [])]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

// meta: { title, intro }; onMeta(patch). makeDef(): the survey definition
// (throws with a reason when the survey is not ready).
export function ShareLink({ makeDef, meta, onMeta, idPrefix = 'ob-share', privacy }) {
  const [copied, setCopied] = useState(null);
  let def = null, err = null, link = null;
  try { def = makeDef(); link = surveyLink(def, appBase()); } catch (e) { err = e.message; }
  const copy = async () => { const ok = await copyText(link.url); setCopied(ok ? 'Link copied.' : 'Copying is blocked here; select the link and copy it.'); };
  const respondUrl = appBase() + '#respond';
  return html`<div class="ob-stack ob-share">
    <div class="ob-grid-form">
      <div class="field"><label class="field__label" for=${idPrefix + '-title'}>Survey title respondents see</label>
        <${DraftInput} id=${idPrefix + '-title'} value=${meta.title || ''} onInput=${v => onMeta({ title: v })} /></div>
    </div>
    <div class="field"><label class="field__label" for=${idPrefix + '-intro'}>Message to respondents (optional)</label>
      <textarea id=${idPrefix + '-intro'} class="input" rows="2" placeholder="Why you are asking, by when, and who to send the response to"
        value=${meta.intro || ''} onInput=${e => onMeta({ intro: e.currentTarget.value })}></textarea></div>
    ${err ? html`<p class="ob-err" role="alert">${err}</p>` : html`
      ${link.tooLong ? html`<p class="ob-note ob-warn" role="status">This survey is too large for a link (${link.length.toLocaleString('en-US')} characters; links over ${LINK_LIMIT.toLocaleString('en-US')} break in email and chat). Send the survey file instead: respondents open <span class="ob-mono">${respondUrl}</span> and choose the file.</p>`
        : html`<div class="field"><label class="field__label" for=${idPrefix + '-url'}>Share link (${link.length.toLocaleString('en-US')} characters)</label>
          <textarea id=${idPrefix + '-url'} class="input ob-share__url" rows="3" readonly value=${link.url} onFocus=${e => e.currentTarget.select()}></textarea></div>`}
      <div class="ob-row" style="gap:.5rem 1.5rem">
        ${link.tooLong ? null : html`<button type="button" class="tlink" onClick=${copy}>Copy link</button>
          <a class="tlink tlink--arrow" href=${link.url} target="_blank" rel="noopener">Open it as a respondent</a>`}
        <button type="button" class="tlink tlink--down" onClick=${() => downloadText(`${fileStem(def.title)}.survey.json`, surveyFileText(def), 'application/json')}>Survey file</button>
      </div>
      ${copied ? html`<p class="ob-note" role="status">${copied}</p>` : null}
      <p class="ob-note">${privacy || 'The link carries only the survey: its questions and the names on the roster. Attributes you entered are not included.'} Nothing is uploaded: the survey travels in the part of the link after #, which browsers never send to a server, and each respondent's answers stay on their device until they send you their response file.</p>`}
  </div>`;
}

// Read response files and pasted response text. onRead({ items, surveys, errors, files }).
export function ResponsesIn({ onRead, idPrefix = 'ob-resp', busyLabel = 'Reading...' }) {
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState('');
  const fromFiles = async () => {
    const files = await pickFiles('.json,.txt,application/json,text/plain');
    if (!files.length) return;
    setBusy(true);
    try {
      const out = { items: [], surveys: [], errors: [], files: files.map(f => f.name) };
      for (const f of files) {
        const r = parseResponses(await readFileText(f), { file: f.name });
        out.items.push(...r.responses); out.surveys.push(...r.surveys); out.errors.push(...r.errors);
      }
      onRead(out);
    } finally { setBusy(false); }
  };
  const fromPaste = () => {
    const r = parseResponses(paste);
    onRead({ items: r.responses, surveys: r.surveys, errors: r.errors, files: [] });
    if (r.responses.length) setPaste('');
  };
  return html`<div class="ob-stack">
    <div class="ob-row"><button type="button" class="btn" disabled=${busy} onClick=${fromFiles}>${busy ? busyLabel : 'Import response files'}</button>
      <span class="ob-note">Choose all of them at once; more can be added later.</span></div>
    <div class="field"><label class="field__label" for=${idPrefix + '-paste'}>Or paste responses from email</label>
      <textarea id=${idPrefix + '-paste'} class="input" rows="3" placeholder="-----BEGIN ORG SIGNAL RESPONSE----- ... (several can be pasted together)"
        value=${paste} onInput=${e => setPaste(e.currentTarget.value)}></textarea></div>
    <div class="ob-row"><button type="button" class="tlink" disabled=${!paste.trim()} onClick=${fromPaste}>Read the pasted responses</button></div>
    <p class="ob-note ob-warn">Response files show exactly who named whom. Keep them to yourself: to share results with participants or a class, share the analyzed network or its exports (with contact details left out), not the files.</p>
  </div>`;
}

// notes: recombineNotes(result) lines.
export function RecombineNotes({ notes }) {
  if (!notes?.length) return null;
  return html`<ul class="ob-notes" aria-label="What the responses gave">
    ${notes.map(n => html`<li class=${n.level === 'error' ? 'ob-err' : n.level === 'warn' ? 'ob-warn' : ''}>${n.text}</li>`)}
  </ul>`;
}
