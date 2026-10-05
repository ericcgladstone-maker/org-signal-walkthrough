// Construction settings drawer. Every rule that turns events into ties is a
// visible choice with an on/off switch and a weight, plus direction,
// weighting, thresholds, a time range (with the activity histogram behind
// it), visibility layers, media and bots. Rules with no evidence in the data
// are shown but disabled, with the reason. Applying rebuilds via the engine.

import { html, useState, useEffect, useRef, useMemo } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { Icon, Flag, Select, ErrorLine, Term } from '../components/common.js';
import { Histogram } from '../components/charts.js';
import { RULES, RULE_TEXT, ruleEvidence, sequencedMessages, activityHistogram, visibilityPresent, mediaPresent, botCount, timeExtent } from '../lib/dsutil.js';
import { fmtInt, isoDay, fmtDate } from '../lib/format.js';
import { RULE_LABEL } from '../actions.js';
import { inferEventAttributeSchema, twoModeOf } from '../../core/model.js';
import { viewOptions, projectionOptions, projectionSentence } from '../lib/twomode.js';

const ruleName = r => { const l = RULE_LABEL[r] || r; return l.charAt(0).toUpperCase() + l.slice(1); };
const MEDIA_TEXT = { chat: 'Chat', email: 'Email', meeting: 'Meetings', calendar: 'Calendar', social: 'Social media', survey: 'Surveys', sms: 'Text messages', forum: 'Forums', canvas: 'Drawn' };

// Why a rule has no evidence. Most rules need a kind of record the sources do
// not have; turn-taking is different: it is inferred from message order, and
// the engine only offers it when many messages in shared conversations are
// unaddressed (src/analysis/construct.js defaultSettings). Saying "none of the
// sources records this" for a Slack export was wrong (D10).
function noEvidenceReason(r, ds) {
  if (r === 'adjacency' && sequencedMessages(ds) > 0) {
    return 'Not derived for this data. Turn-taking is inferred from message order only where many messages in shared conversations are unaddressed (30% or more) or there are group chats; here most messages are replies, mentions or direct messages. Plain channel posts with no reply, mention or reaction create no tie.';
  }
  return 'None of the imported sources records this.';
}

const VIS_TEXT = { public: 'Public channels', private: 'Private channels', direct: 'Direct messages', group: 'Group chats and meetings', unknown: 'Unknown visibility' };

