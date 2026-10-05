// Rough token and cost estimates, shown before any LLM action runs.
//
// These are estimates. Token counts use a characters/4 rule of thumb (real
// tokenizers differ by model and language), reasoning models spend hidden
// thinking tokens that are billed as output, and providers change prices.
// The table below is dated and sourced; the UI must show `asOf` and the
// "estimate" wording next to any figure.

export const PRICES_AS_OF = '2026-10-02';

export const PRICE_SOURCES = {
  anthropic: 'https://platform.claude.com/docs/en/about-claude/pricing',
  openai: 'https://developers.openai.com/api/docs/pricing',
  gemini: 'https://ai.google.dev/gemini-api/docs/pricing',
};

// USD per million tokens, standard (non-batch) rates. Keys match a model id
// exactly or as a prefix (longest match wins). `until` / `later` express a
// published scheduled price change.
export const PRICES = {
  anthropic: {
    'claude-fable-5-1': { input: 10, output: 50 },
    'claude-fable-5': { input: 10, output: 50 },
    'claude-opus-5-5': { input: 4, output: 20 },
    'claude-opus-5': { input: 5, output: 25 },
    'claude-opus-4-8': { input: 5, output: 25 },
    'claude-opus-4-7': { input: 5, output: 25 },
    'claude-opus-4-6': { input: 5, output: 25 },
    'claude-sonnet-5-5': { input: 2, output: 10 },
    'claude-sonnet-5': { input: 2, output: 10 },
    'claude-sonnet-4-6': { input: 3, output: 15 },
    'claude-haiku-4-5': { input: 1, output: 5 },
  },
  openai: {
    // Prompts up to 272K input tokens; longer prompts cost more.
    'gpt-6-astra': { input: 10, output: 50 },
    'gpt-6.1-sol': { input: 2, output: 10 },
    'gpt-6-luna': { input: 0.1, output: 0.5 },
    'gpt-5.5': { input: 5, output: 30 },
    'gpt-5-mini': { input: 0.25, output: 2 },
  },
  gemini: {
    'gemini-3.8-flash': { input: 0.75, output: 3.75, until: '2026-12-31', later: { input: 1.5, output: 7.5 } },
    'gemini-3.7-flash': { input: 0.75, output: 3.75, until: '2026-12-31', later: { input: 1.5, output: 7.5 } },
    'gemini-3.5-flash-lite': { input: 0.3, output: 2.5 },
    'gemini-3.5-flash': { input: 1.5, output: 9 },
    'gemini-3.1-flash-lite': { input: 0.25, output: 1.5 },
    'gemini-3.1-pro': { input: 2, output: 12 }, // prompts up to 200K tokens
    'gemini-2.5-pro': { input: 1.25, output: 10 },
    'gemini-2.5-flash': { input: 0.3, output: 2.5 },
  },
};

export function estimateTokens(text) {
  if (!text) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  return Math.ceil(s.length / 4);
}

// priceFor('gemini', 'gemini-3.8-flash', '2027-01-15') -> { input, output, source, asOf, model }
export function priceFor(provider, model, date = new Date().toISOString().slice(0, 10)) {
  const table = PRICES[provider];
  if (!table || !model) return null;
  const id = String(model).replace(/^models\//, '');
  let best = null;
  for (const k of Object.keys(table)) if (id === k || id.startsWith(k + '-') || id.startsWith(k)) { if (!best || k.length > best.length) best = k; }
  if (!best) return null;
  let p = table[best];
  if (p.until && date > p.until && p.later) p = p.later;
  return { input: p.input, output: p.output, source: PRICE_SOURCES[provider], asOf: PRICES_AS_OF, model: best };
}

function usd(tokens, perMillion) { return (tokens / 1e6) * perMillion; }

// estimateCost({ provider, model, inputTokens, outputTokens, outputHigh })
//   -> { inputTokens, outputTokens, usd, usdHigh, price, note }
// usdHigh allows for hidden reasoning tokens and longer answers.
export function estimateCost({ provider, model, inputTokens, outputTokens, outputHigh, date }) {
  const price = priceFor(provider, model, date);
  const oh = outputHigh ?? outputTokens * 3;
  const out = { inputTokens, outputTokens, outputTokensHigh: oh, usd: null, usdHigh: null, price, note: '' };
  if (!price) {
    out.note = `No price on file for ${model}. Check ${PRICE_SOURCES[provider] || 'the provider pricing page'}.`;
    return out;
  }
  out.usd = usd(inputTokens, price.input) + usd(outputTokens, price.output);
  out.usdHigh = usd(inputTokens, price.input) + usd(oh, price.output);
  out.note = `Estimate only: tokens approximated as characters/4, prices as of ${price.asOf} from ${price.source}.`;
  return out;
}

export function formatUSD(x) {
  if (x == null) return 'unknown';
  if (x < 0.01) return '< $0.01';
  return `$${x.toFixed(x < 1 ? 3 : 2)}`;
}

// Analyst question: the system prompt and tool definitions are resent on every
// tool step, and the conversation grows by each tool result.
export function estimateAsk({ provider, model, systemPrompt = '', tools = [], historyText = '', steps = 4, resultTokens = 600, answerTokens = 700, date }) {
  const fixed = estimateTokens(systemPrompt) + estimateTokens(tools) + estimateTokens(historyText);
  let input = 0;
  for (let s = 0; s < steps; s++) input += fixed + s * (resultTokens + 80);
  return estimateCost({ provider, model, inputTokens: input, outputTokens: answerTokens + steps * 80, date });
}

// Report: one call over a fixed bundle of tool results.
export function estimateReport({ provider, model, systemPrompt = '', resultsText = '', sections = 6, date }) {
  const input = estimateTokens(systemPrompt) + estimateTokens(resultsText) + 200;
  return estimateCost({ provider, model, inputTokens: input, outputTokens: 180 * sections, date });
}
