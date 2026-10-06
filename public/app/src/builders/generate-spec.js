// Generator form logic (pure, Node-testable): normalise whatever
// listContexts() returns, work out which combinations are valid, reset
// choices that become invalid, and describe the result in plain language.
//
// The generator owns its parameters. This file only reads them:
//   listContexts() -> [{ id, label, description, media[], params[], defaults{},
//                        presets[{id,label,params}], timespan{start,days},
//                        observations[], nativeMedia[] }]
// Accepted variations, normalised here:
//   media       strings, or { id, label, observations?, native?, importer?, files? }
//   params      array of { key, label, type, min, max, default, choices|options, help }
//               or an object keyed by param name
//   presets     array, or an object keyed by id
//
// What the generator does not (yet) say per medium, the UI fills from
// MEDIUM_INFO below: which observations an export of that medium can
// realistically show, what its native files are, and which importer reads
// them. Anything the generator states wins over these hints.

export const CONTENT_LEVELS = [
  { id: 'none', label: 'No text', help: 'Interactions only: who, whom, when, where. Smallest and fastest.' },
  { id: 'light', label: 'Light text', help: 'Short messages drawn from a vocabulary, enough for keywords, affect and diffusion of planted terms.' },
  { id: 'full', label: 'Full text', help: 'Longer messages with topics and affect shifts planted over time. Largest files.' },
];

export const OBSERVATIONS = {
  full: { label: 'Everyone', help: 'An admin or whole-group export: every interaction among the people in the world.' },
  ego: { label: 'One person', help: 'One person\'s own export: only interactions they sent, received, were mentioned in or attended.' },
  authored: { label: 'One person\'s posts', help: 'Only what one account wrote, as in a data package or a public repository.' },
  chat: { label: 'One conversation', help: 'A single conversation exported from a chat app.' },
  sample: { label: 'A sample', help: 'Interactions by a random share of people, as in a research dataset.' },
};

// Realism hints per medium (what a real export of that medium shows) and the
// importer that reads its native files. Keys are generator medium ids.
export const MEDIUM_INFO = {
  slack: { label: 'Slack', observations: ['full'], files: 'a Slack workspace export (zip with users.json, channels.json and one folder of day files per channel)', importer: 'Slack export' },
  teams: { label: 'Microsoft Teams', observations: ['full', 'ego'], files: 'a Teams / Purview export', importer: 'Microsoft Teams' },
  email: { label: 'Email', observations: ['ego', 'full'], files: 'an mbox mailbox', importer: 'Email (mbox / eml)' },
  calendar: { label: 'Calendar', observations: ['ego', 'full'], files: 'an iCalendar (.ics) file', importer: 'Calendar (.ics)' },
  network: { label: 'Network file', observations: ['full', 'sample'], files: 'a GraphML network file', importer: 'Network files (GraphML, GEXF, edge lists)' },
  x: { label: 'X (Twitter)', observations: ['ego', 'authored', 'sample'], files: 'an X account archive (data/*.js files)', importer: 'X archive' },
  bluesky: { label: 'Bluesky', observations: ['ego', 'authored', 'sample'], files: 'a Bluesky repository (CAR file)', importer: 'Bluesky' },
  mastodon: { label: 'Mastodon', observations: ['ego', 'authored', 'sample'], files: 'a Mastodon account archive', importer: 'Mastodon' },
  threads: { label: 'Threads', observations: ['ego', 'authored'], files: 'a Threads data download', importer: 'Threads' },
  linkedin: { label: 'LinkedIn', observations: ['ego'], files: 'a LinkedIn data export (Connections.csv, messages.csv, ...)', importer: 'LinkedIn export' },
  whatsapp: { label: 'WhatsApp', observations: ['ego', 'chat'], files: 'WhatsApp chat exports (.txt)', importer: 'WhatsApp chat' },
  telegram: { label: 'Telegram', observations: ['ego', 'chat'], files: 'a Telegram Desktop export (result.json)', importer: 'Telegram' },
  imessage: { label: 'iMessage', observations: ['ego', 'chat'], files: 'an iMessage database export', importer: 'iMessage' },
  messenger: { label: 'Messenger', observations: ['ego', 'chat'], files: 'a Meta data download', importer: 'Messenger / Instagram' },
  discord: { label: 'Discord', observations: ['full', 'authored'], files: 'a Discord server or account export', importer: 'Discord' },
  reddit: { label: 'Reddit', observations: ['full', 'sample', 'authored'], files: 'Reddit comment and submission dumps', importer: 'Reddit' },
  survey: { label: 'Survey', observations: ['full', 'ego'], files: 'survey CSV files (roster matrix and name-generator answers)', importer: 'Survey (roster / ego)' },
};

