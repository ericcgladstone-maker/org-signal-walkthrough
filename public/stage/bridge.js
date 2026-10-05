// Loaded into the app's iframe by the stage (a same-origin module script, so
// the app's Content-Security-Policy, script-src 'self', allows it). It imports
// the app's own store module by the same URL the app uses, so it gets the
// same module instance, and offers dynamic import inside the app's realm so
// the stage can call the app's own APIs (generateAndAnalyze, loadClassic,
// the share and generator services) on the running app.
import { store } from '../app/src/ui/store.js';

window.__bridge = {
  store,
  imp: path => import(path),
};
