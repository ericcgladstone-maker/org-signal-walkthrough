// Small UI helpers shared by the Build and Generate views.
// Browser-only (DOM); pure logic lives in src/builders/.

import { html, useState, useEffect, useRef } from '../../../vendor/preact.js';
import { ViewHead } from '../components/common.js';
import { useStore } from '../store.js';

// The shell's view head (title, intro, focus on view change), so Build and
// Generate open like every other view.
export const ViewHeader = ViewHead;

// Load assets/build.css once. The shell owns index.html, so the views bring
// their own stylesheet. Resolved from this module's URL so it works wherever
// the app is served from.
let cssInjected = false;
export function ensureBuildCss() {
  if (cssInjected || typeof document === 'undefined') return;
  cssInjected = true;
  const href = new URL('../../../assets/build.css', import.meta.url).href;
  if ([...document.querySelectorAll('link[rel="stylesheet"]')].some(l => l.href === href)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.owner = 'ui-build';
  document.head.appendChild(link);
}

// ---- files ----

export function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export function downloadText(name, text, type = 'text/plain;charset=utf-8') {
  downloadBlob(name, new Blob([text], { type }));
}

export function readFileText(file) {
  return file.text ? file.text() : new Promise((res, rej) => {
    const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsText(file);
  });
}

// Hidden file input opened from a button; resolves with the chosen File or null.
export function pickFile(accept = '') {
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.style.display = 'none';
    input.onchange = () => { resolve(input.files?.[0] ?? null); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}

// ---- storage: localStorage can throw (private mode, blocked site data) ----

export const storage = {
  get(key, fallback = null) {
    try { const s = localStorage.getItem(key); return s == null ? fallback : JSON.parse(s); } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; }
  },
  remove(key) { try { localStorage.removeItem(key); } catch { /* storage unavailable */ } },
};

export function prefersReducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

// ---- components ----

// Accessible tab list: arrow keys move between tabs (roving tabindex).
export function Tabs({ tabs, value, onChange, label }) {
  const refs = useRef([]);
  const onKey = (e, i) => {
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = tabs.length - 1;
    if (j === null) return;
    e.preventDefault();
    onChange(tabs[j].id);
    refs.current[j]?.focus();
  };
  return html`<div class="tabs" role="tablist" aria-label=${label}>
    ${tabs.map((t, i) => html`<button type="button" role="tab" id=${'obtab-' + t.id}
      aria-selected=${t.id === value ? 'true' : 'false'} aria-controls=${'obpanel-' + t.id}
      tabindex=${t.id === value ? 0 : -1} ref=${el => (refs.current[i] = el)}
      onClick=${() => onChange(t.id)} onKeyDown=${e => onKey(e, i)}>${t.label}</button>`)}
  </div>`;
}

// Numbered step list with a progress rule. steps: [{ id, label }]
export function Steps({ steps, value, onChange, done = [] }) {
  const idx = Math.max(0, steps.findIndex(s => s.id === value));
  return html`<nav aria-label="Steps" class="ob-stack" style="gap:.4rem">
    <ol class="ob-steps">
      ${steps.map(s => html`<li class=${done.includes(s.id) ? 'done' : ''} aria-current=${s.id === value ? 'step' : undefined}>
        <button type="button" onClick=${() => onChange(s.id)} title=${s.short ? s.label : undefined}>${s.short || s.label}</button></li>`)}
    </ol>
    <div class="ob-progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax=${steps.length} aria-valuenow=${idx + 1}>
      <span style=${`width:${((idx + 1) / steps.length) * 100}%`}></span>
    </div>
  </nav>`;
}

// Neutral placeholder for a dependency that is not in the build yet.
export function Unavailable({ title, children }) {
  return html`<div class="ob-unavailable" role="status">
    <span class="label">Not available yet</span>
    <strong>${title}</strong>
    ${children ? html`<p class="ob-note">${children}</p>` : null}
  </div>`;
}

// useState mirrored to localStorage (best effort).
export function usePersistentState(key, initial) {
  const [v, setV] = useState(() => storage.get(key, typeof initial === 'function' ? initial() : initial));
  useEffect(() => { storage.set(key, v); }, [key, v]);
  return [v, setV];
}

// Group colour by index: the app's one categorical palette (--cat-*), so a
// group drawn here keeps its colour in the analysis views. Fixed order, never
// cycled; the 9th group on folds to --cat-other.
export function groupColor(i) {
  return i >= 0 && i < 8 ? `var(--cat-${i + 1})` : 'var(--cat-other)';
}

// The closing action of every builder: turn what was built into a Dataset and
// hand it to the analysis views. build() returns a Dataset or throws an Error
// whose message is shown to the user.
export function useHandOff(build) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async mode => {
    setErr(null); setBusy(true);
    try {
      const svc = await import('./service.js');
      const ds = await build();
      await svc.handOff(ds, { mode });
    } catch (e) { setErr(e.message || String(e)); }
    finally { setBusy(false); }
  };
  return { run, busy, err };
}

// With data already loaded, the bar says the main action replaces it and
// offers adding to it instead (nothing replaces data silently). `compact`
// leaves out the primary button for editors that put it in their toolbar.
export function HandOffBar({ build, disabled, note, label = 'Analyze this network', compact = false, handoff }) {
  const loaded = useStore(s => s.dataset);
  const own = useHandOff(build);
  const { run, busy, err } = handoff || own;
  return html`<div class="ob-stack ob-handoff" style="gap:.4rem">
    <div class="ob-row" style="gap:.5rem 1.25rem">
      ${compact ? null : html`<button type="button" class="btn btn--primary" disabled=${disabled || busy} onClick=${() => run('replace')}>${label}</button>`}
      ${loaded ? html`<button type="button" class="tlink" disabled=${disabled || busy} onClick=${() => run('add')}>Add to the data already loaded</button>` : null}
    </div>
    ${loaded ? html`<p class="ob-note">${label} replaces the data now loaded (${loaded.meta?.name || 'unnamed'}).</p>` : null}
    ${note ? html`<p class="ob-note">${note}</p>` : null}
    ${err ? html`<p class="ob-err" role="alert">${err}</p>` : null}
  </div>`;
}

// A text input that shows what is being typed while it has focus, even when
// the value it reports falls back to a default when blank (a survey title
// that defaults to the roster's name). Clearing it no longer brings the
// default straight back mid-typing (C7). onInput(v) on every keystroke;
// onCommit(v) when focus leaves or Enter is pressed. selectOnFocus: the
// whole text is selected on focus, so typing replaces it (C6).
export function DraftInput({ value, onInput = null, onCommit = null, selectOnFocus = false, className = 'input', ...rest }) {
  const [draft, setDraft] = useState(null);
  const shown = draft ?? value ?? '';
  const commit = el => { onCommit?.(el.value); setDraft(null); };
  return html`<input ...${rest} class=${className} value=${shown}
    onFocus=${e => { setDraft(e.currentTarget.value); if (selectOnFocus) e.currentTarget.select(); }}
    onInput=${e => { setDraft(e.currentTarget.value); onInput?.(e.currentTarget.value); }}
    onBlur=${e => commit(e.currentTarget)}
    onKeyDown=${e => { if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget); } }} />`;
}