// The browser target from CONTRACTS.md: ~5,000 nodes and a few million events.
export const COMFORT = { nodes: 5000, warnAbove: 5000, hardNote: 20000 };
// Betweenness and closeness are estimated by sampling above this many people (src/analysis/metrics.js).
const APPROX_ABOVE = 3000;

// Dev-only fallback used when src/generator/index.js cannot be loaded, so the
// form can be built and checked. Generation is disabled while it is in use.
export const FALLBACK_CONTEXTS = [
  { id: 'workplace', label: 'Workplace', media: ['slack', 'teams', 'email', 'calendar'] },
  { id: 'online', label: 'Online public', media: ['x', 'bluesky', 'mastodon', 'threads', 'reddit'] },
  { id: 'professional', label: 'Professional network', media: ['linkedin', 'email'] },
  { id: 'personal', label: 'Personal', media: ['whatsapp', 'imessage', 'telegram', 'messenger'] },
  { id: 'community', label: 'Community', media: ['discord', 'reddit', 'slack'] },
  { id: 'survey', label: 'Survey', media: ['survey'] },
].map(c => ({ ...c, devFallback: true, params: [{ key: 'size', label: 'People', type: 'int', min: 8, max: 50000, default: 120 }], presets: [{ id: 'default', label: 'Default structure', params: {} }], observations: ['full', 'ego', 'authored', 'chat', 'sample'], timespan: { start: '2025-01-06', days: 90 } }));

function normParams(p) {
  const arr = Array.isArray(p) ? p : p && typeof p === 'object' ? Object.entries(p).map(([key, v]) => ({ key, ...v })) : [];
  return arr.filter(x => x && x.key).map(x => {
    const choices = x.choices || x.options || x.values || null;
    return {
      key: x.key, label: x.label || x.key, help: x.help || x.description || '',
      type: x.type || (choices ? 'choice' : typeof x.default === 'boolean' ? 'boolean' : typeof x.default === 'number' ? 'number' : 'text'),
      min: x.min, max: x.max, step: x.step, default: x.default,
      choices: choices ? choices.map(c => (typeof c === 'object' ? { id: String(c.id ?? c.value), label: c.label ?? String(c.id ?? c.value) } : { id: String(c), label: String(c) })) : null,
    };
  });
}

export function normalizeContexts(list) {
  return (list || []).map(c => {
    const media = (c.media || []).map(m => {
      const id = typeof m === 'string' ? m : m.id;
      const hint = MEDIUM_INFO[id] || {};
      const o = typeof m === 'object' ? m : {};
      return {
        id, label: o.label || hint.label || id,
        observations: o.observations || hint.observations || null,
        native: o.native ?? (Array.isArray(c.nativeMedia) ? c.nativeMedia.includes(id) : null),
        files: o.files || hint.files || null,
        importer: o.importer || hint.importer || null,
        nativeView: o.nativeView ?? null,
      };
    });
    const presets = Array.isArray(c.presets) ? c.presets : c.presets && typeof c.presets === 'object'
      ? Object.entries(c.presets).map(([id, p]) => ({ id, ...p })) : [];
    const params = normParams(c.params || c.schema);
    return {
      id: c.id, label: c.label || c.id, description: c.description || '',
      media, params, defaults: { ...Object.fromEntries(params.map(p => [p.key, p.default])), ...(c.defaults || {}) },
      presets: presets.map(p => ({ id: p.id, label: p.label || p.id, params: p.params || {} })),
      observations: c.observations || Object.keys(OBSERVATIONS),
      timespan: c.timespan || c.timespanDefaults || null,
      devFallback: !!c.devFallback,
    };
  }).filter(c => c.id);
}

// Observations offered for a context + medium: the context's list, narrowed
// by what an export of that medium can show. Order follows the medium's list
// (most typical first).
export function validObservations(ctx, mediumId) {
  const m = ctx?.media.find(x => x.id === mediumId);
  const allowed = ctx?.observations || Object.keys(OBSERVATIONS);
  const pref = m?.observations || allowed;
  const out = pref.filter(o => allowed.includes(o));
  return out.length ? out : allowed.slice(0, 1);
}

// The observation a form starts on, and falls back to: everyone when the
// medium allows it, because only a whole-group view can show the planted
// structure (a one-person export of a polarized world is a star).
export function defaultObservation(ctx, mediumId) {
  const obs = validObservations(ctx, mediumId);
  return obs.includes('full') ? 'full' : obs[0];
}

export function sizeParam(ctx) {
  return ctx?.params.find(p => p.key === 'size') || { key: 'size', label: 'People', type: 'int', min: 2, max: 50000, default: 100 };
}

