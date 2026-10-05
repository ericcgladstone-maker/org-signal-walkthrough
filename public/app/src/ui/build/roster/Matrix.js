// Who-to-whom grid used by the roster and perceived-network builders.
//
// Rows are senders (the person answering, or "from"), columns receivers.
// One cell is in the tab order at a time (roving tabindex): arrow keys move,
// Home/End jump within a row, PageUp/PageDown move 10 rows, Space or Enter
// toggles a binary tie, digits 0..max set a valued tie, Delete/Backspace clear.
// Headers stay put while the grid scrolls inside its own wrapper, so a 50+
// person roster never makes the page itself scroll sideways.
//
// Tie fields (fields + attrs): the grid itself stays one character per cell,
// so it stays fast at 100 people; the fields of the focused cell are edited
// in one details panel under the grid. F2 or Shift+Enter on a cell moves
// focus into the panel; Escape in the panel returns to the cell. Cells whose
// tie has details carry a corner mark.

import { html, useState, useRef, useEffect, useMemo } from '../../../../vendor/preact.js';
import { pairKey } from '../../../builders/matrix.js';
import { PersonSelect } from '../pick.js';
import { TieFieldInputs } from '../tiefields.js';
import { describeTieValues } from '../../../builders/tiefields.js';

export function Matrix({ people, values, onSet, scale = 'binary', max = 5, caption = 'Ties', rowHeading = 'From', colHeading = 'To',
  fields = [], attrs = {}, onSetAttrs = null, onToggle = null, mutual = false }) {
  const [focus, setFocus] = useState({ r: 0, c: people.length > 1 ? 1 : 0 });
  const [hl, setHl] = useState(null);
  const tableRef = useRef(null);
  const n = people.length;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  useEffect(() => { if (focus.r >= n || focus.c >= n) setFocus({ r: 0, c: n > 1 ? 1 : 0 }); }, [n]);

  const moveTo = (r, c) => {
    r = clamp(r, 0, n - 1); c = clamp(c, 0, n - 1);
    setFocus({ r, c }); setHl({ r, c });
    const td = tableRef.current?.querySelector(`td[data-r="${r}"][data-c="${c}"]`);
    if (td) { td.focus({ preventScroll: false }); td.scrollIntoView?.({ block: 'nearest', inline: 'nearest' }); }
  };

  const valueAt = (r, c) => values[pairKey(people[r].id, people[c].id)] || 0;
  const set = (r, c, v) => { if (r !== c) onSet(people[r].id, people[c].id, v); };
  // onToggle: the caller decides what a click means (perceived networks keep
  // a mutual tie when its mirror cell is clicked).
  const toggle = (r, c) => {
    if (onToggle && scale === 'binary') { if (r !== c) onToggle(people[r].id, people[c].id); return; }
    const cur = valueAt(r, c);
    if (scale === 'binary') set(r, c, cur ? 0 : 1);
    else set(r, c, cur >= max ? 0 : cur + 1); // click cycles 0..max
  };

  const panelRef = useRef(null);
  const withFields = fields.length > 0 && onSetAttrs;
  const openDetails = () => { const el = panelRef.current?.querySelector('input,select,button'); el?.focus(); };
  const onKey = e => {
    const td = e.target.closest('td[data-r]');
    if (!td) return;
    const r = Number(td.dataset.r), c = Number(td.dataset.c);
    const k = e.key;
    if (withFields && r !== c && (k === 'F2' || (k === 'Enter' && e.shiftKey))) { e.preventDefault(); openDetails(); return; }
    if (k === 'ArrowRight') moveTo(r, c + 1);
    else if (k === 'ArrowLeft') moveTo(r, c - 1);
    else if (k === 'ArrowDown') moveTo(r + 1, c);
    else if (k === 'ArrowUp') moveTo(r - 1, c);
    else if (k === 'Home') moveTo(e.ctrlKey ? 0 : r, 0);
    else if (k === 'End') moveTo(e.ctrlKey ? n - 1 : r, n - 1);
    else if (k === 'PageDown') moveTo(r + 10, c);
    else if (k === 'PageUp') moveTo(r - 10, c);
    else if (k === ' ' || k === 'Enter') toggle(r, c);
    else if (k === 'Delete' || k === 'Backspace') set(r, c, 0);
    else if (/^[0-9]$/.test(k)) {
      const v = Number(k);
      if (scale === 'binary') set(r, c, v ? 1 : 0); else if (v <= max) set(r, c, v);
    } else return;
    e.preventDefault();
  };

  const help = (scale === 'binary'
    ? 'Arrow keys move. Space or Enter toggles a tie. 1 sets, 0 clears.'
    : `Arrow keys move. Type 0 to ${max} to set a value; Space steps it up.`) + (withFields ? ' F2 or Shift+Enter edits the tie\u2019s details below the grid.' : '');
  // mutual: both cells of a pair hold the tie; count each pair once.
  const counts = useMemo(() => {
    if (!mutual) return Object.keys(values).length;
    const seen = new Set();
    for (const k of Object.keys(values)) { if (!values[k]) continue; const i = k.indexOf('|'); const a = k.slice(0, i), b = k.slice(i + 1); seen.add(a < b ? a + '|' + b : b + '|' + a); }
    return seen.size;
  }, [values, mutual]);

  if (!n) return html`<p class="ob-empty">Add people to the roster first.</p>`;
  return html`<div class="ob-stack" style="gap:.4rem">
    <p class="ob-note" id="ob-matrix-help"><span class="ob-kbdonly">${help} </span><span class="ob-touchonly">${scale === 'binary' ? 'Tap a cell to tick it; tap again to clear it.' : `Tap a cell to step its value up to ${max}, then back to empty.`} </span>Rows are ${rowHeading.toLowerCase()}, columns are ${colHeading.toLowerCase()}. ${counts} ${counts === 1 ? 'tie' : 'ties'} entered${mutual ? ' (each pair of people counted once)' : ''}.</p>
    <div class="ob-matrixwrap">
      <table class="ob-matrix" role="grid" aria-label=${caption} aria-describedby="ob-matrix-help" ref=${tableRef}
        onKeyDown=${onKey} onFocusOut=${e => { if (!tableRef.current?.contains(e.relatedTarget)) setHl(null); }}>
        <thead><tr>
          <th scope="col" class="corner"><div class="meta">${rowHeading} ↓<br />${colHeading} →</div></th>
          ${people.map((p, c) => html`<th scope="col" class=${hl && hl.c === c ? 'hl' : ''} title=${p.label}><span>${p.label}</span></th>`)}
        </tr></thead>
        <tbody>
          ${people.map((p, r) => html`<tr class=${hl && hl.r === r ? 'hl' : ''}>
            <th scope="row" title=${p.label}>${p.label}</th>
            ${people.map((q, c) => {
              if (r === c) return html`<td class="self" aria-disabled="true" data-r=${r} data-c=${c} tabindex=${focus.r === r && focus.c === c ? 0 : -1}
                aria-label=${`${p.label} (self)`}></td>`;
              const v = values[pairKey(p.id, q.id)] || 0;
              const det = withFields && v && attrs[pairKey(p.id, q.id)];
              const cls = (v ? (scale === 'binary' ? 'on' : `v${Math.min(5, Math.max(1, Math.round((v / max) * 5)))}`) : '') + (det ? ' has-f' : '');
              return html`<td role="gridcell" class=${cls} data-r=${r} data-c=${c}
                tabindex=${focus.r === r && focus.c === c ? 0 : -1}
                aria-label=${`${p.label} to ${q.label}: ${v ? (scale === 'binary' ? 'tie' : v) : 'no tie'}${det ? `, ${describeTieValues(fields, det)}` : ''}`}
                onClick=${() => { setFocus({ r, c }); setHl({ r, c }); toggle(r, c); }}
                onFocus=${() => { setHl({ r, c }); }}>${v ? (scale === 'binary' ? '●' : v) : ''}</td>`;
            })}
          </tr>`)}
        </tbody>
      </table>
    </div>
    ${withFields ? html`<${TieDetails} ref_=${panelRef} people=${people} focus=${focus} values=${values} attrs=${attrs} fields=${fields}
      onSetAttrs=${onSetAttrs} back=${() => moveTo(focus.r, focus.c)} />` : null}
  </div>`;
}

