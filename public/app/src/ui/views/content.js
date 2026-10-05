// Content view: what people wrote, measured without an LLM. Affect by source,
// group, person, layer or month (lexicon-based, marked approximate, with
// coverage), distinctive keywords by group, topics with their top terms and
// shares, and a diffusion explorer for terms: adoption over time and the
// cascade along ties, compared with a null in which adoption times are
// shuffled.
//
// Text is cleaned in the engine first (quoted replies, signatures, the names
// of people in the data; see content/corpus.js) and the view says so.

import { html, useState, useMemo, useRef } from '../../../vendor/preact.js';
import { useStore } from '../store.js';
import { engine } from '../services/engine.js';
import { ViewHead, NeedsData, Loading, ErrorLine, Select, ConstructionButton, useEngine, Flag, applicabilityReason, Term, HowToRead, nullInWords } from '../components/common.js';
import { tokens } from '../lib/palette.js';
import { hasText, textCoverage, label as nodeLabel } from '../lib/dsutil.js';
import { fmtNum, fmtInt, fmtPct, fmtDate, humanize, columnFormat } from '../lib/format.js';
import { suggestTimeRange } from '../../analysis/time.js';
import { defaultGrouping } from '../../analysis/groups.js';
import { TimeChart, cool, warm, fmtMonth } from './time.js';
import { attrLabel, groupingAttributes } from './groups.js';

const FEW = 20; // months or groups with fewer scored messages are shown faint

export function ContentView() {
  const ds = useStore(s => s.dataset);
  const net = useStore(s => s.network);
  if (!ds || !net) return html`<${NeedsData} title="Content" />`;
  if (!hasText(ds)) {
    return html`<div class="view view--col"><${ViewHead} title="Content" />
      <div class="empty"><h2>This data has no message text</h2>
      <p class="lead">Content measures require message text. The loaded sources record interactions but not their content (surveys, calendars, network files, or exports without message bodies).</p></div></div>`;
  }
  return html`<${ContentInner} ds=${ds} />`;
}

const TABS = [['affect', 'Tone'], ['keywords', 'Keywords'], ['topics', 'Topics'], ['diffusion', 'Diffusion']];

function ContentInner({ ds }) {
  const [tab, setTab] = useState('affect');
  const coverage = useMemo(() => textCoverage(ds), [ds]);
  const refs = useRef({});
  // Tabs pattern: one tab stop, arrows move between tabs, Home and End jump.
  const onKey = (e) => {
    const i = TABS.findIndex(([id]) => id === tab);
    let j = null;
    if (e.key === 'ArrowRight') j = (i + 1) % TABS.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + TABS.length) % TABS.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = TABS.length - 1;
    if (j == null) return;
    e.preventDefault();
    setTab(TABS[j][0]);
    refs.current[TABS[j][0]]?.focus();
  };
  return html`<div class="view">
    <${ViewHead} title="Content" intro=${`This view analyzes message text locally using lexicon, term-frequency, topic, and diffusion methods. It reports tone, distinctive words, recurring topics, and the spread of terms along observed ties. ${fmtPct(coverage)} of messages contain text.`} actions=${html`<${ConstructionButton} />`} />
    <div class="tabs" role="tablist" aria-label="Content measures" onKeyDown=${onKey}>
      ${TABS.map(([id, l]) => html`<button type="button" role="tab" id=${`ct-tab-${id}`} aria-controls="ct-panel" aria-selected=${String(tab === id)} tabindex=${tab === id ? '0' : '-1'} ref=${el => { refs.current[id] = el; }} onClick=${() => setTab(id)}>${l}</button>`)}
    </div>
    <div role="tabpanel" id="ct-panel" aria-labelledby=${`ct-tab-${tab}`} tabindex="0">
      ${tab === 'affect' && html`<${Affect} ds=${ds} />`}
      ${tab === 'keywords' && html`<${Keywords} ds=${ds} />`}
      ${tab === 'topics' && html`<${Topics} />`}
      ${tab === 'diffusion' && html`<${Diffusion} ds=${ds} />`}
    </div>
  </div>`;
}

// ---- grouping choices -----------------------------------------------------------------

function sourceFormats(ds) { return new Set((ds.meta?.sources || []).map(s => s.format)); }

