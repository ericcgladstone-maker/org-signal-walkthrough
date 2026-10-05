// Application shell: masthead with primary navigation, the active view, the
// construction drawer, notices and the job status bar. Mounted from
// index.html. Views are loaded lazily so a missing optional module (another
// owner's work still landing) only affects its own view.

import { html, render, useState, useEffect, useRef } from '../../vendor/preact.js';
import { store, useStore } from './store.js';
import { registerActions, VIEWS, NAV_GROUPS, parseHash, formatProgress, shortName } from './actions.js';
import { initEngine, engineStatus } from './services/engine.js';
import { MOCK, mockSize } from './services/modules.js';
import { Icon, Loading, ErrorLine, ViewHead } from './components/common.js';
import { hasText, timeExtent } from './lib/dsutil.js';

const loaders = {
  data: () => import('./views/data.js').then(m => m.DataView),
  network: () => import('./views/network.js').then(m => m.NetworkView),
  people: () => import('./views/people.js').then(m => m.PeopleView),
  groups: () => import('./views/groups.js').then(m => m.GroupsView),
  content: () => import('./views/content.js').then(m => m.ContentView),
  time: () => import('./views/time.js').then(m => m.TimeView),
  ask: () => import('./views/ask.js').then(m => m.AskView),
  methods: () => import('./views/methods.js').then(m => m.MethodsView),
  learn: () => import('./views/learn.js').then(m => m.LearnView),
  build: () => import('./views/external.js').then(m => m.BuildMount),
  generate: () => import('./views/external.js').then(m => m.GenerateMount),
};
const loaded = {};

