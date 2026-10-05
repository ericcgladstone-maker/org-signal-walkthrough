// Public entry point of the optional LLM layer. Nothing else in the app needs
// this module to work; it is loaded only when the user turns on an LLM.

export { providers, providerList, getProvider } from './providers/index.js';
export { createAnalyst, ANALYST_SYSTEM_PROMPT } from './analyst.js';
export { writeReport, REPORT_SECTIONS, reportPlan } from './reports.js';
export { buildMethodsAppendix, REFERENCES } from './methods.js';
export { TOOL_DEFINITIONS, availableTools, createToolRunner, engineFromAnalysis } from './tools.js';
export { checkCitations, extractNumbers } from './citations.js';
export { createKeyStore, redact, maskKey } from './keys.js';
export { LLMError, ERROR_CODES } from './errors.js';
export { estimateCost, estimateAsk, estimateReport, estimateTokens, priceFor, formatUSD, PRICES, PRICES_AS_OF, PRICE_SOURCES } from './estimate.js';
export { validateCodebook, sampleMessages, estimateCoding, codeMessages, agreement, cohenKappa, krippendorffAlpha } from './coding.js';
