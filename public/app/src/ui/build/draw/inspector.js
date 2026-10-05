// Side panel of the draw editor. What it shows depends on the selection:
// nothing (drawing settings: name, groups, attribute columns, tie types),
// one node, several nodes (group, align, distribute), or one tie.
// Every edit goes through apply(fn, label) so it is one undo step.

import { html, useState } from '../../../../vendor/preact.js';
import * as D from '../../../builders/draw.js';
import { ATTR_TYPES } from '../../../builders/common.js';
import { groupColor } from '../shared.js';

export function Inspector({ doc, sel, apply, setSel, edgeDefaults, setEdgeDefaults, onRename, onTwoMode }) {
  if (sel.edges.length === 1 && !sel.nodes.length) {
    const e = D.edgeById(doc, sel.edges[0]);
    if (e) return html`<${EdgePanel} doc=${doc} e=${e} apply=${apply} setSel=${setSel} />`;
  }
  if (sel.nodes.length === 1) {
    const n = D.nodeById(doc, sel.nodes[0]);
    if (n) return html`<${NodePanel} doc=${doc} n=${n} apply=${apply} setSel=${setSel} onRename=${onRename} />`;
  }
  if (sel.nodes.length > 1 || sel.edges.length > 1) return html`<${MultiPanel} doc=${doc} sel=${sel} apply=${apply} setSel=${setSel} />`;
  return html`<${DocPanel} doc=${doc} apply=${apply} edgeDefaults=${edgeDefaults} setEdgeDefaults=${setEdgeDefaults} onTwoMode=${onTwoMode} />`;
}

// Two-mode drawings: which mode a node (or a selection) is, in words.
function ModeSelect({ doc, value, onChange, id, mixed }) {
  return html`<select class="select" id=${id} value=${mixed ? '__mixed' : String(value)} onChange=${e => e.currentTarget.value !== '__mixed' && onChange(+e.currentTarget.value)}>
    ${mixed ? html`<option value="__mixed">Mixed</option>` : null}
    ${doc.twoMode.labels.map((l, m) => html`<option value=${String(m)}>${D.modeNoun(l)} (${m === 0 ? 'circle' : 'square'})</option>`)}
  </select>`;
}

function GroupSelect({ doc, value, onChange, id, mixed }) {
  return html`<select class="select" id=${id} value=${mixed ? '__mixed' : value || ''} onChange=${e => e.currentTarget.value !== '__mixed' && onChange(e.currentTarget.value || null)}>
    ${mixed ? html`<option value="__mixed">Mixed</option>` : null}
    <option value="">No group</option>
    ${doc.groups.map(g => html`<option value=${g.id}>${g.name}</option>`)}
  </select>`;
}

function AttrInput({ col, value, onChange, id }) {
  const v = value ?? '';
  if (col.type === 'boolean') {
    return html`<select class="select" id=${id} value=${v === true || /^(true|yes|1)$/i.test(String(v)) ? 'true' : v === '' ? '' : 'false'}
      onChange=${e => onChange(e.currentTarget.value)}>
      <option value=""></option><option value="true">Yes</option><option value="false">No</option></select>`;
  }
  const type = col.type === 'number' || col.type === 'ordinal' ? 'number' : col.type === 'date' ? 'date' : 'text';
  return html`<input class="input" id=${id} type=${type} value=${v} step=${type === 'number' ? 'any' : undefined}
    onChange=${e => onChange(e.currentTarget.value)} />`;
}

