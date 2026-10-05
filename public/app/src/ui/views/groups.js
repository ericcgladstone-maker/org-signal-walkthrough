// Groups view: compare groups defined by an attribute or by detected
// communities. Group table (size, density within, ties within and across,
// E-I index, mean measures, members), mixing matrix, assortativity with its
// null-model z and p, and a plain-language reading that only claims what the
// null comparison supports.
//
// The view opens on the same grouping as Network and People (dsutil
// defaultGroupAttr: a department-like attribute with up to eight values, else
// the detected communities); bookkeeping flags
// (Responded, Is phone number) are not offered. The descriptive table shows
// as soon as it is counted; the null model fills in the reading after.

import { html, useState, useMemo } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { engine } from '../services/engine.js';
import { ViewHead, NeedsData, Loading, ErrorLine, Select, MetricName, Swatch, ConstructionButton, useEngine, Flag, Seg, applicabilityReason, Verdict, HowToRead, Term, nullInWords, pShort, chanceWords } from '../components/common.js';
import { tokens } from '../lib/palette.js';
import { metricLabel } from '../lib/measures.js';
import { groupColoring } from '../lib/grouping.js';
import { communityColoring } from '../lib/coloring.js';
import * as d3 from '../../../vendor/d3.js';
import { preferredAttributes, isBookkeeping, orderedValues, defaultGroupAttr, label as nodeLabel } from '../lib/dsutil.js';
import { cachedRender } from '../lib/render-cache.js';
import { fmtNum, fmtInt, fmtPct, fmtDate, humanize, columnFormat } from '../lib/format.js';
import { communityWords, communityCounts } from '../lib/rebuild.js';
import { communitySize, NO_COMMUNITY } from '../lib/communities.js';
import { isBookkeepingAttr } from '../../analysis/groups.js';
import { cssVar, useTimeShifts, groupShift, snapshotNote, changeWords, persistWords } from './time.js';
import { timeExtent } from '../lib/dsutil.js';
import { suggestTimeRange } from '../../analysis/time.js';

const MEAN_METRICS = ['degree', 'strength', 'betweenness', 'constraint'];
const PLANTED = 'Planted group (ground truth)';

// Display name of an attribute. The generator's planted grouping is ground
// truth, never to be confused with detected communities (decision 6, P4).
export function attrLabel(ds, key) {
  if (key === '__community') return 'Detected communities';
  const gen = store.get().generated;
  if (key === 'planted_group' || (gen && gen.groundTruth?.communities?.attr === key)) return PLANTED;
  const a = (ds.attributeSchema || []).find(x => x.key === key);
  return ds.meta?.attrLabels?.[key] || a?.label || humanize(key);
}

// Attributes worth grouping by, department-like first, minus bookkeeping
// flags (either test: the shared one in dsutil and the analysis one behind
// defaultGrouping, so a field hidden here is never the default either).
export function groupingAttributes(ds) {
  return preferredAttributes(ds).filter(a => !isBookkeeping(a) && !isBookkeepingAttr(a));
}

export function GroupsView() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  if (!ds || !net) return html`<${NeedsData} title="Groups" />`;
  return html`<${GroupsInner} ds=${ds} net=${net} />`;
}

