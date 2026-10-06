// The import report as people read it: totals, then one card per source (or
// per group of like sources, such as 56 WhatsApp chats), each leading with
// what the data can and cannot show, then its counts and the problems found
// while reading. The review before loading puts the cards first.
//
// Wording follows the evidence: message exports count messages; surveys and
// network files, whose events are self-reported ties, count responses and
// reported ties instead (src/core/report.js marks those sources `reported`).

import { html } from '../../../../vendor/preact.js';
import { Flag } from '../../components/common.js';
import { fmtInt, fmtRange, plural } from '../../lib/format.js';
import { VIEW_TEXT, RULES, ruleEvidence } from '../../lib/dsutil.js';
import { RULE_LABEL } from '../../lib/rebuild.js';

const TYPE_WORDS = {
  message: ['message', 'messages'], copresence: ['shared meeting or call', 'shared meetings or calls'], declared: ['reported tie', 'reported ties'],
  reaction: ['reaction', 'reactions'], repost: ['repost', 'reposts'], like: ['like', 'likes'], follow: ['follow', 'follows'],
  join: ['join', 'joins'], leave: ['leave', 'leaves'],
};
const typeWord = (k, n) => (TYPE_WORDS[k] ? TYPE_WORDS[k][n === 1 ? 0 : 1] : k);
const VIS_WORDS = { public: 'public', private: 'private', direct: 'one-to-one', group: 'group', unknown: 'of unknown visibility' };

function sevFlag(s) {
  return s === 'error' ? html`<${Flag} level="error">Error</${Flag}>` : s === 'info' ? html`<${Flag} level="info">Note</${Flag}>` : html`<${Flag} level="caution">Warning</${Flag}>`;
}

// Like sources (same format and view), three or more of them, become one card.
export function groupSources(sources) {
  const out = [];
  const by = new Map();
  for (const s of sources) {
    const k = `${s.label}|${s.view}`;
    if (!by.has(k)) { by.set(k, []); out.push(by.get(k)); }
    by.get(k).push(s);
  }
  return out.flatMap(list => (list.length >= 3 ? [list] : list.map(s => [s])));
}

function sumCounts(list) {
  const c = { nodes: 0, events: 0, contexts: 0, messages: 0, messagesWithText: 0, undatedEvents: 0, eventsByType: {}, contextsByVisibility: {} };
  for (const s of list) {
    for (const k of ['nodes', 'events', 'contexts', 'messages', 'messagesWithText', 'undatedEvents']) c[k] += s.counts[k] || 0;
    for (const [k, v] of Object.entries(s.counts.eventsByType || {})) c.eventsByType[k] = (c.eventsByType[k] || 0) + v;
    for (const [k, v] of Object.entries(s.counts.contextsByVisibility || {})) c.contextsByVisibility[k] = (c.contextsByVisibility[k] || 0) + v;
  }
  return c;
}

