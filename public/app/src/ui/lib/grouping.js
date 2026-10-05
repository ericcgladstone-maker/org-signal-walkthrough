// Group coloring shared by the network map, its legend and figure export,
// the People swatches and the Groups table.
//
// Groups arrive in their fixed order (by size over the whole dataset, then
// name; communities by number), so colors follow the group and never its
// rank in a filtered view. The first eight take the eight hues. Past eight
// the map switches to highlight mode: the rest share "Other groups", every
// group is named on the map and listed in the legend, and choosing one
// lights it up. People with no value are "Not recorded": their own darker
// gray and their own words, never folded into "Other groups".

import { categoricalScale, tokens } from './palette.js';
import { fmtInt } from './format.js';

export const HUES = 8;
// Legend and highlight keys for the two summary rows. The NUL prefix keeps
// them apart from any real value.
export const OTHER = '\u0000other';
export const MISSING = '\u0000missing';
export const NOT_RECORDED = 'Not recorded';

const isMissing = v => v == null || v === '';

export function otherGroupsLabel(groups, people) {
  return `Other groups (${fmtInt(groups)} ${groups === 1 ? 'group' : 'groups'}, ${fmtInt(people)} ${people === 1 ? 'person' : 'people'})`;
}

// groups: [{ value, label?, count, color? }] in fixed order. missing: people
// with no value. A group's own `color` (one of the eight hues) overrides the
// hue its position gives (communities matched to an attribute's hues,
// lib/coloring.js). Returns the color function, the legend rows and the
// highlight test.
export function groupColoring(groups, { missing = 0 } = {}) {
  const t = tokens();
  const base = categoricalScale(groups.map(g => String(g.value)));
  const fixed = new Map(groups.filter((g, i) => g.color && i < HUES).map(g => [String(g.value), g.color]));
  const sc = { color: v => fixed.get(String(v)) ?? base.color(v) };
  const index = new Map();
  const entries = groups.map((g, i) => {
    const value = String(g.value);
    index.set(value, i);
    return { value, label: g.label ?? value, count: g.count ?? 0, color: sc.color(value), other: i >= HUES };
  });
  const others = entries.filter(e => e.other);
  const otherPeople = others.reduce((a, e) => a + e.count, 0);
  const isOther = (v) => {
    if (isMissing(v)) return false;
    const i = index.get(String(v));
    return i == null || i >= HUES;
  };
  return {
    entries,
    colored: entries.filter(e => !e.other),
    others,
    many: others.length > 0, // highlight mode: names on the map, full legend
    otherCount: others.length,
    otherPeople,
    otherColor: t.other,
    otherLabel: otherGroupsLabel(others.length, otherPeople),
    missing,
    missingColor: t.missing,
    missingLabel: NOT_RECORDED,
    color: v => (isMissing(v) ? t.missing : sc.color(String(v))),
    isOther,
    // Does a person with value v belong to the chosen legend row?
    matches: (v, focus) => (focus === OTHER ? isOther(v) : focus === MISSING ? isMissing(v) : !isMissing(v) && String(v) === focus),
  };
}

// The smallest group that gets a name on the map: 1% of the people, at least 3.
export function groupLabelMin(n) {
  return Math.max(3, Math.round(n * 0.01));
}