function GroupsInner({ ds, net }) {
  const communities = useStore(s => s.communities);
  const metrics = useStore(s => s.metrics);
  const ap = useStore(s => s.applicability) || {};
  const attrs = useMemo(() => groupingAttributes(ds), [ds]);
  const [by, setBy] = useState(() => {
    const d = defaultGroupAttr(ds, { communities });
    if (d && attrs.some(a => a.key === d)) return d;
    return communities || !attrs.length ? '__community' : attrs[0].key;
  });
  const [cellMode, setCellMode] = useState('density');
  const [openGroup, setOpenGroup] = useState(null);
  const isComm = by === '__community';
  // One replicate count everywhere (NULL_REPS in analysis/uncertainty.js):
  // the engine keeps one run per network and statistic, so Network, Groups
  // and the reports quote the same numbers (N3).
  const reps = 200;

  const res = useEngine('groups', async () => {
    const r = await engine.groups(by, { membership: communities?.membership });
    if (isComm && !(r?.groups?.length)) return localGroups(net, communities, cachedRender(net.version));
    return r;
  }, [by], { label: 'Comparing groups' });
  // The null model is queued after the descriptive call and fills in later.
  const nul = useEngine('groups-null', () => engine.nullModel(isComm ? { stats: ['modularity'], reps, seed: 1, membership: communities?.membership } : { stats: ['attrAssortativity', 'eiIndex'], attr: by, reps, seed: 1 }), [by, reps], { label: 'Testing against rewired networks', enabled: !!res.data });

  const r = res.data;
  const name = attrLabel(ds, by);
  // A Louvain community of one is a person with no ties, not a community (N17).
  const labelOf = (v) => (isComm ? (communitySize(communities, Number(v)) > 1 ? `Community ${Number(v) + 1}` : NO_COMMUNITY) : String(v));
  // Colors as on the Network view (the same functions): communities as
  // communityColoring assigns them (matched to the grouping attribute's hues
  // where it can), attribute values by size over the whole dataset (not just
  // the people in the network), the eight largest in color and the rest in
  // the "Other groups" gray. A community of one is "no community".
  const scale = useMemo(() => {
    if (!isComm) return groupColoring(orderedValues(ds, by));
    const gc = communityColoring(ds, net, communities || { count: 0, membership: [] });
    const color = gc.color;
    return { ...gc, color: v => (communitySize(communities, Number(v)) > 1 ? color(v) : gc.missingColor), isOther: v => communitySize(communities, Number(v)) > 1 && gc.isOther(v) };
  }, [ds, net, by, isComm, communities]);
  const means = useMemo(() => groupMeans(ds, net, metrics, by, communities), [ds, net, metrics, by, communities]);
  const members = useMemo(() => groupMembers(ds, net, metrics, by, communities), [ds, net, metrics, by, communities]);
  const shownMeans = MEAN_METRICS.filter(m => metrics?.node?.[m] && ap[m]?.level !== 'na');

  const groupsSorted = r?.groups ? [...r.groups].sort((a, b) => b.size - a.size || String(a.value).localeCompare(String(b.value))) : [];
  const assort = typeof r?.assortativity === 'number' ? r.assortativity : r?.assortativity?.observed;
  const ei = typeof r?.eiIndex === 'number' ? r.eiIndex : r?.eiIndex?.observed;
  const nA = nul.data?.attrAssortativity, nE = nul.data?.eiIndex, nQ = nul.data?.modularity;
  const eiExp = !isComm && nE?.groups ? Object.fromEntries(nE.groups.map(g => [String(g.value), g])) : null;
  const colFmt = useMemo(() => {
    const f = { density: columnFormat(groupsSorted.map(g => g.density)), ei: columnFormat(groupsSorted.map(g => g.eiIndex ?? g.ei)) };
    for (const m of shownMeans) f[m] = columnFormat(groupsSorted.map(g => means?.[String(g.value)]?.[m]));
    return f;
  }, [r, means, shownMeans.join()]);

  const mixing = r?.mixing;
  const idx = mixing ? mixing.values.map(String) : [];
  const shown = groupsSorted.slice(0, 16).map(g => String(g.value)).filter(v => idx.includes(v));
  const matrix = mixing ? shown.map(a => shown.map(b => { const i = idx.indexOf(a), j = idx.indexOf(b); const src = cellMode === 'density' ? mixing.density : mixing.counts; return src?.[i]?.[j] ?? NaN; })) : [];
  const groupAp = ap.groups;

  return html`<div class="view">
    <${ViewHead} title="Groups" intro="Compare within- and between-group structure using an observed attribute or communities detected from the network. The view reports group size, internal density, within- and between-group ties, E-I index, assortativity, and comparisons with degree-preserving random networks."
      actions=${html`<${ConstructionButton} />`} />
    <div class="toolbar">
      <${Select} label="Groups from" value=${by} onChange=${v => { setBy(v); setOpenGroup(null); }} options=${[
        ...(communities ? [{ value: '__community', label: `Detected communities (${communityCounts(communities).groups})` }] : []),
        ...(attrs.length ? [{ group: 'Attributes', options: attrs.map(a => ({ value: a.key, label: `${attrLabel(ds, a.key)} (${a.values.length})` })) }] : []),
      ]} />
    </div>
    <${ShiftBanner} ds=${ds} by=${by} isComm=${isComm} name=${name} attrs=${attrs} />
    ${!attrs.length && html`<p class="small text2">Detected communities are currently the available grouping. Join an attribute table in Data to compare departments, teams, roles, or other observed groups.</p>`}
    ${groupAp && groupAp.level !== 'ok' && html`<p class="small text2"><${Flag} level=${groupAp.level} /> ${applicabilityReason(groupAp)}</p>`}
    ${res.loading && html`<${Loading}>Comparing groups</${Loading}>`}
    <${ErrorLine} error=${res.error} onRetry=${res.retry} />
    ${r && html`
      ${r.note && html`<p class="small text2">${r.note}</p>`}
      ${r.coverage != null && r.coverage < 1 && html`<p class="small text2"><${Flag} level="caution" /> ${fmtPct(r.coverage)} of people in the network have a value for ${name}; the rest are left out of these comparisons.</p>`}
      <section class="section" style="border-top:0;padding-top:.25rem" aria-labelledby="reading-h">
        <h2 id="reading-h" class="section__title">Group structure</h2>
        <${Reading} isComm=${isComm} name=${isComm ? 'community' : name.replace(/\s*\([^)]*\)$/, '').toLowerCase()} assort=${assort} ei=${ei} nA=${nA} nE=${nE} nQ=${nQ} communities=${communities} loadingNull=${nul.loading} nullError=${nul.error} meta=${nul.data?.meta} groups=${groupsSorted} />
      </section>
      <section class="section" aria-labelledby="gt-h">
        <h2 id="gt-h" class="section__title">${isComm ? 'Communities' : name}</h2>
        <div class="table-wrap"><table class="tbl">
          <thead><tr>
            <th scope="col">Group</th><th scope="col" class="num">People</th>
            <th scope="col" class="num"><${MetricName} metric="density" short=${true} showFlag=${false} /> within</th>
            <th scope="col" class="num">Ties within</th><th scope="col" class="num">Ties across</th>
            <th scope="col" class="num"><${MetricName} metric="eiIndex" showFlag=${false} /></th>
            ${eiExp && html`<th scope="col" class="num">E-I if random</th>`}
            ${shownMeans.map(m => html`<th scope="col" class="num">Mean <${MetricName} metric=${m} label=${metricLabel(m, net.directed).replace(/^./, c => c.toLowerCase())} short=${true} iconOnly=${true} /></th>`)}
          </tr></thead>
          <tbody>${groupsSorted.map(g => { const v = String(g.value); const open = openGroup === v; const mem = members[v] || []; return html`<tr>
            <td class="name"><button type="button" class="gview__rowbtn" aria-expanded=${String(open)} onClick=${() => setOpenGroup(open ? null : v)}><span class="gview__chev" aria-hidden="true"></span><span title=${scale.isOther(v) ? 'Past the eight largest groups: gray (Other groups) on the map' : undefined}><${Swatch} color=${scale.color(v)} /></span> ${labelOf(g.value)}</button></td>
            <td class="num">${fmtInt(g.size)}</td>
            <td class="num">${colFmt.density(g.density)}</td>
            <td class="num">${fmtInt(g.internalTies ?? g.internal)}</td>
            <td class="num">${fmtInt(g.externalTies ?? g.external)}</td>
            <td class="num">${colFmt.ei(g.eiIndex ?? g.ei)}</td>
            ${eiExp && html`<td class="num" title=${eiExp[v] ? `Rewired networks with the same degrees: ${colFmt.ei(eiExp[v].lo)} to ${colFmt.ei(eiExp[v].hi)} in 95% of them; ${pShort(eiExp[v].p, eiExp[v].replicates)}` : undefined}>${eiExp[v] ? colFmt.ei(eiExp[v].mean) : '–'}</td>`}
            ${shownMeans.map(m => html`<td class="num">${colFmt[m](means?.[v]?.[m])}</td>`)}
          </tr>${open && html`<tr class="gview__detail"><td colspan=${6 + (eiExp ? 1 : 0) + shownMeans.length}>
            <p class="gview__members">${mem.length ? html`${mem.slice(0, 40).map(i => nodeLabel(ds, i)).join(', ')}${mem.length > 40 ? `, and ${fmtInt(mem.length - 40)} more` : ''}.` : 'No members in the current network.'}${metrics?.node?.degree ? ' Most connected first.' : ''}</p>
            ${mem.length > 0 && html`<button type="button" class="tlink" onClick=${() => store.actions.select(mem)}>Select these ${fmtInt(mem.length)} people</button>
              <span class="small muted"> The selection carries to Network and People.</span>`}
          </td></tr>`}`; })}</tbody>
        </table></div>
        <p class="basis">Select a group to list its members. E-I index per group: ties leaving the group minus ties inside it, over all its ties (-1 entirely inward, +1 entirely outward).${eiExp ? ` E-I if random: the average over ${nE.replicates} rewired networks with the same degrees; a group well below it keeps to itself more than its size and connections explain.` : ''} Density within: share of possible ties inside the group that exist.</p>
      </section>
      ${mixing && shown.length > 1 && html`<section class="section" aria-labelledby="mx-h">
        <div class="row row--between"><h2 id="mx-h" class="section__title" style="margin:0">Mixing matrix</h2>
          <${Seg} label="Cells show" value=${cellMode} onChange=${setCellMode} options=${[{ value: 'density', label: 'Density' }, { value: 'counts', label: 'Tie counts' }]} /></div>
        <p class="small text2" style="margin:.4rem 0 .75rem">Rows send, columns receive${net.directed ? '' : ' (undirected, so the matrix is symmetric)'}. ${cellMode === 'density' ? 'Each cell is the share of possible ties between the two groups that exist.' : 'Each cell is a number of ties.'} The darkest cells, without a number, have no ties.</p>
        <${MixTable} rows=${shown.map(labelOf)} values=${matrix} mode=${cellMode} caption=${`Mixing matrix by ${isComm ? 'community' : name}: ${cellMode === 'density' ? 'tie density' : 'tie counts'} from row group to column group`} />
        ${groupsSorted.length > shown.length && html`<p class="basis">The ${shown.length} largest groups are shown.</p>`}
      </section>`}
    `}
  </div>`;
}

