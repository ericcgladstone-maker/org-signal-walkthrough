// Shared-survey responses: the files (or pasted text blocks) respondents
// send back from an Org Signal share link, recombined into one network.
//
// Formats are defined in src/builders/share.js (ours, so nothing here is
// guessed). A drop may hold any number of response files (.json), text files
// of pasted response blocks, and optionally the survey file itself. All of
// them are read together, because recombining is a whole-set operation: the
// merge rule needs both people's answers, and who did not respond, who
// answered twice and who answered another survey can only be said with the
// full set in hand.
//
// The reference survey is the survey file when one is in the drop, else the
// survey most of the responses answered; responses to any other survey are
// rejected with a message naming them. Duplicates keep the latest response.
//
// Roster surveys also keep who named whom on the source (source.nominations),
// so a saved project can be recombined later with another rule: union,
// reciprocated only or as reported (rederiveSurvey; C9).

import { peek } from '../core/fileset.js';
import { DatasetBuilder, inferAttributeSchema } from '../core/model.js';
import { parseResponses, recombine, writeRecombined, sniffShared, rosterRespondents } from '../builders/share.js';
import { MERGE_RULES, writeRoster } from '../builders/roster.js';

const CANDIDATE = /\.(json|txt|eml|text)$/i;

async function detect(fs) {
  const hits = [];
  let candidates = 0;
  for (const e of fs.entries) {
    if (!CANDIDATE.test(e.rel) || e.size > 5e6) continue;
    candidates++;
    if (candidates > 2000) break;
    let head = '';
    try { head = await peek(e, 4096); } catch { continue; }
    const kind = sniffShared(head);
    if (kind) hits.push({ rel: e.rel, kind });
  }
  const responses = hits.filter(h => h.kind === 'response').length;
  if (!responses) return { score: 0, reason: '' };
  return {
    score: 0.97,
    reason: `${responses} Org Signal survey ${responses === 1 ? 'response' : 'responses'}${hits.length > responses ? ' and the survey file' : ''}`,
    files: hits.map(h => h.rel),
  };
}

async function importResponses(fs, { builder, options = {}, progress = () => {}, signal } = {}) {
  const items = [], surveys = [], errors = [];
  const files = fs.entries.filter(e => CANDIDATE.test(e.rel));
  for (let k = 0; k < files.length; k++) {
    if (signal?.aborted) throw Object.assign(new Error('Import cancelled.'), { name: 'AbortError' });
    const e = files[k];
    progress(k / files.length, `Reading ${e.rel}`);
    const text = await e.text();
    if (!sniffShared(text.slice(0, 4096)) && !sniffShared(text)) continue;
    const r = parseResponses(text, { file: e.rel.split('/').pop() });
    items.push(...r.responses); surveys.push(...r.surveys); errors.push(...r.errors);
  }
  const result = recombine(items, { surveys });
  result.invalid.push(...errors);
  if (!result.survey) {
    builder.beginSource({ format: 'shared-survey', family: 'survey', medium: 'survey', view: 'full', context: 'survey', fileNames: files.map(f => f.rel) });
    for (const x of result.invalid) builder.warn('survey-invalid', `${x.file || 'A file'} could not be used: ${x.reason}.`);
    throw new Error(result.invalid.length ? `No usable response: ${result.invalid.map(x => `${x.file || 'a file'} (${x.reason})`).join('; ')}.` : 'No Org Signal survey responses found.');
  }
  const mergeRule = MERGE_RULES.some(m => m.id === options.mergeRule) ? options.mergeRule : null;
  const first = builder.sources.length;
  writeRecombined(builder, result, { mergeRule, fileNames: files.map(f => f.rel) });
  for (const s of builder.sources) if (s.format === 'shared-survey') s.counts.responses = result.accepted.length;
  // The survey's title names the data (C13: "SOC 101 friendship (union)").
  if (result.survey.kind === 'roster') for (const s of builder.sources.slice(first)) { if (!s.nominations) s.nominations = nominationsOf(result); if (!s.title) s.title = result.survey.title; }
  progress(1, 'Recombined');
}

