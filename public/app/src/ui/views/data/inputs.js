// The list of inputs waiting to be imported: what each was recognized as,
// its options, and the column mapper for tables. Inputs read by the same
// importer (56 WhatsApp chats) are shown as one group with one set of options.

import { html, useState, useEffect } from '../../../../vendor/preact.js';
import { Flag, Loading, ErrorLine, Select, Seg } from '../../components/common.js';
import { listImporters, peekCSV, suggestMapping } from '../../services/pipeline.js';
import { fmtInt, fmtBytes, plural, humanize } from '../../lib/format.js';
import { isCSV, blobOf, whyUnrecognized, timeZones, browserZone } from './io.js';

let importerList = null;
function useImporters() {
  const [all, setAll] = useState(importerList || []);
  useEffect(() => { if (!importerList) listImporters().then(l => { importerList = l; setAll(l); }); }, []);
  return all;
}

// Importers that will read this input: the one chosen, or (automatic) every
// detection that claims files, best first.
export function effectiveImporters(input, all = importerList || []) {
  const det = input.detections || [];
  if (input.importerId && input.importerId !== 'auto') {
    const d = det.find(x => x.id === input.importerId) || all.find(x => x.id === input.importerId);
    return d ? [d] : [];
  }
  const claimed = [];
  for (const d of det) if (d.score >= 0.5 && !claimed.some(c => c.id === d.id)) claimed.push(d);
  if (claimed.length) return claimed;
  const fallback = det.find(d => d.id === 'tabular') || det[0];
  return fallback ? [fallback] : [];
}

export const isRecognized = input => !input.detecting && !input.error && effectiveImporters(input).length > 0;

// 'join' or 'import'. A table of people defaults to joining when there is
// something to join it to: loaded data or another input that is not a table.
export function inputUse(input, inputs, hasData) {
  if (input.use) return input.use;
  if (input.tableKind !== 'nodes') return 'import';
  return hasData || inputs.some(x => x.id !== input.id && x.tableKind !== 'nodes') ? 'join' : 'import';
}

// Inputs whose importer is the same single one, three or more of them, are grouped.
export function groupInputs(inputs) {
  const groups = new Map();
  const out = [];
  for (const inp of inputs) {
    const eff = inp.detecting ? [] : effectiveImporters(inp);
    const id = eff.length === 1 && !inp.error && inp.importerId === 'auto' && eff[0].id !== 'tabular' ? eff[0].id : null;
    if (id) { if (!groups.has(id)) { groups.set(id, { id, label: eff[0].label, inputs: [] }); out.push(groups.get(id)); } groups.get(id).inputs.push(inp); }
    else out.push({ single: inp });
  }
  return out.flatMap(g => (g.single || g.inputs.length >= 3 ? [g] : g.inputs.map(single => ({ single }))));
}

export function InputList({ inputs, uses, onChange, onChangeMany, onRemove }) {
  const groups = groupInputs(inputs);
  return html`<div class="dv-inputs">
    ${groups.map(g => (g.single
      ? html`<${InputCard} key=${g.single.id} input=${g.single} use=${uses.get(g.single.id)} onChange=${p => onChange(g.single.id, p)} onRemove=${() => onRemove(g.single.id)} />`
      : html`<${GroupCard} key=${g.id} group=${g} onChangeMany=${onChangeMany} onRemove=${onRemove} />`))}
  </div>`;
}

function Recognized({ list, reasons }) {
  return html`<div class="dv-recog">
    <${Flag} level="ok">Recognized</${Flag}>
    <span>${list.map(d => d.label).join(' and ')}</span>
    ${reasons.length > 0 && html`<details class="dv-why"><summary>Why?</summary><ul class="can-list">${reasons.map(r => html`<li>${r}</li>`)}</ul></details>`}
  </div>`;
}