// The mixing matrix as a real table: values readable by screen readers, full
// group names in the headers, color as a second channel. Zero cells stay
// empty so they recede; the diagonal (within-group) cells are outlined. One
// scale from 0 to the largest cell, diagonal included: scaled to the largest
// between-group cell, a 0.833 within a group and a 0.063 between groups took
// the same full color and the contrast the matrix exists to show vanished (m12).
function MixTable({ rows, values, mode, caption }) {
  const all = [];
  values.forEach(r => r.forEach(v => { if (Number.isFinite(v) && v > 0) all.push(v); }));
  const hi = Math.max(1e-12, ...all);
  const ramp = [cssVar('--seq-zero', '#0d2a35'), ...tokens().seq];
  const interp = d3.piecewise(d3.interpolateLab, ramp);
  const color = (v) => interp(Math.max(0, Math.min(1, v / hi)));
  const fmt = mode === 'density' ? columnFormat(values.flat()) : (v) => fmtInt(v);
  const narrow = rows.length > 10;
  // Ink by the fill's lightness, so every printed value keeps its contrast.
  const ink = (v) => (d3.lab(color(v)).l > 58 ? '#051521' : 'var(--text)');
  return html`<div class="table-wrap mx-wrap">
    <table class=${`mx${narrow ? ' mx--narrow' : ''}`}>
      <caption class="visually-hidden">${caption}</caption>
      <thead><tr><td></td>${rows.map(c => html`<th scope="col"><span>${c}</span></th>`)}</tr></thead>
      <tbody>${rows.map((rname, i) => html`<tr><th scope="row" title=${rname}>${rname}</th>${values[i].map((v, j) => {
        const empty = !Number.isFinite(v) || v === 0;
        return html`<td class=${`${empty ? 'mx__zero' : ''}${i === j ? ' mx__diag' : ''}`} style=${empty ? '' : `background:${color(v)};color:${ink(v)}`} title=${`${rname} to ${rows[j]}: ${Number.isFinite(v) ? fmt(v) : 'no possible ties'}`}>
          ${empty ? html`<span class="visually-hidden">${Number.isFinite(v) ? '0' : 'none'}</span>` : narrow && i !== j ? html`<span class="visually-hidden">${fmt(v)}</span>` : fmt(v)}
        </td>`;
      })}</tr>`)}</tbody>
    </table>
    <div class="mx-legend" aria-hidden="true">
      <div><div class="ramp" style=${`background:linear-gradient(90deg,${ramp.join(',')})`}></div><div class="ramp-labels" style="max-width:12rem"><span>${mode === 'density' ? '0' : '1'}</span><span>${fmt(hi)}</span></div></div>
      <span><span class="mx-legend__diag"></span>Within the group</span>
      ${narrow && html`<span>Values between groups are in the cell tooltips and read aloud.</span>`}
    </div>
  </div>`;
}

