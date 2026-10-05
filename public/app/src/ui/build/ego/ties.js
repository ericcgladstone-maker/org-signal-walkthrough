// Ego builder step 5: who knows whom.
// First alters are sorted into contexts (everyone in a context is assumed to
// know each other), then exceptions are fixed by clicking pairs on a canvas
// or ticking them in an accessible pair list. Both edit the same overrides.

import { html, useState, useMemo } from '../../../../vendor/preact.js';
import { polygonHull } from '../../../../vendor/d3.js';
import * as E from '../../../builders/ego.js';
import { groupColor } from '../shared.js';

function ContextSorter({ s, update }) {
  const [name, setName] = useState('');
  const unused = E.CONTEXT_PRESETS.filter(p => !s.contexts.some(c => c.name.toLowerCase() === p.toLowerCase()));
  const placed = new Set(s.contexts.flatMap(c => c.members));
  const [msg, setMsg] = useState(null);
  // A new setting starts with the people whose answers place them in it.
  const add = n => {
    const pre = E.suggestedMembers(s, n).length;
    update(x => E.addContext(x, n));
    setMsg(pre ? `${n} starts with ${pre} ${pre === 1 ? 'person' : 'people'} whose answers say ${n}; untick anyone who does not belong.` : null);
  };
  return html`<div class="ob-stack">
    <p class="ob-note">Sort the people named into the settings they come from. People in the same setting are assumed to know each other; fix the exceptions below. A person can be in more than one setting.</p>
    <div class="ob-row">
      ${unused.map(p => html`<button type="button" class="btn btn--sm" onClick=${() => add(p)}>Add ${p}</button>`)}
      <form class="ob-row" onSubmit=${e => { e.preventDefault(); if (name.trim()) { add(name.trim()); setName(''); } }}>
        <label class="visually-hidden" for="ego-ctx-name">New setting name</label>
        <input id="ego-ctx-name" class="input input--sm" style="width:11rem" placeholder="Other setting" value=${name} onInput=${e => setName(e.target.value)} />
        <button type="submit" class="btn btn--sm" disabled=${!name.trim()}>Add</button>
      </form>
    </div>
    ${msg ? html`<p class="ob-note" role="status">${msg}</p>` : null}
    ${s.contexts.length ? html`<div class="table-wrap"><table class="tbl ego-ctx">
      <caption class="visually-hidden">Which setting each person belongs to</caption>
      <thead><tr><th scope="col">Person</th>
        ${s.contexts.map((c, i) => html`<th scope="col"><div class="ego-ctx-head">
          <span class="ego-ctx-line"><span class="ob-dot" style=${'background:' + groupColor(i)}></span>
          <input class="input input--sm ego-ctx-name" aria-label="Setting name" value=${c.name} onChange=${e => update(x => E.renameContext(x, c.id, e.target.value))} /></span>
          <button type="button" class="tlink tlink--quiet" aria-label=${'Delete the setting ' + c.name} onClick=${() => update(x => E.removeContext(x, c.id))}>Delete setting</button></div></th>`)}
      </tr></thead>
      <tbody>${s.alters.map(a => html`<tr key=${a.id}>
        <th scope="row">${a.label}${placed.has(a.id) ? '' : html` <span class="ob-note">unsorted</span>`}</th>
        ${s.contexts.map(c => html`<td><input type="checkbox" class="ego-cb" aria-label=${`${a.label} in ${c.name}`} checked=${c.members.includes(a.id)}
          onChange=${e => update(x => E.assignContext(x, a.id, c.id, e.target.checked))} /></td>`)}
      </tr>`)}</tbody>
    </table></div>` : html`<p class="ob-empty">No settings yet. Add Work, Family and so on above, or skip straight to the pairs.</p>`}
  </div>`;
}

const W = 640, H = 440, R = 150;

