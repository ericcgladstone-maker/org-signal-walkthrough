// Shared plumbing for the provider adapters.
//
// Normalized message history (what the analyst loop and callers keep):
//
//   { role: 'user', content: string }
//   { role: 'assistant', content: string, toolCalls?: [{ id, name, arguments }],
//     raw?: { provider, ... } }          provider-native turn, replayed verbatim
//                                        to the same provider (thinking blocks,
//                                        thought signatures, reasoning items)
//   { role: 'tool', toolCallId, name, content: string, isError?: boolean }
//
// Consecutive 'tool' messages answer the preceding assistant turn's toolCalls.
// Each adapter converts this to its wire format. `raw` exists because current
// models attach opaque state to a turn (Anthropic thinking signatures, Gemini
// thoughtSignature, OpenAI reasoning items) that must be sent back unchanged
// for multi-step tool use to keep working; when the history came from a
// different provider the adapter rebuilds the turn from content + toolCalls.
//
// Normalized tool definition: { name, description, parameters } where
// parameters is a JSON Schema object.
//
// chat() resolves to { text, toolCalls, stopReason, usage, message, model }:
//   stopReason  'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'
//   usage       { inputTokens, outputTokens, cacheReadTokens? }
//   message     the assistant turn in normalized form, ready to append

import { fromFetchFailure, readErrorBody, makeError, codeForStatus } from '../errors.js';
import { rememberForRedaction } from '../keys.js';

export function getFetch(f) {
  const fn = f || globalThis.fetch;
  if (typeof fn !== 'function') throw new Error('No fetch implementation available');
  return fn;
}

// One HTTP request with uniform error handling. classify(status, json, text)
// returns { code, detail } for a non-2xx response.
export async function request(provider, { url, method = 'POST', headers, body, fetch, signal, key, classify }) {
  rememberForRedaction(key);
  const f = getFetch(fetch);
  let res;
  try {
    res = await f(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
  } catch (err) {
    throw fromFetchFailure(provider, err, signal);
  }
  if (!res.ok) {
    const { json, text } = await readErrorBody(res);
    const c = classify ? classify(res.status, json, text) : null;
    throw makeError(c?.code || codeForStatus(res.status), provider, { status: res.status, detail: c?.detail ?? text.slice(0, 300) });
  }
  return res;
}

// Wrap stream consumption so a dropped connection or abort mid-stream becomes
// an LLMError rather than a raw TypeError.
export async function consume(provider, signal, fn) {
  try {
    return await fn();
  } catch (err) {
    if (err?.name === 'LLMError') throw err;
    if (err instanceof SyntaxError) throw makeError('bad_response', provider, { detail: err.message });
    throw fromFetchFailure(provider, err, signal);
  }
}

// Tool-call arguments arrive as JSON text. Parse strictly: a truncated or
// malformed argument string must not silently become a partial object.
export function parseArgs(text) {
  if (text == null || text === '') return { ok: true, value: {} };
  if (typeof text === 'object') return { ok: true, value: text };
  try {
    const v = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    return { ok: false, raw: String(text) };
  } catch {
    return { ok: false, raw: String(text) };
  }
}

// Normalized tool call from an id, a name and argument text or object.
// Calls whose arguments failed to parse keep the raw text in `invalidArguments`
// so the loop can return an error result instead of running the tool.
export function toolCall(id, name, args) {
  const p = parseArgs(args);
  return p.ok ? { id, name, arguments: p.value } : { id, name, arguments: {}, invalidArguments: p.raw };
}

// Split a normalized history into runs: each run is one wire-level turn.
// Consecutive tool results become a single 'tool' run.
export function runs(messages) {
  const out = [];
  for (const m of messages || []) {
    const last = out[out.length - 1];
    if (m.role === 'tool' && last?.role === 'tool') last.items.push(m);
    else if (m.role === 'tool') out.push({ role: 'tool', items: [m] });
    else out.push({ role: m.role, items: [m] });
  }
  return out;
}

export function stringifyResult(content) {
  return typeof content === 'string' ? content : JSON.stringify(content);
}

let idCounter = 0;
export function localId(prefix = 'call') { idCounter += 1; return `${prefix}_${Date.now().toString(36)}_${idCounter}`; }
