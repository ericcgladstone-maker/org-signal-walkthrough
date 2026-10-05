// Survey exports, per docs/formats/network-canvas-and-surveys.md.
//
//   ego-interview  Network Canvas Interviewer CSV + GraphML export
//                  (networkCanvasExport.zip): per session <caseId>_<sessionId>_ego.csv,
//                  _attributeList_Person.csv, _edgeList_knows.csv and <caseId>_<sessionId>.graphml.
//                  Column names follow the exporter source, which the spec trusts
//                  over the illustrative columns on Network Canvas's own docs page.
//                  Ego-alter tie data (closeness) lives on the alter row; the ego is
//                  not a node; alter-alter edges are the ego's perception.
//   perceived      the same layout, one session per informant: alters are the whole
//                  roster except the informant, edges are the informant's perceived
//                  ties among them, and ties involving the informant become an alter
//                  variable (`friend`), since NC stores ego-alter ties on the alter.
//   roster-matrix  a Google Forms response sheet: `Timestamp`, `Your name`, then one
//                  grid column per roster member `Who do you spend free time with? [Name]`.
// nodeID restarts at 1 per session, as the exporter resequences per file.

import { zip, u8, csv, xmlEscape } from './util.js';
import { pad, parts } from '../time.js';

const PROTOCOL = 'Friendship Networks Study';
const QUESTION = 'Who do you spend free time with?';

export function write({ world, ident, rng }) {
  const rec = world.recall;
  const r = rng.fork('survey');
  if (rec.variant === 'roster-matrix') return rosterForm(world, rec);
  const sessions = rec.variant === 'perceived'
    ? rec.perceived.reports.map(rep => perceivedSession(world, rep))
    : rec.respondents.filter(x => x.responded).map(resp => interviewSession(world, resp));
  const files = [];
  const exported = isoMs(world.span.end);
  for (const s of sessions) {
    const egoUuid = r.uuid(), sessionId = r.uuid();
    const caseId = ident.rosterId ? ident.rosterId[s.ego] : `P${pad(s.ego + 1, 3)}`;
    const prefix = `${caseId}_${sessionId}`.replace(/[^\w.-]/g, '_');
    const start = s.t, finish = s.t + (20 + r.int(30)) * 60000;
    const egoAttrs = world.people.attrs[s.ego];
    files.push({ path: `${prefix}_ego.csv`, bytes: u8(csv([
      ['networkCanvasEgoUUID', 'networkCanvasCaseID', 'networkCanvasSessionID', 'networkCanvasProtocolName', 'sessionStart', 'sessionFinish', 'sessionExported', 'APP_VERSION', 'COMMIT_HASH', 'name', 'gender', 'age'],
      [egoUuid, caseId, sessionId, PROTOCOL, isoMs(start), isoMs(finish), exported, '6.5.3', '2b5f0c1', world.people.label[s.ego], egoAttrs.gender ?? '', egoAttrs.age ?? ''],
    ])) });
    const alterUuid = new Map();
    const nodeId = new Map();
    const varCols = s.vars.map(v => v.key);
    const aRows = [['nodeID', 'networkCanvasEgoUUID', 'networkCanvasUUID', 'name', ...varCols]];
    s.alters.forEach((a, k) => {
      const u = r.uuid();
      alterUuid.set(a.person, u); nodeId.set(a.person, k + 1);
      aRows.push([k + 1, egoUuid, u, world.people.label[a.person], ...s.vars.map(v => fmt(a[v.key]))]);
    });
    files.push({ path: `${prefix}_attributeList_Person.csv`, bytes: u8(csv(aRows)) });
    const eRows = [['edgeID', 'from', 'to', 'networkCanvasEgoUUID', 'networkCanvasUUID', 'networkCanvasSourceUUID', 'networkCanvasTargetUUID']];
    const edgeUuids = [];
    s.edges.forEach(([x, y], k) => {
      const u = r.uuid(); edgeUuids.push(u);
      eRows.push([k + 1, nodeId.get(x), nodeId.get(y), egoUuid, u, alterUuid.get(x), alterUuid.get(y)]);
    });
    files.push({ path: `${prefix}_edgeList_knows.csv`, bytes: u8(csv(eRows)) });
    files.push({ path: `${prefix}.graphml`, bytes: u8(ncGraphml(world, s, { egoUuid, caseId, sessionId, start, finish, exported, alterUuid, nodeId, edgeUuids, r })) });
  }
  return [{ path: 'networkCanvasExport.zip', bytes: zip(files, world.span.end) }];
}

function interviewSession(world, resp) {
  return {
    ego: resp.person, t: resp.session?.t ?? world.span.start,
    alters: resp.named.map(x => ({ person: x.alter, closeness: x.closeness, in_roster: x.alter < world.rosterSize })),
    vars: [{ key: 'closeness', type: 'int' }, { key: 'in_roster', type: 'boolean' }],
    edges: (resp.alterTies || []).map(t => [t.a, t.b]),
  };
}

