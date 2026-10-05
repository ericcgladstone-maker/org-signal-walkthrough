// Synthetic social worlds with planted ground truth.
//
// Three levels:
//   1. social context (contexts/*.js) decides who exists, their attributes and
//      the true ties, plus planted structure (communities, hierarchy, brokers)
//      and planted events (departures, reorgs, silos, quiet teams, affect shifts);
//   2. medium (sim/*.js) decides what interactions look like and how they arise
//      from true ties over the timespan, with medium-typical rhythms;
//   3. observation (observe.js) decides what slice an export would show.
// Output is a Dataset (built directly) or native export files in the real
// layout for the medium (writers/*.js), plus the ground truth.
//
// Public API (see docs/api/generator.md):
//   listContexts() -> [{ id, label, media, params, defaults, presets, timespan }]
//   generate(spec) -> { dataset, groundTruth, files? }
//   recoveryCheck(groundTruth, ds, [net,] results) -> report

import { Rng } from './rng.js';
import { normalizeTimespan, makeRhythm } from './time.js';
import { makeContent } from './content.js';
import { makeIdentities } from './identity.js';
import { normalizeObservation } from './observe.js';
import { makeDatasetSink } from './dataset.js';
import { makeCtx } from './sim/core.js';
import { makeTruthAccumulator, buildGroundTruth } from './groundtruth.js';
import { plantCascades } from './contexts/common.js';
import { SEED_TERMS } from './vocab.js';
import { CONTEXTS, SIMS, NATIVE_VIEW } from './registry.js';
import { WRITERS } from './writers/index.js';
import { nativeView, nativeAllNodes } from './native.js';

export { recoveryCheck } from './recovery.js';

// Per medium: which observations are realistic for its exports, what the
// native output is, and which importer (registry id) reads it back.
export const MEDIUM_INFO = {
  slack: { label: 'Slack', observations: ['full', 'ego', 'chat', 'sample'], nativeView: 'full', files: 'Slack workspace export zip: users.json, channels.json, groups.json, dms.json, mpims.json and one folder of YYYY-MM-DD.json day files per conversation', importer: 'slack' },
  email: { label: 'Email', observations: ['ego', 'full', 'sample'], nativeView: 'ego', files: "Google Takeout zip with one person's mailbox (Takeout/Mail/All mail Including Spam and Trash.mbox)", importer: 'email' },
  calendar: { label: 'Calendar', observations: ['ego', 'full'], nativeView: 'ego', files: "Google Calendar export zip with one person's calendar (.ics)", importer: 'calendar' },
  network: { label: 'Network file', observations: ['full', 'sample'], nativeView: 'full', files: 'GraphML file of the declared (true) ties', importer: 'network-files' },
  x: { label: 'X (Twitter)', observations: ['ego', 'authored', 'sample', 'full'], nativeView: 'ego', files: "X account archive zip (data/manifest.js, tweets.js, like.js, follower.js, following.js, direct-messages.js)", importer: 'x-archive' },
  bluesky: { label: 'Bluesky', observations: ['authored', 'ego', 'sample', 'full'], nativeView: null, files: null, importer: 'bluesky' },
  mastodon: { label: 'Mastodon', observations: ['ego', 'authored', 'sample', 'full'], nativeView: null, files: null, importer: 'mastodon' },
  linkedin: { label: 'LinkedIn', observations: ['ego', 'full', 'sample'], nativeView: 'ego', files: 'LinkedIn Complete data export zip (Connections.csv, messages.csv, Invitations.csv, Profile.csv, Positions.csv, Education.csv)', importer: 'linkedin' },
  whatsapp: { label: 'WhatsApp', observations: ['ego', 'chat', 'full'], nativeView: 'ego (one export per chat) or chat', files: 'WhatsApp chat exports, one per conversation (iOS zip with _chat.txt, or Android .txt; spec.platform, spec.locale)', importer: 'whatsapp' },
  telegram: { label: 'Telegram', observations: ['ego', 'chat', 'full'], nativeView: 'ego (full export) or chat', files: 'Telegram Desktop JSON export (DataExport_*/result.json, or ChatExport_*/result.json for one chat)', importer: 'telegram' },
  imessage: { label: 'iMessage', observations: ['ego', 'chat', 'full'], nativeView: null, files: null, importer: 'imessage' },
  discord: { label: 'Discord', observations: ['full', 'sample', 'ego', 'authored'], nativeView: 'full', files: 'DiscordChatExporter JSON, one file per channel', importer: 'discord' },
  reddit: { label: 'Reddit', observations: ['full', 'sample', 'ego', 'authored'], nativeView: 'full or sample', files: 'Pushshift / Arctic Shift NDJSON per subreddit (<name>_submissions.ndjson, <name>_comments.ndjson)', importer: 'reddit' },
  survey: { label: 'Survey', observations: ['full'], nativeView: 'full', files: 'Network Canvas CSV export (ego interviews, perceived networks) or a Google Forms roster CSV', importer: 'network-canvas or survey' },
};

