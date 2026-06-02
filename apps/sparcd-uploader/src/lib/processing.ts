// Drives the worker pool from a module scope, not a component, so processing
// keeps running while the user switches sections or scrolls. `ensure` is
// idempotent per batch token: a new batch cancels the prior run and starts a
// fresh one; re-entering the inspect step with the same batch is a no-op.

import { processBatch, type ProcessRun } from './processPool';
import { useStore } from '../store';

let run: ProcessRun | null = null;
let runningToken = -1;

export function ensureProcessing(): void {
  const { batchToken, files } = useStore.getState();
  if (runningToken === batchToken) return;

  run?.cancel();
  runningToken = batchToken;

  const queued = files.filter((f) => f.processState === 'queued');
  if (queued.length === 0) {
    run = null;
    return;
  }

  const { markProcessing, applyResult, setProcessing } = useStore.getState();
  setProcessing(true);
  run = processBatch(
    queued.map((f) => ({ id: f.id, file: f.file })),
    markProcessing,
    applyResult,
  );
  run.done.then(() => {
    // Only clear if this is still the active run (a newer batch may have taken over).
    if (runningToken === batchToken) useStore.getState().setProcessing(false);
  });
}
