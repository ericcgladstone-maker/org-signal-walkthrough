// Small shared pieces: tooltips, metric names with their glossary,
// applicability flags, loading and error lines, downloads, and the hooks
// views use to ask the engine for results tied to the current network.

import { html, useState, useEffect, useRef, useCallback, useLayoutEffect } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { gloss } from '../services/glossary.js';
import { GLOSSARY, GLOSSARY_ALIASES } from '../../analysis/glossary.js';
import { EVENT_TYPES } from '../../core/model.js';
import { VIEWS, viewInfo } from '../actions.js';

// ---- icons (simple strokes, no emoji) -------------------------------------
export const Icon = {
  caution: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2 L14.5 13.5 H1.5 Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M8 6.5 V9.5" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="11.6" r=".8" fill="currentColor"/></svg>`,
  na: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.8 12.2 L12.2 3.8" stroke="currentColor" stroke-width="1.4"/></svg>`,
  error: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 5.5 L10.5 10.5 M10.5 5.5 L5.5 10.5" stroke="currentColor" stroke-width="1.4"/></svg>`,
  ok: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8.5 L6.5 12 L13 4.5" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`,
  info: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 7 V11.5" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="4.8" r=".8" fill="currentColor"/></svg>`,
  close: html`<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M3.5 3.5 L12.5 12.5 M12.5 3.5 L3.5 12.5" stroke="currentColor" stroke-width="1.5"/></svg>`,
  sortAsc: html`<svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1 7 L5 2.5 L9 7" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
  sortDesc: html`<svg viewBox="0 0 10 10" width="8" height="8" aria-hidden="true"><path d="M1 3 L5 7.5 L9 3" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>`,
};

// A status flag: icon plus a word, never color alone. With `reason`, the
// flag is a button that shows the reason on click, tap or Enter (C8): a
// CAUTION marker always carries why.
export function Flag({ level, children, reason = '', iconOnly = false }) {
  const lvl = level === 'warn' ? 'caution' : level;
  const icon = Icon[lvl] || Icon.info;
  const text = children ?? ({ caution: 'Caution', na: 'Not applicable', error: 'Error', ok: 'OK', info: 'Note', note: 'Note' })[lvl];
  if (!reason) {
    if (iconOnly) return html`<span class=${`flag flag--${lvl}`} role="img" aria-label=${text}>${icon}</span>`;
    return html`<span class=${`flag flag--${lvl}`}>${icon}<span>${text}</span></span>`;
  }
  return html`<${Pop} className=${`flag flag--${lvl} flag--btn`} label=${`${text}: why`} trigger=${iconOnly ? icon : html`${icon}<span>${text}</span>`}>
    <strong>${typeof text === 'string' ? text.charAt(0).toUpperCase() + text.slice(1) : text}</strong><span class="pop__p">${reason}</span>
  </${Pop}>`;
}

// ---- dismissable popovers (M10) ----------------------------------------------
// Every popover in the app closes on a click or tap outside it and on Escape,
// and Escape returns focus to the control that opened it. `refs` are the
// elements that count as inside (the trigger and the popover).
export function useDismiss(open, onClose, refs) {
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const inside = t => refs.some(r => r?.current && r.current.contains(t));
    const onKey = e => { if (e.key === 'Escape') close.current('escape'); };
    const onDown = e => { if (!inside(e.target)) close.current('outside'); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, [open]);
}

// The same for a <details> used as a menu (People > Columns): pass a ref to
// the <details>; it closes on an outside click or Escape, and Escape puts
// focus back on its <summary>.
export function useDetailsDismiss(ref) {
  useEffect(() => {
    const onKey = e => {
      const d = ref.current;
      if (e.key !== 'Escape' || !d?.open) return;
      d.open = false;
      d.querySelector('summary')?.focus();
    };
    const onDown = e => { const d = ref.current; if (d?.open && !d.contains(e.target)) d.open = false; };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('pointerdown', onDown, true); };
  }, []);
}

// Fixed position under (or above) an anchor, clamped inside the viewport so
// a popover never causes horizontal scroll on a phone.
function usePlacement(open, anchor, pop) {
  const [pos, setPos] = useState(null);
  useLayoutEffect(() => {
    if (!open) { if (pos) setPos(null); return; }
    if (!anchor.current || !pop.current) return;
    const r = anchor.current.getBoundingClientRect();
    const t = pop.current.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const left = Math.round(Math.max(8, Math.min(r.left, vw - t.width - 8)));
    let top = r.bottom + 6;
    if (top + t.height > window.innerHeight - 8) top = Math.max(8, r.top - t.height - 6);
    top = Math.round(top);
    if (!pos || pos.left !== left || pos.top !== top) setPos({ left, top });
  });
  return pos ? `left:${pos.left}px;top:${pos.top}px` : 'left:-9999px;top:0;visibility:hidden';
}

let popSeq = 0;

// Click-to-open popover: the shared base of Term and reasoned flags. Opens on
// click, tap, Enter or Space (a button), closes on outside click, Escape, or
// a second click. Content can hold links.
export function Pop({ trigger, label, className = '', children, wide = false }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const box = useRef(null);
  const id = useRef(`pop-${++popSeq}`).current;
  useDismiss(open, why => { setOpen(false); if (why === 'escape') btn.current?.focus(); }, [btn, box]);
  // Follow the anchor while the page scrolls; a resize closes it.
  const [, bump] = useState(0);
  useEffect(() => {
    if (!open) return;
    const off = () => setOpen(false);
    const follow = () => bump(x => x + 1);
    window.addEventListener('resize', off);
    window.addEventListener('scroll', follow, { passive: true, capture: true });
    return () => { window.removeEventListener('resize', off); window.removeEventListener('scroll', follow, { capture: true }); };
  }, [open]);
  const style = usePlacement(open, btn, box);
  return html`<span class="pop-wrap"><button type="button" class=${`pop-trigger ${className}`} ref=${btn} aria-expanded=${String(open)} aria-controls=${id} aria-label=${label}
      onClick=${e => { e.stopPropagation(); setOpen(o => !o); }}>${trigger}</button>${open && html`<span class=${`pop${wide ? ' pop--wide' : ''}`} id=${id} role="dialog" aria-label=${label} ref=${box} style=${style}
      onClick=${e => { if (e.target.closest('a')) setOpen(false); }}>${children}</span>`}</span>`;
}

// ---- tooltip --------------------------------------------------------------
// Shown on hover and on keyboard focus, and pinned open by a click or tap so
// touch readers get it too (C8, L17); closes on an outside click or Escape.
// Positioned in the viewport so it never causes horizontal scroll.
export function Tip({ content, children, label, className = '' }) {
  const [hover, setHover] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef(null);
  const tipRef = useRef(null);
  const id = useRef(`tip-${Math.random().toString(36).slice(2, 9)}`).current;
  const open = hover || pinned;
  useDismiss(open, () => { setHover(false); setPinned(false); }, [ref]);
  const style = usePlacement(open, ref, tipRef);
  return html`<span class=${`tip-wrap ${className}`} ref=${ref}
      onMouseEnter=${() => setHover(true)} onMouseLeave=${() => setHover(false)}>
    <button type="button" class="tip-trigger" aria-describedby=${open ? id : undefined} aria-label=${label} aria-expanded=${String(open)}
      onClick=${e => { e.stopPropagation(); setPinned(p => !(p && open)); if (pinned) setHover(false); }}
      onFocus=${() => setHover(true)} onBlur=${() => { if (!pinned) setHover(false); }}>${children}</button>
    ${open && html`<span role="tooltip" id=${id} class="tip" ref=${tipRef} style=${`${style};max-width:min(22rem,calc(100vw - 16px));text-align:left;white-space:normal;display:block`}>${content}</span>`}
  </span>`;
}

// The engine's "Very small network" reason is shown in the audit's wording
// (SMALL_NETWORK_NOTE) wherever a reason is printed.
export function applicabilityReason(a) {
  if (!a) return '';
  const list = Array.isArray(a.reasons) ? a.reasons : a.reason ? [a.reason] : [];
  return list.map(r => (SMALL.test(r) ? SMALL_NETWORK_NOTE : r)).join(' ');
}

// "Very small network" applies to every measure of a tiny network, so it is
// said once, calmly, rather than as a CAUTION on each measure (M7). The
// remaining reasons decide the flag.
const SMALL = /^Very small network/i;
export const SMALL_NETWORK_NOTE = 'Small network. Individual ties have substantial leverage on many measures. Comparisons across networks should therefore be interpreted cautiously.';
export function applicabilityView(ap) {
  const level = ap?.level || 'ok';
  const reasons = Array.isArray(ap?.reasons) ? ap.reasons : ap?.reason ? [ap.reason] : [];
  const small = reasons.some(r => SMALL.test(r));
  const rest = reasons.filter(r => !SMALL.test(r));
  if (level === 'caution' && small && !rest.length) return { level: 'ok', reason: '', small };
  return { level, reason: rest.join(' '), small };
}

// ---- reliability notes filtered by context (L17) ---------------------------
// Glossary reliability notes cover every kind of data. Show only the clauses
// that can apply here: no "above 3,000 people" on a 6-person drawing, no
// broadcast cutoff or resampling for hand-entered ties, no one-person-export
// caveat when no source is one person's export.
const DECLARED = EVENT_TYPES.indexOf('declared');
const ctxCache = new WeakMap();
export function dataContext(ds, net) {
  if (!ds) return { n: net?.n ?? null, declaredOnly: false, ego: false, directed: !!net?.directed };
  let c = ctxCache.get(ds);
  if (!c) {
    const type = ds.events?.type;
    let declaredOnly = !!type && type.length > 0;
    if (type) for (let i = 0; i < type.length; i++) if (type[i] !== DECLARED) { declaredOnly = false; break; }
    const ego = (ds.meta?.sources || []).some(s => s.view === 'ego');
    c = { declaredOnly, ego };
    ctxCache.set(ds, c);
  }
  return { ...c, n: net?.n ?? ds.nodes?.count ?? null, directed: !!net?.directed };
}

const CLAUSE_RULES = [
  // [pattern, keep(ctx)]
  [/above 3,000 people|Spearman|exact values before naming|sampled from 500 sources|sampled sources/i, c => !(c.n != null && c.n <= 3000)],
  [/rank interval from resampling|resampl/i, c => !c.declaredOnly],
  [/one person'?s export|ego exports|in one person/i, c => c.ego],
  [/construction rules|broadcast cutoff/i, c => !c.declaredOnly],
];
export function reliabilityFor(text, ctx) {
  if (!text || !ctx) return text || '';
  // Clauses end at ". " or "; " before the next one.
  const parts = String(text).split(/(?<=[.;])\s+/);
  const kept = parts.filter(p => CLAUSE_RULES.every(([re, keep]) => !re.test(p) || keep(ctx)));
  let out = kept.join(' ').trim();
  if (!out) return '';
  out = out.replace(/;$/, '.');
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

function useDataContext() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  return dataContext(ds, net);
}

// Metric name with its glossary meaning, reliability note and applicability.
// `label` overrides the glossary name (degree on a directed network reads
// "Total ties (in + out)"); `gloss` adds the plain one-line meaning under the
// name, for rows of measures (shown, not only on hover). The plain meaning
// comes first, then the caveats that apply to this data (M7, L17).
function metricTip(g, label, ap, ctx) {
  const v = applicabilityView(ap);
  const rel = reliabilityFor(g.reliability, ctx);
  return html`<strong>${label}</strong><p>${g.meaning}</p>${v.level !== 'ok' && html`<p><${Flag} level=${v.level} /> ${v.reason}</p>`}${v.small && html`<p class="tip__rel">${SMALL_NETWORK_NOTE}</p>`}${rel && html`<p class="tip__rel">Reliability: ${rel}</p>`}`;
}

// A caller-supplied extra paragraph for a measure's tooltip, such as the
// formula in plain words for this network's size and direction.
function withNote(content, note) {
  return note ? html`${content}<p class="tip__note">${note}</p>` : content;
}

export function MetricName({ metric, short = false, showFlag = true, iconOnly = false, label = null, gloss: showGloss = false, note = null }) {
  const ap = useStore(s => s.applicability?.[metric]);
  const ctx = useDataContext();
  const g = gloss(metric);
  const name = label || g.label;
  const v = applicabilityView(ap);
  const content = withNote(metricTip(g, name, ap, ctx), note);
  const flag = showFlag && v.level !== 'ok' && html` <${Flag} level=${v.level} reason=${v.reason || applicabilityReason(ap)} iconOnly=${iconOnly}>${v.level === 'na' ? 'n/a' : 'caution'}</${Flag}>`;
  const main = html`<span class=${iconOnly ? '' : 'nowrap'}><${Tip} content=${content} label=${`${name}: what it means`}>${short ? name.split(' (')[0] : name}</${Tip}>${flag}</span>`;
  // The always-shown gloss rows stay on regardless of the Interpretive notes switch (decision 3).
  if (!showGloss || !g.meaning) return main;
  return html`<span class="metric-name">${main}<span class="metric-name__gloss">${g.meaning}</span></span>`;
}

// The "what it means" control on its own, as an info icon, for places where
// the name itself is another control (a sortable column header). Keeps the
// two buttons siblings rather than one inside the other. Opens on hover,
// focus, click or tap.
export function MetricInfo({ metric, label = null, note = null }) {
  const ap = useStore(s => s.applicability?.[metric]);
  const ctx = useDataContext();
  const g = gloss(metric);
  const name = label || g.label;
  const v = applicabilityView(ap);
  return html`<${Tip} className="tip-wrap--icon" content=${withNote(metricTip(g, name, ap, ctx), note)} label=${`${name}: what it means`}>${v.level !== 'ok' ? html`<span class=${`flag flag--${v.level}`}>${Icon[v.level] || Icon.info}</span>` : Icon.info}</${Tip}>`;
}

// ---- beginner support (decision 1) -----------------------------------------

// The Interpretive notes switch: true unless the reader turned the notes off.
export function useExplain() {
  return useStore(s => s.explain !== false);
}

// A term with a dotted underline. Click, tap, Enter or Space opens its plain
// meaning from the glossary and a link to the concept in Learn.
//   <${Term} k="betweenness" />            the glossary label as the text
//   <${Term} k="tie">ties</${Term}>        your own wording
export function Term({ k, children, label = null }) {
  const g = termGloss(k);
  const name = label || g.label;
  // Link to the canonical key so #learn/<key> always lands on its entry.
  return html`<${Pop} className="term" label=${`${name}: what it means`} trigger=${children ?? name}>
    <strong>${name}</strong><span class="pop__p">${g.meaning}</span>
    <a class="tlink tlink--arrow pop__more" href=${`#learn/${encodeURIComponent(g.key || k)}`}>More in Learn</a>
  </${Pop}>`;
}

// Glossary entry for a Term: the analysis glossary (metrics and beginner
// concepts), then the UI fallback.
export function termGloss(k) {
  const key = GLOSSARY[k] ? k : GLOSSARY_ALIASES[k] || k;
  const e = GLOSSARY[key];
  if (e) return { key, label: e.label, meaning: e.meaning };
  return gloss(k);
}

// Interpretation: a disclosure under a number or chart, in the shared
// explanatory grammar of the copy audit (2026-10-04). Four parts, each
// optional: Definition (what the measure is), Scale (how to judge its size),
// In this network (one sentence from the live data; the caller builds it) and
// Caution (the inferential boundary). Hidden when the reader turns
// Interpretive notes off. The prop names are the original ones (means, scale,
// example, mistake) so callers did not change.
export const HOWTO_PARTS = { means: 'Definition.', scale: 'Scale.', example: 'In this network.', mistake: 'Caution.' };
// Open by default (2026-10-04): with the switch on, the notes are visible, so
// turning it off and on makes a difference a reader can see. A reader can
// still close any one of them.
export function HowToRead({ title = 'Interpretation', means, scale, example, mistake, open = true, children, className = '' }) {
  const explain = useExplain();
  if (!explain) return null;
  return html`<details class=${`disclose howto ${className}`} open=${open}>
    <summary>${title}</summary>
    <div class="reading howto__body">
      ${means && html`<p><span class="howto__k">${HOWTO_PARTS.means}</span> ${means}</p>`}
      ${scale && html`<p><span class="howto__k">${HOWTO_PARTS.scale}</span> ${scale}</p>`}
      ${example && html`<p><span class="howto__k">${HOWTO_PARTS.example}</span> ${example}</p>`}
      ${mistake && html`<p><span class="howto__k">${HOWTO_PARTS.mistake}</span> ${mistake}</p>`}
      ${children}
    </div>
  </details>`;
}

// Verdict-first statistic (decision 5): the plain sentence, then the number
// in plain words, then the technical details (the basis line, always shown).
//   <${Verdict} verdict="People mostly tie within their own department, far more than chance."
//      plain="Assortativity 0.70 (0 = no preference, 1 = only within); random networks give about 0."
//      details="Degree-preserving rewiring, 200 networks; z 55, p <= 1/201." />
export function Verdict({ verdict, plain, details, level = null, className = '' }) {
  return html`<div class=${`verdict ${className}`}>
    <p class="verdict__claim">${level && html`<${Flag} level=${level} /> `}${verdict}</p>
    ${plain && html`<p class="verdict__plain">${plain}</p>`}
    ${details && html`<p class="basis verdict__details">${details}</p>`}
  </div>`;
}

// True when p is the smallest value an empirical test with `reps` random
// networks can give, (0 + 1) / (reps + 1).
export function pAtFloor(p, reps) {
  return Number.isFinite(p) && Number.isFinite(reps) && reps > 0 && p <= (1 / (reps + 1)) * (1 + 1e-9);
}

// How many of the random networks were at least as extreme, in words, worded
// for the test as implemented:
//   two-sided (nullModel: |random - random mean| >= |observed - random mean|)
//     none of the 200 random networks came this far from their average (p <= 1/201)
//     7 of the 200 random networks came at least this far from their average (p = 0.040)
//   upper (one-sided, random >= observed)
//     none of the 100 shuffled timelines reached the observed value (p <= 1/101)
// `what` names the random networks ("shuffled timelines" for diffusion).
export function nullInWords(p, reps, { what = 'random networks', sided = 'two' } = {}) {
  if (!Number.isFinite(p)) return '';
  if (!Number.isFinite(reps) || reps <= 0) return fmtPPlain(p);
  const upper = sided === 'upper';
  if (pAtFloor(p, reps)) return `none of the ${reps} ${what} ${upper ? 'reached the observed value' : 'came this far from their average'} (p ≤ 1/${reps + 1})`;
  const k = Math.max(0, Math.round(p * (reps + 1) - 1));
  return `${k} of the ${reps} ${what} ${upper ? 'reached the observed value' : 'came at least this far from their average'} (p = ${p.toFixed(3)})`;
}

// p for a table cell: "p <= 1/201" at the floor, else "p = 0.040".
export function pShort(p, reps) {
  if (!Number.isFinite(p)) return '–';
  if (pAtFloor(p, reps)) return `p ≤ 1/${reps + 1}`;
  return fmtPPlain(p);
}

function fmtPPlain(p) { return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`; }

