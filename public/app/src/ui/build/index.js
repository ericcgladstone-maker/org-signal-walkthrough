// Build view: the ways to make a network by hand.
//
//   Draw        free-hand editor with snapping and layouts (draw/)
//   Ego         name generators, interpreters, alter-alter ties (ego/)
//   Roster      bounded network from a roster, single informant or many (roster/)
//   Perceived   cognitive social structures from several informants (perceived/)
//   Paste       a list of ties typed or pasted as text (paste/)
//
// Every builder ends in store.actions.loadDataset via service.handOff.
// ui-core mounts <BuildView/>; it takes no required props. `tab` may be
// passed to open a given builder.
//
// Worked examples (src/builders/examples.js) open from a link:
//   #build?example=<id>      works with the shell's router as it is
//   #build/example/<id>      the same, for a router that passes #build/... here
// The Draw or Ego tab opens with the example loaded (asking first when it
// would replace work), and the address goes back to #build.
//
// A classic dataset's perceived networks open the same way:
//   #build?perceived=krackhardt:advice
// The Perceived tab opens with that study (asking first when it would replace
// one), and the address goes back to #build.

import { html, useState, useEffect } from '../../../vendor/preact.js';
import { ensureBuildCss, Tabs, storage, ViewHeader } from './shared.js';
import { DrawEditor } from './draw/index.js';
import { EgoBuilder } from './ego/index.js';
import { RosterBuilder } from './roster/index.js';
import { PerceivedBuilder } from './perceived/index.js';
import { PasteTies } from './paste/index.js';
import { exampleById } from '../../builders/examples.js';
import { exampleFromHash, perceivedFromHash } from './hash.js';
import { loadClassicPerceived } from '../../core/classic.js';
import { store } from '../store.js';

export { exampleFromHash, perceivedFromHash };

const TABS = [
  { id: 'draw', label: 'Draw', title: 'Draw a network', lede: 'Place people and ties directly on the canvas. You can preserve the hand-drawn positions or apply a layout before analyzing the network.', C: DrawEditor },
  { id: 'ego', label: 'Ego network', title: 'Ego-network interview', lede: 'Conduct an ego-network interview by eliciting the people around a respondent, recording attributes of those people and relationships, and asking about ties among them. The resulting personal network can be analyzed using ego-network measures such as size, density, effective size, and constraint.', C: EgoBuilder },
  { id: 'roster', label: 'Roster', title: 'Bounded network from a roster', lede: 'Define a bounded population from a roster and record ties among its members. Ties can be entered by one informant or collected from multiple respondents through a survey.', C: RosterBuilder },
  { id: 'perceived', label: 'Perceived', title: 'Perceived networks', lede: 'Collect whole-network reports from multiple informants. Each perceived network is retained separately, allowing reports to be compared, combined into a consensus network, and evaluated for perceptual accuracy. This supports cognitive social structure designs such as Krackhardt\u2019s.', C: PerceivedBuilder },
  { id: 'paste', label: 'Paste ties', title: 'Paste a list of ties', lede: 'Enter or paste one tie per line. The preview shows how each line is parsed and flags lines that remain unparsed.', C: PasteTies },
];

const TAB_KEY = 'orgsignal.build.tab';

export function BuildView({ tab: initialTab } = {}) {
  ensureBuildCss();
  const linked = () => (typeof location === 'undefined' ? null : exampleFromHash(location.hash));
  const linkedStudy = () => (typeof location === 'undefined' ? null : perceivedFromHash(location.hash));
  const [tab, setTab] = useState(() => { const id = linked(); return id ? (exampleById(id).kind === 'ego' ? 'ego' : 'draw') : linkedStudy() ? 'perceived' : initialTab || storage.get(TAB_KEY, 'draw'); });
  const [example, setExample] = useState(null); // { id, nonce } for the Draw or Ego tab
  const [study, setStudy] = useState(null); // { css, nonce } for the Perceived tab
  useEffect(() => { storage.set(TAB_KEY, tab); }, [tab]);
  useEffect(() => {
    const back = () => { try { history.replaceState(null, '', `${location.pathname}${location.search}#build`); } catch { /* address bar left as is */ } };
    const take = () => {
      const p = linkedStudy();
      if (p) {
        back();
        setTab('perceived');
        loadClassicPerceived(p.id, p.relation)
          .then(css => setStudy({ css, nonce: Date.now() + Math.random() }))
          .catch(e => store.actions.notify?.('error', `Could not open the perceived networks: ${e.message}`));
        return;
      }
      const id = linked();
      if (!id) return;
      setTab(exampleById(id).kind === 'ego' ? 'ego' : 'draw');
      setExample({ id, nonce: Date.now() + Math.random() });
      back();
    };
    take();
    window.addEventListener('hashchange', take);
    return () => window.removeEventListener('hashchange', take);
  }, []);
  const cur = TABS.find(t => t.id === tab) || TABS[0];
  const C = cur.C;
  return html`<section class="ob ob-view">
    <${ViewHeader} title="Build" intro="Construct a network directly from a drawing, ego-network interview, roster, perceived-network reports, or pasted tie list." />
    <${Tabs} tabs=${TABS} value=${cur.id} onChange=${setTab} label="Ways to build a network" />
    <div role="tabpanel" class="ob-stack" id=${'obpanel-' + cur.id} aria-labelledby=${'obtab-' + cur.id}>
      <div class="ob-subhead">
        <h2 class="ob-h">${cur.title}</h2>
        <p class="ob-text">${cur.lede}</p>
      </div>
      <${C} example=${example && (exampleById(example.id).kind === 'ego') === (cur.id === 'ego') ? example : null} study=${cur.id === 'perceived' ? study : null} />
    </div>
  </section>`;
}

export default BuildView;