// Alters on one circle, ordered by their first context so each context sits
// on a contiguous arc and its hull stays compact.
function positions(s) {
  const first = a => { const i = s.contexts.findIndex(c => c.members.includes(a.id)); return i < 0 ? 1e9 : i; };
  const order = [...s.alters].sort((a, b) => first(a) - first(b));
  const n = order.length;
  const pos = new Map();
  order.forEach((a, i) => {
    const ang = -Math.PI / 2 + (2 * Math.PI * i) / Math.max(1, n);
    pos.set(a.id, { x: W / 2 + R * Math.cos(ang), y: H / 2 + R * Math.sin(ang), ang });
  });
  return pos;
}

function hullPath(pts, pad = 22) {
  const ring = [];
  for (const p of pts) for (let k = 0; k < 12; k++) {
    const a = (k / 12) * 2 * Math.PI;
    ring.push([p.x + pad * Math.cos(a), p.y + pad * Math.sin(a)]);
  }
  const h = polygonHull(ring);
  return h ? 'M' + h.map(p => p.map(v => v.toFixed(1)).join(',')).join('L') + 'Z' : '';
}

function TieCanvas({ s, update }) {
  const [pick, setPick] = useState(null);
  const pos = useMemo(() => positions(s), [s.alters, s.contexts]);
  const ties = E.tieList(s);
  const click = id => {
    if (pick === null) return setPick(id);
    if (pick === id) return setPick(null);
    update(x => E.toggleTie(x, pick, id));
    setPick(null);
  };
  const pickedLabel = pick && s.alters.find(a => a.id === pick)?.label;
  // Setting names sit outside the circle, pushed out from the center, and
  // never on top of one another (placeLabels).
  const hulls = s.contexts.map((c, i) => {
    const pts = c.members.map(m => pos.get(m)).filter(Boolean);
    if (!pts.length) return null;
    const cx = pts.reduce((t, p) => t + p.x, 0) / pts.length, cy = pts.reduce((t, p) => t + p.y, 0) / pts.length;
    const dx = cx - W / 2, dy = cy - H / 2, d = Math.hypot(dx, dy) || 1;
    const anchor = Math.abs(dx) < 20 ? 'middle' : dx > 0 ? 'start' : 'end';
    return { c, i, pts, x: W / 2 + (dx / d) * (R + 70), y: H / 2 + (dy / d) * (R + 62), anchor, w: c.name.length * 8.6 + 6 };
  }).filter(Boolean);
  const labelY = E.placeLabels(hulls, { lineH: 15, midY: H / 2 });
  return html`<div class="ob-stack" style="gap:.4rem">
    <p class="ob-note" aria-live="polite">${pickedLabel ? `${pickedLabel} selected. Click another person to add or remove their tie, or click ${pickedLabel} again to cancel.` : 'Click two people to add or remove the tie between them. Solid lines come from shared settings; accent lines are ties you added.'}</p>
    <svg class="ego-canvas" viewBox=${`0 0 ${W} ${H}`} role="group" aria-label="Who knows whom">
      ${hulls.map(h => html`<path key=${'h' + h.c.id} class="ego-hull" d=${hullPath(h.pts)} style=${`fill:${groupColor(h.i)};stroke:${groupColor(h.i)}`} />`)}
      ${hulls.map((h, k) => html`<text key=${'t' + h.c.id} class="ego-hull-label" x=${h.x} y=${labelY[k]} text-anchor=${h.anchor} style=${'fill:' + groupColor(h.i)}>${h.c.name}</text>`)}
      ${ties.filter(t => t.on).map(t => {
        const a = pos.get(t.a), b = pos.get(t.b);
        return html`<line key=${t.key} class=${'ego-tie' + (t.source === 'added' ? ' added' : '')} x1=${a.x} y1=${a.y} x2=${b.x} y2=${b.y} />`;
      })}
      ${s.alters.map(a => {
        const p = pos.get(a.id);
        const out = Math.cos(p.ang);
        return html`<g key=${a.id} class=${'ego-node' + (pick === a.id ? ' sel' : '')} transform=${`translate(${p.x},${p.y})`}
          role="button" tabindex="0" aria-pressed=${pick === a.id ? 'true' : 'false'} aria-label=${a.label}
          onClick=${() => click(a.id)} onKeyDown=${e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); click(a.id); } }}>
          <circle r="9" />
          <text x=${out >= 0 ? 14 : -14} y=${4 + Math.sin(p.ang) * 6} text-anchor=${out >= 0 ? 'start' : 'end'}>${a.label}</text>
        </g>`;
      })}
    </svg>
    ${s.contexts.length ? html`<ul class="ob-inline" aria-label="Settings">
      ${s.contexts.map((c, i) => html`<li><span class="ob-dot" style=${'background:' + groupColor(i)}></span>${c.name} (${c.members.length})</li>`)}
    </ul>` : null}
  </div>`;
}