// Words for how far a value sits from chance, from its z against random
// networks: "about what chance gives", "more than chance", "far more than
// chance" (or "less"). For the verdict sentence.
export function chanceWords(z, { more = 'more', less = 'less' } = {}) {
  if (!Number.isFinite(z)) return '';
  const a = Math.abs(z);
  if (a < 2) return 'about what chance gives';
  const dir = z > 0 ? more : less;
  return a < 4 ? `${dir} than chance` : `far ${dir} than chance`;
}

export function Loading({ children = 'Working' }) {
  return html`<div class="loading" role="status"><span class="spinner" aria-hidden="true"></span><span>${children}</span></div>`;
}

export function ErrorLine({ error, onRetry }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message || String(error);
  return html`<div class="notice-line" role="alert"><${Flag} level="error" /><span class="grow">${msg}</span>${onRetry && html`<button type="button" class="tlink" onClick=${onRetry}>Try again</button>`}</div>`;
}

export function Unavailable({ what, children }) {
  return html`<div class="notice-line"><${Flag} level="na">Not available yet</${Flag}><span class="grow">${children || `${what} is not available in this build.`}</span></div>`;
}

export function Swatch({ color, square = false }) {
  return html`<span class=${`swatch${square ? ' swatch--sq' : ''}`} style=${`background:${color}`} aria-hidden="true"></span>`;
}