function InputCard({ input, use, onChange, onRemove }) {
  const all = useImporters();
  const det = input.detections || [];
  const eff = effectiveImporters(input, all);
  const nFiles = input.fileCount ?? input.files.length;
  const table = input.tableKind === 'nodes';
  const detIds = new Set(det.map(d => d.id));
  const choices = [
    { value: 'auto', label: eff.length ? `Automatic: ${eff.map(d => d.label).join(' + ')}` : 'Automatic' },
    ...(det.length ? [{ group: 'Recognized', options: det.map(d => ({ value: d.id, label: d.label })) }] : []),
    ...(all.some(i => !detIds.has(i.id)) ? [{ group: 'Other importers', options: all.filter(i => !detIds.has(i.id)).map(i => ({ value: i.id, label: i.label })) }] : []),
  ];
  const mapping = use === 'import' && eff.some(d => d.id === 'tabular' || (d.options || []).some(o => o.type === 'mapping')) && input.files.some(isCSV);
  const setOpt = (imp, k, v) => onChange({ options: { ...input.options, [imp]: { ...(input.options[imp] || {}), [k]: v } } });
  const status = input.detecting ? 'detecting' : input.error ? 'error' : !eff.length ? 'none' : 'ok';
  return html`<article class="src dv-input" aria-label=${input.name}>
    <div class="src__head">
      <div class="dv-input__name">
        <span class="src__title">${input.name}</span>
        <span class="meta">${input.kind}${nFiles > 1 ? ` · ${fmtInt(nFiles)} files` : ''} · ${fmtBytes(input.size)}</span>
      </div>
      <button type="button" class="tlink tlink--quiet" onClick=${onRemove} aria-label=${`Remove ${input.name}`}>Remove</button>
    </div>
    <div role="status" class="dv-input__status">
      ${status === 'detecting' && html`<${Loading}>${input.progress || 'Detecting the format'}</${Loading}>`}
      ${status === 'error' && html`<${ErrorLine} error=${`Could not read this input: ${input.error}`} />`}
      ${status === 'none' && html`<p class="small"><${Flag} level="caution">Not recognized</${Flag}> <span class="text2">${whyUnrecognized(input)}</span></p>`}
      ${status === 'ok' && !table && html`<${Recognized} list=${eff} reasons=${eff.map(d => d.reason).filter(Boolean)} />`}
      ${status === 'ok' && table && html`<p class="small text2">A table with one row per person.</p>`}
    </div>
    ${status === 'ok' && table && html`<div class="dv-use">
      <${Seg} label="Use this table to" value=${use} onChange=${v => onChange({ use: v })}
        options=${[{ value: 'join', label: 'Add details to people' }, { value: 'import', label: 'Import it as a source' }]} />
      <p class="small text2">${use === 'join'
        ? 'Its columns (department, role, office...) are joined to the people in the other data by email or name. You can check the matches before loading.'
        : 'Each row becomes a person, with no ties between them unless other sources add some.'}</p>
    </div>`}
    ${(status === 'ok' || status === 'none') && use === 'import' && html`<div class="grid-2 dv-opts">
      <${Select} label="Importer" value=${input.importerId} onChange=${v => onChange({ importerId: v })} options=${choices} />
      ${eff.map(d => html`<${OptionFields} key=${d.id} imp=${d} values=${input.options[d.id] || {}} hide=${mapping ? ['kind'] : []} onChange=${(k, v) => setOpt(d.id, k, v)} heading=${eff.length > 1 ? d.label : null} />`)}
    </div>`}
    ${mapping && html`<${ColumnMapper} file=${blobOf(input.files.find(isCSV))} value=${input.options.tabular || {}} onChange=${v => onChange({ options: { ...input.options, tabular: { ...(input.options.tabular || {}), ...v } } })} />`}
  </article>`;
}

function GroupCard({ group, onChangeMany, onRemove }) {
  const first = group.inputs[0];
  const imp = effectiveImporters(first)[0];
  const values = first.options[imp.id] || {};
  const size = group.inputs.reduce((s, i) => s + i.size, 0);
  const setOpt = (k, v) => onChangeMany(group.inputs.map(i => i.id), inp => ({ options: { ...inp.options, [imp.id]: { ...(inp.options[imp.id] || {}), [k]: v } } }));
  return html`<article class="src dv-input" aria-label=${`${group.inputs.length} ${group.label} inputs`}>
    <div class="src__head">
      <div class="dv-input__name"><span class="src__title">${plural(group.inputs.length, group.label)}</span><span class="meta">${fmtBytes(size)}</span></div>
      <button type="button" class="tlink tlink--quiet" onClick=${() => group.inputs.forEach(i => onRemove(i.id))}>Remove all</button>
    </div>
    <${Recognized} list=${[imp]} reasons=${[...new Set(group.inputs.map(i => effectiveImporters(i)[0]?.reason).filter(Boolean))].slice(0, 3)} />
    ${(imp.options || []).some(o => o.type !== 'mapping') && html`<p class="small text2 dv-opts__note">These options apply to all ${fmtInt(group.inputs.length)}.</p>`}
    <div class="grid-2 dv-opts"><${OptionFields} imp=${imp} values=${values} onChange=${setOpt} /></div>
    <details class="disclose dv-files"><summary>List the ${fmtInt(group.inputs.length)} files</summary>
      <ul class="dv-files__list">${group.inputs.map(i => html`<li><span>${i.name}</span><span class="meta">${fmtBytes(i.size)}</span><button type="button" class="tlink tlink--quiet" onClick=${() => onRemove(i.id)} aria-label=${`Remove ${i.name}`}>Remove</button></li>`)}</ul>
    </details>
  </article>`;
}