// Every choice with whether it is valid and why not.
export function options(contexts, form) {
  const ctx = contexts.find(c => c.id === form.context) || null;
  const obs = ctx ? validObservations(ctx, form.medium) : [];
  const size = sizeParam(ctx);
  return {
    contexts: contexts.map(c => ({ id: c.id, label: c.label, enabled: c.media.length > 0, reason: c.media.length ? '' : 'No media for this context yet' })),
    media: ctx ? ctx.media.map(m => {
      const nativeBlocked = form.output === 'native' && m.native === false;
      return { id: m.id, label: m.label, enabled: !nativeBlocked, reason: nativeBlocked ? 'No native export writer for this medium yet' : '' };
    }) : [],
    structures: ctx ? ctx.presets.map(p => ({ id: p.id, label: p.label, enabled: true, reason: '' })) : [],
    observations: Object.keys(OBSERVATIONS).filter(o => !ctx || ctx.observations.includes(o) || obs.includes(o)).map(o => ({
      id: o, label: OBSERVATIONS[o].label, help: OBSERVATIONS[o].help, enabled: obs.includes(o),
      reason: obs.includes(o) ? '' : `A ${ctx?.media.find(m => m.id === form.medium)?.label || 'this'} export does not show this slice`,
    })),
    content: CONTENT_LEVELS.map(c => ({ ...c, enabled: true, reason: '' })),
    size: { min: size.min ?? 2, max: size.max ?? 50000, default: size.default ?? 100, label: size.label },
    params: ctx ? ctx.params.filter(p => p.key !== 'size') : [],
  };
}

export function defaultForm(contexts, contextId) {
  const ctx = contexts.find(c => c.id === contextId) || contexts[0];
  if (!ctx) return { context: null };
  const medium = ctx.media[0]?.id ?? null;
  return {
    context: ctx.id, medium,
    structure: ctx.presets[0]?.id ?? null,
    size: sizeParam(ctx).default ?? 100,
    content: 'light',
    observation: defaultObservation(ctx, medium) ?? 'full',
    seed: 1,
    days: ctx.timespan?.days ?? 90,
    start: ctx.timespan?.start ?? null,
    params: {},
    output: 'dataset',
  };
}

// Apply a change and repair whatever it made invalid downstream. Returns the
// new form plus a list of human-readable notes on what was reset.
export function applyChange(contexts, form, patch) {
  let f = { ...form, ...patch };
  const notes = [];
  if (patch.context && patch.context !== form.context) {
    const d = defaultForm(contexts, patch.context);
    f = { ...d, seed: form.seed, content: form.content, output: form.output };
    return { form: f, notes };
  }
  const ctx = contexts.find(c => c.id === f.context);
  if (!ctx) return { form: f, notes };
  if (!ctx.media.some(m => m.id === f.medium)) { f.medium = ctx.media[0]?.id ?? null; notes.push('Medium reset'); }
  const o = options(contexts, f);
  if (!o.media.find(m => m.id === f.medium)?.enabled) {
    const alt = o.media.find(m => m.enabled);
    if (alt) { notes.push(`${o.media.find(m => m.id === f.medium)?.label} has no native export; switched to ${alt.label}`); f.medium = alt.id; }
  }
  const obs = validObservations(ctx, f.medium);
  if (!obs.includes(f.observation)) {
    const to = defaultObservation(ctx, f.medium);
    notes.push(`What the export shows changed to "${OBSERVATIONS[to]?.label || to}" because ${ctx.media.find(m => m.id === f.medium)?.label || f.medium} exports do not show "${OBSERVATIONS[f.observation]?.label || f.observation}"`);
    f.observation = to;
  }
  if (f.structure && !ctx.presets.some(p => p.id === f.structure)) { f.structure = ctx.presets[0]?.id ?? null; notes.push('Scenario reset'); }
  const s = sizeParam(ctx);
  const n = Math.round(Number(f.size));
  f.size = Number.isFinite(n) ? Math.max(s.min ?? 2, Math.min(s.max ?? 50000, n)) : (s.default ?? 100);
  return { form: f, notes };
}

// The spec handed to generate(). Extra params are only sent when the user
// changed them, so the generator's own defaults and preset values apply.
export function toSpec(form, { output = form.output || 'dataset' } = {}) {
  const spec = {
    context: form.context, medium: form.medium, size: form.size, seed: Number(form.seed) || 1,
    structure: form.structure, content: form.content, observation: form.observation, output,
  };
  if (form.days || form.start) spec.timespan = { ...(form.start ? { start: form.start } : {}), ...(form.days ? { days: Number(form.days) } : {}) };
  for (const [k, v] of Object.entries(form.params || {})) if (v !== undefined && v !== '') spec[k] = v;
  return spec;
}

