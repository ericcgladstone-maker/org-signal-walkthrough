// Teaching text for the Learn view. The meaning of every concept comes from
// the glossary (src/analysis/glossary.js), the same source as the API docs
// and every tooltip; this file adds where the number appears in the app, its
// interpretation, and a caution (the copy audit's grammar, 2026-10-04). Keys
// are glossary keys.
//
// Each entry: { where: [[label, hash]], read, mistake, diagram? }.
// `diagram` names a figure in diagrams.js.

import { exampleById } from '../../../builders/examples.js';

export const SECTIONS = [
  { id: 'basics', title: 'Basics', intro: 'Ties, direction, weight, paths, and communities.', keys: ['tie', 'directed', 'weight', 'path', 'communities', 'plantedGroup'] },
  { id: 'people', title: 'Person-level centrality', intro: 'Measures of position for individual actors. Each represents a different structural property.', keys: ['contacts', 'degree', 'inDegree', 'outDegree', 'strength', 'betweenness', 'closeness', 'clustering', 'eigenvector', 'pagerank', 'coreNumber', 'reciprocity'] },
  { id: 'ego', title: 'Personal networks', intro: 'Measures defined for an ego and the alters surrounding that ego.', keys: ['ego', 'alter', 'nameGenerator', 'nameInterpreter', 'egoSize', 'egoDensity', 'effectiveSize', 'efficiency', 'constraint', 'diversity', 'homophily'] },
  { id: 'network', title: 'Whole network', intro: 'Measures that summarize structure at the network level.', keys: ['density', 'reciprocityNetwork', 'transitivity', 'avgClustering', 'components', 'largestComponentShare', 'avgPathLength', 'diameter', 'degreeCentralization', 'strengthGini', 'degreeAssortativity', 'modularity'] },
  { id: 'groups', title: 'Groups', intro: 'Measures of within- and between-group structure.', keys: ['eiIndex', 'assortativity', 'numericAssortativity', 'groupDensity'] },
  { id: 'chance', title: 'Random-network comparisons and uncertainty', intro: 'Null-model comparisons, resampling, and uncertainty in ranks and other estimates.', keys: ['nullModel', 'nullZ', 'nullP', 'rankInterval', 'topShare', 'randomSeed'] },
  { id: 'twomode', title: 'Two-mode networks', intro: 'Networks containing two kinds of nodes, such as people and events, with ties defined across modes.', keys: ['twoMode', 'affiliation', 'projection', 'borgattiEverett', 'twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering', 'twoModeDensity', 'robinsAlexander', 'barberModularity'] },
  { id: 'surveys', title: 'Surveys', intro: 'Network construction from roster-based or respondent-reported ties.', keys: ['roster'] },
  { id: 'time', title: 'Time and content', intro: 'Temporal change, message content, and diffusion.', keys: ['tieTurnover', 'shiftZ', 'dz', 'sentiment', 'tfidf', 'topics', 'exposedShare'] },
];

const PEOPLE = ['People', 'people'];
const NETWORK = ['Network', 'network'];
const GROUPS = ['Groups', 'groups'];
const TIME = ['Time', 'time'];
const CONTENT = ['Content', 'content'];
const BUILD = ['Build', 'build'];
const GENERATE = ['Generate', 'generate'];

