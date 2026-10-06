// Import report: what each source contributed, what went wrong, and what the
// data can and cannot show. Structured data only; the UI renders it.
//
// Everything is derived from the Dataset itself (events carry their source
// index) plus the counts and warnings importers recorded on each source, so
// the report is reproducible from a saved project.

import { EVENT_TYPES, ROLES, VISIBILITY, VIEWS, twoModeOf } from './model.js';

// Warning severity. Importers may set w.severity themselves; otherwise the
// code decides: first the table of codes our importers emit, then patterns.
// Unknown codes default to 'warn' so nothing important is hidden.
//   error  the file or a whole part of it could not be used
//   warn   data was skipped, guessed or is less reliable than it looks
//   info   context worth knowing; nothing was lost
const CODES = {
  error: ['import-failed', 'survey-invalid', 'pst-unsupported', 'parse-error', 'xml-error', 'no-network-questions', 'slack-bad-json', 'teams-bad-json',
    'teams-free-no-messages', 'spreadsheet-unsupported',
    // Incomplete and wrong uploads (src/core/upload.js and the importers' UploadErrors).
    'download-unfinished', 'archive-unsupported', 'empty-upload', 'not-a-zip', 'zip-truncated', 'zip-encrypted', 'not-recognized',
    'meta-html-format', 'meta-no-messages', 'telegram-html-format', 'teams-no-messages', 'purview-no-items', 'calendar-csv-unsupported',
    'telegram-no-result', 'x-archive-no-data'],
  info: ['auto-mapping', 'multiple-egos', 'matrix-duplicate', 'pair-values-as-weights', 'self-nominations', 'self-loops',
    'direction-assumed', 'interval-end-dropped', 'edge-attrs-dropped', 'node-times-dropped', 'dynamic-attr-flattened',
    'slack-usergroup-mentions', 'teams-channel-visibility-unknown', 'mbox-preamble', 'empty-mbox', 'empty-file', 'duplicate-sessions-skipped',
    'combine-rule', 'survey-responded', 'survey-nonrespondents', 'survey-earlier-version', 'survey-perceived', 'spam-trash-excluded', 'automated-excluded', 'automated-included', 'owner-from-chat-title', 'nested-zip',
    'roster-tie-weight', 'css-consensus-weight', 'parts-combined', 'duplicate-upload', 'zip-renamed', 'export-part-one'],
};
const CODE_SEV = new Map(Object.entries(CODES).flatMap(([sev, list]) => list.map(c => [c, sev])));
const SEVERITY = {
  error: [/unsupported$/, /failed$/, /corrupt/, /unreadable/, /bad-json$/],
  info: [/^multiple-/, /-deduped$/, /^metadata-/],
};
const SEV_RANK = { error: 0, warn: 1, info: 2 };

export function warningSeverity(w) {
  if (w.severity && w.severity in SEV_RANK) return w.severity;
  const code = String(w.code || '');
  if (CODE_SEV.has(code)) return CODE_SEV.get(code);
  for (const re of SEVERITY.error) if (re.test(code)) return 'error';
  for (const re of SEVERITY.info) if (re.test(code)) return 'info';
  return 'warn';
}

