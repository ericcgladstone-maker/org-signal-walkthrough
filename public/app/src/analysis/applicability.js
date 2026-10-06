// Which measures mean something for this dataset and network.
//
// Every measure gets a level ('ok' | 'caution' | 'na') and a plain-language
// reason the UI shows next to it. The checks encode what the source can and
// cannot see: in one person's mailbox every path runs through the owner, so
// betweenness there describes the export, not the organisation.

import { VIEWS } from '../core/model.js';
import { graphOf, components } from './graph.js';
import { NODE_METRICS } from './metrics.js';
import { TWO_MODE_METRICS, isTwoModeView } from './twomode.js';

const RANK = { ok: 0, caution: 1, na: 2 };
const HIERARCHY_KEYS = /^(manager|manager_?id|managerkey|reports_?to|supervisor|supervisor_?id|boss|line_?manager)$/i;

export const APPLICABILITY_KEYS = [...NODE_METRICS, ...TWO_MODE_METRICS, 'twoModeDensity', 'robinsAlexander',
  'density', 'reciprocityNetwork', 'transitivity', 'avgClustering', 'avgPathLength', 'degreeCentralization', 'strengthGini', 'degreeAssortativity',
  'communities', 'groups', 'ego', 'nullModel', 'resampleRanks', 'timeSeries', 'detectShifts', 'compareBeforeAfter',
  'affect', 'keywords', 'topics', 'diffusion', 'hierarchy'];

