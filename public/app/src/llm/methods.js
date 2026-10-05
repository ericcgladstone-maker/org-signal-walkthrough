// Methods appendix, built deterministically (no LLM).
//
// Given what was actually done (sources and their views, construction
// settings, metrics, null models, resampling, time windows, content methods
// and their parameters), produce Markdown suitable for a paper appendix, with
// references for the standard methods. Only methods that were used are
// described and only references that are cited are listed.
//
// Results are reported with each analysis (N4, N5): null means, sd,
// intervals, z and p for every randomization test, rank intervals, window
// dates, shifts, before/after differences and diffusion tests. They come from
// store.methodsLog, where the engine adapter records a compact summary of
// each run (summarizeRun below), so the numbers are the ones the views showed.
//
// References were checked against Crossref / publisher records on 2026-10-02.

import { VIEWS, VISIBILITY } from '../core/model.js';

export const REFERENCES = {
  brandes2001: 'Brandes, U. (2001). A faster algorithm for betweenness centrality. *Journal of Mathematical Sociology, 25*(2), 163-177. https://doi.org/10.1080/0022250X.2001.9990249',
  burt1992: 'Burt, R. S. (1992). *Structural holes: The social structure of competition.* Harvard University Press.',
  blondel2008: 'Blondel, V. D., Guillaume, J.-L., Lambiotte, R., & Lefebvre, E. (2008). Fast unfolding of communities in large networks. *Journal of Statistical Mechanics: Theory and Experiment, 2008*(10), P10008. https://doi.org/10.1088/1742-5468/2008/10/P10008',
  newman2002: 'Newman, M. E. J. (2002). Assortative mixing in networks. *Physical Review Letters, 89*(20), 208701. https://doi.org/10.1103/PhysRevLett.89.208701',
  newman2003: 'Newman, M. E. J. (2003). Mixing patterns in networks. *Physical Review E, 67*(2), 026126. https://doi.org/10.1103/PhysRevE.67.026126',
  krackhardt1988: 'Krackhardt, D., & Stern, R. N. (1988). Informal networks and organizational crises: An experimental simulation. *Social Psychology Quarterly, 51*(2), 123-140. https://doi.org/10.2307/2786835',
  hutto2014: 'Hutto, C. J., & Gilbert, E. (2014). VADER: A parsimonious rule-based model for sentiment analysis of social media text. *Proceedings of the International AAAI Conference on Web and Social Media, 8*(1), 216-225. https://doi.org/10.1609/icwsm.v8i1.14550',
  maslov2002: 'Maslov, S., & Sneppen, K. (2002). Specificity and stability in topology of protein networks. *Science, 296*(5569), 910-913. https://doi.org/10.1126/science.1065103',
  page1999: 'Page, L., Brin, S., Motwani, R., & Winograd, T. (1999). *The PageRank citation ranking: Bringing order to the web* (Technical Report 1999-66). Stanford InfoLab. http://ilpubs.stanford.edu:8090/422/',
  bonacich1972: 'Bonacich, P. (1972). Factoring and weighting approaches to status scores and clique identification. *Journal of Mathematical Sociology, 2*(1), 113-120. https://doi.org/10.1080/0022250X.1972.9989806',
  bonacich1987: 'Bonacich, P. (1987). Power and centrality: A family of measures. *American Journal of Sociology, 92*(5), 1170-1182. https://doi.org/10.1086/228631',
  freeman1977: 'Freeman, L. C. (1977). A set of measures of centrality based on betweenness. *Sociometry, 40*(1), 35-41. https://doi.org/10.2307/3033543',
  freeman1979: 'Freeman, L. C. (1979). Centrality in social networks: Conceptual clarification. *Social Networks, 1*(3), 215-239. https://doi.org/10.1016/0378-8733(78)90021-7',
  marchiori2000: 'Marchiori, M., & Latora, V. (2000). Harmony in the small-world. *Physica A, 285*(3-4), 539-546. https://doi.org/10.1016/S0378-4371(00)00311-3',
  boldi2014: 'Boldi, P., & Vigna, S. (2014). Axioms for centrality. *Internet Mathematics, 10*(3-4), 222-262. https://doi.org/10.1080/15427951.2013.865686',
  watts1998: "Watts, D. J., & Strogatz, S. H. (1998). Collective dynamics of 'small-world' networks. *Nature, 393*(6684), 440-442. https://doi.org/10.1038/30918",
  seidman1983: 'Seidman, S. B. (1983). Network structure and minimum degree. *Social Networks, 5*(3), 269-287. https://doi.org/10.1016/0378-8733(83)90028-X',
  batagelj2003: 'Batagelj, V., & Zaversnik, M. (2003). *An O(m) algorithm for cores decomposition of networks* (arXiv:cs/0310049). https://arxiv.org/abs/cs/0310049',
  borgatti1997: 'Borgatti, S. P., & Everett, M. G. (1997). Network analysis of 2-mode data. *Social Networks, 19*(3), 243-269. https://doi.org/10.1016/S0378-8733(96)00301-2',
  breiger1974: 'Breiger, R. L. (1974). The duality of persons and groups. *Social Forces, 53*(2), 181-190. https://doi.org/10.2307/2576011',
  newman2001: 'Newman, M. E. J. (2001). Scientific collaboration networks. II. Shortest paths, weighted networks, and centrality. *Physical Review E, 64*(1), 016132. https://doi.org/10.1103/PhysRevE.64.016132',
  latapy2008: 'Latapy, M., Magnien, C., & Del Vecchio, N. (2008). Basic notions for the analysis of large two-mode networks. *Social Networks, 30*(1), 31-48. https://doi.org/10.1016/j.socnet.2007.04.006',
  robins2004: 'Robins, G., & Alexander, M. (2004). Small worlds among interlocking directors: Network structure and distance in bipartite graphs. *Computational and Mathematical Organization Theory, 10*(1), 69-94. https://doi.org/10.1023/B:CMOT.0000032580.12184.c0',
  barber2007: 'Barber, M. J. (2007). Modularity and community detection in bipartite networks. *Physical Review E, 76*(6), 066102. https://doi.org/10.1103/PhysRevE.76.066102',
  newman2004: 'Newman, M. E. J., & Girvan, M. (2004). Finding and evaluating community structure in networks. *Physical Review E, 69*(2), 026113. https://doi.org/10.1103/PhysRevE.69.026113',
  traag2019: 'Traag, V. A., Waltman, L., & van Eck, N. J. (2019). From Louvain to Leiden: Guaranteeing well-connected communities. *Scientific Reports, 9*, 5233. https://doi.org/10.1038/s41598-019-41695-z',
  efron1993: 'Efron, B., & Tibshirani, R. J. (1993). *An introduction to the bootstrap.* Chapman & Hall.',
  borgatti2006: 'Borgatti, S. P., Carley, K. M., & Krackhardt, D. (2006). On the robustness of centrality measures under conditions of imperfect data. *Social Networks, 28*(2), 124-136. https://doi.org/10.1016/j.socnet.2005.05.001',
  blei2003: 'Blei, D. M., Ng, A. Y., & Jordan, M. I. (2003). Latent Dirichlet allocation. *Journal of Machine Learning Research, 3*, 993-1022.',
  krippendorff2019: 'Krippendorff, K. (2019). *Content analysis: An introduction to its methodology* (4th ed.). SAGE. https://doi.org/10.4135/9781071878781',
  cohen1960: 'Cohen, J. (1960). A coefficient of agreement for nominal scales. *Educational and Psychological Measurement, 20*(1), 37-46. https://doi.org/10.1177/001316446002000104',
  wasserman1994: 'Wasserman, S., & Faust, K. (1994). *Social network analysis: Methods and applications.* Cambridge University Press. https://doi.org/10.1017/CBO9780511815478',
  kleinberg1999: 'Kleinberg, J. M. (1999). Authoritative sources in a hyperlinked environment. *Journal of the ACM, 46*(5), 604-632. https://doi.org/10.1145/324133.324140',
  sparckjones1972: 'Sparck Jones, K. (1972). A statistical interpretation of term specificity and its application in retrieval. *Journal of Documentation, 28*(1), 11-21. https://doi.org/10.1108/eb026526',
  garlaschelli2004: 'Garlaschelli, D., & Loffredo, M. I. (2004). Patterns of link reciprocity in directed networks. *Physical Review Letters, 93*(26), 268701. https://doi.org/10.1103/PhysRevLett.93.268701',
};

