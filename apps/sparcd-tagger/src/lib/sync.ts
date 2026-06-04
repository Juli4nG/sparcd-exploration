// The compatibility sync — the tagger's only S3 write path (P4). It turns local
// drafts into the canonical Camtrap output the Java app, sparcd-web, and the
// marimo explorer already read: it replaces upload-level `media.csv`,
// `observations.csv`, and `UploadMeta.json` in place, guarded by `IfMatch`
// against the ETags the user reviewed, after writing an immutable pre-change
// snapshot.
//
// Two layers:
//   1. Pure planning — `buildSyncPlan` diffs drafts against the canonical base
//      into `@sparcd/camtrap` `MediaEdit`s. No I/O, fully testable.
//   2. `runSync` — the orchestrator. All S3/Dexie effects come through an
//      injected `SyncIO`, so the conflict / snapshot-collision / partial-resume
//      behaviour is testable with fakes and never touches a real bucket.
//
// Dry-run is the default (see the store): a dry-run returns the planned writes
// and touches nothing — not even a snapshot.

import {
  mergeMedia,
  mergeObservations,
  computeSpeciesDelta,
  applyUploadMetaEdit,
  parseUploadMeta,
  serializeUploadMeta,
  javaEditStamp,
  correctedTimestamp,
  type MediaEdit,
  type TimeOffset,
} from '@sparcd/camtrap';
import type { TagImage } from './workspace';
import type { DraftRecord } from './db';
import { sha256Hex } from './hash';
import {
  ROLE_ORDER,
  planResume,
  collectNewETags,
  type CanonicalRole,
  type SyncJournal,
  type JournalObject,
  type RemoteState,
} from './syncJournal';

// --- Canonical state -------------------------------------------------------

/** One canonical file as loaded for a sync: bytes + the ETag/hash to ground on. */
export type CanonicalFile = { text: string; etag: string; hash: string };
export type CanonicalState = Record<CanonicalRole, CanonicalFile>;

const SNAPSHOT_FILE: Record<CanonicalRole, string> = {
  media: 'media.csv',
  observations: 'observations.csv',
  uploadMeta: 'UploadMeta.json',
};

const CONTENT_TYPE: Record<CanonicalRole, string> = {
  media: 'text/csv',
  observations: 'text/csv',
  uploadMeta: 'application/json',
};

// --- Pure planning ---------------------------------------------------------

export type DiffSummary = {
  additions: number; // untagged → tagged
  modifications: number; // tagged → different species/count
  removals: number; // tagged → detagged
  timeCorrections: number; // images whose capture time changes
};

export type SyncPlan = {
  /** Images whose observation rows change — drive `mergeObservations` + the delta. */
  tagEdits: MediaEdit[];
  /** Images whose `media.csv` col-4 timestamp changes but whose tags don't. */
  timeEdits: MediaEdit[];
  summary: DiffSummary;
};

const effField = <K extends keyof DraftRecord>(
  draft: DraftRecord | undefined,
  base: string | number,
  key: K,
): string | number => (draft ? (draft[key] as string | number) : base);

/**
 * Diff the loaded drafts against the canonical base into the edits the merge
 * helpers consume. A draft that equals its base produces no edit (re-applying
 * the same species, or a questionable-only toggle, is not a canonical change).
 */