// Verdict first, then the number in plain words, then the basis (decision 5).
function Reading({ isComm, name, assort, ei, nA, nE, nQ, communities, loadingNull, nullError, meta, groups }) {
  const sig = (x) => x && Number.isFinite(x.p) && x.p < 0.05;
  const usable = (x) => x && Number.isFinite(x.mean);
  const reps = meta?.reps ?? 200;
  const basis = (x) => `Compared with ${reps} random networks that keep everyone's number of ties (${meta?.model || 'degree-preserving rewiring'}, seed ${meta?.seed ?? 1})${x ? `; z ${fmtNum(x.z, { digits: 2 })}` : ''}; two-sided p, where the smallest possible is 1/${reps + 1}.`;
  const out = [];
  if (isComm) {
    if (communities) {
      const head = `The network splits into ${communityWords(communities)} (modularity ${fmtNum(communities.modularity)}).`;
      if (usable(nQ)) {
        const real = sig(nQ) && nQ.observed > nQ.mean;
        out.push(html`<${Verdict} level=${real ? null : 'info'}
          verdict=${real ? `${head} The split is cleaner than in random networks with the same numbers of ties.` : `${head} The split is not clearly cleaner than in random networks with the same numbers of ties; the communities are one of many comparable partitions.`}
          plain=${html`On the ties alone, ignoring weights, the best split found scores ${fmtNum(nQ.observed)}; the same search on random networks with the same numbers of ties scores ${fmtNum(nQ.mean)} on average, and ${nullInWords(nQ.p, nQ.replicates ?? reps)}. (Modularity values above about 0.3 are often read as clear community structure, but randomized networks can reach such values too, so the comparison re-runs the search on each.)`}
          details=${`${basis(nQ)} Community detection (Louvain) is re-run on every random network.`} />`);
      } else out.push(html`<p class="verdict__claim">${head}</p>`);
    }
  } else {
    if (Number.isFinite(assort)) {
      const plain = assort > 0.3 ? `People tie mostly within their ${name}` : assort > 0.05 ? `People tie somewhat more within their ${name} than across` : assort < -0.05 ? `People tie more across ${name} lines than within` : `Ties mostly ignore ${name}`;
      const scale = `Assortativity ${fmtNum(assort)} (1 means every tie stays within a group, 0 means ties ignore ${name})`;
      if (nA && !usable(nA)) out.push(html`<${Verdict} verdict=${`${plain}.`} plain=${`${scale}. There are too few ties between people with a value to compare with random networks, so no test is reported.`} />`);
      else if (usable(nA)) {
        out.push(html`<${Verdict} level=${sig(nA) ? null : 'info'}
          verdict=${sig(nA) ? `${plain}: ${Math.abs(nA.z) >= 4 ? 'far ' : ''}more ${nA.observed > nA.mean ? 'within' : 'across'} than random networks with the same numbers of ties give.` : `${plain}, but no more than random networks with the same numbers of ties give; the observed mixing by ${name} is consistent with the random-network comparison.`}
          plain=${html`${scale}; random networks with the same numbers of ties give ${fmtNum(nA.mean)} on average, and ${nullInWords(nA.p, nA.replicates ?? reps)}.`} />`);
      } else out.push(html`<${Verdict} verdict=${`${plain}.`} plain=${`${scale}.`} />`);
    }
    if (Number.isFinite(ei)) {
      const lean = ei < -0.2 ? 'Most ties stay inside groups' : ei > 0.2 ? 'Most ties cross groups' : 'Ties are split between staying inside and crossing groups';
      const outward = (groups || []).filter(g => Number.isFinite(g.eiIndex) && g.eiIndex > 0 && g.size > 1).map(g => String(g.value));
      const exp = new Map((nE?.groups || []).map(g => [String(g.value), g]));
      const stillIn = outward.length && outward.every(v => exp.get(v) && exp.get(v).mean > (groups.find(g => String(g.value) === v)?.eiIndex ?? Infinity));
      const names = `${outward.slice(0, 4).join(', ')}${outward.length > 4 ? ` and ${outward.length - 4} more` : ''}`;
      const notAll = ei < 0 && outward.length ? ` Not every group keeps to itself: ${names} ${outward.length === 1 ? 'has' : 'have'} more ties out than in${stillIn ? ', though fewer than random networks give (see E-I if random in the table)' : ''}.` : '';
      out.push(html`<${Verdict}
        verdict=${usable(nE) ? `${lean}, ${chanceWords(nE.z, { more: 'more outward', less: 'more inward' })} for groups of these sizes.${notAll}` : `${lean}.${notAll}`}
        plain=${html`Overall <${Term} k="eiIndex">E-I index</${Term}> ${fmtNum(ei)} (-1 all inside, +1 all across)${usable(nE) ? html`; random networks with the same numbers of ties give ${fmtNum(nE.mean)}, and ${nullInWords(nE.p, nE.replicates ?? reps)}` : ''}. Larger groups have more possible within-group ties, so the E-I index is interpreted relative to the random value.`}
        details=${(usable(nA) || usable(nE)) ? basis(usable(nE) ? nE : nA) : null} />`);
    }
  }
  return html`<div class="reading">
    ${out}
    ${loadingNull && html`<p class="small muted"><span class="spinner"></span> Comparing with ${reps} random networks; the numbers above are final, the comparison fills in when it is done.</p>`}
    ${nullError && html`<p class="small"><${Flag} level="error" /> Comparison with random networks failed: ${nullError.message}</p>`}
    ${!isComm && html`<${HowToRead} means="E-I index summarizes the balance between ties within a group and ties crossing its boundary. Assortativity summarizes the tendency for ties to connect people with the same group value."
      scale="E-I ranges from -1 for entirely within-group ties to +1 for entirely between-group ties. The random-network comparison accounts for group sizes and each person’s number of ties."
      example=${groupExample(name, ei, assort, nE, nA, usable)}
      mistake="Group size affects the number of possible within-group ties. Interpret E-I and assortativity relative to the random-network comparison, particularly when groups differ substantially in size." />`}
  </div>`;
}

