// Snapping for the draw editor: grid snap and smart guides.
//
// All values are world coordinates (the drawing's own units). The editor
// converts its screen-pixel threshold to world units (threshold / zoom) so
// guides feel the same at every zoom level. Pure functions; tested in Node.

export function snapToGrid(v, size) {
  if (!(size > 0)) return v;
  return Math.round(v / size) * size;
}

export function snapPointToGrid(p, size) {
  return { x: snapToGrid(p.x, size), y: snapToGrid(p.y, size) };
}

// Smart guides for a point being dragged, against the other nodes.
//   - centre alignment: snap x to another node's x (vertical guide) and/or y
//     to another node's y (horizontal guide) when within threshold;
//   - equal spacing: when the point sits on a row (or column) with other
//     nodes, offer the position that repeats the gap between its two nearest
//     neighbours on that row, so A-B-C come out evenly spaced.
// Returns { x, y, guides } where x/y are the snapped values (or the input
// when nothing snapped) and guides are line segments to draw:
//   { kind: 'align'|'spacing', axis: 'x'|'y', at, from, to }
// For axis 'x' the guide is a vertical line x=at from y=from to y=to.
export function findGuides(p, others, threshold = 6) {
  let bestX = null, bestY = null;
  for (const o of others) {
    const dx = Math.abs(o.x - p.x), dy = Math.abs(o.y - p.y);
    if (dx <= threshold && (!bestX || dx < bestX.d)) bestX = { d: dx, v: o.x };
    if (dy <= threshold && (!bestY || dy < bestY.d)) bestY = { d: dy, v: o.y };
  }
  let x = bestX ? bestX.v : p.x;
  let y = bestY ? bestY.v : p.y;
  const guides = [];
  let spacingX = null, spacingY = null;
  if (!bestX) spacingX = spacing(p, others, 'x', 'y', threshold, y);
  if (spacingX) x = spacingX.v;
  if (!bestY) spacingY = spacing(p, others, 'y', 'x', threshold, x);
  if (spacingY) y = spacingY.v;

  if (bestX) {
    const col = others.filter(o => Math.abs(o.x - x) < 1e-9);
    const ys = [...col.map(o => o.y), y];
    guides.push({ kind: 'align', axis: 'x', at: x, from: Math.min(...ys), to: Math.max(...ys) });
  }
  if (bestY) {
    const row = others.filter(o => Math.abs(o.y - y) < 1e-9);
    const xs = [...row.map(o => o.x), x];
    guides.push({ kind: 'align', axis: 'y', at: y, from: Math.min(...xs), to: Math.max(...xs) });
  }
  if (spacingX) guides.push({ kind: 'spacing', axis: 'y', at: y, from: spacingX.from, to: spacingX.to, gap: spacingX.gap });
  if (spacingY) guides.push({ kind: 'spacing', axis: 'x', at: x, from: spacingY.from, to: spacingY.to, gap: spacingY.gap });
  return { x, y, guides };
}

// Equal-spacing candidate along `main` axis for nodes on the same row
// (within threshold on the `cross` axis). Considers extending the nearest
// pair on either side, and the midpoint between two neighbours.
function spacing(p, others, main, cross, threshold, crossVal) {
  const row = others.filter(o => Math.abs(o[cross] - crossVal) <= threshold).map(o => o[main]).sort((a, b) => a - b);
  if (row.length < 2) return null;
  const v = p[main];
  const cands = [];
  const below = row.filter(r => r < v), above = row.filter(r => r > v);
  if (below.length >= 2) { const a = below[below.length - 2], b = below[below.length - 1]; cands.push({ v: b + (b - a), from: a, gap: b - a }); }
  if (above.length >= 2) { const a = above[0], b = above[1]; cands.push({ v: a - (b - a), to: b, gap: b - a }); }
  if (below.length && above.length) { const a = below[below.length - 1], b = above[0]; cands.push({ v: (a + b) / 2, from: a, to: b, gap: (b - a) / 2 }); }
  let best = null;
  for (const c of cands) {
    const d = Math.abs(c.v - v);
    if (d <= threshold && c.gap > threshold && (!best || d < best.d)) best = { ...c, d };
  }
  if (!best) return null;
  return { v: best.v, from: best.from ?? best.v, to: best.to ?? best.v, gap: best.gap };
}

// Combined snapping used while dragging or placing: guides win over the grid
// on the axis they snap; the other axis falls back to the grid when on.
export function snapPoint(p, others, { grid = false, gridSize = 20, guides = true, threshold = 6 } = {}) {
  let out = { x: p.x, y: p.y, guides: [] };
  if (guides && others.length) out = findGuides(p, others, threshold);
  if (grid) {
    const gx = out.guides.some(g => g.axis === 'x' && g.kind === 'align') || out.guides.some(g => g.kind === 'spacing' && g.axis === 'y');
    const gy = out.guides.some(g => g.axis === 'y' && g.kind === 'align') || out.guides.some(g => g.kind === 'spacing' && g.axis === 'x');
    if (!gx) out.x = snapToGrid(out.x, gridSize);
    if (!gy) out.y = snapToGrid(out.y, gridSize);
  }
  return out;
}