function perceivedSession(world, rep) {
  const N = world.rosterSize, k = rep.informant;
  const friends = new Set();
  const edges = [];
  for (const [a, b] of rep.ties) {
    if (a === k) friends.add(b); else if (b === k) friends.add(a); else edges.push([a, b]);
  }
  const alters = [];
  for (let i = 0; i < N; i++) if (i !== k) alters.push({ person: i, friend: friends.has(i) });
  return { ego: k, t: rep.session?.t ?? world.span.start, alters, vars: [{ key: 'friend', type: 'boolean' }], edges };
}

function ncGraphml(world, s, o) {
  const L = [];
  L.push('<?xml version="1.0" encoding="UTF-8"?>');
  L.push('<graphml xmlns="http://graphml.graphdrawing.org/xmlns" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:nc="http://schema.networkcanvas.com/xmlns" xsi:schemaLocation="http://graphml.graphdrawing.org/xmlns http://graphml.graphdrawing.org/xmlns/1.0/graphml.xsd">');
  L.push('  <key id="label" for="all" attr.name="label" attr.type="string"/>');
  L.push('  <key id="networkCanvasType" for="all" attr.name="networkCanvasType" attr.type="string"/>');
  L.push('  <key id="networkCanvasUUID" for="all" attr.name="networkCanvasUUID" attr.type="string"/>');
  L.push('  <key id="networkCanvasSourceUUID" for="edge" attr.name="networkCanvasSourceUUID" attr.type="string"/>');
  L.push('  <key id="networkCanvasTargetUUID" for="edge" attr.name="networkCanvasTargetUUID" attr.type="string"/>');
  // Variable keys use codebook variable UUIDs as ids and the variable name as attr.name.
  const egoNameKey = o.r.uuid();
  L.push(`  <key id="${egoNameKey}" for="graph" attr.name="name" attr.type="string"/>`);
  const varKeys = s.vars.map(v => ({ ...v, id: o.r.uuid() }));
  for (const v of varKeys) L.push(`  <key id="${v.id}" for="node" attr.name="${v.key}" attr.type="${v.type}"/>`);
  L.push(`  <graph edgedefault="undirected" nc:caseId="${xmlEscape(o.caseId)}" nc:sessionUUID="${o.sessionId}" nc:protocolName="${xmlEscape(PROTOCOL)}" nc:protocolUID="${o.r.uuid()}" nc:codebookHash="${o.r.hex(40)}" nc:sessionExportTime="${o.exported}" nc:sessionStartTime="${isoMs(o.start)}" nc:sessionFinishTime="${isoMs(o.finish)}">`);
  L.push(`    <data key="networkCanvasUUID">${o.egoUuid}</data>`);
  L.push(`    <data key="${egoNameKey}">${xmlEscape(world.people.label[s.ego])}</data>`);
  for (const a of s.alters) {
    let line = `    <node id="${o.nodeId.get(a.person)}"><data key="networkCanvasUUID">${o.alterUuid.get(a.person)}</data><data key="networkCanvasType">Person</data><data key="label">${xmlEscape(world.people.label[a.person])}</data>`;
    for (const v of varKeys) if (a[v.key] !== undefined) line += `<data key="${v.id}">${fmt(a[v.key])}</data>`;
    L.push(line + '</node>');
  }
  s.edges.forEach(([x, y], k) => {
    L.push(`    <edge id="${k + 1}" source="${o.nodeId.get(x)}" target="${o.nodeId.get(y)}"><data key="networkCanvasUUID">${o.edgeUuids[k]}</data><data key="networkCanvasType">knows</data><data key="networkCanvasSourceUUID">${o.alterUuid.get(x)}</data><data key="networkCanvasTargetUUID">${o.alterUuid.get(y)}</data></edge>`);
  });
  L.push('  </graph>');
  L.push('</graphml>');
  return L.join('\n') + '\n';
}

function rosterForm(world, rec) {
  const N = world.rosterSize;
  const header = ['Timestamp', 'Your name', ...Array.from({ length: N }, (_, i) => `${QUESTION} [${world.people.label[i]}]`)];
  const rows = [header];
  const resp = rec.respondents.filter(x => x.responded).slice().sort((a, b) => (a.session?.t ?? 0) - (b.session?.t ?? 0) || a.person - b.person);
  for (const x of resp) {
    const named = new Set(x.named.map(n => n.alter));
    const row = [formsTime(x.session?.t ?? world.span.start), world.people.label[x.person]];
    for (let i = 0; i < N; i++) row.push(i !== x.person && named.has(i) ? 'Yes' : '');
    rows.push(row);
  }
  return [{ path: 'Friendship survey (Responses).csv', bytes: u8(csv(rows)) }];
}

// Google Forms (US locale) timestamps: M/D/YYYY H:MM:SS, local wall clock, no zone.
function formsTime(t) { const p = parts(t, 0); return `${p.mo}/${p.d}/${p.y} ${p.h}:${pad(p.mi)}:${pad(p.s)}`; }
function isoMs(t) { return new Date(t).toISOString(); }
function fmt(v) { return v === true ? 'true' : v === false ? 'false' : v ?? ''; }