// In-text citation labels.
const CITE = {
  brandes2001: 'Brandes, 2001', burt1992: 'Burt, 1992', blondel2008: 'Blondel et al., 2008', newman2002: 'Newman, 2002',
  newman2003: 'Newman, 2003', krackhardt1988: 'Krackhardt & Stern, 1988', hutto2014: 'Hutto & Gilbert, 2014',
  maslov2002: 'Maslov & Sneppen, 2002', page1999: 'Page et al., 1999', bonacich1972: 'Bonacich, 1972', bonacich1987: 'Bonacich, 1987',
  freeman1977: 'Freeman, 1977', freeman1979: 'Freeman, 1979', marchiori2000: 'Marchiori & Latora, 2000', boldi2014: 'Boldi & Vigna, 2014',
  watts1998: 'Watts & Strogatz, 1998', seidman1983: 'Seidman, 1983', batagelj2003: 'Batagelj & Zaversnik, 2003',
  newman2004: 'Newman & Girvan, 2004', borgatti1997: 'Borgatti & Everett, 1997', breiger1974: 'Breiger, 1974', newman2001: 'Newman, 2001', latapy2008: 'Latapy et al., 2008', robins2004: 'Robins & Alexander, 2004', barber2007: 'Barber, 2007', traag2019: 'Traag et al., 2019', efron1993: 'Efron & Tibshirani, 1993',
  borgatti2006: 'Borgatti et al., 2006', blei2003: 'Blei et al., 2003', krippendorff2019: 'Krippendorff, 2019', cohen1960: 'Cohen, 1960',
  wasserman1994: 'Wasserman & Faust, 1994', kleinberg1999: 'Kleinberg, 1999', sparckjones1972: 'Sparck Jones, 1972',
  garlaschelli2004: 'Garlaschelli & Loffredo, 2004',
};

// Node metrics: plain-language definition and references. `directed` swaps in
// the directed wording where the definition differs.
const NODE_METRIC_TEXT = {
  contacts: ['Contacts: number of distinct people a person has a tie with, in either direction.', ['wasserman1994']],
  degree: ['Total ties (in + out): in-degree plus out-degree, so a two-way tie counts twice; contacts count each person once.', ['freeman1979']],
  inDegree: ['In-degree: number of distinct people who directed ties to the person.', ['wasserman1994']],
  outDegree: ['Out-degree: number of distinct people the person directed ties to.', ['wasserman1994']],
  strength: ['Strength: sum of tie weights (weighted degree).', ['wasserman1994']],
  inStrength: ['In-strength: sum of incoming tie weights.', ['wasserman1994']],
  outStrength: ['Out-strength: sum of outgoing tie weights.', ['wasserman1994']],
  betweenness: ['Betweenness (normalized): the share of shortest paths between pairs of other people that pass through the person, summed over pairs and divided by the number of pairs, (n - 1)(n - 2) on a directed network and (n - 1)(n - 2) / 2 on an undirected one; multiplying by that number gives the raw count. Computed with Brandes\' algorithm.', ['freeman1977', 'brandes2001']],
  betweennessWeighted: ['Weighted betweenness: as betweenness, with path length the sum of 1 / tie weight, so strong ties are short steps.', ['brandes2001']],
  closeness: ['Closeness (harmonic): the mean of 1 / distance to every other person, (1 / (n - 1)) times the sum of 1 / d; a person who cannot be reached adds 0, so it stays defined in disconnected networks. The textbook closeness, 1 / (sum of distances), is not defined there and ranks differently.', ['marchiori2000', 'boldi2014']],
  closenessWeighted: ['Weighted closeness (harmonic), with distance 1 / tie weight.', ['marchiori2000']],
  eigenvector: ['Eigenvector centrality: centrality proportional to the centrality of one\'s contacts. Computed on the undirected network with tie weights summed in both directions (a two-way tie\'s two weights add up), scaled to unit length; it matches networkx eigenvector_centrality on that symmetrized weighted graph.', ['bonacich1972', 'bonacich1987']],
  pagerank: ['PageRank: stationary probability of a random walk that follows ties in their direction, in proportion to tie weight, with damping factor 0.85 (uniform teleportation; people without outgoing ties pass their share to everyone equally), as networkx pagerank.', ['page1999']],
  hits: ['Hubs and authorities (HITS).', ['kleinberg1999']],
  clustering: ['Local clustering coefficient: share of a person\'s contact pairs that are themselves connected.', ['watts1998']],
  coreNumber: ['Core number: the largest k for which the person belongs to the k-core.', ['seidman1983', 'batagelj2003']],
  reciprocity: ['Reciprocity (per person): share of a person\'s directed ties that are returned.', ['wasserman1994', 'garlaschelli2004']],
  constraint: ['Constraint: Burt\'s measure of how much a person\'s contacts are connected to each other (low constraint indicates brokerage opportunity), with tie weights as Burt\'s proportional tie strengths.', ['burt1992']],
  effectiveSize: ['Effective size: number of contacts minus the redundancy among them, with tie weights (Burt\'s formula).', ['burt1992']],
  egoDensity: ['Ego-network density: density of ties among a person\'s contacts.', ['wasserman1994']],
  twoModeDegree: ['Two-mode degree: the share of the other mode a node is tied to (degree divided by the size of the other mode).', ['borgatti1997']],
  twoModeBetweenness: ['Two-mode betweenness: betweenness over unordered pairs divided by the largest value possible for a node of that mode given both mode sizes (Borgatti-Everett normalization).', ['borgatti1997', 'brandes2001']],
  twoModeCloseness: ['Two-mode closeness: the smallest possible sum of distances for a node of that mode, m + 2(n - 1), divided by the node\'s sum of distances, times the share of the network it can reach.', ['borgatti1997']],
  twoModeClustering: ['Two-mode clustering: for each node, the mean overlap (Jaccard) of its neighbors with those of each node two steps away (Latapy, dot mode).', ['latapy2008']],
};
const UNDIRECTED_DEGREE = 'Contacts (degree): number of distinct people a person has a tie with.';

// Which measures use tie weights. Path measures (betweenness, closeness,
// average path length) and clustering run on the unweighted network unless
// their weighted versions are listed; saying so matters because changing the
// weighting then leaves them unchanged (D9).
const PATH_UNWEIGHTED = ['betweenness', 'closeness'];
const SHORT = { betweenness: 'betweenness', closeness: 'closeness', strength: 'strength', inStrength: 'in-strength', outStrength: 'out-strength',
  betweennessWeighted: 'weighted betweenness', closenessWeighted: 'weighted closeness', eigenvector: 'eigenvector centrality', pagerank: 'PageRank',
  constraint: 'constraint', effectiveSize: 'effective size' };
const WEIGHTED = ['strength', 'inStrength', 'outStrength', 'betweennessWeighted', 'closenessWeighted', 'eigenvector', 'pagerank', 'constraint', 'effectiveSize'];

export const NETWORK_STAT_TEXT = {
  density: ['density (share of possible ties present)', ['wasserman1994']],
  reciprocity: ['reciprocity (share of directed ties that are returned, over the whole network)', ['garlaschelli2004']],
  transitivity: ['transitivity (share of connected triples that are closed)', ['wasserman1994']],
  avgClustering: ['average local clustering', ['watts1998']],
  components: ['number of connected components', ['wasserman1994']],
  largestComponentShare: ['share of nodes in the largest component', []],
  avgPathLength: ['average shortest-path length within components', ['watts1998']],
  degreeCentralization: ['degree centralization', ['freeman1979']],
  strengthGini: ['Gini coefficient of node strength (inequality of activity)', []],
  modularity: ['modularity of the detected partition', ['newman2004']],
  twoModeDensity: ['two-mode density (ties divided by the product of the two mode sizes)', ['borgatti1997']],
  robinsAlexander: ['two-mode clustering (four times the four-cycles over the three-paths)', ['robins2004']],
  barberModularity: ['bipartite modularity of the detected partition', ['barber2007']],
  assortativity: ['degree assortativity', ['newman2002']],
};

const STAT_NAME = {
  reciprocity: 'reciprocity', transitivity: 'transitivity', avgClustering: 'average clustering', modularity: 'modularity',
  attrAssortativity: 'attribute assortativity', eiIndex: 'E-I index', density: 'density', assortativity: 'degree assortativity',
};

const RULE_TEXT = {
  reply: ['Replies', 'a reply links the replier to the author of the message replied to'],
  mention: ['Mentions', 'a mention links the author to each person mentioned'],
  dm: ['Direct messages', 'a direct message links sender and recipient(s)'],
  to: ['To recipients', 'an email links the sender to each To recipient'],
  cc: ['Cc recipients', 'an email links the sender to each Cc recipient'],
  bcc: ['Bcc recipients', 'an email links the sender to each Bcc recipient'],
  adjacency: ['Turn-taking', 'consecutive messages by different people in the same channel within a time window link their authors'],
  copresence: ['Co-presence', 'attendance at the same meeting or membership of the same small group links the people present'],
  declared: ['Declared ties', 'a survey nomination, a hand-entered tie or a declared connection links the two people'],
  repost: ['Reposts', 'a repost links the reposter to the original author'],
  like: ['Likes', 'a like links the liker to the author'],
  follow: ['Follows', 'a follow links the follower to the followed account'],
  reaction: ['Reactions', 'a reaction links the reacting person to the message author'],
};

