// People view: every person in the network with their measures and
// attributes, sortable and filterable (virtualised for 5,000+ rows), a
// column chooser, rank stability for a whole ranking (resampling intervals
// and top-10 share as columns, plus a top-10 panel), and a profile for the
// selected person: measures with rank, intervals and a plain gloss, strongest
// ties with their evidence, attributes, ego measures, activity and content,
// and position over time.

import { html, useState, useMemo, useEffect, useRef } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { engine } from '../services/engine.js';
import { gloss, NODE_METRICS, TWO_MODE_METRICS } from '../services/glossary.js';
import { ViewHead, NeedsData, Loading, ErrorLine, Select, MetricName, MetricInfo, Flag, Swatch, ConstructionButton, useEngine, download, applicabilityReason, HowToRead, Verdict, useExplain, useDetailsDismiss } from '../components/common.js';
import { VirtualTable } from '../components/vtable.js';
import { Spark } from '../components/charts.js';
import { Evidence } from './network.js';
import { tokens } from '../lib/palette.js';
import { preferredAttributes, isBookkeeping, numericAttributes, label as nodeLabel, RULE_LABEL } from '../lib/dsutil.js';
import { cachedRender, getRender, tiesOf } from '../lib/render-cache.js';
import { fmtNum, fmtInt, fmtDate, fmtPct, fmtAttr, columnFormat, humanize, plural } from '../lib/format.js';
import { withContacts, metricLabel, rankInfo, fmtRank, RESAMPLABLE, displayKey, isDeactivated, sparkSeries, distinctMeasures, measureFormat, measureNote } from '../lib/measures.js';
import { communityScale, communityNumber } from '../lib/communities.js';
import { nodeColoring, getColorBy } from '../lib/coloring.js';
import { departures, hasTimes } from '../lib/departures.js';
import { stabilityReading, stabilitySummary, resamplingCaveat, TOP_CHOICES } from '../lib/stability.js';
import { peopleSort, rememberPeopleSort, rememberColumn, applyColumnChoices } from '../lib/viewprefs.js';
import { EVENT_TYPES } from '../../core/model.js';
import { twoModeOfNet, isTwoModeView, withoutModeAttr, modeLabelOf } from '../lib/twomode.js';

const DEFAULT_METRICS = ['contacts', 'strength', 'betweenness', 'closeness', 'pagerank'];
// Two-mode view: the measures normalized per kind of node come first.
const TWO_MODE_DEFAULT = ['contacts', 'twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness'];
const ORDER = ['contacts', ...TWO_MODE_METRICS, ...NODE_METRICS];
const TOP = 10;
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

// Sort and columns survive switching views (not reloads); reset per dataset.
let prefs = { ds: null };

export function PeopleView() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  if (!ds || !net) return html`<${NeedsData} title="People" />`;
  return html`<${PeopleInner} ds=${ds} net=${net} />`;
}

// Rank-stability results for the current network, shared by the table and
// the profile and kept in the store so a report can cite them:
// store.stability = { version, byMetric: { [metric]: { reps, top, map: Map(dsIndex -> row) } } }.
function useStability(net) {
  const st = useStore(s => s.stability);
  return st && st.version === net.version ? st.byMetric : {};
}

async function checkStability(net, metric) {
  const r = await store.actions.runJob(`Rank stability: ${metricLabel(metric, net.directed)}`, (signal, progress) => engine.resampleRanks({ metric, reps: 50, top: TOP, seed: 1, signal, onProgress: progress }));
  const list = Array.isArray(r) ? r : r?.nodes || [];
  const cur = store.get().stability;
  const byMetric = cur && cur.version === net.version ? cur.byMetric : {};
  store.set({ stability: { version: net.version, byMetric: { ...byMetric, [metric]: { reps: r?.meta?.reps ?? 50, top: TOP, map: new Map(list.map(x => [x.node, x])) } } } });
}

