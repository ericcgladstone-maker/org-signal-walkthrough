// Learn (#learn, #learn/<key>): the beginner-support home (decision 1). Four
// parts: "Find it in the app" (the course's questions, each with where to go),
// worked examples that open in Build, the classic datasets library
// (learn/classic.js), and every concept from the glossary
// with its meaning, where it appears, its interpretation, a caution, and a
// tiny figure for the five core ideas (labels from the copy audit, 2026-10-04). Meanings come from the glossary
// (src/analysis/glossary.js), so Learn, tooltips and the API docs agree.

import { html, useState, useEffect, useMemo, useRef } from '../../../vendor/preact.js';
import { store, useStore } from '../store.js';
import { ViewHead, Term } from '../components/common.js';
import { GLOSSARY, GLOSSARY_ALIASES } from '../../analysis/glossary.js';
import { viewInfo } from '../actions.js';
import { SECTIONS, TEACH, TASKS, EXAMPLES } from './learn/concepts.js';
import { DIAGRAMS } from './learn/diagrams.js';
import { ClassicList, ClassicCard } from './learn/classic.js';
import { About } from './learn/about.js';

// Every glossary key appears once: in its section, or under "More measures".
function allSections() {
  const placed = new Set(SECTIONS.flatMap(s => s.keys));
  const rest = Object.keys(GLOSSARY).filter(k => !placed.has(k));
  const out = SECTIONS.map(s => ({ ...s, keys: s.keys.filter(k => GLOSSARY[k]) }));
  if (rest.length) out.push({ id: 'more', title: 'More measures', intro: 'Variants of the measures above.', keys: rest });
  return out;
}

const norm = s => String(s || '').toLowerCase();

function Where({ items }) {
  return html`<span class="concept__where">${items.map(([label, hash]) => html`<a class="tlink tlink--arrow" href=${`#${hash}`}>${label}</a>`)}</span>`;
}

