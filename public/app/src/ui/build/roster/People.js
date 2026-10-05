// Roster entry: paste or import names (with optional attribute columns), then
// edit them as a table. Shared by the roster and perceived-network builders.
// Attribute columns are typed (text, number, choice, ordered, yes/no, date):
// each can be renamed, retyped or removed from its header, cells take input
// of their type, and values that do not fit the type are flagged.

import { html, useState } from '../../../../vendor/preact.js';
import { parseRosterText, renameAttrColumn, removeAttrColumn, badAttrValues } from '../../../builders/roster.js';
import { uid, normName, ATTR_TYPES } from '../../../builders/common.js';

const TYPE_LABEL = { text: 'Text', number: 'Number', categorical: 'Choice', ordinal: 'Ordered', boolean: 'Yes / no', date: 'Date' };
import { pickFile, readFileText } from '../shared.js';

// onSurvey(text, fileName), when given, takes a survey responses file that
// was pasted or imported here (the roster builder starts a survey roster
// from it); without it the user is told where such a file goes.
export function PeopleEditor({ people, attrColumns = [], onChange, withAttrs = true, idPrefix = 'ob-people', onSurvey = null }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState(null);
  const [newName, setNewName] = useState('');
  // A table with no name column waits here for the user to pick one.
  const [pick, setPick] = useState(null); // { src, replace, headers, sample, file, col }

  const apply = (src, replace, { nameColumn, file = null } = {}) => {
    const r = parseRosterText(src, { nameColumn });
    if (r.survey) {
      if (onSurvey) { setText(''); setPick(null); onSurvey(src, file); return; }
      setMsg({ err: true, text: 'This is a survey responses file, not a list of names. Import it in the Roster builder (Import survey responses) or in Data.' });
      return;
    }
    if (r.needsColumn) { setPick({ src, replace, headers: r.headers, sample: r.sample, file, col: r.headers[0] }); setMsg(null); return; }
    setPick(null);
    if (!r.people.length) { setMsg({ err: true, text: 'No names found.' }); return; }
    const existing = new Set(people.map(p => normName(p.label)));
    const incoming = replace ? r.people : r.people.filter(p => !existing.has(normName(p.label)));
    const cols = [...attrColumns];
    for (const c of r.attrColumns) if (!cols.some(x => x.key === c.key)) cols.push(c);
    onChange(replace ? incoming : [...people, ...incoming], cols);
    const skipped = r.duplicates.length + (replace ? 0 : r.people.length - incoming.length);
    setMsg({ text: `${incoming.length} ${incoming.length === 1 ? 'person' : 'people'} added${skipped ? `; ${skipped} repeated name(s) skipped` : ''}.` });
    setText('');
  };
  const importFile = async () => {
    const f = await pickFile('.csv,.tsv,.txt,text/csv,text/plain');
    if (f) apply(await readFileText(f), people.length === 0, { file: f.name });
  };
  const update = (id, patch) => onChange(people.map(p => (p.id === id ? { ...p, ...patch } : p)), attrColumns);
  const remove = id => onChange(people.filter(p => p.id !== id), attrColumns);
  const addOne = e => {
    e.preventDefault();
    const label = newName.trim();
    if (!label) return;
    if (people.some(p => normName(p.label) === normName(label))) { setMsg({ err: true, text: `${label} is already on the roster.` }); return; }
    onChange([...people, { id: uid('p'), label, attrs: {} }], attrColumns);
    setNewName('');
  };
  const [newCol, setNewCol] = useState('');
  const [newType, setNewType] = useState('text');
  const addColumn = e => {
    e.preventDefault();
    const key = newCol.trim();
    if (!key) return;
    if (attrColumns.some(c => c.key === key)) { setMsg({ err: true, text: `There is already a column called ${key}.` }); return; }
    onChange(people, [...attrColumns, { key, type: newType }]);
    setNewCol('');
  };
  const model = { people, attrColumns };
  const renameCol = (key, next) => { const m = renameAttrColumn(model, key, next); onChange(m.people, m.attrColumns); };
  const retypeCol = (key, type) => onChange(people, attrColumns.map(c => (c.key === key ? { ...c, type } : c)));
  const removeCol = key => { if (!confirm(`Remove the column ${key} and its values?`)) return; const m = removeAttrColumn(model, key); onChange(m.people, m.attrColumns); };
  const isChoice = c => c.type === 'categorical' || c.type === 'ordinal';
  const listIdOf = c => `${idPrefix}-dl-${normName(c.key).replace(/\W+/g, '_')}`;
  const choices = key => [...new Set(people.map(p => p.attrs?.[key]).filter(v => v !== undefined && v !== ''))].sort();

  return html`<div class="ob-stack">
    <div class="field">
      <label class="field__label" for=${idPrefix + '-paste'}>Paste names</label>
      <textarea id=${idPrefix + '-paste'} class="input" rows="5" placeholder=${'One name per line, or a CSV with a "name" column and attribute columns'}
        value=${text} onInput=${e => setText(e.currentTarget.value)}></textarea>
    </div>
    <div class="ob-row" style="gap:.5rem 1.25rem">
      <button type="button" class="btn" disabled=${!text.trim()} onClick=${() => apply(text, false)}>Add to roster</button>
      ${people.length ? html`<button type="button" class="tlink" disabled=${!text.trim()} onClick=${() => apply(text, true)}>Replace the roster with these</button>` : null}
      <button type="button" class="tlink" onClick=${importFile}>Import names from a file (CSV or text)</button>
    </div>
    ${pick ? html`<div class="ob-colpick" role="group" aria-label="Choose the name column">
      <p class="ob-note" style="flex:1 1 100%">${pick.file || 'This table'} has columns but none is called name. Which column holds the names? The others become attributes.</p>
      <div class="field" style="min-width:12rem"><label class="field__label" for=${idPrefix + '-namecol'}>Names are in</label>
        <select id=${idPrefix + '-namecol'} class="select" value=${pick.col} onChange=${e => setPick({ ...pick, col: e.currentTarget.value })}>
          ${pick.headers.map(h => html`<option value=${h}>${h}${pick.sample?.[0] ? ` (e.g. ${pick.sample[0][pick.headers.indexOf(h)] ?? ''})` : ''}</option>`)}
          <option value="">Each whole line is one name</option></select></div>
      <button type="button" class="btn btn--sm" onClick=${() => apply(pick.src, pick.replace, { nameColumn: pick.col, file: pick.file })}>Use this column</button>
      <button type="button" class="tlink tlink--quiet" onClick=${() => setPick(null)}>Cancel</button>
    </div>` : null}
    ${msg ? html`<p class=${msg.err ? 'ob-note ob-err' : 'ob-note'} role="status">${msg.text}</p>` : null}
    <form class="ob-row" onSubmit=${addOne}>
      <label class="visually-hidden" for=${idPrefix + '-one'}>Add one person</label>
      <input id=${idPrefix + '-one'} class="input" style="max-width:16rem" placeholder="Add one person" value=${newName} onInput=${e => setNewName(e.currentTarget.value)} />
      <button type="submit" class="btn btn--sm" disabled=${!newName.trim()}>Add person</button>
      <span class="ob-spacer"></span>
      <span class="meta">${people.length} on roster</span>
    </form>
    ${withAttrs ? html`<form class="ob-row" onSubmit=${addColumn}>
      <label class="visually-hidden" for=${idPrefix + '-col'}>New attribute column</label>
      <input id=${idPrefix + '-col'} class="input" style="max-width:16rem" placeholder="New attribute, e.g. department" value=${newCol} onInput=${e => setNewCol(e.currentTarget.value)} />
      <label class="visually-hidden" for=${idPrefix + '-coltype'}>Type of the new attribute</label>
      <select id=${idPrefix + '-coltype'} class="select select--sm" style="width:auto" value=${newType} onChange=${e => setNewType(e.currentTarget.value)}>
        ${ATTR_TYPES.map(t => html`<option value=${t}>${TYPE_LABEL[t] || t}</option>`)}</select>
      <button type="submit" class="btn btn--sm" disabled=${!newCol.trim()}>Add attribute column</button>
    </form>` : null}
    ${people.length ? html`<div class="table-wrap" style="max-height:22rem">
      <table class="tbl">
        <thead><tr><th>#</th><th>Name</th>${withAttrs ? attrColumns.map(c => html`<th class="ob-colhead">
          <input class="input input--sm" aria-label=${`Column name ${c.key}`} value=${c.key} onChange=${e => renameCol(c.key, e.currentTarget.value)} />
          <span class="ob-row" style="gap:.25rem .5rem;flex-wrap:nowrap">
            <select class="select select--sm" aria-label=${`Type of ${c.key}`} value=${c.type || 'text'} onChange=${e => retypeCol(c.key, e.currentTarget.value)}>
              ${ATTR_TYPES.map(t => html`<option value=${t}>${TYPE_LABEL[t] || t}</option>`)}</select>
            <button type="button" class="tlink tlink--quiet" aria-label=${`Remove the column ${c.key}`} onClick=${() => removeCol(c.key)}>Remove</button>
          </span>
          ${(() => { const bad = badAttrValues(model, c.key); return bad.length ? html`<span class="ob-note ob-warn">${bad.length} not ${(TYPE_LABEL[c.type] || c.type).toLowerCase()}</span>` : null; })()}
        </th>`) : null}<th><span class="visually-hidden">Remove</span></th></tr></thead>
        <tbody>${people.map((p, i) => html`<tr key=${p.id}>
          <td class="num muted">${i + 1}</td>
          <td><input class="input" aria-label=${`Name ${i + 1}`} value=${p.label} onChange=${e => update(p.id, { label: e.currentTarget.value.trim() || p.label })} /></td>
          ${withAttrs ? attrColumns.map(c => html`<td><${AttrCell} col=${c} p=${p} listId=${isChoice(c) ? listIdOf(c) : null}
            onSet=${v => update(p.id, { attrs: { ...p.attrs, [c.key]: v } })} /></td>`) : null}
          <td><button type="button" class="btn btn--sm btn--quiet" aria-label=${`Remove ${p.label}`} onClick=${() => remove(p.id)}>Remove</button></td>
        </tr>`)}</tbody>
      </table>
      ${withAttrs ? attrColumns.filter(isChoice).map(c => html`<datalist id=${listIdOf(c)}>${choices(c.key).map(v => html`<option value=${v} />`)}</datalist>`) : null}
      </div>` : null}
  </div>`;
}

// One attribute value, with an input of the column's type. Choice columns
// suggest the values already used (a datalist), so categories stay consistent.
function AttrCell({ col, p, onSet, listId }) {
  const v = p.attrs?.[col.key] ?? '';
  const label = `${col.key} for ${p.label}`;
  if (col.type === 'boolean') {
    const cur = v === '' ? '' : /^(true|yes|1|y)$/i.test(String(v)) ? 'true' : 'false';
    return html`<select class="select select--sm" aria-label=${label} value=${cur} onChange=${e => onSet(e.currentTarget.value)}>
      <option value="">-</option><option value="true">Yes</option><option value="false">No</option></select>`;
  }
  const type = col.type === 'number' ? 'number' : col.type === 'date' ? 'date' : 'text';
  const bad = v !== '' && ((col.type === 'number' && !Number.isFinite(Number(v))) || (col.type === 'date' && Number.isNaN(Date.parse(String(v)))));
  return html`<span>
    <input class="input" type=${bad ? 'text' : type} step=${type === 'number' ? 'any' : undefined} aria-label=${label} aria-invalid=${bad ? 'true' : undefined}
      list=${listId || undefined} value=${v} onChange=${e => onSet(e.currentTarget.value)} />
  </span>`;
}