function PeopleInner({ ds, net }) {
  const metrics = useStore(s => s.metrics);
  const ap = useStore(s => s.applicability) || {};
  const communities = useStore(s => s.communities);
  const selection = useStore(s => s.selection);
  const profile = useStore(s => s.ui?.profile ?? null);
  const stability = useStability(net);
  const node = useMemo(() => withContacts(metrics?.node, net.directed), [metrics, net.directed]);
  const attrs = useMemo(() => withoutModeAttr(preferredAttributes(ds)), [ds]);
  const tm = twoModeOfNet(net);
  const twoModeView = isTwoModeView(net);
  const tmView = tm?.view ?? null;
  // Ordinal attributes are both groupable and numeric; show each one once.
  const numAttrs = useMemo(() => withoutModeAttr(numericAttributes(ds)).filter(a => !attrs.some(g => g.key === a.key)), [ds, attrs]);
  const metricKeys = distinctMeasures(ORDER.filter(k => node?.[k]), net.directed);
  const naKeys = metricKeys.filter(k => ap[k]?.level === 'na');
  if (prefs.ds !== ds || prefs.view !== tmView) {
    // Measures that do not apply start hidden (C12); the reader's own column
    // and sort choices carry over from the last network (M11, J15).
    const visibleAttrs = attrs.filter(a => !isBookkeeping(a)).slice(0, 2).map(a => `attr:${a.key}`);
    const available = new Set(metricKeys.map(k => `m:${k}`));
    const unweighted = sameValues(node?.strength, node?.contacts);
    const base = new Set([...(twoModeView ? ['mode'] : []), 'community', ...visibleAttrs, ...(twoModeView ? TWO_MODE_DEFAULT : DEFAULT_METRICS).filter(k => available.has(`m:${k}`) && ap[k]?.level !== 'na' && !(k === 'strength' && unweighted)).map(k => `m:${k}`)]);
    const has = key => key === 'name' || available.has(key) || base.has(key);
    const cols = applyColumnChoices(base, available);
    if (twoModeView) cols.add('mode');
    prefs = { ds, view: tmView, sort: peopleSort(has) || { key: twoModeView ? 'm:twoModeDegree' : 'm:contacts', dir: 'desc' }, cols, q: '', mode: '' };
  } else {
    const pending = peopleSort(key => key.startsWith('m:') && !!node?.[key.slice(2)]);
    if (pending) prefs.sort = pending;
  }
  // Read from prefs on every render: the view stays mounted when a new
  // dataset loads, so component state would keep the old choices.
  const [, redraw] = useState(0);
  const { q, sort, cols } = prefs;
  // Two-mode view: show one kind of node, or both ('' = both).
  const modeSel = twoModeView ? (prefs.mode || '') : '';
  const setModeSel = v => { prefs.mode = v; redraw(x => x + 1); };
  const setQ = v => { prefs.q = v; redraw(x => x + 1); };
  const setSort = f => { const n = typeof f === 'function' ? f(prefs.sort) : f; prefs.sort = n; rememberPeopleSort(n); redraw(x => x + 1); };
  const setCols = (c, key, on) => { prefs.cols = c; if (key) rememberColumn(key, on); redraw(x => x + 1); };
  const [filterAttr, setFilterAttr] = useState('');
  const [filterVal, setFilterVal] = useState('');
  const [stabBusy, setStabBusy] = useState(false);
  const [showTable, setShowTable] = useState(false);
  const phone = usePhone();
  const ids = net.nodeIds;
  const left = departures(ds);

  // Dots follow what the Network map is colored by (L6, N21).
  const colorBy = getColorBy(ds, communities, attrs, net);
  const dots = useMemo(() => nodeColoring({ ds, net, communities, colorBy, attrs, nodeMetrics: node, label: k => metricLabel(k, net.directed) }), [ds, net, communities, colorBy, node]);

  const mlabel = k => metricLabel(k, net.directed);
  const formats = useMemo(() => Object.fromEntries(Object.keys(node || {}).map(k => [k, measureFormat(k, node[k])])), [node]);
  const sortMetric = sort.key.startsWith('m:') ? sort.key.slice(2) : null;
  // The phone ranked list opens on contacts with no sort chosen, so the
  // stability check uses contacts (degree) there until a measure is picked.
  const stabMetric = sortMetric || (phone && !showTable ? 'degree' : null);

  // Every column that can be shown; `cols` decides which are.
  const allColumns = [
    ...(twoModeView ? [{ key: 'mode', title: 'Kind', width: 'minmax(6rem,.7fr)', min: 96, group: 'People' }] : []),
    ...(communities ? [{ key: 'community', title: 'Community', width: 'minmax(5.5rem,.7fr)', min: 96, group: 'People' }] : []),
    ...attrs.map(a => ({ key: `attr:${a.key}`, title: a.label, width: 'minmax(7rem,1fr)', min: 110, group: isBookkeeping(a) ? 'Data-collection fields' : 'Attributes' })),
    ...numAttrs.map(a => ({ key: `num:${a.key}`, title: a.label, num: true, width: 'minmax(5.5rem,.8fr)', min: 90, group: 'Attributes' })),
    ...metricKeys.map(k => ({ key: `m:${k}`, title: mlabel(k), info: html`<${MetricInfo} metric=${k} label=${mlabel(k)} note=${measureNote(k, { n: net.n, directed: net.directed, twoMode: net.twoMode })} />`, num: true, width: 'minmax(8.5rem,.9fr)', min: 136, group: ap[k]?.level === 'na' ? 'Measures that do not apply to this data' : 'Measures' })),
  ];
  const stabCols = Object.keys(stability).filter(m => cols.has(`m:${m}`)).flatMap(m => [
    { key: `iv:${m}`, title: `${mlabel(m).split(' (')[0]} rank range`, num: true, sortable: false, width: 'minmax(7rem,.9fr)', min: 112, after: `m:${m}` },
    { key: `top:${m}`, title: `In top ${stability[m].top ?? TOP}`, num: true, width: 'minmax(5.5rem,.7fr)', min: 90, after: `m:${m}` },
  ]);
  // Badges (bot, deactivated, left) sit after the name, so give the column room for both.
  const badged = useMemo(() => { for (let i = 0; i < ds.nodes.count; i++) if (ds.nodes.isBot[i] || left.has(i)) return true; return false; }, [ds, left]);
  // On a phone the name column stays put while the rest scrolls, so it
  // must leave room for the measures.
  const columns = [phone ? { key: 'name', title: 'Name', width: 'minmax(9rem,1fr)', min: 144, name: true }
    : { key: 'name', title: 'Name', width: badged ? 'minmax(17rem,2fr)' : 'minmax(11rem,1.6fr)', min: badged ? 272 : 170, name: true }];
  for (const c of allColumns) {
    if (!cols.has(c.key)) continue;
    columns.push(c);
    for (const s of stabCols) if (s.after === c.key) columns.push(s);
  }

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out = [];
    for (let v = 0; v < ids.length; v++) {
      const i = ids[v];
      if (s && !(ds.nodes.labels[i] || '').toLowerCase().includes(s) && !ds.nodes.keys[i].toLowerCase().includes(s)) continue;
      if (filterAttr && filterVal !== '' && String(ds.nodes.attrs[i][filterAttr] ?? '') !== filterVal) continue;
      if (modeSel !== '' && String(tm.mode[v]) !== modeSel) continue;
      out.push(v);
    }
    const key = sort.key;
    const val = (v) => {
      const i = ids[v];
      if (key === 'name') return (ds.nodes.labels[i] || '').toLowerCase();
      if (key === 'community') return communityNumber(communities, v) ?? Infinity;
      if (key === 'mode') return tm?.mode ? tm.mode[v] : 0;
      if (key.startsWith('attr:')) return String(ds.nodes.attrs[i][key.slice(5)] ?? '￿');
      if (key.startsWith('num:')) { const x = Number(ds.nodes.attrs[i][key.slice(4)]); return Number.isFinite(x) ? x : -Infinity; }
      if (key.startsWith('top:')) { const x = stability[key.slice(4)]?.map.get(i)?.topShare; return Number.isFinite(x) ? x : -Infinity; }
      const x = node?.[key.slice(2)]?.[v];
      return Number.isFinite(x) ? x : -Infinity;
    };
    const dir = sort.dir === 'asc' ? 1 : -1;
    const cache = new Map(out.map(v => [v, val(v)]));
    out.sort((a, b) => { const x = cache.get(a), y = cache.get(b); return x < y ? -dir : x > y ? dir : a - b; });
    return out;
  }, [ids, q, sort, filterAttr, filterVal, node, communities, stability, modeSel, tm]);

  const onSort = (k) => setSort(s => (s.key === k ? { key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key: k, dir: k === 'name' || k.startsWith('attr:') ? 'asc' : 'desc' }));
  const selSet = new Set(selection.map(i => net.nodeIds.indexOf(i)).filter(v => v >= 0));
  const open = (v, e) => {
    const i = ids[v];
    store.set({ ui: { ...store.get().ui, profile: i } });
    if (e?.shiftKey) store.actions.select(selection.includes(i) ? selection.filter(x => x !== i) : [...selection, i]);
    else store.actions.select([i]);
    // On narrow screens the profile sits below the table; bring its heading
    // into view (the page's scroll padding keeps it clear of the header).
    if (window.innerWidth <= 1060) setTimeout(() => document.querySelector('.split__side')?.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' }), 50);
  };
  const badges = (i) => {
    const d = left.get(i);
    return html`${ds.nodes.isBot[i] ? html`<span class="meta">bot</span>` : ''}${d?.kind === 'deactivated' ? html`<${Flag} level="caution">deactivated</${Flag}>` : d?.kind === 'silent' ? html`<span title=${`No activity after ${fmtDate(d.last)}`}><${Flag} level="caution">left?</${Flag}></span>` : ''}`;
  };
  const dot = v => (dots.kind === 'none' ? '' : html`<${Swatch} color=${dots.of(v)} />`);
  const cell = (v, c) => {
    const i = ids[v];
    // The name truncates, never the badges after it: a cut-off "deactivated"
    // flag is how a departed person passed for a current broker in testing.
    if (c.key === 'name') return html`<span class="vt-name">${dot(v)}<span class="vt-name__text">${nodeLabel(ds, i)}</span>${badges(i)}</span>`;
    if (c.key === 'community') return communityNumber(communities, v) == null ? '' : String(communityNumber(communities, v));
    if (c.key === 'mode') return modeLabelOf(net, v) || '–';
    if (c.key.startsWith('attr:')) { const x = ds.nodes.attrs[i][c.key.slice(5)]; return x == null || x === '' ? html`<span class="muted">–</span>` : fmtAttr(c.key.slice(5), x); }
    if (c.key.startsWith('num:')) { const k = c.key.slice(4); const x = ds.nodes.attrs[i][k]; return x == null || x === '' ? html`<span class="muted">–</span>` : fmtAttr(k, Number.isFinite(Number(x)) && !/offset/i.test(k) ? fmtNum(Number(x)) : x); }
    if (c.key.startsWith('iv:')) { const r = stability[c.key.slice(3)]?.map.get(i); return r ? (r.lo === r.hi ? fmtInt(r.lo) : `${fmtInt(r.lo)} to ${fmtInt(r.hi)}`) : '–'; }
    if (c.key.startsWith('top:')) { const r = stability[c.key.slice(4)]?.map.get(i); return r ? fmtPct(r.topShare) : '–'; }
    const m = c.key.slice(2);
    return formats[m](node[m][v]);
  };
  const exportCSV = () => {
    const head = columns.map(c => c.title);
    const lines = [['key', ...head].join(',')];
    for (const v of rows) {
      const i = ids[v];
      lines.push([ds.nodes.keys[i], ...columns.map(c => {
        let x;
        if (c.key === 'name') x = nodeLabel(ds, i);
        else if (c.key === 'community') x = communityNumber(communities, v) ?? '';
        else if (c.key === 'mode') x = modeLabelOf(net, v);
        else if (c.key.startsWith('m:')) x = node[c.key.slice(2)][v];
        else if (c.key.startsWith('attr:')) x = ds.nodes.attrs[i][c.key.slice(5)];
        else if (c.key.startsWith('num:')) x = ds.nodes.attrs[i][c.key.slice(4)];
        else if (c.key.startsWith('iv:')) { const r = stability[c.key.slice(3)]?.map.get(i); x = r ? `${r.lo}-${r.hi}` : ''; }
        else if (c.key.startsWith('top:')) x = stability[c.key.slice(4)]?.map.get(i)?.topShare;
        const s = x == null || (typeof x === 'number' && !Number.isFinite(x)) ? '' : String(x);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      })].join(','));
    }
    download(lines.join('\n'), 'people.csv', 'text/csv');
  };
  const runStability = async () => {
    if (!stabMetric) return;
    setStabBusy(true);
    try { await checkStability(net, stabMetric); } catch (e) { if (e.name !== 'AbortError') store.actions.notify('error', e.message); } finally { setStabBusy(false); }
  };
  const filterValues = filterAttr ? (attrs.find(a => a.key === filterAttr)?.values || []) : [];
  const canStab = stabMetric && RESAMPLABLE.includes(stabMetric) && ap[stabMetric]?.level !== 'na';
  const profileHidden = profile != null && !rows.some(v => ids[v] === profile);
  const hiddenNa = naKeys.filter(k => !cols.has(`m:${k}`));
  const sortCol = [...allColumns, { key: 'name', title: 'Name' }].find(c => c.key === sort.key);
  const sortedBy = sortCol ? `Sorted by ${sortCol.title}, ${sort.dir === 'asc' ? (sort.key === 'name' || sort.key.startsWith('attr:') ? 'A to Z' : 'lowest first') : (sort.key === 'name' ? 'Z to A' : 'highest first')}.` : '';
  const listMetric = sortMetric && node?.[sortMetric] ? sortMetric : 'contacts';

  return html`<div class="view">
    <${ViewHead} title="People" intro="This view reports person-level network measures, ranks, attributes, and profiles. Sort a measure to compare positions across the network. Select a person to inspect their measures, ties, attributes, activity, and the observations underlying their relationships."
      actions=${html`<div class="tlinks"><${ConstructionButton} /><button type="button" class="tlink tlink--down" onClick=${exportCSV}>Export table</button></div>`} />
    <div class="toolbar">
      <label class="field field--grow"><span>Search</span><input class="input" type="search" placeholder="Name or id" value=${q} onInput=${e => setQ(e.currentTarget.value)} /></label>
      ${twoModeView && html`<${Select} label="Show" value=${modeSel} onChange=${setModeSel} options=${[{ value: '', label: `${tm.labels[0]} and ${tm.labels[1].toLowerCase()}` }, { value: '0', label: `${tm.labels[0]} only` }, { value: '1', label: `${tm.labels[1]} only` }]} />`}
      ${attrs.length > 0 && html`<${Select} label="Filter by" value=${filterAttr} onChange=${v => { setFilterAttr(v); setFilterVal(''); }} options=${[{ value: '', label: 'Everyone' }, ...attrs.map(a => ({ value: a.key, label: a.label }))]} />`}
      ${filterAttr && html`<${Select} label="Value" value=${filterVal} onChange=${setFilterVal} options=${[{ value: '', label: 'Any' }, ...filterValues.map(v => ({ value: v, label: fmtAttr(filterAttr, v) }))]} />`}
    </div>
    <div class="split">
      <div class="split__main">
        <div class="row row--between" style="margin-bottom:.4rem;gap:.5rem 1.5rem">
          <p class="meta" style="margin:0">${fmtInt(rows.length)} of ${fmtInt(ids.length)} ${twoModeView ? 'nodes' : 'people'}</p>
          <div class="tlinks">
            ${canStab && !stability[stabMetric] && html`<button type="button" class="tlink" onClick=${runStability} disabled=${stabBusy}>${stabBusy ? 'Resampling' : `Check how stable the ${mlabel(stabMetric).split(' (')[0].toLowerCase()} ranking is`}</button>`}
            ${!(phone && !showTable) && html`<${ColumnChooser} columns=${allColumns} cols=${cols} setCols=${setCols} />`}
          </div>
        </div>
        <p class="small text2 people-sorted">${sortedBy} <${DotKey} coloring=${dots} /></p>
        ${twoModeView && html`<p class="small text2 people-twomode">A two-mode network: ${fmtInt(tm.counts[0])} ${tm.labels[0].toLowerCase()} and ${fmtInt(tm.counts[1])} ${tm.labels[1].toLowerCase()}. Two-mode measures are scaled to what is possible for each kind (Borgatti and Everett 1997), so ${modeSel === '' ? html`rank each kind among its own: <button type="button" class="tlink" onClick=${() => setModeSel('0')}>${tm.labels[0]} only</button> or <button type="button" class="tlink" onClick=${() => setModeSel('1')}>${tm.labels[1].toLowerCase()} only</button>.` : `this list ranks the ${tm.labels[Number(modeSel)].toLowerCase()} among themselves.`}</p>`}
        ${stabMetric && stability[stabMetric] && html`<${TopStability} ds=${ds} metric=${stabMetric} label=${mlabel(stabMetric)} result=${stability[stabMetric]} n=${ids.length} values=${node[stabMetric]} fmt=${formats[stabMetric]} net=${net} left=${left} />`}
        ${phone && !showTable ? html`<${RankedList} ds=${ds} ids=${ids} node=${node} rows=${rows} metric=${listMetric} keys=${metricKeys.filter(k => ap[k]?.level !== 'na')} label=${mlabel} fmt=${formats} dot=${dot} badges=${badges}
              onMetric=${k => setSort({ key: `m:${k}`, dir: 'desc' })} onOpen=${open} />
            <button type="button" class="tlink" style="margin-top:.6rem" onClick=${() => setShowTable(true)}>Show the full table (scrolls sideways)</button>`
          : html`<div class="people-table"><${VirtualTable} label="People and their measures" columns=${columns} rows=${rows} rowKey=${v => v} cell=${cell} onActivate=${open}
            selected=${selSet} sort=${sort} onSort=${onSort} empty="Nobody matches the search or filter." /></div>
            ${phone && html`<button type="button" class="tlink" style="margin-top:.6rem" onClick=${() => setShowTable(false)}>Back to the ranked list</button>`}`}
        ${hiddenNa.length > 0 && html`<p class="basis">Hidden because they do not apply to this data (add them under Columns): ${hiddenNa.map(k => mlabel(k)).join(', ')}. ${applicabilityReason(ap[hiddenNa[0]])}</p>`}
        <${RankingHowTo} ds=${ds} net=${net} node=${node} metric=${listMetric} label=${mlabel(listMetric)} fmt=${formats[listMetric]} />
      </div>
      <aside class="split__side" aria-label="Profile">
        ${profile != null ? html`<${Profile} key=${profile} ds=${ds} net=${net} i=${profile} hidden=${profileHidden} />` : html`<h2 class="label">Profile</h2><p class="small text2">Select a person in the table (click, or focus the table and press Enter) to see their profile.</p>`}
      </aside>
    </div>
  </div>`;
}