function byOptions(ds, { overall = true } = {}) {
  return [
    ...(sourceFormats(ds).size > 1 ? [{ value: 'source', label: 'Source (kind of export)' }] : []),
    ...groupingAttributes(ds).map(a => ({ value: `attr:${a.key}`, label: attrLabel(ds, a.key) })),
    { value: 'node', label: 'Person (most active)' },
    { value: 'window', label: 'Month' },
    { value: 'visibility', label: 'Visibility layer' },
    ...(overall ? [{ value: 'overall', label: 'Everyone together' }] : []),
  ];
}

// The comparison a view opens on: kinds of export when several are mixed
// (one person's mail vs their chats), else a department-like attribute,
// else everyone (or people, for keywords, where one unit has nothing to
// contrast).
function defaultBy(ds, fallback) {
  if (sourceFormats(ds).size > 1) return 'source';
  const g = defaultGrouping(ds);
  if (g && groupingAttributes(ds).some(a => a.key === g)) return `attr:${g}`;
  return fallback;
}

// UI choice -> engine options ({ by: 'group', attr } | { by: 'window', window } | { by }).
function byOpts(choice) {
  if (choice.startsWith('attr:')) return { by: 'group', attr: choice.slice(5) };
  if (choice === 'window') return { by: 'window', window: 'month' };
  return { by: choice };
}
const rowLabel = (g) => String(g.label ?? g.value ?? g.key);
const byLabel = (ds, choice) => (choice.startsWith('attr:') ? attrLabel(ds, choice.slice(5)).toLowerCase() : { window: 'month', visibility: 'visibility layer', source: 'source', node: 'person', overall: 'everyone' }[choice] || choice);

function CleaningNote({ c }) {
  if (!c || !(c.quoted || c.signatures || c.nameWords)) return null;
  return html`<p class="small muted cview__note">Before counting words, quoted replies were removed from ${fmtInt(c.quoted)} message${c.quoted === 1 ? '' : 's'} and signatures from ${fmtInt(c.signatures)}. Weekdays, months and ${fmtInt(c.nameWords)} words that name people in the data (name parts, mail domains) are not counted.</p>`;
}

// Horizontal bars with the value beside the bar end. rows: [{ label, value, n?, color, faint? }].
// diverging: bars grow left or right of a center line.
function Bars({ rows, title, sub, format, max, diverging = false, nLabel = 'messages' }) {
  const mx = max ?? Math.max(1e-12, ...rows.map(r => Math.abs(r.value)).filter(Number.isFinite));
  return html`<figure class="chart" style="margin:0">
    ${title && html`<figcaption><div class="chart__title">${title}</div>${sub && html`<div class="chart__sub">${sub}</div>`}</figcaption>`}
    <ul class="bars">${rows.map(r => {
      const v = r.value;
      const w = Number.isFinite(v) ? Math.min(1, Math.abs(v) / mx) * (diverging ? 50 : 100) : 0;
      const pos = diverging ? (v >= 0 ? `left:50%;width:${w}%;border-radius:0 4px 4px 0` : `right:50%;width:${w}%;border-radius:4px 0 0 4px`) : `left:0;width:${w}%;border-radius:0 4px 4px 0`;
      return html`<li title=${`${r.label}: ${format(v)}${r.n != null ? `, ${fmtInt(r.n)} ${nLabel}` : ''}`}>
        <span class="bars__label">${r.label}${r.n != null ? html` <span class="bars__n">${fmtInt(r.n)}</span>` : ''}</span>
        <span class="bars__track">${diverging && html`<span class="bars__axis"></span>`}<span class="bars__bar" style=${`${pos};background:${r.color};${r.faint ? 'opacity:.4' : ''}`}></span></span>
        <span class="bars__val">${format(v)}</span>
      </li>`;
    })}</ul>
  </figure>`;
}

// ---- affect -----------------------------------------------------------------------------