// The details of the focused cell's tie. Entering a detail on a pair with no
// tie records the tie (the builder does that: setTieAttrs).
function TieDetails({ ref_, people, focus, values, attrs, fields, onSetAttrs, back }) {
  const a = people[focus.r], b = people[focus.c];
  if (!a || !b) return null;
  const k = pairKey(a.id, b.id);
  const cur = attrs[k] || {};
  const self = a.id === b.id;
  return html`<section class="ob-details" ref=${ref_} aria-label="Tie details" onKeyDown=${e => { if (e.key === 'Escape') { e.preventDefault(); back(); } }}>
    <div class="ob-row"><h4 class="ob-details__h">Tie details: ${a.label} to ${b.label}</h4>
      <span class="ob-spacer"></span><button type="button" class="tlink tlink--quiet" onClick=${back}>Back to the grid</button></div>
    ${self ? html`<p class="ob-note">Choose a cell off the diagonal.</p>` : html`
      <p class="ob-note">${values[k] ? 'Every detail is optional.' : 'No tie yet. Entering a detail records the tie.'}</p>
      <${TieFieldInputs} fields=${fields} values=${cur} idPrefix=${`ob-td`} onChange=${(key, v) => onSetAttrs(a.id, b.id, { ...cur, [key]: v })} />`}
  </section>`;
}

