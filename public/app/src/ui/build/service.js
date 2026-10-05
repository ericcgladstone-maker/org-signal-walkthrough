// Every call the Build view makes outside its own folder goes through here,
// so a missing or changed module in another owner's area shows up in one
// place as a neutral "not available yet" instead of a crash.
//
//   handOff(ds, { mode })     -> store.actions.loadDataset (owned by ui-core)
//   notify(level, text)       -> store.actions.notify
//   loadSurveyImporter()      -> src/importers/survey.js (owned by importers-A), or null
//   importRosterResponses(file, opts) -> survey importer if it understands the file, else null
//   currentDataset()          -> the active Dataset, used as a reference network

import { EVENT_TYPES } from '../../core/model.js';
import { store } from '../store.js';

export function notify(level, text) {
  try {
    if (typeof store.actions.notify === 'function') return store.actions.notify(level, text);
  } catch (e) { console.warn('notify failed', e); }
  // No shell yet (standalone harness): keep a visible trace without throwing.
  store.set({ notice: { level, text } });
  if (level === 'error') console.warn('[build]', text); else console.info('[build]', text);
}

export function canHandOff() {
  return typeof store.actions.loadDataset === 'function';
}

// Hand a finished Dataset to the app. mode 'replace' starts a fresh analysis;
// 'add' merges it with what is loaded (ui-core decides how).
export async function handOff(ds, { mode = 'replace', view = 'network' } = {}) {
  if (!canHandOff()) {
    notify('warn', 'The analysis views are not connected in this build, so the network could not be opened. Export it instead.');
    return false;
  }
  try {
    await store.actions.loadDataset(ds, { mode });
    if (view && typeof store.actions.setView === 'function') store.actions.setView(view);
    // Hand-built networks are all reported ties; generated ones are messages and other events.
    const declaredOnly = ds.events.type.every(t => t === EVENT_TYPES.indexOf('declared'));
    notify('info', `Loaded ${ds.meta.name}: ${ds.nodes.count.toLocaleString('en-US')} people, ${ds.events.count.toLocaleString('en-US')} ${declaredOnly ? 'reported ties' : 'events'}.`);
    return true;
  } catch (e) {
    notify('error', `Could not load the network: ${e.message}`);
    return false;
  }
}

export function currentDataset() {
  return store.get().dataset ?? null;
}

let surveyMod;
export async function loadSurveyImporter() {
  if (surveyMod !== undefined) return surveyMod;
  try {
    const m = await import('../../importers/survey.js');
    surveyMod = m.default ?? m;
  } catch {
    surveyMod = null;
  }
  return surveyMod;
}

// Try the survey importer on a responses CSV. Returns a Dataset or null when
// the importer is missing or does not recognise the file; the roster builder
// then falls back to its own documented roster-matrix parser.
export async function importRosterResponses(file) {
  const imp = await loadSurveyImporter();
  if (!imp || typeof imp.import !== 'function') return null;
  try {
    const [{ FileSet }, { DatasetBuilder }] = await Promise.all([import('../../core/fileset.js'), import('../../core/model.js')]);
    const fs = await FileSet.from([{ blob: file, path: file.name || 'responses.csv' }]);
    if (typeof imp.detect === 'function') {
      const d = await imp.detect(fs);
      if (!d || d.score < 0.5) return null;
    }
    const builder = new DatasetBuilder({ name: file.name || 'Survey responses' });
    await imp.import(fs, { builder, options: {}, progress: () => {}, signal: undefined });
    return builder.build();
  } catch (e) {
    console.warn('survey importer failed; using built-in roster parser', e);
    return null;
  }
}
