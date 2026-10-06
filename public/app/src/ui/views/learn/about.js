// About Org Signal, in Learn: what it is for, how the numbers are checked,
// what happens to the data, and the known limitations. README.md ("Your
// data", "How the numbers are checked", "Known limitations") states the same
// facts in its own wording; when a fact changes, change both.

import { html } from '../../../../vendor/preact.js';
import { store } from '../../store.js';

const REPO = 'https://github.com/ericcgladstone-maker/org-signal';

// Opens Learn at the About section (from the Data start page). Learn loads
// on demand, so this waits (up to 3 s) for the section to exist.
export function openAbout() {
  store.actions.setView('learn', { focus: false });
  const t0 = performance.now();
  const go = () => {
    const el = document.getElementById('learn-about');
    if (el) { el.scrollIntoView({ block: 'start' }); el.querySelector('h2')?.focus({ preventScroll: true }); }
    else if (performance.now() - t0 < 3000) requestAnimationFrame(go);
  };
  requestAnimationFrame(go);
}

// Wording from the copy audit (docs/ux/copy-audit-eric-2026-10-04.md), with
// the corrections recorded in docs/ux/copy-audit-2026-10-04-applied.md.
const LIMITS = [
  ['Testing and browser coverage', [
    'Automated browser testing currently centers on Chrome. Safari and Firefox have received less systematic testing, including the WebGL network map.',
    'Usability testing to date has used simulated student and instructor workflows through the Networks 101 assignments. Live classroom use has not yet been evaluated systematically.',
    'Ask has been tested end to end with an offline provider stand-in. Coverage against the live services of each supported model provider remains more limited.',
    'Some importers were developed from published platform specifications and public sample files. Microsoft Teams and LinkedIn are among the sources with the least testing against real user exports. Platform export formats can also change over time.',
  ]],
  ['Measurement', [
    'Above approximately 3,000 people, betweenness and closeness are estimated by sampling. These approximations perform best when structural differences are large. Rankings become less stable when scores are close together or when the network is sparse, directed, or strongly tree-like.',
    'Resampling addresses variation in observed events and cannot recover ties absent from the source data. Rank intervals for contacts therefore have narrower-than-nominal coverage in the current simulations, approximately 88 percent rather than 95 percent.',
    'Shift detection has limited power when few events occur within each time window. The current calibration favors a low false-positive rate, so an undetected shift provides limited evidence of temporal stability.',
    'Personal platform exports represent the portion of a network visible from one account. Whole-network measures calculated from those records describe that observed export. Ego-network measures are generally more appropriate when the source is explicitly personal.',
  ]],
  ['Synthetic data', [
    'Recovery varies across generated contexts and media. Workplace and online-community structures are generally recovered well. Recovery is weaker in some professional-network, Discord, calendar, and bot-campaign scenarios.',
    'Generated people, messages, and organizational records are fictional. Their structure is generated to support known-ground-truth analysis and recovery tests.',
  ]],
  ['Data and ethics', [
    'The included Enron subset contains workplace communication records from identifiable people. The dataset is provided for methodological use, and the included version excludes message text and subjects. Published forensic work has also raised questions about the authenticity of some records in the larger Enron corpus.',
    'Several classic datasets distributed through UCINET and Pajek collections carry no explicit license statement in their source collections. Org Signal includes them with citations to the published studies from which they derive.',
  ]],
  ['Practical limits', [
    'PST, OST, and MSG files can be identified but are not currently parsed directly in the browser. Mbox provides the supported path for Outlook mail archives.',
    'Very large exports are constrained by available browser memory. Imports run in the background and can be cancelled.',
    'Loaded projects have no server backup. Build drafts are retained in local browser storage, and project files can be downloaded for durable storage.',
  ]],
];

export function About() {
  return html`<section class="section learn__part learn-about" id="learn-about" aria-labelledby="learn-about-h">
    <h2 id="learn-about-h" tabindex="-1">About Org Signal and its limits</h2>
    <p class="prose">Org Signal is a browser-based environment for teaching and conducting social network analysis. It supports directly constructed networks, ego networks, surveys, synthetic systems with known structure, published datasets, and empirical records. The same analysis engine is used across these sources, allowing measures and construction choices to be examined first in transparent settings and then applied to more complex data.</p>
    <p class="prose">I built Org Signal as part of my work on network measurement and computational research systems.</p>

    <h3 class="dv-h3">Your data</h3>
    <ul class="prose learn-about__list">
      <li>Files are read and analyzed locally in the browser.</li>
      <li>Ask sends information to a model provider only when a user supplies an API key and runs a language-model function. The Ask panel lists the information sent for each operation and supports replacement of names with codes before transmission.</li>
      <li>Exported network files omit contact details by default.</li>
    </ul>

    <h3 class="dv-h3">How the numbers are checked</h3>
    <ul class="prose learn-about__list">
      <li>The numerical implementation is tested against NetworkX, exact linear-algebra calculations, and closed-form reference cases across approximately 21 million comparisons, with no unexplained failures in the current validation campaign.</li>
      <li>Statistical procedures are calibrated through simulation. Tests based on degree-preserving randomization produce approximately the expected false-positive rate under the null, and rank intervals have been evaluated against known ranks across repeated simulations.</li>
      <li>Generated worlds are written to native export formats, read back through the production importers, and compared with their source structure. The included classic datasets reproduce published counts and reference values.</li>
      <li>These procedures evaluate implementation and numerical accuracy. Substantive validity depends on the relationship between the source data, the rules used to construct the network, and the theoretical quantity being studied.</li>
    </ul>

    <h3 class="dv-h3">Known limitations</h3>
    ${LIMITS.map(([title, items]) => html`<div class="learn-about__group">
      <p class="label">${title}</p>
      <ul class="prose learn-about__list">${items.map(t => html`<li>${t}</li>`)}</ul>
    </div>`)}

    <h3 class="dv-h3">Source, citation, and issue reporting</h3>
    <ul class="prose learn-about__list">
      <li>Problems and undocumented limitations can be reported through the project’s <a class="linkish" href=${REPO + '/issues'} target="_blank" rel="noopener">GitHub issue tracker</a>. A useful report identifies the type of data loaded, the expected behavior, the observed behavior, and the browser, without including the underlying data.</li>
      <li>Citation: Gladstone, E. (2026). <em>Org Signal: Browser-based network analysis for teaching and research</em> (Version 2.0) [Software].</li>
      <li>The source code, documentation, accuracy report, supported formats, classic datasets, and Networks 101 materials are available in the <a class="linkish" href=${REPO + '#readme'} target="_blank" rel="noopener">project repository</a>.</li>
      <li>An interactive walkthrough of the analyses in this tool, from a drawn network to a claim that can be defended, is available as a talk: <a class="linkish" href="https://orgsignalwalkthrough.eric-c-gladstone.workers.dev" target="_blank" rel="noopener">Analyzing Social Network Data</a>.</li>
    </ul>
  </section>`;
}