function PairList({ s, update }) {
  const [q, setQ] = useState('');
  const [only, setOnly] = useState('all');
  const byId = new Map(s.alters.map(a => [a.id, a]));
  const ql = q.trim().toLowerCase();
  const rows = E.tieList(s).filter(p => {
    if (only === 'on' && !p.on) return false;
    if (only === 'exceptions' && (p.source === 'context' || p.source === 'none')) return false;
    if (!ql) return true;
    return byId.get(p.a).label.toLowerCase().includes(ql) || byId.get(p.b).label.toLowerCase().includes(ql);
  });
  const why = { context: 'shared setting', added: 'added by hand', removed: 'removed by hand', none: '' };
  const shown = rows.slice(0, 400);
  return html`<div class="ob-stack" style="gap:.5rem">
    <div class="ob-row">
      <div class="field" style="flex:1 1 12rem"><label class="field__label" for="ego-pair-q">Filter pairs by name</label>
        <input id="ego-pair-q" class="input" value=${q} onInput=${e => setQ(e.target.value)} /></div>
      <div class="field" style="flex:0 1 12rem"><label class="field__label" for="ego-pair-only">Show</label>
        <select id="ego-pair-only" class="select" value=${only} onChange=${e => setOnly(e.target.value)}>
          <option value="all">All pairs</option><option value="on">Ties only</option><option value="exceptions">Exceptions only</option>
        </select></div>
    </div>
    <ul class="ego-pairs" aria-label="Pairs of people">
      ${shown.map(p => html`<li key=${p.key}><label class="check">
        <input type="checkbox" checked=${p.on} onChange=${e => update(x => E.setTie(x, p.a, p.b, e.target.checked))} />
        <span>${byId.get(p.a).label} and ${byId.get(p.b).label} know each other</span></label>
        <span class="ob-note">${why[p.source]}</span></li>`)}
    </ul>
    ${rows.length > shown.length ? html`<p class="ob-note">Showing 400 of ${rows.length} pairs. Filter by name to find the rest.</p>` : null}
    ${!rows.length ? html`<p class="ob-note">No pairs match.</p>` : null}
  </div>`;
}

export function TiesStep({ s, update }) {
  if (s.alters.length < 2) return html`<p class="ob-empty">Name at least two people to record who knows whom.</p>`;
  const ties = E.tieList(s);
  const on = ties.filter(t => t.on).length;
  const exc = Object.keys(s.ties).length;
  return html`<div class="ob-stack">
    <div class="ob-section"><h3>Sort into settings</h3><${ContextSorter} s=${s} update=${update} /></div>
    <div class="ob-section">
      <h3>${s.contexts.length ? 'Fix the exceptions' : 'Pairs who know each other'}</h3>
      <p class="ob-note">${on} of ${ties.length} pairs know each other${s.contexts.length ? `; ${exc} ${exc === 1 ? 'pair differs' : 'pairs differ'} from what the settings imply` : ', each set by hand (no settings yet)'}.</p>
      <div class="ego-ties-grid">
        <${TieCanvas} s=${s} update=${update} />
        <${PairList} s=${s} update=${update} />
      </div>
    </div>
  </div>`;
}
