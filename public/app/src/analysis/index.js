// Org Signal analysis engine: pure functions. See docs/api/analysis.md.
//
// Everything here runs in Node 24 or a Web Worker without a DOM. The engine
// (engine.js) runs these in a worker and keeps the dataset and the current
// network there.

export { defaultSettings, evidenceCounts, normalizeSettings, buildNetwork, edgeEvidence, networkFromEdges, forEachEvidence, edgeTieAttributes, tieFieldPlan, RULES, RULE_INFO, LAYERS, TWO_MODE_VIEWS, PROJECTIONS, twoModeDefaults } from './construct.js';
export { computeNodeMetrics, NODE_METRICS } from './metrics.js';
export { computeNetworkMetrics } from './network.js';
export { detectCommunities, modularity } from './communities.js';
export { groupMetrics, egoMetrics } from './groups.js';
export { nullModel, resampleRanks, ranks, NULL_STATS } from './uncertainty.js';
export { applicability, APPLICABILITY_KEYS } from './applicability.js';
export { timeSeries, detectShifts, compareBeforeAfter, makeWindows } from './time.js';
export { affect, keywords, topics, diffusion, tokenize } from './content/index.js';
export { graphForRender } from './render.js';
export { TWO_MODE_METRICS, twoModeNodeMetrics, twoModeNetworkMetrics, barberModularity, projectNetwork, twoModeBetweennessMax, isTwoModeView } from './twomode.js';
export { GLOSSARY, glossaryFor } from './glossary.js';
export { createRng } from './rng.js';
