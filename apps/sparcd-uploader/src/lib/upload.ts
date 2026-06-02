// P4 upload orchestration. Runs the full publish sequence for one bundle:
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
// no PUTs — it logs every write the run would make (bucket, key, size, hash).
//
// Re-stamp retry: a 412 on any final-prefix metadata object means another
// uploader took this `<stamp>_<user>` prefix. We abandon it, bump the stamp by
// one second, rebuild the bundle (new prefix → new keys), and retry the whole
// run once; a second collision surfaces. Abandoned blobs are orphans — this
// tool never deletes (open question 5 lean: auto-retry once, then surface).
//
// Bounded concurrency is a small inline lane pool rather than p-limit: lanes
// lazily pull the next blob, so memory stays flat across thousands of files and
// a hard failure aborts the in-flight set at once.

import type { S3Config } from '@sparcd/types';
import { PreconditionFailedError } from '@sparcd/s3-safe';
import { getClient } from './s3';
import { buildBundle, type BuildInput, type BundlePreview } from './bundle';

export type UploadPhase = 'idle' | 'blobs' | 'metadata' | 'done' | 'error';
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
};

export type UploadRun = { cancel: () => void; done: Promise<void> };

const METADATA_RETRY = 1; // re-stamp attempts after the first
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 500;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// A 412 (precondition) or an access denial is never worth retrying; network
// blips, 5xx, and 429 are. Default to transient only when we recognize it.
function isTransient(err: unknown): boolean {
  if (err instanceof PreconditionFailedError) return false;
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  if (status === undefined) return true; // network/CORS/DNS — worth a retry
  if (status >= 500 || status === 429) return true;
  return false;
}

// Full jitter: random in [0, base * 2^attempt].
const backoff = (attempt: number) => Math.random() * (BASE_BACKOFF_MS * 2 ** attempt);