// "Analyzing: <name>" and "Clear loaded data", in the masthead whenever data
// is loaded (decision 7). It asks first, because nothing is stored. Builders
// use "New ..." for their own drafts, so "Start over" no longer means two
// things (L15, decision 4).
function Loaded() {
  const ds = useStore(s => s.dataset);
  const [ask, setAsk] = useState(false);
  const btn = useRef(null);
  const box = useRef(null);
  useEffect(() => {
    if (!ask) return;
    box.current?.querySelector('.tlink--quiet')?.focus();
    const onKey = e => { if (e.key === 'Escape') { setAsk(false); btn.current?.focus(); } };
    const onClick = e => { if (!box.current?.contains(e.target) && !btn.current?.contains(e.target)) setAsk(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, [ask]);
  if (!ds) return null;
  const name = ds.meta?.name || 'Untitled';
  const n = ds.nodes?.count ?? 0;
  return html`<div class="loaded">
    <span class="loaded__name" title=${`${name}: ${n.toLocaleString('en-US')} people`}><span class="loaded__label">Analyzing: </span><strong>${shortName(name, 40)}</strong></span>
    <button type="button" class="tlink tlink--quiet" ref=${btn} aria-expanded=${String(ask)} aria-controls="startOver" onClick=${() => setAsk(!ask)}>Clear loaded data</button>
    ${ask && html`<div class="confirm" id="startOver" ref=${box} role="dialog" aria-labelledby="startOverH">
      <p id="startOverH"><strong style="color:var(--text)">Clear loaded data?</strong></p>
      <p>This clears ${shortName(name, 48)}, the network and every result from this tab. Loaded data is not kept anywhere, so it cannot be brought back unless you save a project first. Drafts in Build stay saved in this browser.</p>
      <div class="tlinks">
        <button type="button" class="tlink tlink--danger" onClick=${() => { setAsk(false); store.actions.startOver(); }}>Clear it</button>
        <button type="button" class="tlink tlink--arrow" onClick=${() => { setAsk(false); store.actions.setView('methods'); store.actions.focus('#proj-h'); }}>Save a project first</button>
        <button type="button" class="tlink tlink--quiet" onClick=${() => { setAsk(false); btn.current?.focus(); }}>Cancel</button>
      </div>
    </div>`}
  </div>`;
}

// Views that cannot apply to what is loaded stay as links with a muted reason
// (decision 2): Content needs message text, Time needs dates.
function useNavNotes(ds) {
  const [notes, setNotes] = useState({});
  useEffect(() => {
    if (!ds) { setNotes({}); return; }
    const out = {};
    if (!hasText(ds)) out.content = 'no text';
    const [lo] = timeExtent(ds);
    if (!Number.isFinite(lo)) out.time = 'no dates';
    setNotes(out);
  }, [ds]);
  return notes;
}

const NOTE_TITLE = { 'no text': 'This data has no message text', 'no dates': 'This data has no dates' };

// The Interpretive notes switch (decision 1): a quiet text control. On shows
// the Interpretation blocks and term glosses; the reader's choice is kept.
function ExplainSwitch({ className = '' }) {
  const on = useStore(s => s.explain !== false);
  return html`<button type="button" class=${`explain-switch ${className}`} aria-pressed=${String(on)}
      title="Show or hide the Interpretation notes and term explanations"
      onClick=${() => store.actions.setExplain(!on)}>Interpretive notes: <span class="explain-switch__v">${on ? 'on' : 'off'}</span></button>`;
}

function Header() {
  const view = useStore(s => s.view);
  const ds = useStore(s => s.dataset);
  const notes = useNavNotes(ds);
  const open = useStore(s => !!s.ui?.menuOpen);
  const btn = useRef(null);
  const nav = useRef(null);
  const setOpen = v => store.set({ ui: { ...(store.get().ui || {}), menuOpen: v } });
  useEffect(() => {
    if (!open) return;
    const onKey = e => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    const onClick = e => { if (!nav.current?.contains(e.target) && !btn.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, [open]);
  // Transparent until the page scrolls, then the rule and deeper ground (as on the site).
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const set = () => setScrolled(window.scrollY > 8);
    set();
    window.addEventListener('scroll', set, { passive: true });
    return () => window.removeEventListener('scroll', set);
  }, []);
  const go = (e, id) => { e.preventDefault(); store.actions.setView(id); };
  // Grouped in workflow order. On desktop the groups are separated by thin
  // rules and each link's description is its title; the phone menu shows the
  // group names as small mono labels and the descriptions under each link.
  const groups = NAV_GROUPS.map(g => ({ ...g, views: VIEWS.filter(v => v.group === g.id) }));
  return html`<header class="app-header" data-scrolled=${String(scrolled || open)}>
    <div class="app-header__inner">
      <a class="brand" href="#data" onClick=${e => go(e, 'data')}>
        <span class="brand__name">Org Signal</span>
        <span class="brand__desc">Social network analysis in the browser</span>
      </a>
      <div class="app-header__end">
      <${Loaded} />
      <button class="menu-btn" ref=${btn} type="button" aria-label="Menu" aria-expanded=${String(open)} aria-controls="appNav" onClick=${() => setOpen(!open)}>
        <span class="menu-btn__bars" aria-hidden="true"></span>
      </button>
      <nav class="app-nav" id="appNav" ref=${nav} aria-label="Views" data-open=${String(open)}>
        <ul>
          ${groups.map((g, gi) => html`${gi > 0 && html`<li class="sep" aria-hidden="true"></li>`}<li class="nav-group__label" aria-hidden="true">${g.label}</li>${g.views.map(v => {
            const note = notes[v.id];
            return html`<li><a href=${`#${v.id}`} aria-current=${view === v.id ? 'page' : undefined}
              title=${note ? `${v.desc}. ${NOTE_TITLE[note]}.` : v.desc}
              aria-describedby=${`nav-d-${v.id}`} data-note=${note || undefined}
              onClick=${e => go(e, v.id)}><span class="nav-link__label">${v.label}${note && html`<span class="nav-link__note">${note}</span>`}</span><span class="nav-link__desc" id=${`nav-d-${v.id}`}>${v.desc}${note ? ` (${NOTE_TITLE[note].toLowerCase()})` : ''}</span></a></li>`;
          })}`)}
          <li class="nav-explain"><${ExplainSwitch} /></li>
        </ul>
      </nav>
      </div>
    </div>
    <div class="loaded-row frame"><${Loaded} /></div>
  </header>`;
}

function StatusBar() {
  const jobs = useStore(s => s.jobs);
  const ref = useRef(null);
  useEffect(() => {
    const h = jobs.length && ref.current ? ref.current.offsetHeight : 0;
    document.documentElement.style.setProperty('--status-h', `${h}px`);
  }, [jobs.length]);
  if (!jobs.length) return null;
  // Not a live region: progress is announced, throttled, through #announcer (actions.js).
  return html`<div class="status" ref=${ref} role="region" aria-label="Running jobs">
    ${jobs.map(j => {
      const indet = !(j.progress > 0);
      const pct = indet ? '' : `${Math.round(j.progress * 100)}%`;
      return html`<div class="status__job" key=${j.id}>
        <span class=${`status__bar${indet ? ' status__bar--indet' : ''}`} style=${indet ? '' : `width:${Math.max(2, j.progress * 100)}%`} aria-hidden="true"></span>
        <span class="spinner" aria-hidden="true"></span>
        <span class="status__label">${j.label}${j.message ? html`<span class="muted"> · ${formatProgress(j.message)}</span>` : ''}</span>
        <span class="status__pct">${pct}</span>
        ${j.cancel && html`<button type="button" class="btn btn--sm" onClick=${() => j.cancel()}>Cancel</button>`}
      </div>`;
    })}
  </div>`;
}

// Notices sit at the bottom right, above the status bar and above any bar a
// view keeps stuck to the bottom of the window (the Data view's action bar):
// views mark such bars with [data-sticky-bottom] (or .dv-actions).
function stickyBottomOffset() {
  let h = 0;
  for (const el of document.querySelectorAll('[data-sticky-bottom], .dv-actions')) {
    const r = el.getBoundingClientRect();
    if (r.height && r.bottom >= window.innerHeight - 2 && r.top < window.innerHeight) h = Math.max(h, window.innerHeight - r.top);
  }
  return h;
}

// They also keep off the network map and anything marked
// [data-notice-avoid] (C14): on a phone the map fills the screen width, so a
// notice at the bottom covered its people. When the stack would overlap such
// an area, it moves above the area if there is room on screen, else below
// it, else it collapses to one short line (tap to expand).
function avoidPlacement(stack, lift) {
  const vh = window.innerHeight;
  const st = stack.getBoundingClientRect();
  const h = stack.scrollHeight || st.height;
  if (!h) return { lift, compact: false };
  const header = document.querySelector('.app-header')?.getBoundingClientRect().bottom || 0;
  const bottomEdge = vh - Math.max(lift, 0) - 16;
  const overlaps = (r, top, bottom) => r.top < bottom && r.bottom > top && r.left < st.right && r.right > st.left;
  for (const el of document.querySelectorAll('.net, [data-notice-avoid]')) {
    const r = el.getBoundingClientRect();
    if (!r.height || r.bottom <= header || r.top >= vh) continue;
    if (!overlaps(r, bottomEdge - h, bottomEdge)) continue;
    // Room between the area's bottom and the window's bottom (scrolled up)?
    if (vh - r.bottom >= h + 16 + Math.max(lift, 0)) return { lift, compact: false };
    // Room above the area, below the header?
    if (r.top - header >= h + 16) return { lift: vh - r.top + 8, compact: false };
    return { lift, compact: true };
  }
  return { lift, compact: false };
}

function Notices() {
  const notices = useStore(s => s.notices || []);
  const view = useStore(s => s.view);
  const a = store.actions;
  const ref = useRef(null);
  const [compact, setCompact] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (!notices.length) { setExpanded(false); return; }
    const place = () => {
      const el = ref.current;
      if (!el) return;
      const lift = stickyBottomOffset();
      el.style.setProperty('--notice-lift', `${lift}px`);
      const p = avoidPlacement(el, lift);
      el.style.setProperty('--notice-lift', `${p.lift}px`);
      setCompact(p.compact);
    };
    place();
    const t = setInterval(place, 500);
    window.addEventListener('scroll', place, { passive: true });
    window.addEventListener('resize', place);
    return () => { clearInterval(t); window.removeEventListener('scroll', place); window.removeEventListener('resize', place); };
  }, [notices.length, view]);
  const short = compact && !expanded;
  return html`<div class=${`notices${short ? ' notices--compact' : ''}`} ref=${ref} aria-live="polite" aria-relevant="additions"
    onMouseEnter=${() => a.pauseNotices()} onMouseLeave=${e => { if (!e.currentTarget.contains(document.activeElement)) a.resumeNotices(); }}
    onFocusIn=${() => a.pauseNotices()} onFocusOut=${e => { if (!e.currentTarget.contains(e.relatedTarget)) a.resumeNotices(); }}>
    ${notices.map(n => html`<div class=${`notice notice--${n.level}`} key=${n.id} data-notice=${n.id} role=${n.level === 'error' ? 'alert' : 'status'}>
      <span class=${`flag flag--${n.level === 'warn' ? 'caution' : n.level === 'error' ? 'error' : 'ok'}`}>${n.level === 'warn' ? Icon.caution : n.level === 'error' ? Icon.error : Icon.info}</span>
      <div class="grow notice__body">
        ${short ? html`<button type="button" class="notice__more" aria-expanded="false" onClick=${() => setExpanded(true)}>${n.text}</button>` : html`<span>${n.text}</span>`}
        ${!short && n.detail && html`<ul class="notice__list">${n.detail.map(d => html`<li>${d}</li>`)}</ul>`}
        ${!short && n.action && html`<span><button type="button" class="tlink" onClick=${() => { n.action.onClick(); a.dismiss(n.id); }}>${n.action.label}</button></span>`}
      </div>
      <button type="button" class="btn btn--quiet btn--sm" aria-label="Dismiss notice" onClick=${() => a.dismiss(n.id)}>${Icon.close}</button>
    </div>`)}
  </div>`;
}

function ViewHost() {
  const view = useStore(s => s.view);
  const epoch = useStore(s => s.epoch || 0);
  const [, force] = useState(0);
  const [error, setError] = useState(null);
  useEffect(() => {
    setError(null);
    if (loaded[view]) return;
    let live = true;
    loaders[view]().then(C => { loaded[view] = C; if (live) force(x => x + 1); }, e => { console.error(e); if (live) setError(e); });
    return () => { live = false; };
  }, [view]);
  const C = loaded[view];
  if (error) return html`<div class="view view--col"><${ViewHead} title=${VIEWS.find(v => v.id === view)?.label} /><${ErrorLine} error=${`This view could not be loaded: ${error.message}`} /></div>`;
  if (!C) return html`<div class="view"><${Loading}>Opening view</${Loading}></div>`;
  return html`<${C} key=${`${view}:${epoch}`} />`;
}

function Drawer() {
  const open = useStore(s => !!s.ui?.drawer);
  const [C, setC] = useState(null);
  useEffect(() => { if (open && !C) import('./views/drawer.js').then(m => setC(() => m.SettingsDrawer)); }, [open]);
  return open && C ? html`<${C} />` : null;
}

function EngineBanner() {
  const st = engineStatus();
  if (st.available) return MOCK ? html`<div class="frame"><div class="notice-line" style="border-top:0"><span class="flag flag--info">${Icon.info}<span>Demo mode</span></span><span class="grow small">Synthetic data and a demo analysis engine (the <code>?mock</code> flag). Remove it from the address to use your own data.</span></div></div>` : null;
  return html`<div class="frame"><div class="notice-line" style="border-top:0" role="alert"><span class="flag flag--caution">${Icon.caution}<span>Engine unavailable</span></span><span class="grow small">${st.reason} Import and building still work; analysis views will stay empty until it is present.</span></div></div>`;
}

function App() {
  return html`
    <${Header} />
    <${EngineBanner} />
    <main id="main" tabindex="-1"><${ViewHost} /></main>
    <${Drawer} />
    <${Notices} />
    <${StatusBar} />
    <div id="announcer" class="visually-hidden" role="status" aria-live="polite" aria-atomic="true"></div>`;
}

// Per-view document title (A16): "Network · Synthetic workplace · Org Signal".
function syncTitle(s) {
  const v = VIEWS.find(x => x.id === s.view)?.label || 'Data';
  const ds = s.dataset ? shortName(s.dataset.meta?.name, 40) : null;
  const t = [v, ds, 'Org Signal'].filter(Boolean).join(' \u00b7 ');
  if (document.title !== t) document.title = t;
  // Lets CSS size the sticky header (the loaded chip takes a row on phones).
  document.documentElement.dataset.loaded = String(!!s.dataset);
}

// Leaving or reloading with data loaded loses it: nothing is stored (decision 7).
// The wording is the Data view's (LEAVE_WARNING), loaded lazily so the view
// is not pulled into startup; most browsers show their own text anyway.
let leaveWarning = 'Leave Org Signal? The loaded data is not stored anywhere, so leaving or reloading erases it.';
import('./views/data.js').then(m => { if (m.LEAVE_WARNING) leaveWarning = m.LEAVE_WARNING; }, () => {});
function warnBeforeLeaving(e) {
  if (!store.get().dataset) return;
  e.preventDefault();
  e.returnValue = leaveWarning;
  return leaveWarning;
}

// Focus safety net (A8): when an action removes the focused control (a
// button replaced by results, a closed panel), focus falls to <body> and a
// keyboard or screen-reader user loses their place. Move it to the active
// view's heading instead. Views that know a better target call
// store.actions.focus(selector) themselves.
function keepFocus(e) {
  const gone = e.target;
  setTimeout(() => {
    if (gone.isConnected) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    const h = document.querySelector('main .view__title, main h1');
    if (h) { if (!h.hasAttribute('tabindex')) h.setAttribute('tabindex', '-1'); h.focus({ preventScroll: true }); }
  }, 0);
}

// A share link (#survey=1.<data>) or #respond (a survey file) opens
// respondent mode: the survey only, no analysis navigation and nothing from
// any organizer's session (src/ui/build/respond/index.js).
const RESPOND = /^#(survey=|respond\b)/;

async function boot() {
  if (RESPOND.test(location.hash)) {
    const m = await import('./build/respond/index.js');
    m.mountRespondent(document.getElementById('app'));
    return;
  }
  registerActions();
  const fromHash = parseHash(location.hash);
  store.set({ view: fromHash.view || 'data', learnKey: fromHash.key, notices: [], ui: { drawer: false, menuOpen: false } });
  window.addEventListener('hashchange', () => {
    // A survey link pasted into this tab: open it as a respondent would.
    if (RESPOND.test(location.hash)) { location.reload(); return; }
    const h = parseHash(location.hash);
    const st = store.get();
    if (!h.view) return;
    if (h.view !== st.view || (h.view === 'learn' && h.key !== st.learnKey)) store.actions.setView(h.view === 'learn' && h.key ? `learn/${h.key}` : h.view);
  });
  // Under ?mock the offline demo LLM provider is the default, so nothing is
  // ever sent to a real provider while developing or testing.
  if (MOCK) store.set({ llm: { ...store.get().llm, provider: 'demo', key: null } });
  syncTitle(store.get());
  store.subscribe(syncTitle);
  window.addEventListener('beforeunload', warnBeforeLeaving);
  document.addEventListener('focusout', keepFocus);
  await initEngine();
  render(html`<${App} />`, document.getElementById('app'));
  // ?mock: demo engine + synthetic data (UI development). ?demo: the real
  // engine with the same synthetic data, for trying the tool or QA.
  const params = new URLSearchParams(location.search);
  if ((MOCK || params.has('demo')) && engineStatus().available && !params.has('empty')) {
    try { await store.actions.loadDataset(MOCK ? (await import('./services/mock.js')).mockDataset({ n: mockSize() }) : await demoDataset(mockSize())); }
    catch (e) { store.actions.notify('error', `Demo data failed to load: ${e.message}`); }
  }
}

// The demo organization comes from the real generator: a bridge-dependent
// workplace on Slack with light message text (fake names, generated messages).
export async function demoDataset(size) {
  const { generate } = await import('../generator/index.js');
  return generate({ context: 'workplace', medium: 'slack', structure: 'bridge-dependent', size: size || 120, seed: 1, content: 'light', output: 'dataset' }).dataset;
}

boot();
