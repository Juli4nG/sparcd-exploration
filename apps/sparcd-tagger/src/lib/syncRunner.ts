// Glue between the React layer and the pure `runSync` orchestrator: it pulls the
// grounded base + time offset + any resume journal out of Dexie, builds the
// injected S3 IO, runs the sync, and re-grounds on the freshly written canonical
// state so the next sync starts clean. The UI keeps the result and drives the
// store/query side-effects (it owns those React handles).

import type { S3Config } from '@sparcd/types';
import { buildSyncPlan, runSync, runRestore, type SyncResult } from './sync';
import { makeSyncIO, loadCanonicalState, loadSnapshotBodies } from './s3';
import {
  getUpload,
  groundUpload,
  loadSyncJournal,
  saveSyncJournal,
  clearSyncJournal,
  type DraftRecord,
} from './db';
import type { TagImage } from './workspace';

export type SyncArgs = {
  cfg: S3Config;
  bucket: string;
  uploadPrefix: string;
  user: string;
  images: TagImage[];
  drafts: Record<string, DraftRecord>;
  dryRun: boolean;
};

/**
 * Run one sync (dry-run or live). Resumes a prior partial sync if a journal
 * exists for this upload; otherwise diffs drafts against the grounded base and
 * writes. On a successful live write it re-grounds on the new canonical state.
 */
export async function performSync(args: SyncArgs): Promise<SyncResult> {
  const { cfg, bucket, uploadPrefix, user, images, drafts, dryRun } = args;

  // The workspace grounds on load; ground here too as a fallback so a sync is
  // never run against a missing base.
  let base = await getUpload(bucket, uploadPrefix);
  if (!base?.mediaETag) {
    const state = await loadCanonicalState(cfg, bucket, uploadPrefix);
    await groundUpload(bucket, uploadPrefix, state);
    base = await getUpload(bucket, uploadPrefix);
  }

  const plan = buildSyncPlan(images, drafts, base?.timeOffset ?? null);
  const resumeJournal = await loadSyncJournal(bucket, uploadPrefix);

  const io = makeSyncIO(cfg, bucket, uploadPrefix, {
    save: saveSyncJournal,
    clear: () => clearSyncJournal(bucket, uploadPrefix),
  });

  const result = await runSync(
    {
      bucket,
      uploadPrefix,
      user,
      base: {
        media: { etag: base?.mediaETag ?? '' },
        observations: { etag: base?.observationsETag ?? '' },
        uploadMeta: { etag: base?.uploadMetaETag ?? '' },
      },
      plan,
      dryRun,
      resumeJournal,
    },
    io,
  );

  if (result.status === 'synced' && !dryRun) {
    const fresh = await loadCanonicalState(cfg, bucket, uploadPrefix);
    await groundUpload(bucket, uploadPrefix, fresh);
  }
  return result;
}

export type RestoreArgs = {
  cfg: S3Config;
  bucket: string;
  uploadPrefix: string;
  user: string;
  /** Full snapshot prefix `<uploadPrefix>.sparcd-tagger-snapshots/<user>/<stamp>/`. */
  snapshotPrefix: string;
  dryRun: boolean;
};

/**
 * Restore a chosen snapshot (dry-run or live). Loads the snapshot bodies, runs
 * them back through the conditional-replacement flow, and — on a successful live
 * write — re-grounds on the now-restored canonical state. Resumes a prior
 * partial sync/restore journal if one exists for this upload (the journal must
 * be finished before a new write begins).
 */
export async function performRestore(args: RestoreArgs): Promise<SyncResult> {
  const { cfg, bucket, uploadPrefix, user, snapshotPrefix, dryRun } = args;

  const bodies = await loadSnapshotBodies(cfg, bucket, snapshotPrefix);
  const resumeJournal = await loadSyncJournal(bucket, uploadPrefix);

  const io = makeSyncIO(cfg, bucket, uploadPrefix, {
    save: saveSyncJournal,
    clear: () => clearSyncJournal(bucket, uploadPrefix),
  });

  const result = await runRestore({ bucket, uploadPrefix, user, bodies, dryRun, resumeJournal }, io);

  if (result.status === 'synced' && !dryRun) {
    const fresh = await loadCanonicalState(cfg, bucket, uploadPrefix);
    await groundUpload(bucket, uploadPrefix, fresh);
  }
  return result;
}