function Affect({ ds }) {
  const [by, setBy] = useState(() => defaultBy(ds, 'overall'));
  const ap = useStore(s => s.applicability?.affect);
  const dense = useMemo(() => suggestTimeRange(ds), [ds]);
  const q = useEngine('affect', (ctl) => engine.affect({ ...byOpts(by), ...(by === 'node' ? { minMessages: FEW } : {}), ...ctl }), [by], { label: 'Scoring message tone' });
  const t = tokens();
  const r = q.data;
  let groups = r?.groups || (r?.by ? Object.values(r.by)[0] : []) || [];
  const cov = r?.coverage;
  const covered = groups.reduce((s, g) => s + (g.n || 0), 0);
  if (by === 'node') groups = groups.slice(0, 15);
  const scored = cov?.scored ?? null;
  const seFmt = { mean: columnFormat(groups.map(g => g.mean)), se: columnFormat(groups.map(g => g.se)) };
  const toneColor = (m) => (m >= 0 ? cool() : warm());
  // Months: thin months are faint and left out of the line; the dense period
  // sets the axis so a stray 2008 message does not flatten the rest.
  const monthPts = groups.map(g => ({ x: typeof g.key === 'number' ? g.key : Date.parse(`${g.label}-01T00:00:00Z`), y: g.mean, n: g.n, faint: g.n < FEW }));
  const inDense = dense ? monthPts.filter(p => p.x >= dense.start - 31 * 86400000 && p.x < dense.end) : monthPts;
  const outside = monthPts.length - inDense.length;
  return html`<div>
    <div class="toolbar"><${Select} label="Compare by" value=${by} onChange=${setBy} options=${byOptions(ds)} /></div>
    <p class="small text2 cview__note"><${Flag} level="caution">Approximate</${Flag}> Tone is estimated with VADER (Hutto & Gilbert, 2014), which assigns each message a score from -1 to +1 using a lexicon and rules for negation and emphasis. Estimates are most informative in aggregate. Sarcasm, domain-specific language, and non-English text can reduce validity.${cov?.likelyNonEnglish ? ` ${fmtInt(cov.likelyNonEnglish)} messages appear to be non-English.` : ''}${ap?.level === 'na' ? ` ${applicabilityReason(ap)}` : ''}</p>
    <p class="small text2 cview__note">Quoted replies and signatures are removed where they can be identified${cov?.quotedRemoved ? ` (quoted text in ${fmtInt(cov.quotedRemoved)} messages here)` : ''}. Words corresponding to people in the dataset are also excluded from the text used for keyword, topic, and diffusion analyses.</p>
    ${r && scored != null && html`<p class="small cview__note">${covered < scored
      ? html`${covered < 0.9 * scored ? html`<${Flag} level="caution" /> ` : ''}This comparison covers ${fmtInt(covered)} of ${fmtInt(scored)} scored messages${by.startsWith('attr:') ? `: only messages from people with a ${byLabel(ds, by)} value count` : by === 'node' ? `: people with at least ${FEW} messages, the 15 most active shown` : by === 'window' ? ': messages without a date are left out' : ''}${by.startsWith('attr:') || by === 'node' ? '' : '; messages from bots are never counted'}.`
      : `This comparison covers all ${fmtInt(scored)} scored messages.`}</p>`}
    ${q.loading && html`<${Loading}>Scoring messages</${Loading}>`}<${ErrorLine} error=${q.error} onRetry=${q.retry} />
    ${r && (by === 'window'
      ? html`<div style="max-width:56rem"><${TimeChart} title="Mean tone by month" sub=${`Mean score of the month's messages. Hollow points are months with fewer than ${FEW} messages; they are not joined to the line.${outside ? ` ${fmtInt(outside)} month${outside === 1 ? '' : 's'} outside the busy period (${fmtDate(dense.start)} to ${fmtDate(dense.end)}) are in the table only.` : ''}`}
          series=${[{ id: 'a', label: 'Tone', color: t.cat[0], values: inDense }]} height=${220} xName=${fmtMonth} unit="month" yFormat=${x => fmtNum(x, { digits: 2 })} yDomain=${[-1, 1]} nLabel="messages" tableLabel="Show every month as a table" /></div>`
      : html`<div style="max-width:52rem"><${Bars} diverging=${true} title=${`Mean tone by ${byLabel(ds, by)}`} sub=${`Blue bars, right of the line, lean positive; red bars, left of it, lean negative. The small number is the count of messages; faint bars rest on fewer than ${FEW}.`}
          rows=${groups.map(g => ({ label: rowLabel(g), value: g.mean, n: g.n, faint: g.n < FEW, color: toneColor(g.mean) }))} max=${Math.max(0.05, ...groups.map(g => Math.abs(g.mean)).filter(Number.isFinite))} format=${x => fmtNum(x, { digits: 2 })} /></div>`)}
    ${r && html`<div class="table-wrap" style="margin-top:1rem;max-width:52rem"><table class="tbl">
      <thead><tr><th scope="col">${humanize(byLabel(ds, by))}</th><th scope="col" class="num">Mean</th><th scope="col" class="num">Std. error</th><th scope="col" class="num">Messages scored</th><th scope="col" class="num">Positive</th><th scope="col" class="num">Negative</th></tr></thead>
      <tbody>${groups.map(g => html`<tr><td class="name">${by === 'window' ? fmtMonth(typeof g.key === 'number' ? g.key : Date.parse(`${g.label}-01T00:00:00Z`)) : rowLabel(g)}</td><td class="num">${seFmt.mean(g.mean)}</td><td class="num">${seFmt.se(g.se)}</td><td class="num">${fmtInt(g.n)}</td><td class="num">${fmtPct(g.posShare)}</td><td class="num">${fmtPct(g.negShare)}</td></tr>`)}</tbody>
    </table></div>`}
  </div>`;
}

