// Drives the worker pool from a module scope, not a component, so processing
// keeps running while the user switches sections or scrolls. `ensure` is
// idempotent per batch token: a new batch cancels the prior run and starts a
// fresh one; re-entering the inspect step with the same batch is a no-op.

import { processBatch, type ProcessRun, type ProcessResponse } from './processPool';
import { posterFor } from './videoPoster';
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

  // Videos can't be decoded in the worker; grab a poster frame on the main
  // thread once the worker reports a video ready. Best-effort — a failure just
  // leaves the typed placeholder tile in the file list.
  const onResult = (r: ProcessResponse): void => {
    applyResult(r);
    if (!r.error && r.mediaKind === 'video' && !r.thumbnail) {
      const entry = useStore.getState().files.find((f) => f.id === r.id);
      if (entry) {
        void posterFor(entry.file).then((poster) => {
          if (poster) useStore.getState().setThumbnail(r.id, poster);
        });
      }
    }
  };

  run = processBatch(
    queued.map((f) => ({ id: f.id, file: f.file, fileKind: f.mediaKind })),
    markProcessing,
    onResult,
  );
  run.done.then(() => {
    // Only clear if this is still the active run (a newer batch may have taken over).
    if (runningToken === batchToken) useStore.getState().setProcessing(false);
  });
}