// Who named whom, per relation, in the roster builder's respondent shape
// (ties[relation]['me|them'] = value, attrs = tie fields), with the roster
// and relations needed to recombine it.
export function nominationsOf(result) {
  const def = result.survey;
  return {
    version: 1, title: def.title,
    people: def.people.map(p => ({ id: p.id, label: p.label })),
    relations: def.relations,
    respondents: rosterRespondents(result).map(r => ({ personId: r.personId, label: r.label, ties: r.ties, attrs: r.attrs })),
  };
}

// Rule words for dataset names: "SOC101 A4 friendship (reciprocated)".
export const RULE_NAME = { union: 'union', intersection: 'reciprocated', respondent: 'as reported' };
const RULE_IN_NAME = /\s*\((union|reciprocated( only)?|intersection|as reported)\)\s*$/i;

// The survey source a dataset can be recombined from: exactly one source
// with events, carrying nominations. Null otherwise (merged data, network
// files, a project saved before nominations were kept).
export function rederivableSource(ds) {
  const srcs = ds?.meta?.sources || [];
  const withNom = srcs.filter(s => s.nominations?.respondents);
  if (withNom.length !== 1) return null;
  const sid = srcs.indexOf(withNom[0]);
  const ev = ds.events;
  for (let i = 0; i < ev.count; i++) if (ev.source[i] !== sid) return null;
  return withNom[0];
}

// The same responses combined with another rule ('union' | 'intersection' |
// 'respondent'). People keep their key ('roster:<name>'), so attributes
// joined later (a major from a roster CSV) and the join record carry over.
export function rederiveSurvey(ds, rule) {
  const src = rederivableSource(ds);
  if (!src) throw new Error('This data does not keep who named whom, so it cannot be recombined. Import the response files again and choose the rule there.');
  const r = MERGE_RULES.find(m => m.id === rule);
  if (!r) throw new Error(`Unknown combine rule "${rule}".`);
  const nom = src.nominations;
  const name = `${String(ds.meta.name || nom.title || 'Survey').replace(RULE_IN_NAME, '')} (${RULE_NAME[rule]})`;
  const b = new DatasetBuilder({ name });
  writeRoster(b, {
    name, people: nom.people.map(p => ({ id: p.id, label: p.label, attrs: {} })), attrColumns: [], relations: nom.relations,
    mode: 'multi', ties: {}, tieAttrs: {}, responses: { respondents: nom.respondents, file: null }, mergeRule: rule,
  }, { source: { format: src.format, fileNames: src.fileNames || [], ...(src.survey ? { survey: src.survey } : {}), nominations: nom } });
  // The response notes stay; the lines the roster writer makes again (the
  // tie weight under the new rule) come from it, and the combine line names
  // the new rule.
  const regen = new Set(['combine-rule', 'roster-tie-weight', 'roster-nonrespondents']);
  const fuller = (src.warnings || []).some(w => w.code === 'survey-nonrespondents');
  const fresh = b.source.warnings.filter(w => w.code !== 'combine-rule' && !(w.code === 'roster-nonrespondents' && fuller));
  b.source.warnings = [...(src.warnings || []).filter(w => !regen.has(w.code)), ...fresh, { code: 'combine-rule', message: `Combined with ${r.label}: ${r.help}`, count: 1, severity: 'info' }];
  if (src.counts?.responses != null) b.source.counts.responses = src.counts.responses;
  const out = b.build();
  const old = new Map(ds.nodes.keys.map((k, i) => [k, i]));
  const attrs = out.nodes.attrs.map((a, i) => { const j = old.get(out.nodes.keys[i]); return j === undefined ? a : { ...ds.nodes.attrs[j], ...a }; });
  return {
    ...out,
    nodes: { ...out.nodes, attrs },
    // Types and labels set earlier (major as a choice) are kept.
    attributeSchema: inferAttributeSchema(attrs).map(x => (ds.attributeSchema || []).find(y => y.key === x.key) || x),
    meta: { ...out.meta, ...(ds.meta.profileJoins ? { profileJoins: ds.meta.profileJoins } : {}), createdAt: ds.meta.createdAt ?? out.meta.createdAt },
  };
}

export default {
  id: 'shared-survey',
  label: 'Shared survey responses',
  family: 'survey',
  detect,
  options: [
    { key: 'mergeRule', label: 'Combine self-reports (roster surveys)', type: 'select', default: 'survey',
      choices: [{ value: 'survey', label: "The survey's own rule" }, ...MERGE_RULES.map(m => ({ value: m.id, label: m.label }))] },
  ],
  import: importResponses,
};
