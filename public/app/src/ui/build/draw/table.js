// Table editor: the same drawing as two tables (nodes, ties), for anyone who
// would rather not use the canvas, including screen-reader users. Every edit
// is the same command the canvas uses, so undo/redo and autosave cover both.

import { html, useState, useRef } from '../../../../vendor/preact.js';
import * as D from '../../../builders/draw.js';
import { uid } from '../../../builders/common.js';
import { store } from '../../store.js';

export function TableEditor({ doc, apply, edgeDefaults, say = () => {} }) {
  const tm = doc.twoMode;
  const [newTie, setNewTie] = useState({ source: '', target: '' });
  const root = useRef(null);
  const label = id => D.nodeById(doc, id)?.label ?? id;
  // A removed row takes the focused button with it; move focus to the same
  // place in the next row (or the add button) so the keyboard, and Cmd+Z to
  // undo the removal, keep working.
  const focusAfter = (list, i, sel, fallback) => requestAnimationFrame(() => {
    const els = root.current?.querySelectorAll(sel) || [];
    const el = els[Math.min(i, els.length - 1)] || root.current?.querySelector(fallback);
    // The shell's helper waits for the re-render and owns the fallback.
    if (typeof store.actions.focus === 'function') store.actions.focus(el || fallback);
    else el?.focus();
  });
  const addNode = (mode = 0) => {
    // New rows go below the drawing's lowest node so the canvas stays tidy.
    const b = D.bounds(doc.nodes);
    const id = uid('n');
    apply(d => D.addNode(d, { id, mode, x: b ? b.x + (doc.nodes.length % 6) * 60 : 0, y: b ? b.y + b.h + 80 : 0 }), 'Add person');
    // Straight into the new row's name, like a new person on the canvas.
    requestAnimationFrame(() => { const el = root.current?.querySelector(`[data-name="${id}"]`); el?.focus(); el?.select(); });
  };
  const why = newTie.source && newTie.target ? D.canConnect(doc, newTie.source, newTie.target) : null;
  const addTie = () => {
    if (!newTie.source || !newTie.target || why) { if (why) say(why); return; }
    apply(d => D.addEdge(d, { source: newTie.source, target: newTie.target, type: edgeDefaults.type, directed: edgeDefaults.directed }), 'Add tie');
    setNewTie({ source: newTie.source, target: '' });
  };
  const nodeOptions = html`<option value=""></option>${doc.nodes.map(n => html`<option value=${n.id}>${n.label}${tm ? ` (${D.modeNoun(tm.labels[D.nodeMode(n)]).toLowerCase()})` : ''}</option>`)}`;
  return html`<div class="ob-stack ob-drawtable" ref=${root}>
    <section class="ob-stack" aria-labelledby="ob-tbl-nodes">
      <div class="ob-row"><h3 id="ob-tbl-nodes" class="ob-h">${tm ? `${tm.labels[0]} and ${tm.labels[1].toLowerCase()}` : 'People'}</h3><span class="ob-note">${doc.nodes.length}</span><span class="ob-spacer"></span>
        ${tm ? [0, 1].map(m => html`<button type="button" class=${'btn btn--sm' + (m === 0 ? ' ob-addperson' : '')} onClick=${() => addNode(m)}>Add ${D.modeNoun(tm.labels[m]).toLowerCase()}</button>`)
          : html`<button type="button" class="btn btn--sm ob-addperson" onClick=${() => addNode(0)}>Add person</button>`}</div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">Name</th>${tm ? html`<th scope="col">Mode</th>` : null}<th scope="col">Group</th>${doc.attrColumns.map(c => html`<th scope="col">${c.key}</th>`)}<th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
        <tbody>${doc.nodes.map((n, i) => html`<tr key=${n.id}>
          <td><input class="input" data-name=${n.id} aria-label=${`Name, row ${i + 1}`} value=${n.label} onChange=${e => apply(d => D.updateNode(d, n.id, { label: e.currentTarget.value.trim() || n.label }), 'Rename')} /></td>
          ${tm ? html`<td><select class="select" aria-label=${`Mode of ${n.label}`} value=${String(D.nodeMode(n))} onChange=${e => apply(d => D.setNodeMode(d, [n.id], +e.currentTarget.value), 'Change mode')}>
            ${tm.labels.map((l, m) => html`<option value=${String(m)}>${D.modeNoun(l)}</option>`)}</select></td>` : null}
          <td><select class="select" aria-label=${`Group of ${n.label}`} value=${n.group || ''} onChange=${e => apply(d => D.setGroup(d, [n.id], e.currentTarget.value || null), 'Set group')}>
            <option value="">No group</option>${doc.groups.map(g => html`<option value=${g.id}>${g.name}</option>`)}</select></td>
          ${doc.attrColumns.map(c => html`<td><input class="input" aria-label=${`${c.key} of ${n.label}`} type=${c.type === 'number' || c.type === 'ordinal' ? 'number' : 'text'} step="any"
            value=${n.attrs[c.key] ?? ''} onChange=${e => apply(d => D.setNodeAttr(d, n.id, c.key, e.currentTarget.value), 'Edit attribute')} /></td>`)}
          <td><button type="button" class="btn btn--sm btn--quiet ob-rm-node" aria-label=${`Remove ${n.label}`} onClick=${() => { apply(d => D.removeNodes(d, [n.id]), 'Delete person'); focusAfter(doc.nodes, i, '.ob-rm-node', '.ob-addperson'); }}>Remove</button></td>
        </tr>`)}</tbody>
      </table></div>
      ${doc.nodes.length ? null : html`<p class="ob-empty">Nobody yet. Add a person with the button above.</p>`}
    </section>

    <section class="ob-stack" aria-labelledby="ob-tbl-ties">
      <div class="ob-row"><h3 id="ob-tbl-ties" class="ob-h">Ties</h3><span class="ob-note">${doc.edges.length}</span></div>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">From</th><th scope="col">To</th><th scope="col">Type</th><th scope="col" class="num">Weight</th><th scope="col">${tm ? 'Analyzed' : 'Directed'}</th><th scope="col"><span class="visually-hidden">Remove</span></th></tr></thead>
        <tbody>${doc.edges.map((e, i) => html`<tr key=${e.id}>
          <td>${label(e.source)}</td><td>${label(e.target)}</td>
          <td><select class="select" aria-label=${`Type of tie ${label(e.source)} to ${label(e.target)}`} value=${e.type} onChange=${ev => apply(d => D.updateEdge(d, e.id, { type: ev.currentTarget.value }), 'Tie type')}>
            ${doc.edgeTypes.map(t => html`<option value=${t}>${t}</option>`)}</select></td>
          <td class="num"><input class="input" style="width:5rem" type="number" min="0" step="any" aria-label=${`Weight of tie ${label(e.source)} to ${label(e.target)}`} value=${e.weight}
            onChange=${ev => apply(d => D.updateEdge(d, e.id, { weight: ev.currentTarget.value }), 'Tie weight')} /></td>
          <td>${tm ? html`<span class="ob-note">${D.canConnect(doc, e.source, e.target) ? 'no: same mode' : 'yes'}</span>` : html`<input type="checkbox" aria-label=${`Directed, ${label(e.source)} to ${label(e.target)}`} checked=${e.directed} onChange=${ev => apply(d => D.updateEdge(d, e.id, { directed: ev.currentTarget.checked }), 'Tie direction')} />`}</td>
          <td><button type="button" class="btn btn--sm btn--quiet ob-rm-tie" aria-label=${`Remove tie ${label(e.source)} to ${label(e.target)}`} onClick=${() => { apply(d => D.removeEdges(d, [e.id]), 'Delete tie'); focusAfter(doc.edges, i, '.ob-rm-tie', '#ob-tbl-from'); }}>Remove</button></td>
        </tr>`)}</tbody>
      </table></div>
      <fieldset class="ob-fieldset"><legend>Add a tie</legend>
        <div class="ob-row">
          <select id="ob-tbl-from" class="select" style="width:auto;max-width:12rem" aria-label="From" value=${newTie.source} onChange=${e => setNewTie({ ...newTie, source: e.currentTarget.value })}>${nodeOptions}</select>
          <span class="ob-note">to</span>
          <select class="select" style="width:auto;max-width:12rem" aria-label="To" value=${newTie.target} onChange=${e => setNewTie({ ...newTie, target: e.currentTarget.value })}>${nodeOptions}</select>
          <button type="button" class="btn btn--sm" disabled=${!newTie.source || !newTie.target || !!why} onClick=${addTie}>Add tie</button>
        </div>
        ${why && newTie.source !== newTie.target ? html`<p class="ob-note ob-warn" role="status">${why}</p>` : null}
        <p class="ob-note">New ties use the type "${edgeDefaults.type}"${edgeDefaults.directed ? ' and are directed' : ''}; change either in the panel with nothing selected, or per row above.</p>
      </fieldset>
    </section>
  </div>`;
}