function OptionFields({ imp, values, onChange, hide = [], heading = null }) {
  const opts = (imp.options || []).filter(o => o.type !== 'mapping' && !hide.includes(o.key));
  if (!opts.length) return null;
  return html`${heading && html`<p class="label dv-opts__head">${heading}</p>`}
    ${opts.map(o => html`<${OptionField} key=${o.key} opt=${o} value=${values[o.key] ?? o.default} onChange=${v => onChange(o.key, v)} />`)}`;
}

const isZoneOption = o => o.type === 'timezone' || /^(time_?zone|tz)$/i.test(o.key);

export function OptionField({ opt, value, onChange }) {
  if (opt.type === 'boolean') return html`<label class="check dv-check"><input type="checkbox" checked=${!!value} onChange=${e => onChange(e.currentTarget.checked)} />${opt.label}</label>`;
  if (isZoneOption(opt)) return html`<${ZoneField} opt=${opt} value=${value} onChange=${onChange} />`;
  if (opt.choices) {
    const choices = opt.choices.map(c => (typeof c === 'object' ? { value: c.value, label: c.label } : { value: c, label: humanize(c) }));
    if (choices.length <= 5 && choices.every(c => c.label.length <= 28) && value != null) return html`<${Seg} label=${opt.label} value=${value} onChange=${onChange} options=${choices} />`;
    return html`<${Select} label=${opt.label} value=${value ?? ''} onChange=${onChange} options=${[...(value == null ? [{ value: '', label: 'Automatic' }] : []), ...choices]} />`;
  }
  return html`<label class="field"><span>${opt.label}</span><input class="input" type=${opt.type === 'number' ? 'number' : 'text'} value=${value ?? ''} onInput=${e => onChange(opt.type === 'number' ? Number(e.currentTarget.value) : e.currentTarget.value)} /></label>`;
}