export function buildSyncPlan(
  images: TagImage[],
  drafts: Record<string, DraftRecord>,
  offset: TimeOffset | null,
): SyncPlan {
  const tagEdits: MediaEdit[] = [];
  const timeEdits: MediaEdit[] = [];
  const summary: DiffSummary = { additions: 0, modifications: 0, removals: 0, timeCorrections: 0 };

  for (const img of images) {
    const d = drafts[img.key];
    const label = String(effField(d, img.baseLabel, 'label'));
    const count = Number(effField(d, img.baseCount, 'count'));
    const commonName = String(effField(d, img.baseCommonName, 'commonName'));
    const requested = String(effField(d, img.baseRequested, 'requestedSpecies'));

    const corrected = correctedTimestamp(img.baseTimestamp, offset, d?.timeOverride ?? null);
    const timeChanged = !!img.baseTimestamp && corrected !== img.baseTimestamp;

    const tagChanged =
      label !== img.baseLabel ||
      count !== img.baseCount ||
      commonName !== img.baseCommonName ||
      requested !== img.baseRequested;

    if (timeChanged) summary.timeCorrections++;

    if (tagChanged) {
      const wasTagged = !!img.baseLabel;
      const nowTagged = !!label;
      if (!wasTagged && nowTagged) summary.additions++;
      else if (wasTagged && !nowTagged) summary.removals++;
      else summary.modifications++;

      tagEdits.push({
        mediaId: img.key,
        deploymentId: img.deploymentId,
        timestamp: corrected,
        mediaTimestamp: timeChanged ? corrected : undefined,
        observations: label
          ? [
              {
                scientificName: label,
                count: Math.max(1, count),
                commonName: commonName || undefined,
                requestedSpecies: requested || undefined,
              },
            ]
          : [],
      });
    } else if (timeChanged) {
      // Time correction on an image whose species rows don't change. Goes to
      // `mergeMedia` only (it reads `mediaTimestamp`); `observations` stays `[]`
      // here and is never handed to `mergeObservations`, so its rows survive.
      timeEdits.push({
        mediaId: img.key,
        deploymentId: img.deploymentId,
        timestamp: corrected,
        mediaTimestamp: corrected,
        observations: [],
      });
    }
  }

  return { tagEdits, timeEdits, summary };
}

export function planIsEmpty(plan: SyncPlan): boolean {
  return plan.tagEdits.length === 0 && plan.timeEdits.length === 0;
}

// --- Snapshot stamp --------------------------------------------------------

const p2 = (n: number): string => String(n).padStart(2, '0');