const VIEW_TEXT = {
  [VIEWS.FULL]: 'a bounded group in which everyone\'s interactions are recorded',
  [VIEWS.EGO]: 'one person\'s own interactions (an ego network); ties among that person\'s contacts are not observed',
  [VIEWS.CHAT]: 'a single conversation',
  [VIEWS.SAMPLE]: 'a sample of a larger population',
  [VIEWS.AUTHORED]: 'only what one account wrote',
};

const VISIBILITY_TEXT = { public: 'public channels', private: 'private channels', direct: 'direct messages', group: 'group chats and meetings', unknown: 'unknown visibility' };

// Display names for source formats (the importers' ids are lowercase).
const FORMAT_NAME = {
  slack: 'Slack', teams: 'Microsoft Teams', email: 'Email', mbox: 'Email (mbox)', gmail: 'Gmail', eml: 'Email (.eml)', pst: 'Outlook', calendar: 'Calendar', ics: 'Calendar (.ics)',
  tabular: 'Spreadsheet', csv: 'Spreadsheet', profile: 'Attribute table', survey: 'Survey', graphml: 'GraphML', gexf: 'GEXF', gml: 'GML', pajek: 'Pajek', ucinet: 'UCINET',
  'network-canvas': 'Network Canvas', 'x-archive': 'X archive', 'x-research': 'X research export', bluesky: 'Bluesky', mastodon: 'Mastodon', threads: 'Threads',
  linkedin: 'LinkedIn', whatsapp: 'WhatsApp', imessage: 'iMessage', telegram: 'Telegram', meta: 'Facebook and Instagram', facebook: 'Facebook', instagram: 'Instagram',
  discord: 'Discord', reddit: 'Reddit', draw: 'Hand-drawn network', drawn: 'Hand-drawn network', ego: 'Ego-network interview', roster: 'Roster', perceived: 'Perceived networks', generated: 'Generated',
};
const formatName = f => FORMAT_NAME[String(f || '').toLowerCase()] || (f ? String(f).charAt(0).toUpperCase() + String(f).slice(1) : 'Unknown format');

// A source is an attribute table when it describes people (one row each) and
// records no interactions: an HR roster joined to a Slack export, say. Its
// "view" then says nothing about whose interactions are recorded.
const isAttributeTable = src => src.tableKind === 'nodes' || src.role === 'attributes' || /^(profile|attributes?)$/i.test(src.format || '')
  || (src.counts && Number(src.counts.events ?? src.counts.messages ?? 0) === 0 && Number(src.counts.nodes ?? src.counts.people ?? src.counts.rows ?? 0) > 0 && src.tableKind !== 'edges');

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDate = t => {
  if (typeof t !== 'number' || !Number.isFinite(t)) return null;
  const d = new Date(t);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};
const fmtNum = x => (typeof x === 'number' ? x.toLocaleString('en-US') : String(x));
const pct = (a, b) => (b > 0 ? `${Math.round((100 * a) / b)}%` : 'n/a');
const list = xs => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const uniq = xs => [...new Set(xs.filter(Boolean))];
// Several runs of one kind may be recorded (input.nullModels, a single input.nullModel, ...).
const runs = (many, one) => [...(Array.isArray(many) ? many : []), ...(one ? [].concat(one) : [])];

// How a survey's two answers about a pair became a tie (src.combine, set by
// the survey importer; src.mergeRule, set by the roster writer for shared
// and roster surveys).
const COMBINE_TEXT = {
  union: 'Answers were combined by union: a tie exists if either person named the other; ties are undirected.',
  intersection: 'Only reciprocated nominations were kept: a tie exists only if both people named each other; ties are undirected.',
  respondent: 'Ties were kept as reported: each runs from the respondent to the person they named.',
};
const isSurvey = src => src.family === 'survey';

// "9 response files" (the builder records a count, not names) or a list of files.
function filesRead(src) {
  const f = src.fileNames || [];
  if (f.length === 1 && /^\d+ [a-z ]*files?$/i.test(f[0])) return ` ${f[0]} read.`;
  if (!f.length) return '';
  return isSurvey(src) && src.format === 'shared-survey' ? ` ${fmtNum(f.length)} response file${f.length === 1 ? '' : 's'} read.` : ` ${fmtNum(f.length)} file${f.length === 1 ? '' : 's'} read.`;
}

// One source count in words. Importers name their counts in the plural
// ("messages", "duplicates-skipped"); the generator counts by event type,
// which is singular ("message", "leave"). Event types get their noun, plural
// unless the count is 1; hyphenated keys read as words.
const EVENT_NOUN = {
  message: ['message', 'messages'], reaction: ['reaction', 'reactions'], leave: ['leave', 'leaves'], join: ['join', 'joins'],
  copresence: ['co-presence event', 'co-presence events'], declared: ['declared tie', 'declared ties'],
  repost: ['repost', 'reposts'], like: ['like', 'likes'], follow: ['follow', 'follows'],
};
export function countWords(k, v) {
  const noun = EVENT_NOUN[k] ? EVENT_NOUN[k][v === 1 ? 0 : 1] : String(k).replace(/-/g, ' ');
  return `${fmtNum(v)} ${noun}`;
}

// src.label, when given, is the import report's short source name.
function sourceLine(src) {
  const name = src.label || formatName(src.format);
  const counts = Object.entries(src.counts || {}).filter(([, v]) => typeof v === 'number').map(([k, v]) => countWords(k, v)).join(', ');
  // Family, medium and context only where they add something the format name
  // does not already say ("Email (email, email, workplace)" said nothing).
  const said = name.toLowerCase();
  const detail = uniq([src.medium, src.context].map(x => String(x || '').toLowerCase()))
    .filter(x => x && x !== 'unknown' && !said.includes(x) && x !== String(src.format || '').toLowerCase() && !(isSurvey(src) && x === 'survey'));
  const head = `- **${name}**${detail.length ? ` (${detail.join(', ')})` : ''}.`;
  let role;
  if (isAttributeTable(src)) role = ' An attribute table with one row per person: it adds attributes to people already in the data and records no interactions.';
  else if (isSurvey(src) && src.view === VIEWS.FULL) role = ' A roster survey: each respondent named people from a fixed list, so the ties are self-reports about a bounded group.';
  else role = ` View: *${src.view}*, i.e. ${VIEW_TEXT[src.view] || 'unspecified'}.${src.egoKey ? ' The ego is the export owner.' : ''}`;
  const window = src.window && (fmtDate(src.window.start) || fmtDate(src.window.end)) ? ` Covers ${fmtDate(src.window.start) || 'the start'} to ${fmtDate(src.window.end) || 'the end'}.` : '';
  const rule = src.combine || src.mergeRule;
  const combine = rule && COMBINE_TEXT[rule] ? ` ${COMBINE_TEXT[rule]}` : '';
  const responded = src.survey?.responded ? ` ${fmtNum(src.survey.responded.length)} people responded${src.survey.missing?.length ? `; ${fmtNum(src.survey.missing.length)} did not (they appear only as others named them)` : ''}.` : '';
  // Times are irrelevant to a survey's ties; its time zone says nothing.
  const tz = src.tz && !isSurvey(src) ? ` Time zone: ${src.tz}.` : '';
  return `${head}${role}${combine}${responded}${filesRead(src)}${counts ? ` Records: ${counts}.` : ''}${tz}${window}`;
}

// ---- results recorded by the app --------------------------------------------------
//
// summarizeRun(kind, result, { labels }) -> a small JSON-safe summary of one
// analysis run, kept in store.methodsLog next to its options by the engine
// adapter (src/ui/services/engine.js). Kinds: nullModel, groups, resampling,
// time, shifts, beforeAfter, diffusion. Unknown kinds give null.
const finite = x => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o?.[k] != null && (typeof o[k] !== 'number' || Number.isFinite(o[k]))).map(k => [k, o[k]]));
const STAT_FIELDS = ['observed', 'mean', 'sd', 'z', 'p', 'pUpper', 'pLower', 'lo', 'hi', 'replicates', 'partition'];

