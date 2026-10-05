// Methods and Export view: the deterministic methods appendix (no LLM),
// network files for other tools, figures, a print-friendly summary report,
// and saving or opening an Org Signal project file. Everything is produced
// on this device.

import { isDeactivated } from '../lib/measures.js';
import { html, useState, useEffect, useRef } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { FORMATS, available, exportAs, fileBase } from '../services/exporters.js';
import { projectText, readProject, openProject } from './data/project.js';
import { summaryResults, wholeNetworkLines } from '../../llm/methods.js';
import { withContacts, metricLabel } from '../lib/measures.js';
import { methodsAppendix } from '../services/llm.js';
import { gloss } from '../services/glossary.js';
import { ViewHead, Loading, ErrorLine, Flag, download, Unavailable, applicabilityReason } from '../components/common.js';
import { renderMarkdown, markdownToHTMLDocument } from '../lib/markdown.js';
import { categoricalScale, tokens } from '../lib/palette.js';
import { cachedRender, getRender } from '../lib/render-cache.js';
import { groupableAttributes, label as nodeLabel } from '../lib/dsutil.js';
import { fmtNum, fmtInt, fmtRange } from '../lib/format.js';
import { communityWords, communityCounts } from '../lib/rebuild.js';

export function MethodsView() {
  const ds = useStore(s => s.dataset);
  return html`<div class="view view--col">
    <${ViewHead} title="Methods & Export" intro="This view records how the current network was constructed and analyzed, and exports the resulting network, measures, figures, reports, and project state." />
    ${ds ? html`<${Loaded} ds=${ds} />` : html`<div class="section" style="border-top:0"><p class="text2">Nothing to describe or export yet. Load data, or open a saved project below.</p></div>`}
    ${!ds && html`<${Project} />`}
  </div>`;
}

// download() confirms the save itself.
function save(text, filename, mime) {
  download(text, filename, mime);
}

// What the appendix describes: the construction actually used, the measures
// computed, and only the optional analyses that were run on this network
// (store.methodsLog, recorded by the engine adapter), each with its own
// replicate count and the results the views showed (`result`, N4, N5).
export function appendixInput(state) {
  const { dataset, settings, network, metrics, communities } = state;
  const log = state.methodsLog || {};
  const approx = {};
  for (const [k, m] of Object.entries(metrics?.meta || {})) if (m?.approximate) approx[k] = m.method || 'approximate (sampled)';
  const attrs = groupableAttributes(dataset);
  const attributeLabels = Object.fromEntries(attrs.map(a => [a.key, a.label || a.key]));
  // The detected communities are grouped under an internal key ('__community');
  // the appendix names them in words (N12).
  const isComm = a => a === 'community' || a === '__community';
  const groups = [];
  for (const g of log.groups || []) if (g.attr) groups.push({ attr: isComm(g.attr) ? '__community' : g.attr, result: g.result });
  for (const n of log.nullModel || []) if (n.attr && !groups.some(g => g.attr === n.attr)) groups.push({ attr: n.attr });
  const content = {};
  if (log.affect?.length) content.affect = log.affect[log.affect.length - 1];
  if (log.keywords?.length) content.keywords = log.keywords[log.keywords.length - 1];
  if (log.topics?.length) content.topics = log.topics[log.topics.length - 1];
  // People view's measure list leads with contacts (decision 4).
  const nodeKeys = Object.keys(metrics?.node || {});
  return {
    dataset, settings,
    network: network ? { n: network.n, directed: network.directed, edges: { count: network.edgeCount }, summary: network.summary } : null,
    metrics: nodeKeys.includes('degree') ? ['contacts', ...nodeKeys] : nodeKeys,
    networkStats: Object.keys(metrics?.network || {}).filter(k => typeof metrics.network[k] === 'number'),
    approx,
    communities: communities ? { resolution: communities.resolution ?? 1, seed: communities.seed ?? 1, runs: 1, count: communityCounts(communities).groups, isolates: communityCounts(communities).alone, numbering: communities.numbering || 'size', modularity: communities.modularity } : undefined,
    groups, attributeLabels,
    // The import report's short names, by source index (report.sources[i].id).
    sourceLabels: (dataset?.meta?.sources || []).map((_, i) => state.report?.sources?.find(x => x.id === i)?.label || null),
    nullModels: (log.nullModel || []).map(n => ({ ...n, attr: n.attr && isComm(n.attr) ? undefined : n.attr })),
    resampling: (log.resampling || []).map(r => ({ ...r, scheme: 'events resampled with replacement' })),
    time: (log.time || []).map(t => ({ window: t.window, metrics: t.metrics, start: t.start, end: t.end, purpose: t.purpose, result: t.result })),
    shifts: log.shifts || [],
    beforeAfter: log.beforeAfter || [],
    diffusion: log.diffusion || [],
    content: Object.keys(content).length ? content : undefined,
    software: { name: 'Org Signal', version: '2' },
  };
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall back below */ }
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false;
  try { ok = document.execCommand('copy'); } catch { ok = false; }
  ta.remove();
  return ok;
}

