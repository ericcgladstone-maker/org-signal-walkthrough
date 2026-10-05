// Analysis worker. Holds the dataset and current network; see
// src/analysis/host.js for the message protocol and src/analysis/engine.js for
// the main-thread side.

import { attachWorker } from '../analysis/host.js';

attachWorker(self);