function Concept({ k, target }) {
  const g = GLOSSARY[k];
  const t = TEACH[k] || {};
  const D = t.diagram && DIAGRAMS[t.diagram];
  return html`<article class=${`concept${D ? ' concept--fig' : ''}${target ? ' is-target' : ''}`} id=${`learn-${k}`} tabindex="-1" aria-labelledby=${`learn-h-${k}`}>
    <div class="concept__text">
      <h3 class="concept__name" id=${`learn-h-${k}`}><a class="concept__anchor" href=${`#learn/${k}`}>${g.label}</a></h3>
      <p class="concept__meaning">${g.meaning}</p>
      ${(t.where || t.read || t.mistake) && html`<dl class="concept__dl">
        ${t.where && html`<dt>Where it appears</dt><dd><${Where} items=${t.where} /></dd>`}
        ${t.read && html`<dt>Interpretation</dt><dd>${t.read}</dd>`}
        ${t.mistake && html`<dt>Caution</dt><dd>${t.mistake}</dd>`}
      </dl>`}
      ${(g.formula || g.reliability) && html`<details class="disclose concept__more">
        <summary>Formula and reliability</summary>
        <div class="small text2 stack">
          ${g.formula && html`<p><span class="concept__k">Formula.</span> ${g.formula}</p>`}
          ${g.needs && html`<p><span class="concept__k">Needs.</span> ${g.needs}</p>`}
          ${g.reliability && html`<p><span class="concept__k">Reliability.</span> ${g.reliability}</p>`}
        </div>
      </details>`}
    </div>
    ${D && html`<${D} />`}
  </article>`;
}

function Tasks() {
  return html`<ol class="tasks">
    ${TASKS.map(t => html`<li class="task">
      <span class="meta task__a">${t.a}</span>
      <div class="task__body">
        <p class="task__q">${t.q}</p>
        <p class="task__how">${t.how}</p>
        <p class="tlinks task__links">
          <a class="tlink tlink--arrow" href=${`#${t.to}`}>Go to ${viewInfo(t.to)?.label || t.to}</a>
          ${t.learn.length > 0 && html`<span class="small text2">Read first: ${t.learn.map((k, i) => html`${i ? ', ' : ''}<a class="linkish" href=${`#learn/${k}`}>${GLOSSARY[k]?.label || k}</a>`)}</span>`}
        </p>
      </div>
    </li>`)}
  </ol>`;
}

function Examples() {
  return html`<ul class="examples">
    ${EXAMPLES.map(x => html`<li class="example">
      <h3 class="example__title">${x.title}</h3>
      <p class="example__what"><span class="concept__k">What to look for.</span> ${x.what}</p>
      <p class="tlinks">
        <a class="tlink tlink--arrow" href=${`#build?example=${x.id}`}>Open in Build</a>
        <span class="small text2">Read: ${x.learn.map((k, i) => html`${i ? ', ' : ''}<a class="linkish" href=${`#learn/${k}`}>${GLOSSARY[k]?.label || k}</a>`)}</span>
      </p>
    </li>`)}
  </ul>`;
}

export function LearnView() {
  const learnKey = useStore(s => s.learnKey);
  const loadedExample = useStore(s => s.dataset?.meta?.example);
  const explain = useStore(s => s.explain !== false);
  const [q, setQ] = useState('');
  const sections = useMemo(allSections, []);
  const key = learnKey && (GLOSSARY[learnKey] ? learnKey : GLOSSARY_ALIASES[learnKey]);
  const shown = useMemo(() => {
    const n = norm(q).trim();
    if (!n) return sections;
    return sections.map(s => ({ ...s, keys: s.keys.filter(k => norm(GLOSSARY[k].label).includes(n) || norm(GLOSSARY[k].meaning).includes(n) || norm(k).includes(n)) })).filter(s => s.keys.length);
  }, [q, sections]);
  const first = useRef(true);
  // Opening #learn/<key> scrolls to that concept and moves focus to it.
  useEffect(() => {
    if (!key) return;
    if (q) setQ('');
    const go = () => {
      const el = document.getElementById(`learn-${key}`);
      if (!el) return;
      el.scrollIntoView({ block: 'start', behavior: first.current ? 'auto' : 'smooth' });
      el.focus({ preventScroll: true });
      first.current = false;
    };
    requestAnimationFrame(() => requestAnimationFrame(go));
  }, [key]);
  const count = shown.reduce((a, s) => a + s.keys.length, 0);
  return html`<div class="view learn">
    <${ViewHead} title="Learn" purpose=${false} intro="Definitions, interpretation, worked examples, and limitations for the measures used throughout Org Signal." />
    <nav class="tlinks learn__jump" aria-label="On this page">
      <a class="tlink" href="#learn-tasks" onClick=${e => { e.preventDefault(); document.getElementById('learn-tasks')?.scrollIntoView({ block: 'start' }); }}>Find it in the app</a>
      <a class="tlink" href="#learn-examples" onClick=${e => { e.preventDefault(); document.getElementById('learn-examples')?.scrollIntoView({ block: 'start' }); }}>Worked examples</a>
      <a class="tlink" href="#learn-classic" onClick=${e => { e.preventDefault(); document.getElementById('learn-classic')?.scrollIntoView({ block: 'start' }); }}>Classic datasets</a>
      <a class="tlink" href="#learn-concepts" onClick=${e => { e.preventDefault(); document.getElementById('learn-concepts')?.scrollIntoView({ block: 'start' }); }}>Concepts</a>
      <a class="tlink" href="#learn-about" onClick=${e => { e.preventDefault(); document.getElementById('learn-about')?.scrollIntoView({ block: 'start' }); }}>About and limits</a>
      <span class="small text2 learn__explain">Interpretive notes: ${explain ? 'on' : 'off'}. When on, an Interpretation note appears under the numbers in every view. <button type="button" class="tlink tlink--quiet" onClick=${() => store.actions.setExplain(!explain)}>Turn ${explain ? 'off' : 'on'}</button></span>
    </nav>

    <section class="section learn__part" id="learn-tasks" aria-labelledby="learn-tasks-h">
      <h2 id="learn-tasks-h">Find it in the app</h2>
      <p class="prose">Common network-analysis questions, with links to the views and measures used to address them.</p>
      <${Tasks} />
    </section>

    <section class="section learn__part" id="learn-examples" aria-labelledby="learn-examples-h">
      <h2 id="learn-examples-h">Worked examples</h2>
      <p class="prose">Small networks with known structure that can be opened in Build, modified, and analyzed.</p>
      <${Examples} />
    </section>

    <div class="learn__part" id="learn-classic">
      ${loadedExample?.classic && html`<${ClassicCard} example=${loadedExample} title="Loaded now" />`}
      <${ClassicList} headingId="learn-classic-h" />
    </div>

    <section class="section learn__part" id="learn-concepts" aria-labelledby="learn-concepts-h">
      <div class="learn__concepts-head">
        <h2 id="learn-concepts-h">Concepts</h2>
        <label class="field learn__search"><span>Find a term</span>
          <input class="input" type="search" value=${q} placeholder="for example betweenness, tie, p" onInput=${e => setQ(e.currentTarget.value)} />
        </label>
      </div>
      <p class="prose">Definitions, formulas, interpretation, and reliability notes for the measures used throughout the analysis.</p>
      <p class="small text2" role="status">${q ? `${count} ${count === 1 ? 'term' : 'terms'} match.` : html`Terms with a dotted underline anywhere in the app, like <${Term} k="tie">tie</${Term}>, open here.`}</p>
      ${shown.map(s => html`<div class="learn__sec" id=${`learn-sec-${s.id}`}>
        <p class="label">${s.title}</p>
        ${!q && html`<p class="prose learn__sec-intro">${s.intro}</p>`}
        ${s.keys.map(k => html`<${Concept} k=${k} key=${k} target=${k === key} />`)}
      </div>`)}
    </section>

    <${About} />
  </div>`;
}
