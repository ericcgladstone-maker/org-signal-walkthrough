// Tie fields in the builders: an editor for a relation's (or an interview's)
// field definitions, and the inputs that record one tie's values. Pure
// definitions and typing live in src/builders/tiefields.js.

import { html, useState } from '../../../vendor/preact.js';
import { TIE_FIELD_PRESETS, TIE_FIELD_TYPES, makeTieField, updateTieField } from '../../builders/tiefields.js';
import { DraftInput } from './shared.js';

// fields: [TieField]; onChange(next fields). taken: keys used elsewhere.
export function TieFieldsEditor({ fields = [], onChange, idPrefix = 'ob-tf', taken = [], intro = null }) {
  const [custom, setCustom] = useState('');
  const keys = () => [...taken, ...fields.map(f => f.key)];
  const has = p => fields.some(f => f.key === p.key);
  const toggle = (p, on) => onChange(on ? [...fields, makeTieField({ preset: p.id }, keys())] : fields.filter(f => f.key !== p.key));
  const update = (id, patch) => onChange(fields.map(f => (f.id === id ? updateTieField(f, patch) : f)));
  const remove = id => onChange(fields.filter(f => f.id !== id));
  return html`<div class="ob-stack ob-tf">
    ${intro ? html`<p class="ob-note">${intro}</p>` : null}
    <div class="ob-row" role="group" aria-label="Common tie fields">
      ${TIE_FIELD_PRESETS.map(p => html`<label class="check"><input type="checkbox" checked=${has(p)} onChange=${e => toggle(p, e.currentTarget.checked)} />${p.label}</label>`)}
    </div>
    <form class="ob-row" onSubmit=${e => { e.preventDefault(); if (custom.trim()) { onChange([...fields, makeTieField({ label: custom.trim(), type: 'choice', options: [] }, keys())]); setCustom(''); } }}>
      <label class="visually-hidden" for=${idPrefix + '-new'}>New tie field</label>
      <input id=${idPrefix + '-new'} class="input input--sm" style="max-width:16rem" placeholder="Custom field, e.g. Channel" value=${custom} onInput=${e => setCustom(e.currentTarget.value)} />
      <button type="submit" class="btn btn--sm" disabled=${!custom.trim()}>Add field</button>
    </form>
    ${fields.map(f => html`<div class="ob-tf__item" key=${f.id}>
      <div class="ob-tf__grid">
        <div class="field"><label class="field__label" for=${`${idPrefix}-${f.id}-l`}>Field</label>
          <${DraftInput} id=${`${idPrefix}-${f.id}-l`} className="input input--sm" value=${f.label} selectOnFocus=${true}
            onCommit=${v => { if (v.trim() && v.trim() !== f.label) update(f.id, { label: v.trim() }); }} /></div>
        <div class="field"><label class="field__label" for=${`${idPrefix}-${f.id}-t`}>Answer</label>
          <select id=${`${idPrefix}-${f.id}-t`} class="select select--sm" value=${f.type} onChange=${e => update(f.id, { type: e.currentTarget.value })}>
            ${TIE_FIELD_TYPES.map(t => html`<option value=${t.id}>${t.label}</option>`)}</select></div>
        ${f.type === 'scale' ? html`<div class="field"><label class="field__label" for=${`${idPrefix}-${f.id}-m`}>Top of scale</label>
          <input id=${`${idPrefix}-${f.id}-m`} class="input input--sm" type="number" min="2" max="10" value=${f.max} onChange=${e => update(f.id, { max: e.currentTarget.value })} /></div>` : null}
        <button type="button" class="tlink tlink--quiet ob-tf__rm" aria-label=${`Remove the field ${f.label}`} onClick=${() => remove(f.id)}>Remove</button>
      </div>
      ${f.type === 'choice' ? html`<div class="ob-tf__grid">
        <div class="field" style="grid-column:1/-1"><label class="field__label" for=${`${idPrefix}-${f.id}-o`}>Options, one per line${f.ordered ? ' (lowest first)' : ''}</label>
          <textarea id=${`${idPrefix}-${f.id}-o`} class="input" rows="3" value=${(f.options || []).join('\n')} onChange=${e => update(f.id, { options: e.currentTarget.value.split('\n') })}></textarea></div>
        <label class="check"><input type="checkbox" checked=${!!f.multiple} onChange=${e => update(f.id, { multiple: e.currentTarget.checked })} />More than one may apply</label>
        <label class="check"><input type="checkbox" checked=${!!f.ordered} onChange=${e => update(f.id, { ordered: e.currentTarget.checked })} />Options run from low to high</label>
      </div>` : null}
    </div>`)}
  </div>`;
}

// The inputs for one tie's values. values: { key: raw }; onChange(key, value).
// compact: one row per field, for tables and lists.
export function TieFieldInputs({ fields, values = {}, onChange, idPrefix, compact = false, labelFor = f => f.label }) {
  return html`<div class=${compact ? 'ob-tfin ob-tfin--compact' : 'ob-tfin'}>
    ${fields.map(f => {
      const id = `${idPrefix}-${f.key}`;
      const v = values?.[f.key];
      if (f.type === 'choice' && f.multiple) {
        const cur = Array.isArray(v) ? v : v ? [v] : [];
        return html`<fieldset class="ob-tfin__f ob-tfin__multi"><legend class="field__label">${labelFor(f)}</legend>
          <div class="ob-row" style="gap:.2rem .9rem">${(f.options || []).map(o => html`<label class="check"><input type="checkbox" checked=${cur.includes(o)}
            onChange=${e => onChange(f.key, e.currentTarget.checked ? [...cur, o] : cur.filter(x => x !== o))} />${o}</label>`)}</div></fieldset>`;
      }
      if (f.type === 'choice') {
        return html`<div class="field ob-tfin__f"><label class="field__label" for=${id}>${labelFor(f)}</label>
          <select id=${id} class="select select--sm" value=${v ?? ''} onChange=${e => onChange(f.key, e.currentTarget.value)}>
            <option value="">Not answered</option>${(f.options || []).map(o => html`<option value=${o}>${o}</option>`)}</select></div>`;
      }
      if (f.type === 'scale') {
        return html`<fieldset class="ob-tfin__f"><legend class="field__label">${labelFor(f)} (1 to ${f.max})</legend>
          <div class="seg seg--scale" role="group" aria-label=${`${labelFor(f)}, 1 to ${f.max}`}>
            ${Array.from({ length: f.max }, (_, i) => i + 1).map(n => html`<button type="button" aria-pressed=${String(Number(v) === n)}
              onClick=${() => onChange(f.key, Number(v) === n ? '' : n)}>${n}</button>`)}
          </div></fieldset>`;
      }
      return html`<div class="field ob-tfin__f"><label class="field__label" for=${id}>${labelFor(f)}</label>
        <input id=${id} class="input input--sm" type=${f.type === 'number' ? 'number' : 'text'} step="any" value=${v ?? ''}
          onChange=${e => onChange(f.key, e.currentTarget.value)} /></div>`;
    })}
  </div>`;
}
