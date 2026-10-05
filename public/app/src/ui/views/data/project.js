// Org Signal project files: saving one, recognizing one wherever it is
// dropped (Data or Methods & Export, C9), and opening it. A project holds the
// combined dataset and the construction settings; for a roster survey the
// dataset also keeps who named whom, so it can be recombined with another
// rule after opening (src/importers/survey-response.js rederiveSurvey).

import { store } from '../../store.js';
import { toJSON, fromJSON, MODEL_VERSION } from '../../../core/model.js';
import { pathOf, blobOf } from './io.js';

const MARK = /"format"\s*:\s*"org-signal-project"/;

// The project file's text: a small head, then the dataset, so the head can be
// sniffed from the first bytes.
export function projectText(state) {
  const ds = state.dataset;
  const head = JSON.stringify({ format: 'org-signal-project', version: 1, modelVersion: MODEL_VERSION, savedAt: new Date().toISOString(), name: ds.meta.name, settings: state.settings });
  return `${head.slice(0, -1)},"dataset":${toJSON(ds)}}`;
}

// Is this dropped input a project file? Single .json file whose first bytes
// carry the project mark.
export async function isProjectInput(input) {
  if (input.kind !== 'file' || input.files.length !== 1) return false;
  const f = input.files[0];
  if (!/\.json$/i.test(pathOf(f))) return false;
  try { return MARK.test(await blobOf(f).slice(0, 2048).text()); } catch { return false; }
}

// Read and check a project file (File or Blob) -> the parsed project.
export async function readProject(file) {
  let obj;
  try { obj = fromJSON(await blobOf(file).text()); } catch { throw new Error('This file is not valid JSON, so it is not an Org Signal project file.'); }
  if (obj?.format !== 'org-signal-project' || !obj.dataset?.nodes) throw new Error('This is not an Org Signal project file.');
  if (obj.modelVersion > MODEL_VERSION) throw new Error(`This project was saved by a newer version of Org Signal (data model ${obj.modelVersion}).`);
  return obj;
}

// What the Data view says about a project before it is opened.
export function projectSummary(obj) {
  const ds = obj.dataset;
  const survey = (ds.meta?.sources || []).find(s => s.family === 'survey');
  return {
    name: obj.name || ds.meta?.name || 'Project',
    savedAt: obj.savedAt || null,
    people: ds.nodes?.count ?? 0,
    events: ds.events?.count ?? 0,
    sources: (ds.meta?.sources || []).length,
    survey: !!survey,
    nominations: !!(ds.meta?.sources || []).some(s => s.nominations?.respondents),
  };
}

// Load a read project: the dataset replaces what is loaded, then the saved
// construction settings are applied.
export async function openProject(obj) {
  await store.actions.loadDataset(obj.dataset, { mode: 'replace' });
  store.set({ datasets: [obj.dataset] });
  if (obj.settings) await store.actions.rebuild({ ...store.get().settings, ...obj.settings }, { quiet: true });
  store.actions.notify('info', `Opened ${obj.name || 'project'}.`);
}