// Names people know the sources by. Importer ids and format strings are
// lower-case codes ("linkedin", "x-archive"); the report and the Data view
// show these instead. Unknown formats fall back to a capitalised code.
const FORMAT_LABELS = {
  slack: 'Slack', teams: 'Microsoft Teams', email: 'Email', mbox: 'Email', eml: 'Email', calendar: 'Calendar',
  whatsapp: 'WhatsApp', linkedin: 'LinkedIn', 'x-archive': 'X archive', 'x-research': 'X research data', x: 'X',
  bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads', telegram: 'Telegram', imessage: 'iMessage',
  meta: 'Messenger or Instagram', messenger: 'Messenger', instagram: 'Instagram', discord: 'Discord', reddit: 'Reddit',
  tabular: 'Spreadsheet', 'google-forms': 'Google Forms survey', qualtrics: 'Qualtrics survey', 'egor-long': 'egor survey',
  'egor-wide': 'egor survey', egoweb: 'EgoWeb survey', 'network-canvas': 'Network Canvas interview', 'ego-interview': 'Ego interview',
  roster: 'Roster', 'shared-survey': 'Shared survey', drawn: 'Drawn network', draw: 'Drawn network', perceived: 'Perceived networks', css: 'Perceived networks', paste: 'Pasted ties', graphml: 'GraphML', gexf: 'GEXF', gml: 'GML',
  pajek: 'Pajek', ucinet: 'UCINET', dl: 'UCINET', 'ucinet-dl': 'UCINET', edgelist: 'Edge list', 'csv-edgelist': 'Edge list', 'gephi-csv': 'Edge list', 'csv-matrix': 'Adjacency matrix',
  fullmatrix: 'Adjacency matrix', synthetic: 'Synthetic',
};

export function formatLabel(format, variant) {
  const f = String(format || '');
  if (f === 'email' && variant === 'takeout') return 'Gmail';
  if (FORMAT_LABELS[f]) return FORMAT_LABELS[f];
  if (!f) return 'Source';
  return f.replace(/[-_]+/g, ' ').replace(/^\w/, c => c.toUpperCase());
}

function tzStatus(tz) {
  const v = tz == null ? 'unknown' : String(tz);
  if (/^utc$/i.test(v)) return { value: 'UTC', status: 'exact', note: 'Times are absolute (UTC) in the source.' };
  if (/assumed|unknown|floating|local/i.test(v)) return { value: v, status: 'assumed', note: 'The source has wall-clock times without a zone; time-of-day and day boundaries may be shifted. Set the zone if you know it.' };
  return { value: v, status: 'zone', note: `Wall-clock times were read in ${v}.` };
}

const VIEW_LINES = {
  [VIEWS.FULL]: {
    can: ["The structure of communication among everyone in this export: brokers, clusters, and each person's position."],
    cannot: ['Interaction that happened outside this export (other tools, meetings, hallways), or in conversations the export left out.'],
  },
  [VIEWS.EGO]: {
    can: ["The owner's contacts: how often, when and in which role each person interacts with the owner.", "The size and make-up of the owner's personal network."],
    cannot: ["Ties among the owner's contacts, except where they appear together on the same messages or meetings with the owner.", 'Whole-network measures such as centrality or brokerage for anyone but the owner: every tie runs through the owner, so these are biased toward them.'],
  },
  [VIEWS.CHAT]: {
    can: ['The structure of communication within this one conversation, and how it changes over time.'],
    cannot: ["Relationships outside this conversation; people's positions in any wider network."],
  },
  [VIEWS.SAMPLE]: {
    can: ['Patterns in a sample of a larger population (who replies to or mentions whom among sampled posts).'],
    cannot: ['The complete structure: degrees are undercounted and paths between people outside the sample are missing.'],
  },
  [VIEWS.AUTHORED]: {
    can: ['What one account did: whom it replied to, mentioned, reposted or followed.'],
    cannot: ['What others wrote or how they responded; incoming ties are invisible.'],
  },
};

const SURVEY_FULL = {
  can: ['Structure of the whole group as its members report it: who names whom, brokers, clusters, and how central each person is.'],
  cannot: ['Ties outside the questions asked, and ties of people on the roster who did not answer, except as others named them.'],
};