export const TEACH = {
  tie: {
    where: [['Network: the lines on the map, and the count in the first line', 'network'], BUILD],
    read: 'One line on the map is one tie. The tie count in Network counts pairs, or pairs per direction when the network is directed.',
    mistake: 'Messages are not ties. Fifty emails between two people form one tie with a large weight, not fifty ties.',
  },
  directed: {
    where: [['Network: "(directed: a two-way tie counts as two)" after the tie count', 'network'], ['Construction settings: Direction', 'network']],
    read: 'If the network is directed, a friendship both people named is two ties. In an undirected network it is one.',
    mistake: 'Tie counts from directed and undirected versions of the same data are not comparable: the directed count can be nearly double.',
  },
  weight: {
    where: [['Construction settings: Tie weight', 'network'], ['People: Strength', 'people']],
    read: 'Heavier ties mean more interaction or a closer rating. Strength adds a person\'s tie weights; Contacts ignores them.',
    mistake: 'Betweenness and closeness count steps rather than weights, so changing the weighting does not change them.',
  },
  path: {
    where: [['Network: Average path length and Diameter', 'network']],
    read: 'Distance 1 is a direct tie, 2 is a friend of a friend. Betweenness and closeness are both built from these shortest paths.',
    mistake: 'Distances in the map drawing do not correspond to network distances, which are read from the measures.',
  },
  communities: {
    where: [['Network: Color by > Community', 'network'], ['Groups: Communities', 'groups']],
    read: 'People in the same community have more ties to each other than to the rest. Numbers are names (community 1 is the largest), not ranks.',
    mistake: 'The partition is one of several plausible splits. Another seed or resolution can assign a borderline person differently.',
  },
  plantedGroup: {
    where: [['Generate: the recovery check compares them', 'generate'], ['Groups: choose a department or the communities', 'groups']],
    read: 'When communities match departments, ties follow the org chart. When they do not, people organize their work differently from the chart.',
    mistake: 'A mismatch between communities and planted groups is not a failure of the method. It is often the substantive result.',
  },
  contacts: {
    where: [['People: the Contacts column (sorted by it at first)', 'people'], ['Network: Size by Contacts', 'network']],
    read: 'The person with the most contacts has the most different people tied to them. In an undirected network Contacts is the degree.',
    mistake: 'On a directed network, "Total ties (in + out)" counts a two-way tie twice and therefore does not equal the number of people.',
    diagram: 'degree',
  },
  degree: {
    where: [['People: Contacts (degree); on directed networks also Total ties (in + out)', 'people']],
    read: 'Undirected: the number of ties, which equals the number of contacts. Directed: ties in plus ties out, so a two-way tie counts twice.',
    mistake: 'Hand-computed degree on a directed network corresponds to Total ties (in + out), not to Contacts.',
    diagram: 'degree',
  },
  inDegree: { where: [PEOPLE], read: 'High in-degree: many people reach out to or name this person (popularity, being sought out).', mistake: "In one person's export only the owner's incoming ties are complete, so in-degree for other people is partial." },
  outDegree: { where: [PEOPLE], read: 'High out-degree: this person reaches out to or names many others (activity, expansiveness).', mistake: 'Out-degree measures sending activity rather than importance.' },
  strength: { where: [PEOPLE], read: 'How much interaction, not with how many people. Relative to Contacts, high strength with few contacts means a few very heavy ties.', mistake: 'Strength is comparable only across networks built with the same weighting (count or log).' },
  betweenness: {
    where: [['People: Betweenness column', 'people'], ['Network: Size by Betweenness', 'network']],
    read: 'Between 0 and 1: the share of pairs of other people whose shortest route passes through this person. 1 is the center of a star; 0 is someone no shortest route needs. To get the raw count of pairs for an undirected network, multiply by (n-1)(n-2)/2.',
    mistake: 'The app reports normalized betweenness (a share of pairs), so a star center scores 1 rather than the raw count. Hand counts are compared after normalizing.',
    diagram: 'betweenness',
  },
  closeness: {
    where: [['People: Closeness (harmonic)', 'people']],
    read: 'For each other person take 1 / distance (1 for a direct tie, 1/2 two steps away), add them up and divide by n-1. 1 means tied to everyone directly.',
    mistake: 'This is harmonic closeness, not the textbook (n-1) / sum of distances. Values differ, orderings can differ slightly, and the measure remains defined when some people cannot be reached.',
    diagram: 'closeness',
  },
  clustering: {
    where: [['People: Clustering', 'people']],
    read: 'Of all pairs of this person\'s contacts, the share that are tied to each other. 1: everyone they know knows each other; 0: none do.',
    mistake: 'For people with one or two contacts, a single tie moves clustering between 0 and 1.',
    diagram: 'clustering',
  },
  eigenvector: { where: [PEOPLE], read: 'High when a person\'s contacts are themselves well connected. Ranks rather than values are comparable across networks.', mistake: 'Scores outside the largest connected component shrink toward 0 regardless of position.' },
  pagerank: { where: [PEOPLE], read: 'On directed networks: attention from people who themselves get attention. Values add up to 1, so they shrink as the network grows.', mistake: 'PageRank values sum to 1, so they are not comparable between networks of different sizes.' },
  coreNumber: { where: [PEOPLE], read: 'How deep in the dense center someone sits: core 3 means part of a group where everyone has at least 3 ties within it.', mistake: 'Many people share the same core number, so it separates people only coarsely.' },
  reciprocity: { where: [PEOPLE], read: 'Share of this person\'s ties that run both ways.', mistake: 'On an undirected network every tie is two-way by definition, so reciprocity is uninformative there.' },
  ego: { where: [['Build: Ego interview', 'build'], ['People: the profile of the export owner', 'people']], read: 'All ego measures describe the network around one person: size, density, effective size, constraint.', mistake: "In one person's data the ego lies on every route by construction, so betweenness is uninformative there." },
  alter: { where: [['Build: Ego interview, step 3 and later', 'build']], read: 'Ego\'s alters and the ties among them make the ego network.', mistake: 'Density, effective size, and constraint require the ties among alters; without them these measures cannot be computed.' },
  nameGenerator: { where: [['Build: Ego interview, "Who comes to mind"', 'build']], read: 'Two or three generators ("discuss important matters", "socialize with") give a fuller list than one.', mistake: 'The cap on the number of names bounds the size of the resulting network. A low cap (5) truncates larger personal networks.' },
  nameInterpreter: { where: [['Build: Ego interview, "About each person"', 'build']], read: 'These answers become attributes you can group and color by.', mistake: 'Each interpreter is asked about every person named, so interview length grows quickly with the number of interpreters.' },
  egoSize: { where: [PEOPLE, ['Build: Ego interview review', 'build']], read: 'How many people ego is tied to.', mistake: 'Ego is not counted in the size.' },
  egoDensity: { where: [PEOPLE], read: 'Share of possible ties among ego\'s alters that exist (ego\'s own ties left out). High: a closed circle.', mistake: 'Larger ego networks have lower density by construction, so densities of very different sizes are not directly comparable.' },
  effectiveSize: {
    where: [PEOPLE, ['Build: Ego interview review', 'build']],
    read: 'Contacts who are not redundant. If none of ego\'s alters know each other, effective size equals size; the more they know each other, the lower it is.',
    mistake: 'With tie weights, effective size and constraint are weighted and differ from the unweighted textbook values.',
    diagram: 'constraint',
  },
  efficiency: { where: [PEOPLE], read: 'Effective size divided by size: 1 means every contact brings someone new.', mistake: 'Efficiency is unstable for networks of one or two contacts.' },
  constraint: {
    where: [PEOPLE, ['Build: Ego interview review', 'build']],
    read: 'High constraint (toward 1): ego\'s contacts know each other, so the network is closed. Low constraint: ego\'s contacts do not know each other, so ego brokers between them.',
    mistake: 'High constraint indicates fewer brokerage opportunities, not greater influence.',
    diagram: 'constraint',
  },
  diversity: { where: [PEOPLE], read: 'How varied ego\'s contacts are on an attribute: 0 all alike.', mistake: 'Diversity values are not comparable across attributes with different numbers of values.' },
  homophily: { where: [PEOPLE], read: 'Share of ego\'s contacts in ego\'s own group.', mistake: "Homophily is interpreted relative to the group's share of the population: 60 percent same-group contacts is expected when ego's group is 60 percent of everyone." },
  density: { where: [NETWORK], read: 'Share of all possible ties that exist. 1: everyone tied to everyone.', mistake: 'Larger networks are sparse by construction, so densities of networks of very different sizes are not directly comparable.' },
  reciprocityNetwork: { where: [NETWORK], read: 'Share of ties that are returned. Only meaningful on directed data.', mistake: 'A survey union network switched to directed has reciprocity 1 by construction, because union ties are two-way.' },
  transitivity: { where: [NETWORK], read: 'How often a friend of a friend is also a friend. It is interpreted against random networks with the same degrees.', mistake: 'Random networks also have positive transitivity, so the value is interpreted relative to the random-network comparison.' },
  avgClustering: { where: [NETWORK], read: 'Average of every person\'s clustering.', mistake: 'Average clustering differs from transitivity because people with few contacts carry more weight in the average.' },
  components: { where: [NETWORK], read: 'Separate pieces with no path between them; a person with no ties is a piece of their own.', mistake: 'Many components can reflect isolates rather than fragmentation.' },
  largestComponentShare: { where: [NETWORK], read: 'Share of people in the biggest connected piece.', mistake: 'Path lengths are measured within components, so they are interpreted together with this share.' },
  avgPathLength: { where: [NETWORK], read: 'Typical number of steps between two people who can reach each other.', mistake: 'Average path length is not comparable across networks in which many people cannot reach each other.' },
  diameter: { where: [NETWORK], read: 'The longest of all shortest routes.', mistake: 'A single long chain determines the diameter, so it does not describe typical distance.' },
  degreeCentralization: { where: [NETWORK], read: '1 is a star, 0 is everyone with the same number of ties.', mistake: 'A single bot or hub can drive centralization.' },
  strengthGini: { where: [NETWORK], read: '0: everyone interacts equally; near 1: one person does nearly all of it.', mistake: 'Isolates count as zeros and raise the coefficient.' },
  degreeAssortativity: { where: [NETWORK], read: 'Positive: well-connected people tie to each other. Negative: hubs tie to the less connected.', mistake: 'Degree assortativity is interpreted relative to the random-network comparison.' },
  modularity: { where: [NETWORK, GROUPS], read: 'Up to about 1: the network splits cleanly into groups. It is interpreted against random networks, which also score above 0.', mistake: 'Positive modularity alone does not establish community structure; random networks also score above 0.' },
  eiIndex: { where: [['Groups: E-I index', 'groups']], read: '-1: every tie inside groups; +1: every tie across. It is interpreted against random mixing for these group sizes.', mistake: 'Larger groups have more within-group options by chance, so a negative E-I index indicates separation only relative to the random expectation.' },
  assortativity: { where: [['Groups: the reading at the top', 'groups']], read: '1: ties only within groups; 0: no preference (as random); negative: ties mostly across.', mistake: 'The value is interpreted together with the random-network comparison reported with it.' },
  numericAssortativity: { where: [GROUPS], read: 'Whether people tie to others with similar values (tenure, year).', mistake: 'It captures linear similarity only and misses non-linear patterns.' },
  groupDensity: { where: [['Groups: the mixing matrix', 'groups']], read: 'Share of possible ties inside a group, or between two groups.', mistake: 'Density is unstable for groups of two or three people.' },
  nullModel: {
    where: [['Network: Whole network vs random', 'network'], ['Groups: the comparison under the reading', 'groups']],
    read: 'If the real network sits far outside the spread of the random ones, the pattern is unlikely to be chance given everyone\'s number of ties.',
    mistake: 'A departure from the null model establishes that a pattern exceeds what the degrees alone produce, not what caused it.',
  },
  nullZ: { where: [NETWORK, GROUPS], read: 'How many standard deviations the real value is from the random average. Beyond about 2 (either sign) is unusual; 50 is far outside anything chance gave.', mistake: 'z values are not comparable between tests: a large z on a tight null distribution is not a larger effect.' },
  nullP: { where: [NETWORK, GROUPS], read: 'The share of random networks at least as extreme. With 200 random networks the smallest p possible is 1/201 (about 0.005): "none of the 200 came this far from their average".', mistake: 'p is the share of random networks at least as extreme as the observed value, not the probability that the finding is wrong.' },
  rankInterval: { where: [['People: rank stability', 'people']], read: 'The events are resampled many times and the ranking recomputed: a person who stays at rank 1 to 2 has a stable rank; rank 1 to 30 is not stable.', mistake: 'Resampling events shows how much the ranking depends on which events were recorded. It does not test whether a tie exists.' },
  topShare: { where: [['People: rank stability', 'people']], read: 'In what share of the resamples this person was in the top k. 100% is settled.', mistake: 'A top-k share of 60 percent means the person fell outside the top k in 40 percent of resamples.' },
  randomSeed: { where: [GENERATE, ['Basis lines: "seed 1"', 'network']], read: 'The same seed reproduces the same result, which allows others to reproduce the numbers.', mistake: 'The random seed is distinct from the first user of a word in diffusion analysis (Content).' },
  roster: { where: [['Build: Roster survey', 'build']], read: 'Union: a tie if either person named the other. Reciprocated: only if both did. Reciprocated networks are smaller and denser in strong ties.', mistake: 'Union and reciprocated networks differ, so each reported number states which rule produced it.' },
  tieTurnover: { where: [TIME], read: 'How many ties appear and disappear between windows.', mistake: 'Short windows miss ties by chance, so turnover in daily windows overstates change.' },
  shiftZ: { where: [['Time: Detected shifts', 'time']], read: 'A week far outside the previous 8 weeks is flagged.', mistake: 'Holidays and gaps in the data are also flagged, so a flag does not by itself identify an event.' },
  dz: { where: [['Time: Before and after', 'time']], read: 'Size of the average per-person change around the date: about 0.2 small, 0.5 moderate, 0.8 large.', mistake: 'The effect size describes change around the date, not change caused by it; anything else that changed at the same time contributes.' },
  twoMode: {
    where: [['Construction settings: Two-mode', 'network'], ['Network: shapes and colors by mode', 'network'], ['Build: File, Two-mode drawing', 'build']],
    read: 'Circles are one kind of node (people), squares the other (events, clubs). A line means "belongs to" or "attended"; two people are never tied directly. Measures are interpreted within a mode: people with people, events with events.',
    mistake: "One-mode measures do not apply: ordinary clustering is always 0 (no triangles can exist), and density and Burt's constraint count ties that cannot exist. The app marks them not applicable.",
    diagram: 'twoMode',
  },
  affiliation: {
    where: [['Build: File, Two-mode drawing', 'build'], ['Data: an incidence list or matrix', 'data']],
    read: 'One affiliation per person and event. It can carry a weight (hours, a role) and a date; the two-mode measures count it as present or absent.',
    mistake: 'Shared membership indicates an opportunity for contact, not contact itself.',
  },
  projection: {
    where: [['Construction settings: Two-mode, project onto either mode', 'network']],
    read: 'Project onto people and two people are tied when they share an event; the tie weight is how many they share (or Newman\'s weighting, where a big event counts less). Project onto events and two events are tied by the people they share.',
    mistake: 'Every event becomes a clique of its members in the projection, which raises clustering and constraint by construction. The two-mode view and the event sizes are needed to interpret them.',
    diagram: 'projection',
  },
  borgattiEverett: {
    where: [['People: the two-mode columns, per mode', 'people']],
    read: 'Each two-mode measure is scaled by what a node of its own mode could reach: a person who attended every event has two-mode degree 1, and so does an event everyone attended.',
    mistake: "The scales of people's and events' values align, but their meanings differ, so values are compared within a mode.",
  },
  twoModeDegree: { where: [PEOPLE], read: 'Share of the other mode a node is tied to: 0.5 for a person at half the events, or an event half the people attended.', mistake: 'Plain degree is not comparable across modes, because a mode with more nodes allows more ties.' },
  twoModeBetweenness: { where: [PEOPLE], read: 'Who joins otherwise separate parts: a person in two clubs that share nobody else, an event that brings two crowds together. 1 is the most a node of its mode could have.', mistake: 'Raw betweenness ranks events and people together without accounting for the number of each.' },
  twoModeCloseness: { where: [PEOPLE], read: 'How few steps a node needs to reach everyone, against the fewest possible for its mode (1 step to every node of the other mode, 2 to its own).', mistake: 'This is the classic form, not harmonic closeness; in a disconnected network the share reachable dominates.' },
  twoModeClustering: { where: [PEOPLE], read: 'How much a node shares its ties with the nodes two steps away: people who keep going to the same events as each other score high.', mistake: 'It differs from ordinary clustering, which is always 0 in a two-mode network.' },
  twoModeDensity: { where: [NETWORK], read: 'Share of possible person-event ties present: ties / (people x events).', mistake: 'It is not comparable with one-mode density, which divides by pairs that cannot be tied.' },
  robinsAlexander: { where: [NETWORK], read: 'Of the people who share one event, how often they also share another: closure in a two-mode network.', mistake: 'A few very large events create many four-cycles, so event sizes affect the value.' },
  barberModularity: { where: [['Groups: Communities', 'groups'], NETWORK], read: 'How well the communities found on the projection split people and events, compared with random two-mode mixing.', mistake: 'The communities were found on the projection rather than by maximizing this score, so it does not describe the best possible split.' },
  sentiment: { where: [['Content: Tone', 'content']], read: 'Average tone from -1 to +1; informative for groups or weeks rather than single messages.', mistake: 'Sarcasm, jargon, and non-English text reduce validity.' },
  tfidf: { where: [CONTENT], read: 'Words this person or group uses more than the others.', mistake: 'Lists for units with very little text are unreliable.' },
  topics: { where: [CONTENT], read: 'Clusters of words that tend to appear together; any name for a topic is an interpretation of its words.', mistake: 'Topics change with the number of topics and the random seed.' },
  exposedShare: { where: [['Content: Diffusion', 'content']], read: 'Share of adopters who had a tied, earlier adopter. It is interpreted against the shuffled-time baseline.', mistake: 'Exposure is not influence: tied people also share meetings and news.' },
};

