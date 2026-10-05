// Google Gemini adapter on generateContent (raw fetch).
//
// Verified against ai.google.dev docs, 2026-10-02:
//   - POST https://generativelanguage.googleapis.com/v1beta/models/{model}:streamGenerateContent?alt=sse
//     with header x-goog-api-key. Google now recommends the Interactions API
//     for new work but states generateContent "remains fully supported"; it is
//     used here because it is stateless (fits a local-first app that keeps its
//     own history) and its shapes are stable.
//   - Body: contents [{ role: 'user'|'model', parts }], systemInstruction
//     { parts: [{ text }] }, tools [{ functionDeclarations: [{ name,
//     description, parametersJsonSchema }] }], generationConfig
//     { maxOutputTokens, responseMimeType, responseJsonSchema } (JSON output; checked live 2026-10-04).
//   - Each SSE data line is a GenerateContentResponse: { candidates: [{
//     content: { role, parts }, finishReason }], promptFeedback,
//     usageMetadata: { promptTokenCount, candidatesTokenCount,
//     thoughtsTokenCount } }. Function calls arrive whole, with an id on
//     Gemini 3; the functionResponse must echo that id.
//   - Thought signatures: parts must be sent back exactly as received
//     (thoughtSignature included); the first functionCall of each step in the
//     current turn must carry its signature or the API returns 400. For
//     function calls that Gemini did not generate (history from another
//     provider) the docs allow the dummy "skip_thought_signature_validator".
//   - Errors: { error: { code, message, status, details } }. An invalid key is
//     HTTP 400 with reason API_KEY_INVALID; 429 RESOURCE_EXHAUSTED; 503 UNAVAILABLE.
//   - Browser: the endpoint answers CORS for x-goog-api-key requests; Google
//     advises a backend proxy for production apps with shared keys.

import { request, consume, toolCall, runs, stringifyResult, localId } from './common.js';
import { readSSE } from '../sse.js';
import { makeError } from '../errors.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
const LOCAL = 'gemini_local_';
const DUMMY_SIGNATURE = 'skip_thought_signature_validator';

function classify(status, json) {
  const e = json?.error || {};
  const detail = e.message || '';
  const reasons = (e.details || []).map(d => d.reason).filter(Boolean);
  if (reasons.includes('API_KEY_INVALID') || e.status === 'UNAUTHENTICATED') return { code: 'auth', detail };
  if (e.status === 'PERMISSION_DENIED') return { code: 'permission', detail };
  if (e.status === 'RESOURCE_EXHAUSTED') return { code: 'rate_limit', detail };
  if (e.status === 'UNAVAILABLE') return { code: 'overloaded', detail };
  if (e.status === 'NOT_FOUND') return { code: 'not_found', detail };
  if (e.status === 'FAILED_PRECONDITION' && /billing|free tier/i.test(detail)) return { code: 'billing', detail };
  return { code: undefined, detail };
}

function headers(key) {
  return { 'content-type': 'application/json', 'x-goog-api-key': key };
}

function toContents(messages) {
  const contents = [];
  for (const run of runs(messages)) {
    if (run.role === 'user') contents.push({ role: 'user', parts: [{ text: run.items[0].content }] });
    else if (run.role === 'assistant') {
      const m = run.items[0];
      if (m.raw?.provider === 'gemini' && Array.isArray(m.raw.parts)) contents.push({ role: 'model', parts: m.raw.parts });
      else {
        const parts = [];
        if (m.content) parts.push({ text: m.content });
        (m.toolCalls || []).forEach((c, i) => parts.push({
          functionCall: { name: c.name, args: c.arguments || {} },
          // Injected calls carry no signature; the documented dummy value skips validation.
          ...(i === 0 ? { thoughtSignature: DUMMY_SIGNATURE } : {}),
        }));
        contents.push({ role: 'model', parts: parts.length ? parts : [{ text: '(no text)' }] });
      }
    } else if (run.role === 'tool') {
      // All responses for one step go in one user turn, after all the calls.
      contents.push({ role: 'user', parts: run.items.map(t => ({
        functionResponse: {
          ...(String(t.toolCallId).startsWith(LOCAL) ? {} : { id: String(t.toolCallId) }),
          name: t.name,
          response: wrapResponse(t),
        },
      })) });
    }
  }
  return contents;
}

// functionResponse.response must be an object.
function wrapResponse(t) {
  const s = stringifyResult(t.content);
  let v;
  try { v = JSON.parse(s); } catch { v = null; }
  const obj = v && typeof v === 'object' && !Array.isArray(v) ? v : { result: s };
  return t.isError ? { error: obj.error ?? obj } : obj;
}

function toolsToWire(tools) {
  return [{ functionDeclarations: tools.map(t => ({ name: t.name, description: t.description, parametersJsonSchema: t.parameters })) }];
}

