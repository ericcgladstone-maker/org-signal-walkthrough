// Ego builder steps 3 and 4: collect names per question, then describe each
// person (and ego's tie to them) in a fast-entry table. ctx carries the
// respondent-mode extras: { roster: [{ id, label }], selfId, allowOthers }.

import { html, useState, useRef } from '../../../../vendor/preact.js';
import * as E from '../../../builders/ego.js';
import { normName } from '../../../builders/common.js';
import { likelyDuplicates, duplicateReason, REASON_TEXT } from '../../../builders/names.js';
import { Combobox } from '../pick.js';
import { TieFieldInputs } from '../tiefields.js';

// One name-generator question. Names carry over: people already named under
// another question are one click away (toggles), typing suggests them, and a
// name that looks like someone already named ("Jon" for "Jonathan Reyes",
// "J. Reyes", a typo) asks "Same person?" before a second person is made.
// Against a roster (ctx.roster), names are picked from the roster with
// type-ahead; free typing is only behind "Someone not on the list".
function GeneratorBox({ s, g, update, ctx = {} }) {
  const roster = ctx.roster || null;
  const [msg, setMsg] = useState(null);
  const [pending, setPending] = useState([]); // names waiting for "same person?"
  const [hint, setHint] = useState([]);
  const [offList, setOffList] = useState(false);
  const named = s.alters.filter(a => a.generators.includes(g.id));
  const full = named.length >= g.cap;
  const genName = id => s.generators.find(q => q.id === id)?.name;
  // Carry-over: everyone named under another question.
  const carry = s.alters.filter(a => !(a.generators.length === 1 && a.generators[0] === g.id));
  const note = (r, label) => {
    if (r.status === 'duplicate-same') return { level: 'warn', text: `${r.alter.label} is already on this list.` };
    if (r.status === 'cap') return { level: 'warn', text: `This question takes at most ${g.cap} names. ${label} was not added.` };
    if (r.status === 'duplicate-other') {
      const others = r.alter.generators.filter(x => x !== g.id).map(genName).filter(Boolean);
      return { level: 'info', text: `${r.alter.label} was already named under ${others.join(', ')}; added to this question too.` };
    }
    return null;
  };
  const addOne = (cur, label, opts = {}) => {
    const r = E.addAlter(cur, label, g.id, opts);
    return { session: r.session, note: note(r, label || r.alter?.label) };
  };
  // Each action computes the next session from the one on screen, then hands
  // it over; notes and pending questions are set beside it, not inside it.
  const commit = next => update(() => next);
  // Free text: every name without a likely duplicate is added; the others wait.
  const addTyped = text => {
    const names = text.split(/[\n;,]+/).map(x => x.trim()).filter(Boolean);
    if (!names.length) return;
    const notes = [], wait = [];
    let next = s;
    for (const n of names) {
      const exact = next.alters.find(a => normName(a.label) === normName(n));
      const pool = [...next.alters.map(a => ({ id: a.id, label: a.label, kind: 'alter' })),
        ...(roster || []).filter(p => p.id !== ctx.selfId && !next.alters.some(a => a.personId === p.id)).map(p => ({ id: p.id, label: p.label, kind: 'roster' }))];
      const dups = exact ? [] : likelyDuplicates(n, pool);
      if (dups.length) { wait.push({ name: n, matches: dups }); continue; }
      const r = addOne(next, n);
      next = r.session; if (r.note) notes.push(r.note);
    }
    commit(next);
    setPending(p => [...p, ...wait]);
    setMsg(notes.length ? notes : null);
    setHint([]);
  };
  const resolve = (item, choice) => {
    const r = choice === 'new' ? addOne(s, item.name)
      : choice.kind === 'roster' ? addOne(s, choice.label, { personId: choice.id }) : addOne(s, null, { alterId: choice.id });
    commit(r.session);
    setMsg(r.note ? [r.note] : null);
    setPending(p => p.filter(x => x !== item));
  };
  const toggleCarry = (a, on) => commit(on ? addOne(s, null, { alterId: a.id }).session : E.removeAlter(s, a.id, g.id));
  const items = roster
    ? roster.filter(p => p.id !== ctx.selfId && !named.some(a => a.personId === p.id)).map(p => {
      const a = s.alters.find(x => x.personId === p.id);
      return { id: p.id, label: p.label, hint: a ? `named under ${a.generators.map(genName).join(', ')}` : '' };
    })
    : carry.filter(a => !a.generators.includes(g.id)).map(a => ({ id: a.id, label: a.label, hint: `named under ${a.generators.map(genName).join(', ')}` }));
  const onPick = x => {
    const r = roster ? addOne(s, x.label, { personId: x.id }) : addOne(s, null, { alterId: x.id });
    commit(r.session);
    setMsg(r.note ? [r.note] : null);
  };
  const live = text => {
    const t = text.trim();
    if (!t || roster && !offList) { setHint([]); return; }
    setHint(likelyDuplicates(t, s.alters.map(a => ({ id: a.id, label: a.label }))).filter(d => d.reason !== 'same').slice(0, 3));
  };
  const freeOK = !roster || offList;
  return html`<section class="ego-gen" aria-labelledby=${'gq-' + g.id}>
    <div class="ego-item-head">
      <h3 id=${'gq-' + g.id}>${g.name}</h3>
      <span class="meta">${named.length} of ${g.cap}</span>
    </div>
    ${g.prompt ? html`<p class="ego-prompt-text">${g.prompt}</p>` : null}
    ${carry.length ? html`<fieldset class="ego-carry">
      <legend class="field__label">Also name someone you already mentioned</legend>
      <div class="ego-chips">${carry.map(a => {
        const on = a.generators.includes(g.id);
        return html`<button type="button" class="ego-chip" aria-pressed=${String(on)} disabled=${!on && full}
          onClick=${() => toggleCarry(a, !on)}>${a.label}</button>`;
      })}</div>
    </fieldset>` : null}
    <div class="ob-row ego-addname">
      ${roster && !offList
        ? html`<${Combobox} id=${'an-' + g.id} label=${`Find a person for ${g.name}`} hideLabel=${true} items=${items} onPick=${onPick}
            placeholder=${full ? 'This question is full' : 'Type to find a name on the list'} disabled=${full} />`
        : html`<${Combobox} id=${'an-' + g.id} label=${`Add a name for ${g.name}`} hideLabel=${true} items=${roster ? [] : items} onPick=${onPick}
            onText=${addTyped} freeText=${'Add “%s”'} onInput=${live} describedBy=${'dh-' + g.id}
            placeholder=${full ? 'This question is full' : roster ? 'Name of someone not on the list' : 'Type a name and press Enter'} disabled=${full} />`}
      ${roster && ctx.allowOthers !== false ? html`<button type="button" class="tlink tlink--quiet" aria-pressed=${String(offList)} onClick=${() => { setOffList(!offList); setHint([]); }}>
        ${offList ? 'Pick from the list' : 'Someone not on the list'}</button>` : null}
    </div>
    ${full && !ctx.respondent ? html`<p class="ob-note ob-warn" role="status">This question is full: it takes at most ${g.cap} names.
      <button type="button" class="tlink" onClick=${() => update(x => E.updateGenerator(x, g.id, { cap: g.cap + 5 }))}>Allow up to ${g.cap + 5}</button></p>` : full ? html`<p class="ob-note" role="status">That is the most names this question takes (${g.cap}).</p>` : null}
    <div id=${'dh-' + g.id} aria-live="polite">
      ${freeOK && hint.length ? html`<p class="ob-note ob-warn">Possibly someone already named: ${hint.map(h => `${h.label} (${REASON_TEXT[h.reason]})`).join(', ')}.</p>` : null}
      ${msg ? msg.map(m => html`<p class=${'ob-note ' + (m.level === 'warn' ? 'ob-warn' : '')}>${m.text}</p>`) : null}
    </div>
    ${pending.map(item => html`<div class="ego-dup" role="group" aria-label=${`Is ${item.name} someone already named?`}>
      <p class="ob-note"><strong>${item.name}</strong> may be someone already ${item.matches.some(m => m.kind === 'roster') ? 'on the list' : 'named'}:</p>
      <div class="ob-row" style="gap:.4rem 1.1rem">
        ${item.matches.slice(0, 4).map(m => html`<button type="button" class="tlink" onClick=${() => resolve(item, m)}>Same person: ${m.label}</button>`)}
        <button type="button" class="tlink tlink--quiet" onClick=${() => resolve(item, 'new')}>No, add ${item.name} as someone new</button>
      </div>
    </div>`)}
    ${named.length ? html`<ul class="ego-names">
      ${named.map(a => html`<li key=${a.id}>
        <span>${a.label}</span>
        ${a.generators.length > 1 ? html`<span class="ob-note">also ${a.generators.filter(x => x !== g.id).map(genName).join(', ')}</span>` : null}
        <button type="button" class="btn btn--sm btn--quiet" aria-label=${`Remove ${a.label} from ${g.name}`} onClick=${() => update(x => E.removeAlter(x, a.id, g.id))}>Remove</button>
      </li>`)}
    </ul>` : null}
  </section>`;
}