export function summarizeRun(kind, r, { labels = null } = {}) {
  if (!r || typeof r !== 'object') return null;
  if (kind === 'nullModel') {
    const stats = {};
    for (const [k, v] of Object.entries(r)) if (k !== 'meta' && k !== 'nodes' && v && typeof v === 'object' && 'observed' in v) stats[k] = pick(v, STAT_FIELDS);
    return { stats, meta: pick(r.meta || {}, ['reps', 'seed', 'swapsPerEdge', 'acceptedSwapShare', 'model', 'modularity', 'attr', 'pFloor']) };
  }
  if (kind === 'groups') {
    return { ...pick(r, ['assortativity', 'eiIndex', 'withinTies', 'betweenTies']), groups: Array.isArray(r.groups) ? r.groups.length : null };
  }
  if (kind === 'resampling') {
    const nodes = Array.isArray(r) ? r : r.nodes || [];
    return { top: nodes.slice(0, 5).map(x => ({ label: x.label ?? labels?.[x.node] ?? String(x.node), ...pick(x, ['rank', 'lo', 'hi', 'topShare', 'value']) })), reps: r.meta?.reps ?? null };
  }
  if (kind === 'time') {
    const w = r.windows || [];
    return {
      window: r.meta?.window ?? null, windows: w.length,
      first: w[0] ? { start: w[0].start, end: w[0].end } : null,
      last: w.length ? { start: w[w.length - 1].start, end: w[w.length - 1].end } : null,
      dataStart: finite(r.meta?.start), dataEnd: finite(r.meta?.end),
      partial: w.filter(x => (x.coverage ?? 1) < 1).length,
    };
  }
  if (kind === 'shifts') {
    const list = r.shifts || [];
    return {
      meta: pick(r.meta || {}, ['method', 'threshold', 'nodeThreshold', 'groupThreshold', 'baseline', 'windows', 'seriesScanned', 'partialWindowsSkipped', 'sourceEdgeWindowsSkipped']),
      count: list.length,
      top: list.slice(0, 5).map(x => ({ ...pick(x, ['target', 'label', 'metric', 'windowLabel', 'start', 'z', 'statistic', 'direction']) })),
    };
  }
  if (kind === 'beforeAfter') {
    const metrics = {};
    for (const [m, v] of Object.entries(r.node || {})) if (v && v.n) metrics[m] = pick(v, ['n', 'meanBefore', 'meanAfter', 'meanDiff', 'sdDiff', 'dz', 'p', 'reps']);
    return {
      date: r.date, span: r.span,
      before: pick(r.before || {}, ['start', 'end', 'nodes', 'ties']), after: pick(r.after || {}, ['start', 'end', 'nodes', 'ties']),
      metrics, ties: pick(r.ties || {}, ['formed', 'dissolved', 'persisted', 'jaccard']),
      meta: pick(r.meta || {}, ['reps', 'test', 'effectSize']),
    };
  }
  if (kind === 'diffusion') {
    return {
      terms: (r.terms || []).slice(0, 12).map(t => ({ ...pick(t, ['term', 'adopters', 'exposed', 'eligible', 'exposedShare']), null: pick(t.null || {}, ['mean', 'sd', 'z', 'pUpper', 'pAdjusted', 'reps', 'ceiling']) })),
      meta: pick(r.meta || {}, ['reps', 'seed', 'window', 'auto', 'neighbours', 'null', 'correction', 'tested']),
    };
  }
  return null;
}

// Numbers in prose: three significant digits ("0.201", "-0.00919", "86.2").
const n3 = x => (finite(x) == null ? 'n/a' : Math.abs(x) >= 1000 ? fmtNum(Math.round(x)) : String(Number(x.toPrecision(3))));
const share = x => (finite(x) == null ? 'n/a' : `${Math.round(x * 100)}%`);
// p from an empirical test with `reps` random draws: at its floor, say that
// none was as extreme (decision 5), worded for the test as implemented:
// 'two' (distance from the random average, nullModel), 'diff' (an absolute
// difference at least as large, the before-and-after relabelling test) or
// 'upper' (one-sided, at least the observed value, diffusion).
function pWords(p, reps, what = 'randomized networks', sided = 'two') {
  if (finite(p) == null) return 'no p-value (the statistic was undefined in the random networks)';
  const as = sided === 'upper' ? 'reached the observed value' : sided === 'diff' ? 'gave a difference this large in either direction' : 'came this far from their average';
  if (reps > 0 && p <= (1 / (reps + 1)) * (1 + 1e-9)) return `none of the ${fmtNum(reps)} ${what} ${as} (p ≤ 1/${fmtNum(reps + 1)})`;
  return p < 0.001 ? 'p < 0.001' : `p = ${p.toFixed(3)}`;
}
// The last day a window or period covers: ends are exclusive.
const lastDay = end => (finite(end) == null ? null : fmtDate(end - 1));

// Labels of grouping attributes; the detected communities have an internal key (N12).
const COMMUNITY_KEYS = new Set(['community', '__community']);
const METRIC_WORDS = (directed) => ({ degree: directed ? 'total ties (in + out)' : 'contacts (degree)', contacts: 'contacts', strength: 'strength', betweenness: 'betweenness', closeness: 'closeness (harmonic)', constraint: 'constraint', effectiveSize: 'effective size', inDegree: 'in-degree', outDegree: 'out-degree' });

// buildMethodsAppendix(input) -> markdown
// input = { dataset | meta, settings, network, metrics: [names], networkStats: [names], approx: { [metric]: text },
//           sourceLabels: [short name per source, from the import report],
//           communities: { method, resolution, seed, runs },
//           groups: [attrKeys actually analyzed] | [{ attr, result }], attributeLabels: { key: label },
//           nullModel | nullModels: [{ stats, reps, seed, attr, communities, result }],
//           resampling: { metric(s), reps, top, seed, scheme, result } | [..],
//           time: [{ window, start, end, metrics, purpose, result }], shifts: [{ method, threshold, baseline, result }],
//           beforeAfter: [{ date, metrics, result }], diffusion: [{ terms, reps, result }],
//           content: { affect, keywords, topics, coding }, software: { name, version } }
// `result` fields are summarizeRun summaries. Only what is passed is
// described: the caller passes what was actually run (the UI records it in
// store.methodsLog), never the defaults of views that were not opened.
// timeSeries window names -> the adjective used in prose.
const WINDOW_WORD = { day: 'daily', week: 'weekly', month: 'monthly' };
const WINDOW_NOUN = { day: 'day', week: 'week', month: 'month' };

