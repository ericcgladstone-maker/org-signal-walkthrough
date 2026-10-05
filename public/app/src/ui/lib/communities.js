// The community color scale the network map and the People table share.
//
// Community numbers come from the shell (src/ui/actions.js orderCommunities:
// by size on first load, matched by overlap after a rebuild), and colors
// follow the number, so a community that survives a rebuild keeps its color.

import { categoricalScale } from './palette.js';

// Hues on the map: all eight slots stay apart under every color-vision
// deficiency for every pair, so any two communities may sit side by side;
// the rest share "Other groups" and are told apart by their number at the
// cluster.
export const MAP_HUES = 8;

export function communityScale(communities) {
  if (!communities) return null;
  const k = communities.count ?? 0;
  return categoricalScale(Array.from({ length: k }, (_, i) => String(i)), { hues: MAP_HUES });
}

// A person's community number (1-based), or null for someone on their own:
// Louvain gives an isolate a "community" of one, which no view counts as a
// community (communityWords, N17), so it is not shown as one either.
export const NO_COMMUNITY = 'No community (no ties)';
export function communitySize(communities, c) {
  return communities?.sizes?.[c] ?? (communities?.membership || []).filter(m => m === c).length;
}
export function communityNumber(communities, v) {
  const c = communities?.membership?.[v];
  if (c == null || c < 0) return null;
  return communitySize(communities, c) > 1 ? c + 1 : null;
}
export function communityLabel(communities, v) {
  const n = communityNumber(communities, v);
  return n == null ? NO_COMMUNITY : `Community ${n}`;
}
