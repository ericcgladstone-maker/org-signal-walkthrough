// Keyboard shortcuts for the draw editor, and the overlay that lists them.
// The list is the single source: the editor's key handler and this overlay
// both read SHORTCUTS' wording, so the help never drifts from behaviour.

import { html, useEffect, useRef } from '../../../../vendor/preact.js';

const mod = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '') ? 'Cmd' : 'Ctrl';

export const SHORTCUTS = [
  ['Canvas', [
    ['V', 'Select mode'], ['B', 'Add-person mode (click to place)'], ['C', 'Connect mode (drag from one person to another, or click two people)'], ['H', 'Pan mode'],
    ['Space + drag', 'Pan in any mode'], ['Wheel or pinch', 'Zoom around the pointer'], ['+ / -', 'Zoom in / out'], ['0', 'Fit the drawing to the view'],
  ]],
  ['People and ties', [
    ['N', 'New person near the center of the view, ready to name'], ['Tab / Shift+Tab', 'Move to the next / previous person and select them (leaves the canvas after the last)'],
    ['Space', 'Keep the selection while moving with Tab; again to add or remove the focused person'], ['Enter or F2', 'Rename the focused or selected person'],
    ['E', 'Connect the selected people in the order selected (or the selected person to the focused one)'],
    ['M', 'Two-mode drawings: switch which kind of node Add places (circle or square)'],
    ['Arrow keys', 'Nudge the selection by one grid step (Shift: five); with nothing selected, pan'],
    ['Delete / Backspace', 'Delete the selection'], [`${mod}+A`, 'Select everyone'], ['Esc', 'Clear selection, cancel, close'],
  ]],
  ['Edit', [
    [`${mod}+Z`, 'Undo'], [`${mod}+Shift+Z or ${mod}+Y`, 'Redo'], [`${mod}+C / ${mod}+V`, 'Copy / paste the selection'], [`${mod}+D`, 'Duplicate the selection'],
    ['G', 'Snap to grid on or off'], ['L', 'Go to the layout menu'], ['T', 'Switch between the canvas and the table'], ['?', 'This help'],
  ]],
];

export function HelpOverlay({ onClose }) {
  const btn = useRef(null);
  useEffect(() => {
    const prev = document.activeElement;
    btn.current?.focus();
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    document.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('keydown', onKey, true); prev?.focus?.(); };
  }, []);
  return html`<div class="dialog-backdrop" onClick=${e => e.target === e.currentTarget && onClose()}>
    <div class="dialog ob ob-draw-help" role="dialog" aria-modal="true" aria-labelledby="ob-draw-help-title">
      <div class="dialog__head"><h2 id="ob-draw-help-title">How to draw</h2>
        <button type="button" class="btn btn--sm" ref=${btn} onClick=${onClose}>Close</button></div>
      <ol class="ob-notes ob-howto">
        <li><strong>Add people:</strong> choose Add person, click the canvas, type the name and press Enter.</li>
        <li><strong>Tie two people:</strong> choose Connect, then click one person and then the other. Ties are two-way unless you tick Directed (one-way) in the panel beside the canvas.</li>
        <li><strong>Fix mistakes:</strong> Undo, or choose Select, click a person or tie and use the panel (rename, group, delete).</li>
        <li><strong>Two kinds of node:</strong> File, Two-mode drawing makes people (circles) and events or clubs (squares), tied only across the kinds. Choose which kind Add places in the toolbar (or press M); Arrange, Two columns lines them up.</li>
        <li><strong>Analyze:</strong> Analyze this network opens the map; People lists each person's measures.</li>
      </ol>
      <p class="ob-note">Not sure where to start? File, Start from an example loads a small network with notes on what to look for. Every action is also a button, and Table edits the same drawing as rows.</p>
      <h3 class="ob-h">Keyboard shortcuts</h3>
      ${SHORTCUTS.map(([title, rows]) => html`<section class="ob-stack" style="gap:.4rem">
        <h4 class="label">${title}</h4>
        <dl class="ob-keys">${rows.map(([k, d]) => html`<dt><kbd>${k}</kbd></dt><dd>${d}</dd>`)}</dl>
      </section>`)}
    </div>
  </div>`;
}
