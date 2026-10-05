// Choosing people from a list: a type-ahead combobox (ARIA 1.2 combobox with
// a listbox popup) used wherever a person is picked in the builders and in
// respondent mode, so nobody has to recall and retype a name.
//
//   Combobox     text input + suggestions; Enter or click picks the highlighted
//                suggestion, or hands the typed text to onText when free text
//                is allowed. Arrow keys move, Escape closes, Tab leaves.
//   PersonSelect a <select> replacement: the chosen person's name is shown and
//                typing filters the list.

import { html, useState, useRef, useEffect, useMemo } from '../../../vendor/preact.js';
import { matchNames } from '../../builders/names.js';

let seq = 0;

// items: [{ id, label, hint? }]. onPick(item). onText(text) when free text is
// allowed (Enter with nothing highlighted). freeText: label for the free-text
// option shown at the end of the list ("Add “x”"), or null.
export function Combobox({ id, label, items, onPick, onText = null, placeholder = 'Type a name', disabled = false,
  hideLabel = false, freeText = null, limit = 8, value = null, onInput = null, clearOnPick = true, describedBy, noMatch = null }) {
  const uidRef = useRef(id || `ob-cb-${++seq}`);
  const cid = uidRef.current;
  const [text, setText] = useState(value ?? '');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const inputRef = useRef(null);
  useEffect(() => { if (value !== null && value !== undefined) setText(value); }, [value]);
  const shown = useMemo(() => matchNames(text, items, { limit }), [text, items, limit]);
  const free = onText && freeText && text.trim() && !shown.some(x => x.label.toLowerCase() === text.trim().toLowerCase());
  const options = [...shown.map(x => ({ kind: 'item', x })), ...(free ? [{ kind: 'free' }] : [])];
  const pick = o => {
    if (!o) return;
    if (o.kind === 'free') onText(text.trim()); else onPick(o.x);
    if (clearOnPick) setText(''); else if (o.kind === 'item') setText(o.x.label);
    setOpen(false); setActive(-1);
    inputRef.current?.focus();
  };
  const onKey = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(a => Math.min(options.length - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(-1, a - 1)); }
    else if (e.key === 'Escape') { if (open) { e.preventDefault(); e.stopPropagation(); setOpen(false); setActive(-1); } }
    else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && options[active]) pick(options[active]);
      else if (onText && text.trim()) { onText(text.trim()); if (clearOnPick) setText(''); setOpen(false); }
      else if (shown.length === 1) pick(options[0]);
    }
  };
  const listId = `${cid}-list`;
  const optId = i => `${cid}-o${i}`;
  return html`<div class="ob-combo">
    <label class=${hideLabel ? 'visually-hidden' : 'field__label'} for=${cid}>${label}</label>
    <input id=${cid} ref=${inputRef} class="input" type="text" role="combobox" autocomplete="off" spellcheck="false"
      aria-autocomplete="list" aria-expanded=${String(open && options.length > 0)} aria-controls=${listId}
      aria-activedescendant=${open && active >= 0 ? optId(active) : undefined} aria-describedby=${describedBy}
      placeholder=${placeholder} disabled=${disabled} value=${text}
      onInput=${e => { setText(e.currentTarget.value); setOpen(true); setActive(-1); onInput?.(e.currentTarget.value); }}
      onFocus=${() => setOpen(true)}
      onBlur=${() => setTimeout(() => setOpen(false), 150)}
      onKeyDown=${onKey} />
    <ul id=${listId} role="listbox" class="ob-combo__list" aria-label=${label} hidden=${!(open && options.length)}>
      ${options.map((o, i) => html`<li id=${optId(i)} role="option" aria-selected=${String(i === active)} class="ob-combo__opt"
        onMouseDown=${e => { e.preventDefault(); pick(o); }}>
        ${o.kind === 'free' ? html`<span>${freeText.replace('%s', text.trim())}</span>`
          : html`<span>${o.x.label}</span>${o.x.hint ? html`<span class="ob-combo__hint">${o.x.hint}</span>` : null}`}
      </li>`)}
    </ul>
    ${noMatch && text.trim() && !options.length ? html`<p class="ob-note ob-warn" role="status">${noMatch(text.trim())}</p>` : null}
  </div>`;
}

// A person chooser in place of a <select>: value is a person id.
export function PersonSelect({ id, label, people, value, onChange, exclude = null, hideLabel = false }) {
  const items = useMemo(() => people.filter(p => p.id !== exclude).map(p => ({ id: p.id, label: p.label })), [people, exclude]);
  const cur = people.find(p => p.id === value);
  return html`<${Combobox} id=${id} label=${label} hideLabel=${hideLabel} items=${items} value=${cur?.label ?? ''} clearOnPick=${false}
    placeholder="Type to find a name" onPick=${x => onChange(x.id)} />`;
}
