// Joining a table of people (an HR export, a roster) to the people already in
// the data as attributes. Used in two places: the review after import (the
// table came in with the exports) and the "Join attributes" tab of loaded data.
//
// The match is previewed as soon as the table is read, with a guessed key
// column, so the first thing shown is "148 of 150 rows matched", not a form.

import { html, useState, useEffect, useRef } from '../../../../vendor/preact.js';
import { store } from '../../store.js';
import { Flag, Loading, ErrorLine, Select } from '../../components/common.js';
import { joinProfiles, readCSV } from '../../services/pipeline.js';
import { fmtInt } from '../../lib/format.js';
import { blobOf, pathOf } from './io.js';

const OTHER_PERSON = /(manager|supervisor|boss|reports.?to|mentor|approver)/i;

// Best key column: a unique email column, else an id, else a name (not a
// manager's), else the first.
export function guessKey(table) {
  const h = table.headers;
  const filled = c => table.records.filter(r => String(r[c] ?? '').trim()).length;
  const email = h.filter(c => /e-?mail/i.test(c) && !OTHER_PERSON.test(c)).sort((x, y) => filled(y) - filled(x))[0];
  const key = email || h.find(c => /^(id|employee_?id|person_?id|key)$/i.test(c)) || h.find(c => /name/i.test(c) && !OTHER_PERSON.test(c)) || h[0];
  return { keyColumn: key, matchOn: /e-?mail/i.test(key) ? 'email' : /name/i.test(key) ? 'name' : /^key$/i.test(key) ? 'key' : 'platformId' };
}

// Columns with no value in any row of the table.
export function emptyColumns(table) {
  return table.headers.filter(h => !table.records.some(r => String(r[h] ?? '').trim()));
}

export function rowsMatched(r) {
  const n = v => (Array.isArray(v) ? v.length : v || 0);
  return { matched: n(r.matched), unmatched: n(r.unmatchedRows ?? r.unmatched), ambiguous: n(r.ambiguous), noRow: n(r.unmatchedNodes ?? r.nodesWithoutRow) };
}

