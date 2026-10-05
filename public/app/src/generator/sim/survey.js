// Survey answers and plain network files as declared-tie records.

import { HOUR, DAY } from '../time.js';

export function simSurvey(world, ctx) {
  const { r } = ctx;
  const rec = world.recall;
  const { span } = world;
  const sessionTime = () => span.start + Math.floor(r.next() * Math.max(1, (span.end - span.start) / DAY)) * DAY + Math.round((9 + r.next() * 7) * HOUR);
  if (rec.variant === 'perceived') {
    for (const rep of rec.perceived.reports) {
      const sp = ctx.addSpace({ key: 'perceived-' + rep.informant, name: `Perceived network: ${world.people.label[rep.informant]}`, kind: 'survey', visibility: 'private', members: [rep.informant], informant: rep.informant });
      const t = sessionTime();
      rep.session = { t, space: sp };
      for (const [a, b] of rep.ties) ctx.emit({ kind: 'declared', t, actor: a, to: [b], space: sp, weight: 1, meta: { perceivedBy: rep.informant } });
    }
    return;
  }
  const roster = rec.variant === 'roster-matrix' ? ctx.addSpace({ key: 'roster', name: 'Roster survey', kind: 'survey', visibility: 'private', members: Array.from({ length: world.rosterSize }, (_, i) => i) }) : -1;
  for (const resp of rec.respondents) {
    if (!resp.responded) continue;
    const t = sessionTime();
    const sp = roster >= 0 ? roster : ctx.addSpace({ key: 'interview-' + resp.person, name: `Interview: ${world.people.label[resp.person]}`, kind: 'survey', visibility: 'private', members: [resp.person, ...resp.named.map(x => x.alter)], respondent: resp.person });
    resp.session = { t, space: sp };
    for (const x of resp.named) ctx.emit({ kind: 'declared', t, actor: resp.person, to: [x.alter], space: sp, weight: x.closeness, meta: { closeness: x.closeness } });
    if (resp.alterTies) for (const at of resp.alterTies) ctx.emit({ kind: 'declared', t, actor: at.a, to: [at.b], space: sp, weight: 1, meta: { perceivedBy: resp.person } });
  }
}

export function simNetwork(world, ctx) {
  const { ties, span } = world;
  const sp = ctx.addSpace({ key: 'network', name: 'Network file', kind: 'network', visibility: 'unknown', members: [] });
  for (let ti = 0; ti < ties.count; ti++) {
    const f = ties.from[ti];
    if (f >= span.end) continue;
    if (ties.until[ti] <= span.start) continue;
    ctx.emit({ kind: 'declared', t: Number.isFinite(f) ? Math.max(f, -8.64e15) : span.start, actor: ties.a[ti], to: [ties.b[ti]], space: sp, weight: ties.w[ti], meta: { tieKind: ties.kindOf(ti), until: ties.until[ti] } });
  }
}
