// Upload orchestration. Runs the full publish sequence for one bundle:
//
//   1. Stream every image blob under the upload prefix (bounded concurrency,
//      exponential backoff + jitter on transient failures, HEAD verify).
//   2. Write the three CSVs.
//   3. Write UploadMeta.json — upstream SPARC'd's completion marker, so it
//      lands after the blobs and CSVs.
//   4. Write UploadComplete.json last — this project's richer integrity sentinel.
//
// Ordering is the half-populated-directory guard: an upstream reader only
// treats the prefix as complete once UploadMeta.json exists, by which point
// the blobs and CSVs are already in place.
//
// Dry-run (default on for the first session) walks the same sequence but issues
// no PUTs — it logs every write the run would make (bucket, key, size, hash) —
// and persists nothing, since there is nothing to resume.
//
// Re-stamp retry (fresh runs only): a 412 on any final-prefix metadata object
// means another uploader took this `<stamp>_<user>` prefix. We abandon it, bump
// the stamp by one second, rebuild the bundle (new prefix → new keys), and
// retry the whole run once; a second collision surfaces. Abandoned blobs are
// orphans — this tool never deletes (open question 5 lean: auto-retry once,
// then surface).
//
// Resume (P5): a wet run persists its session to IndexedDB (Dexie) and updates
// per-file state as blobs land. `resumeUpload` replays a persisted session
// against reattached source files — completed blobs are skipped after a
// statObject size/hash sanity check, and interrupted files restart from
// scratch (mid-file multipart resume is a follow-on, not v0). The prefix is
// reused, so a 412 on a metadata write is treated as "already written, skip"
// rather than a re-stamp.
//
// Bounded concurrency is a small inline lane pool rather than p-limit: lanes
// lazily pull the next blob, so memory stays flat across thousands of files and
// a hard failure aborts the in-flight set at once.

import type { S3Config } from '@sparcd/types';
import { PreconditionFailedError } from '@sparcd/s3-safe';
import { getClient } from './s3';
import { buildBundle, type BuildInput, type BundlePreview, type UploadItem } from './bundle';
import {
  fileRecordId,
  saveSession,
  markFileState,
  markBatchComplete,
  type BatchRecord,
  type BundleRecord,
  type FileAccessMode,
  type FileRecord,
  type LoadedSession,
} from './db';

export type UploadPhase = 'idle' | 'blobs' | 'metadata' | 'partial' | 'done' | 'error';
export type FileState = 'pending' | 'uploading' | 'verifying' | 'done' | 'skipped' | 'failed';

export type FileProgress = {
  id: string;
  key: string;
  size: number;
  loaded: number;
  state: FileState;
  attempt: number;
  error?: string;
};

export type LogLine = { kind: 'put' | 'info' | 'warn' | 'error'; text: string };

export type UploadSnapshot = {
  version: number; // bumped each emit so React re-renders the live arrays
  sessionId: string;
  phase: UploadPhase;
  dryRun: boolean;
  files: FileProgress[];
  uploadedBytes: number;
  totalBytes: number;
  log: LogLine[];
  uploadPath?: string;
  bucket: string;
  metadataBundleSha256?: string;
  error?: string;
};

export type UploadParams = {
  config: S3Config;
  build: Omit<BuildInput, 'now'>;
  dryRun: boolean;
  concurrency: number; // parallel blob lanes
  // Resume metadata persisted in the batch row; absent for dry runs.
  uploaderUser?: string; // raw identity (the slug lives in build.uploaderSlug)
  fileAccessMode?: FileAccessMode;
  dirHandle?: FileSystemDirectoryHandle | null;
};

export type ResumeParams = {
  config: S3Config;
  session: LoadedSession;
  attached: Map<string, File>; // localPath → reattached source file
  concurrency: number;
};

export type UploadRun = { cancel: () => void; done: Promise<void> };

const METADATA_RETRY = 1; // re-stamp attempts after the first
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;
// Ten independent blob failures usually means credentials, CORS, or endpoint policy, not bad files.
const MAX_FILE_FAILURES = 10;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Clock-skew errors surface as a 403 but are worth retrying: against a
// load-balanced MinIO, a single node that has drifted off NTP rejects a request
// as skewed while its siblings accept it, so a retry usually lands on a healthy
// node. (The front proxy stamps a correct Date header, so the SDK's own
// clock-skew correction can't fix it — the app-level retry is what recovers.)
const CLOCK_SKEW_CODES = new Set(['RequestTimeTooSkewed', 'RequestExpired', 'RequestInTheFuture']);