export function Select({ label, value, onChange, options, id, className = '', disabled = false }) {
  return html`<label class=${`field ${className}`}>
    <span>${label}</span>
    <select class="select" id=${id} value=${value} disabled=${disabled} onChange=${e => onChange(e.currentTarget.value)}>
      ${options.map(o => (o.group
        ? html`<optgroup label=${o.group}>${o.options.map(x => html`<option value=${x.value} disabled=${x.disabled}>${x.label}</option>`)}</optgroup>`
        : html`<option value=${o.value} disabled=${o.disabled}>${o.label}</option>`))}
    </select>
  </label>`;
}

export function Seg({ label, value, onChange, options }) {
  return html`<div class="field"><span id=${`seg-${label}`}>${label}</span>
    <div class="seg" role="group" aria-labelledby=${`seg-${label}`}>
      ${options.map(o => html`<button type="button" aria-pressed=${String(value === o.value)} onClick=${() => onChange(o.value)}>${o.label}</button>`)}
    </div></div>`;
}

// ---- downloads -------------------------------------------------------------
// Says so after saving (C14: a phone shows no download bar), unless `quiet`.
export function download(text, filename, mime = 'text/plain', { quiet = false } = {}) {
  const blob = text instanceof Blob ? text : new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  if (!quiet) store.actions.notify?.('info', `Downloaded ${filename}.`);
}

