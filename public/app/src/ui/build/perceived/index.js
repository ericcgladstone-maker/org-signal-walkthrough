// Perceived networks (cognitive social structures) UI:
// people -> informants -> each informant's report -> results.

import { html, useState, useMemo, useEffect } from '../../../../vendor/preact.js';
import { newCSS, addInformant, perInformantAccuracy, disagreement, referenceFromDataset, viewTies, viewLabel, toDataset, las,
  undirectedOf, setUndirected, setInformantTie, toggleInformantTie, symmetrize, symmetryCheck, bestPerceiver, isMutualRelation, CSS_RELATIONS, reportedCount } from '../../../builders/perceived.js';
import { parseAdjacencyCSV, adjacencyCSV, splitKey } from '../../../builders/matrix.js';
import { Term, Verdict } from '../../components/common.js';
import { Steps, HandOffBar, usePersistentState, pickFile, readFileText, downloadText } from '../shared.js';
import { currentDataset } from '../service.js';
import { useStore, store } from '../../store.js';
import { Matrix } from '../roster/Matrix.js';
import { PeopleEditor } from '../roster/People.js';

const KEY = 'orgsignal.build.perceived';
const STEPS = [
  { id: 'people', label: 'People' },
  { id: 'informants', label: 'Informants' },
  { id: 'reports', label: 'Reports' },
  { id: 'results', label: 'Compare' },
];

// study: { css, nonce } from a #build?perceived=... link (a classic dataset's
// perceptions). It replaces the study here, asking first when one is entered
// and it is not the same dataset's, and opens Compare.
export function PerceivedBuilder({ study = null } = {}) {
  const [css, setCss] = usePersistentState(KEY, newCSS);
  const [step, setStep] = useState(css.people.length ? (css.informants.length ? 'reports' : 'informants') : 'people');
  useEffect(() => {
    if (!study) return;
    const s = study.css;
    const same = css.classic && css.classic === s.classic && css.relation?.name === s.relation?.name;
    if (css.people.length && !same && !confirm(`Open ${s.name || 'these perceived networks'} in Perceived? The study entered here now is replaced.`)) return;
    setCss(s);
    setStep('results');
    store.actions.notify?.('info', `Opened ${s.people.length} people and ${s.informants.length} informants' reports (${s.relation?.name}). Compare shows consensus and accuracy.`);
  }, [study?.nonce]);
  const patch = p => setCss(c => ({ ...c, ...(typeof p === 'function' ? p(c) : p) }));
  const idx = STEPS.findIndex(s => s.id === step);
  const done = [css.people.length > 1 && 'people', css.informants.length > 1 && 'informants',
    css.informants.length && css.informants.every(i => Object.keys(i.ties).length) && 'reports'].filter(Boolean);
  return html`<div class="ob-stack">
    <div class="ob-row">
      <${Steps} steps=${STEPS} value=${step} onChange=${setStep} done=${done} />
      <span class="ob-spacer"></span>
      <button type="button" class="tlink tlink--quiet" onClick=${() => { if (confirm('Start a new perceived-network study? The people, informants and reports entered so far are cleared.')) { setCss(newCSS()); setStep('people'); } }}>New perceived study</button>
    </div>
    ${step === 'people' ? html`<${PeopleEditor} people=${css.people} withAttrs=${false} idPrefix="ob-css"
        onChange=${people => patch(c => ({ people, informants: c.informants.filter(i => !i.personId || people.some(p => p.id === i.personId)) }))} />`
    : step === 'informants' ? html`<${Informants} css=${css} patch=${patch} />`
    : step === 'reports' ? html`<${Reports} css=${css} patch=${patch} />`
    : html`<${Results} css=${css} />`}
    <div class="ob-navrow">
      ${idx > 0 ? html`<button type="button" class="tlink tlink--quiet" onClick=${() => setStep(STEPS[idx - 1].id)}>Back: ${STEPS[idx - 1].label}</button>` : html`<span></span>`}
      <span class="ob-spacer"></span>
      ${idx < STEPS.length - 1 ? html`<button type="button" class="btn btn--primary" onClick=${() => setStep(STEPS[idx + 1].id)}>Next: ${STEPS[idx + 1].label}</button>` : null}
    </div>
  </div>`;
}