// Table settings + live preview. onChange({ table, opts, result }) whenever
// the preview is ready; `result.dataset` is the joined dataset.
export function JoinSetup({ ds, file, onChange }) {
  const [table, setTable] = useState(null);
  const [opts, setOpts] = useState(null);
  const [result, setResult] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setTable(null); setResult(null); setErr(null);
    readCSV(blobOf(file)).then(t => {
      if (!live) return;
      const g = guessKey(t);
      setTable(t);
      // Columns empty in every row start unticked (N18): adding them would
      // only list a column that holds nothing.
      const empty = new Set(emptyColumns(t));
      setOpts({ ...g, columns: t.headers.filter(h => h !== g.keyColumn && !empty.has(h)) });
    }, e => live && setErr(e));
    return () => { live = false; };
  }, [file]);
  useEffect(() => {
    if (!table || !opts) return;
    let live = true;
    joinProfiles(ds, table, opts).then(r => { if (live) { setResult(r); onChange?.({ table, opts, result: r }); } }, e => live && setErr(e));
    return () => { live = false; };
  }, [ds, table, opts]);
  if (err) return html`<${ErrorLine} error=${`Could not join ${pathOf(file)}: ${err.message || err}`} />`;
  if (!table || !opts) return html`<${Loading}>Reading ${pathOf(file)}</${Loading}>`;
  const r = result?.report;
  const c = r ? rowsMatched(r) : null;
  const rows = table.records.length;
  const blank = new Set(emptyColumns(table));
  const blankChosen = (r?.emptyColumns || []).filter(x => opts.columns.includes(x));
  return html`<div class="stack dv-join">
    ${c && html`<p class="dv-join__headline"><${Flag} level=${c.matched / (rows || 1) >= 0.8 ? 'ok' : 'caution'}>${fmtInt(c.matched)} of ${fmtInt(rows)} rows matched</${Flag}>
      <span class="small text2">${c.unmatched ? `${fmtInt(c.unmatched)} matched nobody` : 'every row found its person'}${c.ambiguous ? `, ${fmtInt(c.ambiguous)} matched several people and were left out` : ''}${c.noRow ? `; ${c.noRow === 1 ? '1 person' : `${fmtInt(c.noRow)} people`} in the data ${c.noRow === 1 ? 'has' : 'have'} no row` : ''}.</span></p>`}
    <div class="grid-2">
      <${Select} label="Column that identifies the person" value=${opts.keyColumn} onChange=${v => setOpts(o => ({ ...o, keyColumn: v, matchOn: /e-?mail/i.test(v) ? 'email' : /name/i.test(v) ? 'name' : o.matchOn, columns: o.columns.filter(x => x !== v) }))} options=${table.headers.map(h => ({ value: h, label: h }))} />
      <${Select} label="Match it against" value=${opts.matchOn} onChange=${v => setOpts(o => ({ ...o, matchOn: v }))} options=${[{ value: 'email', label: 'Email address' }, { value: 'name', label: 'Name' }, { value: 'platformId', label: 'Account id (Slack, Teams...)' }, { value: 'key', label: 'Record key' }]} />
    </div>
    <fieldset class="dv-fieldset"><legend class="label">Columns to add</legend>
      <div class="row">${table.headers.filter(h => h !== opts.keyColumn).map(h => html`<label class="check"><input type="checkbox" checked=${opts.columns.includes(h)} onChange=${e => { const on = e.currentTarget.checked; setOpts(o => ({ ...o, columns: on ? [...o.columns, h] : o.columns.filter(x => x !== h) })); }} />${h}${blank.has(h) ? html` <span class="muted">(empty)</span>` : ''}</label>`)}</div>
    </fieldset>
    ${blank.size > 0 && html`<p class="small text2"><${Flag} level="info">Empty</${Flag}> ${[...blank].join(', ')} ${blank.size === 1 ? 'has' : 'have'} no value in any row, so ${blank.size === 1 ? 'it is' : 'they are'} not added.</p>`}
    ${blankChosen.length > 0 && html`<p class="small text2"><${Flag} level="caution">No values</${Flag}> ${blankChosen.join(', ')} ${blankChosen.length === 1 ? 'has' : 'have'} no value for any matched person and will not be added.</p>`}
    ${r && Array.isArray(r.unmatchedRows) && r.unmatchedRows.length > 0 && html`<details class="disclose"><summary>Rows that matched nobody (${fmtInt(r.unmatchedRows.length)})</summary><p class="small text2">${r.unmatchedRows.slice(0, 30).map(u => u.key || '(empty)').join(', ')}${r.unmatchedRows.length > 30 ? ', ...' : ''}</p></details>`}
    ${r && Array.isArray(r.ambiguous) && r.ambiguous.length > 0 && html`<details class="disclose"><summary>Rows that matched several people (${fmtInt(r.ambiguous.length)})</summary><ul class="can-list">${r.ambiguous.slice(0, 20).map(a => html`<li>${a.key || a.node?.label}: ${a.reason}</li>`)}</ul></details>`}
  </div>`;
}

// "Join attributes" tab on loaded data.
export function ProfileJoin({ ds }) {
  const [file, setFile] = useState(null);
  const [state, setState] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const ref = useRef(null);
  useEffect(() => {
    const f = store.get().ui?.profileFile;
    if (f) { store.set({ ui: { ...store.get().ui, profileFile: null } }); setFile(f); }
  }, []);
  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      await store.actions.replaceDataset(state.result.dataset);
      const added = state.opts.columns.length - (state.result.report?.emptyColumns?.length || 0);
      store.actions.notify('info', `Joined ${added} ${added === 1 ? 'column' : 'columns'} from ${pathOf(file)}.`);
      setFile(null); setState(null);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  return html`<div class="stack">
    <p class="small text2 dv-measure">Add details such as department, role or office from an HR export or any table with one row per person. Rows are matched to people by email, account id or name; a row that matches several people is left out rather than guessed.</p>
    <div class="row"><button type="button" class="btn" onClick=${() => ref.current.click()}>Choose a table (CSV)</button>${file && html`<span class="meta">${pathOf(file)}</span>`}</div>
    <input type="file" accept=".csv,.tsv,.txt" hidden ref=${ref} onChange=${e => { const f = e.currentTarget.files[0]; if (f) { setFile(f); setState(null); } e.currentTarget.value = ''; }} />
    <${ErrorLine} error=${err} />
    ${file && html`<${JoinSetup} ds=${ds} file=${file} onChange=${setState} />`}
    ${file && html`<div class="row"><button type="button" class="tlink" onClick=${() => { setFile(null); setState(null); }}>Cancel</button><div class="grow"></div><button type="button" class="btn btn--primary" onClick=${apply} disabled=${busy || !state?.opts.columns.length}>Apply and rebuild</button></div>`}
  </div>`;
}
