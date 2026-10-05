// Provider registry. Every adapter has the same shape:
//   { id, label, defaultModel, defaultMaxTokens, keyPlaceholder, keyUrl, browser,
//     listModels({ key, fetch, signal }) -> [{ id, label, contextWindow, maxOutput, created }],
//     chat({ key, model, system, messages, tools, onText, signal, fetch, maxTokens, json, effort })
//       -> { text, toolCalls, stopReason, usage, model, message } }
// See providers/common.js for the normalized message and tool formats.

import anthropic from './anthropic.js';
import openai from './openai.js';
import gemini from './gemini.js';

export const providers = { anthropic, openai, gemini };
export const providerList = [anthropic, openai, gemini];

export function getProvider(id) {
  const p = providers[id];
  if (!p) throw new Error(`Unknown LLM provider: ${id}`);
  return p;
}

export { anthropic, openai, gemini };
