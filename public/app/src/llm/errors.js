// User-facing errors for the LLM layer.
//
// Provider adapters turn every failure (HTTP status, error JSON, a stream
// error event, a thrown fetch) into an LLMError with a stable `code` the UI
// can branch on and a `message` written for the person using the app, not for
// a developer. All text passes through redact() so a key never reaches the UI.

import { redact } from './keys.js';

export const ERROR_CODES = ['auth', 'permission', 'billing', 'rate_limit', 'overloaded', 'not_found', 'bad_request',
  'too_large', 'server', 'network', 'aborted', 'refusal', 'bad_response'];

export class LLMError extends Error {
  // code      one of ERROR_CODES
  // provider  'anthropic' | 'openai' | 'gemini'
  // status    HTTP status or 0
  // retryable whether trying again later can help
  // detail    the provider's own message (redacted), for a "details" disclosure
  constructor({ code, provider, status = 0, message, detail = '', retryable = false }) {
    super(redact(message));
    this.name = 'LLMError';
    this.code = code;
    this.provider = provider;
    this.status = status;
    this.retryable = retryable;
    this.detail = redact(detail);
  }
}

const LABEL = { anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };

const KEY_PAGES = {
  anthropic: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
};

// Map a code to a plain-language message. `detail` is appended where it helps.
export function messageFor(code, provider, detail = '') {
  const who = LABEL[provider] || provider;
  const d = detail ? ` (${who} said: ${truncate(detail, 240)})` : '';
  switch (code) {
    case 'auth': return `${who} rejected the API key. Check that it was pasted completely and has not been revoked. Keys are managed at ${KEY_PAGES[provider] || 'the provider console'}.${d}`;
    case 'permission': return `This ${who} key is valid but is not allowed to do this (for example, the model is not enabled for its project or region).${d}`;
    case 'billing': return `${who} reports a billing or quota problem on this account. Add credit or check the plan, then try again.${d}`;
    case 'rate_limit': return `${who} is rate-limiting this key. Wait a minute and try again, or use a smaller request.${d}`;
    case 'overloaded': return `${who} is temporarily overloaded. Try again in a moment.${d}`;
    case 'not_found': return `${who} does not recognize that model for this key. Pick another model from the list.${d}`;
    case 'too_large': return `The request is too large for ${who}. Ask about a smaller part of the network or use fewer messages.${d}`;
    case 'bad_request': return `${who} rejected the request.${d}`;
    case 'server': return `${who} had an internal error. Try again shortly.${d}`;
    case 'network': return `Could not reach ${who}. Check the internet connection. If you are online, a browser extension, firewall or the browser's cross-origin (CORS) rules may have blocked the request.${d}`;
    case 'aborted': return 'Stopped.';
    case 'refusal': return `The model declined to answer this request.${d}`;
    case 'bad_response': return `${who} sent a response this app could not read.${d}`;
    default: return `${who} request failed.${d}`;
  }
}

function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 3) + '...' : s; }

// Status -> code. Provider-specific error types refine it (see fromHttp callers).
export function codeForStatus(status) {
  if (status === 401) return 'auth';
  if (status === 402) return 'billing';
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  if (status === 408) return 'overloaded';
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limit';
  if (status === 529 || status === 503) return 'overloaded';
  if (status >= 500) return 'server';
  return 'bad_request';
}

const RETRYABLE = new Set(['rate_limit', 'overloaded', 'server', 'network']);

export function makeError(code, provider, { status = 0, detail = '' } = {}) {
  return new LLMError({ code, provider, status, detail, message: messageFor(code, provider, detail), retryable: RETRYABLE.has(code) });
}

// fetch() rejected: abort, offline, DNS, or a CORS block (browsers report
// CORS failures as an opaque TypeError, indistinguishable from offline).
export function fromFetchFailure(provider, err, signal) {
  if (signal?.aborted || err?.name === 'AbortError') return makeError('aborted', provider);
  const cause = err?.cause?.code || err?.cause?.message || '';
  return makeError('network', provider, { detail: cause ? String(cause) : '' });
}

// Read an error body once, as JSON if possible.
export async function readErrorBody(res) {
  let text = '';
  try { text = await res.text(); } catch { /* body unreadable */ }
  try { return { json: JSON.parse(text), text }; } catch { return { json: null, text }; }
}
