// OpenAI adapter on the Responses API (raw fetch).
//
// Verified against developers.openai.com docs, 2026-10-02:
//   - Responses is recommended for new projects; current models do not
//     support tool calling through Chat Completions (gpt-6.1-sol model page),
//     so Chat Completions is not used here.
//   - POST https://api.openai.com/v1/responses, Authorization: Bearer <key>.
//     Body: model, instructions, input[], tools [{ type:'function', name,
//     description, parameters, strict }], max_output_tokens, stream, store.
//   - Stream events (data.type): response.output_text.delta { delta },
//     response.output_item.added / .done { output_index, item },
//     response.function_call_arguments.delta / .done, response.refusal.delta,
//     response.completed / response.incomplete { response: { status,
//     incomplete_details, usage } }, response.failed, error.
//   - Tool results go back as { type:'function_call_output', call_id, output }.
//     Stateless use (store:false) must replay every item of the previous
//     response's output (reasoning items included) before the results;
//     include: ['reasoning.encrypted_content'] makes reasoning items replayable.
//   - GET /v1/models -> { object:'list', data:[{ id, created, owned_by }] }.
//   - Errors: { error: { message, type, param, code } }. 401 bad key, 403
//     unsupported region, 429 rate limit or (by error.code) billing, 503 overloaded.
//   - Browser: the API answers CORS preflights (access-control-allow-origin: *),
//     though OpenAI advises against exposing keys client-side. This app only
//     uses the user's own key in the user's own browser.

import { request, consume, toolCall, runs, stringifyResult } from './common.js';
import { readSSE } from '../sse.js';
import { makeError } from '../errors.js';

const API = 'https://api.openai.com/v1';

