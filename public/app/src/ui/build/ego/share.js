// Ego builder, survey mode: share the interview's questions as a link, then
// read the respondents' response files back and analyze them together.
//
// With "pick people from the roster" on, respondents choose themselves and
// the people they name from the Roster tab's list, so their interviews are
// stitched into one bounded network (src/builders/share.js stitchEgo);
// without it, each response is its own ego network.

import { html, useState, useMemo } from '../../../../vendor/preact.js';
import { uid } from '../../../builders/common.js';
import { surveyFromEgo, recombine, recombineNotes, recombinedDataset } from '../../../builders/share.js';
import { ShareLink, ResponsesIn, RecombineNotes } from '../sharing.js';
import { HandOffBar, storage } from '../shared.js';

export const SHARE_KEY = 'orgsignal.build.ego.share';
const ROSTER_KEY = 'orgsignal.build.roster';

export function newEgoShare() {
  return { mode: 'interview', id: null, createdAt: null, title: '', intro: '', useRoster: false, askTies: true, allowOthers: true, items: [] };
}

export function EgoShareStep({ s, share, setShare }) {
  const roster = useMemo(() => storage.get(ROSTER_KEY, null), []);
  const people = roster?.people || [];
  const useRoster = share.useRoster && people.length > 1;
  const [notes, setNotes] = useState(null);
  const [result, setResult] = useState(null);
  const set = p => setShare(x => ({ ...x, ...p }));
  const id = share.id;
  const makeDef = () => surveyFromEgo(s, {
    id: id || 'pending', createdAt: share.createdAt, title: share.title || s.protocolName, intro: share.intro,
    roster: useRoster ? people : null, askTies: share.askTies, allowOthers: share.allowOthers,
  });
  const read = ({ items, errors }) => {
    const def = makeDef();
    const all = [...(share.items || []), ...items];
    const res = recombine(all, { survey: def });
    res.invalid.push(...errors.map(e => ({ file: e.file, reason: e.reason })));
    setNotes(recombineNotes(res));
    setResult(res);
    set({ items: all.filter(x => x.ok && x.response.survey.id === def.id) });
  };
  // Responses read in an earlier visit are recombined again on demand.
  const current = () => result || recombine(share.items || [], { survey: makeDef() });
  const n = (share.items || []).length;
  return html`<div class="ob-stack">
    <p class="ob-note">Each respondent opens the link on their own computer or phone and does this interview for themselves: the questions that ask for names, the questions about each person and each tie${share.askTies ? ', and who knows whom' : ''}. They send back a small response file; nothing is uploaded anywhere.</p>
    <fieldset class="ob-fieldset">
      <legend>Who respondents can name</legend>
      <label class="check"><input type="checkbox" checked=${useRoster} disabled=${people.length < 2}
        onChange=${e => set({ useRoster: e.currentTarget.checked })} />
        <span>Pick people from the roster${people.length ? ` (${people.length} people in the Roster tab)` : ' (make one in the Roster tab first)'}. Respondents also pick themselves from it, and their interviews are stitched into one network.</span></label>
      ${useRoster ? html`<label class="check"><input type="checkbox" checked=${share.allowOthers} onChange=${e => set({ allowOthers: e.currentTarget.checked })} />
        <span>Allow naming someone not on the list</span></label>` : null}
      <label class="check"><input type="checkbox" checked=${share.askTies} onChange=${e => set({ askTies: e.currentTarget.checked })} />
        <span>Ask who knows whom among the people named</span></label>
    </fieldset>
    <div class="ob-section">
      <h3>1. Send a link</h3>
      ${id ? html`<${ShareLink} makeDef=${makeDef} meta=${{ title: share.title || s.protocolName, intro: share.intro }} onMeta=${set} idPrefix="ego-share"
          privacy=${useRoster ? 'The link carries only the questions and the names on the roster (no attributes).' : 'The link carries only the questions.'} />`
        : html`<div class="ob-row"><button type="button" class="btn" disabled=${!s.generators.length}
            onClick=${() => set({ id: uid('s'), createdAt: new Date().toISOString(), title: share.title || s.protocolName })}>Make a share link</button></div>`}
    </div>
    ${id ? html`<div class="ob-section">
      <h3>2. Collect the responses</h3>
      <${ResponsesIn} onRead=${read} idPrefix="ego-resp" />
      <${RecombineNotes} notes=${notes} />
      ${n ? html`<p class="ob-note">${n} ${n === 1 ? 'response' : 'responses'} read so far. Dropping the files on Data, Import gives the same network.</p>
        <${HandOffBar} build=${() => recombinedDataset(current(), { people })} label="Analyze the responses" />` : null}
    </div>` : null}
  </div>`;
}
