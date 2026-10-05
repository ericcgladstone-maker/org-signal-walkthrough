// Metric glossary used by every view. The analysis engine owns the canonical
// text (docs/api/analysis.md); when it exposes a glossary object we use that
// and fall back to these entries only for keys it does not cover, so the UI
// never shows a number without a meaning beside it.

import { humanize } from '../lib/format.js';

const FALLBACK = {
  // node metrics
  degree: { label: 'Degree', meaning: 'Number of distinct people this person is tied to.', reliability: 'Robust to small data errors; counts a once-only contact the same as a daily one.' },
  inDegree: { label: 'In-degree', meaning: 'Number of people who direct ties to this person.', reliability: 'Only meaningful when direction is recorded; ego exports undercount everyone but the owner.' },
  outDegree: { label: 'Out-degree', meaning: 'Number of people this person directs ties to.', reliability: 'Only meaningful when direction is recorded.' },
  strength: { label: 'Strength', meaning: 'Total weight of this person’s ties (for example, messages exchanged).', reliability: 'Driven by volume; a few very active pairs can dominate.' },
  inStrength: { label: 'In-strength', meaning: 'Total weight of ties directed to this person.', reliability: 'Driven by volume and by how the source records recipients.' },
  outStrength: { label: 'Out-strength', meaning: 'Total weight of ties this person directs to others.', reliability: 'Driven by volume.' },
  betweenness: { label: 'Betweenness', meaning: 'How often this person sits on the shortest path between two others; a measure of brokerage.', reliability: 'Sensitive to missing ties and to the boundary of the data. Check resampling intervals before reading ranks.' },
  closeness: { label: 'Closeness (harmonic)', meaning: 'How near this person is, on average, to everyone else.', reliability: 'Compresses into a narrow range in dense networks; differences are often small.' },
  eigenvector: { label: 'Eigenvector', meaning: 'Tied to people who are themselves well tied.', reliability: 'Unstable in disconnected or near-regular networks.' },
  pagerank: { label: 'PageRank', meaning: 'Share of attention flowing to this person when ties are followed at random.', reliability: 'Depends on direction and on the damping assumption.' },
  clustering: { label: 'Clustering', meaning: 'Share of this person’s contacts who are also tied to each other.', reliability: 'Undefined for people with fewer than two contacts; noisy for small degree.' },
  coreNumber: { label: 'Core number', meaning: 'Depth in the network: the largest k such that this person sits in a group where everyone has at least k ties.', reliability: 'Coarse; many people share a value.' },
  reciprocity: { label: 'Reciprocity', meaning: 'Share of this person’s ties that run both ways.', reliability: 'Only meaningful when direction is recorded and both sides are observed.' },
  constraint: { label: 'Constraint', meaning: 'How much this person’s contacts are tied to each other (low means brokerage opportunities).', reliability: 'Needs complete ties among contacts; ego exports usually lack them.' },
  effectiveSize: { label: 'Effective size', meaning: 'Number of non-redundant contacts.', reliability: 'Needs ties among contacts.' },
  egoDensity: { label: 'Ego density', meaning: 'Share of possible ties among this person’s contacts that exist.', reliability: 'Noisy for small ego networks.' },
  // two-mode networks (src/analysis/twomode.js)
  twoModeDegree: { label: 'Two-mode degree', meaning: 'Share of the other kind of node this one is tied to (Borgatti and Everett).', reliability: 'Compare within a kind of node.' },
  twoModeBetweenness: { label: 'Two-mode betweenness', meaning: 'How often this node is on the shortest routes between others, against the most possible for its kind.', reliability: 'Sensitive to missing affiliations.' },
  twoModeCloseness: { label: 'Two-mode closeness', meaning: 'Fewest possible steps to everyone for its kind, divided by its actual steps.', reliability: 'Classic closeness; dominated by reach in disconnected networks.' },
  twoModeClustering: { label: 'Two-mode clustering', meaning: 'How much this node shares its ties with the nodes two steps away (Latapy).', reliability: 'Unweighted.' },
  twoModeDensity: { label: 'Two-mode density', meaning: 'Share of all possible ties between the two kinds that exist.', reliability: 'Falls as either kind grows.' },
  robinsAlexander: { label: 'Two-mode clustering (Robins-Alexander)', meaning: 'How often two nodes that share one tie partner also share another.', reliability: 'Large events create many four-cycles.' },
  barberModularity: { label: 'Bipartite modularity (Barber)', meaning: 'How cleanly both kinds of node split into groups that keep to themselves.', reliability: 'Scores the communities found on the projection.' },
  community: { label: 'Community', meaning: 'Group found by modularity optimisation (Louvain).', reliability: 'One of many near-equal partitions; small communities can change with the seed.' },
  // network metrics
  density: { label: 'Density', meaning: 'Share of possible ties that exist.', reliability: 'Falls with size by construction; compare only networks of similar size.' },
  transitivity: { label: 'Transitivity', meaning: 'Share of connected triples that close into triangles.', reliability: 'Read against a null model; random networks of the same density also have some.' },
  avgClustering: { label: 'Average clustering', meaning: 'Mean of every person’s clustering.', reliability: 'Dominated by low-degree people.' },
  components: { label: 'Components', meaning: 'Number of disconnected pieces.', reliability: 'Isolates and the time window change this a lot.' },
  largestComponentShare: { label: 'Largest component share', meaning: 'Share of people in the biggest connected piece.', reliability: 'Robust.' },
  avgPathLength: { label: 'Average path length', meaning: 'Typical number of steps between two people in the largest component.', reliability: 'Approximate on large networks (sampled).' },
  degreeCentralization: { label: 'Degree centralization', meaning: 'How much ties concentrate on a few people (0 even, 1 a star).', reliability: 'Sensitive to one hub, including bots.' },
  strengthGini: { label: 'Strength inequality (Gini)', meaning: 'How unequal tie volume is across people.', reliability: 'Driven by the most active accounts.' },
  modularity: { label: 'Modularity', meaning: 'How strongly the network splits into the detected communities.', reliability: 'Compare with the null model; random networks also score above zero.' },
  assortativity: { label: 'Assortativity', meaning: 'Tendency for ties to connect people in the same group (1 all within, 0 as if random, negative across).', reliability: 'Read with its null-model z; group sizes shape the expected value.' },
  eiIndex: { label: 'E-I index', meaning: 'External minus internal ties over all ties (-1 all within groups, +1 all across).', reliability: 'Depends on group sizes; compare with the expected value.' },
};

let engineGlossary = null;

export function setEngineGlossary(g) {
  engineGlossary = g && typeof g === 'object' ? g : null;
}

export function gloss(key) {
  const e = engineGlossary?.[key];
  const f = FALLBACK[key];
  if (!e && !f) return { key, label: humanize(key), meaning: 'No description available.', reliability: '' };
  return { key, label: e?.label || f?.label || humanize(key), meaning: e?.meaning || e?.description || f?.meaning || '', reliability: e?.reliability || e?.note || f?.reliability || '' };
}

// Two-mode measures (src/analysis/twomode.js): the engine computes them only on
// a two-mode network, so asking for them elsewhere returns nothing.
export const TWO_MODE_METRICS = ['twoModeDegree', 'twoModeBetweenness', 'twoModeCloseness', 'twoModeClustering'];
export const NODE_METRICS = ['degree', 'inDegree', 'outDegree', 'strength', 'inStrength', 'outStrength', 'betweenness', 'closeness', 'eigenvector', 'pagerank', 'clustering', 'coreNumber', 'reciprocity', 'constraint', 'effectiveSize', 'egoDensity'];