function NodePanel({ doc, n, apply, setSel, onRename }) {
  const ties = doc.edges.filter(e => e.source === n.id || e.target === n.id);
  const other = e => D.nodeById(doc, e.source === n.id ? e.target : e.source)?.label;
  const tm = doc.twoMode;
  return html`<div class="ob-stack">
    <h3 class="label">${tm ? D.modeNoun(tm.labels[D.nodeMode(n)]) : 'Person'}</h3>
    <div class="field"><label class="field__label" for="ob-n-label">Name</label>
      <input class="input" id="ob-n-label" value=${n.label} onChange=${e => apply(d => D.updateNode(d, n.id, { label: e.currentTarget.value.trim() || n.label }), 'Rename')} /></div>
    ${tm ? html`<div class="field"><label class="field__label" for="ob-n-mode">Mode</label>
      <${ModeSelect} id="ob-n-mode" doc=${doc} value=${D.nodeMode(n)} onChange=${m => apply(d => D.setNodeMode(d, [n.id], m), 'Change mode')} />
      <p class="ob-help">Ties join ${tm.labels[0].toLowerCase()} with ${tm.labels[1].toLowerCase()} only; changing the mode leaves existing ties in place, and any that then join two of the same mode are left out of the analysis.</p></div>` : null}
    <div class="field"><label class="field__label" for="ob-n-group">Group</label>
      <${GroupSelect} id="ob-n-group" doc=${doc} value=${n.group} onChange=${g => apply(d => D.setGroup(d, [n.id], g), 'Set group')} /></div>
    ${doc.attrColumns.map(c => html`<div class="field" key=${c.key}><label class="field__label" for=${'ob-n-a-' + c.key}>${c.key} <span class="ob-help">(${c.type})</span></label>
      <${AttrInput} id=${'ob-n-a-' + c.key} col=${c} value=${n.attrs[c.key]} onChange=${v => apply(d => D.setNodeAttr(d, n.id, c.key, v), 'Edit attribute')} /></div>`)}
    ${doc.attrColumns.length ? null : html`<p class="ob-note">Add attribute columns (role, tenure...) with nobody selected.</p>`}
    <div class="ob-stack" style="gap:.3rem">
      <h3 class="label">Ties (${ties.length})</h3>
      ${ties.length ? html`<ul class="ob-inline" style="flex-direction:column;gap:.15rem">
        ${ties.map(e => html`<li key=${e.id}><button type="button" class="tlink" onClick=${() => setSel({ nodes: [], edges: [e.id] })}>
          ${e.directed ? (e.source === n.id ? 'to ' : 'from ') : 'with '}${other(e)}</button> <span class="ob-note">(${e.type}${e.weight !== 1 ? ', weight ' + e.weight : ''})</span></li>`)}
      </ul>` : html`<p class="ob-note">No ties yet.</p>`}
    </div>
    <div class="ob-row">
      <button type="button" class="tlink" onClick=${() => onRename(n.id)}>Rename on canvas</button>
      <button type="button" class="tlink ob-danger" onClick=${() => { apply(d => D.removeNodes(d, [n.id]), 'Delete person'); setSel({ nodes: [], edges: [] }); }}>Delete ${n.label}</button>
    </div>
  </div>`;
}