function ZoneField({ opt, value, onChange }) {
  const here = browserZone();
  const list = timeZones();
  const options = [
    ...(opt.default === 'unknown' ? [{ value: 'unknown', label: 'Not known (read as UTC)' }] : []),
    { value: here, label: `${here} (this computer)` },
    ...list.filter(z => z !== here).map(z => ({ value: z, label: z })),
  ];
  return html`<div>
    <${Select} label=${opt.label.replace(/\s*\(IANA.*$/i, '')} value=${value || 'unknown'} onChange=${onChange} options=${options} />
    ${value === here && html`<p class="small text2 dv-hint">Filled in with this computer's time zone. Change it if the export came from a device set to another zone.</p>`}
  </div>`;
}

// ---- tabular column mapper -------------------------------------------------------

const ROLE_SETS = {
  events: [['actor', 'Who acted (sender)'], ['targets', 'Directed at (recipients)'], ['timestamp', 'When'], ['context', 'Where (channel, thread)'], ['text', 'Message text'], ['weight', 'Weight'], ['type', 'Kind of event'], ['ignore', 'Ignore']],
  edges: [['actor', 'Source'], ['targets', 'Target'], ['weight', 'Weight'], ['type', 'Tie type'], ['directed', 'Directed flag'], ['ignore', 'Ignore']],
  nodes: [['id', 'Person id'], ['label', 'Name'], ['attr', 'Attribute'], ['ignore', 'Ignore']],
  // Two-mode (affiliation) tables: people and the events or groups they belong to.
  affiliations: [['actor', 'Person'], ['targets', 'Event or group'], ['weight', 'Weight'], ['timestamp', 'When'], ['ignore', 'Ignore']],
  incidence: [['actor', 'Row name'], ['event', 'Event column'], ['attr', 'Row attribute'], ['ignore', 'Ignore']],
};
const KIND_OPTIONS = [
  { value: 'events', label: 'An event (message, meeting...)' },
  { value: 'edges', label: 'A tie between two people' },
  { value: 'nodes', label: 'A person (attributes)' },
  { value: 'affiliations', label: 'A person and an event or group (two-mode list)' },
  { value: 'incidence', label: 'A person, one column per event or group (two-mode matrix)' },
];
const TWO_MODE = new Set(['affiliations', 'incidence']);
// What an unmapped column becomes for each kind.
const fallbackRole = k => (k === 'nodes' ? 'attr' : k === 'incidence' ? 'event' : 'ignore');
// Roles one column at most can play; attributes and ignored columns can repeat.
const SINGLE = new Set(['actor', 'targets', 'timestamp', 'context', 'text', 'weight', 'type', 'directed', 'id', 'label']);

export function ColumnMapper({ file, value, onChange }) {
  const [state, setState] = useState(null);
  const [err, setErr] = useState(null);
  const [moved, setMoved] = useState(null);
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { headers, rows } = await peekCSV(file, 50);
        const s = await suggestMapping(headers, rows);
        const kind = value.kind || s.kind || 'events';
        const roles = {};
        for (const h of headers) roles[h] = fallbackRole(kind);
        for (const [role, col] of Object.entries(s.mapping || {})) if (typeof col === 'string' && headers.includes(col) && ROLE_SETS[kind].some(([r]) => r === role)) roles[col] = role;
        // Incidence matrix: the suggestion lists event columns and row attributes.
        if (kind === 'incidence' && kind === s.kind) for (const h of s.mapping?.attrs || []) if (headers.includes(h)) roles[h] = 'attr';
        const modeLabels = s.mapping?.modeLabels || ['People', 'Events'];
        if (live) setState({ headers, rows, kind, roles, notes: s.notes || [], extra: { timeFormat: s.mapping?.timeFormat, timezone: s.mapping?.timezone, targetSeparator: s.mapping?.targetSeparator, modeLabels } });
      } catch (e) { if (live) setErr(e); }
    })();
    return () => { live = false; };
  }, [file]);
  useEffect(() => { if (state) onChange({ kind: state.kind, mapping: toMapping(state) }); }, [state]);
  if (err) return html`<${ErrorLine} error=${`Could not read the table: ${err.message}`} />`;
  if (!state) return html`<${Loading}>Reading columns</${Loading}>`;
  const roles = ROLE_SETS[state.kind];
  const roleName = r => (roles.find(([v]) => v === r) || [r, r])[1];
  // One column per single role: giving a role to a second column takes it
  // from the first, and says so (two "Person id" columns used to pass silently).
  const setRole = (h, r) => setState(s => {
    const next = { ...s.roles, [h]: r };
    let prev = null;
    if (SINGLE.has(r)) for (const [col, role] of Object.entries(s.roles)) if (col !== h && role === r) { next[col] = fallbackRole(s.kind); prev = col; }
    setMoved(prev ? `"${prev}" was the ${roleName(r)} column; it is now ${s.kind === 'nodes' ? 'an attribute' : s.kind === 'incidence' ? 'an event column' : 'ignored'}.` : null);
    return { ...s, roles: next };
  });
  const missing = (state.kind === 'nodes' ? ['id'] : state.kind === 'incidence' ? ['actor', 'event'] : ['actor', 'targets']).filter(r => !Object.values(state.roles).includes(r));
  const setModeLabel = (k, v) => setState(s => { const l = [...(s.extra.modeLabels || ['People', 'Events'])]; l[k] = v; return { ...s, extra: { ...s.extra, modeLabels: l } }; });
  return html`<div class="dv-mapper">
    <p class="label">Column mapping</p>
    <div class="row dv-mapper__row">
      <${Select} label="Each row is" value=${state.kind} onChange=${k => setState(s => ({ ...s, kind: k, roles: Object.fromEntries(Object.entries(s.roles).map(([h, r]) => [h, ROLE_SETS[k].some(([v]) => v === r) ? r : fallbackRole(k)])) }))} options=${KIND_OPTIONS} />
      ${TWO_MODE.has(state.kind) && html`<label class="field"><span>First kind is called</span><input class="input" type="text" value=${state.extra.modeLabels?.[0] ?? ''} onInput=${e => setModeLabel(0, e.currentTarget.value)} /></label>
        <label class="field"><span>Second kind is called</span><input class="input" type="text" value=${state.extra.modeLabels?.[1] ?? ''} onInput=${e => setModeLabel(1, e.currentTarget.value)} /></label>`}
      ${state.kind === 'events' && html`<${Select} label="Time format" value=${state.extra.timeFormat || 'iso'} onChange=${v => setState(s => ({ ...s, extra: { ...s.extra, timeFormat: v } }))} options=${[['iso', 'ISO (2025-01-31 14:05)'], ['epoch_s', 'Unix seconds'], ['epoch_ms', 'Unix milliseconds'], ['mdy', 'Month/day/year'], ['dmy', 'Day/month/year'], ['ymd', 'Year/month/day']].map(([v, l]) => ({ value: v, label: l }))} />`}
      ${state.kind === 'events' && html`<${ZoneField} opt=${{ label: 'Time zone of the times', default: 'UTC' }} value=${state.extra.timezone || 'UTC'} onChange=${v => setState(s => ({ ...s, extra: { ...s.extra, timezone: v } }))} />`}
    </div>
    ${state.notes.map(n => html`<p class="small text2">${n}</p>`)}
    ${TWO_MODE.has(state.kind) && html`<p class="small text2">Two-mode data: people are tied only to the events or groups they belong to. Network can show the two kinds side by side or tie people by the events they share (construction settings).</p>`}
    ${moved && html`<p class="small" role="status"><${Flag} level="info" /> ${moved}</p>`}
    ${missing.length > 0 && html`<p class="small" role="status"><${Flag} level="caution">Needs a column</${Flag}> <span class="text2">Choose a column for ${missing.map(roleName).join(' and ')}.</span></p>`}
    <div class="table-wrap">
      <table class="tbl dv-mapper__tbl">
        <thead><tr>${state.headers.map(h => html`<th scope="col">
          <div class="dv-mapper__col">${h}</div>
          <select class="select" aria-label=${`Role of column ${h}`} value=${state.roles[h]} onChange=${e => setRole(h, e.currentTarget.value)}>
            ${roles.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
          </select></th>`)}</tr></thead>
        <tbody>${state.rows.slice(0, 5).map(r => html`<tr>${state.headers.map((h, j) => html`<td class=${state.roles[h] === 'ignore' ? 'dv-mapper__off' : ''}>${String(r[j] ?? '').slice(0, 60)}</td>`)}</tr>`)}</tbody>
      </table>
    </div>
    <p class="basis">First rows of ${file.name || 'the table'}. Ignored columns are not read.</p>
  </div>`;
}

function toMapping(state) {
  const m = { namespace: 'csv' };
  const attrs = [];
  for (const [h, r] of Object.entries(state.roles)) {
    if (r === 'ignore') continue;
    if (r === 'attr') attrs.push(h); else m[r] = h;
  }
  if (state.kind === 'nodes' || state.kind === 'incidence') m.attrs = attrs;
  if (state.kind === 'incidence') { m.events = Object.entries(state.roles).filter(([, r]) => r === 'event').map(([h]) => h); delete m.event; }
  if (TWO_MODE.has(state.kind)) {
    m.modeLabels = (state.extra.modeLabels || []).map((l, k) => String(l || '').trim() || ['People', 'Events'][k]);
    if (state.kind === 'affiliations' && m.timestamp) { m.timeFormat = state.extra.timeFormat || 'iso'; m.timezone = state.extra.timezone || 'UTC'; }
  }
  if (state.kind === 'events') { m.timeFormat = state.extra.timeFormat || 'iso'; m.timezone = state.extra.timezone || 'UTC'; m.role = 'to'; m.eventType = 'message'; }
  if (state.kind === 'edges') { m.role = 'declared'; m.eventType = 'declared'; }
  if (state.extra.targetSeparator) m.targetSeparator = state.extra.targetSeparator;
  return m;
}