// A 412 (precondition) or an access denial is never worth retrying; network
// blips, 5xx, 429, and clock-skew are. Default to transient only when we
// recognize it.
function isTransient(err: unknown): boolean {
  if (err instanceof PreconditionFailedError) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  if (e.name && CLOCK_SKEW_CODES.has(e.name)) return true;
  const status = e.$metadata?.httpStatusCode;
  if (status === undefined) return true; // network/CORS/DNS — worth a retry
  if (status >= 500 || status === 429) return true;
  return false;
}

function isRunFatalBlobError(err: unknown): boolean {
  if (err instanceof PreconditionFailedError) return true;
  const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
  return status === 403 || status === 501;
}

// Full jitter: random in [0, base * 2^attempt].
const backoff = (attempt: number) => Math.random() * (BASE_BACKOFF_MS * 2 ** attempt);

// A statObject 404 (the object isn't there) is a recognizable shape; anything
// without a 2xx/expected stat means "re-upload".
function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e.$metadata?.httpStatusCode === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey';
}

/** A single blob to (maybe) upload, with whether the persisted state says done. */
type PlanItem = {
  id: string;
  localPath: string;
  fileName: string;
  objectName: string;
  key: string;
  size: number;
  sha256: string;
  captureTimestamp?: string;
  mediaKind: FileRecord['mediaKind'];
  mimeType: string;
  file: File | null;
  doneAlready: boolean;
};

type RunPlan = {
  sessionId: string;
  bucket: string;
  uploadPath: string;
  totalBytes: number;
  metadataBundleSha256: string;
  items: PlanItem[];
  writes: { name: string; body: string; contentType: string }[];
};

const metadataWrites = (b: {
  deploymentsCsv: string;
  mediaCsv: string;
  observationsCsv: string;
  uploadMetaJson: string;
  uploadCompleteJson: string;
}): RunPlan['writes'] => [
  { name: 'deployments.csv', body: b.deploymentsCsv, contentType: 'text/csv' },
  { name: 'media.csv', body: b.mediaCsv, contentType: 'text/csv' },
  { name: 'observations.csv', body: b.observationsCsv, contentType: 'text/csv' },
  { name: 'UploadMeta.json', body: b.uploadMetaJson, contentType: 'application/json' },
  { name: 'UploadComplete.json', body: b.uploadCompleteJson, contentType: 'application/json' },
];

const planFromBundle = (sessionId: string, bundle: BundlePreview): RunPlan => ({
  sessionId,
  bucket: bundle.bucket,
  uploadPath: bundle.uploadPath,
  totalBytes: bundle.totalBytes,
  metadataBundleSha256: bundle.metadataBundleSha256,
  items: bundle.items.map((it: UploadItem) => ({
    id: it.id,
    localPath: it.localPath,
    fileName: it.fileName,
    objectName: it.objectName,
    key: it.key,
    size: it.size,
    sha256: it.sha256,
    captureTimestamp: it.captureTimestamp,
    mediaKind: it.mediaKind,
    mimeType: it.mimeType,
    file: it.file,
    doneAlready: false,
  })),
  writes: metadataWrites(bundle),
});

const fileRecordFor = (sessionId: string, it: PlanItem, state: FileRecord['state']): FileRecord => ({
  id: fileRecordId(sessionId, it.localPath),
  sessionId,
  localPath: it.localPath,
  fileName: it.fileName,
  relPathInBundle: it.objectName,
  sanitizedObjectName: it.objectName,
  size: it.size,
  sha256: it.sha256,
  captureTimestamp: it.captureTimestamp,
  mediaKind: it.mediaKind,
  mimeType: it.mimeType,
  state,
  remoteKey: it.key,
  attempt: 0,
});

/**
 * The shared executor over a RunPlan. Used by both a fresh run and a resume; the
 * differences are: `persist` (write Dexie state as blobs land), `isResume`
 * (treat a metadata 412 as already-written rather than a collision to re-stamp),
 * and `dryRun` (log only).
 */