// "Find it in the app": the questions of the Networks 101 assignments, each
// with where to go. `to` is a hash; `learn` names concepts to read first.
export const TASKS = [
  { a: 'A1', q: 'Who has the most ties?', how: 'People, sorted by Contacts (the default order). On a directed network, Contacts counts people; Total ties (in + out) counts ties.', to: 'people', learn: ['contacts'] },
  { a: 'A1', q: 'Who connects two groups?', how: 'People, sort by Betweenness; then check on the Network map that this person sits between the groups.', to: 'people', learn: ['betweenness'] },
  { a: 'A1', q: 'How many ties does the network have?', how: 'Network, the first line under the title ("8 people and 11 ties").', to: 'network', learn: ['tie', 'directed'] },
  { a: 'A2', q: 'Check degree, betweenness and closeness computed by hand', how: 'People. Betweenness is normalized (a share of pairs) and closeness is harmonic; see their entries here for how to convert.', to: 'people', learn: ['betweenness', 'closeness'] },
  { a: 'A3', q: 'Run an ego interview and read size, density, effective size and constraint', how: 'Build > Ego interview; the review step and the People profile show the ego measures.', to: 'build', learn: ['ego', 'nameGenerator', 'constraint', 'effectiveSize'] },
  { a: 'A4', q: 'Find the groups (communities) in a class survey', how: 'Network, Color by > Community; Groups, choose Communities.', to: 'network', learn: ['communities', 'plantedGroup'] },
  { a: 'A4', q: 'Does friendship stay within majors?', how: 'Groups, choose the major; read the sentence at the top and its comparison with random networks.', to: 'groups', learn: ['assortativity', 'nullModel'] },
  { a: 'A4', q: 'Union vs reciprocated networks', how: 'Build > Roster, when combining the responses (or drop the response files on Data and choose the combine rule).', to: 'build', learn: ['roster'] },
  { a: 'A5', q: 'Top brokers and how stable that ranking is', how: 'People, sort by Betweenness, then Rank stability.', to: 'people', learn: ['rankInterval', 'topShare'] },
  { a: 'A5', q: 'Did the measures find the planted brokers?', how: 'Generate, the recovery check below the form (also linked from Network).', to: 'generate', learn: ['plantedGroup'] },
  { a: 'A6', q: 'Are departments siloed?', how: 'Groups: the E-I index against its random expectation, and the mixing matrix.', to: 'groups', learn: ['eiIndex', 'nullModel'] },
  { a: 'A6', q: 'When did the silo form?', how: 'Time, Detected shifts.', to: 'time', learn: ['shiftZ'] },
  { a: 'A7', q: 'What can my own export show and not show?', how: 'Data, the import report: "What these records support" and "Limits of these records" for each source.', to: 'data', learn: ['ego'] },
  { a: 'A8', q: 'Build the network three ways and compare the top 5', how: 'Network or People > Construction settings; after Apply, the notice lists what changed.', to: 'network', learn: ['tie', 'weight'] },
  { a: 'A9', q: 'Did a word spread along ties?', how: 'Content > Diffusion: the exposed share against the shuffled-time baseline.', to: 'content', learn: ['exposedShare', 'nullModel'] },
  { a: 'A10', q: 'When did the reorg happen and what changed?', how: 'Time: Detected shifts, then Before and after at that date.', to: 'time', learn: ['shiftZ', 'dz'] },
  { a: 'A11', q: 'Perceived networks: who perceives best?', how: 'Build > Perceived networks, then Compare.', to: 'build', learn: [] },
  { a: 'A12', q: 'Export the methods appendix and a GEXF file', how: 'Methods & Export.', to: 'methods', learn: ['nullModel', 'randomSeed'] },
];