// excludeBots: the construction leaves bots out (the default), so the
// People total says how many of them the Network view will not show (L16:
// "97 people (1 bot left out of the network)").
// dataset (optional): the imported data, so the review can say which ties its
// records can build (the construction rules with evidence, as in Settings).
export function ReportView({ report, pending = false, excludeBots = true, dataset = null }) {
  if (!report) return html`<p class="small text2">No import report is available for this data.</p>`;
  const t = report.totals;
  const reported = report.sources.some(s => s.reported) && report.sources.every(s => s.reported || s.counts.events === 0);
  const vis = Object.entries(t.contextsByVisibility || {}).filter(([, n]) => n);
  const bots = excludeBots && !reported ? t.botsInEvents || 0 : 0;
  const peopleSub = [
    pending ? 'before merging duplicates' : (t.nodesInEvents != null && t.nodesInEvents !== t.nodes ? `${fmtInt(t.nodes)} listed in the export` : null),
    bots ? `${plural(bots, 'bot')} left out of the network, which shows ${fmtInt((t.nodesInEvents ?? t.nodes) - bots)}` : null,
  ].filter(Boolean).join('; ') || null;
  // Two-mode (affiliation) data counts both kinds of node and the memberships.
  const tm = t.twoMode;
  const rows = [
    tm ? [`${tm.labels[0]} and ${tm.labels[1]}`, fmtInt(tm.counts[0] + tm.counts[1]), `${fmtInt(tm.counts[0])} ${tm.labels[0].toLowerCase()}, ${fmtInt(tm.counts[1])} ${tm.labels[1].toLowerCase()}${pending ? '; before merging duplicates' : ''}`] : ['People', fmtInt(t.nodesInEvents ?? t.nodes), peopleSub],
    tm && reported ? ['Affiliations', fmtInt(t.events), 'one per membership or attendance'] : reported ? ['Reported ties', fmtInt(t.events), 'one per nomination'] : ['Messages and other events', fmtInt(t.events), t.messages ? `${fmtInt(t.messages)} messages, ${fmtInt(t.messagesWithText)} with text` : null],
    ...(tm && reported ? [] : [[reported ? 'Questions' : 'Conversations', fmtInt(t.contexts), !reported && vis.length > 1 ? vis.map(([v, n]) => `${fmtInt(n)} ${VIS_WORDS[v] || v}`).join(', ') : null]]),
    ['Time range', t.timeRange ? fmtRange(t.timeRange.start, t.timeRange.end) : 'no timestamps', null],
    ...(!reported ? [['Bots', fmtInt(t.botsInEvents ?? t.bots), t.botNames?.length ? t.botNames.slice(0, 4).join(', ') + (t.botNames.length > 4 ? ', ...' : '') : null]] : []),
    ...(t.deactivatedInEvents ? [['Deactivated accounts', fmtInt(t.deactivatedInEvents), t.deactivatedNames.slice(0, 4).join(', ') + (t.deactivatedNames.length > 4 ? ', ...' : '')]] : []),
  ];
  const totals = html`
    <dl class="dv-totals">
      ${rows.map(([k, v, sub]) => html`<div><dt class="label">${k}</dt><dd class="tnum dv-totals__v">${v}</dd>${sub && html`<dd class="small text2">${sub}</dd>`}</div>`)}
    </dl>
    ${(report.notes || []).length > 0 && html`<ul class="dv-notes">${report.notes.map(n => html`<li><${Flag} level=${/^Could not read/.test(n) ? 'error' : /deactivated|Nothing was read/.test(n) ? 'caution' : 'info'} /> <span>${n}</span></li>`)}</ul>`}
    ${report.unclaimed?.length > 0 && html`<p class="small text2"><${Flag} level="caution">Not read</${Flag}> ${plural(report.unclaimed.length, 'file')} matched no importer: ${report.unclaimed.slice(0, 6).join(', ')}${report.unclaimed.length > 6 ? ', ...' : ''}</p>`}`;
  const cards = groupSources(report.sources).map(list => (list.length > 1 ? html`<${SourceGroup} key=${list[0].id} list=${list} group=${(report.groups || []).find(g => g.key === `${list[0].label}|${list[0].view}`)} />` : html`<${SourceReport} key=${list[0].id} s=${list[0]} />`));
  // Before loading, what each source can and cannot show is what the reader
  // has to judge, so the source cards (which lead with it) come before the
  // totals: under the review's sticky action bar the totals had pushed it
  // below the first screen, even on a laptop.
  const rules = dataset ? html`<${TieRules} ds=${dataset} pending=${pending} />` : null;
  return pending
    ? html`<div class="dv-report dv-report--pending">${cards}${rules}<div class="dv-report__totals"><h3 class="dv-h3">${report.sources.length > 1 ? 'All sources together' : 'In total'}</h3>${totals}</div></div>`
    : html`<div class="dv-report">${totals}${cards}${rules}</div>`;
}

// Which ties these records can build: each construction rule with evidence,
// and how much. The same counts as Construction settings (the engine's
// evidenceCounts), before any choice. Before loading, the counts are of the
// records as read: merging two accounts of one person can turn a few of their
// pieces of evidence into ties with themselves, which make no tie.
function TieRules({ ds, pending = false }) {
  const ev = ruleEvidence(ds);
  const found = RULES.filter(r => ev[r] > 0);
  if (!found.length) return null;
  const items = found.map(r => `${RULE_LABEL[r] || r} (${fmtInt(ev[r])})`);
  const list = items.length > 1 ? `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}` : items[0];
  return html`<section class="dv-rules" aria-labelledby="dv-rules-h">
    <p class="label" id="dv-rules-h">Records available for tie construction</p>
    <p class="small text2">These records support tie construction from ${list}. The counts are pieces of evidence, as in Construction settings${pending ? ', before any duplicate accounts are merged' : ''}. Each rule can be enabled, disabled, or weighted under Construction settings. The network is rebuilt from the selected rules.</p>
  </section>`;
}