function familyLines(s, stats) {
  const can = [], cannot = [];
  const fmt = String(s.format || '');
  if (s.medium === 'email' || fmt === 'email') cannot.push('Blind copies on messages the owner received (Bcc is only visible on the sender\'s copy), and forwards that never reached this mailbox.');
  if (s.medium === 'calendar' || fmt === 'calendar') cannot.push('Actual attendance: calendar data shows invitations and responses, not who showed up.');
  if (fmt.startsWith('teams') && /purview/i.test(String(s.variant || ''))) cannot.push('Who said what to whom: the Purview item report lists the participants of each transcript only.');
  if (s.family === 'survey') {
    can.push('Ties people reported themselves (who they go to, feel close to, and so on).');
    cannot.push(s.view === VIEWS.EGO
      ? 'Observed behavior: these are self-reports, and ties between the people a respondent named are that respondent\'s perception.'
      : 'Observed behavior: these are self-reports, and people who did not respond named nobody.');
  }
  if (s.family === 'network') cannot.push('How the ties were measured: the file holds declared ties whose origin and time window are not recorded.');
  if (s.twoMode) {
    const [a, b] = (s.twoMode.labels || ['Actors', 'Events']).map(x => String(x).toLowerCase());
    can.push(`Two-mode (affiliation) structure: which of the ${a} belong to or attended which of the ${b}, and through that who shares ${b} with whom.`);
    cannot.push(`Whether ${a} who share one of the ${b} actually interacted: a shared membership is an opportunity to meet, not a tie in itself.`);
  }
  if (stats.undated === stats.events && stats.events > 0) cannot.push('Change over time: no event has a timestamp.');
  if (stats.events > 0 && stats.withText === 0 && stats.byType.message > 0) cannot.push('Content measures (tone, topics, keywords): the messages carry no text.');
  if (stats.byType.copresence > 0) can.push('Who was together in the same meetings or conversations (co-presence), which is weaker evidence of a tie than a direct message.');
  if (s.view === VIEWS.FULL && s.medium === 'slack' && !stats.byVisibility.private && !stats.byVisibility.direct && !stats.byVisibility.group && stats.events > 0) {
    cannot.push('Private channels and direct messages: this looks like a public-channels-only export.');
  }
  return { can, cannot };
}