function Informants({ css, patch }) {
  const isInf = id => css.informants.some(i => i.personId === id);
  const toggle = id => patch(c => (isInf(id) ? { informants: c.informants.filter(i => i.personId !== id) } : addInformant(c, id)));
  const und = undirectedOf(css);
  // Choosing a relation by name also sets its usual direction; the checkbox
  // can override it.
  const setRelName = name => patch(c => {
    const preset = CSS_RELATIONS.find(r => r.name.toLowerCase() === name.trim().toLowerCase());
    const next = { ...c, relation: { ...c.relation, name, ...(preset ? { question: preset.question } : {}) } };
    return setUndirected(next, preset ? preset.undirected : isMutualRelation(name));
  });
  return html`<div class="ob-stack">
    <div class="ob-grid-form">
      <div class="field"><label class="field__label" for="ob-css-rel">Relation</label>
        <input id="ob-css-rel" class="input" list="ob-css-rels" value=${css.relation.name} onChange=${e => setRelName(e.currentTarget.value)} />
        <datalist id="ob-css-rels">${CSS_RELATIONS.map(r => html`<option value=${r.name} />`)}</datalist></div>
      <div class="field" style="grid-column:span 2"><label class="field__label" for="ob-css-q">Question each informant answers about every pair</label>
        <input id="ob-css-q" class="input" value=${css.relation.question} onInput=${e => patch(c => ({ relation: { ...c.relation, question: e.currentTarget.value } }))} /></div>
    </div>
    <label class="check"><input type="checkbox" checked=${und} onChange=${e => patch(c => setUndirected(c, e.currentTarget.checked))} />
      <span><strong>Mutual relation</strong> <span class="ob-note">(undirected, like friendship): ticking Ana and Ben also ticks Ben and Ana, every count is over pairs of people, and the network is analyzed without direction. Turn it off for one-way relations such as advice.</span></span></label>
    <p class="ob-note"><strong>Informants</strong> are the people who report the network as they see it, usually the group's own members. Each one fills in the whole who-and-whom grid, including ties between other people. Outside observers can be added too.</p>
    <fieldset class="ob-fieldset">
      <legend>Roster members who report</legend>
      <div class="ob-row">
        <button type="button" class="btn btn--sm" onClick=${() => patch(c => css.people.reduce((acc, p) => (acc.informants.some(i => i.personId === p.id) ? acc : addInformant(acc, p.id)), c))}>Everyone</button>
        <button type="button" class="btn btn--sm" onClick=${() => patch(c => ({ informants: c.informants.filter(i => !i.personId) }))}>No one</button>
      </div>
      <div class="ob-row">${css.people.map(p => html`<label class="check"><input type="checkbox" checked=${isInf(p.id)} onChange=${() => toggle(p.id)} />${p.label}</label>`)}</div>
    </fieldset>
    <div class="ob-row">
      <button type="button" class="btn" onClick=${() => patch(c => addInformant(c, null))}>Add an outside observer</button>
      <span class="meta">${css.informants.length} informants</span>
    </div>
    ${css.informants.filter(i => !i.personId).map(i => html`<div class="ob-row">
      <label class="visually-hidden" for=${'ob-obs-' + i.id}>Observer name</label>
      <input id=${'ob-obs-' + i.id} class="input" style="max-width:16rem" value=${i.label}
        onInput=${e => patch(c => ({ informants: c.informants.map(x => (x.id === i.id ? { ...x, label: e.currentTarget.value } : x)) }))} />
      <button type="button" class="btn btn--sm btn--quiet" onClick=${() => patch(c => ({ informants: c.informants.filter(x => x.id !== i.id) }))}>Remove</button>
    </div>`)}
  </div>`;
}