function Counts({ s, counts }) {
  const c = counts || s.counts;
  const imp = s.importerCounts || {};
  const vis = Object.entries(c.contextsByVisibility || {}).filter(([, n]) => n);
  if (s.reported && s.twoMode) {
    const [l0, l1] = s.twoMode.labels;
    return html`<dl class="kv dv-kv">
      <dt>${l0}</dt><dd>${fmtInt(s.twoMode.counts[0])}</dd>
      <dt>${l1}</dt><dd>${fmtInt(s.twoMode.counts[1])}</dd>
      <dt>Affiliations</dt><dd>${fmtInt(imp.affiliations ?? c.events)}</dd>
    </dl>`;
  }
  if (s.reported) {
    return html`<dl class="kv dv-kv">
      ${imp.respondents != null && html`<dt>Respondents</dt><dd>${fmtInt(imp.respondents)}</dd>`}
      ${imp.rosterSize != null && html`<dt>People on the roster</dt><dd>${fmtInt(imp.rosterSize)}</dd>`}
      <dt>People named or naming</dt><dd>${fmtInt(c.nodes)}</dd>
      <dt>Nominations</dt><dd>${fmtInt(imp.nominations ?? c.events)}</dd>
      ${imp.ties != null && html`<dt>Ties after combining</dt><dd>${fmtInt(imp.ties)}</dd>`}
      ${imp.reciprocatedPairs != null && html`<dt>Pairs who named each other</dt><dd>${fmtInt(imp.reciprocatedPairs)}</dd>`}
    </dl>`;
  }
  const byType = Object.entries(c.eventsByType || {}).map(([k, n]) => `${fmtInt(n)} ${typeWord(k, n)}`).join(', ');
  return html`<dl class="kv dv-kv">
    <dt>People</dt><dd>${fmtInt(c.nodes)}</dd>
    <dt>Events</dt><dd>${byType || fmtInt(c.events)}</dd>
    ${c.messages > 0 && html`<dt>Messages with text</dt><dd>${fmtInt(c.messagesWithText)} of ${fmtInt(c.messages)}</dd>`}
    <dt>Conversations</dt><dd>${fmtInt(c.contexts)}${vis.length > 1 ? ` (${vis.map(([v, n]) => `${fmtInt(n)} ${VIS_WORDS[v] || v}`).join(', ')})` : ''}</dd>
    ${c.undatedEvents > 0 && html`<dt>Events without a time</dt><dd>${fmtInt(c.undatedEvents)}</dd>`}
    ${!counts && s.bots?.nodes > 0 && html`<dt>Bots</dt><dd>${s.bots.names?.length ? s.bots.names.join(', ') : fmtInt(s.bots.nodes)}</dd>`}
  </dl>`;
}

function Deactivated({ list }) {
  const names = [...new Set(list.flatMap(s => s.deactivated?.names || []))];
  const n = list.reduce((a, s) => a + (s.deactivated?.nodes || 0), 0);
  if (!n) return null;
  return html`<p class="small dv-gone"><${Flag} level="caution">${plural(n, 'deactivated account')}</${Flag}> <span class="text2">${names.slice(0, 12).join(', ')}${names.length > 12 ? ', ...' : ''}. Their history still counts, so someone who left can rank high.</span></p>`;
}

function CanCannot({ s }) {
  // s: a source, or a group's { canShow, cannotShow } (core/report.js).
  return html`<div class="src__cols">
    <div><p class="label">What these records support</p>${s.canShow?.length ? html`<ul class="can-list">${s.canShow.map(x => html`<li>${x}</li>`)}</ul>` : html`<p class="small text2">Nothing: no events were read.</p>`}</div>
    <div><p class="label">Limits of these records</p><ul class="can-list">${(s.cannotShow || []).map(x => html`<li>${x}</li>`)}</ul></div>
  </div>`;
}

// Warnings, each code once; `of` = how many sources it came from.
function Warnings({ list }) {
  const by = new Map();
  for (const s of list) for (const w of s.warnings || []) {
    const e = by.get(w.code) || { ...w, count: 0, of: 0 };
    e.count += w.count; e.of++;
    by.set(w.code, e);
  }
  const ws = [...by.values()];
  if (!ws.length) return null;
  const many = list.length > 1;
  return html`<div class="dv-warn"><p class="label">Found while reading</p>
    <ul class="warn-list">${ws.map(w => html`<li title=${w.code}><span class="sev">${sevFlag(w.severity)}</span><span>${w.message}${many ? html` <span class="text2">${w.of === list.length ? `Applies to all ${fmtInt(list.length)}.` : `Applies to ${fmtInt(w.of)} of ${fmtInt(list.length)}.`}</span>` : ''}</span><span class="tnum">${w.count > 1 ? fmtInt(w.count) : ''}</span></li>`)}</ul></div>`;
}

