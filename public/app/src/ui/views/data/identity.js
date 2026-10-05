// Who is who: the owners of personal exports ("Are these all you?"), merge
// suggestions with their evidence, a manual "Same person as..." merge that is
// always available, and the log of merges already applied.
//
// Everything here only collects pairs; merging is applyMerges, run when the
// data is loaded (review) or on "Merge and rebuild" (loaded data).

import { html, useState, useEffect, useMemo } from '../../../../vendor/preact.js';
import { store } from '../../store.js';
import { Flag, Loading, ErrorLine } from '../../components/common.js';
import { suggestMatches, applyMerges } from '../../services/pipeline.js';
import { fmtInt, plural } from '../../lib/format.js';

// Distinct owners named by the sources ({ key, label, sources: [labels] }).
// Several chats from one phone usually share one owner, so they appear once.
export function ownersOf(ds, report) {
  const byKey = new Map();
  const idx = new Map(ds.nodes.keys.map((k, i) => [k, i]));
  for (const s of report?.sources || []) {
    const k = s.ego?.key;
    if (!k || !idx.has(k)) continue;
    if (!byKey.has(k)) byKey.set(k, { key: k, label: ds.nodes.labels[idx.get(k)], sources: new Map() });
    const src = byKey.get(k).sources;
    src.set(s.label, (src.get(s.label) || 0) + 1);
  }
  return [...byKey.values()].map(o => ({ ...o, sources: [...o.sources].map(([l, n]) => (n > 1 ? `${n} ${l} ${l === 'WhatsApp' || l === 'Telegram' ? 'chats' : 'sources'}` : l)) }));
}

// Pairs that merge the checked owners into the first checked one.
export function ownerPairs(owners, checked) {
  const keep = owners.filter(o => checked.has(o.key));
  return keep.slice(1).map(o => ({ keyA: keep[0].key, keyB: o.key, confidence: 'manual', evidence: ['owners of personal exports, confirmed as one person'] }));
}

export function Owners({ owners, checked, onToggle }) {
  const n = owners.filter(o => checked.has(o.key)).length;
  return html`<section class="dv-owners" aria-labelledby="own-h">
    <h3 id="own-h" class="dv-h3">Are these all you?</h3>
    <p class="small text2">Each personal export names its owner. If they are all you, they become one person, so your contacts from every app connect through you. Untick anyone who is someone else.</p>
    <ul class="dv-owners__list">${owners.map(o => html`<li><label class="check"><input type="checkbox" checked=${checked.has(o.key)} onChange=${e => onToggle(o.key, e.currentTarget.checked)} />
      <span><span class="dv-strong">${o.label}</span> <span class="text2">owner of ${o.sources.join(', ')}</span></span></label></li>`)}</ul>
    <p class="meta">${n >= 2 ? `${n} owners will be merged into one person` : 'No owners will be merged'}</p>
  </section>`;
}

const CONF = { high: ['ok', 'High'], medium: ['info', 'Medium'], low: ['caution', 'Low'], manual: ['ok', 'Yours'] };

export function MatchList({ matches, accepted, onToggle, onAll }) {
  const [all, setAll] = useState(false);
  if (matches == null) return html`<p class="small text2">Identity matching is not available in this build.</p>`;
  if (!matches.length) return html`<p class="small text2">No likely duplicates were found: no two people share an email address, phone number, account id or full name across sources. If you know two records are one person, use "Same person as" below.</p>`;
  const shown = all ? matches : matches.slice(0, 25);
  return html`<div>
    <p class="small text2 dv-p">The same person can appear once per source (a Slack account and an email address). These pairs look like one person. High-confidence pairs are ticked; nothing is merged until you load.</p>
    <div class="row dv-p"><button type="button" class="tlink" onClick=${() => onAll(true)}>Tick all</button><button type="button" class="tlink" onClick=${() => onAll(false)}>Untick all</button><span class="meta">${fmtInt(accepted.size)} of ${fmtInt(matches.length)} ticked</span></div>
    <div class="table-wrap"><table class="tbl dv-matches">
      <thead><tr><th scope="col">Merge</th><th scope="col">Person A</th><th scope="col">Person B</th><th scope="col">Confidence</th><th scope="col">Evidence</th></tr></thead>
      <tbody>${shown.map((m, i) => html`<tr class=${accepted.has(i) ? 'is-selected' : ''}>
        <td><input type="checkbox" aria-label=${`Merge ${m.labelA ?? m.a} and ${m.labelB ?? m.b}`} checked=${accepted.has(i)} onChange=${e => onToggle(i, e.currentTarget.checked)} /></td>
        <td class="name">${m.labelA ?? m.a}<div class="meta">${m.keyA ?? ''}</div></td>
        <td class="name">${m.labelB ?? m.b}<div class="meta">${m.keyB ?? ''}</div></td>
        <td>${CONF[m.confidence] ? html`<${Flag} level=${CONF[m.confidence][0]}>${CONF[m.confidence][1]}</${Flag}>` : (m.score != null ? `${Math.round(m.score * 100)}%` : '')}</td>
        <td class="small">${(m.evidence || []).join('; ')}</td>
      </tr>`)}</tbody>
    </table></div>
    ${matches.length > shown.length && html`<p class="basis"><button type="button" class="tlink" onClick=${() => setAll(true)}>Show all ${fmtInt(matches.length)} pairs</button></p>`}
  </div>`;
}