const ALIGN = [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']];

function MultiPanel({ doc, sel, apply, setSel }) {
  const nodes = sel.nodes.map(id => D.nodeById(doc, id)).filter(Boolean);
  const groups = new Set(nodes.map(n => n.group || ''));
  const [newGroup, setNewGroup] = useState('');
  const makeGroup = () => {
    const id = 'g' + Math.random().toString(36).slice(2, 8);
    apply(d => D.setGroup(D.addGroup(d, { id, name: newGroup }), sel.nodes, id), 'Group people');
    setNewGroup('');
  };
  return html`<div class="ob-stack">
    <h3 class="label">${nodes.length} ${doc.twoMode ? 'nodes' : 'people'}${sel.edges.length ? `, ${sel.edges.length} ties` : ''} selected</h3>
    ${nodes.length && doc.twoMode ? html`<div class="field"><label class="field__label" for="ob-m-mode">Mode</label>
      <${ModeSelect} id="ob-m-mode" doc=${doc} value=${D.nodeMode(nodes[0])} mixed=${new Set(nodes.map(D.nodeMode)).size > 1} onChange=${m => apply(d => D.setNodeMode(d, sel.nodes, m), 'Change mode')} /></div>` : null}
    ${nodes.length ? html`
    <div class="field"><label class="field__label" for="ob-m-group">Group</label>
      <${GroupSelect} id="ob-m-group" doc=${doc} value=${[...groups][0]} mixed=${groups.size > 1} onChange=${g => apply(d => D.setGroup(d, sel.nodes, g), 'Set group')} /></div>
    <div class="ob-row" style="flex-wrap:nowrap">
      <input class="input" aria-label="Name of a new group for the selection" placeholder="New group name" value=${newGroup} onInput=${e => setNewGroup(e.currentTarget.value)}
        onKeyDown=${e => e.key === 'Enter' && makeGroup()} />
      <button type="button" class="btn btn--sm" onClick=${makeGroup}>Make group</button>
    </div>
    <div class="ob-stack" style="gap:.35rem" role="group" aria-label="Align">
      <span class="field__label">Align</span>
      <div class="ob-row" style="gap:.3rem">${ALIGN.map(([k, l]) => html`<button type="button" class="btn btn--sm" disabled=${nodes.length < 2}
        onClick=${() => apply(d => D.align(d, sel.nodes, k), 'Align ' + l.toLowerCase())}>${l}</button>`)}</div>
      <span class="field__label">Distribute</span>
      <div class="ob-row" style="gap:.3rem">
        <button type="button" class="btn btn--sm" disabled=${nodes.length < 3} onClick=${() => apply(d => D.distribute(d, sel.nodes, 'h'), 'Distribute')}>Horizontally</button>
        <button type="button" class="btn btn--sm" disabled=${nodes.length < 3} onClick=${() => apply(d => D.distribute(d, sel.nodes, 'v'), 'Distribute')}>Vertically</button>
      </div>
    </div>
    <div class="ob-row">
      <button type="button" class="btn btn--sm" disabled=${nodes.length < 2} onClick=${() => apply(d => D.connectPath(d, sel.nodes), 'Connect')}>Connect in order</button>
    </div>` : null}
    <div class="ob-row">
      <button type="button" class="tlink ob-danger" onClick=${() => { apply(d => D.removeEdges(D.removeNodes(d, sel.nodes), sel.edges), 'Delete'); setSel({ nodes: [], edges: [] }); }}>Delete selection</button>
    </div>
  </div>`;
}

function TypeSelect({ doc, value, onChange, id }) {
  const [adding, setAdding] = useState(false);
  if (adding) {
    return html`<input class="input" id=${id} placeholder="New tie type, then Enter" autofocus
      onKeyDown=${e => { if (e.key === 'Enter') { const v = e.currentTarget.value.trim(); if (v) onChange(v); setAdding(false); } else if (e.key === 'Escape') { e.stopPropagation(); setAdding(false); } }}
      onBlur=${e => { const v = e.currentTarget.value.trim(); if (v) onChange(v); setAdding(false); }} />`;
  }
  return html`<select class="select" id=${id} value=${value} onChange=${e => (e.currentTarget.value === '__new' ? setAdding(true) : onChange(e.currentTarget.value))}>
    ${doc.edgeTypes.map(t => html`<option value=${t}>${t}</option>`)}
    <option value="__new">New type...</option>
  </select>`;
}

function EdgePanel({ doc, e, apply, setSel }) {
  const s = D.nodeById(doc, e.source), t = D.nodeById(doc, e.target);
  return html`<div class="ob-stack">
    <h3 class="label">Tie</h3>
    <p><button type="button" class="tlink" onClick=${() => setSel({ nodes: [s.id], edges: [] })}>${s.label}</button>
      ${e.directed ? ' to ' : ' and '}
      <button type="button" class="tlink" onClick=${() => setSel({ nodes: [t.id], edges: [] })}>${t.label}</button></p>
    <div class="field"><label class="field__label" for="ob-e-type">Type</label>
      <${TypeSelect} id="ob-e-type" doc=${doc} value=${e.type} onChange=${v => apply(d => D.updateEdge(d, e.id, { type: v }), 'Tie type')} /></div>
    <div class="field"><label class="field__label" for="ob-e-w">Weight</label>
      <input class="input" id="ob-e-w" type="number" min="0" step="any" value=${e.weight} onChange=${ev => apply(d => D.updateEdge(d, e.id, { weight: ev.currentTarget.value }), 'Tie weight')} /></div>
    ${doc.twoMode ? html`<p class="ob-note">${D.canConnect(doc, s.id, t.id) ? 'Both ends are of the same mode: this tie is left out of the analysis.' : 'An affiliation: membership has no direction.'}</p>`
      : html`<label class="check"><input type="checkbox" checked=${e.directed} onChange=${ev => apply(d => D.updateEdge(d, e.id, { directed: ev.currentTarget.checked }), 'Tie direction')} /> Directed (one-way)</label>`}
    <div class="ob-row">
      ${e.directed ? html`<button type="button" class="tlink" onClick=${() => apply(d => D.reverseEdge(d, e.id), 'Reverse tie')}>Reverse direction</button>` : null}
      <button type="button" class="tlink ob-danger" onClick=${() => { apply(d => D.removeEdges(d, [e.id]), 'Delete tie'); setSel({ nodes: [], edges: [] }); }}>Delete tie</button>
    </div>
  </div>`;
}

function DocPanel({ doc, apply, edgeDefaults, setEdgeDefaults, onTwoMode }) {
  const tm = doc.twoMode;
  const [col, setCol] = useState({ key: '', type: 'text' });
  const [grp, setGrp] = useState('');
  const addCol = () => { if (col.key.trim()) { apply(d => D.addAttrColumn(d, { key: col.key.trim(), type: col.type }), 'Add column'); setCol({ key: '', type: col.type }); } };
  const addGrp = () => { apply(d => D.addGroup(d, { name: grp }), 'Add group'); setGrp(''); };
  return html`<div class="ob-stack">
    <h3 class="label">Drawing</h3>
    <div class="field"><label class="field__label" for="ob-d-name">Name</label>
      <input class="input" id="ob-d-name" value=${doc.name} onChange=${e => apply(d => ({ ...d, name: e.currentTarget.value.trim() || d.name }), 'Rename drawing')} /></div>
    <dl class="ob-kv">${tm ? html`<dt>${tm.labels[0]}</dt><dd>${doc.nodes.filter(n => D.nodeMode(n) === 0).length}</dd><dt>${tm.labels[1]}</dt><dd>${doc.nodes.filter(n => D.nodeMode(n) === 1).length}</dd>` : html`<dt>People</dt><dd>${doc.nodes.length}</dd>`}<dt>Ties</dt><dd>${doc.edges.length}</dd><dt>Groups</dt><dd>${doc.groups.length}</dd></dl>

    <div class="ob-stack" style="gap:.4rem">
      <h3 class="label">Kind of network</h3>
      <label class="check"><input type="checkbox" id="ob-d-twomode" checked=${!!tm} onChange=${e => onTwoMode?.(e.currentTarget.checked)} /> Two-mode drawing</label>
      ${tm ? html`<div class="ob-row" style="flex-wrap:nowrap;gap:.4rem">
        ${[0, 1].map(m => html`<div class="field" style="flex:1 1 0;min-width:0"><label class="field__label" for=${'ob-d-mode' + m}>${m === 0 ? 'Circles are' : 'Squares are'}</label>
          <input class="input input--sm" id=${'ob-d-mode' + m} value=${tm.labels[m]} onChange=${e => apply(d => D.setModeLabels(d, m === 0 ? [e.currentTarget.value, d.twoMode.labels[1]] : [d.twoMode.labels[0], e.currentTarget.value]), 'Rename mode')} /></div>`)}
      </div>
      <p class="ob-note">Ties join ${tm.labels[0].toLowerCase()} to ${tm.labels[1].toLowerCase()} only (affiliations, like Davis's women and the events they attended). Network can show the two-mode network or either projection.</p>`
      : html`<p class="ob-note">Two-mode: two kinds of node, such as people and the clubs or events they belong to, tied only across the kinds.</p>`}
    </div>

    <div class="ob-stack" style="gap:.4rem">
      <h3 class="label">New ties</h3>
      <div class="field"><label class="field__label" for="ob-d-etype">Type</label>
        <${TypeSelect} id="ob-d-etype" doc=${doc} value=${edgeDefaults.type} onChange=${v => { apply(d => D.addEdgeType(d, v), 'Add tie type'); setEdgeDefaults({ ...edgeDefaults, type: v }); }} /></div>
      ${tm ? null : html`<label class="check"><input type="checkbox" checked=${edgeDefaults.directed} onChange=${e => setEdgeDefaults({ ...edgeDefaults, directed: e.currentTarget.checked })} /> Directed (one-way)</label>`}
    </div>

    <div class="ob-stack" style="gap:.4rem">
      <h3 class="label">Groups</h3>
      ${doc.groups.map((g, i) => html`<div class="ob-row" key=${g.id} style="flex-wrap:nowrap;gap:.4rem">
        <span class="ob-dot" style=${`background:${groupColor(i)}`} aria-hidden="true"></span>
        <input class="input input--sm" aria-label=${'Group name ' + (i + 1)} value=${g.name} onChange=${e => apply(d => D.renameGroup(d, g.id, e.currentTarget.value), 'Rename group')} />
        <button type="button" class="btn btn--sm btn--quiet" aria-label=${'Remove group ' + g.name} onClick=${() => apply(d => D.removeGroup(d, g.id), 'Remove group')}>Remove</button>
      </div>`)}
      <div class="ob-row" style="flex-wrap:nowrap;gap:.4rem">
        <input class="input input--sm" aria-label="New group name" placeholder="New group" value=${grp} onInput=${e => setGrp(e.currentTarget.value)} onKeyDown=${e => e.key === 'Enter' && addGrp()} />
        <button type="button" class="btn btn--sm" onClick=${addGrp}>Add group</button>
      </div>
      <p class="ob-note">Select people, then pick a group for them. Groups are drawn as outlines with their names, in the colors the analysis views use.</p>
    </div>

    <div class="ob-stack" style="gap:.4rem">
      <h3 class="label">Attribute columns</h3>
      ${doc.attrColumns.map(c => html`<div class="ob-row" key=${c.key} style="flex-wrap:nowrap;gap:.4rem">
        <span style="flex:1 1 auto;font-size:var(--fs-small)">${c.key}</span>
        <select class="select select--sm" style="width:auto" aria-label=${'Type of ' + c.key} value=${c.type} onChange=${e => apply(d => D.setAttrColumnType(d, c.key, e.currentTarget.value), 'Column type')}>
          ${ATTR_TYPES.map(t => html`<option value=${t}>${t}</option>`)}</select>
        <button type="button" class="btn btn--sm btn--quiet" aria-label=${'Remove column ' + c.key} onClick=${() => apply(d => D.removeAttrColumn(d, c.key), 'Remove column')}>Remove</button>
      </div>`)}
      <div class="ob-row" style="flex-wrap:nowrap;gap:.4rem">
        <input class="input input--sm" aria-label="New column name" placeholder="New column" value=${col.key} onInput=${e => setCol({ ...col, key: e.currentTarget.value })} onKeyDown=${e => e.key === 'Enter' && addCol()} />
        <select class="select select--sm" style="width:auto" aria-label="New column type" value=${col.type} onChange=${e => setCol({ ...col, type: e.currentTarget.value })}>
          ${ATTR_TYPES.map(t => html`<option value=${t}>${t}</option>`)}</select>
        <button type="button" class="btn btn--sm" onClick=${addCol}>Add column</button>
      </div>
    </div>
  </div>`;
}