export function listContexts() {
  return Object.entries(CONTEXTS).map(([id, C]) => ({
    id, label: C.label, description: C.description,
    media: C.media.map(m => ({ id: m, ...MEDIUM_INFO[m], native: !!WRITERS[m] && !!MEDIUM_INFO[m]?.files })),
    mediaIds: C.media.slice(),
    params: C.schema.map(p => ({ ...p })),
    defaults: { ...C.defaults },
    presets: Object.entries(C.presets).map(([pid, p]) => ({ id: pid, label: p.label, params: { ...(p.params || {}) } })),
    timespan: { ...C.timespanDefaults },
    observations: C.observations || ['full', 'ego', 'authored', 'chat', 'sample'],
    nativeMedia: C.media.filter(m => WRITERS[m]),
  }));
}

export function normalizeSpec(spec = {}) {
  const context = spec.context || 'workplace';
  const C = CONTEXTS[context];
  if (!C) throw new Error(`Unknown context "${context}". Known: ${Object.keys(CONTEXTS).join(', ')}`);
  const medium = spec.medium || C.media[0];
  if (!C.media.includes(medium)) throw new Error(`Medium "${medium}" does not fit context "${context}". Use one of: ${C.media.join(', ')}`);
  const output = spec.output === 'native' ? 'native' : 'dataset';
  if (output === 'native' && !WRITERS[medium]) throw new Error(`No native writer for ${medium}; use output: 'dataset'`);
  return {
    ...spec, context, medium, output,
    seed: spec.seed ?? 1,
    content: ['none', 'light', 'full'].includes(spec.content) ? spec.content : 'light',
    structure: spec.structure ?? spec.preset ?? null,
  };
}

export function generate(specIn) {
  const spec = normalizeSpec(specIn);
  const progress = typeof spec.onProgress === 'function' ? spec.onProgress : null;
  const report = (f, msg) => { if (progress) try { progress(f, msg); } catch { /* a UI callback must not break generation */ } };
  report(0, 'Building the social world');
  const C = CONTEXTS[spec.context];
  const root = new Rng(spec.seed);
  const span = normalizeTimespan(spec.timespan, C.timespanDefaults);
  const world = C.build(spec, root.fork('world'), span);
  labelPlantedGroups(world);
  plantDiffusion(world, spec, root.fork('diffusion'));
  world.topics ||= {};
  const rhythm = makeRhythm(world.rhythmKind || 'flat', span, root.fork('rhythm'));
  const content = makeContent(world, spec, root.fork('content'));
  const ident = makeIdentities(world, spec.medium, root);
  const forcedView = spec.output === 'native' ? NATIVE_VIEW[spec.medium]?.(spec) : null;
  const obs = normalizeObservation(spec, world, ident, root.fork('observe'), { forcedView });
  const acc = makeTruthAccumulator(world);
  report(0.15, `World: ${world.n} people, ${world.ties.count} true ties`);
  // The scenario (preset) is in the name itself, not only in the parenthesis,
  // so the header and export file names say which world this is (J14):
  // "Synthetic workplace, bridge-dependent (Slack, seed 1)".
  const name = spec.name || `Synthetic ${spec.context}, ${world.preset || 'default'} (${MEDIUM_INFO[spec.medium]?.label || spec.medium}, seed ${spec.seed})`;
  const native = spec.output === 'native';
  const hooks = {};
  const ds = makeDatasetSink({ world, medium: spec.medium, ident, obs, name, seed: spec.seed, hooks,
    allNodes: native ? nativeAllNodes(spec.medium, world) : undefined });

  const records = native ? [] : null;
  const ctx = makeCtx(world, {
    rng: root.fork('sim:' + spec.medium), rhythm, content,
    sink: native ? rec => { acc.add(rec); records.push(rec); } : (rec, c) => { acc.add(rec); ds.sink(rec, c); },
  });
  if (progress) {
    // The total is unknown in advance, so progress approaches 0.85 asymptotically.
    const inner = ctx.emit;
    ctx.emit = rec => { const id = inner(rec); if (ctx.count % 100000 === 0) report(0.15 + 0.7 * (1 - 1 / (1 + ctx.count / 1e6)), `Simulated ${ctx.count.toLocaleString('en-US')} interactions`); return id; };
  }
  SIMS[spec.medium](world, ctx, spec);
  report(0.85, `Simulated ${ctx.count} interactions`);

  let files;
  if (native) {
    records.sort((a, b) => a.t - b.t || a.id - b.id);
    report(0.88, 'Writing export files');
    // The writer reports values it draws (bot ids, invitation times, follow
    // lists) in `seen`; the dataset is then what the export can show (native.js).
    const seen = {};
    files = WRITERS[spec.medium]({ world, ctx, records, ident, obs, spec, rng: root.fork('writer'), native: seen });
    const view = nativeView(spec.medium, { world, ctx, records, ident, obs, spec, native: seen });
    Object.assign(hooks, view.hooks);
    for (const rec of view.records) ds.sink(rec, ctx);
  }
  report(0.93, 'Building the dataset');
  const dataset = ds.finish();
  // Display name for the ground-truth attribute (readers may ignore it).
  dataset.meta.attrLabels = { ...(dataset.meta.attrLabels || {}), [PLANTED_GROUP_ATTR]: PLANTED_GROUP_LABEL };
  const groundTruth = buildGroundTruth({ world, spec, ident, obs, ctx, acc, rhythm, keptEvents: ds.kept });
  if (files) groundTruth.files = files.map(f => ({ path: f.path, size: f.bytes.length }));
  report(1, 'Done');
  return files ? { dataset, groundTruth, files } : { dataset, groundTruth };
}