// "Same person as...": pick two people by name. Always available, because
// matching cannot see that "Jae" on WhatsApp is "Jae Guerrero" on LinkedIn.
export function ManualMerge({ ds, pairs, onAdd, onRemove }) {
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [msg, setMsg] = useState(null);
  const listId = useMemo(() => `dv-people-${Math.random().toString(36).slice(2, 7)}`, []);
  // "Label (key)" is unique even when labels repeat.
  const entries = useMemo(() => ds.nodes.keys.map((k, i) => [`${ds.nodes.labels[i]} (${k})`, i]), [ds]);
  const index = useMemo(() => new Map(entries), [entries]);
  const find = v => index.get(v.trim()) ?? (() => {
    const hits = entries.filter(([s]) => s.toLowerCase().startsWith(v.trim().toLowerCase()));
    return hits.length === 1 ? hits[0][1] : undefined;
  })();
  const add = () => {
    const i = find(a), j = find(b);
    if (i === undefined || j === undefined) { setMsg('Pick both people from the list (type a few letters to search).'); return; }
    if (i === j) { setMsg('That is the same record twice.'); return; }
    onAdd({ a: i, b: j, keyA: ds.nodes.keys[i], keyB: ds.nodes.keys[j], labelA: ds.nodes.labels[i], labelB: ds.nodes.labels[j], confidence: 'manual', evidence: ['merged by hand'] });
    setA(''); setB(''); setMsg(null);
  };
  return html`<div class="dv-manual">
    <h3 class="dv-h3">Same person as...</h3>
    <p class="small text2">Merge two records you know are one person.</p>
    <datalist id=${listId}>${entries.slice(0, 20000).map(([s]) => html`<option value=${s} />`)}</datalist>
    <div class="row dv-manual__row">
      <label class="field grow"><span>Person</span><input class="input" list=${listId} value=${a} onInput=${e => setA(e.currentTarget.value)} placeholder="Type a name" /></label>
      <label class="field grow"><span>is the same person as</span><input class="input" list=${listId} value=${b} onInput=${e => setB(e.currentTarget.value)} placeholder="Type a name" /></label>
      <button type="button" class="tlink dv-manual__add" onClick=${add}>Add this merge</button>
    </div>
    ${msg && html`<p class="small" role="status"><${Flag} level="caution" /> ${msg}</p>`}
    ${pairs.length > 0 && html`<ul class="dv-manual__list">${pairs.map((p, k) => html`<li><span>${p.labelA} <span class="meta">${p.keyA}</span> = ${p.labelB} <span class="meta">${p.keyB}</span></span><button type="button" class="tlink" onClick=${() => onRemove(k)} aria-label=${`Do not merge ${p.labelA} and ${p.labelB}`}>Undo</button></li>`)}</ul>`}
  </div>`;
}

export function MergeLog({ ds }) {
  const merges = ds.meta.merges || [];
  if (!merges.length) return null;
  const groups = merges.flatMap(m => m.groups.map(g => ({ ...g, at: m.at })));
  return html`<details class="disclose dv-log"><summary>Merges already applied (${fmtInt(groups.length)})</summary>
    <ul class="can-list">${groups.slice(0, 200).map(g => html`<li>${g.labels.join(' = ')} <span class="meta">${[g.into, ...g.from].join(', ')}</span>${g.conflicts?.length ? html` <span class="text2">(${plural(g.conflicts.length, 'differing value')} kept from the first)</span>` : ''}</li>`)}</ul>
    ${groups.length > 200 && html`<p class="basis">Showing 200 of ${fmtInt(groups.length)}.</p>`}
  </details>`;
}

// Loaded data: suggestions, manual merges and the log, then "Merge and rebuild".
export function IdentityPanel({ ds }) {
  const [matches, setMatches] = useState(undefined);
  const [accepted, setAccepted] = useState(new Set());
  const [manual, setManual] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  useEffect(() => {
    let live = true;
    setMatches(undefined); setManual([]);
    suggestMatches(ds).then(m => { if (live) { setMatches(m); setAccepted(new Set((m || []).map((x, i) => (x.confidence === 'high' ? i : -1)).filter(i => i >= 0))); } }, e => live && setErr(e));
    return () => { live = false; };
  }, [ds]);
  const n = accepted.size + manual.length;
  const apply = async () => {
    setBusy(true); setErr(null);
    try {
      const ds2 = await applyMerges(ds, [...(matches || []).filter((_, i) => accepted.has(i)), ...manual]);
      await store.actions.replaceDataset(ds2);
      store.actions.notify('info', `Merged ${plural(n, 'pair')}. ${plural(ds2.nodes.count, 'person', 'people')} now.`);
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  if (err) return html`<${ErrorLine} error=${err} />`;
  if (matches === undefined) return html`<${Loading}>Looking for duplicate identities</${Loading}>`;
  return html`<div class="stack">
    <${MergeLog} ds=${ds} />
    <${MatchList} matches=${matches} accepted=${accepted} onToggle=${(i, v) => setAccepted(p => { const s = new Set(p); if (v) s.add(i); else s.delete(i); return s; })} onAll=${v => setAccepted(new Set(v ? (matches || []).map((_, i) => i) : []))} />
    <${ManualMerge} ds=${ds} pairs=${manual} onAdd=${p => setManual(m => [...m, p])} onRemove=${k => setManual(m => m.filter((_, j) => j !== k))} />
    <div class="row"><div class="grow"></div><button type="button" class="btn btn--primary" disabled=${busy || !n} onClick=${apply}>${n ? `Merge ${fmtInt(n)} and rebuild` : 'Merge and rebuild'}</button></div>
  </div>`;
}
