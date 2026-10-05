// Anthropic Messages API adapter (raw fetch; the app has no build step and no
// npm dependencies, so the official SDK is not available here).
//
// Verified against platform.claude.com docs, 2026-10-02:
//   POST https://api.anthropic.com/v1/messages, headers x-api-key,
//   anthropic-version: 2023-06-01. Browser calls need
//   anthropic-dangerous-direct-browser-access: true (enables CORS; this is the
//   bring-your-own-key case the header exists for).
//   Streaming SSE events: message_start, content_block_start/_delta/_stop
//   (text_delta, input_json_delta, thinking_delta, signature_delta), ping,
//   message_delta (stop_reason, usage.output_tokens), message_stop, error.
//   GET /v1/models: { data: [{ id, display_name, created_at, max_input_tokens,
//   max_tokens }], has_more, last_id } with ?limit= and ?after_id= paging.
//
// Current Claude models think adaptively by default and return thinking
// blocks (empty text, with a signature) that must be echoed back unchanged on
// the next request in a tool loop, so the assistant turn's full content is
// kept in message.raw.
//
// Opus 5.5 / Opus 5 / Fable 5.1 / Sonnet 5.5 run safety classifiers that can
// decline (HTTP 200, stop_reason "refusal"). We opt into server-side
// fallbacks ("default" mode) for those models so a false positive on benign
// network-analysis text is retried on the recommended model inside the same
// call. Pass fallbacks: false to turn it off.

import { request, consume, toolCall, runs, stringifyResult } from './common.js';
import { readSSE } from '../sse.js';
import { makeError } from '../errors.js';

const API = 'https://api.anthropic.com/v1';
const VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const FALLBACK_MODELS = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-fable-5', 'claude-sonnet-5-5']);

function headers(key, extra = {}) {
  return {
    'content-type': 'application/json',
    'x-api-key': key,
    'anthropic-version': VERSION,
    'anthropic-dangerous-direct-browser-access': 'true',
    ...extra,
  };
}

const TYPE_CODE = {
  authentication_error: 'auth', permission_error: 'permission', not_found_error: 'not_found',
  rate_limit_error: 'rate_limit', overloaded_error: 'overloaded', api_error: 'server',
  request_too_large: 'too_large', billing_error: 'billing', invalid_request_error: 'bad_request',
  timeout_error: 'overloaded',
};

// { type: 'error', error: { type, message }, request_id }
function classify(status, json) {
  const e = json?.error;
  const code = (e?.type && TYPE_CODE[e.type]) || undefined;
  return { code, detail: e?.message || '' };
}

const STOP = { end_turn: 'end', stop_sequence: 'end', tool_use: 'tool_use', max_tokens: 'max_tokens',
  model_context_window_exceeded: 'max_tokens', refusal: 'refusal' };

// Tool-use ids must match ^[a-zA-Z0-9_-]+$; ids from another provider may not.
const safeId = id => String(id).replace(/[^a-zA-Z0-9_-]/g, '_');

// After a mid-output fallback, blocks before the final `fallback` marker other
// than text (thinking, tool_use, ...) must not be echoed back; the marker itself
// is an ignorable audit block. Empty text blocks are rejected by the API.
export function echoContent(content) {
  let boundary = -1;
  content.forEach((b, i) => { if (b.type === 'fallback') boundary = i; });
  return content.filter((b, i) => {
    if (b.type === 'fallback') return false;
    if (b.type === 'text') return b.text !== '';
    return i > boundary;
  });
}

function toWire(messages) {
  const out = [];
  for (const run of runs(messages)) {
    if (run.role === 'user') {
      out.push({ role: 'user', content: run.items[0].content });
    } else if (run.role === 'assistant') {
      const m = run.items[0];
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content)) {
        out.push({ role: 'assistant', content: echoContent(m.raw.content) });
      } else {
        const content = [];
        if (m.content) content.push({ type: 'text', text: m.content });
        for (const c of m.toolCalls || []) content.push({ type: 'tool_use', id: safeId(c.id), name: c.name, input: c.arguments || {} });
        out.push({ role: 'assistant', content: content.length ? content : [{ type: 'text', text: '(no text)' }] });
      }
    } else if (run.role === 'tool') {
      // All results for one assistant turn go back in a single user message.
      out.push({ role: 'user', content: run.items.map(t => ({
        type: 'tool_result', tool_use_id: safeId(t.toolCallId), content: stringifyResult(t.content), ...(t.isError ? { is_error: true } : {}),
      })) });
    }
  }
  return out;
}