export function runUpload(
  params: UploadParams,
  onUpdate: (snap: UploadSnapshot) => void,
): UploadRun {
  const { config, build, dryRun, concurrency } = params;
  let cancelled = false;
  let abort = new AbortController();

  const snap: UploadSnapshot = {
    version: 0,
    phase: 'idle',
    dryRun,
    files: [],
    uploadedBytes: 0,
    totalBytes: 0,
    log: [],
    bucket: build.bucket,
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

  const client = getClient(config);

  const uploadBlob = async (fp: FileProgress, file: File, sha256: string): Promise<void> => {
    for (let attempt = 0; ; attempt++) {
      if (cancelled) throw new Error('cancelled');
      fp.attempt = attempt + 1;
      fp.state = 'uploading';
      snap.uploadedBytes -= fp.loaded; // reset this file's contribution on retry
      fp.loaded = 0;
      emit(true);
      try {
        await client.writeImmutableStream(snap.bucket, fp.key, file, {
          sha256,
          contentType: 'image/jpeg',
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
        const stat = await client.statObject(snap.bucket, fp.key);
        if (stat.size !== fp.size) throw new Error(`size mismatch (${stat.size} ≠ ${fp.size})`);
        if (stat.metadata.sha256 !== sha256) throw new Error('sha256 metadata mismatch');
        fp.state = 'done';
        emit(true);
        return;
      } catch (err) {
        if (err instanceof PreconditionFailedError) {
          // The key is already occupied (e.g. a re-run of the same prefix);
          // nothing to write. Treat as present rather than failing the run.
          fp.state = 'skipped';
          snap.uploadedBytes += fp.size - fp.loaded;
          fp.loaded = fp.size;
          log('warn', `skip (exists): ${fp.key}`);
          return;
        }
        // A user cancel or a sibling lane's fatal failure aborts the signal;
        // don't retry an aborted request — let the run unwind.
        if (cancelled || abort.signal.aborted) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt + 1 >= MAX_ATTEMPTS || !isTransient(err)) {
          fp.state = 'failed';
          fp.error = msg;
          log('error', `failed ${fp.key}: ${msg}`);
          throw err;
        }
        const wait = backoff(attempt);
        log('warn', `retry ${fp.key} (attempt ${attempt + 2}) after ${Math.round(wait)}ms: ${msg}`);
        await sleep(wait);
      }
    }
  };

  // One attempt at the whole sequence against a freshly-built bundle. Throws
  // PreconditionFailedError if a final-prefix metadata write collides, so the
  // caller can re-stamp and retry.
  const runOnce = async (bundle: BundlePreview): Promise<void> => {
    snap.uploadPath = bundle.uploadPath;
    snap.metadataBundleSha256 = bundle.metadataBundleSha256;
    snap.totalBytes = bundle.totalBytes;
    snap.uploadedBytes = 0;
    snap.files = bundle.items.map((it) => ({
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
    log('info', `${bundle.items.length} blobs → ${bundle.uploadPath}/`);

    if (dryRun) {
      for (const it of bundle.items) {
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
      const lane = async (): Promise<void> => {
        for (;;) {
          if (cancelled || fatal) return;
          const i = next++;
          if (i >= bundle.items.length) return;
          const it = bundle.items[i];
          try {
            await uploadBlob(byId.get(it.id)!, it.file, it.sha256);
          } catch (err) {
            if (!fatal) {
              fatal = err;
              abort.abort(); // stop sibling lanes' in-flight requests at once
            }
            return;
          }
        }
      };
      const lanes = Math.max(1, Math.min(concurrency, bundle.items.length));
      await Promise.all(Array.from({ length: lanes }, lane));
      if (fatal) throw fatal;
    }

    if (cancelled) throw new Error('cancelled');

    // --- Phase 2: metadata, in publish order ---
    snap.phase = 'metadata';
    emit(true);

    const writes: { name: string; body: string; contentType: string }[] = [
      { name: 'deployments.csv', body: bundle.deploymentsCsv, contentType: 'text/csv' },
      { name: 'media.csv', body: bundle.mediaCsv, contentType: 'text/csv' },
      { name: 'observations.csv', body: bundle.observationsCsv, contentType: 'text/csv' },
      { name: 'UploadMeta.json', body: bundle.uploadMetaJson, contentType: 'application/json' },
      { name: 'UploadComplete.json', body: bundle.uploadCompleteJson, contentType: 'application/json' },
    ];

    for (const w of writes) {
      const key = `${bundle.uploadPath}/${w.name}`;
      if (dryRun) {
        log('put', `PUT ${snap.bucket}/${key} (${new TextEncoder().encode(w.body).length} B)`);
        continue;
      }
      // A 412 here means the prefix was taken between blob upload and now —
      // propagate so the caller re-stamps. Other failures get a short retry.
      for (let attempt = 0; ; attempt++) {
        try {
          await client.writeImmutable(snap.bucket, key, w.body, { contentType: w.contentType });
          log('info', `wrote ${key}`);
          break;
        } catch (err) {
          if (err instanceof PreconditionFailedError) throw err;
          if (attempt + 1 >= MAX_ATTEMPTS || !isTransient(err)) throw err;
          await sleep(backoff(attempt));
        }
      }
    }
  };

  const done = (async () => {
    let now = new Date();
    for (let stamp = 0; ; stamp++) {
      abort = new AbortController(); // fresh signal per attempt
      const bundle = await buildBundle({ ...build, now });
      try {
        await runOnce(bundle);
        snap.phase = 'done';
        log('info', dryRun ? 'dry-run complete — nothing written' : `published ${bundle.uploadPath}/`);
        return;
      } catch (err) {
        if (cancelled) {
          snap.phase = 'error';
          snap.error = 'cancelled';
          log('warn', 'cancelled');
          return;
        }
        if (err instanceof PreconditionFailedError && stamp < METADATA_RETRY) {
          log('warn', `prefix ${bundle.uploadPath} taken — re-stamping +1s and retrying`);
          now = new Date(now.getTime() + 1000);
          continue;
        }
        snap.phase = 'error';
        snap.error = err instanceof Error ? err.message : String(err);
        log('error', snap.error);
        return;
      }
    }
  })();

  return {
    cancel: () => {
      cancelled = true;
      abort.abort();
    },
    done,
  };
}
