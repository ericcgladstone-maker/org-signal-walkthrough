// Import worker. Parsing big exports (Slack zips, mboxes, calendars) happens
// here so the page stays responsive. The main thread talks to it through
// importInWorker() in src/core/pipeline.js.
//
// Messages in:  { type: 'run' | 'detect', files: [{ blob, path }], opts: { choices, options, name } }
// Messages out: { type: 'progress', fraction, message }
//               { type: 'done', result }   result = { dataset, report, detections, plan, unclaimed }
//                                          (detect: { detections, files } with the number of files seen)
//               { type: 'error', message, name, stack }
// Cancel = the main thread terminates the worker; nothing here needs to clean up.

import { runImport, detectImports, toFileSet } from '../core/pipeline.js';
import { toTransfer } from '../core/model.js';

// Exported so tests can drive the worker logic without a Worker.
export async function handle(msg, post) {
  try {
    let last = 0;
    // Throttle: progress messages are cheap but thousands per second still flood the main thread.
    const progress = (fraction, message) => {
      const now = Date.now();
      if (now - last < 50 && fraction < 1) return;
      last = now;
      post({ type: 'progress', fraction, message });
    };
    if (msg.type === 'detect') {
      const fs = await toFileSet(msg.files);
      post({ type: 'done', result: { detections: await detectImports(fs, { progress }), files: fs.entries.length } });
      return;
    }
    if (msg.type !== 'run') throw new Error(`Unknown message type "${msg.type}".`);
    const result = await runImport(msg.files, { ...(msg.opts || {}), progress });
    const { payload, transfer } = toTransfer(result.dataset);
    post({ type: 'done', result: { ...result, dataset: payload } }, transfer);
  } catch (e) {
    post({ type: 'error', message: e?.message || String(e), name: e?.name, stack: e?.stack });
  }
}

// Only wire up when running as a worker (self exists, no window/document).
if (typeof self !== 'undefined' && typeof self.postMessage === 'function' && typeof window === 'undefined') {
  self.addEventListener('message', (ev) => handle(ev.data || {}, (m, transfer) => self.postMessage(m, transfer || [])));
}