// Pairs among everyone named that look like one person, with a merge.
// Roster people are distinct by definition, so two picks from the roster are
// never flagged; "Different people" is remembered (s.distinct).
function possibleDuplicates(s) {
  const out = [];
  const distinct = new Set(s.distinct || []);
  const A = s.alters;
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    if (A[i].personId && A[j].personId) continue;
    if (distinct.has(E.pairKey(A[i].id, A[j].id))) continue;
    const r = duplicateReason(A[i].label, A[j].label);
    if (r && r !== 'first-name') out.push({ a: A[i], b: A[j], reason: r });
  }
  return out;
}

export function NamesStep({ s, update, ctx = {} }) {
  if (!s.generators.length) return html`<p class="ob-empty">Choose at least one name generator first.</p>`;
  const dups = possibleDuplicates(s);
  const keepOf = d => (d.a.personId || (!d.b.personId && d.a.label.length >= d.b.label.length) ? [d.a, d.b] : [d.b, d.a]);
  return html`<div class="ob-stack">
    ${s.generators.map(g => html`<${GeneratorBox} key=${g.id} s=${s} g=${g} update=${update} ctx=${ctx} />`)}
    ${dups.length ? html`<div class="ob-section ego-dups" role="group" aria-label="Possible duplicates">
      <h3>Possibly the same person</h3>
      ${dups.map(d => { const [keep, drop] = keepOf(d); return html`<div class="ob-row ego-dup" key=${d.a.id + d.b.id}>
        <span>${d.a.label} and ${d.b.label} <span class="ob-note">(${REASON_TEXT[d.reason]})</span></span>
        <button type="button" class="tlink" onClick=${() => update(x => E.mergeAlters(x, keep.id, drop.id))}>Same person: keep ${keep.label}</button>
        <button type="button" class="tlink tlink--quiet" onClick=${() => update(x => ({ ...x, distinct: [...(x.distinct || []), E.pairKey(d.a.id, d.b.id)] }))}>Different people</button>
      </div>`; })}
    </div>` : null}
    ${s.alters.length ? html`<div class="ob-section">
      <h3>Everyone named <span class="meta">${s.alters.length}</span></h3>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">Name</th>${s.generators.map(g => html`<th scope="col">${g.name}</th>`)}</tr></thead>
        <tbody>${s.alters.map(a => html`<tr key=${a.id}>
          <th scope="row">${a.personId ? a.label : html`<label class="visually-hidden" for=${'rn-' + a.id}>Name</label>
            <input id=${'rn-' + a.id} class="input" value=${a.label} onChange=${e => update(x => E.renameAlter(x, a.id, e.target.value))} />`}</th>
          ${s.generators.map(g => html`<td>${a.generators.includes(g.id) ? 'named' : ''}</td>`)}
        </tr>`)}</tbody>
      </table></div>
    </div>` : null}
  </div>`;
}

