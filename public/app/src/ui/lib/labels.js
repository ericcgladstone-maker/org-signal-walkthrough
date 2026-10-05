// Geometry for the network map's labels and layout, kept free of the DOM
// and of sigma so it can be tested in Node.

// Rotate a force layout so its long axis runs along the canvas's long side.
// Force layouts have no meaningful orientation, and sigma fits the bounding
// box preserving aspect, so an unrotated layout used under half of a wide
// canvas. Returns rotated copies.
export function orientLayout(x, y, wide) {
  const n = x.length;
  if (n < 3) return { x, y };
  let mx = 0, my = 0;
  for (let i = 0; i < n; i++) { mx += x[i]; my += y[i]; }
  mx /= n; my /= n;
  let sxx = 0, syy = 0, sxy = 0;
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
  const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy); // angle of the principal axis
  const rot = (wide ? 0 : Math.PI / 2) - theta;
  const c = Math.cos(rot), s = Math.sin(rot);
  const X = new Float32Array(n), Y = new Float32Array(n);
  for (let i = 0; i < n; i++) { const dx = x[i] - mx, dy = y[i] - my; X[i] = dx * c - dy * s; Y[i] = dx * s + dy * c; }
  return { x: X, y: Y };
}

// How many labels to place: everyone in a small network; otherwise the 8
// largest (4 on a phone), more as the reader zooms in, and a dozen more for
// the neighbors of a selection.
export function labelBudget({ n, width, ratio, focus }) {
  if (n <= 30) return Infinity;
  const base = width < 600 ? 4 : 8;
  const zoom = Math.min(6, Math.max(1, 1 / (ratio || 1)));
  return Math.round(base * zoom) + (focus ? 12 : 0);
}

export function overlaps(a, list, pad = 2) {
  for (const b of list) if (a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y) return true;
  return false;
}

// Where to name each group on the map: not the mean of all its members (a
// group spread over the map would be named in the middle of someone else's
// cluster) but the mean of its members in the densest 3x3 block of a grid
// laid over the layout, where most of the group actually sits. keyOf(i)
// gives node i's group ('' or null for none).
//
// A group can also sit in two or more separate places (a division whose
// departments each form their own cluster), and one name would leave the
// rest unnamed. So each group is split into clusters (groupClusters), and
// every substantial cluster gets its own anchor at its own densest block.
//
// Returns [{ key, x, y, n, m, part }]: n is the whole group's size, m the
// cluster's, part 0 the group's main anchor (its largest substantial
// cluster, or the whole group when it has only one) and 1.. the further
// clusters. Main anchors come first, largest group first, then the further
// ones, largest cluster first, so a second name never takes the place of
// another group's first.
export function groupAnchors(x, y, keyOf, { grid = 24 } = {}) {
  const n = x.length;
  if (!n) return [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < n; i++) { if (x[i] < x0) x0 = x[i]; if (x[i] > x1) x1 = x[i]; if (y[i] < y0) y0 = y[i]; if (y[i] > y1) y1 = y[i]; }
  const sx = (x1 - x0) / grid || 1, sy = (y1 - y0) / grid || 1;
  const cellOf = i => Math.min(grid - 1, Math.floor((x[i] - x0) / sx)) * grid + Math.min(grid - 1, Math.floor((y[i] - y0) / sy));
  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const k = keyOf(i);
    if (k == null || k === '') continue;
    let g = groups.get(k);
    if (!g) groups.set(k, g = []);
    g.push(i);
  }
  // Mean position of the members in the densest 3x3 block of cells.
  const anchor = (members) => {
    const cells = new Map();
    for (const i of members) { const c = cellOf(i); cells.set(c, (cells.get(c) || 0) + 1); }
    let top = -1, at = 0;
    for (const c of cells.keys()) {
      const cx = Math.floor(c / grid), cy = c % grid;
      let s = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        const X = cx + dx, Y = cy + dy;
        if (X >= 0 && Y >= 0 && X < grid && Y < grid) s += cells.get(X * grid + Y) || 0;
      }
      if (s > top || (s === top && c < at)) { top = s; at = c; }
    }
    const bx = Math.floor(at / grid), by = at % grid;
    let ax = 0, ay = 0, m = 0;
    for (const i of members) {
      const c = cellOf(i);
      if (Math.abs(Math.floor(c / grid) - bx) <= 1 && Math.abs((c % grid) - by) <= 1) { ax += x[i]; ay += y[i]; m++; }
    }
    return { x: ax / m, y: ay / m };
  };
  // Two cells of the grid: people closer than this are in one cluster.
  const eps = 2 * Math.max(sx, sy);
  const main = [], more = [];
  for (const [key, members] of groups) {
    const parts = groupClusters(x, y, members, eps).filter(c => c.length >= clusterMin(members.length));
    if (parts.length < 2) { main.push({ key, ...anchor(members), n: members.length, m: members.length, part: 0 }); continue; }
    parts.forEach((c, j) => (j ? more : main).push({ key, ...anchor(c), n: members.length, m: c.length, part: j }));
  }
  const byKey = (a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  main.sort((a, b) => b.n - a.n || byKey(a, b));
  more.sort((a, b) => b.m - a.m || byKey(a, b) || a.part - b.part);
  return main.concat(more);
}