// ---- keywords ---------------------------------------------------------------------------

function Keywords({ ds }) {
  const [by, setBy] = useState(() => defaultBy(ds, 'node'));
  const q = useEngine('keywords', (ctl) => engine.keywords({ ...byOpts(by), k: 10, ...ctl }), [by], { label: 'Finding distinctive words' });
  const units = q.data?.units || q.data?.groups || [];
  return html`<div>
    <div class="toolbar"><${Select} label="Distinctive words by" value=${by} onChange=${setBy} options=${byOptions(ds, { overall: false })} /></div>
    <p class="small text2 cview__note">Distinctive words are identified with <${Term} k="tfidf">TF-IDF</${Term}>. A term receives a higher score when it is common within one group and comparatively uncommon across the others. The comparison can be made across sources, groups, people, time periods, or visibility layers where the data support those distinctions.</p>
    <${CleaningNote} c=${q.data?.meta?.cleaning} />
    ${q.loading && html`<${Loading}>Counting words</${Loading}>`}<${ErrorLine} error=${q.error} onRetry=${q.retry} />
    ${q.data && !units.length && html`<p class="small text2">Not enough text per group to find distinctive words.</p>`}
    ${q.data && html`<div class="grid-3">${units.slice(0, 30).map(g => html`<div>
      <h3 class="label">${by === 'window' && typeof g.key === 'number' ? fmtMonth(g.key) : rowLabel(g)}</h3>
      <ol style="margin:0;padding-left:1.2rem;color:var(--text-2);font-size:.875rem">${(g.terms || []).map(t => html`<li><span style="color:var(--text)">${t.term}</span> <span class="muted small">${fmtInt(t.count)}</span></li>`)}</ol>
    </div>`)}</div>`}
  </div>`;
}

// ---- topics -----------------------------------------------------------------------------

function Topics() {
  const [k, setK] = useState(6);
  const q = useEngine('topics', (ctl) => engine.topics({ k, seed: 1, ...ctl }), [k], { label: 'Fitting topics' });
  const t = tokens();
  const r = q.data;
  const terms = (tp) => (tp.terms || []).map(x => (typeof x === 'string' ? x : x.term));
  const top = Math.max(1e-9, ...(r?.topics || []).map(tp => tp.share));
  return html`<div>
    <div class="toolbar"><${Select} label="Number of topics" value=${String(k)} onChange=${v => setK(Number(v))} options=${[4, 6, 8, 10, 12].map(n => ({ value: String(n), label: String(n) }))} /></div>
    <p class="small text2 cview__note">Topic analysis identifies recurring patterns of terms in the message corpus. Each topic is represented by its most strongly associated terms and by its share of the analyzed text. The number of topics can be changed to examine broader or finer partitions of the corpus.</p>
    <p class="basis">A <${Term} k="topics">topic model</${Term}> (latent Dirichlet allocation${r?.meta?.documents ? `, ${fmtInt(r.meta.documents)} messages` : ''}, <${Term} k="randomSeed">random seed</${Term}> ${r?.meta?.seed ?? 1}). Topics are clusters of co-occurring terms; any label given to a topic is an interpretation of its terms. A different number of topics or random seed gives a different partition.</p>
    <${CleaningNote} c=${r?.meta?.cleaning} />
    ${q.loading && html`<${Loading}>Fitting topics</${Loading}>`}<${ErrorLine} error=${q.error} onRetry=${q.retry} />
    ${r && html`<div style="max-width:52rem"><${Bars} title="Share of words by topic" sub="Bars are scaled to the largest topic."
      rows=${(r.topics || []).map((tp, i) => ({ label: `${i + 1}. ${terms(tp).slice(0, 4).join(', ')}`, value: tp.share, color: t.cat[0] }))} format=${x => fmtPct(x)} max=${top} /></div>
      <div class="grid-3" style="margin-top:1.25rem">${(r.topics || []).map((tp, i) => html`<div><h3 class="label">Topic ${i + 1} · ${fmtPct(tp.share)}</h3><p class="small text2">${terms(tp).join(', ')}</p></div>`)}</div>`}
  </div>`;
}

