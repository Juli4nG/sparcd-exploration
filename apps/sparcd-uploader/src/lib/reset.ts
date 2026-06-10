import { db } from './db';

// Logout teardown. A SPARC'd tool is BYO-credentials and often shared on one
// machine, so logging out must leave nothing of the previous user behind:
// otherwise their resumable upload sessions (folder handles, per-file progress)
// would surface for whoever connects next. The caller pushes or discards any
// in-progress work before this runs.

/** Wipe all of this browser's local uploader data, then reload onto the connect
 *  gate. The caller has already nulled the connection (`disconnect`), so the
 *  reload rebuilds every in-memory store clean. */
export async function resetLocalState(): Promise<void> {
  await Promise.all([db.batches.clear(), db.files.clear(), db.bundles.clear()]);
  location.reload();
}
