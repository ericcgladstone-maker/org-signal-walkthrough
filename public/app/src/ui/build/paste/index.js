// Paste ties: textarea with a live, line-by-line preview.

import { html, useMemo, useState } from '../../../../vendor/preact.js';
import { parseTies, toDataset } from '../../../builders/paste.js';
import { HandOffBar, storage } from '../shared.js';

const KEY = 'orgsignal.build.paste.text';
// Kept out of the template: htm would read "<-" as the start of a tag.
const HELP = 'Separate two names with " - " (undirected), " -> " or " <- " (directed), " <-> " (both ways), a comma or a tab. Add a number at the end for a weight. Put names that contain commas in double quotes.';
const EXAMPLE = `# One tie per line. Lines starting with # are notes.
Avery - Jordan
Jordan -> Sam, 3
Sam <-> Riley
"Lee, Morgan", Avery, 2
Riley\tAvery`;

export function PasteTies() {
  const [text, setTextState] = useState(() => storage.get(KEY, ''));
  const [name, setName] = useState('Pasted ties');
  const setText = t => { setTextState(t); storage.set(KEY, t); };
  const parsed = useMemo(() => parseTies(text), [text]);
  const nTies = parsed.ties.length, nErr = parsed.errors.length;
  return html`<div class="ob-stack">
    <div class="ob-cols">
      <div class="ob-stack">
        <div class="field">
          <label class="field__label" for="ob-paste-text">Ties</label>
          <textarea id="ob-paste-text" class="input" rows="14" spellcheck="false"
            aria-describedby="ob-paste-help ob-paste-summary"
            placeholder="for example: Avery - Jordan" value=${text} onInput=${e => setText(e.currentTarget.value)}></textarea>
          <span id="ob-paste-help" class="ob-help">
            ${HELP}
          </span>
        </div>
        <div class="ob-row" style="gap:.5rem 1.5rem">
          <button type="button" class="tlink" onClick=${() => setText(EXAMPLE)}>Load example</button>
          <button type="button" class="tlink tlink--quiet" disabled=${!text} onClick=${() => setText('')}>Clear</button>
        </div>
      </div>
      <div class="ob-stack">
        <div class="ob-previewhead">
          <h3 class="label">Preview</h3>
          <span id="ob-paste-summary" class="ob-note" aria-live="polite">
            ${nTies} ${nTies === 1 ? 'tie' : 'ties'} among ${parsed.nodes.length} people${parsed.directed ? ', directed' : ''}${nErr ? html`, <span class="ob-err">${nErr} ${nErr === 1 ? 'line' : 'lines'} not read</span>` : ''}
          </span>
        </div>
        ${parsed.lines.length && text.trim() ? html`<ol class="ob-lines" aria-label="How each line is read">
          ${parsed.lines.map(l => html`<li class=${l.kind === 'error' ? 'bad' : ''}>
            <span class="n">${l.n}</span>
            <span>${l.kind === 'tie' ? l.ties.map((t, i) => html`${i ? '; ' : ''}${t.from} ${t.directed ? '→' : '—'} ${t.to}${t.weight !== 1 ? ` (${t.weight})` : ''}`)
              : l.kind === 'error' ? html`${l.raw}<span class="msg">${l.message}</span>`
              : html`<span class="muted">${l.kind === 'comment' ? l.raw : ' '}</span>`}</span>
          </li>`)}
        </ol>` : html`<p class="ob-empty">Nothing pasted yet.</p>`}
      </div>
    </div>
    <div class="ob-section">
      <div class="field" style="max-width:24rem">
        <label class="field__label" for="ob-paste-name">Network name</label>
        <input id="ob-paste-name" class="input" value=${name} onInput=${e => setName(e.currentTarget.value)} />
      </div>
      <${HandOffBar} disabled=${!nTies} build=${() => toDataset(parsed, { name: name || 'Pasted ties' })}
        note=${nErr ? 'Lines that could not be read are left out.' : null} />
    </div>
  </div>`;
}