// Worked examples, opened in Build. The id is passed as #build?example=<id>;
// Build (src/ui/build) loads the example of that id. Keep these ids in step
// with Build's example library (docs/api/ui-core.md, "Learn links").
export const EXAMPLES = [
  { id: 'two-cliques-broker', what: 'The broker is the only route between the teams: the highest betweenness (0.571), with 4 contacts, no more than each of the four team members tied to him.', learn: ['betweenness', 'contacts'] },
  { id: 'path-and-star', what: 'In the path C and D have the highest betweenness (0.600) and the ends A and F have 0. Then open the star (File, Start from an example): its center has betweenness 1 and each leaf 0. Compare with your hand values.', learn: ['betweenness', 'closeness', 'degree'] },
  { id: 'ring-small-world', what: 'Then open the small world (File, Start from an example): two shortcuts cut the average path length from 2.895 to 2.347 steps, while clustering (transitivity) stays high, 0.441 against 0.500.', learn: ['avgPathLength', 'clustering'] },
  { id: 'class-friendships', what: 'Friendships mostly within majors: 15 of 18 ties, assortativity 0.750, far above what random networks give; and one student with no friendships yet, an isolate.', learn: ['assortativity', 'eiIndex', 'nullModel', 'isolate'] },
  { id: 'clubs-two-mode', what: 'Six students and four clubs. Compare plain and two-mode degree, find the two bridging students by two-mode betweenness, then project onto students: Ana and Ben share two clubs.', learn: ['twoMode', 'projection', 'borgattiEverett', 'twoModeBetweenness'] },
  { id: 'ego-10', what: 'Three settings (family, college, work) that barely know each other: effective size 7.6 of 10 contacts. Constraint is 0.292, high in the 0.100 to 0.361 range possible with 10 contacts, because each setting is close-knit inside.', learn: ['constraint', 'effectiveSize', 'ego'] },
// The title is the one the example opens under in Build, so Learn and the
// header name match ("Example: <title>").
].map(x => ({ ...x, title: exampleById(x.id)?.title || x.id }));