function Reports({ css, patch }) {
  const [cur, setCur] = useState(css.informants[0]?.id);
  const [msg, setMsg] = useState(null);
  const inf = css.informants.find(i => i.id === cur) || css.informants[0];
  if (!inf) return html`<p class="ob-empty">Choose informants first.</p>`;
  const setInfObj = f => patch(c => ({ informants: c.informants.map(x => (x.id === inf.id ? f(x) : x)) }));
  const setInf = ties => setInfObj(x => ({ ...x, ties, mirrored: {} }));
  const und = undirectedOf(css);
  const onSet = (from, to, v) => setInfObj(x => setInformantTie(css, x, from, to, v));
  const onToggle = (from, to) => setInfObj(x => toggleInformantTie(css, x, from, to));
  const sym = symmetryCheck(css);
  const importCsv = async () => {
    const f = await pickFile('.csv,.tsv,text/csv');
    if (!f) return;
    const r = parseAdjacencyCSV(await readFileText(f), css.people);
    if (r.error) { setMsg({ err: true, text: r.error }); return; }
    setInfObj(x => ({ ...x, ties: und ? symmetrize(r.ties) : r.ties, mirrored: {} }));
    setMsg({ text: `${Object.keys(r.ties).length} ties read from ${f.name}${r.unknown.length ? `; not on the roster: ${r.unknown.join(', ')}` : ''}.` });
  };
  return html`<div class="ob-stack">
    <div class="ob-row">
      <div class="field"><label class="field__label" for="ob-css-inf">Informant</label>
        <select id="ob-css-inf" class="select" value=${inf.id} onChange=${e => { setCur(e.currentTarget.value); setMsg(null); }}>
          ${css.informants.map(i => html`<option value=${i.id}>${i.label} (${reportedCount(css, i.ties)} ties)</option>`)}</select></div>
      <span class="ob-spacer"></span>
      <button type="button" class="btn btn--sm" onClick=${importCsv}>Import matrix CSV</button>
      <button type="button" class="btn btn--sm" onClick=${() => downloadText(`perceived-${inf.label}.csv`, adjacencyCSV(css.people, inf.ties), 'text/csv')}>Download as CSV</button>
      <button type="button" class="btn btn--sm btn--quiet" disabled=${!Object.keys(inf.ties).length} onClick=${() => setInf({})}>Clear</button>
    </div>
    ${msg ? html`<p class=${msg.err ? 'ob-note ob-err' : 'ob-note'} role="status">${msg.text}</p>` : null}
    <p class="ob-note">The network as ${inf.label} sees it${css.relation.question ? html`, answering "${css.relation.question}"` : ''}.
      ${und ? ` ${css.relation.name || 'This relation'} is mutual: tick a pair once, in either cell, and its mirror is ticked too. Clicking the mirror keeps the tie; to clear it, click the cell you ticked or press Delete.` : ` A row is the person who ${css.relation.name ? `has the ${css.relation.name.toLowerCase()} tie` : 'sends the tie'}, a column the person it goes to.`}</p>
    <${SymmetryNote} sym=${css.classic ? null : sym} />
    <${Matrix} people=${css.people} values=${inf.ties} onSet=${onSet} onToggle=${onToggle} mutual=${und} caption=${`${inf.label}'s view`} />
  </div>`;
}

// Mutual off: informants whose matrices differ in symmetry are named (M1).
// Not shown for a published study (css.classic): its informants' answers are
// the data, and a one-way relation such as advice is often returned.
function SymmetryNote({ sym }) {
  if (!sym) return null;
  const share = l => { const r = sym.rows.find(x => x.label === l); return `${l} ${Math.round(r.share * 100)}%`; };
  if (sym.mixed) return html`<p class="ob-note ob-warn" role="status">Informants filled in the grid in different ways. Share of each one's ties ticked in both directions: ${[...sym.twoWay, ...sym.oneWay].map(share).join(', ')}. Compared as one-way ties, the two-way reports count as extra ties and score worse. If the relation is mutual, turn on Mutual relation under Informants.</p>`;
  if (sym.allTwoWay) return html`<p class="ob-note" role="status">Every informant ticked (almost) every tie in both directions, so the relation looks mutual. Turn on Mutual relation under Informants to count each pair once.</p>`;
  return null;
}

