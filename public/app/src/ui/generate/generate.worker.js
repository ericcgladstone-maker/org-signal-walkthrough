// Module worker for the synthetic generator. Keeps the last generated dataset
// and ground truth (of a "Generate and analyze" run) so the recovery check
// can run here too, off the UI thread, without copying them back in.
//
// in:  { type: 'generate', id, spec }
//      { type: 'recovery', id, seed, runId, settings?, groundTruth?, dataset? }
//        runId is the id of the generate run to check; when this worker no
//        longer holds that run (it was restarted after a cancel), the caller
//        sends the ground truth and dataset along.
// out: { type: 'progress', id, fraction, message }
//      { type: 'done', id, result }     (result.download.bytes transferred when present)
//      { type: 'recovery', id, result } |  { type: 'error', id, message }

import { runGenerate, runRecovery } from './run.js';

let last = null; // { runId, groundTruth, dataset }

self.onmessage = async ({ data }) => {
  const { type, id } = data;
  try {
    if (type === 'generate') {
      const res = await runGenerate(data.spec, (fraction, message) => self.postMessage({ type: 'progress', id, fraction, message }));
      // A native download does not replace the run being checked.
      if (data.spec.output !== 'native') last = { runId: id, groundTruth: res.groundTruth, dataset: res.dataset };
      // The dataset is copied rather than transferred so the worker keeps its
      // own copy for the recovery check.
      self.postMessage({ type: 'done', id, result: res }, res.download ? [res.download.bytes.buffer] : []);
    } else if (type === 'recovery') {
      const run = data.groundTruth ? data : last && last.runId === data.runId ? last : null;
      if (!run) throw new Error('Generate a dataset first.');
      self.postMessage({ type: 'recovery', id, result: await runRecovery(run.groundTruth, run.dataset, { seed: data.seed, settings: data.settings || null }) });
    }
  } catch (e) {
    self.postMessage({ type: 'error', id, message: e?.message || String(e) });
  }
};