const REFUSAL_REASONS = new Set(['SAFETY', 'RECITATION', 'BLOCKLIST', 'PROHIBITED_CONTENT', 'SPII', 'IMAGE_SAFETY']);

export const gemini = {
  id: 'gemini',
  label: 'Google Gemini',
  defaultModel: 'gemini-3.8-flash',
  defaultMaxTokens: 32000, // includes thinking tokens; model limit 65,536
  keyPlaceholder: 'AIza...',
  keyUrl: 'https://aistudio.google.com/apikey',
  browser: 'Direct browser calls are accepted (CORS). Google advises a server proxy for shared production keys; here the key stays in this browser.',

  async listModels({ key, fetch, signal } = {}) {
    const out = [];
    let token = '';
    for (let page = 0; page < 20; page++) {
      const url = `${API}/models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`;
      const res = await request('gemini', { url, method: 'GET', headers: headers(key), fetch, signal, key, classify });
      const json = await consume('gemini', signal, () => res.json());
      for (const m of json.models || []) {
        if (!(m.supportedGenerationMethods || []).includes('generateContent')) continue;
        out.push({ id: String(m.name).replace(/^models\//, ''), label: m.displayName || m.name, contextWindow: m.inputTokenLimit || null, maxOutput: m.outputTokenLimit || null, created: null });
      }
      if (!json.nextPageToken) break;
      token = json.nextPageToken;
    }
    return out;
  },

  async chat({ key, model, system, messages, tools, onText, signal, fetch, maxTokens, json, effort }) {
    model = model || this.defaultModel;
    const body = { contents: toContents(messages), generationConfig: { maxOutputTokens: maxTokens || this.defaultMaxTokens } };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (tools?.length) body.tools = toolsToWire(tools);
    // JSON output: responseMimeType + responseJsonSchema (a JSON Schema). The
    // newer responseFormat.text.mimeType takes an enum, not a MIME string, and
    // returned 400 for 'application/json' in a live test on 2026-10-04.
    if (json?.schema) { body.generationConfig.responseMimeType = 'application/json'; body.generationConfig.responseJsonSchema = json.schema; }
    // Gemini 3 thinking levels are low/medium/high; map the shared effort names onto them.
    if (effort) body.generationConfig.thinkingConfig = { thinkingLevel: ({ low: 'low', medium: 'medium', high: 'high', xhigh: 'high', max: 'high' })[effort] || 'medium' };

    const url = `${API}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
    const res = await request('gemini', { url, headers: headers(key), body, fetch, signal, key, classify });

    const parts = [];
    let text = '';
    let finish = null;
    let blocked = null;
    let servedBy = model;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    await consume('gemini', signal, async () => {
      for await (const ev of readSSE(res.body, { signal })) {
        let d;
        try { d = JSON.parse(ev.data); } catch { continue; }
        if (d.error) {
          const c = classify(d.error.code, d);
          throw makeError(c.code || 'server', 'gemini', { status: d.error.code || 0, detail: c.detail });
        }
        if (d.modelVersion) servedBy = d.modelVersion;
        if (d.promptFeedback?.blockReason) blocked = d.promptFeedback.blockReason;
        const cand = d.candidates?.[0];
        for (const p of cand?.content?.parts || []) {
          parts.push(p);
          // Thought summaries (thought: true) are not part of the answer.
          if (typeof p.text === 'string' && !p.thought) { text += p.text; if (p.text) onText?.(p.text); }
        }
        if (cand?.finishReason) finish = cand.finishReason;
        const u = d.usageMetadata;
        if (u) {
          usage.inputTokens = u.promptTokenCount || usage.inputTokens;
          usage.outputTokens = (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) || usage.outputTokens;
          usage.cacheReadTokens = u.cachedContentTokenCount || 0;
        }
      }
    });

    // Give id-less calls (pre-Gemini-3 models) a local id so tool results can be matched.
    const calls = parts.filter(p => p.functionCall).map(p => toolCall(p.functionCall.id || localId(LOCAL.slice(0, -1)), p.functionCall.name, p.functionCall.args || {}));
    let stopReason;
    if (blocked || REFUSAL_REASONS.has(finish)) stopReason = 'refusal';
    else if (finish === 'MAX_TOKENS') stopReason = 'max_tokens';
    else if (calls.length) stopReason = 'tool_use';
    else if (finish === 'STOP') stopReason = 'end';
    else stopReason = 'other';
    return {
      text,
      toolCalls: calls,
      stopReason,
      usage,
      model: servedBy,
      message: { role: 'assistant', content: text, toolCalls: calls, raw: { provider: 'gemini', parts } },
    };
  },
};

export default gemini;