// The planted groups go on every person under one key, `planted_group`, so
// the analysis views can tell ground truth from detected communities and say
// so ("Planted group (ground truth)"; see PLANTED_GROUP_LABEL). A context's
// own key is dropped when it only ever existed to carry the planted group
// (online `community` read as "Community" next to the detected communities);
// keys a real export or HR file would also carry (department, company) stay.
export const PLANTED_GROUP_ATTR = 'planted_group';
export const PLANTED_GROUP_LABEL = 'Planted group (ground truth)';
const SYNTHETIC_GROUP_KEYS = new Set(['community', 'home_space', 'cluster', 'friend_group']);

function labelPlantedGroups(world) {
  const key = world.groupAttr;
  const names = world.groups.map(g => g.name);
  for (let i = 0; i < world.n; i++) {
    const a = world.people.attrs[i];
    if (!a) continue;
    // Membership decides; the context's own value only names people outside
    // every group (survey names beyond the roster).
    const v = world.group[i] >= 0 ? names[world.group[i]] : key ? a[key] : undefined;
    if (SYNTHETIC_GROUP_KEYS.has(key)) delete a[key];
    if (v !== undefined && v !== '') a[PLANTED_GROUP_ATTR] = v;
  }
  world.groupAttr = PLANTED_GROUP_ATTR;
}

// Planted diffusion: seed terms introduced by chosen people early in the span
// spread along true ties (see plantCascades). Seeds are well-connected,
// non-bot people who stay for the whole span.
function plantDiffusion(world, spec, rng) {
  if (spec.diffusion === false || world.context === 'survey' || world.n < 3) { world.diffusion = null; return; }
  // Default transmission chance keeps the expected number of onward
  // transmissions per adopter near 1.3: a cascade that spreads but does not
  // saturate, so reach varies and the tree is informative.
  let wsum = 0;
  for (let ti = 0; ti < world.ties.count; ti++) wsum += Math.min(4, world.ties.w[ti]);
  const meanW = wsum / world.n * (world.ties.directed ? 1 : 2);
  const p0 = Math.max(0.01, Math.min(0.3, 1.3 / Math.max(1, meanW)));
  const d = { terms: 2, p0, meanDelayDays: 4, ...(spec.diffusion || {}) };
  if (!(d.terms > 0)) { world.diffusion = null; return; }
  const k = Math.min(d.terms, SEED_TERMS.length);
  const terms = rng.sample(SEED_TERMS, k);
  const cand = [];
  for (let i = 0; i < world.n; i++) if (!world.isBot[i] && world.leftAt[i] === Infinity && i !== world.ego) cand.push([(world.ties.degree(i) + (world.ties.directed ? world.ties.degree(i, 'in') : 0)) * (world.prop ? world.prop[i] : 1), i]);
  cand.sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  const top = cand.slice(0, Math.max(k, Math.ceil(cand.length * 0.05))).map(c => c[1]);
  const seeds = d.seeds || rng.sample(top, k);
  const t0 = world.span.start + Math.round((d.startAt ?? 0.15) * (world.span.end - world.span.start));
  // A planted cascade should actually spread: redraw (up to 12 times) until it
  // reaches a minimum size, keeping the largest draw.
  const minReach = Math.min(8, Math.max(3, Math.ceil(world.n * 0.03)));
  let res = null;
  for (let attempt = 0; attempt < 12; attempt++) {
    const out = plantCascades(world, rng.fork('attempt' + attempt), { terms, seeds, t0, p0: d.p0, meanDelayDays: d.meanDelayDays, flow: world.ties.directed ? 'in' : 'out' });
    if (!res || Math.min(...out.cascades.map(c => c.adopters.length)) > Math.min(...res.cascades.map(c => c.adopters.length))) res = out;
    if (Math.min(...res.cascades.map(c => c.adopters.length)) >= minReach) break;
  }
  world.diffusion = { ...res, params: { p0: d.p0, meanDelayDays: d.meanDelayDays, t0, flow: world.ties.directed ? 'followed account to followers' : 'along ties' } };
}
