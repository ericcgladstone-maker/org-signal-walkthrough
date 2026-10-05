// Ego builder step 6: review, analyze, export, resume.

import { html, useState } from '../../../../vendor/preact.js';
import { zipSync, strToU8 } from '../../../../vendor/fflate.js';
import * as E from '../../../builders/ego.js';
import { HandOffBar, downloadText, downloadBlob, readFileText } from '../shared.js';
import { Term, Verdict, HowToRead } from '../../components/common.js';

// Multi-file picker (Network Canvas exports come as three CSVs).
function pickFiles(accept) {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = true; input.style.display = 'none';
    input.onchange = () => { resolve([...(input.files || [])]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

export function ReviewStep({ s, update, replace }) {
  const [msg, setMsg] = useState(null);
  const ties = E.tieList(s);
  const p = E.progress(s);
  const prefix = E.ncPrefix(s);
  // What is left, in words (rather than a percentage that jumps between steps).
  const todo = E.todo(s);
  const build = () => {
    const done = s.finishedAt ? s : { ...s, finishedAt: new Date().toISOString() };
    if (!s.finishedAt) update(() => done);
    return E.toDataset(done);
  };
  const saveJSON = () => downloadText(`ego-session-${prefix}.json`, E.sessionToJSON(s), 'application/json');
  const saveNC = () => {
    const files = E.toNetworkCanvasCSV(s);
    const zip = zipSync(Object.fromEntries(files.map(f => [f.name, strToU8(f.text)])));
    downloadBlob(`${prefix}_networkCanvasExport.zip`, new Blob([zip], { type: 'application/zip' }));
  };
  const resume = async () => {
    const files = await pickFiles('.json,.csv,application/json,text/csv');
    if (!files.length) return;
    try {
      const texts = await Promise.all(files.map(async f => ({ name: f.name, text: await readFileText(f) })));
      const json = texts.find(t => /\.json$/i.test(t.name));
      const next = json ? E.sessionFromJSON(json.text) : E.fromNetworkCanvasCSV(texts.filter(t => /\.csv$/i.test(t.name)), { template: s });
      replace(next);
      setMsg({ ok: true, text: `Loaded ${next.alters.length} people from ${files.map(f => f.name).join(', ')}.` });
    } catch (e) { setMsg({ ok: false, text: e.message }); }
  };
  return html`<div class="ob-stack">
    <${EgoMeasures} s=${s} />
    <h4 class="label">The interview</h4>
    <dl class="ob-kv">
      <dt>Respondent</dt><dd>${s.egoLabel || 'unnamed'}${s.caseId ? ` (case ${s.caseId})` : ''}</dd>
      <dt>People named</dt><dd>${s.alters.length}</dd>
      <dt>Questions</dt><dd>${s.generators.map(g => `${g.name}: ${E.generatorCount(s, g.id)}`).join(', ') || 'none'}</dd>
      <dt>Answers</dt><dd>${p.answered} of ${p.cells} descriptions filled in</dd>
      <dt>Who knows whom</dt><dd>${ties.filter(t => t.on).length} of ${ties.length} pairs know each other; ${Object.keys(s.ties).length} set by hand</dd>
      <dt>Still to do</dt><dd>${todo.length ? todo.join('; ') : 'nothing: every step is complete'}</dd>
    </dl>
    <p class="ob-note">The network is ego's view: ties from the respondent to each person named (one per question that elicited them) and ties between those people as the respondent perceives them, not as observed.</p>
    <${HandOffBar} build=${build} disabled=${!s.alters.length} note=${s.alters.length ? null : 'Name at least one person first.'} />
    <div class="ob-section">
      <h3>Save and move data</h3>
      <div class="ob-row" style="gap:.5rem 1.5rem">
        <button type="button" class="tlink tlink--down" onClick=${saveJSON}>Save session (JSON)</button>
        <button type="button" class="tlink tlink--down" disabled=${!s.alters.length} onClick=${saveNC}>Network Canvas CSVs (zip)</button>
        <button type="button" class="tlink" onClick=${resume}>Resume from a file</button>
      </div>
      <p class="ob-note">The CSVs follow Network Canvas's export columns (ego file, attribute list, edge list), so they open in egor, ideanet or anything that reads Network Canvas. Resume accepts a saved session or those three CSVs.</p>
      ${msg ? html`<p class=${msg.ok ? 'ob-good' : 'ob-err'} role="status">${msg.text}</p>` : null}
    </div>
  </div>`;
}

const f3 = x => (Number.isFinite(x) ? x.toFixed(3) : '–');
const f1 = x => (Number.isFinite(x) ? (Math.round(x * 10) / 10).toString() : '–');

// The four numbers an ego-network assignment asks for, each with what it
// means and a reading, then one verdict on closed versus brokering (L12).
// Every tie counts 1 (Burt's binary formulas), whatever the interview's
// weighting, so a hand calculation gives the same numbers (C4).
export function EgoMeasures({ s }) {
  const m = E.egoMeasures(s);
  if (m.size < 2) return html`<p class="ob-note">Name at least two people to see the measures of this network.</p>`;
  // One rule (E.EGO_READING_RULE, by density) for the verdict and every line.
  const kind = m.reading;
  const known = kind === 'brokering' ? 'most of them do not know each other' : kind === 'mixed' ? 'some of them know each other' : 'most of them know each other';
  const verdict = kind === 'brokering'
    ? `Brokering: most of the people named do not know each other, so ${s.egoLabel || 'the respondent'} links people who would otherwise be apart.`
    : kind === 'closed'
      ? `Closed: most of the people named know each other, so they form one close-knit circle around ${s.egoLabel || 'the respondent'}.`
      : `In between: some groups of people named know each other, and ${s.egoLabel || 'the respondent'} links those groups.`;
  return html`<section class="ob-section ego-measures" aria-labelledby="ego-m-title">
    <h4 id="ego-m-title" class="label">This ego network</h4>
    <${Verdict} verdict=${verdict}
      plain=${`${f1(m.effectiveSize)} of the ${m.size} people named are non-redundant contacts (effective size), and ${m.ties} of the ${m.possible} pairs know each other (density ${f3(m.density)}).`}
      details=${`${E.EGO_READING_RULE} Every tie counts 1 (Burt 1992, unweighted). Ties among the people named are as the respondent sees them.`} />
    <dl class="ob-kv ego-measures__list">
      <dt><${Term} k="egoSize">Size</${Term}></dt><dd><strong>${m.size}</strong> <span class="ob-note">people named</span></dd>
      <dt><${Term} k="egoDensity">Density</${Term}></dt><dd><strong>${f3(m.density)}</strong> <span class="ob-note">${m.ties} of ${m.possible} pairs know each other: ${known}</span></dd>
      <dt><${Term} k="effectiveSize">Effective size</${Term}></dt><dd><strong>${f3(m.effectiveSize)}</strong> <span class="ob-note">size minus the average number of ties each person has to the others named: ${m.size} − 2 × ${m.ties} / ${m.size}</span></dd>
      <dt><${Term} k="constraint">Constraint</${Term}></dt><dd><strong>${f3(m.constraint)}</strong> <span class="ob-note">lower = more brokering. With ${m.size} people named it can only run from ${f3(m.constraintMin)} (nobody knows anybody else) to ${f3(m.constraintMax)} (everybody knows everybody). Not used for the reading above: close-knit clusters among the people named raise it even when the clusters do not know each other.</span></dd>
    </dl>
    <${HowToRead} means="Effective size counts the alters who are not redundant: an alter tied to many of ego's other contacts adds little new access. Constraint (Burt) is high when ego's contacts are tied to each other, concentrating ego in one close-knit group, and low when they are not, leaving ego in a brokerage position between them."
      scale=${`Effective size runs from 1 (everyone knows everyone) up to the size (${m.size}, nobody knows anybody else). Constraint depends strongly on size, so it is compared between egos who named a similar number of people, or interpreted against its range above.`}
      example=${`${f1(m.effectiveSize)} of ${m.size} non-redundant and constraint ${f3(m.constraint)}: ${kind === 'brokering' ? 'a brokering network' : kind === 'closed' ? 'a closed network' : 'partly closed, partly brokering'}.`}
      mistake="Constraint has no fixed scale: a network of ten people cannot go below 0.1, and close-knit groups inside it raise constraint even when the groups do not know each other." />
  </section>`;
}