export function SettingsDrawer() {
  const ds = useStore(s => s.dataset);
  const current = useStore(s => s.settings);
  const [s, setS] = useState(() => structuredClone(current || {}));
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const panel = useRef(null);
  const lastFocus = useRef(document.activeElement);
  const evidence = useMemo(() => (ds ? ruleEvidence(ds) : {}), [ds]);
  const hist = useMemo(() => (ds ? activityHistogram(ds, 72) : null), [ds]);
  const vis = useMemo(() => (ds ? visibilityPresent(ds) : []), [ds]);
  const media = useMemo(() => (ds ? mediaPresent(ds) : []), [ds]);
  const bots = useMemo(() => (ds ? botCount(ds) : 0), [ds]);
  const [t0, t1] = useMemo(() => (ds ? timeExtent(ds) : [NaN, NaN]), [ds]);

  const close = () => { store.actions.closeDrawer(); setTimeout(() => lastFocus.current?.focus?.(), 0); };
  useEffect(() => {
    panel.current?.querySelector('h2')?.focus();
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Tab' && panel.current) {
        const f = [...panel.current.querySelectorAll('button,input,select,textarea,[tabindex]:not([tabindex="-1"])')].filter(x => !x.disabled && x.offsetParent !== null);
        if (!f.length) return;
        if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
        else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (!ds || !current) {
    return html`<div class="drawer-backdrop" onClick=${close}></div>
      <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-h" ref=${panel}>
        <div class="drawer__head"><h2 id="drawer-h" tabindex="-1">Construction settings</h2><button type="button" class="btn btn--quiet" onClick=${close} aria-label="Close">${Icon.close}</button></div>
        <div class="drawer__body"><p class="text2" style="padding-top:1rem">Load data first; the settings describe how its events become ties.</p></div>
      </aside>`;
  }

  const rule = (r) => s.rules?.[r] || { on: false, weight: 1 };
  const setRule = (r, patch) => setS(x => ({ ...x, rules: { ...x.rules, [r]: { ...rule(r), ...patch } } }));
  // Counted from the data now, not read from the settings: settings saved in
  // a project keep whatever count was current when they were made.
  const ev = (r) => evidence[r] ?? s.rules?.[r]?.evidence ?? 0;
  const toMs = (d) => (d ? Date.parse(`${d}T00:00:00Z`) : null);
  const visSel = new Set(s.visibility || vis);
  const mediaSel = s.media ? new Set(s.media) : null;

  const apply = async () => {
    setBusy(true); setErr(null);
    try { await store.actions.rebuild(s); close(); }
    catch (e) { if (e.name !== 'AbortError') setErr(e); } finally { setBusy(false); }
  };
  const reset = async () => setS(structuredClone(current));

  const rulesWith = RULES.filter(r => ev(r) > 0);
  const rulesWithout = RULES.filter(r => !(ev(r) > 0));

  return html`<div class="drawer-backdrop" onClick=${close}></div>
  <aside class="drawer" role="dialog" aria-modal="true" aria-labelledby="drawer-h" ref=${panel}>
    <div class="drawer__head">
      <h2 id="drawer-h" tabindex="-1">Construction settings</h2>
      <button type="button" class="btn btn--quiet" onClick=${close} aria-label="Close settings">${Icon.close}</button>
    </div>
    <div class="drawer__body">
      <p class="small text2" style="padding-top:.9rem">A tie between two people is built from the evidence below. Each rule is a methodological choice that can be enabled, disabled, or weighted; every tie can be traced to its events in the Network view.</p>

      ${s.twoMode && html`<${TwoModeSection} ds=${ds} s=${s} setS=${setS} />`}

      <div class="section" style=${s.twoMode ? '' : 'border-top:0'}>
        <p class="label">Rules with evidence in this data</p>
        ${rulesWith.map(r => html`<div class=${`rule-row${rule(r).on ? '' : ' rule-row--off'}`}>
          <label class="check"><input type="checkbox" checked=${!!rule(r).on} onChange=${e => setRule(r, { on: e.currentTarget.checked })} /><span style="color:var(--text)">${ruleName(r)}</span></label>
          <label class="field field--inline"><span class="visually-hidden">Weight for ${ruleName(r)}</span><input class="input tnum" type="number" min="0" step="0.1" value=${rule(r).weight} disabled=${!rule(r).on} onInput=${e => setRule(r, { weight: Math.max(0, Number(e.currentTarget.value) || 0) })} aria-label=${`Weight for ${ruleName(r)}`} /></label>
          <span class="rule-row__desc">${RULE_TEXT[r]} · ${fmtInt(ev(r))} ${ev(r) === 1 ? 'piece' : 'pieces'} of evidence</span>
          ${r === 'adjacency' && rule(r).on && html`<label class="field" style="grid-column:1/-1"><span>Only when the next message comes within (minutes)</span><input class="input tnum" type="number" min="1" value=${rule(r).windowMin ?? 10} onInput=${e => setRule(r, { windowMin: Number(e.currentTarget.value) || 10 })} style="max-width:7rem;text-align:left" /></label>`}
          ${r === 'copresence' && rule(r).on && html`<label class="check" style="grid-column:1/-1"><input type="checkbox" checked=${rule(r).normalize !== false} onChange=${e => setRule(r, { normalize: e.currentTarget.checked })} />Divide each meeting's weight by its size (a 2-person call counts more than a 30-person all-hands)</label>`}
        </div>`)}
        ${!rulesWith.length && html`<p class="small text2">No construction evidence was found in this data.</p>`}
        ${rulesWithout.length > 0 && html`<details class="disclose"><summary>Rules with no evidence here (${rulesWithout.length})</summary>
          <ul class="can-list">${rulesWithout.map(r => html`<li><span style="color:var(--text)">${ruleName(r)}</span> (${RULE_TEXT[r]}). ${noEvidenceReason(r, ds)}</li>`)}</ul></details>`}
      </div>

      <div class="section">
        <p class="label">Ties</p>
        <div class="grid-2" style="gap:.75rem 1rem">
          <${Select} label="Direction" disabled=${!!s.twoMode} value=${s.directed && !s.twoMode ? 'directed' : 'undirected'} onChange=${v => setS(x => ({ ...x, directed: v === 'directed' }))} options=${[{ value: 'directed', label: 'Directed (A to B)' }, { value: 'undirected', label: 'Undirected' }]} />
          <${Select} label="Tie weight" value=${s.weighting || 'count'} onChange=${v => setS(x => ({ ...x, weighting: v }))} options=${[{ value: 'count', label: 'Count of evidence' }, { value: 'log', label: 'Log of count' }, { value: 'binary', label: 'Present or absent' }]} />
          <label class="field"><span>Minimum tie weight</span><input class="input tnum" type="number" min="0" step="0.5" value=${s.minWeight ?? 0} onInput=${e => setS(x => ({ ...x, minWeight: Math.max(0, Number(e.currentTarget.value) || 0) }))} /></label>
          <label class="field"><span>Broadcast cutoff (recipients)</span><input class="input tnum" type="number" min="0" value=${s.maxRecipients ?? 25} onInput=${e => setS(x => ({ ...x, maxRecipients: Math.max(0, Number(e.currentTarget.value) || 0) }))} /></label>
        </div>
        <p class="basis">${s.twoMode ? 'Two-mode data is always undirected: belonging to a group or attending an event has no direction. ' : ''}Messages addressed to more people than the cutoff are treated as broadcasts and create no ties. 0 means no cutoff.</p>
        <label class="check" style="margin-top:.6rem"><input type="checkbox" checked=${s.includeIsolates !== false} onChange=${e => setS(x => ({ ...x, includeIsolates: e.currentTarget.checked }))} />Keep people with no ties (isolates)</label>
      </div>

      <div class="section">
        <p class="label">Time range</p>
        <${Histogram} hist=${hist} range=${[s.time?.start ?? null, s.time?.end ?? null]} label="Events over time; the shaded range is included" />
        <div class="grid-2" style="gap:.75rem 1rem;margin-top:.6rem">
          <label class="field"><span>From</span><input class="input" type="date" min=${isoDay(t0)} max=${isoDay(t1)} value=${isoDay(s.time?.start)} onInput=${e => setS(x => ({ ...x, time: { ...x.time, start: toMs(e.currentTarget.value) } }))} /></label>
          <label class="field"><span>Until (exclusive)</span><input class="input" type="date" min=${isoDay(t0)} max=${isoDay(t1 + 864e5)} value=${isoDay(s.time?.end)} onInput=${e => setS(x => ({ ...x, time: { ...x.time, end: toMs(e.currentTarget.value) } }))} /></label>
        </div>
        <p class="basis">${Number.isFinite(t0) ? `Data runs ${fmtDate(t0)} to ${fmtDate(t1)}. Leave empty for everything. Events without a time are dropped when a range is set.` : 'This data has no timestamps.'}</p>
      </div>

      <div class="section">
        <p class="label">Visibility layers</p>
        ${vis.map(v => html`<label class="check" style="display:flex"><input type="checkbox" checked=${visSel.has(v)} onChange=${e => { const n = new Set(visSel); if (e.currentTarget.checked) n.add(v); else n.delete(v); setS(x => ({ ...x, visibility: [...n] })); }} />${VIS_TEXT[v] || v}</label>`)}
      </div>

      ${media.length > 1 && html`<div class="section">
        <p class="label">Media</p>
        ${media.map(m => html`<label class="check" style="display:flex"><input type="checkbox" checked=${!mediaSel || mediaSel.has(m)} onChange=${e => { const n = new Set(mediaSel || media); if (e.currentTarget.checked) n.add(m); else n.delete(m); setS(x => ({ ...x, media: n.size === media.length ? null : [...n] })); }} />${MEDIA_TEXT[m] || m}</label>`)}
      </div>`}

      <${TieFieldsSection} ds=${ds} s=${s} setS=${setS} />

      <div class="section">
        <p class="label">Bots</p>
        <label class="check"><input type="checkbox" checked=${!!s.excludeBots} onChange=${e => setS(x => ({ ...x, excludeBots: e.currentTarget.checked }))} />Leave out accounts marked as bots</label>
        <p class="basis">${bots ? `${fmtInt(bots)} ${bots === 1 ? 'account is' : 'accounts are'} marked as bots in this data.` : 'No account is marked as a bot.'}</p>
      </div>
      <${ErrorLine} error=${err} />
    </div>
    <div class="drawer__foot">
      <button type="button" class="tlink tlink--quiet" onClick=${reset}>Undo changes</button>
      <button type="button" class="tlink tlink--quiet" onClick=${close}>Close</button>
      <button type="button" class="btn btn--primary" onClick=${apply} disabled=${busy}>${busy ? 'Rebuilding' : 'Apply and rebuild'}</button>
    </div>
  </aside>`;
}

// Tie fields (survey tie type, strength, how often, reported as ...): take
// the tie amount from a numeric or ordered field, and keep only ties whose
// fields match (settings.tieFields, see src/analysis/construct.js). Shown only
// when the data has tie fields.
function TieFieldsSection({ ds, s, setS }) {
  const schema = useMemo(() => ds.eventAttributeSchema || inferEventAttributeSchema(ds), [ds]);
  if (!schema.length) return null;
  const tf = s.tieFields || { weight: null, filters: [] };
  const filters = tf.filters || [];
  const setTf = patch => setS(x => ({ ...x, tieFields: { weight: null, filters: [], ...(x.tieFields || {}), ...patch } }));
  const filterFor = key => filters.find(f => f.key === key);
  const setFilter = (key, f) => setTf({ filters: [...filters.filter(x => x.key !== key), ...(f ? [{ key, ...f }] : [])] });
  const weighable = schema.filter(f => f.type === 'numeric' || (f.type === 'categorical' && f.ordered));
  const choices = schema.filter(f => f.type === 'categorical' && f.values?.length && f.values.length <= 40);
  const numbers = schema.filter(f => f.type === 'numeric');
  return html`<div class="section">
    <p class="label">Tie fields</p>
    <p class="small text2">Qualities recorded on each tie in this data (${schema.map(f => f.label).join(', ')}). Filters apply only to sources that record the field.</p>
    ${weighable.length > 0 && html`<${Select} label="Tie amount from" value=${tf.weight || ''} onChange=${v => setTf({ weight: v || null })}
      options=${[{ value: '', label: 'The tie value as recorded' }, ...weighable.map(f => ({ value: f.key, label: f.type === 'numeric' ? f.label : `${f.label} (position in its list)` }))]} />`}
    ${choices.map(f => {
      const cur = filterFor(f.key);
      const sel = new Set(cur?.values || f.values);
      const toggle = (v, on) => {
        const n = new Set(sel); if (on) n.add(v); else n.delete(v);
        const all = f.values.every(x => n.has(x)), keep = cur ? cur.keepMissing !== false : true;
        // Everything ticked, blanks included, is no filter at all.
        setFilter(f.key, all && keep ? null : { values: [...n], keepMissing: keep });
      };
      return html`<fieldset class="tf-group" style="border:0;padding:0;margin:.75rem 0 0">
        <legend class="small" style="color:var(--text)">Keep ties whose ${f.label.toLowerCase()} is</legend>
        ${f.values.map(v => html`<label class="check" style="display:flex"><input type="checkbox" checked=${sel.has(v)} onChange=${e => toggle(v, e.currentTarget.checked)} />${v}</label>`)}
        <label class="check" style="display:flex"><input type="checkbox" checked=${cur ? cur.keepMissing !== false : true}
          onChange=${e => { const keep = e.currentTarget.checked; const vals = cur?.values || f.values; setFilter(f.key, keep && vals.length === f.values.length ? null : { values: [...vals], keepMissing: keep }); }} /><span class="text2">Not recorded</span></label>
      </fieldset>`;
    })}
    ${numbers.length > 0 && html`<div class="grid-2" style="gap:.75rem 1rem;margin-top:.75rem">
      ${numbers.map(f => { const cur = filterFor(f.key); return html`<label class="field"><span>Keep ties with ${f.label.toLowerCase()} at least</span>
        <input class="input tnum" type="number" step="any" placeholder="any" value=${cur && Number.isFinite(cur.min) ? cur.min : ''}
          onInput=${e => { const v = e.currentTarget.value; setFilter(f.key, v === '' ? null : { min: Number(v), keepMissing: false }); }} /></label>`; })}
    </div>`}
    <p class="basis">A filter drops the events whose field does not match; a tie with no evidence left disappears. "Not recorded" keeps ties where the field was left blank.</p>
  </div>`;
}

// Two-mode (affiliation) data: build the two-mode network itself, or one of
// its one-mode projections, with the projection's weighting and a minimum
// number shared (settings.twoMode, src/analysis/construct.js).
function TwoModeSection({ ds, s, setS }) {
  const labels = useStore(st => st.network?.twoMode?.labels) || twoModeOf(ds)?.labels || ['Actors', 'Events'];
  const tm = s.twoMode;
  const set = patch => setS(x => ({ ...x, twoMode: { ...x.twoMode, ...patch } }));
  const views = viewOptions(labels);
  const basis = tm.view === 'mode1' ? 1 : 0;
  const projected = tm.view === 'mode0' || tm.view === 'mode1';
  const sentence = projected ? projectionSentence({ ...tm, labels, basis }) : null;
  return html`<div class="section twomode-sec" style="border-top:0">
    <p class="label">Two-mode</p>
    <p class="small text2">This is <${Term} k="twoMode">two-mode</${Term}> data: ${labels[0].toLowerCase()} tied to the ${labels[1].toLowerCase()} they belong to or attend (<${Term} k="affiliation">affiliations</${Term}>). Analyze it as it is, or as a <${Term} k="projection">projection</${Term}> onto one kind.</p>
    <fieldset class="radios" style="margin-top:.5rem">
      <legend>Network to analyze</legend>
      ${views.map(o => html`<label class="radio"><input type="radio" name="tm-view" value=${o.value} checked=${tm.view === o.value} onChange=${() => set({ view: o.value })} /><span>${o.label}</span><span class="radio__desc">${o.desc}</span></label>`)}
    </fieldset>
    ${projected ? html`<fieldset class="radios" style="margin-top:.6rem">
        <legend>Projected tie weight</legend>
        ${projectionOptions(labels, basis).map(o => html`<label class="radio"><input type="radio" name="tm-proj" value=${o.value} checked=${(tm.projection || 'count') === o.value} onChange=${() => set({ projection: o.value })} /><span>${o.label}</span><span class="radio__desc">${o.desc}</span></label>`)}
      </fieldset>
      <label class="field" style="margin-top:.5rem;max-width:16rem"><span>Minimum number shared</span><input class="input tnum" type="number" min="1" step="1" value=${tm.minShared ?? 1} onInput=${e => set({ minShared: Math.max(1, Math.floor(Number(e.currentTarget.value) || 1)) })} /></label>
      <p class="basis">${sentence} Every shared one makes a clique, which inflates clustering and constraint in a projection.</p>`
      : html`<p class="basis">Measures on the two-mode network use the <${Term} k="borgattiEverett">Borgatti-Everett normalization</${Term}>: each node is scored against what is possible for its kind. Clustering, density and Burt's measures for one-mode networks do not apply and are hidden.</p>`}
  </div>`;
}