// True on touch screens (coarse pointer), for hints that differ by device:
// "Tap" instead of "Click", no keyboard-only tips on a phone (C14).
export function useTouch() {
  const q = typeof matchMedia === 'function' ? matchMedia('(pointer: coarse)') : null;
  const [touch, setTouch] = useState(() => !!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setTouch(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return touch;
}

// ---- engine queries tied to the current network ---------------------------
// Results are cached per network version and key so switching views does not
// recompute, and are dropped when the network is rebuilt.
const cache = new Map();
let cacheVersion = null;

export function useEngine(key, fn, deps = [], { enabled = true, label = null } = {}) {
  const version = useStore(s => s.network?.version ?? null);
  const full = `${key}|${JSON.stringify(deps)}`;
  if (cacheVersion !== version) { cache.clear(); cacheVersion = version; }
  const [state, setState] = useState(() => (cache.has(full) ? { data: cache.get(full), loading: false, error: null } : { data: null, loading: enabled && version != null, error: null }));
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    if (!enabled || version == null) { setState({ data: null, loading: false, error: null }); return; }
    if (cache.has(full)) { setState({ data: cache.get(full), loading: false, error: null }); return; }
    let live = true;
    const ctrl = new AbortController();
    setState(s => ({ data: s.data, loading: true, error: null }));
    const run = label ? store.actions.runJob(label, (signal, progress) => fn({ signal, onProgress: progress })) : fn({ signal: ctrl.signal });
    Promise.resolve(run).then(
      data => { if (cacheVersion === version) cache.set(full, data); if (live) setState({ data, loading: false, error: null }); },
      error => { if (live) setState({ data: null, loading: false, error: error?.name === 'AbortError' ? null : error }); },
    );
    return () => { live = false; ctrl.abort(); };
  }, [version, full, enabled, nonce]);
  return { ...state, retry: useCallback(() => { cache.delete(full); setNonce(n => n + 1); }, [full]) };
}