function Loaded({ ds }) {
  const state = useStore(s => s);
  const [md, setMd] = useState(null);
  const [err, setErr] = useState(null);
  const [avail, setAvail] = useState(null);
  const [busy, setBusy] = useState(null);
  // Leave out contact details (N19): on by default, for files handed in or shared.
  const [omitContacts, setOmitContacts] = useState(true);
  const logKey = JSON.stringify(state.methodsLog || {});
  useEffect(() => {
    let live = true;
    methodsAppendix(appendixInput(state)).then(m => live && setMd(m ?? false), e => live && setErr(e));
    return () => { live = false; };
  }, [state.network?.version, logKey]);
  useEffect(() => { available().then(setAvail); }, []);
  const base = fileBase(ds);

  const doExport = async (id) => {
    setBusy(id);
    try {
      const r = await exportAs(id, { ds, settings: state.settings, nodeMetrics: state.metrics?.node, communities: state.communities, omitContacts });
      save(r.text, r.filename, r.mime);
    } catch (e) { store.actions.notify('error', e.message); } finally { setBusy(null); }
  };
  const figure = async () => {
    const data = cachedRender(state.network.version) || await getRender(state.network.version);
    save(staticNetworkSVG(ds, data, state.communities, state.metrics), `${base}-figure.svg`, 'image/svg+xml');
  };
  const summary = () => {
    const doc = markdownToHTMLDocument(summaryMarkdown(state, md || ''), `${ds.meta.name}: network summary`);
    save(doc, `${base}-summary.html`, 'text/html');
  };
  const copy = async () => {
    const ok = await copyText(md);
    store.actions.notify(ok ? 'info' : 'warn', ok ? 'Methods appendix copied as Markdown.' : 'This browser did not allow copying. Download the Markdown instead.');
  };

  return html`
    <section class="section" style="border-top:0" aria-labelledby="exp-h">
      <h2 id="exp-h" class="section__title">Network files</h2>
      <p class="small text2" style="margin-bottom:.6rem">Export the network as currently constructed, including node attributes, computed measures, communities, and tie-level evidence for each construction rule. Contact details are omitted by default.</p>
      <label class="check mx-privacy"><input type="checkbox" checked=${omitContacts} onChange=${e => setOmitContacts(e.currentTarget.checked)} />
        <span>Leave out contact details: email addresses, handles, phone numbers and account ids. People keep their names; ids become p1, p2, ... ${omitContacts ? '' : 'With this off, ids are the dataset\'s person keys, so files can be joined back to the data.'}</span></label>
      <div class="table-wrap"><table class="tbl tbl--files">
        <tbody>${FORMATS.map(f => html`<tr>
          <td class="name">${f.label}</td>
          <td class="small">${f.note}</td>
          <td class="num">${avail && !avail[f.id] ? html`<${Flag} level="na">Not available yet</${Flag}>` : html`<button type="button" class="tlink tlink--down" onClick=${() => doExport(f.id)} disabled=${busy === f.id || !avail} aria-label=${`Download ${f.label}`}>${busy === f.id ? 'Preparing' : `.${f.ext}`}</button>`}</td>
        </tr>`)}</tbody>
      </table></div>
    </section>
    <section class="section" aria-labelledby="fig-h">
      <h2 id="fig-h" class="section__title">Figures and summary</h2>
      <div class="tlinks">
        <button type="button" class="tlink tlink--down" onClick=${figure}>Network figure, colored by community (SVG)</button>
        <button type="button" class="tlink tlink--down" onClick=${summary} disabled=${md === null}>Summary report (HTML, prints to PDF)</button>
        <a class="tlink tlink--arrow" href="#network" onClick=${e => { e.preventDefault(); store.actions.setView('network'); }}>The current network view as SVG or PNG</a>
      </div>
      <p class="basis">Export a network figure or a summary report containing the data description, whole-network measures, analyses already run in Org Signal, and the methods appendix.</p>
      <p class="basis">The summary is generated deterministically from computed results and can be saved as HTML or printed to PDF.</p>
    </section>
    <${Project} />
    <section class="section" aria-labelledby="meth-h">
      <h2 id="meth-h" class="section__title">Methods appendix</h2>
      <p class="small text2">The methods appendix is generated from the sources, construction settings, measures, and analyses used for the current network. Analyses appear after they have been run in the relevant view.</p>
      <p class="small text2" style="margin-bottom:.7rem">The exported text provides a reproducible record of the analytical sequence and can be edited for a paper or report.</p>
      ${md && html`<div class="tlinks" style="margin-bottom:1.25rem">
        <button type="button" class="tlink" onClick=${copy}>Copy appendix</button>
        <button type="button" class="tlink tlink--down" onClick=${() => save(md, `${base}-methods.md`, 'text/markdown')}>Markdown</button>
        <button type="button" class="tlink tlink--down" onClick=${() => save(markdownToHTMLDocument(md, 'Methods appendix'), `${base}-methods.html`, 'text/html')}>HTML</button>
      </div>`}
      <${ErrorLine} error=${err} />
      ${md === null && !err && html`<${Loading}>Writing the appendix</${Loading}>`}
      ${md === false && html`<${Unavailable}>The methods appendix (src/llm/methods.js) is not available in this build.</${Unavailable}>`}
      ${md && renderMarkdown(md.replace(/^# [^\n]*\n+/, ''), { shift: 1 })}
    </section>`;
}