function makeRunner(
  config: S3Config,
  concurrency: number,
  onUpdate: (snap: UploadSnapshot) => void,
  opts: { persist: boolean; isResume: boolean; dryRun: boolean },
) {
  const { persist, isResume, dryRun } = opts;
  const client = getClient(config);
  let cancelled = false;
  let abort = new AbortController();

  const snap: UploadSnapshot = {
    version: 0,
    sessionId: '',
    phase: 'idle',
    dryRun,
    files: [],
    uploadedBytes: 0,
    totalBytes: 0,
    log: [],
    bucket: '',
  };

  let lastEmit = 0;
  const emit = (force = false) => {
    const now = Date.now();
    if (!force && now - lastEmit < 120) return; // coalesce byte-progress spam
    lastEmit = now;
    snap.version++;
    onUpdate({ ...snap });
  };
  const log = (kind: LogLine['kind'], text: string) => {
    snap.log.push({ kind, text });
    emit(true);
  };

  const persistFile = (sessionId: string, localPath: string, patch: Partial<FileRecord>) => {
    if (persist) void markFileState(fileRecordId(sessionId, localPath), patch);
  };

  // Upload (or skip) one blob. Returns once the object is present and verified,
  // or throws on a non-recoverable failure.
  const processItem = async (sessionId: string, fp: FileProgress, it: PlanItem): Promise<void> => {
    // A completed blob from a prior run: sanity-check the remote copy before
    // skipping it. Size + recorded SHA-256 metadata is the portable contract.
    const verifyExisting = async (): Promise<boolean> => {
      try {
        const stat = await client.statObject(snap.bucket, it.key);
        if (stat.size === it.size && stat.metadata.sha256 === it.sha256) {
          fp.state = 'skipped';
          snap.uploadedBytes += it.size - fp.loaded;
          fp.loaded = it.size;
          log('info', `verified, skip: ${it.key}`);
          emit(true);
          return true;
        }
        log('warn', `remote mismatch: ${it.key}`);
      } catch (err) {
        if (isNotFound(err)) log('warn', `remote missing, re-uploading: ${it.key}`);
        else throw err;
      }
      return false;
    };

    if (it.doneAlready) {
      if (await verifyExisting()) return;
    }

    if (!it.file) {
      fp.state = 'failed';
      fp.error = 'source file unavailable — reselect the folder';
      persistFile(sessionId, it.localPath, { state: 'failed', lastError: fp.error });
      log('error', `${it.key}: ${fp.error}`);
      throw new Error(fp.error);
    }

    for (let attempt = 0; ; attempt++) {
      if (cancelled) throw new Error('cancelled');
      fp.attempt = attempt + 1;
      fp.state = 'uploading';
      snap.uploadedBytes -= fp.loaded; // reset this file's contribution on retry
      fp.loaded = 0;
      emit(true);
      try {
        const { etag } = await client.writeImmutableStream(snap.bucket, it.key, it.file, {
          sha256: it.sha256,
          contentType: it.mimeType,
          signal: abort.signal,
          onProgress: (loaded) => {
            snap.uploadedBytes += loaded - fp.loaded;
            fp.loaded = loaded;
            emit();
          },
        });
        // Portable verification: HEAD and confirm size + recorded digest.
        fp.state = 'verifying';
        emit(true);
        const stat = await client.statObject(snap.bucket, it.key);
        if (stat.size !== fp.size) throw new Error(`size mismatch (${stat.size} ≠ ${fp.size})`);
        if (stat.metadata.sha256 !== it.sha256) throw new Error('sha256 metadata mismatch');
        fp.state = 'done';
        persistFile(sessionId, it.localPath, {
          state: 'done',
          remoteETag: etag,
          attempt: fp.attempt,
        });
        emit(true);
        return;
      } catch (err) {
        if (err instanceof PreconditionFailedError) {
          // Fresh runs must not silently accept a blob collision. Resume can
          // accept an existing key only after the portable size/hash HEAD check.
          if (isResume && (await verifyExisting())) {
            persistFile(sessionId, it.localPath, { state: 'done' });
            return;
          }
          throw err;
        }
        // A user cancel or a sibling lane's fatal failure aborts the signal;
        // don't retry an aborted request — let the run unwind.
        if (cancelled || abort.signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt + 1 >= MAX_ATTEMPTS || !isTransient(err)) {
          fp.state = 'failed';
          fp.error = msg;
          persistFile(sessionId, it.localPath, { state: 'failed', lastError: msg, attempt: fp.attempt });
          log('error', `failed ${it.key}: ${msg}`);
          throw err;
        }
        const wait = backoff(attempt);
        log('warn', `retry ${it.key} (attempt ${attempt + 2}) after ${Math.round(wait)}ms: ${msg}`);
        await sleep(wait);
      }
    }
  };

  // One attempt at the whole sequence for a given plan. Throws
  // PreconditionFailedError on a final-prefix metadata collision (fresh runs
  // re-stamp; resumes skip).
  const runOnce = async (plan: RunPlan): Promise<void> => {
    abort = new AbortController(); // fresh signal per attempt
    snap.sessionId = plan.sessionId;
    snap.bucket = plan.bucket;
    snap.uploadPath = plan.uploadPath;
    snap.metadataBundleSha256 = plan.metadataBundleSha256;
    snap.totalBytes = plan.totalBytes;
    snap.uploadedBytes = 0;
    snap.files = plan.items.map((it) => ({
      id: it.id,
      key: it.key,
      size: it.size,
      loaded: 0,
      state: 'pending' as FileState,
      attempt: 0,
    }));
    const byId = new Map(snap.files.map((f) => [f.id, f]));

    // --- Phase 1: blobs ---
    snap.phase = 'blobs';
    const remaining = plan.items.filter((it) => !it.doneAlready).length;
    log(
      'info',
      `${plan.items.length} blobs → ${plan.uploadPath}/` +
        (remaining !== plan.items.length ? ` (${plan.items.length - remaining} already done)` : ''),
    );

    if (dryRun) {
      for (const it of plan.items) {
        const fp = byId.get(it.id)!;
        fp.state = 'done';
        fp.loaded = it.size;
        snap.uploadedBytes += it.size;
        log('put', `PUT ${snap.bucket}/${it.key} (${it.size} B, sha256 ${it.sha256.slice(0, 12)}…)`);
      }
      emit(true);
    } else {
      let next = 0;
      let fatal: unknown = null;
      let fileFailures = 0;
      const lane = async (): Promise<void> => {
        for (;;) {
          if (cancelled || fatal) return;
          const i = next++;
          if (i >= plan.items.length) return;
          const it = plan.items[i];
          try {
            await processItem(plan.sessionId, byId.get(it.id)!, it);
          } catch (err) {
            if (cancelled || abort.signal.aborted) return;
            if (isRunFatalBlobError(err)) {
              if (!fatal) {
                fatal = err;
                abort.abort(); // stop sibling lanes' in-flight requests at once
              }
              return;
            }
            fileFailures++;
            if (fileFailures >= MAX_FILE_FAILURES && !fatal) {
              fatal = new Error(
                `aborted after ${MAX_FILE_FAILURES} file failures — the problem looks systemic, not per-file`,
              );
              abort.abort(); // stop sibling lanes' in-flight requests at once
              return;
            }
            if (fatal) return;
            continue;
          }
        }
      };
      const lanes = Math.max(1, Math.min(concurrency, plan.items.length));
      await Promise.all(Array.from({ length: lanes }, lane));
      if (fatal) throw fatal;
    }

    if (cancelled) throw new Error('cancelled');

    const failed = snap.files.filter((f) => f.state === 'failed').length;
    if (failed > 0) {
      log(
        'warn',
        `${failed} files failed — metadata not written; retry the failed files to complete the upload`,
      );
      snap.phase = 'partial';
      emit(true);
      return;
    }

    // --- Phase 2: metadata, in publish order ---
    snap.phase = 'metadata';
    emit(true);

    for (const w of plan.writes) {
      const key = `${plan.uploadPath}/${w.name}`;
      if (dryRun) {
        log('put', `PUT ${snap.bucket}/${key} (${new TextEncoder().encode(w.body).length} B)`);
        continue;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          await client.writeImmutable(snap.bucket, key, w.body, { contentType: w.contentType });
          log('info', `wrote ${key}`);
          break;
        } catch (err) {
          if (err instanceof PreconditionFailedError) {
            // Resume owns the prefix, so a 412 means we already wrote this file
            // in a prior run — idempotent, skip. A fresh run re-stamps instead.
            if (isResume) {
              log('info', `already present, skip: ${key}`);
              break;
            }
            throw err;
          }
          if (attempt + 1 >= MAX_ATTEMPTS || !isTransient(err)) throw err;
          await sleep(backoff(attempt));
        }
      }
    }
  };

  return {
    snap,
    log,
    emit,
    runOnce,
    cancel: () => {
      cancelled = true;
      abort.abort();
    },
    isCancelled: () => cancelled,
  };
}