// Strength equals contacts for everyone when ties carry no weight.
function sameValues(a, b) {
  if (!a || !b) return false;
  for (let x = 0; x < a.length; x++) if (Number.isFinite(a[x]) && a[x] !== b[x]) return false;
  return true;
}

// Phones (below 600px): a measure picker and a ranked list of name and
// value, so "who has the most ties?" is answered without sideways scrolling
// (L7, M15). The full table stays one tap away.
function usePhone() {
  const q = typeof matchMedia === 'function' ? matchMedia('(max-width: 599px)') : null;
  const [phone, setPhone] = useState(!!q?.matches);
  useEffect(() => {
    if (!q) return;
    const on = () => setPhone(q.matches);
    q.addEventListener?.('change', on);
    return () => q.removeEventListener?.('change', on);
  }, []);
  return phone;
}

const LIST_PAGE = 50;

function RankedList({ ds, ids, node, rows, metric, keys, label, fmt, dot, badges, onMetric, onOpen }) {
  const [more, setMore] = useState(false);
  const arr = node[metric];
  const order = rows.filter(v => Number.isFinite(arr[v])).sort((a, b) => arr[b] - arr[a] || a - b);
  const shown = more ? order : order.slice(0, LIST_PAGE);
  // Competition ranks at the precision shown: equal values share a rank.
  const ranks = [];
  order.forEach((v, x) => { ranks.push(x > 0 && fmt[metric](arr[v]) === fmt[metric](arr[order[x - 1]]) ? ranks[x - 1] : x + 1); });
  return html`<div class="people-list" data-notice-avoid>
    <${Select} label="Measure" value=${metric} onChange=${onMetric} options=${keys.map(k => ({ value: k, label: label(k) }))} />
    <ol class="people-list__items">
      ${shown.map((v, x) => { const i = ids[v]; return html`<li><button type="button" class="people-list__row" onClick=${e => onOpen(v, e)}>
        <span class="people-list__rank tnum">${ranks[x]}${(ranks[x + 1] === ranks[x] || (x > 0 && ranks[x - 1] === ranks[x])) ? '=' : ''}</span><span class="vt-name">${dot(v)}<span class="vt-name__text">${nodeLabel(ds, i)}</span>${badges(i)}</span><span class="tnum people-list__val">${fmt[metric](arr[v])}</span>
      </button></li>`; })}
    </ol>
    ${order.length > LIST_PAGE && html`<button type="button" class="tlink" onClick=${() => setMore(m => !m)}>${more ? `Show the top ${LIST_PAGE}` : `Show all ${fmtInt(order.length)}`}</button>`}
    <p class="basis">People with the same value at the precision shown share a rank (marked =).</p>
  </div>`;
}