// The smallest cluster of a group that gets its own name: a quarter of the
// group, at least 3 people, so stragglers and a small group's loose ends
// never add a name.
export function clusterMin(groupSize) {
  return Math.max(3, Math.ceil(groupSize * 0.25));
}

// Split members (node indices) into clusters by distance in layout space:
// single linkage, two people closer than eps are in the same cluster.
// Points are bucketed in eps-sized cells so only neighboring cells are
// compared. Returns arrays of node indices, largest first (ties by the node
// index of their first member).
export function groupClusters(x, y, members, eps) {
  const m = members.length;
  if (m < 2 || !(eps > 0)) return m ? [members.slice()] : [];
  const parent = Int32Array.from({ length: m }, (_, i) => i);
  const find = a => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  const cells = new Map();
  const cx = Math.floor, e2 = eps * eps;
  for (let a = 0; a < m; a++) {
    const i = members[a];
    const X = cx(x[i] / eps), Y = cx(y[i] / eps);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const list = cells.get(`${X + dx},${Y + dy}`);
      if (!list) continue;
      for (const b of list) {
        const j = members[b], ddx = x[i] - x[j], ddy = y[i] - y[j];
        if (ddx * ddx + ddy * ddy <= e2) { const ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
      }
    }
    const k = `${X},${Y}`;
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(a);
  }
  const out = new Map();
  for (let a = 0; a < m; a++) { const r = find(a); if (!out.has(r)) out.set(r, []); out.get(r).push(members[a]); }
  return [...out.values()].sort((p, q) => q.length - p.length || p[0] - q[0]);
}

// Small or hand-drawn maps (L5): every person keeps their name, so a group's
// name (or community number) goes on the edge of the group, not on a member.
// members: [{ x, y, r }] in viewport pixels for one group. Returns the
// candidate spots for a w x h label in order of preference: centered above
// the group's top member, below its bottom member, left of its leftmost and
// right of its rightmost. The caller takes the first that fits.
export function hullEdgeSpots(members, w, h, gap = 6) {
  if (!members.length) return [];
  let top = members[0], bottom = members[0], left = members[0], right = members[0];
  let cx = 0, cy = 0;
  for (const m of members) {
    cx += m.x; cy += m.y;
    if (m.y - m.r < top.y - top.r) top = m;
    if (m.y + m.r > bottom.y + bottom.r) bottom = m;
    if (m.x - m.r < left.x - left.r) left = m;
    if (m.x + m.r > right.x + right.r) right = m;
  }
  cx /= members.length; cy /= members.length;
  return [
    { x: cx - w / 2, y: top.y - top.r - gap - h, w, h },
    { x: cx - w / 2, y: bottom.y + bottom.r + gap, w, h },
    { x: left.x - left.r - gap - w, y: cy - h / 2, w, h },
    { x: right.x + right.r + gap, y: cy - h / 2, w, h },
  ];
}

// When people's names win over group names: the map labels everyone (30 or
// fewer people) or the layout is as drawn.
export function namesFirst(n, drawn) {
  return !!drawn || n <= 30;
}