/** Fresh upload (dry or wet). Wet runs persist a resumable session to Dexie. */
export function runUpload(
  params: UploadParams,
  onUpdate: (snap: UploadSnapshot) => void,
): UploadRun {
  const { config, build, dryRun, concurrency } = params;
  const persist = !dryRun;
  const runner = makeRunner(config, concurrency, onUpdate, { persist, isResume: false, dryRun });

  const done = (async () => {
    const sessionId = crypto.randomUUID();
    runner.snap.sessionId = sessionId;
    let now = new Date();
    for (let stamp = 0; ; stamp++) {
      const bundle = await buildBundle({ ...build, now });
      const plan = planFromBundle(sessionId, bundle);

      // Persist (or re-persist after a re-stamp) the session before writing a
      // byte, so a crash mid-blobs leaves a resumable row.
      if (persist) {
        const startedAt = new Date().toISOString();
        const batch: BatchRecord = {
          id: sessionId,
          targetBucket: bundle.bucket,
          uploadPrefix: bundle.uploadPath,
          deploymentId: bundle.deploymentId,
          uploaderUser: params.uploaderUser ?? build.uploaderSlug,
          uploaderSlug: build.uploaderSlug,
          collectionUuid: build.collectionUuid,
          description: build.description,
          startedAt,
          totalFiles: plan.items.length,
          totalBytes: plan.totalBytes,
          uploadTimeZone: build.timeZone,
          fileAccessMode: params.fileAccessMode ?? 'reselect-required',
          dirHandle: params.dirHandle ?? undefined,
        };
        const bundleRec: BundleRecord = {
          sessionId,
          uploadMetaJson: bundle.uploadMetaJson,
          deploymentsCsv: bundle.deploymentsCsv,
          mediaCsv: bundle.mediaCsv,
          observationsCsv: bundle.observationsCsv,
          uploadCompleteJson: bundle.uploadCompleteJson,
          metadataBundleSha256: bundle.metadataBundleSha256,
        };
        await saveSession(
          batch,
          bundleRec,
          plan.items.map((it) => fileRecordFor(sessionId, it, 'pending')),
        );
      }

      try {
        await runner.runOnce(plan);
        if (runner.snap.phase !== 'partial') {
          runner.snap.phase = 'done';
          if (persist) await markBatchComplete(sessionId, new Date().toISOString());
          runner.log('info', dryRun ? 'dry-run complete — nothing written' : `published ${bundle.uploadPath}/`);
          runner.emit(true);
        }
        return;
      } catch (err) {
        if (runner.isCancelled()) {
          runner.snap.phase = 'error';
          runner.snap.error = 'cancelled';
          runner.log('warn', 'cancelled');
          return;
        }
        if (err instanceof PreconditionFailedError && stamp < METADATA_RETRY) {
          runner.log('warn', `prefix ${bundle.uploadPath} taken — re-stamping +1s and retrying`);
          now = new Date(now.getTime() + 1000);
          continue;
        }
        runner.snap.phase = 'error';
        runner.snap.error = err instanceof Error ? err.message : String(err);
        runner.log('error', runner.snap.error);
        runner.emit(true);
        return;
      }
    }
  })();

  return { cancel: runner.cancel, done };
}