// One line saying what the dots mean, with the colors (L6, N21, J15).
function DotKey({ coloring }) {
  if (!coloring || coloring.kind === 'none') return null;
  if (coloring.kind === 'seq') return html`<span class="dot-key">Dots: ${coloring.title}, darker is lower (as on the Network map).</span>`;
  const gc = coloring.gc;
  return html`<span class="dot-key">Dots: ${coloring.title.replace(' (found by Louvain)', '')}, as on the Network map${gc.colored.length ? ':' : '.'}
    ${gc.colored.map(e => html` <span class="nowrap"><${Swatch} color=${e.color} />${e.label}</span>`)}${gc.many ? html` <span class="nowrap"><${Swatch} color=${gc.otherColor} />other groups</span>` : ''}${gc.missing ? html` <span class="nowrap"><${Swatch} color=${gc.missingColor} />not recorded</span>` : ''}</span>`;
}

// Interpretation of a ranking (decision 1, copy audit 2026-10-04): what the
// sorted measure means, how to judge its scale, the live top of the list,
// and the caution.
function RankingHowTo({ ds, net, node, metric, label, fmt }) {
  const arr = node?.[metric];
  if (!arr) return null;
  const order = Array.from(arr.keys()).filter(v => Number.isFinite(arr[v])).sort((a, b) => arr[b] - arr[a] || a - b);
  if (!order.length) return null;
  const top = order[0];
  const tied = order.filter(v => fmt(arr[v]) === fmt(arr[top]));
  const who = tied.length > 1 ? `${tied.slice(0, 3).map(v => nodeLabel(ds, net.nodeIds[v])).join(', ')}${tied.length > 3 ? ` and ${tied.length - 3} more` : ''} share the top value (${fmt(arr[top])})` : `${nodeLabel(ds, net.nodeIds[top])} is first with ${fmt(arr[top])}${order[1] != null ? `, then ${nodeLabel(ds, net.nodeIds[order[1]])} with ${fmt(arr[order[1]])}` : ''}`;
  return html`<${HowToRead} title="Interpretation of a ranking"
    means=${measureNote(metric, { n: net.n, directed: net.directed, twoMode: net.twoMode }) || gloss(metric).meaning}
    scale="Compare values and ranks within the same network and measure. Close values provide weak evidence for a precise ordering even when the displayed ranks differ."
    example=${`Ranked by ${label}: ${who}.`}
    mistake="Each measure describes a particular form of network position. A high rank on one measure should be interpreted in terms of that measure rather than as general importance." />`;
}