// Pair-at-a-time entry: the same ties as a form and a list. Better on a phone
// and with a screen reader than a large grid.
export function PairEntry({ people, values, onSet, scale = 'binary', max = 5, fields = [], attrs = {} }) {
  const [from, setFrom] = useState(people[0]?.id || '');
  const [to, setTo] = useState(people[1]?.id || '');
  const [val, setVal] = useState(scale === 'binary' ? 1 : max);
  const label = new Map(people.map(p => [p.id, p.label]));
  const list = Object.entries(values).map(([k, v]) => { const i = k.indexOf('|'); return { from: k.slice(0, i), to: k.slice(i + 1), v }; })
    .filter(t => label.has(t.from) && label.has(t.to))
    .sort((a, b) => label.get(a.from).localeCompare(label.get(b.from)) || label.get(a.to).localeCompare(label.get(b.to)));
  const add = e => { e.preventDefault(); if (from && to && from !== to) onSet(from, to, scale === 'binary' ? 1 : Number(val)); };
  return html`<div class="ob-stack">
    <form class="ob-row" onSubmit=${add} aria-label="Add a tie">
      <div class="field"><${PersonSelect} id="ob-pe-from" label="From" people=${people} value=${from} onChange=${setFrom} /></div>
      <div class="field"><${PersonSelect} id="ob-pe-to" label="To" people=${people} value=${to} onChange=${setTo} exclude=${from} /></div>
      ${scale === 'valued' ? html`<div class="field" style="width:5rem"><label class="field__label" for="ob-pe-val">Value</label>
        <input id="ob-pe-val" class="input" type="number" min="1" max=${max} value=${val} onInput=${e => setVal(e.currentTarget.value)} /></div>` : null}
      <button class="btn" type="submit" style="align-self:flex-end" disabled=${!from || from === to}>Add tie</button>
    </form>
    ${list.length ? html`<div class="table-wrap"><table class="tbl">
      <thead><tr><th>From</th><th>To</th>${scale === 'valued' ? html`<th class="num">Value</th>` : null}${fields.length ? html`<th>Details</th>` : null}<th><span class="visually-hidden">Remove</span></th></tr></thead>
      <tbody>${list.map(t => html`<tr><td>${label.get(t.from)}</td><td>${label.get(t.to)}</td>
        ${scale === 'valued' ? html`<td class="num">${t.v}</td>` : null}
        ${fields.length ? html`<td class="ob-note">${describeTieValues(fields, attrs[pairKey(t.from, t.to)]) || '—'}</td>` : null}
        <td><button type="button" class="btn btn--sm btn--quiet" onClick=${() => onSet(t.from, t.to, 0)} aria-label=${`Remove ${label.get(t.from)} to ${label.get(t.to)}`}>Remove</button></td></tr>`)}
      </tbody></table></div>` : html`<p class="ob-note">No ties yet.</p>`}
  </div>`;
}