/** Filesystem-friendly snapshot stamp `uuuu-MM-ddTHH-mm-ss` (colons → dashes). */
export function snapshotStamp(d: Date): string {
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T` +
    `${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`
  );
}

export const snapshotPrefixOf = (uploadPrefix: string, user: string, stamp: string): string =>
  `${uploadPrefix}.sparcd-tagger-snapshots/${user}/${stamp}/`;

// --- Orchestrator ----------------------------------------------------------

/** Every S3/Dexie effect the sync performs, injected so it is fully testable. */
export type SyncIO = {
  /** Re-HEAD/GET the three canonical files with current ETag + SHA-256. */
  loadCanonical: () => Promise<CanonicalState>;
  /** Conditional `writeImmutable` of one snapshot object; rejects with a 412-typed error if the key exists. */
  writeSnapshot: (key: string, body: string, contentType: string) => Promise<void>;
  /** `replaceIfUnchanged` of one canonical object; rejects with a conflict-typed error on a stale ETag. */
  replace: (key: string, body: string, etag: string, contentType: string) => Promise<{ etag?: string }>;
  saveJournal: (journal: SyncJournal) => Promise<void>;
  clearJournal: () => Promise<void>;
  now: () => Date;
};

export type PlannedWrite = { role: CanonicalRole; key: string; bytes: number; baseETag: string };

/** A canonical body prepared for writing: the bytes + their SHA-256, by role. */
type PreparedWrite = { role: CanonicalRole; body: string; hash: string };

/** The snapshot's `manifest.json`, written last so recovery ignores partial
 *  prefixes. The shape both the writer (`writeSnapshotSet`) and the reader
 *  (`s3.listSnapshots`) agree on. */
export type SnapshotManifest = {
  schemaVersion: 1;
  user: string;
  editStamp: string;
  files: { name: string; etag: string; sha256: string }[];
};

const byteLen = (s: string): number => new TextEncoder().encode(s).length;

export type SyncResult =
  | { status: 'noop' }
  | { status: 'dry-run'; summary: DiffSummary; snapshotPrefix: string; writes: PlannedWrite[] }
  | { status: 'synced'; summary: DiffSummary; newETags: Partial<Record<CanonicalRole, string>> }
  | { status: 'conflict'; role: CanonicalRole; reason: string }
  | { status: 'unsupported'; message: string };

export type SyncParams = {
  bucket: string;
  uploadPrefix: string;
  user: string;
  /** The grounded base ETags the user reviewed (per role). */
  base: Record<CanonicalRole, { etag: string }>;
  plan: SyncPlan;
  dryRun: boolean;
  /** A journal left by a prior partial sync, to resume instead of starting fresh. */
  resumeJournal?: SyncJournal;
};

const key = (uploadPrefix: string, role: CanonicalRole): string =>
  `${uploadPrefix}${SNAPSHOT_FILE[role]}`;

/** Thrown error looks like a 412 (snapshot key already exists)? */
function isPrecondition(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'PreconditionFailedError' || e?.$metadata?.httpStatusCode === 412;
}

function isReplaceConflict(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalReplaceConflictError';
}

function isUnsupported(err: unknown): boolean {
  return (err as { name?: string })?.name === 'ConditionalPutUnsupportedError';
}

/**
 * Build the merged canonical bodies and which roles actually change. The merge
 * runs against `current` (verified equal to the grounded base), so unrelated
 * rows and unmodelled columns survive verbatim. `UploadMeta.json` always
 * changes — every successful sync appends its mandatory edit comment.
 */
async function buildWrites(
  current: CanonicalState,
  plan: SyncPlan,
  user: string,
  editStamp: string,
): Promise<PreparedWrite[]> {
  const allMediaEdits = [...plan.tagEdits, ...plan.timeEdits];
  const bodies: Record<CanonicalRole, string> = {
    media: mergeMedia(current.media.text, allMediaEdits),
    observations: mergeObservations(current.observations.text, plan.tagEdits),
    uploadMeta: '',
  };
  const delta = computeSpeciesDelta(current.observations.text, plan.tagEdits);
  const meta = applyUploadMetaEdit(parseUploadMeta(current.uploadMeta.text), {
    delta,
    user,
    editStamp,
  });
  bodies.uploadMeta = serializeUploadMeta(meta);

  return prepareWrites(current, bodies);
}

/** Keep only the roles whose bytes actually change, hashing each kept body. */
async function prepareWrites(
  current: CanonicalState,
  bodies: Record<CanonicalRole, string>,
): Promise<PreparedWrite[]> {
  const out: PreparedWrite[] = [];
  for (const role of ROLE_ORDER) {
    if (bodies[role] === current[role].text) continue; // unchanged → don't rewrite
    out.push({ role, body: bodies[role], hash: await sha256Hex(bodies[role]) });
  }
  return out;
}

/** Write the canonical objects of a journal that are still pending, in order. */
async function writePending(
  io: SyncIO,
  journal: SyncJournal,
  fromIndex: number,
): Promise<SyncResult> {
  for (let i = fromIndex; i < journal.objects.length; i++) {
    const obj = journal.objects[i];
    if (obj.status === 'written') continue;
    try {
      const res = await io.replace(obj.key, obj.body, obj.baseETag, CONTENT_TYPE[obj.role]);
      obj.status = 'written';
      obj.newETag = res.etag;
      await io.saveJournal(journal);
    } catch (err) {
      if (isReplaceConflict(err))
        return { status: 'conflict', role: obj.role, reason: 'a canonical object changed mid-sync' };
      if (isUnsupported(err))
        return {
          status: 'unsupported',
          message: 'The endpoint does not enforce IfMatch — canonical sync is disabled here.',
        };
      throw err;
    }
  }
  await io.clearJournal();
  return { status: 'synced', summary: EMPTY_SUMMARY, newETags: collectNewETags(journal) };
}

const EMPTY_SUMMARY: DiffSummary = { additions: 0, modifications: 0, removals: 0, timeCorrections: 0 };

/**
 * Write the pre-change snapshot set (old canonical bodies, then `manifest.json`
 * last). On a 412 collision the caller re-stamps +1s and retries once. The
 * manifest is written last so recovery ignores incomplete snapshot prefixes.
 */
async function writeSnapshotSet(
  io: SyncIO,
  snapshotPrefix: string,
  current: CanonicalState,
  user: string,
  editStamp: string,
): Promise<void> {
  for (const role of ROLE_ORDER) {
    await io.writeSnapshot(`${snapshotPrefix}${SNAPSHOT_FILE[role]}`, current[role].text, CONTENT_TYPE[role]);
  }
  const manifest: SnapshotManifest = {
    schemaVersion: 1,
    user,
    editStamp,
    files: ROLE_ORDER.map((role) => ({
      name: SNAPSHOT_FILE[role],
      etag: current[role].etag,
      sha256: current[role].hash,
    })),
  };
  await io.writeSnapshot(`${snapshotPrefix}manifest.json`, JSON.stringify(manifest, null, 2), 'application/json');
}

/**
 * Resume a prior partial sync/restore: verify written/pending objects against
 * the current remote, then continue from the first pending one. Returns the
 * terminal `SyncResult` when a journal is present (whether it conflicts,
 * completes, or describes a dry-run), or `null` when there is no journal and the
 * caller should plan a fresh write. The journal carries the exact bodies, so a
 * resume completes the originally-intended write even after a browser reload —
 * and a pending sync or restore journal must be finished (or its conflict
 * resolved) before a new operation begins.
 */
async function tryResume(
  io: SyncIO,
  resumeJournal: SyncJournal | undefined,
  dryRun: boolean,
): Promise<SyncResult | null> {
  if (!resumeJournal) return null;
  const journal = resumeJournal;
  const cur = await io.loadCanonical();
  const decision = planResume(journal, remoteStates(cur));
  if (decision.kind === 'conflict')
    return { status: 'conflict', role: decision.role, reason: decision.reason };
  if (decision.kind === 'done') {
    if (dryRun)
      return { status: 'dry-run', summary: EMPTY_SUMMARY, snapshotPrefix: journal.snapshotPrefix, writes: [] };
    await io.clearJournal();
    return { status: 'synced', summary: EMPTY_SUMMARY, newETags: collectNewETags(journal) };
  }
  if (dryRun) {
    // A dry-run never writes — describe the pending objects a real resume would.
    return {
      status: 'dry-run',
      summary: EMPTY_SUMMARY,
      snapshotPrefix: journal.snapshotPrefix,
      writes: journal.objects
        .slice(decision.fromIndex)
        .filter((o) => o.status === 'pending')
        .map((o) => ({ role: o.role, key: o.key, bytes: byteLen(o.body), baseETag: o.baseETag })),
    };
  }
  return writePending(io, journal, decision.fromIndex);
}

type CommitCtx = {
  bucket: string;
  uploadPrefix: string;
  user: string;
  current: CanonicalState;
  writes: PreparedWrite[];
  editStamp: string;
  snapshotPrefix: string;
};

/**
 * The shared live-write path for both sync and restore: snapshot the current
 * canonical state immutably (manifest last, +1s re-stamp once on a 412
 * collision), journal the intended writes, then conditionally replace each
 * changed canonical object in order. The journal is left in place on a mid-write
 * conflict so the next attempt resumes instead of restarting.
 */
async function commitWrites(io: SyncIO, c: CommitCtx, summary: DiffSummary): Promise<SyncResult> {
  // 1. Immutable pre-change snapshot, with a single +1s re-stamp on collision.
  let activePrefix = c.snapshotPrefix;
  try {
    await writeSnapshotSet(io, activePrefix, c.current, c.user, c.editStamp);
  } catch (err) {
    if (!isPrecondition(err)) throw err;
    const bumped = snapshotStamp(new Date(io.now().getTime() + 1000));
    activePrefix = snapshotPrefixOf(c.uploadPrefix, c.user, bumped);
    await writeSnapshotSet(io, activePrefix, c.current, c.user, c.editStamp);
  }

  // 2. Journal the intended writes before the first canonical PUT.
  const journal: SyncJournal = {
    id: `${c.bucket}::${c.uploadPrefix}`,
    bucket: c.bucket,
    uploadPrefix: c.uploadPrefix,
    snapshotPrefix: activePrefix,
    user: c.user,
    startedAt: io.now().toISOString(),
    objects: c.writes.map<JournalObject>((w) => ({
      role: w.role,
      key: key(c.uploadPrefix, w.role),
      baseETag: c.current[w.role].etag,
      body: w.body,
      intendedHash: w.hash,
      status: 'pending',
    })),
  };
  await io.saveJournal(journal);

  // 3. Conditional canonical replacement, in order, recording each new ETag.
  const result = await writePending(io, journal, 0);
  if (result.status === 'synced') return { ...result, summary };
  return result;
}

export async function runSync(params: SyncParams, io: SyncIO): Promise<SyncResult> {
  const { bucket, uploadPrefix, user, plan, dryRun } = params;

  const resumed = await tryResume(io, params.resumeJournal, dryRun);
  if (resumed) return resumed;

  if (planIsEmpty(plan)) return { status: 'noop' };

  const current = await io.loadCanonical();

  // Pre-write conflict detection: the grounded base must still be the remote.
  for (const role of ROLE_ORDER) {
    if (current[role].etag !== params.base[role].etag) {
      return {
        status: 'conflict',
        role,
        reason: 'the canonical file changed since this upload was loaded',
      };
    }
  }

  const editStamp = javaEditStamp(io.now());
  const writes = await buildWrites(current, plan, user, editStamp);
  const snapshotPrefix = snapshotPrefixOf(uploadPrefix, user, snapshotStamp(io.now()));

  if (dryRun) {
    return {
      status: 'dry-run',
      summary: plan.summary,
      snapshotPrefix,
      writes: writes.map((w) => ({
        role: w.role,
        key: key(uploadPrefix, w.role),
        bytes: byteLen(w.body),
        baseETag: current[w.role].etag,
      })),
    };
  }

  return commitWrites(io, { bucket, uploadPrefix, user, current, writes, editStamp, snapshotPrefix }, plan.summary);
}

// --- Restore (P5) ----------------------------------------------------------

export type RestoreParams = {
  bucket: string;
  uploadPrefix: string;
  /** Who is performing the restore — stamps the new pre-restore snapshot path. */
  user: string;
  /** The snapshot bodies to write back, by role. */
  bodies: Record<CanonicalRole, string>;
  dryRun: boolean;
  /** A journal left by a prior partial sync/restore, to resume instead of starting fresh. */
  resumeJournal?: SyncJournal;
};

/**
 * Restore a prior snapshot: write its `media.csv` / `observations.csv` /
 * `UploadMeta.json` back verbatim through the same conditional-replacement flow
 * a sync uses. The snapshot bytes are restored exactly (no merge, no re-derived
 * `UploadMeta` tally) — an exact rollback — and `IfMatch` is taken against the
 * *current* remote ETags, so a concurrent write since the restore was started is
 * caught as a conflict rather than silently clobbered. The current (pre-restore)
 * state is itself snapshotted first, so a restore is as recoverable as a sync.
 * Only the files whose bytes differ from the current canonical are rewritten.
 */
export async function runRestore(params: RestoreParams, io: SyncIO): Promise<SyncResult> {
  const { bucket, uploadPrefix, user, bodies, dryRun } = params;

  const resumed = await tryResume(io, params.resumeJournal, dryRun);
  if (resumed) return resumed;

  const current = await io.loadCanonical();
  const writes = await prepareWrites(current, bodies);
  if (writes.length === 0) return { status: 'noop' };

  const editStamp = javaEditStamp(io.now());
  const snapshotPrefix = snapshotPrefixOf(uploadPrefix, user, snapshotStamp(io.now()));

  if (dryRun) {
    return {
      status: 'dry-run',
      summary: EMPTY_SUMMARY,
      snapshotPrefix,
      writes: writes.map((w) => ({
        role: w.role,
        key: key(uploadPrefix, w.role),
        bytes: byteLen(w.body),
        baseETag: current[w.role].etag,
      })),
    };
  }

  return commitWrites(io, { bucket, uploadPrefix, user, current, writes, editStamp, snapshotPrefix }, EMPTY_SUMMARY);
}

function remoteStates(state: CanonicalState): Record<CanonicalRole, RemoteState> {
  return {
    media: { etag: state.media.etag, hash: state.media.hash },
    observations: { etag: state.observations.etag, hash: state.observations.hash },
    uploadMeta: { etag: state.uploadMeta.etag, hash: state.uploadMeta.hash },
  };
}