function toolsToWire(tools) {
  // eager_input_streaming streams tool inputs without server-side buffering;
  // the analyst validates every parsed input before running a tool.
  return tools.map(t => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
}

export const anthropic = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  defaultModel: 'claude-opus-5-5',
  // Streaming lets a large ceiling through without HTTP timeouts; it is a cap,
  // not a target, and is billed only for what is generated.
  defaultMaxTokens: 64000,
  keyPlaceholder: 'sk-ant-...',
  keyUrl: 'https://platform.claude.com/settings/keys',
  browser: 'Requests go from this browser straight to Anthropic.',

  async listModels({ key, fetch, signal } = {}) {
    const models = [];
    let after = null;
    for (let page = 0; page < 20; page++) {
      const url = `${API}/models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`;
      const res = await request('anthropic', { url, method: 'GET', headers: headers(key), fetch, signal, key, classify });
      const json = await consume('anthropic', signal, () => res.json());
      for (const m of json.data || []) {
        models.push({ id: m.id, label: m.display_name || m.id, contextWindow: m.max_input_tokens || null, maxOutput: m.max_tokens || null, created: m.created_at || null });
      }
      if (!json.has_more || !json.last_id) break;
      after = json.last_id;
    }
    return models;
  },

  async chat({ key, model, system, messages, tools, onText, signal, fetch, maxTokens, json, effort, fallbacks = true }) {
    model = model || this.defaultModel;
    const useFallback = fallbacks && FALLBACK_MODELS.has(model);
    const body = {
      model,
      max_tokens: maxTokens || this.defaultMaxTokens,
      stream: true,
      messages: toWire(messages),
    };
    // System prompt (and the tools rendered before it) is identical across the
    // turns of a conversation, so cache it.
    if (system) body.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
    if (tools?.length) body.tools = toolsToWire(tools);
    const outputConfig = {};
    if (effort) outputConfig.effort = effort;
    if (json?.schema) outputConfig.format = { type: 'json_schema', schema: json.schema };
    if (Object.keys(outputConfig).length) body.output_config = outputConfig;
    if (useFallback) body.fallbacks = 'default';

    const res = await request('anthropic', {
      url: `${API}/messages`, headers: headers(key, useFallback ? { 'anthropic-beta': FALLBACK_BETA } : {}),
      body, fetch, signal, key, classify,
    });

    const blocks = [];
    let stop = null;
    let servedBy = model;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };

    await consume('anthropic', signal, async () => {
      for await (const ev of readSSE(res.body, { signal })) {
        let d;
        try { d = JSON.parse(ev.data); } catch { continue; }
        switch (d.type) {
          case 'message_start': {
            const u = d.message?.usage || {};
            usage.inputTokens = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
            usage.cacheReadTokens = u.cache_read_input_tokens || 0;
            if (u.output_tokens) usage.outputTokens = u.output_tokens;
            if (d.message?.model) servedBy = d.message.model;
            break;
          }
          case 'content_block_start': {
            const b = { ...d.content_block };
            if (b.type === 'tool_use') { b._json = ''; }
            blocks[d.index] = b;
            break;
          }
          case 'content_block_delta': {
            const b = blocks[d.index];
            const delta = d.delta || {};
            if (!b) break;
            if (delta.type === 'text_delta') { b.text = (b.text || '') + delta.text; onText?.(delta.text); }
            else if (delta.type === 'input_json_delta') b._json += delta.partial_json || '';
            else if (delta.type === 'thinking_delta') b.thinking = (b.thinking || '') + delta.thinking;
            else if (delta.type === 'signature_delta') b.signature = (b.signature || '') + delta.signature;
            else if (delta.type === 'citations_delta') (b.citations ||= []).push(delta.citation);
            break;
          }
          case 'content_block_stop': break;
          case 'message_delta': {
            if (d.delta?.stop_reason) stop = d.delta.stop_reason;
            if (d.usage?.output_tokens != null) usage.outputTokens = d.usage.output_tokens;
            if (d.usage?.input_tokens != null && d.usage.input_tokens > usage.inputTokens) usage.inputTokens = d.usage.input_tokens;
            break;
          }
          case 'error': {
            const code = TYPE_CODE[d.error?.type] || 'server';
            throw makeError(code, 'anthropic', { detail: d.error?.message || '' });
          }
          default: break; // ping, message_stop, future event types
        }
      }
    });

    // Finalize tool_use inputs. Keep the raw text when it is not valid JSON so
    // the caller can report it rather than run a tool on a truncated input.
    const content = [];
    const calls = [];
    let boundary = -1;
    blocks.forEach((b, i) => { if (b?.type === 'fallback') boundary = i; });
    blocks.forEach((b, i) => {
      if (!b) return;
      if (b.type === 'tool_use') {
        const call = toolCall(b.id, b.name, b._json);
        const { _json, ...clean } = b;
        clean.input = call.arguments;
        content.push(clean);
        if (i > boundary) calls.push(call);
      } else {
        content.push(b);
      }
    });
    const text = content.filter(b => b.type === 'text').map(b => b.text).join('');
    const stopReason = STOP[stop] || (calls.length ? 'tool_use' : 'other');
    return {
      text,
      toolCalls: calls,
      stopReason,
      usage,
      model: servedBy,
      message: { role: 'assistant', content: text, toolCalls: calls, raw: { provider: 'anthropic', content } },
    };
  },
};

export default anthropic;