function topBy(state, metric, k = 10) {
  const arr = state.metrics?.node?.[metric];
  if (!arr) return [];
  const ids = state.network.nodeIds;
  return Array.from(arr.keys()).filter(v => Number.isFinite(arr[v])).sort((a, b) => arr[b] - arr[a]).slice(0, k).map(v => ({ i: ids[v], value: arr[v] }));
}

// The printable summary: data, whole network (network-level wording), the
// random-network and group comparisons that were run (verdict first, N13),
// the most central people by contacts and betweenness, then the appendix.
export function summaryMarkdown(state, appendix) {
  const { dataset: ds, network, metrics, communities, applicability: ap = {}, report } = state;
  const L = [];
  L.push(`# ${ds.meta.name}`, '');
  const t = report?.totals;
  L.push(`${fmtInt(ds.nodes.count)} people and ${fmtInt(ds.events.count)} events from ${ds.meta.sources.length} ${ds.meta.sources.length === 1 ? 'source' : 'sources'}${t?.timeRange ? `, ${fmtRange(t.timeRange.start, t.timeRange.end)}` : ''}. The network has ${fmtInt(network.n)} people and ${fmtInt(network.edgeCount)} ${network.directed ? 'directed' : 'undirected'} ties.`, '');
  L.push('## Sources', '');
  for (const s of report?.sources || []) {
    L.push(`- **${s.label || s.format}** (${s.view} view): ${fmtInt(s.counts?.events)} events, ${fmtInt(s.counts?.nodes)} people. Cannot show: ${(s.cannotShow || []).join(' ')}`);
  }
  L.push('', '## Whole network', '');
  L.push(...wholeNetworkLines(metrics?.network || {}, k => gloss(k).label));
  if (communities) L.push(`- **Communities: ${communityWords(communities)}** (modularity ${fmtNum(communities.modularity)}), numbered from 1 ${communities.numbering === 'matched' ? 'by matching: after a rebuild each community keeps the number of the earlier community it shares most people with, so numbers need not follow size' : 'by size'}. ${gloss('community').reliability || ''}`.trim());
  L.push('');
  const results = summaryResults(appendixInput(state));
  if (results.length) L.push(...results);
  // Rank intervals from the People view's stability check, when it was run on this network.
  const stab = state.stability?.version === network.version ? state.stability.byMetric || {} : {};
  const anyStab = ['degree', 'contacts', 'betweenness'].some(m => stab[m]);
  L.push('## Most central people', '', anyStab ? 'Ranks are descriptive. Where shown, the rank interval comes from resampling events and rebuilding the network; a wide interval means the rank is not a finding, and a narrow one cannot show that the ties themselves were measured without error.' : 'Ranks are descriptive. Check rank intervals (People view, "Check stability of this ranking") before treating a ranking as a finding.', '');
  const node = withContacts(metrics?.node, network.directed) || {};
  const local = { ...state, metrics: { ...metrics, node } };
  for (const m of ['contacts', 'betweenness']) {
    const apKey = m === 'contacts' ? 'degree' : m;
    if (ap[apKey]?.level === 'na') { L.push(`- ${metricLabel(m, network.directed)}: not applicable here. ${applicabilityReason(ap[apKey])}`); continue; }
    const top = topBy(local, m, 8);
    if (!top.length) continue;
    const st = stab[m] || (m === 'contacts' ? stab.degree : null);
    const iv = x => { const r = st?.map?.get(x.i); return r && Number.isFinite(r.lo) ? `; rank ${r.lo}-${r.hi}${Number.isFinite(r.topShare) ? `, top ${st.top} in ${Math.round(r.topShare * 100)}% of ${st.reps} resamples` : ''}` : ''; };
    const name = metricLabel(m, network.directed);
    const meaning = m === 'contacts' ? 'number of distinct people each person has a tie with' : 'share of shortest paths between other people that pass through each person';
    L.push(`- **${name}** (${meaning}): ${top.map(x => `${nodeLabel(ds, x.i)}${isDeactivated(ds, x.i) ? ' [deactivated account]' : ''} (${m === 'contacts' ? fmtInt(x.value) : fmtNum(x.value)}${iv(x)})`).join(', ')}.${ap[apKey]?.level === 'caution' ? ` Caution: ${applicabilityReason(ap[apKey])}` : ''}`);
  }
  // A departed person can still rank high on what they did before leaving;
  // say so where a reader would otherwise take the ranking at face value.
  const gone = [...new Set(['contacts', 'betweenness'].flatMap(m => (ap[m === 'contacts' ? 'degree' : m]?.level === 'na' ? [] : topBy(local, m, 8)).map(x => x.i)))].filter(i => isDeactivated(ds, i));
  if (gone.length) L.push('', `${gone.map(i => nodeLabel(ds, i)).join(', ')} ${gone.length === 1 ? 'is a deactivated account' : 'are deactivated accounts'} in the export: ${gone.length === 1 ? 'their' : 'these'} ranks reflect activity before they left, not the current organization.`);
  L.push('');
  if (appendix) L.push(appendix.replace(/^# /m, '## '));
  return L.join('\n');
}

export function staticNetworkSVG(ds, data, communities, metrics) {
  const t = tokens();
  const W = 1200, H = 900, pad = 40;
  const n = data.x.length;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let v = 0; v < n; v++) { x0 = Math.min(x0, data.x[v]); x1 = Math.max(x1, data.x[v]); y0 = Math.min(y0, data.y[v]); y1 = Math.max(y1, data.y[v]); }
  const s = Math.min((W - 2 * pad) / (x1 - x0 || 1), (H - 2 * pad) / (y1 - y0 || 1));
  const X = v => pad + (data.x[v] - x0) * s + ((W - 2 * pad) - (x1 - x0) * s) / 2;
  const Y = v => pad + (data.y[v] - y0) * s + ((H - 2 * pad) - (y1 - y0) * s) / 2;
  const k = communities?.count || 0;
  const sc = categoricalScale(Array.from({ length: k }, (_, i) => String(i)));
  const deg = metrics?.node?.degree;
  const mx = deg ? Math.max(1, ...Array.from(deg).filter(Number.isFinite)) : 1;
  const ni = data.netIndex;
  const r = v => (n > 2000 ? 1.5 : 2.5) + (n > 2000 ? 4 : 7) * Math.sqrt((deg?.[ni[v]] || 0) / mx);
  const edgeA = data.src.length > 20000 ? 0.06 : data.src.length > 3000 ? 0.12 : 0.25;
  const esc = x => String(x).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  const lines = [];
  for (let e = 0; e < data.src.length; e++) lines.push(`<line x1="${X(data.src[e]).toFixed(1)}" y1="${Y(data.src[e]).toFixed(1)}" x2="${X(data.dst[e]).toFixed(1)}" y2="${Y(data.dst[e]).toFixed(1)}"/>`);
  const circles = [];
  for (let v = 0; v < n; v++) circles.push(`<circle cx="${X(v).toFixed(1)}" cy="${Y(v).toFixed(1)}" r="${r(v).toFixed(2)}" fill="${k ? sc.color(String(communities.membership[ni[v]])) : t.node}"/>`);
  const legend = k ? sc.entries.map((e, i) => `<g transform="translate(${pad},${H - pad + 18 - (sc.entries.length - i) * 16})"><circle r="5" cx="5" cy="-4" fill="${e.color}"/><text x="16" y="0">Community ${Number(e.value) + 1}</text></g>`).join('') : '';
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="Geist, system-ui, sans-serif" font-size="11">
<rect width="100%" height="100%" fill="${t.bgDeep}"/>
<g stroke="${t.edge}" stroke-opacity="${edgeA}" stroke-width="0.6">${lines.join('')}</g>
<g>${circles.join('')}</g>
<g fill="${t.text2}">${legend}</g>
<text x="${W - pad}" y="${H - 14}" text-anchor="end" fill="${t.muted}">${esc(ds.meta.name)} · ${fmtInt(n)} people, ${fmtInt(data.src.length)} ties · node size: number of ties · Org Signal</text>
</svg>`;
}

function Project() {
  const state = useStore(s => s);
  const ref = useRef(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const saveProject = () => save(projectText(state), `${fileBase(state.dataset, 'project')}.orgsignal.json`, 'application/json');
  const open = async (file) => {
    setErr(null); setBusy(true);
    try {
      await openProject(await readProject(file));
      store.actions.focus('#proj-h');
    } catch (e) { setErr(e); } finally { setBusy(false); }
  };
  const survey = (state.dataset?.meta?.sources || []).some(x => x.nominations?.respondents);
  return html`<section class="section" aria-labelledby="proj-h">
    <h2 id="proj-h" class="section__title" tabindex="-1">Project file</h2>
    <p class="small text2">Save the current project to preserve the data and construction settings for later work in Org Signal. Opening it here or in Data restores the same network and measures.</p>
    <p class="small text2" style="margin-bottom:.9rem">Loaded data and results are not kept in the browser after the tab closes; only Build drafts and an API key the user chooses to remember are stored locally. The project file contains the combined data after identity merges and joins, including message text and contact details, and requires the same care as the original exports.${survey ? ' For this survey it also keeps who named whom, so whoever opens it can see each person\'s nominations: share it only with people allowed to see the raw answers.' : ''}</p>
    <div class="tlinks">
      ${state.dataset && html`<button type="button" class="btn btn--primary" onClick=${saveProject}>Save project</button>`}
      <button type="button" class="tlink" onClick=${() => ref.current.click()} disabled=${busy}>${busy ? 'Opening' : 'Open a project'}</button>
      <input type="file" accept=".json,application/json" hidden ref=${ref} onChange=${e => { const f = e.currentTarget.files[0]; if (f) open(f); e.currentTarget.value = ''; }} />
    </div>
    <${ErrorLine} error=${err} />
  </section>`;
}
