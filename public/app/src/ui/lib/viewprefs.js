// Choices that outlive one view or one dataset (not reloads).
//
// People keeps its sort and the measure columns a reader added when the next
// network is analyzed (M11, J15): a student who added a column for path A-F
// expects it for the star too. Network's "Who stands out" asks People to open
// sorted by a measure.

const people = { sort: null, addedMeasures: new Set(), removedMeasures: new Set(), pending: null };

export function requestPeopleSort(metric) { people.pending = { key: `m:${metric}`, dir: 'desc' }; }

// The sort People should open with: a pending request from another view,
// else the reader's last sort if this dataset has that column.
export function peopleSort(has) {
  const p = people.pending;
  people.pending = null;
  if (p && has(p.key)) { people.sort = p; return p; }
  if (people.sort && has(people.sort.key)) return people.sort;
  return null;
}
export function rememberPeopleSort(sort) { people.sort = sort; }

// Measure columns the reader turned on or off, carried to the next network.
export function rememberColumn(key, on) {
  if (!key.startsWith('m:')) return;
  if (on) { people.addedMeasures.add(key); people.removedMeasures.delete(key); }
  else { people.removedMeasures.add(key); people.addedMeasures.delete(key); }
}
export function applyColumnChoices(cols, available) {
  const out = new Set(cols);
  for (const k of people.addedMeasures) if (available.has(k)) out.add(k);
  for (const k of people.removedMeasures) out.delete(k);
  return out;
}