function ColumnChooser({ columns, cols, setCols }) {
  // Closes on an outside click or Escape like any menu (M10).
  const ref = useRef(null);
  useDetailsDismiss(ref);
  const groups = [...new Set(columns.map(c => c.group))];
  const toggle = (k, on) => { const n = new Set(cols); if (on) n.add(k); else n.delete(k); setCols(n, k, on); };
  return html`<details class="people-cols" ref=${ref}>
    <summary>Columns (${columns.filter(c => cols.has(c.key)).length} of ${columns.length})</summary>
    <div class="people-cols__panel">
      ${groups.map(g => html`<fieldset><legend class="field__label">${g}</legend>
        ${columns.filter(c => c.group === g).map(c => html`<label class="check"><input type="checkbox" checked=${cols.has(c.key)} onChange=${e => toggle(c.key, e.currentTarget.checked)} />${c.title}</label>`)}
      </fieldset>`)}
    </div>
  </details>`;
}

// The top of a ranking with each person's 95% resampling range of rank:
// a dot at the observed rank and a line across the range, on one shared
// rank axis, with a plain reading per person for the top k the reader picks
// (decision 5, L10, J6): settled, in the top k, or could drop out; people
// whose values are equal at the precision shown are flagged as tied; people
// who left during the data are marked (J7).
function TopStability({ ds, metric, label, result, n, values, fmt, net, left }) {
  const [k, setK] = useState(5);
  const valueOf = r => { const v = Array.prototype.indexOf.call(net.nodeIds, r.node); return v >= 0 ? values[v] : r.value; };
  const all = [...result.map.values()].sort((a, b) => a.rank - b.rank || a.node - b.node).map(r => ({ ...r, value: valueOf(r) }));
  const sum = stabilitySummary(all, k, fmt);
  const rows = all.slice(0, Math.max(k, Math.min(all.length, sum.groups.reduce((m, g) => Math.max(m, g.to), 0))));
  const maxRank = Math.max(k, ...rows.map(r => r.hi));
  const x = r => `${((r - 1) / Math.max(1, maxRank - 1)) * 100}%`;
  const gone = sum.top.filter(r => left.has(r.node));
  const tieText = g => `Ranks ${g.from} to ${g.to} have the same value at the precision shown (${g.text}): their order is not a finding.`;
  return html`<details class="stab" open>
    <summary><h2 class="label" style="margin:0;display:inline">Rank stability: top of the ${label.split(' (')[0].toLowerCase()} ranking</h2></summary>
    <div class="row" style="gap:.4rem 1rem;align-items:flex-end;margin-top:.4rem">
      <${Select} label="Read the top" value=${String(k)} onChange=${v => setK(Number(v))} options=${TOP_CHOICES.filter(c => c <= all.length).map(c => ({ value: String(c), label: String(c) }))} />
    </div>
    <${Verdict} className="stab__verdict" verdict=${sum.verdict} plain=${[...sum.groups.map(tieText), gone.length ? `${gone.map(r => nodeLabel(ds, r.node)).join(', ')} left during the data (marked below); a whole-period rank mixes the time before and after, and resampling cannot show that.` : ''].filter(Boolean).join(' ')} />
    <ol class="stab__list">
      ${rows.map(r => { const rd = stabilityReading(r, k); const tied = sum.tiedNodes.has(r.node); const d = left.get(r.node); return html`<li class=${`stab__row${r.rank > k ? ' stab__row--after' : ''}`}>
        <span class="name">${r.rank}. ${nodeLabel(ds, r.node)}${d ? html` <${Flag} level="caution">${d.kind === 'deactivated' ? 'deactivated' : 'left?'}</${Flag}>` : ''}</span>
        <span class="stab__bar" role="img" aria-label=${`rank ${r.rank}, range ${r.lo} to ${r.hi}`}>
          <span class="axis"></span><span class="span" style=${`left:${x(r.lo)};width:calc(${x(r.hi)} - ${x(r.lo)})`}></span><span class="dot" style=${`left:${x(r.rank)}`}></span>
        </span>
        <span class="tnum">${fmt(r.value)}</span>
        <span class="stab__read">${tied ? `Tied at the precision shown (${fmtNum(r.value, { digits: 4 })} to 4 digits); ` : ''}${tied ? rd.text.charAt(0).toLowerCase() + rd.text.slice(1) : rd.text}</span>
      </li>`; })}
    </ol>
    <p class="basis">Rank 1 at the left, ${fmtInt(maxRank)} at the right; the line is the range of ranks in 95% of ${fmtInt(result.reps)} resamples of the events (each rebuilt with the same settings), out of ${plural(n, 'person', 'people')}. ${resamplingCaveat(metric, sum.allPoint)} The range and "In top ${result.top ?? TOP}" columns are in the table.</p>
    <${HowToRead}
      means="Org Signal repeatedly resamples the observed events, rebuilds the network using the same construction settings, and recalculates the ranking. The resulting intervals show how much a person’s rank changes under this form of sampling variation."
      scale="Narrow intervals indicate that the ordering is stable across resamples. Wider intervals indicate that several rank positions are consistent with the observed events."
      example=${sum.top.length ? `${nodeLabel(ds, sum.top[0].node)}: ${stabilityReading(sum.top[0], k).text.replace(/^Settled: /, '').toLowerCase()}.` : null}
      mistake="These intervals address variation in the observed events. Missing actors, unobserved ties, measurement error in the source, and structural change during the observation period remain outside the resampling procedure." />
  </details>`;
}