function ownerLine(s) {
  if (s.ego) return html` · owner: <span class="dv-strong">${s.ego.label}</span>`;
  return '';
}

function SourceReport({ s }) {
  // A source that could not be read has no view of anything.
  const v = s.counts?.events === 0 && s.worst === 'error' ? { name: 'not read' } : VIEW_TEXT[s.view] || { name: s.view || 'Unknown view' };
  const files = s.fileNames || [];
  return html`<article class="src dv-source" aria-label=${`Source: ${s.title || s.label}`}>
    <div class="src__head">
      <h3 class="src__title">${s.title ? html`${s.title} <span class="muted dv-sub">· ${s.label}</span>` : s.label} <span class="muted dv-sub">· ${v.name}</span></h3>
      <span class="meta">${s.timeRange ? fmtRange(s.timeRange.start, s.timeRange.end) : 'no timestamps'}${s.tz?.status === 'assumed' ? ' · time zone assumed' : ''}</span>
    </div>
    <p class="small text2 dv-files-line">${files.slice(0, 3).join(', ')}${files.length > 3 ? ` and ${fmtInt(files.length - 3)} more files` : ''}${ownerLine(s)}</p>
    <${CanCannot} s=${s} />
    <${Counts} s=${s} />
    <${Deactivated} list=${[s]} />
    <${Warnings} list=${[s]} />
  </article>`;
}

// group: the report's entry for these sources (distinct people, and for
// personal exports the one-person-slice wording).
function SourceGroup({ list, group }) {
  const s0 = list[0];
  // Many chats from one phone are not "a single conversation" (C3).
  const v = group?.canShow ? { name: "one person's slice" } : VIEW_TEXT[s0.view] || { name: s0.view || 'Unknown view' };
  const c = sumCounts(list);
  if (group?.people != null) c.nodes = group.people;
  const starts = list.map(s => s.timeRange?.start).filter(Number.isFinite), ends = list.map(s => s.timeRange?.end).filter(Number.isFinite);
  const owners = [...new Set(list.map(s => s.ego?.label).filter(Boolean))];
  const noun = s0.view === 'chat' ? 'chats' : 'sources';
  return html`<article class="src dv-source" aria-label=${`${list.length} ${s0.label} ${noun}`}>
    <div class="src__head">
      <h3 class="src__title">${s0.label} <span class="muted dv-sub">· ${fmtInt(list.length)} ${noun} · ${v.name}</span></h3>
      <span class="meta">${starts.length ? fmtRange(Math.min(...starts), Math.max(...ends)) : 'no timestamps'}${list.some(s => s.tz?.status === 'assumed') ? ' · time zone assumed' : ''}</span>
    </div>
    ${owners.length > 0 && html`<p class="small text2 dv-files-line">Owner: <span class="dv-strong">${owners.join(', ')}</span>${owners.length === 1 && list.some(s => !s.ego) ? ' (group chats name no owner)' : ''}</p>`}
    <${CanCannot} s=${group?.canShow ? group : s0} />
    <${Counts} s=${s0} counts=${c} />
    <${Deactivated} list=${list} />
    <${Warnings} list=${list} />
    <details class="disclose dv-chats"><summary>List the ${fmtInt(list.length)} ${noun}</summary>
      <div class="table-wrap"><table class="tbl">
        <thead><tr><th scope="col">${s0.view === 'chat' ? 'Chat' : 'Source'}</th><th scope="col" class="num">People</th><th scope="col" class="num">Events</th><th scope="col">Dates</th></tr></thead>
        <tbody>${list.map(s => html`<tr><td>${s.title || s.fileNames?.[0] || s.label}</td><td class="num tnum">${fmtInt(s.counts.nodes)}</td><td class="num tnum">${fmtInt(s.counts.events)}</td><td class="small">${s.timeRange ? fmtRange(s.timeRange.start, s.timeRange.end) : 'no timestamps'}</td></tr>`)}</tbody>
      </table></div>
    </details>
  </article>`;
}
