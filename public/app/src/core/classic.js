// Classic network datasets: a small library of published, teachable networks
// (Zachary's karate club, Padgett's Florentine families, ...) shipped as
// static files under data/classic/. tools/datasets/build.mjs makes them from
// the original distributions; docs/datasets.md records every source, licence
// and conversion choice.
//
//   listClassic({ base, pending })  -> manifest entries (data/classic/index.json)
//   loadClassic(id, { base, pending }) -> Dataset, with meta.example (the card:
//                                      title, lookFor, citation, known answers)
//   loadClassicPerceived(id, relation, { base, pending }) -> a perceived-network
//                                      study (src/builders/perceived.js model)
//   classicExample(entry)           -> the meta.example object for an entry
//
// Each entry has distribution 'bundled' (shipped) or 'pending' (built, but not
// shipped until its redistribution terms are settled; its file lives in
// data/classic-pending/, which tools/stage.sh leaves out). Pending entries
// load only with { pending: true }, which the app sets from the ?classic=pending
// address flag and the tests set directly.
//
// Runs in the browser (fetch relative to this module) and in Node (reads the
// files; Node's fetch has no file: URLs). Large files are gzip, read with
// DecompressionStream, available in both.

import { fromJSON } from './model.js';

const DEFAULT_BASE = new URL('../../data/classic/', import.meta.url);

async function readBytes(url) {
  if (url.protocol === 'file:') {
    const { readFile } = await import('node:fs/promises');
    return new Uint8Array(await readFile(url));
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url.pathname.split('/').pop()} (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

async function readText(url) {
  let bytes = await readBytes(url);
  // gzip magic number: some servers send .gz files already decoded
  // (Content-Encoding), others as is; decode only what is still compressed.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  return new TextDecoder().decode(bytes);
}

const baseURL = base => (base ? new URL(base, typeof location !== 'undefined' ? location.href : undefined) : DEFAULT_BASE);

let cache = null;
async function manifest(base) {
  const key = String(baseURL(base));
  if (cache?.key === key) return cache.value;
  const value = JSON.parse(await readText(new URL('index.json', baseURL(base))));
  cache = { key, value };
  return value;
}

// The entry as the app should use it: a bundled entry that has a pending,
// fuller version (Florentine: business ties and attributes) becomes that
// version when pending datasets are allowed.
function effective(entry, pending) {
  if (pending && entry.pendingVersion) return { ...entry.pendingVersion, bundledVersion: { file: entry.file, bytes: entry.bytes } };
  return entry;
}

export async function listClassic({ base, pending = false } = {}) {
  const m = await manifest(base);
  return m.datasets.map(e => ({ ...effective(e, pending), loadable: e.distribution === 'bundled' || pending }));
}

export async function classicEntry(id, opts = {}) {
  return (await listClassic(opts)).find(e => e.id === id) || null;
}

// The card worked examples carry (Network's "Who stands out" reads
// title and lookFor); the rest is for the library's own card.
export function classicExample(entry) {
  return {
    classic: entry.id,
    title: entry.title,
    lookFor: entry.lookFor || [],
    description: entry.description,
    findings: entry.findings,
    knownAnswers: entry.knownAnswers || [],
    assignment: entry.assignment || null,
    citation: entry.citation,
    sourceUrls: entry.sourceUrls || [],
    license: entry.license,
    ethics: entry.ethics || null,
    distribution: entry.distribution,
  };
}

// What the nodes are, where "people" would be wrong (Network's header line).
const NOUNS = { dolphins: ['dolphin', 'dolphins'], florentine: ['family', 'families'], lesmis: ['character', 'characters'] };

export async function loadClassic(id, { base, pending = false } = {}) {
  const entry = await classicEntry(id, { base, pending });
  if (!entry) throw new Error(`No classic dataset "${id}".`);
  if (!entry.loadable) throw new Error(`${entry.title} is not included in this build: its redistribution terms are not settled.`);
  const ds = fromJSON(await readText(new URL(entry.file, baseURL(base))));
  ds.meta = { ...ds.meta, name: entry.title, example: classicExample(entry), ...(NOUNS[entry.id] && { nodeNoun: NOUNS[entry.id] }) };
  return ds;
}

export async function loadClassicPerceived(id, relation, { base, pending = false } = {}) {
  const entry = await classicEntry(id, { base, pending });
  if (!entry?.perceived) throw new Error(`${entry?.title || id} has no perceived networks.`);
  if (!entry.loadable) throw new Error(`${entry.title} is not included in this build.`);
  const all = JSON.parse(await readText(new URL(entry.perceived.file, baseURL(base))));
  if (!all[relation]) throw new Error(`No perceived "${relation}" network in ${entry.title}.`);
  return all[relation];
}

// Size for people: "8 KB", "0.6 MB".
export function classicSize(bytes) {
  return bytes >= 5e5 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