export function invalidateEngineCache() { cache.clear(); }

// Focus the view heading when a view mounts, for keyboard and screen readers.
export function useFocusHeading(ref) {
  useEffect(() => {
    if (store.get().__focusOnView && ref.current) { ref.current.focus({ preventScroll: false }); store.set({ __focusOnView: false }); }
  }, []);
}

// View heading. Each view writes its own intro, a statement of what the view
// reports (copy audit 2026-10-04: no rhetorical question in front of it).
// `purpose`, when a caller passes one, is shown first as before.
export function ViewHead({ title, intro, actions, hiddenTitle = false, purpose }) {
  const ref = useRef(null);
  useFocusHeading(ref);
  const q = purpose || null;
  return html`<header class=${hiddenTitle ? 'visually-hidden' : 'view__head'}>
    <div class="grow">
      <h1 class="view__title" tabindex="-1" ref=${ref}>${title}</h1>
      ${(q || intro) && html`<p class="view__intro">${q && html`<span class="view__purpose">${q}</span>${intro ? ' ' : ''}`}${intro}</p>`}
    </div>
    ${actions && html`<div class="view__actions">${actions}</div>`}
  </header>`;
}

// Shown in analysis views when no network is loaded (L4). States what the
// view is for and what it will show, then the three ways to get a network,
// with the sample as the quickest. `title` alone works: purpose and shows
// come from the view's entry in the navigation.
//   <${NeedsData} title="Groups" />
//   <${NeedsData} title="Groups" purpose="Do ties stay inside groups?" shows=${['...', '...']} />
export function NeedsData({ title, purpose, shows, view }) {
  const info = (view && viewInfo(view)) || VIEWS.find(v => v.label === title) || {};
  const q = purpose || info.purpose || null;
  const list = shows || info.shows || [];
  const [busy, setBusy] = useState(false);
  const sample = async () => {
    setBusy(true);
    try { await store.actions.loadSample(); } finally { setBusy(false); }
  };
  return html`<div class="view view--col">
    <${ViewHead} title=${title} purpose=${false} intro=${q} />
    <div class="empty needs">
      ${list.length > 0 && html`<p class="label">${title} will show</p>
        <ul class="needs__shows">${list.map(x => html`<li>${x}</li>`)}</ul>`}
      <h2 class="needs__h">No network is loaded yet</h2>
      <p class="needs__lead">Load one first: explore the sample organization, draw or construct a network, or analyze empirical data.</p>
      <div class="row needs__acts">
        <button type="button" class="btn btn--primary" disabled=${busy} onClick=${sample}>${busy ? 'Loading the sample' : 'Explore the sample'}</button>
        <a class="tlink tlink--arrow" href="#build" onClick=${e => { e.preventDefault(); store.actions.setView('build'); }}>Draw or construct a network</a>
        <a class="tlink tlink--arrow" href="#data" onClick=${e => { e.preventDefault(); store.actions.setView('data'); }}>Analyze empirical data</a>
      </div>
      <p class="small text2 needs__learn">New to network analysis? <a class="tlink tlink--arrow" href="#learn">Learn the ideas</a></p>
    </div>
  </div>`;
}

export function ConstructionButton() {
  return html`<button type="button" class="tlink" onClick=${() => store.actions.openDrawer()} aria-haspopup="dialog">Construction settings</button>`;
}