const BILLING_CODES = new Set(['insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'billing_hard_limit_reached']);

function classify(status, json) {
  const e = json?.error || {};
  const detail = e.message || '';
  if (e.code === 'invalid_api_key' || status === 401) return { code: 'auth', detail };
  if (BILLING_CODES.has(e.code) || BILLING_CODES.has(e.type)) return { code: 'billing', detail };
  if (e.code === 'model_not_found') return { code: 'not_found', detail };
  if (e.code === 'context_length_exceeded') return { code: 'too_large', detail };
  if (status === 403) return { code: 'permission', detail };
  if (status === 503 || e.code === 'server_is_overloaded' || e.type === 'service_unavailable_error') return { code: 'overloaded', detail };
  return { code: undefined, detail };
}

function errorFromEvent(e) {
  const code = e?.code;
  const detail = e?.message || '';
  if (BILLING_CODES.has(code)) return makeError('billing', 'openai', { detail });
  if (code === 'rate_limit_exceeded') return makeError('rate_limit', 'openai', { detail });
  if (code === 'server_is_overloaded' || code === 'service_unavailable') return makeError('overloaded', 'openai', { detail });
  if (code === 'context_length_exceeded') return makeError('too_large', 'openai', { detail });
  return makeError('server', 'openai', { detail });
}

function headers(key) {
  return { 'content-type': 'application/json', authorization: `Bearer ${key}` };
}

function toInput(messages) {
  const input = [];
  for (const run of runs(messages)) {
    if (run.role === 'user') input.push({ role: 'user', content: run.items[0].content });
    else if (run.role === 'assistant') {
      const m = run.items[0];
      if (m.raw?.provider === 'openai' && Array.isArray(m.raw.output)) input.push(...m.raw.output);
      else {
        if (m.content) input.push({ role: 'assistant', content: m.content });
        for (const c of m.toolCalls || []) input.push({ type: 'function_call', call_id: String(c.id), name: c.name, arguments: JSON.stringify(c.arguments || {}) });
      }
    } else if (run.role === 'tool') {
      for (const t of run.items) input.push({ type: 'function_call_output', call_id: String(t.toolCallId), output: stringifyResult(t.content) });
    }
  }
  return input;
}

// Our schemas have optional properties, which strict mode does not allow, so
// strict is set to false explicitly (omitting it makes the API try strict first).
function toolsToWire(tools) {
  return tools.map(t => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
}

// Model ids that are clearly not text-generation models.
const NON_CHAT = /(embedding|whisper|tts|dall-e|image|moderation|transcribe|realtime|audio|search|davinci|babbage|sora|computer-use)/i;

export const openai = {
  id: 'openai',
  label: 'OpenAI',
  defaultModel: 'gpt-6.1-sol',
  defaultMaxTokens: 32000, // includes reasoning tokens
  keyPlaceholder: 'sk-...',
  keyUrl: 'https://platform.openai.com/api-keys',
  browser: 'Direct browser calls are accepted (CORS). OpenAI advises keeping keys out of shared client code; here the key stays in this browser.',

  async listModels({ key, fetch, signal } = {}) {
    const res = await request('openai', { url: `${API}/models`, method: 'GET', headers: headers(key), fetch, signal, key, classify });
    const json = await consume('openai', signal, () => res.json());
    return (json.data || [])
      .filter(m => !NON_CHAT.test(m.id))
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map(m => ({ id: m.id, label: m.id, created: m.created ? new Date(m.created * 1000).toISOString() : null, contextWindow: null, maxOutput: null }));
  },

  async chat({ key, model, system, messages, tools, onText, signal, fetch, maxTokens, json, effort }) {
    model = model || this.defaultModel;
    const body = {
      model,
      input: toInput(messages),
      max_output_tokens: maxTokens || this.defaultMaxTokens,
      stream: true,
      store: false,
      include: ['reasoning.encrypted_content'],
    };
    if (system) body.instructions = system;
    if (tools?.length) body.tools = toolsToWire(tools);
    if (effort) body.reasoning = { effort };
    if (json?.schema) body.text = { format: { type: 'json_schema', name: json.name || 'output', schema: json.schema, strict: !!json.strict } };

    const res = await request('openai', { url: `${API}/responses`, headers: headers(key), body, fetch, signal, key, classify });

    const items = [];      // by output_index
    const args = new Map(); // output_index -> streamed argument text
    let text = '';
    let refusal = '';
    let final = null;
    let servedBy = model;

    await consume('openai', signal, async () => {
      for await (const ev of readSSE(res.body, { signal })) {
        if (ev.data === '[DONE]') break;
        let d;
        try { d = JSON.parse(ev.data); } catch { continue; }
        switch (d.type) {
          case 'response.created': if (d.response?.model) servedBy = d.response.model; break;
          case 'response.output_text.delta': text += d.delta || ''; onText?.(d.delta || ''); break;
          case 'response.refusal.delta': refusal += d.delta || ''; break;
          case 'response.output_item.added': items[d.output_index] = d.item; break;
          case 'response.function_call_arguments.delta': args.set(d.output_index, (args.get(d.output_index) || '') + (d.delta || '')); break;
          case 'response.function_call_arguments.done': args.set(d.output_index, d.arguments ?? args.get(d.output_index)); break;
          case 'response.output_item.done': items[d.output_index] = d.item; break;
          case 'response.completed':
          case 'response.incomplete':
            final = d.response; break;
          case 'response.failed':
            throw errorFromEvent(d.response?.error);
          case 'error':
            throw errorFromEvent(d.error || d);
          default: break;
        }
      }
    });

    // Prefer the completed response's output (authoritative and complete);
    // fall back to items assembled from the stream.
    const output = (final?.output?.length ? final.output : items.filter(Boolean)).map((it, i) => {
      if (it?.type === 'function_call' && !it.arguments && args.has(i)) return { ...it, arguments: args.get(i) };
      return it;
    });
    const calls = output.filter(it => it?.type === 'function_call').map(it => toolCall(it.call_id, it.name, it.arguments));
    if (!text) {
      text = output.filter(it => it?.type === 'message').flatMap(it => it.content || []).filter(c => c.type === 'output_text').map(c => c.text).join('');
    }
    if (!refusal) refusal = output.filter(it => it?.type === 'message').flatMap(it => it.content || []).filter(c => c.type === 'refusal').map(c => c.refusal).join('');
    const status = final?.status;
    const reason = final?.incomplete_details?.reason;
    let stopReason;
    if (refusal || reason === 'content_filter') stopReason = 'refusal';
    else if (status === 'incomplete' && reason === 'max_output_tokens') stopReason = 'max_tokens';
    else if (calls.length) stopReason = 'tool_use';
    else if (status === 'completed') stopReason = 'end';
    else stopReason = 'other';
    const u = final?.usage || {};
    return {
      text: text || (stopReason === 'refusal' ? refusal : ''),
      toolCalls: calls,
      stopReason,
      usage: { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0, cacheReadTokens: u.input_tokens_details?.cached_tokens || 0 },
      model: final?.model || servedBy,
      message: { role: 'assistant', content: text, toolCalls: calls, raw: { provider: 'openai', output } },
    };
  },
};

export default openai;
