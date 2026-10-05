// What a rebuild changed, for the notice after "Apply and rebuild" (D9).
// Moved here from actions.js so the wording can be tested (N16, N17):
// - a rule switched off that removed no ties says the weights changed, not
//   "Removed ties from reactions";
// - a time range that did not really change (both ends open, including NaN
//   from a cleared date field) is not reported as "open to open";
// - people left without ties are not counted as communities.

export const RULE_LABEL = { reply: 'replies', mention: 'mentions', dm: 'direct messages', to: 'To recipients', cc: 'Cc recipients', bcc: 'Bcc recipients', adjacency: 'turn-taking', copresence: 'meetings and co-presence', declared: 'declared ties', repost: 'reposts', like: 'likes', follow: 'follows', reaction: 'reactions' };
const WEIGHTING = { count: 'count of evidence', log: 'log of count', binary: 'present or absent' };
const finite = t => (t != null && Number.isFinite(Number(t)) && t !== '' ? Number(t) : null);
const day = t => (finite(t) != null ? new Date(finite(t)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : null);
const n = x => Number(x || 0).toLocaleString('en-US');

// before / after: { edgeCount } when known, so a rule change that left the
// ties as they were is worded as a change of weights.
export function settingsChanges(a = {}, b = {}, { before = null, after = null } = {}) {
  const out = [];
  const sameTies = before && after && before.edgeCount === after.edgeCount && before.n === after.n;
  for (const r of new Set([...Object.keys(a.rules || {}), ...Object.keys(b.rules || {})])) {
    const x = a.rules?.[r] || {}, y = b.rules?.[r] || {};
    const name = RULE_LABEL[r] || r;
    if (!!x.on !== !!y.on) {
      if (sameTies) out.push(`${y.on ? 'Now counting' : 'No longer counting'} ${name} as evidence: the same ties, with ${y.on ? 'more' : 'less'} weight`);
      else out.push(`${y.on ? 'Added' : 'Removed'} ties from ${name}`);
    } else if (y.on && (x.weight ?? 1) !== (y.weight ?? 1)) out.push(`Weight for ${name}: ${x.weight ?? 1} to ${y.weight ?? 1}`);
  }
  if (!!a.directed !== !!b.directed) out.push(`Direction: ${b.directed ? 'directed' : 'undirected'}`);
  if ((a.weighting || 'count') !== (b.weighting || 'count')) out.push(`Tie weight: ${WEIGHTING[a.weighting || 'count']} to ${WEIGHTING[b.weighting || 'count']}`);
  if ((a.minWeight ?? 0) !== (b.minWeight ?? 0)) out.push(`Minimum tie weight: ${a.minWeight ?? 0} to ${b.minWeight ?? 0}`);
  if ((a.maxRecipients ?? 0) !== (b.maxRecipients ?? 0)) out.push(`Broadcast cutoff: ${a.maxRecipients || 'none'} to ${b.maxRecipients || 'none'}`);
  const s0 = finite(a.time?.start), s1 = finite(b.time?.start), e0 = finite(a.time?.end), e1 = finite(b.time?.end);
  if (s0 !== s1 || e0 !== e1) {
    if (s1 == null && e1 == null) out.push('Time range: all dates');
    else out.push(`Time range: ${s1 == null ? 'from the start' : `from ${day(s1)}`} ${e1 == null ? 'to the end' : `until ${day(e1)}`}`);
  }
  if (JSON.stringify(a.visibility || null) !== JSON.stringify(b.visibility || null)) out.push('Visibility layers changed');
  if (JSON.stringify(a.media || null) !== JSON.stringify(b.media || null)) out.push('Media changed');
  if (!!a.excludeBots !== !!b.excludeBots) out.push(b.excludeBots ? 'Bots left out' : 'Bots included');
  if ((a.includeIsolates !== false) !== (b.includeIsolates !== false)) out.push(b.includeIsolates !== false ? 'People with no ties kept' : 'People with no ties left out');
  return out;
}

// Communities of two or more people, and people on their own (an isolate is
// a "community" of one to Louvain, not a group anyone would report).
export function communityCounts(c) {
  if (!c) return null;
  const sizes = c.sizes || [];
  const groups = sizes.length ? sizes.filter(s => s > 1).length : (c.nontrivial ?? c.count);
  const alone = sizes.length ? sizes.filter(s => s === 1).length : 0;
  return { groups, alone };
}

// "6 communities, plus 1 person with no ties" (N17): isolates are not
// counted as communities anywhere (Network, Groups, the appendix).
export function communityWords(c) {
  const k = communityCounts(c);
  if (!k) return '';
  return `${k.groups.toLocaleString('en-US')} ${k.groups === 1 ? 'community' : 'communities'}${k.alone ? `, plus ${k.alone.toLocaleString('en-US')} ${k.alone === 1 ? 'person' : 'people'} with no ties` : ''}`;
}

// Before/after summary of a rebuild. Counts people whose community number
// changed (after overlap matching), by dataset node.
export function rebuildSummary(before, after) {
  const lines = [];
  const was = (x, y) => (x === y ? '' : ` (was ${n(x)})`);
  lines.push(`${n(after.n)} people${was(before.n, after.n)}, ${n(after.edgeCount)} ties${was(before.edgeCount, after.edgeCount)}`);
  if (after.communities) {
    let moved = 0;
    if (before.communities?.membership && before.nodeIds) {
      const prev = new Map();
      for (let v = 0; v < before.communities.membership.length; v++) prev.set(before.nodeIds[v], before.communities.membership[v]);
      for (let v = 0; v < after.communities.membership.length; v++) {
        const p = prev.get(after.nodeIds[v]);
        if (p != null && p !== after.communities.membership[v]) moved++;
      }
    }
    const a = communityCounts(after.communities), b = communityCounts(before.communities);
    const alone = a.alone ? `, plus ${n(a.alone)} ${a.alone === 1 ? 'person' : 'people'} with no ties` : '';
    lines.push(`${n(a.groups)} ${a.groups === 1 ? 'community' : 'communities'}${b ? was(b.groups, a.groups) : ''}${alone}; ${moved ? `${n(moved)} ${moved === 1 ? 'person' : 'people'} changed community` : 'nobody changed community'}`);
  }
  const changes = settingsChanges(before.settings, after.settings, { before, after });
  if ((before.settings?.weighting || 'count') !== (after.settings?.weighting || 'count')) {
    changes.push('Betweenness and closeness ignore tie weights, so the weight setting does not change them; their weighted versions and strength do.');
  }
  return { lines, changes };
}