// Several chats or exports from one person's phone or account, read as one
// group (56 WhatsApp chats): one person's slice of their social life. The
// owner is in every conversation, so they connect everyone by construction
// and path measures for them describe the export, not the person (C3).
export function personalGroupLines(list) {
  const n = list.length;
  const chats = list.every(s => s.view === VIEWS.CHAT);
  const noun = chats ? 'chats' : 'exports';
  const owners = [...new Set(list.map(s => s.ego?.label).filter(Boolean))];
  const owner = owners.length === 1 ? owners[0] : 'the owner';
  const groupChats = list.filter(s => (s.counts?.nodes || 0) > 2).length;
  return {
    canShow: [
      `Whom ${owner} talks with across these ${n} ${noun}, how often and when: ${owner === 'the owner' ? "the owner's" : `${owner}'s`} personal network and its size.`,
      ...(groupChats ? [`Which contacts appear together in the ${groupChats} group ${groupChats === 1 ? 'chat' : 'chats'}, so the parts of ${owner === 'the owner' ? "the owner's" : `${owner}'s`} life show up as clusters (communities).`] : []),
    ],
    cannotShow: [
      `Anyone's position in a wider network: this is one person's slice. ${owner === 'the owner' ? 'The owner' : owner} is in every ${chats ? 'chat' : 'export'}, so ${owner === 'the owner' ? 'they connect' : 'connects'} everyone by construction; betweenness, closeness, constraint and effective size describe the export, not the person.`,
      `How ${owner === 'the owner' ? "the owner's" : `${owner}'s`} contacts know each other outside these ${noun}.`,
    ],
  };
}

const isPersonal = s => s.view === VIEWS.EGO || (s.view === VIEWS.CHAT && s.family === 'personal');

export function importReport(ds) {
  const e = ds.events;
  const S = ds.meta.sources.length;
  const per = Array.from({ length: S }, () => ({
    events: 0, byType: Object.fromEntries(EVENT_TYPES.map(t => [t, 0])), byRole: Object.fromEntries(ROLES.map(r => [r, 0])),
    tMin: Infinity, tMax: -Infinity, undated: 0, withText: 0, nodes: new Set(), contexts: new Set(), botEvents: 0, bots: new Set(),
    unresolved: 0, noTargets: 0,
  }));
  const MESSAGE = EVENT_TYPES.indexOf('message');
  for (let i = 0; i < e.count; i++) {
    const p = per[e.source[i]];
    if (!p) continue;
    p.events++;
    p.byType[EVENT_TYPES[e.type[i]]]++;
    const t = e.t[i];
    if (Number.isFinite(t)) { if (t < p.tMin) p.tMin = t; if (t > p.tMax) p.tMax = t; } else p.undated++;
    // Reactions and system notices can carry text too (an emoji name, a join
    // notice); counting them made "messages with text" exceed the messages.
    if (e.text[i] && e.type[i] === MESSAGE) p.withText++;
    const a = e.actor[i];
    p.nodes.add(a);
    if (ds.nodes.isBot[a]) { p.botEvents++; p.bots.add(a); }
    if (e.context[i] >= 0) p.contexts.add(e.context[i]);
    if (e.tOff[i + 1] === e.tOff[i]) p.noTargets++;
    for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) {
      p.nodes.add(e.tgt[j]); p.byRole[ROLES[e.role[j]]]++;
      if (ds.nodes.isBot[e.tgt[j]]) p.bots.add(e.tgt[j]);
    }
  }

  const isDeactivated = i => !!(ds.nodes.attrs[i] && ds.nodes.attrs[i].deactivated);
  // Two-mode data: nodes of each kind, overall and per source (src/core/model.js twoModeOf).
  const tm = twoModeOf(ds);
  const modeCounts = (set) => { const c = [0, 0]; if (tm) for (const i of set) if (tm.mode[i] >= 0) c[tm.mode[i]]++; return c; };
  // Distinct labels, sorted (two bot accounts can share a name).
  const namesOf = list => [...new Set(list.map(i => ds.nodes.labels[i]))].sort((a, b) => String(a).localeCompare(String(b)));
  const sources = ds.meta.sources.map((s, sid) => {
    const p = per[sid];
    const gone = [...p.nodes].filter(isDeactivated);
    const byVisibility = Object.fromEntries(VISIBILITY.map(v => [v, 0]));
    const byKind = {};
    for (const c of p.contexts) {
      byVisibility[VISIBILITY[ds.contexts.visibility[c]]]++;
      byKind[ds.contexts.kinds[c]] = (byKind[ds.contexts.kinds[c]] || 0) + 1;
    }
    const warnings = (s.warnings || []).map(w => ({ code: w.code, message: w.message, count: w.count ?? 1, severity: warningSeverity(w) }))
      .sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity] || b.count - a.count || a.code.localeCompare(b.code));
    const unresolved = warnings.find(w => w.code === 'unresolved-parent')?.count || 0;
    const stats = { events: p.events, byType: p.byType, withText: p.withText, undated: p.undated, byVisibility };
    // A roster survey is a full network of reports, not of observed talk.
    const view = s.family === 'survey' && s.view === VIEWS.FULL ? SURVEY_FULL : VIEW_LINES[s.view] || { can: [], cannot: ['The kind of slice this source shows is not recorded, so which measures apply is unclear.'] };
    const fam = familyLines(s, stats);
    let canShow = [...view.can, ...fam.can];
    let cannotShow = [...view.cannot, ...fam.cannot];
    // An empty source must not claim it can show the structure of anything.
    if (p.events === 0) { canShow = []; cannotShow = ['Anything yet: no messages, ties or other events were read from it.']; }
    if (p.undated && p.undated < p.events) cannotShow.push(`Timing for ${p.undated} of ${p.events} events, which have no usable timestamp.`);
    const tz = tzStatus(s.tz);
    if (tz.status === 'assumed') cannotShow.push('Reliable time-of-day patterns, until the time zone is confirmed.');
    const egoIdx = s.egoKey ? ds.nodes.keys.indexOf(s.egoKey) : -1;
    return {
      id: sid,
      format: s.format, family: s.family, medium: s.medium, view: s.view, context: s.context,
      variant: s.variant ?? null, directed: s.directed ?? null,
      // Two-mode source: its mode labels and how many nodes of each kind take part.
      twoMode: tm && s.twoMode ? { labels: tm.labels, counts: modeCounts(p.nodes) } : null,
      // How a survey's two answers about a pair were combined (union, intersection, respondent).
      combine: s.combine ?? s.mergeRule ?? null,
      label: formatLabel(s.format, s.variant), title: s.title ?? null,
      // Every event is a self-report (survey nominations, declared network
      // files): the UI words counts as responses and reported ties.
      reported: p.events > 0 && p.byType.declared === p.events,
      fileNames: s.fileNames || [],
      ego: s.egoKey ? { key: s.egoKey, label: egoIdx >= 0 ? ds.nodes.labels[egoIdx] : s.egoKey, inferredFrom: s.egoInferredFrom ?? null } : null,
      // Ego-interview sources with several respondents list them all (egoKey is then null).
      egos: Array.isArray(s.egoKeys) ? s.egoKeys.length : (s.egoKey ? 1 : 0),
      timeRange: Number.isFinite(p.tMin) ? { start: p.tMin, end: p.tMax } : null,
      tz,
      counts: {
        nodes: p.nodes.size, events: p.events,
        eventsByType: Object.fromEntries(Object.entries(p.byType).filter(([, v]) => v)),
        targetsByRole: Object.fromEntries(Object.entries(p.byRole).filter(([, v]) => v)),
        contexts: p.contexts.size, contextsByVisibility: Object.fromEntries(Object.entries(byVisibility).filter(([, v]) => v)), contextsByKind: byKind,
        messages: p.byType.message, messagesWithText: p.withText, undatedEvents: p.undated, eventsWithoutTargets: p.noTargets,
      },
      bots: { nodes: p.bots.size, events: p.botEvents, names: namesOf([...p.bots]).slice(0, 20) },
      // Accounts the export marks as deactivated (attrs.deactivated): people
      // who left keep their history and can still rank high on measures.
      deactivated: { nodes: gone.length, names: namesOf(gone).slice(0, 50), keys: gone.map(i => ds.nodes.keys[i]) },
      selfMessages: s.counts?.['self-messages'] ?? 0,
      unresolvedParents: unresolved,
      importerCounts: { ...(s.counts || {}) },
      warnings,
      worst: warnings.length ? warnings[0].severity : null,
      canShow, cannotShow,
    };
  });

  let tMin = Infinity, tMax = -Infinity;
  for (const s of sources) if (s.timeRange) { tMin = Math.min(tMin, s.timeRange.start); tMax = Math.max(tMax, s.timeRange.end); }
  const notes = [];
  // Personal exports: ego views plus single chats exported from one phone.
  // Several chats from one app are one export to the person who made them.
  const personal = sources.filter(isPersonal);
  if (personal.length > 1) {
    const kinds = new Map();
    for (const s of personal) kinds.set(s.label, (kinds.get(s.label) || 0) + 1);
    const parts = [...kinds].map(([label, n]) => (n > 1 && personal.find(s => s.label === label).view === VIEWS.CHAT ? `${n} ${label} chats` : n > 1 ? `${n} ${label} exports` : label));
    notes.push(`${parts.length > 1 ? `${listJoin(parts)} are` : `${parts[0]} are`} personal exports: one person's slice. Each holds only the conversations its owner (usually you) took part in, so the owner is tied to everyone and bridges them by construction, and the data shows little of how their contacts know each other.`);
  }
  // Like sources read as one group (the Data view shows three or more of
  // one format and view as one card): distinct people across the group, since
  // summing per-chat counts counts the owner and shared contacts many times.
  const byGroup = new Map();
  sources.forEach((src, sid) => {
    const k = `${src.label}|${src.view}`;
    if (!byGroup.has(k)) byGroup.set(k, { key: k, sources: [], people: new Set() });
    const g = byGroup.get(k);
    g.sources.push(sid);
    for (const i of per[sid].nodes) g.people.add(i);
  });
  const groups = [...byGroup.values()].filter(g => g.sources.length > 1).map(g => {
    const list = g.sources.map(i => sources[i]);
    const out = { key: g.key, sources: g.sources, people: g.people.size };
    if (list.every(isPersonal)) Object.assign(out, personalGroupLines(list));
    return out;
  });
  // Only sources that contributed events: a failed or empty source has no view to combine.
  if (new Set(sources.filter(s => s.counts.events > 0).map(s => s.view)).size > 1) notes.push('Sources with different views were combined. Measures are checked against the narrowest view before they are shown.');
  if (ds.meta.merges?.length) {
    let groups = 0, folded = 0;
    for (const m of ds.meta.merges) for (const g of m.groups) { groups++; folded += g.from.length; }
    notes.push(`${folded === 1 ? '1 record was' : `${folded} records were`} folded into ${groups === 1 ? '1 person' : `${groups} people`} after review (same email, name or account). The merge log is under Who is who.`);
  }
  const empty = sources.filter(s => s.counts.events === 0);
  if (empty.length) notes.push(`Nothing was read from ${empty.length === 1 ? 'one source' : `${empty.length} sources`}: ${empty.slice(0, 5).map(s => s.title || s.fileNames[0] || s.label).join(', ')}${empty.length > 5 ? ', ...' : ''}.`);
  // People listed in an export (users.json, a roster) may never act or be
  // addressed; count those who appear in events separately so totals and the
  // per-source rows (which count only people in events) agree visibly.
  const inEvents = new Uint8Array(ds.nodes.count);
  for (let i = 0; i < e.count; i++) {
    inEvents[e.actor[i]] = 1;
    for (let j = e.tOff[i]; j < e.tOff[i + 1]; j++) inEvents[e.tgt[j]] = 1;
  }
  let nodesInEvents = 0, botsInEvents = 0;
  const gone = [], goneInEvents = [];
  for (let i = 0; i < ds.nodes.count; i++) {
    if (inEvents[i]) { nodesInEvents++; if (ds.nodes.isBot[i]) botsInEvents++; }
    if (isDeactivated(i)) { gone.push(i); if (inEvents[i]) goneInEvents.push(i); }
  }
  if (goneInEvents.length) notes.push(`${goneInEvents.length === 1 ? '1 account is' : `${goneInEvents.length} accounts are`} marked as deactivated in the export (${namesOf(goneInEvents).slice(0, 5).join(', ')}${goneInEvents.length > 5 ? ', ...' : ''}). Their past activity still counts, so a person who has left can rank high; check when they were last active before reading a measure as current.`);
  const contextsByVisibility = {};
  for (let c = 0; c < ds.contexts.count; c++) {
    const v = VISIBILITY[ds.contexts.visibility[c]];
    contextsByVisibility[v] = (contextsByVisibility[v] || 0) + 1;
  }
  let messages = 0, messagesWithText = 0;
  for (const p of per) { messages += p.byType.message; messagesWithText += p.withText; }
  return {
    totals: {
      nodes: ds.nodes.count, nodesInEvents, events: e.count, contexts: ds.contexts.count, sources: S,
      messages, messagesWithText, contextsByVisibility,
      bots: ds.nodes.isBot.reduce((a, b) => a + b, 0), botsInEvents,
      botNames: namesOf([...Array(ds.nodes.count).keys()].filter(i => ds.nodes.isBot[i] && inEvents[i])).slice(0, 20),
      deactivated: gone.length, deactivatedInEvents: goneInEvents.length, deactivatedNames: namesOf(goneInEvents).slice(0, 50),
      timeRange: Number.isFinite(tMin) ? { start: tMin, end: tMax } : null,
      warnings: { error: 0, warn: 0, info: 0, ...countSev(sources) },
      // Two-mode data: { labels, counts: [n0, n1] } over every node, else null.
      twoMode: tm ? { labels: tm.labels, counts: tm.counts } : null,
    },
    sources, notes, groups,
  };
}

function countSev(sources) {
  const c = {};
  for (const s of sources) for (const w of s.warnings) c[w.severity] = (c[w.severity] || 0) + 1;
  return c;
}

function listJoin(parts) {
  return parts.length < 2 ? parts.join('') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}