const andList = a => (a.length < 3 ? a.join(' and ') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
const pct = x => (Number.isFinite(x) ? `${Math.round(x * 100)}%` : '—');
const num = x => (Number.isFinite(x) ? x.toFixed(2) : '—');

// The reference's tie filters in words ("; only relation: advice"), and a
// warning when the loaded network's relation is not the one the informants
// reported on (Construction settings decide which relation is loaded).
const refFilterWords = ref => (ref?.filters?.length ? `; only ${ref.filters.map(f => `${f.key}: ${f.values ? f.values.join(', ') : `${f.min ?? ''}-${f.max ?? ''}`}`).join('; ')}, as in Construction settings` : '');
function relationMismatch(css, ref) {
  const f = ref?.filters?.find(x => x.key === 'relation' && x.values);
  const name = String(css.relation?.name || '').trim().toLowerCase();
  if (!name) return '';
  if (!f) return ref?.multiRelation ? ` The loaded network mixes several relations; set its relation filter to ${css.relation.name} in Construction settings.` : '';
  return f.values.some(v => String(v).toLowerCase() === name) ? '' : ` Note: the informants reported ${css.relation.name}, but the loaded network shows ${f.values.join(', ')}. Change the relation filter in Construction settings to compare like with like.`;
}

function Results({ css }) {
  const [threshold, setThreshold] = useState(0.5);
  const [view, setView] = useState('consensus');
  const und = undirectedOf(css);
  const ds = useStore(s => s.dataset) ?? currentDataset();
  const tieFields = useStore(s => s.settings?.tieFields) || null;
  const ref = useMemo(() => (ds ? referenceFromDataset(ds, css.people, { tieFields }) : null), [ds, css, tieFields]);
  const refTies = ref && !ref.fromStudy && ref.matched >= 2 ? (und ? symmetrize(ref.ties) : ref.ties) : null;
  const acc = useMemo(() => perInformantAccuracy(css, { threshold, reference: refTies }), [css, threshold, refTies]);
  const dis = useMemo(() => disagreement(css, { limit: 15 }), [css]);
  const ties = useMemo(() => viewTies(css, view, { threshold }), [css, view, threshold]);
  const missing = useMemo(() => las(css, 'union').missing, [css]);
  const sym = symmetryCheck(css);
  if (css.informants.length < 2) return html`<p class="ob-empty">Comparing perceptions needs at least two informants.</p>`;
  const views = [
    { id: 'consensus', label: 'Consensus' }, { id: 'las-union', label: 'Judged by its two people: either says yes (LAS union)' }, { id: 'las-intersection', label: 'Judged by its two people: both say yes (LAS intersection)' },
    ...css.informants.map(i => ({ id: i.id, label: `As seen by ${i.label}` })),
  ];
  // Scores: against a loaded network when one is loaded (not one built from
  // these reports), otherwise against the consensus of the other informants
  // (leave-one-out). Never against a consensus that includes the informant's
  // own report, which is circular.
  const key = refTies ? 'vsReference' : 'vsOthers';
  const crit = refTies ? 'loaded network' : `consensus of the other informants`;
  const best = bestPerceiver(acc, key);
  const bestOthers = refTies ? bestPerceiver(acc, 'vsOthers') : null;
  const tieCount = und ? Object.keys(ties).length / 2 : Object.keys(ties).length;
  const pairWord = und ? 'pair' : 'tie';
  // A directed view in which no tie is returned: reciprocity 0 and closeness
  // 0 for some people are then artifacts of which cell was ticked (M2).
  const oneWayOnly = !und && tieCount > 2 && !Object.keys(ties).some(k => { const [i, j] = splitKey(k); return ties[`${j}|${i}`]; });
  return html`<div class="ob-stack">
    <${SymmetryNote} sym=${css.classic ? null : sym} />
    ${best ? html`<${Verdict} verdict=${best.tied ? `${andList(best.labels)} perceive the network equally well.` : `${best.labels[0]} perceives the network best.`}
      plain=${`Highest Jaccard against the ${crit}: ${num(best.jaccard)} (1 = the same ties exactly, 0 = no tie in common).${bestOthers ? ` Against the consensus of the other informants: ${andList(bestOthers.labels)} (${num(bestOthers.jaccard)}).` : ''}`}
      details=${refTies ? `The reference is the loaded network (${ref.matched} roster members matched by name${refFilterWords(ref)}).${relationMismatch(css, ref)}` : `Each informant is scored against the consensus of the other ${css.informants.length - 1} informant${css.informants.length > 2 ? 's' : ''} (${css.informants.length > 2 ? `ties at least ${Math.round(threshold * 100)}% of them reported` : 'the other one\'s report'}), leaving their own report out, so nobody is scored against themselves.${ref?.fromStudy ? ' The network now loaded was built from these reports, so it is not used as a reference: that would be circular.' : ''}`} />` : null}
    <div class="field">
      <label class="field__label" for="ob-css-th">Consensus threshold: ${Math.round(threshold * 100)}% of informants</label>
      <input id="ob-css-th" class="ob-range" type="range" min="0.1" max="1" step="0.05" value=${threshold} onInput=${e => setThreshold(Number(e.currentTarget.value))} />
      <span class="ob-help">A ${pairWord} is in the consensus when at least this share of informants report it.</span>
    </div>

    <div class="ob-section">
      <h3>How each informant compares</h3>
      <p class="ob-note">Counted over ${und ? 'pairs of people (the relation is mutual)' : 'one-way ties (each direction counts on its own)'}. Scored against the ${crit}${refTies ? '' : ', leaving each informant\'s own report out'}. <strong>Hits</strong>: ${pairWord}s the informant reported that are also in the ${crit}. <strong>False alarms</strong>: ${pairWord}s they reported that are not. <strong>Hit rate</strong>: hits divided by all the ${pairWord}s in the ${crit} (how much of it they saw). <strong>Jaccard</strong>: hits divided by the ${pairWord}s in either, so it punishes both misses and false alarms; use it to say who perceives best. ${refTies ? `The reference is the loaded network (${ref.matched} roster members matched by name${refFilterWords(ref)}).${relationMismatch(css, ref)}` : ref?.fromStudy ? 'The network now loaded was built from these reports, so it is not a reference. Load an observed network for this group to score against it.' : 'Load an observed network for this group to also score against it.'}</p>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th>Informant</th><th class="num">${und ? 'Pairs' : 'Ties'} reported</th><th class="num">Hits</th><th class="num">False alarms</th><th class="num">Hit rate</th><th>Jaccard vs ${refTies ? 'reference' : 'others'}</th>
          ${refTies ? html`<th class="num">Jaccard vs others</th>` : null}</tr></thead>
        <tbody>${acc.map(a => { const x = a[key]; return html`<tr>
          <td>${a.label}</td><td class="num">${a.reported}</td><td class="num">${x.hits}</td><td class="num">${x.falseAlarms}</td>
          <td class="num">${pct(x.hitRate)}</td>
          <td style="white-space:nowrap"><span class="ob-mono">${num(x.jaccard)}</span><span class="ob-bartrack" aria-hidden="true"><span class="ob-bar" style=${`width:${(Number.isFinite(x.jaccard) ? x.jaccard : 0) * 100}%`}></span></span></td>
          ${refTies ? html`<td class="num">${num(a.vsOthers.jaccard)}</td>` : null}
        </tr>`; })}</tbody></table></div>
    </div>

    <div class="ob-section">
      <h3>${und ? 'Pairs' : 'Ties'} informants disagree about most</h3>
      ${dis.length ? html`<div class="table-wrap"><table class="tbl">
        <thead><tr><th>${und ? 'Pair' : 'Tie'}</th><th class="num">Share reporting it</th><th>Disagreement</th></tr></thead>
        <tbody>${dis.map(d => html`<tr><td>${d.fromLabel} ${und ? 'and' : '→'} ${d.toLabel}</td><td class="num">${pct(d.share)}</td>
          <td style="white-space:nowrap"><span class="ob-mono">${num(d.score)}</span><span class="ob-bartrack" aria-hidden="true"><span class="ob-bar" style=${`width:${d.score * 100}%`}></span></span></td></tr>`)}
        </tbody></table></div>
        <p class="ob-note">Disagreement is 4p(1 − p) for the share p of informants reporting it: 1 at an even split, 0 when everyone agrees.</p>`
      : html`<p class="ob-note">All informants agree on every ${pairWord}.</p>`}
    </div>

    <div class="ob-section">
      <h3>Network to analyze</h3>
      <div class="ob-cols">
        <div class="ob-stack">
          <div class="field"><label class="field__label" for="ob-css-view">View</label>
            <select id="ob-css-view" class="select" value=${view} onChange=${e => setView(e.currentTarget.value)}>
              ${views.map(v => html`<option value=${v.id}>${v.label}</option>`)}</select></div>
          <p class="ob-note">${viewLabel(css, view, threshold)}: ${tieCount} ${tieCount === 1 ? 'tie' : 'ties'}, analyzed as ${und ? 'an undirected network (the relation is mutual)' : 'a directed network'}.
            ${view.startsWith('las') ? ' The tie between two people is decided by those two people only (a locally aggregated structure).' : ''}
            ${view.startsWith('las') && missing.length ? html` <span class="ob-warn">Without their own report: ${missing.join(', ')}.</span>` : null}</p>
          ${view === 'consensus' ? html`<p class="ob-note">Each tie's weight is the share of informants who reported it (0.75 = three in four), so a person's strength in People is the sum of these shares.</p>` : null}
          ${oneWayOnly ? html`<p class="ob-note ob-warn">No tie in this view goes both ways, so reciprocity will be 0 and closeness 0 for anyone who only receives ties. If ${css.relation.name || 'the relation'} is mutual, turn on Mutual relation under Informants.</p>` : null}
          <${HandOffBar} build=${() => toDataset(css, { view, threshold })} />
        </div>
        <${Preview} people=${css.people} ties=${ties} label=${viewLabel(css, view, threshold)} undirected=${und} />
      </div>
    </div>
  </div>`;
}

// Small circle-layout drawing of one view. Arrows show direction.
function Preview({ people, ties, label, undirected = false }) {
  const n = people.length, R = 120, C = 160;
  const pos = new Map(people.map((p, i) => {
    const a = (2 * Math.PI * i) / n - Math.PI / 2;
    return [p.id, { x: C + R * Math.cos(a), y: C + R * Math.sin(a), a }];
  }));
  return html`<svg class="ob-preview" viewBox="0 0 320 320" role="img" aria-label=${`${label}: ${undirected ? Object.keys(ties).length / 2 : Object.keys(ties).length} ties among ${n} people`}>
    <defs><marker id="ob-css-arrow" viewBox="0 0 8 8" refX="12" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0,0 L8,4 L0,8 z" fill="var(--edge)" /></marker></defs>
    ${Object.keys(ties).map(k => { const [i, j] = splitKey(k); const a = pos.get(i), b = pos.get(j);
      if (undirected && i > j && ties[`${j}|${i}`]) return null;
      return a && b ? html`<line x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} marker-end=${undirected ? undefined : 'url(#ob-css-arrow)'} />` : null; })}
    ${people.map(p => { const q = pos.get(p.id); const right = Math.cos(q.a) >= 0; return html`<g>
      <circle cx=${q.x} cy=${q.y} r="5" />
      <text x=${q.x + (right ? 9 : -9)} y=${q.y + 3.5} text-anchor=${right ? 'start' : 'end'}>${p.label.length > 14 ? p.label.slice(0, 13) + '…' : p.label}</text></g>`; })}
  </svg>`;
}