function Cell({ it, a, update, r, c }) {
  const id = `cell-${r}-${c}`;
  const v = a.attrs[it.name] ?? '';
  const set = val => update(x => E.setInterpreter(x, a.id, it.name, val));
  const label = `${it.label} for ${a.label}`;
  if (it.type === 'categorical' || it.type === 'ordinal' || it.type === 'boolean') {
    const options = it.type === 'boolean' ? [{ value: 'true', label: 'Yes' }, { value: 'false', label: 'No' }] : it.options || [];
    return html`<select id=${id} class="select" aria-label=${label} data-r=${r} data-c=${c} value=${String(v)} onChange=${e => set(e.target.value)}>
      <option value="">-</option>
      ${options.map(o => html`<option value=${o.value}>${o.label}</option>`)}
    </select>`;
  }
  return html`<input id=${id} class="input" aria-label=${label} data-r=${r} data-c=${c}
    type=${it.type === 'number' ? 'number' : it.type === 'date' ? 'date' : 'text'} value=${v} onChange=${e => set(e.target.value)} />`;
}

export function DescribeStep({ s, update }) {
  const ref = useRef(null);
  if (!s.alters.length) return html`<p class="ob-empty">Collect some names first.</p>`;
  const tf = s.tieFields || [];
  if (!s.interpreters.length && !tf.length) return html`<p class="ob-empty">No questions about alters were chosen. Go back to About each person to add some, or continue.</p>`;
  // Enter moves down a column (the usual way to key a survey form fast);
  // Shift+Enter moves up. Tab moves across as normal.
  const onKey = e => {
    if (e.key !== 'Enter') return;
    const t = e.target;
    if (!t.dataset?.r) return;
    e.preventDefault();
    t.dispatchEvent(new Event('change', { bubbles: true }));
    const r = Number(t.dataset.r) + (e.shiftKey ? -1 : 1);
    ref.current?.querySelector(`[data-r="${r}"][data-c="${t.dataset.c}"]`)?.focus();
  };
  const p = E.progress(s);
  return html`<div class="ob-stack">
    <p class="ob-note">${p.answered} of ${p.cells} answers filled.<span class="ob-kbdonly"> Enter moves down a column, Tab moves across.</span></p>
    <div class="table-wrap" ref=${ref} onKeyDown=${onKey}><table class="tbl ego-describe">
      <thead><tr><th scope="col">Name</th>${s.interpreters.map(it => html`<th scope="col">${it.label}</th>`)}${tf.map(f => html`<th scope="col">${f.label} <span class="ob-note">(your tie)</span></th>`)}</tr></thead>
      <tbody>${s.alters.map((a, r) => html`<tr key=${a.id}>
        <th scope="row">${a.label}</th>
        ${s.interpreters.map((it, c) => html`<td data-label=${it.label}><${Cell} it=${it} a=${a} update=${update} r=${r} c=${c} /></td>`)}
        ${tf.map(f => html`<td class="ego-tfcell" data-label=${`${f.label} (your tie)`}><${TieFieldInputs} fields=${[f]} values=${a.tie || {}} idPrefix=${`tf-${a.id}`} compact=${true}
          labelFor=${x => `${x.label} for ${a.label}`} onChange=${(k, v) => update(x => E.setTieValue(x, a.id, k, v))} /></td>`)}
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}