// ---- diffusion --------------------------------------------------------------------------

// The verdict uses the Holm-adjusted p (pAdj) when several words were
// tested, and says "inconclusive" when the shuffled baseline leaves the test
// little room (N8), whatever p is.
function verdictOf(ex, room) {
  if (!ex || !Number.isFinite(ex.observed)) return { level: 'na', label: 'Too few adopters', text: 'Too few adopters to compare with shuffled timing.' };
  if (room) return { level: 'caution', label: 'Inconclusive', text: 'The shuffled baseline is already so high that the test cannot tell spread along ties from chance.' };
  if ((ex.pAdj ?? ex.p) < 0.05 && ex.observed > ex.mean) return { level: 'ok', label: 'Follows ties', text: 'Adopters had an earlier adopter among their contacts more often than shuffled timing gives. That fits spread along ties, though shared channels or outside events can produce the same pattern.' };
  return { level: 'info', label: 'No evidence of spread', text: 'Adopters had an earlier adopter among their contacts no more often than shuffled timing gives, so the data do not show this word spreading along ties.' };
}

// N8: when most adopters would have an earlier-adopting contact anyway, the
// test has little room. ceiling and zMax come from the engine; computed here
// for results without them (the demo engine).
function roomOf(ex) {
  if (!ex || !Number.isFinite(ex.mean)) return null;
  const zMax = Number.isFinite(ex.zMax) ? ex.zMax : ex.sd > 0 ? (1 - ex.mean) / ex.sd : NaN;
  const ceiling = ex.ceiling ?? ex.mean >= 0.85;
  return ceiling ? { zMax } : null;
}