export function sizeNote(n) {
  if (n > COMFORT.hardNote) return { level: 'warn', text: `${n.toLocaleString('en-US')} people is far past what a browser tab handles comfortably (about ${COMFORT.nodes.toLocaleString('en-US')}). Expect long waits and approximate measures; consider native files and a smaller slice.` };
  if (n > COMFORT.warnAbove) return { level: 'warn', text: `Above about ${COMFORT.nodes.toLocaleString('en-US')} people generation and analysis take longer, and betweenness and closeness are labeled approximations (as they are above ${APPROX_ABOVE.toLocaleString('en-US')}).` };
  if (n > APPROX_ABOVE) return { level: 'info', text: `Above ${APPROX_ABOVE.toLocaleString('en-US')} people betweenness and closeness are labeled approximations; up to about ${COMFORT.nodes.toLocaleString('en-US')} people run comfortably in the browser.` };
  return { level: 'info', text: `Up to about ${COMFORT.nodes.toLocaleString('en-US')} people and a few million interactions run comfortably in the browser.` };
}

// 2025-01-06 -> "6 Jan 2025" (the app's one date format).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDay(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : String(iso || '');
}

// Views that show one person's corner of the world: the planted groups and
// brokers cannot appear as structure in them.
const PARTIAL = new Set(['ego', 'authored', 'chat']);

// Plain-language description of what will be generated and what the export
// shows. `caution` (or null) warns when the chosen view cannot show the
// planted structure; `nativeCaution` does the same for the native files,
// whose view is fixed by the real export format.
export function describe(contexts, form) {
  const ctx = contexts.find(c => c.id === form.context);
  if (!ctx) return { what: '', export: '', caution: null, native: '', nativeCaution: null, nativeAvailable: false };
  const m = ctx.media.find(x => x.id === form.medium) || { label: form.medium };
  const preset = ctx.presets.find(p => p.id === form.structure);
  const obs = OBSERVATIONS[form.observation];
  const content = CONTENT_LEVELS.find(c => c.id === form.content);
  const span = form.days ? ` over ${form.days} days${form.start ? ` from ${fmtDay(form.start)}` : ''}` : '';
  const what = `A synthetic ${ctx.label.toLowerCase()} world of ${Number(form.size).toLocaleString('en-US')} people${span}, interacting through ${m.label}`
    + `${preset ? `. Scenario: ${preset.label.replace(/\.$/, '')}` : ''}. ${content ? content.label + ': ' + content.help.charAt(0).toLowerCase() + content.help.slice(1) : ''}`
    + ` Random seed ${form.seed}: the same settings and seed always give the same world.`;
  const exportText = `What you will see: ${obs ? obs.label.toLowerCase() + ' (' + obs.help.charAt(0).toLowerCase() + obs.help.slice(1).replace(/\.$/, '') + ')' : form.observation}.`
    + ' The true network, planted groups, brokers, hierarchy and events are kept as ground truth for the recovery check.';
  const everyone = validObservations(ctx, form.medium).includes('full');
  const caution = PARTIAL.has(form.observation)
    ? `${obs.label} shows only the people around one person, so the planted groups${preset ? ` of "${preset.label.replace(/[:.].*$/, '')}"` : ''} and the brokers between them cannot appear as structure.${everyone ? ' Choose Everyone to see them.' : ''}`
    : null;
  const native = m.files
    ? `Native files: ${m.files}${m.importer ? `, read back by the ${m.importer} importer` : ''}.`
    : 'Native files in the real export layout for this medium, read back by its importer.';
  // The files hold only what the real format records, so after import the
  // counts can differ from the generated world loaded directly (src/generator/native.js).
  const nativeLimit = form.medium === 'slack'
    ? ' A Slack export lists each person once per emoji on a message, so a repeated reaction is counted once after import, and the event count can be slightly lower than the generated world\'s.'
    : ' The files hold only what this export format records, so the counts after import can differ from the generated world\'s.';
  const nv = String(m.nativeView || '');
  const nativeCaution = nv && !/^full/.test(nv)
    ? `A real ${m.label} export is one person's view (${nv}), so the files show only that person's ties, whatever you chose above; the planted groups will not show as communities.`
    : null;
  return { what, export: exportText, caution, native: native + nativeLimit, nativeCaution, nativeAvailable: m.native !== false };
}

// Error text from a failed run -> what to tell the user. Out-of-memory
// failures surface from the worker as clone or allocation errors; they get a
// plain explanation and a way forward instead of the raw message.
export function friendlyError(message, { size } = {}) {
  const msg = String(message || '');
  if (/out of memory|could not be cloned|allocation failed|invalid array length|invalid typed array length|maximum call stack|RangeError/i.test(msg)) {
    const n = Number(size);
    return `The browser ran out of memory${Number.isFinite(n) ? ` generating ${n.toLocaleString('en-US')} people` : ''}. Try a smaller world (up to about ${COMFORT.nodes.toLocaleString('en-US')} people runs comfortably), fewer days, or No text under Message text. Nothing was loaded and the data you had is unchanged.`;
  }
  return msg || 'Generation failed.';
}