export function applicability(ds, net) {
  const out = {};
  for (const k of APPLICABILITY_KEYS) out[k] = { level: 'ok', reasons: [] };
  const flag = (keys, level, reason) => {
    for (const k of [].concat(keys)) {
      const o = out[k];
      if (!o) continue;
      if (RANK[level] > RANK[o.level]) o.level = level;
      if (level !== 'ok' && !o.reasons.includes(reason)) o.reasons.push(reason);
    }
  };

  const sources = ds.meta?.sources || [];
  const views = sources.map(s => s.view || VIEWS.FULL);
  const has = (v) => views.includes(v);
  const only = (vs) => views.length > 0 && views.every(v => vs.includes(v));
  const g = graphOf(net);
  const n = net.n;
  const pathMetrics = ['betweenness', 'betweennessWeighted', 'closeness', 'closenessWeighted'];
  const globalMetrics = [...pathMetrics, 'eigenvector', 'pagerank', 'coreNumber', 'avgPathLength', 'degreeCentralization', 'communities'];

  // --- source view ---
  // An ego-network interview is also an ego view, but nothing in it is a
  // message: the respondent names people and says who knows whom. Direction
  // and reciprocity are not observed, and ties among the people named are
  // the respondent's perception, which is the design, not a gap.
  const interview = sources.length > 0 && sources.every(s => s.format === 'ego-interview' || s.family === 'survey' && s.view === VIEWS.EGO);
  if (interview) {
    flag(pathMetrics, 'na', 'In an ego-network interview every path runs through the respondent, so path measures describe the interview design, not anyone\'s position.');
    flag(['eigenvector', 'pagerank', 'degreeCentralization', 'avgPathLength', 'coreNumber'], 'caution', 'Everyone here was named by one respondent; whole-network rankings mostly reflect who the respondent tied together.');
    flag(['inDegree', 'outDegree', 'inStrength', 'outStrength', 'reciprocity', 'reciprocityNetwork'], 'na', 'The respondent reports every tie, so who named whom is not observed: direction and reciprocity mean nothing here. Treat the ties as undirected.');
    flag(['constraint', 'effectiveSize', 'egoDensity', 'clustering', 'density', 'transitivity', 'avgClustering', 'communities'], 'caution', 'Ties among the people named are as the respondent sees them (perceived, not observed), and only people the respondent named are present.');
    flag(['groups', 'nullModel'], 'caution', 'Everyone is tied to the respondent by design; rewired comparison networks ignore that, so read z and p as rough.');
  } else if (only([VIEWS.EGO])) {
    flag(pathMetrics, 'na', "This is one person's export: every path runs through its owner, so path measures describe the export, not the network.");
    flag(['eigenvector', 'pagerank', 'degreeCentralization', 'avgPathLength', 'coreNumber'], 'caution', "In one person's export, others are seen only through their contact with the owner.");
    flag(['constraint', 'effectiveSize', 'egoDensity', 'clustering'], 'caution', "Ties among the owner's contacts are visible only when the owner was on the message; brokerage and density among alters are understated.");
    flag(['density', 'communities', 'transitivity', 'avgClustering'], 'caution', "Ties the owner never saw are missing, so the network looks sparser and more centralised than it is.");
    flag(['inDegree', 'reciprocity', 'reciprocityNetwork'], 'caution', "Only messages the owner sent or received are present.");
    flag(['groups', 'nullModel'], 'caution', "In one person's export, ties among the owner's contacts are only partly visible: group mixing describes what the owner saw, and rewired comparison networks ignore that everyone is tied to the owner.");
  } else if (has(VIEWS.EGO)) {
    flag(globalMetrics, 'caution', "Some sources are one person's export; their owners look more central than they are.");
    flag(['groups', 'nullModel'], 'caution', "Some sources are one person's export: ties among that person's contacts are only partly visible, so group mixing partly describes what the owner saw.");
  }
  // Many conversations from one person's phone or account (a WhatsApp or
  // Telegram export of every chat, an iMessage database): the owner is in
  // every one of them, so the owner joins the conversations by construction
  // and other people are seen only where they shared a chat with the owner.
  const personal = sources.length > 1 && sources.every(s => s.family === 'personal' || s.context === 'personal') && only([VIEWS.CHAT, VIEWS.EGO]) && has(VIEWS.CHAT);
  if (personal) {
    const k = sources.length;
    flag(pathMetrics, 'na', `${k} conversations from one person's export: its owner is in all of them and connects them by construction, so path measures describe the export, not anyone's position. Use ego measures (size, effective size, constraint) for the owner instead.`);
    flag(['eigenvector', 'pagerank', 'degreeCentralization', 'avgPathLength', 'coreNumber'], 'caution', `In ${k} conversations from one person's export, everyone else is seen only through the chats they shared with the owner.`);
    flag(['constraint', 'effectiveSize'], 'caution', `In one person's export the owner's contacts are tied to each other only when they shared a chat with the owner, so the owner's constraint is low and effective size high largely by construction: compare them across people's own exports, not with whole-network studies. For anyone but the owner they describe only the chats the owner was in.`);
    flag(['egoDensity', 'clustering', 'density', 'transitivity', 'avgClustering', 'communities'], 'caution', `Ties are seen only inside the chats of one person's export; group chats make cliques, and contacts who never shared a chat with the owner look unconnected.`);
    flag(['groups', 'nullModel'], 'caution', "In one person's export, everyone is tied to the owner and group chats make cliques; rewired comparison networks ignore both, so read z and p as rough.");
  } else if (only([VIEWS.CHAT])) {
    flag(pathMetrics, 'caution', 'A single conversation: everyone hears everyone, so differences in path position are small and mostly reflect who spoke when.');
    flag(['communities'], 'caution', 'A single conversation rarely contains separate communities.');
  }
  if (only([VIEWS.AUTHORED])) {
    flag(['inDegree', 'inStrength', 'reciprocity', 'reciprocityNetwork', 'pagerank'], 'na', 'The source holds only what one account wrote; nobody else\'s actions toward others are present.');
    flag([...pathMetrics, 'eigenvector', 'communities', 'constraint', 'effectiveSize', 'clustering', 'egoDensity', 'transitivity', 'avgClustering', 'density'], 'na', 'Only one account\'s outgoing actions are present; this is a list of contacts, not a network.');
  }
  if (has(VIEWS.SAMPLE)) {
    flag([...globalMetrics, 'density', 'transitivity', 'avgClustering', 'constraint', 'effectiveSize'], 'caution', 'The data are a sample of a larger population: degrees and paths are biased downward, and who looks central depends on what was sampled.');
  }
  // Ego measures are always defined; for ego views they are the primary measures.
  const egoKeys = [...new Set(sources.filter(s => s.view === VIEWS.EGO).flatMap(s => [s.egoKey, ...(s.egoKeys || [])]).filter(Boolean))];

  // --- direction and weights ---
  if (!net.directed) {
    flag(['inDegree', 'outDegree', 'inStrength', 'outStrength'], 'na', 'The network is undirected; in and out are the same as degree.');
    flag(['reciprocity', 'reciprocityNetwork'], 'na', 'Reciprocity needs a directed network.');
  }
  const binary = net.settings?.weighting === 'binary';
  if (binary) {
    flag(['strength', 'inStrength', 'outStrength'], 'caution', 'Weighting is binary, so strength equals degree.');
    flag(['betweennessWeighted', 'closenessWeighted'], 'na', 'Weighting is binary; the weighted versions are identical to the unweighted ones.');
  }
  const rules = net.settings?.rules || {};
  const on = Object.keys(rules).filter(r => rules[r]?.on);
  if (on.length && on.every(r => r === 'copresence')) {
    flag(pathMetrics, 'caution', 'Ties come only from shared meetings, which create cliques; path measures mostly reflect meeting size.');
    flag(['clustering', 'transitivity', 'avgClustering', 'constraint', 'effectiveSize', 'egoDensity'], 'caution', 'Each meeting creates a clique, which inflates clustering and constraint.');
  }
  if (on.includes('adjacency')) flag(['reciprocity', 'reciprocityNetwork'], 'caution', 'Turn-taking ties run from each speaker to the one before, so two people taking turns tie each other both ways, which inflates reciprocity.');
  if (net.directed && sources.some(s => s.directed === false)) flag(['reciprocity', 'reciprocityNetwork', 'inDegree', 'outDegree'], 'caution', 'Some sources record undirected ties (connections, drawn or undirected network files); they enter the directed network in both directions, which inflates reciprocity.');
  if (on.includes('follow') && on.length === 1) flag(['strength', 'inStrength', 'outStrength'], 'caution', 'Follows have no strength; every tie weighs the same.');

  // --- two-mode data ---
  const tmv = isTwoModeView(net);
  const twoModeKeys = [...TWO_MODE_METRICS, 'twoModeDensity', 'robinsAlexander'];
  if (!tmv) {
    flag(twoModeKeys, 'na', net.twoMode ? 'This is a one-mode projection of two-mode data; two-mode measures apply to the two-mode view (construction settings, Two-mode).' : 'Needs a two-mode (affiliation) network: actors tied only to the events or groups they belong to.');
  } else {
    const [l0, l1] = net.twoMode.labels;
    const kinds = `${l0.toLowerCase()} and ${l1.toLowerCase()}`;
    flag(['clustering', 'transitivity', 'avgClustering', 'egoDensity'], 'na', `In a two-mode network ties run only between ${kinds}, so there are no triangles and one-mode clustering is always 0. Use two-mode clustering (Latapy) or the Robins-Alexander coefficient, or look at a projection.`);
    flag(['constraint', 'effectiveSize'], 'na', `Burt's measures ask whether a person's contacts are tied to each other; in a two-mode network contacts are always of the other kind and never tied to each other, so the values are meaningless. Use a projection.`);
    flag(['density'], 'na', `One-mode density counts ties that cannot exist here (between two ${l0.toLowerCase()} or two ${l1.toLowerCase()}). Use two-mode density, which divides by ${l0.toLowerCase()} x ${l1.toLowerCase()}.`);
    flag(['degreeCentralization', 'degreeAssortativity'], 'na', 'Defined for one-mode networks; the two modes have different maximum degrees, so the one-mode formula does not apply.');
    flag(['betweenness', 'closeness', 'betweennessWeighted', 'closenessWeighted', 'eigenvector', 'pagerank', 'coreNumber'], 'caution', `Computed as if ${kinds} were one kind of node: values of the two modes are not comparable. Use the two-mode versions (Borgatti-Everett normalization) to compare within each mode.`);
    flag(['nullModel'], 'na', 'Rewiring a two-mode network with the one-mode null model would create ties within a mode; compare a projection instead.');
    flag(['communities'], 'caution', `Communities are found on the projection of ${l0.toLowerCase()} by shared ${l1.toLowerCase()}; each of the ${l1.toLowerCase()} joins the community most of its members are in.`);
    if (net.twoMode.counts[0] < 2 || net.twoMode.counts[1] < 1) flag(twoModeKeys, 'na', 'Each mode needs nodes in the network.');
  }
  if (net.twoMode && net.twoMode.basis >= 0) {
    const t = net.twoMode, [l0, l1] = t.labels;
    const me = (t.basis === 0 ? l0 : l1).toLowerCase(), via = (t.basis === 0 ? l1 : l0).toLowerCase();
    flag(['clustering', 'transitivity', 'avgClustering', 'constraint', 'effectiveSize', 'egoDensity'], 'caution', `In a projection every one of the ${via} becomes a clique of its ${me}, which inflates clustering and constraint by construction.`);
    flag(['nullModel'], 'caution', `The rewired comparison networks ignore that the projection is made of cliques (one per shared node), so clustering and modularity look significant more easily than they are.`);
  }

  // --- size, isolates, components ---
  const cc = components(g);
  let isolates = 0, nontrivial = 0;
  for (const s of cc.sizes) { if (s === 1) isolates++; else nontrivial++; }
  if (n < 3) flag(APPLICABILITY_KEYS.filter(k => !['affect', 'keywords', 'topics', 'hierarchy', 'timeSeries'].includes(k)), 'na', 'Fewer than three people in the network.');
  else if (n < 10) flag([...globalMetrics, 'nullModel', 'resampleRanks', 'groups'], 'caution', 'Very small network: single ties move these numbers a lot.');
  if (nontrivial > 1) {
    flag(['eigenvector'], 'caution', `The network has ${nontrivial} separate components; eigenvector scores outside the largest one shrink toward zero and are not comparable.`);
    flag(['closeness', 'closenessWeighted', 'avgPathLength'], 'caution', `The network has ${nontrivial} separate components; people in small components look peripheral partly because they cannot reach the rest.`);
    flag(['betweenness', 'betweennessWeighted'], 'caution', `Betweenness is computed within each of ${nontrivial} components; it cannot exceed what a small component allows.`);
  }
  if (n && isolates / n > 0.2) flag(['density', 'avgClustering', 'degreeCentralization', 'strengthGini'], 'caution', `${isolates} of ${n} people have no ties under the current rules; whole-network averages include them.`);
  if (!net.edges.count) flag(APPLICABILITY_KEYS.filter(k => !['affect', 'keywords', 'topics', 'hierarchy'].includes(k)), 'na', 'No ties under the current construction rules.');
  if (n > 3000) flag(['betweenness', 'betweennessWeighted', 'closeness', 'closenessWeighted'], 'caution', 'Large network: path measures are estimated from a sample of sources unless exact computation is requested.');

  // --- attributes and hierarchy ---
  const schema = ds.attributeSchema || [];
  const cats = schema.filter(s => ['categorical', 'boolean', 'ordinal'].includes(s.type) && !HIERARCHY_KEYS.test(s.key));
  if (!cats.length) flag(['groups'], 'na', 'No categorical attribute (department, team, location...) is loaded.');
  else if (Math.max(...cats.map(s => s.coverage ?? 1)) < 0.8) flag(['groups'], 'caution', 'Attribute values are missing for more than 20% of people; group measures cover only those with values.');
  const hier = schema.find(s => HIERARCHY_KEYS.test(s.key));
  if (!hier) flag('hierarchy', 'na', 'No manager or reports-to attribute is loaded.');
  else flag(['betweenness', 'betweennessWeighted', 'constraint', 'effectiveSize'], 'caution', 'Managers sit on paths between their reports by design; compare brokers with peers at the same level.');

  // --- time ---
  const ev = ds.events;
  let timed = 0, tMin = Infinity, tMax = -Infinity, withText = 0, messages = 0;
  for (let i = 0; i < ev.count; i++) {
    const t = ev.t[i];
    if (Number.isFinite(t)) { timed++; if (t < tMin) tMin = t; if (t > tMax) tMax = t; }
    if (ev.type[i] === 0) { messages++; if (ev.text?.[i]) withText++; }
  }
  const span = timed ? tMax - tMin : 0;
  const DAY = 86400000;
  if (timed < 2 || span <= 0) flag(['timeSeries', 'detectShifts', 'compareBeforeAfter', 'diffusion'], 'na', 'Events have no usable timestamps.');
  else {
    if (timed / ev.count < 0.8) flag(['timeSeries', 'detectShifts', 'compareBeforeAfter', 'diffusion'], 'caution', `${Math.round((1 - timed / ev.count) * 100)}% of events have no timestamp and are left out of time analyses.`);
    if (span < 14 * DAY) flag(['timeSeries', 'detectShifts', 'compareBeforeAfter'], 'caution', 'The data cover less than two weeks; shifts cannot be separated from day-to-day noise.');
    if (span < 56 * DAY) flag(['detectShifts'], 'caution', 'Fewer than eight weekly windows: too few to estimate a baseline.');
  }
  // --- content ---
  if (!withText) flag(['affect', 'keywords', 'topics', 'diffusion'], 'na', 'No message text is present.');
  else {
    if (withText / Math.max(1, messages) < 0.5) flag(['affect', 'keywords', 'topics'], 'caution', `Only ${Math.round((withText / messages) * 100)}% of messages have text.`);
    flag('affect', 'caution', 'Lexicon sentiment (VADER) is approximate: it misses sarcasm, domain jargon and non-English text. Compare groups, not single messages.');
    if (withText < 200) flag(['topics', 'diffusion'], 'caution', 'Fewer than 200 messages with text; topics and adoption patterns will be unstable.');
  }

  const res = {};
  for (const [k, o] of Object.entries(out)) res[k] = { level: o.level, reason: o.reasons.join(' '), reasons: o.reasons };
  res._context = { egoKeys, egoNodes: egoKeys.map(k => ds.nodes.keys.indexOf(k)).filter(i => i >= 0), views: [...new Set(views)], directed: net.directed, weighting: net.settings?.weighting, components: nontrivial, isolates, nodes: n, timedShare: ev.count ? timed / ev.count : 0, span, textShare: messages ? withText / messages : 0 };
  return res;
}