// The live sentence for the Interpretation note: the observed E-I index and
// assortativity for this grouping, each beside its random-network mean when
// the comparison has run.
function groupExample(name, ei, assort, nE, nA, usable) {
  const parts = [];
  if (Number.isFinite(ei)) parts.push(`the E-I index is ${fmtNum(ei)}${usable(nE) ? ` (random-network mean ${fmtNum(nE.mean)})` : ''}`);
  if (Number.isFinite(assort)) parts.push(`assortativity is ${fmtNum(assort)}${usable(nA) ? ` (random-network mean ${fmtNum(nA.mean)})` : ''}`);
  if (!parts.length) return null;
  return `Grouped by ${name}, ${parts.join(' and ')}.`;
}

// When the Time view's shift scan finds a change, Groups says so before any
// whole-period number: a silo that formed halfway hides in the average (J2).
// One click compares the E-I index and crossing ties before and after.
function ShiftBanner({ ds, by, isComm, name, attrs }) {
  const timed = useMemo(() => Number.isFinite(timeExtent(ds)[0]), [ds]);
  const dense = useMemo(() => (timed ? suggestTimeRange(ds) : null), [ds, timed]);
  const range = dense ? { start: dense.start, end: dense.end } : { start: null, end: null };
  const ap = useStore(s => s.applicability?.detectShifts);
  const enabled = timed && ap?.level !== 'na';
  const { series, shifts, groupAttr } = useTimeShifts(ds, { range, enabled });
  const sh = groupShift(shifts.data?.shifts);
  const attr = isComm ? (groupAttr && attrs.some(a => a.key === groupAttr) ? groupAttr : null) : by;
  const [ran, setRan] = useState(null);
  const q = useEngine('groups-ba', () => engine.beforeAfter(ran.date, { metrics: [], attr: ran.attr, start: range.start ?? undefined, end: range.end ?? undefined }), [ran?.date, ran?.attr, range.start, range.end], { enabled: !!ran, label: 'Comparing groups before and after' });
  if (!enabled || !sh) return null;
  const unit = shifts.data?.meta?.window || series.data?.meta?.window;
  const what = sh.metric === 'crossGroupShare' ? `the share of ties crossing ${humanize(sh.label.replace(/^cross-| share of ties$/g, '')).toLowerCase()} lines` : humanize(sh.label).toLowerCase();
  const mix = q.data?.mixing;
  const fmtV = (v) => (sh.metric === 'crossGroupShare' ? fmtPct(v) : fmtNum(v));
  const gName = attr ? attrLabel(ds, attr).toLowerCase() : name;
  return html`<div class="notice-line gview__shift" role="note">
    <${Flag} level="caution" />
    <div class="grow">
      <p><strong>The network changed partway through.</strong> Time found a ${sh.direction === 'up' ? 'rise' : 'drop'} in ${what}, from a typical ${fmtV(sh.baseline)} ${changeWords(sh, unit, fmtV)}${sh.metric === 'crossGroupShare' ? ` (measured in each ${unit || 'window'}'s own network; the before-and-after comparison pools each period, see its note)` : ''}.${persistWords(sh, unit) ? ` ${persistWords(sh, unit)}` : ''} The numbers below cover the whole period, so they mix before and after.</p>
      ${attr ? html`<p class="gview__shift-acts"><button type="button" class="tlink" disabled=${q.loading} onClick=${() => setRan({ date: sh.start, attr })}>Compare ${gName} mixing before and after ${fmtDate(sh.start)}</button>
        <a class="tlink tlink--arrow" href="#time" onClick=${e => { e.preventDefault(); store.actions.setView('time'); }}>See it in Time</a></p>` : html`<p class="small"><a class="tlink tlink--arrow" href="#time" onClick=${e => { e.preventDefault(); store.actions.setView('time'); }}>See it in Time</a></p>`}
      ${q.loading && html`<${Loading}>Building the networks before and after</${Loading}>`}<${ErrorLine} error=${q.error} />
      ${mix && html`<div class="table-wrap"><table class="tbl gview__shift-tbl">
          <thead><tr><th scope="col">By ${gName}</th><th scope="col" class="num">Before ${fmtDate(q.data.date)}</th><th scope="col" class="num">After</th></tr></thead>
          <tbody>
            <tr><td><${Term} k="eiIndex">E-I index</${Term}></td><td class="num">${fmtNum(mix.before.eiIndex)}</td><td class="num">${fmtNum(mix.after.eiIndex)}</td></tr>
            <tr><td>Ties crossing groups (share of the period's ties)</td><td class="num">${fmtPct(mix.before.crossShare)}</td><td class="num">${fmtPct(mix.after.crossShare)}</td></tr>
            <tr><td>Ties with both ends in a group</td><td class="num">${fmtInt(mix.before.coded)}</td><td class="num">${fmtInt(mix.after.coded)}</td></tr>
          </tbody></table></div>
        <p class="small">${Number.isFinite(mix.p) && mix.p < 0.05 ? `Ties ${mix.diff < 0 ? 'turned inward' : 'turned outward'} after the date, unlikely by chance (${pShort(mix.p, mix.reps)}).` : `No clear change in mixing at this date${Number.isFinite(mix.p) ? ` (${pShort(mix.p, mix.reps)})` : ''}.`} Periods of ${Math.round(q.data.span / 86400000)} days either side, each pooled into one network: crossing ties are the share of that network's ties (with both ends in a ${gName}) that join two different ${gName}s, and E-I is the same split (E-I = 2 × share − 1). Pooling more ${unit || 'window'}s collects more of the rare crossing ties, so these shares run higher than single ${unit || 'window'}s in Time. Messages on the date count as after.</p>
`}
      ${attr && html`<p class="small text2">${snapshotNote(ds, attr, attrLabel(ds, attr))}</p>`}
    </div>
  </div>`;
}

function groupOf(ds, net, by, communities, v) {
  const g = by === '__community' ? communities?.membership[v] : ds.nodes.attrs[net.nodeIds[v]]?.[by];
  return g == null || g === '' ? null : String(g);
}

function groupMeans(ds, net, metrics, by, communities) {
  if (!metrics?.node) return null;
  const out = {};
  for (let v = 0; v < net.nodeIds.length; v++) {
    const g = groupOf(ds, net, by, communities, v);
    if (g == null) continue;
    const o = out[g] ||= { __n: {} };
    for (const m of MEAN_METRICS) {
      const x = metrics.node[m]?.[v];
      if (!Number.isFinite(x)) continue;
      o[m] = (o[m] || 0) + x; o.__n[m] = (o.__n[m] || 0) + 1;
    }
  }
  for (const o of Object.values(out)) for (const m of MEAN_METRICS) if (o.__n[m]) o[m] /= o.__n[m];
  return out;
}

// Dataset node indices per group, most connected first.
function groupMembers(ds, net, metrics, by, communities) {
  const out = {};
  const deg = metrics?.node?.degree;
  for (let v = 0; v < net.nodeIds.length; v++) {
    const g = groupOf(ds, net, by, communities, v);
    if (g == null) continue;
    (out[g] ||= []).push(v);
  }
  for (const g of Object.keys(out)) {
    out[g].sort((a, b) => (deg ? deg[b] - deg[a] : 0) || String(nodeLabel(ds, net.nodeIds[a])).localeCompare(String(nodeLabel(ds, net.nodeIds[b]))));
    out[g] = out[g].map(v => net.nodeIds[v]);
  }
  return out;
}

// Community table from tie counts when the engine has no grouping for
// communities. Counting only; no statistics are computed here.
function localGroups(net, communities, render) {
  if (!communities || !render) return { groups: [], mixing: null };
  const k = communities.count;
  const m = communities.membership;
  const size = new Array(k).fill(0); for (const c of m) if (c >= 0) size[c]++;
  const counts = Array.from({ length: k }, () => new Array(k).fill(0));
  let I = 0, E = 0;
  const ni = render.netIndex;
  for (let e = 0; e < render.src.length; e++) {
    const a = m[ni[render.src[e]]], b = m[ni[render.dst[e]]];
    counts[a][b]++; if (!net.directed && a !== b) counts[b][a]++;
    if (a === b) I++; else E++;
  }
  const possible = (a, b) => (a === b ? (net.directed ? size[a] * (size[a] - 1) : size[a] * (size[a] - 1) / 2) : size[a] * size[b]);
  const density = counts.map((row, a) => row.map((c, b) => (possible(a, b) ? c / possible(a, b) : NaN)));
  const groups = size.map((s, a) => { let ext = 0; for (let b = 0; b < k; b++) if (b !== a) ext += counts[a][b] + (net.directed ? counts[b][a] : 0); const int = counts[a][a]; return { value: String(a), size: s, internalTies: int, externalTies: ext, density: density[a][a], eiIndex: int + ext ? (ext - int) / (ext + int) : NaN }; });
  return { attr: '__community', groups, mixing: { values: groups.map(g => g.value), counts, density }, assortativity: NaN, eiIndex: I + E ? (E - I) / (E + I) : NaN };
}