function Diffusion({ ds }) {
  const [input, setInput] = useState('');
  const [terms, setTerms] = useState(null);
  // Opens on words found automatically: the beginner path needs no typing (L21).
  const [auto, setAuto] = useState(true);
  const gen = useStore(s => s.generated);
  const q = useEngine('diffusion', (ctl) => engine.diffusion({ ...(auto ? { auto: 8 } : { terms }), reps: 200, seed: 1, ...ctl }), [terms, auto], { enabled: auto || !!terms?.length, label: 'Tracing diffusion' });
  const t = tokens();
  const list = Array.isArray(q.data) ? q.data : q.data?.terms || [];
  const norm = (d) => {
    const ex = d.exposure || (d.null ? { observed: d.exposedShare, mean: d.null.mean, sd: d.null.sd, z: d.null.z, p: d.null.pUpper, pAdj: d.null.pAdjusted, reps: d.null.reps, zMax: d.null.zMax, ceiling: d.null.ceiling } : null);
    const timeline = d.timeline || (d.adoptions || []).map((a, i) => ({ t: a.t, cumulative: i + 1 }));
    const cascade = d.cascade && Array.isArray(d.cascade) ? d.cascade : (d.adoptions || []).filter(a => a.from != null).map(a => ({ from: a.from, to: a.node, t: a.t }));
    return { ...d, ex, timeline, cascade };
  };
  const items = list.map(norm);
  // One y-axis for every small chart, so their heights compare.
  const yMax = Math.max(1, ...items.map(d => d.adopters || 0));
  const xs = items.flatMap(d => d.timeline.map(p => p.t)).filter(Number.isFinite);
  const xDomain = xs.length ? [Math.min(...xs), Math.max(...xs)] : null;
  const anyCeiling = items.some(d => roomOf(d.ex));
  const nTested = items.filter(d => Number.isFinite(d.ex?.pAdj)).length;
  return html`<div>
    <p class="small text2 cview__tabintro">Diffusion analysis traces when a term first appears for each person and asks how often adoption follows earlier use by one of that person’s contacts. Adoption times are shuffled to provide a comparison distribution while holding the observed network and set of adopters fixed.</p>
    <p class="small text2 cview__tabintro">The resulting comparison reports the observed share of adopters with prior exposure through a contact alongside the corresponding share under shuffled adoption times. ${auto ? 'The terms shown were selected automatically: terms absent from the first tenth of the period, excluding common English words, ranked by number of adopters. Other terms can be traced below.' : ''} When several terms are tested, p values are adjusted for multiple comparisons (Holm’s method).</p>
    <form class="toolbar" onSubmit=${e => { e.preventDefault(); const ts = input.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).slice(0, 6); if (ts.length) { setAuto(false); setTerms(ts); } }}>
      <label class="field field--grow"><span>Words to trace (comma separated)</span><input class="input" value=${input} onInput=${e => setInput(e.currentTarget.value)} placeholder="for example: roadmap, offsite" /></label>
      <button class="btn btn--primary" type="submit">Trace</button>
      <button class="tlink" type="button" aria-pressed=${String(auto)} onClick=${() => { setTerms(null); setAuto(true); }}>Find new words automatically</button>
    </form>
    <p class="small muted cview__note">Names of people in the data are not traced.${gen ? ' The recovery check evaluates diffusion against the underlying generated ties. This view uses ties reconstructed from the observed records, so the two analyses can differ when the observation process omits ties.' : ''}</p>
    ${q.loading && html`<${Loading}>Tracing adoption</${Loading}>`}<${ErrorLine} error=${q.error} onRetry=${q.retry} />
    ${q.data && !items.length && html`<p class="small text2">No new word was used by enough people to trace.</p>`}
    ${items.length > 0 && html`<div class="diff-grid">${items.map(d => { const room = roomOf(d.ex); const v = verdictOf(d.ex, room); return html`<section class="diff-card" aria-label=${`Diffusion of ${d.term}`}>
      <h3>"${d.term}"</h3>
      ${!d.adopters ? html`<p class="small text2">Nobody in the data used this word.</p>` : html`
        <p class="small"><${Flag} level=${v.level}>${v.label}${room ? ' (little room)' : ''}</${Flag}></p>
        <p class="small text2">${fmtPct(d.ex?.observed)} of adopters had an earlier adopter among their contacts, against ${fmtPct(d.ex?.mean)} with shuffled timing; ${nullInWords(d.ex?.p, d.ex?.reps, { what: 'shuffled timelines', sided: 'upper' })}${nTested > 1 && Number.isFinite(d.ex.pAdj) ? `; corrected for ${nTested} words tested (Holm), p = ${d.ex.pAdj.toFixed(3)}` : ''}.</p>
        ${room && html`<p class="small diff-card__room"><${Flag} level="caution" /> Little room to test: even with shuffled timing ${fmtPct(d.ex.mean)} of adopters have an earlier adopter among their contacts${Number.isFinite(room.zMax) ? `, so the strongest result possible, 100%, would be only z = ${fmtNum(room.zMax, { digits: 2 })}` : ''}. Inconclusive either way.</p>`}
        <${TimeChart} series=${[{ id: d.term, label: 'Adopters', color: t.cat[0], values: d.timeline.map(p => ({ x: p.t, y: p.cumulative })) }]} height=${120} area=${true} yDomain=${[0, yMax]} xDomain=${xDomain} compact=${true} yFormat=${fmtInt} />
        <dl class="kv">
          <dt>Adopters</dt><dd>${fmtInt(d.adopters)}</dd>
          <dt>With an earlier adopter among contacts</dt><dd>${fmtPct(d.ex?.observed)}</dd>
          <dt>Same, adoption times shuffled</dt><dd>${fmtPct(d.ex?.mean)}</dd>
        </dl>
        <p class="basis">z ${fmtNum(d.ex?.z, { digits: 2 })}, one-sided.</p>
        ${d.cascade.length > 0 && html`<details class="disclose"><summary>Who adopted after a contact (${fmtInt(d.cascade.length)})</summary>
          <ol class="can-list small">${d.cascade.slice(0, 40).map(c => html`<li>${nodeLabel(ds, c.to)} after ${nodeLabel(ds, c.from)}, ${fmtDate(c.t)}</li>`)}</ol></details>`}`}
    </section>`; })}</div>
    <p class="basis">Charts share one y-axis (cumulative adopters, 0 to ${fmtInt(yMax)}) and one time axis.</p>
    <${HowToRead} means="The exposed share is the proportion of adopters, after the first, with at least one contact who used the term earlier."
      scale="The shuffled share is the exposure expected from the observed network and set of adopters alone. An observed share clearly above it is consistent with spread along ties."
      mistake=${`In a dense network most adopters have an earlier-adopting contact by chance${anyCeiling ? ', as here' : ''}. A high exposed share is interpretable only relative to the shuffled share.`} />`}
  </div>`;
}