/**
 * Resume a persisted session against reattached source files. The prefix and
 * keys are reused verbatim, so completed blobs skip (after a sanity check) and
 * only the interrupted/pending files re-upload. Always a wet run.
 */
export function resumeUpload(
  params: ResumeParams,
  onUpdate: (snap: UploadSnapshot) => void,
): UploadRun {
  const { config, session, attached, concurrency } = params;
  const { batch, bundle, files } = session;
  const runner = makeRunner(config, concurrency, onUpdate, {
    persist: true,
    isResume: true,
    dryRun: false,
  });
  runner.snap.sessionId = batch.id;

  const plan: RunPlan = {
    sessionId: batch.id,
    bucket: batch.targetBucket,
    uploadPath: batch.uploadPrefix,
    totalBytes: files.reduce((n, f) => n + f.size, 0),
    metadataBundleSha256: bundle.metadataBundleSha256,
    items: files.map((r) => ({
      id: r.localPath,
      localPath: r.localPath,
      fileName: r.fileName,
      objectName: r.sanitizedObjectName,
      key: r.remoteKey,
      size: r.size,
      sha256: r.sha256,
      captureTimestamp: r.captureTimestamp,
      mediaKind: r.mediaKind,
      mimeType: r.mimeType,
      file: attached.get(r.localPath) ?? null,
      doneAlready: r.state === 'done',
    })),
    writes: metadataWrites(bundle),
  };

  const done = (async () => {
    try {
      runner.log('info', `resuming ${batch.uploadPrefix}/`);
      await runner.runOnce(plan);
      if (runner.snap.phase !== 'partial') {
        runner.snap.phase = 'done';
        await markBatchComplete(batch.id, new Date().toISOString());
        runner.log('info', `published ${batch.uploadPrefix}/`);
        runner.emit(true);
      }
    } catch (err) {
      if (runner.isCancelled()) {
        runner.snap.phase = 'error';
        runner.snap.error = 'cancelled';
        runner.log('warn', 'cancelled');
        return;
      }
      runner.snap.phase = 'error';
      runner.snap.error = err instanceof Error ? err.message : String(err);
      runner.log('error', runner.snap.error);
      runner.emit(true);
    }
  })();

  return { cancel: runner.cancel, done };
}