// ---- profile -------------------------------------------------------------------------

function Profile({ ds, net, i, hidden }) {
  const metrics = useStore(s => s.metrics);
  const ap = useStore(s => s.applicability) || {};
  const communities = useStore(s => s.communities);
  const stability = useStability(net);
  const node = useMemo(() => withContacts(metrics?.node, net.directed), [metrics, net.directed]);
  const v = Array.prototype.indexOf.call(net.nodeIds, i);
  const [busy, setBusy] = useState(false);
  const [edge, setEdge] = useState(null);
  const head = useRef(null);
  // The attribute for ego diversity: one this person has and shares with
  // someone else. A field only the respondent holds (kind = ego in an
  // interview) gives "diversity 0, same kind 0%", which means nothing (C15).
  const egoAttr = useMemo(() => preferredAttributes(ds).find(a => {
    if (isBookkeeping(a)) return false;
    const x = ds.nodes.attrs[i][a.key];
    if (x == null || x === '') return false;
    for (let j = 0; j < ds.nodes.count; j++) if (j !== i && String(ds.nodes.attrs[j]?.[a.key]) === String(x)) return true;
    return false;
  })?.key, [ds, i]);
  const ego = useEngine('ego', () => engine.ego(i, { attr: egoAttr }), [i, egoAttr], { enabled: v >= 0 });
  const series = useEngine('ts-month', () => engine.timeSeries({ window: 'month', purpose: 'person profiles', metrics: ['degree', 'strength', 'betweenness'] }), [], { enabled: hasTimes(ds) });
  const ties = useTies(net, i, v);
  const activity = useMemo(() => activityOf(ds, i), [ds, i]);
  // Strength equals contacts for everyone when ties carry no weight (surveys,
  // drawings, present-or-absent weighting): no interaction volume to show (C15).
  const unweighted = useMemo(() => sameValues(node?.strength, node?.contacts), [node]);
  const shown = distinctMeasures(ORDER.filter(k => node?.[k] && ap[k]?.level !== 'na' && !(k === 'strength' && unweighted)), net.directed);
  const explain = useExplain();
  const dep = departures(ds).get(i);
  const timed = useMemo(() => hasTimes(ds), [ds]);
  const comm = communityScale(communities);
  const key = displayKey(ds.nodes.keys[i]);
  const toCheck = ['degree', 'betweenness', 'closeness', 'strength'].filter(k => shown.includes(k) && ap[k]?.level !== 'na' && !stability[k]);

  const resampleAll = async () => {
    setBusy(true);
    try { for (const m of toCheck) await checkStability(net, m); } catch (e) { if (e.name !== 'AbortError') store.actions.notify('error', e.message); } finally { setBusy(false); }
  };
  const jump = id => { const el = document.getElementById(id); el?.focus({ preventScroll: true }); el?.scrollIntoView({ block: 'start', behavior: reducedMotion() ? 'auto' : 'smooth' }); };

  if (edge) return html`<${Evidence} ds=${ds} a=${edge.a} b=${edge.b} onClose=${() => setEdge(null)} />`;
  const t = tokens();
  const attrs = Object.entries(ds.nodes.attrs[i]).filter(([k]) => k !== 'deactivated' && k !== 'bipartite');
  // The plots follow the table: a measure that does not apply here (path
  // measures in one person's exports) is not plotted either.
  const sv = series.data ? sparkSeries(series.data, i, ['degree', 'strength', 'betweenness'].filter(k => ap[k]?.level !== 'na' && !(k === 'strength' && unweighted))) : null;
  return html`<div>
    <h2 class="label">Profile</h2>
    <p class="profile-head" tabindex="-1" ref=${head}>${nodeLabel(ds, i)}</p>
    <p class="meta" style="margin:.2rem 0 .6rem">${[v >= 0 ? modeLabelOf(net, v) : null, key, ds.nodes.isBot[i] ? 'bot' : null].filter(Boolean).join(' · ')}${communities && v >= 0 ? html`${key || ds.nodes.isBot[i] || modeLabelOf(net, v) ? ' · ' : ''}${communityNumber(communities, v) == null ? 'No community (no ties)' : html`<${Swatch} color=${comm.color(String(communities.membership[v]))} /> Community ${communityNumber(communities, v)}`}` : ''}</p>
    ${isDeactivated(ds, i) && html`<p class="small"><${Flag} level="caution">Deactivated account</${Flag}> <span class="text2">This account was deactivated in the source; its ties end when the person left${dep?.last != null ? ` (last active ${fmtDate(dep.last)})` : ''}. Whole-period measures mix the time before and after, and rank stability cannot show that.</span></p>`}
    ${dep?.kind === 'silent' && html`<p class="small"><${Flag} level="caution">Left?</${Flag}> <span class="text2">No activity after ${fmtDate(dep.last)}: silent for the last ${fmtInt(dep.quietDays)} days of the data. Whole-period measures mix the time before and after, and rank stability cannot show that; compare before and after in Time.</span></p>`}
    ${hidden && html`<p class="small text2"><${Flag} level="info">Not in the table</${Flag}> The current search or filter hides this person.</p>`}
    ${v < 0 && html`<p class="small text2">This person is in the data but not in the current network (filtered out by the construction settings, or without ties).</p>`}
    ${v >= 0 && html`<nav class="profile-skip" aria-label="Profile sections">
      <button type="button" class="tlink tlink--quiet tlink--down" onClick=${() => jump('pf-ties')}>Strongest ties</button>
      <button type="button" class="tlink tlink--quiet tlink--down" onClick=${() => jump('pf-measures')}>Measures</button>
      <button type="button" class="tlink tlink--quiet tlink--down" onClick=${() => jump('pf-activity')}>Activity</button>
    </nav>`}

    ${v >= 0 && html`<div class="section" style="border-top:0;padding-top:0">
      <h3 class="label" id="pf-ties" tabindex="-1">Strongest ties</h3>
      ${ties === null ? html`<${Loading}>Reading ties</${Loading}>` : !ties.length ? html`<p class="small text2">No ties.</p>` : html`<ol style="list-style:none;margin:0;padding:0">
        ${ties.slice(0, 8).map(tie => html`<li class="metric-row">
          <button type="button" class="linkish" onClick=${() => setEdge({ a: i, b: tie.other })} aria-label=${`Evidence for the tie with ${nodeLabel(ds, tie.other)}`}>${nodeLabel(ds, tie.other)}</button>
          <span class="metric-row__val">${fmtNum(tie.w)}</span>
          <span class="metric-row__sub">${tie.dir}${tie.rules.length ? ` · ${tie.rules.map(r => (RULE_LABEL[r] || r).toLowerCase()).join(', ')}` : ''}</span>
        </li>`)}
      </ol><p class="basis">Weight under the current construction rules. Select a name to see the events behind the tie.</p>`}
    </div>`}

    ${v >= 0 && html`<div class="section">
      <div class="row row--between" style="gap:.3rem 1rem"><h3 class="label" id="pf-measures" tabindex="-1" style="margin:0">Measures</h3>
        ${toCheck.length > 0 && html`<button type="button" class="tlink" onClick=${resampleAll} disabled=${busy}>${busy ? 'Resampling' : 'Check rank stability'}</button>`}</div>
      ${shown.map(k => {
        const arr = node[k];
        const rk = rankInfo(arr, v);
        const iv = stability[k]?.map.get(i);
        const level = ap[k]?.level;
        return html`<div class="metric-row">
          <span><${MetricName} metric=${k} label=${metricLabel(k, net.directed)} note=${measureNote(k, { n: net.n, directed: net.directed, twoMode: net.twoMode })} gloss=${true} /></span>
          <span class="metric-row__val">${measureFormat(k, arr)(arr[v])}</span>
          <span class="metric-row__sub">
            ${fmtRank(rk)}
            ${iv && html` · <span style="color:var(--text-2)">${stabilityReading(iv, stability[k].top ?? TOP).text}; in the top ${stability[k].top ?? TOP} in ${fmtPct(iv.topShare)} of resamples</span>`}
            ${explain && (k === 'closeness' || k === 'betweenness') && html`<br /><span class="profile-note">${measureNote(k, { n: net.n, directed: net.directed, twoMode: net.twoMode })}</span>`}
            ${level === 'caution' && html`<br/><${Flag} level="caution" /> ${applicabilityReason(ap[k])}`}
          </span>
        </div>`;
      })}
      <p class="basis">${Object.keys(stability).length ? `Rank ranges: the events redrawn and the network rebuilt ${Object.values(stability)[0].reps} times with the same settings; the range covers 95% of them. A wide range is not a finding. Redrawing cannot remove whole ties, so it cannot test whether a tie exists.` : 'Rank stability redraws the events and rebuilds the network to show how far each rank could move.'}</p>
    </div>`}

    ${attrs.length > 0 && html`<div class="section">
      <h3 class="label">Attributes</h3>
      <dl class="kv">${attrs.map(([k, x]) => html`<dt>${humanize(k)}</dt><dd>${fmtAttr(k, x)}</dd>`)}</dl>
    </div>`}

    ${v >= 0 && html`<div class="section">
      <h3 class="label">Ego network</h3>
      ${ego.loading && html`<${Loading} />`}<${ErrorLine} error=${ego.error} />
      ${ego.data && html`<dl class="kv">
        <dt>Contacts</dt><dd>${fmtInt(ego.data.size)}</dd>
        <dt>Ties among contacts</dt><dd>${fmtInt(ego.data.tiesAmongAlters)}</dd>
        <dt><${MetricName} metric="egoDensity" showFlag=${false} /></dt><dd>${fmtNum(ego.data.density)}</dd>
        <dt><${MetricName} metric="effectiveSize" showFlag=${false} /></dt><dd>${fmtNum(ego.data.effectiveSize)}</dd>
        <dt><${MetricName} metric="constraint" showFlag=${false} /></dt><dd>${fmtNum(ego.data.constraint)}</dd>
        ${ego.data.diversity != null && Number.isFinite(ego.data.diversity) && (ego.data.altersWithValue ?? 2) >= 2 && html`<dt>Diversity of contacts (${humanize(ego.data.attr)})</dt><dd>${fmtNum(ego.data.diversity)}</dd>`}
        ${ego.data.homophily != null && Number.isFinite(ego.data.homophily) && (ego.data.altersWithValue ?? 2) >= 2 && html`<dt>Contacts with the same ${humanize(ego.data.attr).toLowerCase()}</dt><dd>${fmtPct(ego.data.homophily)}</dd>`}
      </dl>`}
    </div>`}

    <div class="section">
      <h3 class="label" id="pf-activity" tabindex="-1">Activity and content</h3>
      <dl class="kv">
        <dt>Events by this person</dt><dd>${fmtInt(activity.total)}</dd>
        ${Object.entries(activity.byType).map(([k, n]) => html`<dt class="small">${humanize(k)}</dt><dd class="small">${fmtInt(n)}</dd>`)}
        ${activity.messages > 0 && html`<dt>Messages with text</dt><dd>${fmtInt(activity.withText)} of ${fmtInt(activity.messages)}</dd>`}
        ${timed && !activity.declaredOnly && html`<dt>First and last seen</dt><dd>${fmtDate(activity.first)} – ${fmtDate(activity.last)}</dd>`}
      </dl>
      ${activity.contexts.length > 0 && html`<p class="small text2" style="margin-top:.5rem">Most active in ${activity.contexts.map(([c, n]) => `${c} (${fmtInt(n)})`).join(', ')}.</p>`}
      ${activity.terms.length > 0 && html`<p class="small text2" style="margin-top:.3rem">Frequent words: ${activity.terms.join(', ')}.</p>`}
    </div>

    ${v >= 0 && timed && html`<div class="section">
      <h3 class="label">Position over time</h3>
      ${series.loading && html`<${Loading} />`}<${ErrorLine} error=${series.error} />
      ${sv && sv.windows.length > 1 && html`<div class="sm-grid">
        ${sv.metrics.map(m => html`<${Spark} values=${m.values} label=${metricLabel(m.key, net.directed)} color=${t.cat[0]} valueLabel=${m.last ? `${fmtDate(m.last.x).replace(/^\d+ /, '')}: ${fmtNum(m.last.y)}` : '–'} />`)}
      </div><p class="basis">One point per month, each month's network built with the same settings; months the data only partly covers are left out. Values are not comparable across people with very different activity.</p>`}
      ${series.data && !(sv && sv.windows.length > 1) && html`<p class="small text2">Not enough dated activity for a time series.</p>`}
    </div>`}
  </div>`;
}