export function buildMethodsAppendix(input = {}) {
  const used = new Set();
  const cite = keys => { keys.forEach(k => used.add(k)); return keys.length ? ` (${keys.map(k => CITE[k]).join('; ')})` : ''; };
  const meta = input.dataset?.meta || input.meta || {};
  const sources = (meta.sources || []).map((src, i) => (input.sourceLabels?.[i] ? { ...src, label: input.sourceLabels[i] } : src));
  const s = input.settings || {};
  const net = input.network || null;
  const directed = net ? !!net.directed : !!s.directed;
  const out = [];
  const sw = input.software || { name: 'Org Signal', version: '2' };
  const attrLabel = k => (COMMUNITY_KEYS.has(k) ? 'the detected communities' : `\`${input.attributeLabels?.[k] || k}\``);
  const words = METRIC_WORDS(directed);
  const mword = m => words[m] || m;
  const interaction = sources.filter(x => !isAttributeTable(x));
  // Survey-only data: no broadcasts, bots or message construction to describe (C10).
  const surveyOnly = interaction.length > 0 && interaction.every(isSurvey);

  out.push('# Methods appendix', '');

  // 1. Data
  out.push('## Data sources', '');
  if (!sources.length) out.push('No source information was recorded.', '');
  for (const src of sources) {
    out.push(sourceLine(src));
    for (const w of src.warnings || []) out.push(`  - Import note: ${String(w.message).replace(/\.\s*$/, '')}${w.count > 1 ? ` (${fmtNum(w.count)})` : ''}.`);
  }
  // Attribute joins: which column matched which identity, and how many matched.
  for (const j of meta.profileJoins || []) {
    const on = { email: 'email address', name: 'name', id: 'account id', key: 'account key', platformId: 'account id' }[j.matchOn] || j.matchOn || 'identity';
    const cols = (j.columns || []).filter(c => c !== j.keyColumn);
    const empty = (j.emptyColumns || []).filter(c => c !== j.keyColumn);
    out.push(`- **Attribute join.** Rows were joined to people by matching the column \`${j.keyColumn}\` to each person's ${on}; ${fmtNum(j.matched ?? 0)} of ${fmtNum(j.rows ?? 0)} rows (${pct(j.matched ?? 0, j.rows ?? 0)}) matched exactly one person.${cols.length ? ` Columns added: ${cols.map(c => `\`${c}\``).join(', ')}.` : ''}${empty.length ? ` Not added because no matched row had a value: ${empty.map(c => `\`${c}\``).join(', ')}.` : ''} Unmatched people have no value for these attributes.`);
  }
  if (input.dataset?.nodes) out.push('', `After identity matching the dataset contained ${fmtNum(input.dataset.nodes.count)} ${surveyOnly ? 'people' : 'people or accounts'} and ${fmtNum(input.dataset.events?.count ?? 0)} ${surveyOnly ? 'nominations or reported ties' : 'events'}.`);
  out.push('');

  // 2. Construction
  out.push('## Network construction', '');
  const rules = Object.entries(s.rules || {}).filter(([, r]) => r?.on);
  if (rules.length) {
    out.push('Ties were built from the following event rules:', '');
    for (const [k, r] of rules) {
      let extra = '';
      if (k === 'adjacency' && r.windowMin != null) extra = ` (window ${r.windowMin} minutes)`;
      if (k === 'copresence' && r.normalize) extra = ' (weights normalized by group size)';
      const [label, text] = RULE_TEXT[k] || [k, 'custom rule'];
      out.push(`- ${label}: ${text}${extra}; weight ${r.weight ?? 1}.`);
    }
    out.push('');
  }
  const parts = [];
  parts.push(`The network was treated as ${s.directed ? 'directed' : 'undirected'}`);
  // Survey weights set by the builders: a roster's rating (roster-tie-weight)
  // or the share of informants reporting a tie (css-consensus-weight).
  const noted = code => interaction.some(x => (x.warnings || []).some(w => w.code === code));
  if (s.tieFields?.weight) parts.push(`tie weights were the answers to \`${s.tieFields.weight}\``);
  else if (s.weighting !== 'binary' && noted('roster-tie-weight')) parts.push('tie weights were the respondents\' ratings of each tie (for a pair combined from two answers, the larger under union and the smaller under reciprocated only; unrated ties count 1), as the import note says');
  else if (s.weighting !== 'binary' && noted('css-consensus-weight')) parts.push('tie weights were the share of informants who reported each tie (consensus structure: 0.75 means three in four)');
  else if (s.weighting) parts.push(`tie weights were ${s.weighting === 'count' ? (surveyOnly ? 'the number of reports behind each tie' : 'event counts') : s.weighting === 'log' ? 'log-transformed event counts, log(1 + count)' : 'binary (present or absent)'}`);
  if (s.minWeight != null && s.minWeight > 0) parts.push(`ties below weight ${s.minWeight} were dropped`);
  if (s.maxRecipients && !surveyOnly) parts.push(`messages with more than ${s.maxRecipients} recipients were excluded, so broadcasts do not create ties`);
  if (s.time && (fmtDate(s.time.start) || fmtDate(s.time.end))) parts.push(`only events from ${fmtDate(s.time.start) || 'the start of the data'} ${fmtDate(s.time.end) ? `up to but not including ${fmtDate(s.time.end)}` : 'to the end of the data'} were used`);
  else if (input.dataset?.events?.t?.length && !surveyOnly) {
    // No range set: say what the data covers, so the window is never implicit.
    let lo = Infinity, hi = -Infinity;
    for (const t of input.dataset.events.t) if (Number.isFinite(t)) { if (t < lo) lo = t; if (t > hi) hi = t; }
    if (Number.isFinite(lo)) parts.push(`all events were used, from ${fmtDate(lo)} to ${fmtDate(hi)}`);
  }
  // Every visibility layer on is no limit at all.
  if (s.visibility?.length && !surveyOnly && !VISIBILITY.every(v => s.visibility.includes(v))) parts.push(`contexts were limited to ${list(s.visibility.map(v => VISIBILITY_TEXT[v] || v))}`);
  if (s.media?.length) parts.push(`media were limited to ${list(s.media)}`);
  if (s.excludeBots && !surveyOnly) parts.push('accounts flagged as bots were excluded');
  if (s.includeIsolates != null) parts.push(s.includeIsolates ? (surveyOnly ? 'people who named nobody and were named by nobody were kept' : 'isolates were kept') : 'isolates were removed');
  out.push(parts.join('; ') + '.');
  // Two-mode data: say which network was analyzed and how a projection was weighted.
  const tm = s.twoMode;
  if (tm) {
    const labels = net?.twoMode?.labels || ['actors', 'events'];
    const [a, b] = labels.map(x => String(x).toLowerCase());
    if (tm.view === 'two-mode') out.push('', `The data are two-mode (${a} and ${b}): the network analyzed has ties only between ${a} and ${b}, undirected; ties within a mode were left out. Two-mode measures use the Borgatti and Everett normalizations${cite(['borgatti1997'])}.`);
    else {
      const [me, via] = tm.view === 'mode0' ? [a, b] : [b, a];
      const how = tm.projection === 'newman' ? `each shared one adding 1 / (its size - 1)${cite(['newman2001'])}` : tm.projection === 'binary' ? 'weight 1 for any overlap' : `weighted by the number shared${cite(['breiger1974'])}`;
      out.push('', `The data are two-mode (${a} and ${b}); the network analyzed is the one-mode projection onto ${me}: two ${me} are tied when they share at least ${tm.minShared || 1} of the ${via}, ${how}.`);
    }
  }
  if (net) out.push('', `The resulting network had ${fmtNum(net.n)} ${surveyOnly ? 'people' : 'nodes'} and ${fmtNum(net.edges?.count ?? net.edgeCount ?? 0)} ${net.directed ? 'directed' : 'undirected'} ties.`);
  out.push('');

  // 3. Measures
  const metrics = (input.metrics || []).filter(m => NODE_METRIC_TEXT[m]);
  const nstats = (input.networkStats || []).filter(m => NETWORK_STAT_TEXT[m]);
  if (metrics.length || nstats.length) {
    out.push('## Measures', '');
    // Contacts first: it is the People view's default column.
    const ordered = [...metrics].sort((a, b) => (b === 'contacts') - (a === 'contacts'));
    for (const m of ordered) {
      if (m === 'degree' && !directed && metrics.includes('contacts')) continue;
      const [text0, refs] = NODE_METRIC_TEXT[m];
      const text = m === 'degree' && !directed ? UNDIRECTED_DEGREE : text0;
      const approx = input.approx?.[m] ? ` Approximation: ${input.approx[m]}.` : '';
      out.push(`- ${text}${cite(refs)}${approx}`);
    }
    if (nstats.length) out.push(`- Whole-network statistics: ${nstats.map(k => NETWORK_STAT_TEXT[k][0] + cite(NETWORK_STAT_TEXT[k][1])).join('; ')}.`);
    // Path weighting, stated once: which measures the weighting choice reaches.
    const unweighted = metrics.filter(m => PATH_UNWEIGHTED.includes(m));
    const weighted = metrics.filter(m => WEIGHTED.includes(m));
    if (unweighted.length || nstats.includes('avgPathLength')) {
      const names = [...unweighted.map(m => SHORT[m]), ...(nstats.includes('avgPathLength') ? ['average path length'] : [])];
      out.push(`- Path weighting: ${list(names)} ${names.length === 1 ? 'was' : 'were'} computed on shortest paths that ignore tie weights (every tie is one step), so the weighting choice does not change ${names.length === 1 ? 'it' : 'them'}.${weighted.length ? ` Tie weights enter ${list(weighted.map(m => SHORT[m]))}.` : ''}`);
    }
    out.push('');
  }

  // 4. Communities
  if (input.communities) {
    const c = input.communities;
    out.push('## Community detection', '');
    out.push(`Communities were detected with the Louvain method${cite(['blondel2008'])}, which maximizes modularity${cite(['newman2004'])}, at resolution ${c.resolution ?? 1} with random seed ${c.seed ?? 'unspecified'}${c.runs > 1 ? ` over ${c.runs} runs` : ''}${Number.isFinite(c.count) ? `; it found ${fmtNum(c.count)} communities${c.isolates ? ` of two or more people, plus ${fmtNum(c.isolates)} ${c.isolates === 1 ? 'person' : 'people'} with no ties (not counted as communities)` : ''} (modularity ${n3(c.modularity)}), numbered from 1 ${c.numbering === 'matched' ? 'by matching (after a rebuild each community keeps the number of the earlier community it shares most people with, so numbers need not follow size)' : 'by size'} in the app and in every export` : ''}. Louvain partitions depend on the seed and can contain poorly connected communities${cite(['traag2019'])}, so community boundaries should be read as one plausible partition.`, '');
  }

  // 5. Groups: only the attributes actually analyzed, with their mixing results.
  const groupRuns = uniqBy((input.groups || []).map(g => (typeof g === 'string' ? { attr: g } : g)), g => g.attr);
  if (groupRuns.length) {
    out.push('## Group comparison', '');
    const named = groupRuns.map(g => attrLabel(g.attr));
    out.push(`Groups were defined by ${groupRuns.length > 1 ? 'each of ' : ''}${list(named)}. Mixing between groups was summarized by attribute assortativity${cite(['newman2003'])} (0 = no preference, 1 = ties only within groups) and the E-I index, (external - internal) / (external + internal) ties${cite(['krackhardt1988'])} (-1 = all ties inside groups, +1 = all between).`);
    for (const g of groupRuns) {
      const r = g.result;
      if (!r || (finite(r.assortativity) == null && finite(r.eiIndex) == null)) continue;
      out.push(`- ${attrLabel(g.attr).replace(/^the d/, 'D')}: assortativity ${n3(r.assortativity)}, E-I index ${n3(r.eiIndex)}${finite(r.withinTies) != null ? ` (${fmtNum(r.withinTies)} ties within groups, ${fmtNum(r.betweenTies)} between)` : ''}${r.groups ? ` across ${fmtNum(r.groups)} groups` : ''}.`);
    }
    out.push('');
  }

  // 6. Inference: one paragraph per run, with its own replicate count and results.
  const nulls = runs(input.nullModels, input.nullModel);
  const resamples = runs(input.resamplings, input.resampling);
  if (nulls.length || resamples.length) {
    out.push('## Statistical comparison and robustness', '');
    nulls.forEach((nm, i) => {
      const res = nm.result;
      const reps = res?.meta?.reps ?? nm.reps;
      const statKeys = res ? Object.keys(res.stats) : (nm.stats || []);
      const stats = statKeys.map(x => STAT_NAME[x] || x);
      const target = nm.attr && !COMMUNITY_KEYS.has(nm.attr) ? ` for groups defined by ${attrLabel(nm.attr)}` : nm.communities || COMMUNITY_KEYS.has(nm.attr) ? ' for the detected communities' : '';
      const model = res?.meta?.model ? ` (${res.meta.model}${res.meta.swapsPerEdge ? `, ${res.meta.swapsPerEdge} swaps per tie` : ''})` : '';
      const how = i === 0 ? ` degree-preserving randomizations produced by edge swapping${cite(['maslov2002'])}` : ' degree-preserving randomizations';
      out.push(`Observed ${list(stats) || 'statistics'}${target} ${stats.length === 1 ? 'was' : 'were'} compared with ${fmtNum(reps)}${how}${model} (seed ${res?.meta?.seed ?? nm.seed ?? 'unspecified'}).${res?.meta?.modularity && res.stats?.modularity ? ` For modularity, Louvain community detection was re-run on each of the ${fmtNum(reps)} rewired networks (seeded per network), and the best modularity it found there was compared with what the same search finds on the observed ties; tie weights were ignored on both sides.` : ''}`);
      if (res) {
        out.push('');
        for (const k of statKeys) {
          const x = res.stats[k];
          const lab = STAT_NAME[k] || k;
          out.push(`- ${lab.charAt(0).toUpperCase()}${lab.slice(1)}: observed ${n3(x.observed)}; the randomized networks averaged ${n3(x.mean)} (sd ${n3(x.sd)}; 95% between ${n3(x.lo)} and ${n3(x.hi)}); z ${n3(x.z)}; ${pWords(x.p, x.replicates ?? reps)}, two-sided.${k === 'modularity' && finite(x.partition) != null ? ` The partition shown in the app has modularity ${n3(x.partition)} on the same unweighted ties.` : ''}`);
        }
      }
      out.push('');
    });
    if (nulls.length) out.push(`z is (observed - random mean) / random sd. p is the ${nulls[0].pDefinition || 'two-sided empirical p-value with the +1 correction, (k + 1) / (R + 1), where k of the R randomized networks were at least as far from their mean as the observed value'}; its smallest possible value is 1 / (R + 1).`, '');
    resamples.forEach((r, i) => {
      const ms = [].concat(r.metric || r.metrics || []).map(mword).join(', ');
      out.push(`Rank stability for ${ms || 'node rankings'} was assessed by recomputing the network on ${fmtNum(r.reps)} resamples${r.scheme ? ` (${r.scheme})` : ' of events'}${i === 0 ? cite(['efron1993']) : ''} (seed ${r.seed ?? 'unspecified'}); we report each person's 95% rank interval and how often they stayed in the top ${r.top ?? 'k'}.`);
      const top = r.result?.top || [];
      if (top.length) out.push('', ...top.map(x => `- ${x.label}: rank ${fmtNum(x.rank)}; 95% interval ${fmtNum(Math.round(x.lo))} to ${fmtNum(Math.round(x.hi))}; in the top ${r.top ?? 'k'} in ${share(x.topShare)} of resamples.`));
      out.push('');
    });
    if (resamples.length) out.push(`Resampling events varies how much each tie was used; it cannot test whether a tie exists at all, and betweenness and closeness ignore tie weights, so narrow intervals for them mostly show that the same ties reappear in every resample. They are not evidence that the ties were measured without error${cite(['borgatti2006'])}.`, '');
  }

  // 7. Time
  const times = runs(input.times, input.time);
  const shifts = runs(input.shifts, null);
  const befores = runs(input.beforeAfter, null);
  if (times.length || shifts.length || befores.length) {
    out.push('## Change over time', '');
    // One sentence per distinct run; the same request made twice is described once.
    const seen = new Set();
    for (const t of times) {
      const r = t.result;
      const unit = WINDOW_WORD[r?.window || t.window] || (t.window ? `${t.window}` : '');
      const ms = (t.metrics || []).map(mword);
      const first = r?.first?.start ?? t.start, last = r?.last?.end ?? t.end;
      const what = ms.length ? list(ms) : 'measures';
      let line = `${t.purpose ? `For the ${t.purpose}, ${what}` : `${what.charAt(0).toUpperCase()}${what.slice(1)}`} ${ms.length === 1 && !/ties|contacts/.test(what) ? 'was' : 'were'} recomputed in ${r?.windows ? `${fmtNum(r.windows)} ` : ''}consecutive ${unit ? `${unit} ` : ''}windows${fmtDate(first) ? `, the first starting ${fmtDate(first)}` : ''}${lastDay(last) ? ` and the last ending ${lastDay(last)} (inclusive)` : ''}, using the same construction rules in every window.`;
      if (r && finite(r.dataStart) != null) {
        line += ` The data run from ${fmtDate(r.dataStart)} to ${lastDay(r.dataEnd)}${r.partial ? `, so ${r.partial === 1 ? '1 window at the edges is' : `${r.partial} windows at the edges are`} only partly covered; partly covered ${WINDOW_NOUN[r.window] || 'window'}s are left out of shift detection and person profiles` : ''}.`;
      }
      if (!seen.has(line)) { seen.add(line); out.push(line); }
    }
    if (times.length) out.push('A tie was counted as formed in the first window in which it appeared and dissolved in the first window after its last appearance.');
    for (const sh of shifts) {
      const m = sh.result?.meta || {};
      const method = (m.method || sh.method) === 'cusum'
        ? `a two-sided CUSUM on each series standardized by its first ${m.baseline ?? sh.baseline ?? 8} windows (threshold ${m.threshold ?? sh.threshold ?? 6})`
        : `a robust z-score: each window's value against the median and median absolute deviation (MAD) of the ${m.baseline ?? sh.baseline ?? 8} preceding windows, flagged at |z| ≥ ${m.threshold ?? sh.threshold ?? 3.5} for whole-network series${m.groupThreshold ? `, ${m.groupThreshold} for each group` : ''}${m.nodeThreshold ? ` and ${m.nodeThreshold} for each person (stricter, because many series are scanned)` : ''}`;
      out.push('', `Shifts were detected with ${method}.${finite(m.seriesScanned) != null ? ` ${fmtNum(m.seriesScanned)} series were scanned over ${fmtNum(m.windows)} windows.` : ''}${m.partialWindowsSkipped ? ` ${fmtNum(m.partialWindowsSkipped)} partly covered windows were not tested.` : ''}${m.sourceEdgeWindowsSkipped ? ` Windows at the start or end of a source were not tested (${fmtNum(m.sourceEdgeWindowsSkipped)}), so an export starting is not read as a change.` : ''}`);
      const top = sh.result?.top || [];
      if (sh.result) out.push(sh.result.count ? `${fmtNum(sh.result.count)} ${sh.result.count === 1 ? 'shift was' : 'shifts were'} flagged; the largest: ${top.slice(0, 3).map(x => `${x.label} (${x.metric === 'activity' && x.target !== 'network' ? 'activity' : mword(x.metric)}, ${x.direction === 'down' ? 'drop' : 'rise'} in the ${WINDOW_NOUN[sh.window] || 'window'} starting ${fmtDate(x.start) || x.windowLabel}${finite(x.z) != null ? `, z ${n3(x.z)}` : ''})`).join('; ')}.` : 'No shift was flagged.');
    }
    for (const b of befores) {
      const r = b.result;
      if (!r) { out.push('', `Measures were compared before and after ${fmtDate(b.date) || 'a chosen date'}.`); continue; }
      const reps = r.meta?.reps ?? 2000;
      if (!Object.keys(r.metrics || {}).length) {
        out.push('', `Groups were compared before and after ${fmtDate(r.date)}${b.attr ? ` (by ${attrLabel(b.attr)})` : ''}: ${fmtDate(r.before.start)} to ${lastDay(r.before.end)} (${fmtNum(r.before.ties)} ties) against ${fmtDate(r.after.start)} to ${lastDay(r.after.end)} (${fmtNum(r.after.ties)} ties), each built with the same construction rules; group membership is the attribute's single value for the whole period.`);
        continue;
      }
      out.push('', `Before and after ${fmtDate(r.date)}: two periods of equal length, ${fmtDate(r.before.start)} to ${lastDay(r.before.end)} (${fmtNum(r.before.ties)} ties) and ${fmtDate(r.after.start)} to ${lastDay(r.after.end)} (${fmtNum(r.after.ties)} ties), each built with the same construction rules. Each person's measure was compared across the two periods. The p-value comes from a randomization test: every event in the two periods was reassigned to before or after at random, ${fmtNum(reps)} times, and the mean per-person difference recomputed each time. The effect size is Cohen's d_z, the mean difference divided by the standard deviation of the differences.`);
      for (const [m, x] of Object.entries(r.metrics || {})) {
        out.push(`- ${mword(m).charAt(0).toUpperCase()}${mword(m).slice(1)}: mean ${n3(x.meanBefore)} before and ${n3(x.meanAfter)} after (${fmtNum(x.n)} people; d_z ${n3(x.dz)}; ${pWords(x.p, x.reps ?? reps, 'random relabellings', 'diff')}).`);
      }
      // Path measures rebuild both networks for every relabelling, so they use fewer.
      const fewer = Object.entries(r.metrics || {}).filter(([, x]) => x.reps && x.reps !== reps);
      if (fewer.length) out.push(`- ${list(fewer.map(([m, x]) => `${mword(m)} used ${fmtNum(x.reps)} relabellings`))}, because each relabelling rebuilds both networks.`.replace(/^- (\w)/, (_, c) => `- ${c.toUpperCase()}`));
      if (r.ties && finite(r.ties.persisted) != null) out.push(`- Ties: ${fmtNum(r.ties.formed)} formed, ${fmtNum(r.ties.dissolved)} dissolved, ${fmtNum(r.ties.persisted)} in both periods.`);
    }
    out.push('');
  }

  // 8. Content
  const c = input.content;
  const diff = runs(input.diffusion, null).filter(d => d.result?.terms?.length || d.terms?.length);
  if ((c && (c.affect || c.keywords || c.topics || c.coding)) || diff.length) {
    out.push('## Content analysis', '');
    if (c?.affect) out.push(`Message tone was scored with VADER${cite(['hutto2014'])}, a lexicon- and rule-based sentiment model; the compound score ranges from -1 to 1 and was aggregated by ${c.affect.by === 'group' && c.affect.attr ? attrLabel(c.affect.attr) : c.affect.by || 'network'}. VADER was built for English social-media text and is less reliable for other languages, domain jargon and sarcasm.`);
    if (c?.keywords) out.push(`Distinctive terms were ranked by TF-IDF weighting${cite(['sparckjones1972'])}${c.keywords.by ? ` within each ${c.keywords.by === 'group' && c.keywords.attr ? `${attrLabel(c.keywords.attr)} group` : c.keywords.by}` : ''}${c.keywords.k ? `, top ${c.keywords.k}` : ''}.`);
    if (c?.topics) {
      const lda = !c.topics.method || /lda/i.test(c.topics.method);
      out.push(`Topics were estimated with ${lda ? 'latent Dirichlet allocation' : c.topics.method}${lda ? cite(['blei2003']) : ''} with ${c.topics.k} topics (seed ${c.topics.seed ?? 'unspecified'}).`);
    }
    for (const d of diff) {
      const r = d.result;
      const reps = r?.meta?.reps ?? d.reps ?? 200;
      out.push(`Diffusion along ties: for each term, an adopter counts as exposed when a contact (a tie in either direction) used the term before them${r?.meta?.window ? ` within ${r.meta.window}` : ''}. The share of exposed adopters was compared with ${fmtNum(reps)} timelines in which adoption times were shuffled among the same adopters (seed ${r?.meta?.seed ?? d.seed ?? 1}); p is one-sided, (k + 1) / (R + 1), where k shuffled timelines reached the observed share.${r?.meta?.auto ? ' The terms were found automatically: words not used in the first tenth of the period, excluding stopwords and everyday English words, ranked by number of adopters.' : ''}${(r?.meta?.tested ?? 0) > 1 ? ` p-values were adjusted for the ${fmtNum(r.meta.tested)} terms tested with Holm's step-down method; a term is read as following ties only when its adjusted p is below 0.05 and the shuffled baseline is below 85% (otherwise the test is inconclusive).` : ''}`);
      if (r) {
        out.push('');
        for (const t of r.terms) {
          const x = t.null || {};
          const ceiling = x.ceiling ?? (finite(x.mean) != null && x.mean >= 0.85);
          out.push(`- "${t.term}": ${fmtNum(t.adopters)} adopters; ${fmtNum(t.exposed)} of ${fmtNum(t.eligible)} (${share(t.exposedShare)}) had an earlier-adopting contact, against ${share(x.mean)} in the shuffled timelines (sd ${n3(x.sd)}; z ${n3(x.z)}; ${pWords(x.pUpper, x.reps ?? reps, 'shuffled timelines', 'upper')}${finite(x.pAdjusted) != null && (r.meta?.tested ?? 0) > 1 ? `; Holm-adjusted p = ${n3(x.pAdjusted)}` : ''}).${ceiling ? ' The shuffled baseline is already near 100%, so this test has little room to show spread along ties: inconclusive.' : ''}`);
        }
      }
      out.push('');
    }
    if (c?.coding) {
      const cd = c.coding;
      const cb = cd.codebook || { codes: [] };
      out.push('');
      out.push(`Qualitative codes were applied by a large language model (${cd.settings?.provider || 'provider unspecified'}, model \`${cd.settings?.model || 'unspecified'}\`) using a codebook of ${cb.codes.length} code${cb.codes.length === 1 ? '' : 's'} (${cb.multiLabel ? 'multiple codes per message allowed' : 'one code per message'}). Only message text was sent, truncated to ${cd.settings?.maxChars ?? 1000} characters, in batches of ${cd.settings?.batchSize ?? 'unspecified'}.`);
      if (cd.sample) out.push(`The sample of ${fmtNum(cd.sample.size)} messages was drawn from ${fmtNum(cd.sample.population)} eligible messages, stratified by ${cd.sample.strataBy} with proportional allocation and at least one message per stratum where possible (seed ${cd.sample.seed}).`);
      if (cd.settings?.doubleCode) {
        const ag = cd.agreement?.overall;
        const agText = ag ? (ag.kappa != null ? ` Agreement between the two codings: Cohen's kappa ${round3(ag.kappa)}, Krippendorff's alpha ${round3(ag.alpha)}, raw agreement ${round3(ag.agreement)}.` : ag.meanKappa != null ? ` Mean per-code Cohen's kappa ${round3(ag.meanKappa)}; exact match on the full code set ${round3(ag.exactMatch)}.` : '') : '';
        out.push(`Every message was coded twice, independently${cd.settings.secondModel && cd.settings.secondModel !== cd.settings.model ? ` by \`${cd.settings.model}\` and \`${cd.settings.secondModel}\`` : ', in a different batch order'}, and agreement was measured with Cohen's kappa${cite(['cohen1960'])} and Krippendorff's alpha${cite(['krippendorff2019'])}.${agText} Agreement between two runs of a model measures consistency, not validity; codes should be validated against human coding of a subsample.`);
      } else {
        out.push('Codes were not double-coded, so no reliability estimate is available; validate against human coding of a subsample before relying on them.');
      }
      out.push('', 'Codebook:', '');
      for (const code of cb.codes) out.push(`- \`${code.id}\`${code.label ? ` (${code.label})` : ''}: ${code.definition}`);
    }
    out.push('');
  }

  // 9. Limitations implied by the data's views (attribute tables have none).
  const views = new Set(interaction.map(x => x.view));
  const lim = [];
  const personal = interaction.filter(x => x.view === VIEWS.EGO || (x.view === VIEWS.CHAT && x.family === 'personal'));
  if (personal.length > 1) lim.push(`The ${fmtNum(personal.length)} personal sources are one person's slice: each holds only conversations its owner took part in, so the owner is tied to everyone and bridges them by construction. Betweenness, closeness, constraint and effective size for the owner describe the export, not the person, and ties among the owner's contacts are mostly unobserved.`);
  else if (views.has(VIEWS.EGO)) lim.push('Ego-view sources record only the export owner\'s own interactions; ties among their contacts are unobserved, so whole-network statistics and the centrality of anyone but the ego are not interpretable from those sources alone.');
  if (views.has(VIEWS.CHAT) && personal.length <= 1) lim.push('Chat-view sources cover single conversations and do not represent the participants\' wider networks.');
  if (views.has(VIEWS.SAMPLE)) lim.push('Sample-view sources are part of a larger population; network statistics depend on the sampling design and should not be read as population values.');
  if (views.has(VIEWS.AUTHORED)) lim.push('Authored-view sources contain only what one account wrote; incoming ties are missing.');
  if (interaction.length > 1) lim.push('Sources were merged by identity matching; unmatched or mismatched identities split or join people.');
  if ((meta.profileJoins || []).length) lim.push('Attributes from joined tables are missing for people the join did not match; group comparisons leave them out or treat them as a separate "no value" group.');
  if (times.length || shifts.length || befores.length) lim.push('Attributes such as department are snapshots from the export or the joined table; group series over time assume each person stayed in the same group.');
  if (surveyOnly) lim.push('Survey answers are self-reports: they record whom people say they are tied to, which depends on how the question was worded and on recall, not observed interaction. People who did not respond named nobody; their ties come only from others\' answers.');
  else if (interaction.some(isSurvey)) lim.push('Survey sources are self-reports; communication sources record observable interaction. The two kinds of tie are combined in one network.');
  else lim.push('Communication traces record observable interaction, not relationships, attitudes or individual traits; the measures describe structural positions and patterns of observed communication only.');
  out.push('## Limitations', '', ...lim.map(x => `- ${x}`), '');

  out.push(`Analyses were performed with ${sw.name} ${sw.version}. Settings above are as recorded by the application at the time of export.`, '');

  // References
  const refs = [...used].map(k => REFERENCES[k]).sort((a, b) => a.localeCompare(b));
  if (refs.length) out.push('## References', '', ...refs.map(r => `- ${r}`), '');
  return out.join('\n');
}

function uniqBy(xs, key) {
  const m = new Map();
  for (const x of xs) m.set(key(x), { ...(m.get(key(x)) || {}), ...x });
  return [...m.values()];
}

function round3(x) { return typeof x === 'number' && Number.isFinite(x) ? x.toFixed(3) : 'n/a'; }

// ---- summary report sections (N13) -------------------------------------------------
//
// summaryResults(input) -> markdown lines: the random-network comparisons
// and group mixing actually run, verdict first (decision 5), for the
// printable summary report. input: as buildMethodsAppendix (appendixInput).
const chance = (z, more = 'more', less = 'less') => {
  if (finite(z) == null) return null;
  const a = Math.abs(z);
  if (a < 2) return 'about what chance gives';
  return `${a < 4 ? '' : 'far '}${z > 0 ? more : less} than chance`;
};
const VERDICT = {
  reciprocity: c => `Ties are returned ${c === 'about what chance gives' ? 'about as often as chance gives' : c.replace(/^(far )?more/, '$1more often').replace(/^(far )?less/, '$1less often')}.`,
  transitivity: c => `Contacts of contacts are tied to each other ${c === 'about what chance gives' ? 'about as often as chance gives' : c.replace(/^(far )?more/, '$1more often').replace(/^(far )?less/, '$1less often')} (transitivity).`,
  avgClustering: c => `People's contacts know each other ${c === 'about what chance gives' ? 'about as often as chance gives' : c.replace(/^(far )?more/, '$1more often').replace(/^(far )?less/, '$1less often')} (average clustering).`,
  modularity: c => `The network splits into communities ${c === 'about what chance gives' ? 'no more clearly than chance gives' : c.replace(/^(far )?more/, '$1more clearly').replace(/^(far )?less/, '$1less clearly')}.`,
  degreeAssortativity: c => `Well-connected people tie to each other ${c === 'about what chance gives' ? 'about as often as chance gives' : c.replace(/^(far )?more/, '$1more often').replace(/^(far )?less/, '$1less often')} (degree assortativity).`,
  attrAssortativity: (c, g) => `People tie within their own ${g} ${c === 'about what chance gives' ? 'about as much as chance gives' : c} (assortativity).`,
  eiIndex: (c, g) => `Ties cross ${g} lines ${c === 'about what chance gives' ? 'about as often as chance gives' : c.replace(/^(far )?more/, '$1more often').replace(/^(far )?less/, '$1less often')} (E-I index).`,
};
const SCALE = {
  attrAssortativity: '0 = no preference, 1 = ties only within groups',
  eiIndex: '-1 = all ties inside groups, +1 = all between',
  modularity: '0 = no more clustered than chance, above 0.3 = clear communities',
};

export function summaryResults(input = {}) {
  const L = [];
  const attrName = k => (COMMUNITY_KEYS.has(k) ? 'community' : String(input.attributeLabels?.[k] || k).replace(/\s*\([^)]*\)$/, '').toLowerCase());
  const nulls = runs(input.nullModels, input.nullModel).filter(n => n.result && Object.keys(n.result.stats).length);
  const general = nulls.filter(n => !n.attr);
  if (general.length) {
    L.push('## Compared with random networks', '');
    L.push('Each statistic is compared with random networks in which everyone keeps their number of ties but the ties are reshuffled (degree-preserving rewiring).', '');
    // One line per statistic: a test reused by several views is listed once (the latest run).
    const seen = new Set();
    for (const n of [...general].reverse()) {
      const reps = n.result.meta?.reps ?? n.reps;
      for (const [k, x] of Object.entries(n.result.stats)) {
        const c = chance(x.z);
        if (!c || !VERDICT[k] || seen.has(k)) continue;
        seen.add(k);
        L.push(`- **${VERDICT[k](c)}** Observed ${n3(x.observed)}${SCALE[k] ? ` (${SCALE[k]})` : ''}; random networks average ${n3(x.mean)} (95% between ${n3(x.lo)} and ${n3(x.hi)}). z ${n3(x.z)}; ${pWords(x.p, x.replicates ?? reps)}.${k === 'modularity' && n.result.meta?.modularity ? ` Louvain was re-run on each of the ${fmtNum(reps)} random networks.` : ''}`);
      }
    }
    L.push('');
  }
  const groupRuns = uniqBy((input.groups || []).map(g => (typeof g === 'string' ? { attr: g } : g)), g => g.attr).filter(g => g.result || nulls.some(n => n.attr === g.attr));
  if (groupRuns.length) {
    const G = [];
    for (const g of groupRuns) {
      const name = attrName(g.attr);
      const nm = nulls.find(n => n.attr === g.attr);
      const r = g.result || {};
      const before = G.length;
      G.push(`**By ${name}.**`, '');
      const a = nm?.result?.stats?.attrAssortativity, e = nm?.result?.stats?.eiIndex;
      const reps = nm?.result?.meta?.reps ?? nm?.reps;
      if (a && chance(a.z)) G.push(`- **${VERDICT.attrAssortativity(chance(a.z), name)}** Assortativity ${n3(a.observed)} (${SCALE.attrAssortativity}); random networks average ${n3(a.mean)}. z ${n3(a.z)}; ${pWords(a.p, a.replicates ?? reps)}.`);
      else if (finite(r.assortativity) != null) G.push(`- Assortativity ${n3(r.assortativity)} (${SCALE.attrAssortativity}); not compared with random networks.`);
      if (e && chance(e.z)) G.push(`- **${VERDICT.eiIndex(chance(e.z), name)}** E-I index ${n3(e.observed)} (${SCALE.eiIndex}); random networks give ${n3(e.mean)}. z ${n3(e.z)}; ${pWords(e.p, e.replicates ?? reps)}.`);
      else if (finite(r.eiIndex) != null) G.push(`- E-I index ${n3(r.eiIndex)} (${SCALE.eiIndex}); not compared with random networks.`);
      if (finite(r.withinTies) != null) G.push(`- ${fmtNum(r.withinTies)} ties within groups and ${fmtNum(r.betweenTies)} between${r.groups ? `, across ${fmtNum(r.groups)} groups` : ''}.`);
      // A grouping with nothing to report (communities read in the Groups view only) is left out.
      if (G.length === before + 2) G.length = before; else G.push('');
    }
    if (G.length) L.push('## Groups', '', ...G);
  }
  return L;
}

// Whole-network values for the summary report, with network-level wording
// (reciprocity is the share of all ties returned, not "this person's") and
// shares as percentages (N13). stats: metrics.network.
const SHARE_STATS = new Set(['largestComponentShare']);
export function wholeNetworkLines(stats = {}, label = k => k) {
  const L = [];
  for (const [k, v] of Object.entries(stats)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || !NETWORK_STAT_TEXT[k]) continue;
    const text = NETWORK_STAT_TEXT[k][0];
    const value = SHARE_STATS.has(k) ? share(v) : k === 'components' ? fmtNum(v) : n3(v);
    const name = label(k);
    // The meaning only where it says more than the name.
    const more = text.toLowerCase() !== String(name).toLowerCase();
    L.push(`- **${name}: ${value}.**${more ? ` ${text.charAt(0).toUpperCase()}${text.slice(1)}.` : ''}`);
  }
  return L;
}
