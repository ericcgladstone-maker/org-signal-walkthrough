// Virtualised table: only the visible rows are in the DOM, so 5,000+ rows
// scroll smoothly. Columns are CSS grid tracks; the header is sticky inside
// the scroll box, which also scrolls horizontally on narrow screens so the
// page itself never does. Keyboard: the body is focusable; Up/Down/PageUp/
// PageDown/Home/End move the focused row, Enter activates it; the focused
// row is tinted while the table has focus so the cursor is visible.
//
// Columns: { key, title, width, min, num, name, sortable, header, info }.
// `title` (or `header`, plain content) goes inside the sort button; `info`
// (for example a MetricInfo) sits beside it, never inside it, so the two
// controls stay separate buttons.

import { html, useState, useRef, useEffect, useLayoutEffect } from '../../../vendor/preact.js';
import { Icon } from './common.js';

export function VirtualTable({ columns, rows, rowKey, cell, onActivate, selected = new Set(), sort, onSort, label, rowHeight = 36, empty = 'No rows' }) {
  const box = useRef(null);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(480);
  const [focus, setFocus] = useState(0);
  const [hasFocus, setHasFocus] = useState(false);
  const [edge, setEdge] = useState({ left: false, right: false });
  const checkEdge = () => {
    const el = box.current; if (!el) return;
    const left = el.scrollLeft > 2, right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    if (left !== edge.left || right !== edge.right) setEdge({ left, right });
  };
  useEffect(checkEdge);
  useLayoutEffect(() => {
    if (!box.current) return;
    let raf = 0;
    const ro = new ResizeObserver(([e]) => { const h = e.contentRect.height; cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setHeight(p => (p === h ? p : h))); });
    ro.observe(box.current);
    return () => { cancelAnimationFrame(raf); ro.disconnect(); };
  }, []);
  useEffect(() => { if (focus >= rows.length) setFocus(Math.max(0, rows.length - 1)); }, [rows.length]);
  const template = columns.map(c => c.width || 'minmax(6rem,1fr)').join(' ');
  const minWidth = columns.reduce((s, c) => s + (c.min || 96), 0);
  const headH = 44;
  const overscan = 8;
  const start = Math.max(0, Math.floor((top - headH) / rowHeight) - overscan);
  const end = Math.min(rows.length, Math.ceil((top + height) / rowHeight) + overscan);
  const scrollTo = (i) => {
    const el = box.current; if (!el) return;
    const y = headH + i * rowHeight;
    if (y < el.scrollTop + headH) el.scrollTop = y - headH;
    else if (y + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = y + rowHeight - el.clientHeight;
  };
  const onKey = (e) => {
    if (e.target !== box.current) return;
    const page = Math.max(1, Math.floor(height / rowHeight) - 2);
    let n = focus;
    if (e.key === 'ArrowDown') n = focus + 1;
    else if (e.key === 'ArrowUp') n = focus - 1;
    else if (e.key === 'PageDown') n = focus + page;
    else if (e.key === 'PageUp') n = focus - page;
    else if (e.key === 'Home') n = 0;
    else if (e.key === 'End') n = rows.length - 1;
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (rows[focus] != null) onActivate?.(rows[focus], e); return; }
    else return;
    e.preventDefault();
    n = Math.max(0, Math.min(rows.length - 1, n));
    setFocus(n); scrollTo(n);
  };
  const vis = [];
  for (let i = start; i < end; i++) vis.push(i);
  const activeId = rows.length ? `vt-row-${rowKey(rows[focus])}` : undefined;
  // A fade on the side that has more columns, since overlay scrollbars hide
  // the fact that the table scrolls sideways.
  return html`<div class=${`vt${edge.right ? ' vt--more-right' : ''}${edge.left ? ' vt--more-left' : ''}`}>
    <div class=${`vt__scroll${hasFocus ? ' has-focus' : ''}`} ref=${box} tabindex="0" role="grid" aria-label=${label} aria-rowcount=${rows.length + 1} aria-activedescendant=${activeId}
        onScroll=${e => { setTop(e.currentTarget.scrollTop); checkEdge(); }} onKeyDown=${onKey}
        onFocus=${e => { if (e.target === box.current) setHasFocus(true); }} onBlur=${e => { if (e.target === box.current) setHasFocus(false); }}>
      <div style=${`min-width:${minWidth}px;position:relative;height:${headH + rows.length * rowHeight}px`}>
        <div class="vt__head" role="row" aria-rowindex="1" style=${`grid-template-columns:${template};height:${headH}px`}>
          ${columns.map(c => {
            const active = sort?.key === c.key;
            const dir = active ? sort.dir : null;
            return html`<div class=${`vt__th${c.num ? ' num' : ''}${active ? ' is-sorted' : ''}`} role="columnheader" aria-sort=${active ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
              ${c.sortable !== false ? html`<button type="button" class="vt__sort" onClick=${() => onSort?.(c.key)} title=${`Sort by ${c.title}`}>${c.header || c.title}${active ? (dir === 'asc' ? Icon.sortAsc : Icon.sortDesc) : ''}</button>` : (c.header || c.title)}
              ${c.info || ''}
            </div>`;
          })}
        </div>
        ${!rows.length && html`<p class="muted small" style=${`position:absolute;top:${headH + 12}px;left:0`}>${empty}</p>`}
        ${vis.map(i => {
          const r = rows[i];
          const k = rowKey(r);
          return html`<div key=${k} id=${`vt-row-${k}`} role="row" aria-rowindex=${i + 2} aria-selected=${String(selected.has(k))}
              class=${`vt__row${selected.has(k) ? ' is-selected' : ''}${i === focus ? ' is-focus' : ''}`}
              style=${`top:${headH + i * rowHeight}px;height:${rowHeight}px;grid-template-columns:${template}`}
              onClick=${(e) => { setFocus(i); onActivate?.(r, e); }}>
            ${columns.map(c => html`<div role="gridcell" class=${`vt__td${c.num ? ' num' : ''}${c.name ? ' name' : ''}`}>${cell(r, c)}</div>`)}
          </div>`;
        })}
      </div>
    </div>
  </div>`;
}