function useTies(net, i, v) {
  const [ties, setTies] = useState(null);
  useEffect(() => {
    if (v < 0) { setTies([]); return; }
    let live = true;
    const d = cachedRender(net.version);
    if (d) setTies(tiesOf(d, i, net.directed));
    else getRender(net.version).then(x => live && setTies(tiesOf(x, i, net.directed)), () => live && setTies([]));
    return () => { live = false; };
  }, [net.version, i, v]);
  return ties;
}

const STOP = new Set('the a an and or of to in on for with at by from is are was were be been it this that i you we they he she me my our your their not no yes do does did have has had will would can could should just so if as but about up out into over than then there here what when where who how all any some more most very also only too its im ok okay thanks hi hello re fwd'.split(' '));

function activityOf(ds, i) {
  const e = ds.events;
  const byType = {}; const ctx = new Map(); const words = new Map();
  let total = 0, withText = 0, messages = 0, first = Infinity, last = -Infinity;
  for (let k = 0; k < e.count; k++) {
    if (e.actor[k] !== i) continue;
    total++;
    const ty = EVENT_TYPES[e.type[k]];
    byType[ty] = (byType[ty] || 0) + 1;
    const t = e.t[k];
    if (t === t) { if (t < first) first = t; if (t > last) last = t; }
    const c = e.context[k];
    if (c >= 0) ctx.set(ds.contexts.names[c], (ctx.get(ds.contexts.names[c]) || 0) + 1);
    // Only messages count as messages with text (N9): a reaction carries
    // the text of the message it reacts to, a repost the text it reposts.
    const tx = e.text[k];
    if (ty === 'message') { messages++; if (tx) withText++; }
    if (tx && ty === 'message') { for (const w of String(tx).toLowerCase().match(/[a-z][a-z'-]{2,}/g) || []) if (!STOP.has(w)) words.set(w, (words.get(w) || 0) + 1); }
  }
  return { total, byType, withText, messages, declaredOnly: total > 0 && byType.declared === total, first, last, contexts: [...ctx.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3), terms: [...words.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(x => x[0]) };
}
