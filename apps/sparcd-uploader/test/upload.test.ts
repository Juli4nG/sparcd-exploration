import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PreconditionFailedError } from '@sparcd/s3-safe';
import type { S3Config } from '@sparcd/types';
import type { BundlePreview } from '../src/lib/bundle';
import type { BatchRecord, BundleRecord, FileRecord, LoadedSession } from '../src/lib/db';
import { resumeUpload, runUpload, type UploadSnapshot } from '../src/lib/upload';

type FakeClient = {
  statObject: ReturnType<typeof vi.fn>;
  writeImmutableStream: ReturnType<typeof vi.fn>;
  writeImmutable: ReturnType<typeof vi.fn>;
};

const mocks = vi.hoisted(() => ({
  client: null as FakeClient | null,
  saveSession: vi.fn(),
  markFileState: vi.fn(),
  markBatchComplete: vi.fn(),
  buildBundle: vi.fn(),
}));

vi.mock('../src/lib/s3', () => ({
  getClient: vi.fn(() => mocks.client),
}));

vi.mock('../src/lib/db', () => ({
  fileRecordId: (sessionId: string, localPath: string) => `${sessionId}::${localPath}`,
  saveSession: mocks.saveSession,
  markFileState: mocks.markFileState,
  markBatchComplete: mocks.markBatchComplete,
}));

vi.mock('../src/lib/bundle', () => ({
  buildBundle: mocks.buildBundle,
}));

const CONFIG = {} as S3Config;

const badRequest = () =>
  Object.assign(new Error('bad request'), {
    name: 'BadRequest',
    $metadata: { httpStatusCode: 400 },
  });

const forbidden = () =>
  Object.assign(new Error('forbidden'), {
    name: 'Forbidden',
    $metadata: { httpStatusCode: 403 },
  });

function makeFile(localPath: string, size = 12): File {
  return new File([new Uint8Array(size)], localPath.split('/').pop() ?? localPath, { type: 'image/jpeg' });
}

function makeRecord(sessionId: string, i: number, state: FileRecord['state'] = 'pending'): FileRecord {
  const localPath = `file-${i}.jpg`;
  return {
    id: `${sessionId}::${localPath}`,
    sessionId,
    localPath,
    fileName: localPath,
    relPathInBundle: localPath,
    sanitizedObjectName: localPath,
    size: 12,
    sha256: `sha-${i}`,
    captureTimestamp: '2026-07-01T12:00:00',
    mediaKind: 'image',
    mimeType: 'image/jpeg',
    state,
    remoteKey: `Collections/c/Uploads/u/${localPath}`,
    attempt: 0,
  };
}

function makeBundleRecord(sessionId: string): BundleRecord {
  return {
    sessionId,
    deploymentsCsv: 'deployments',
    mediaCsv: 'media',
    observationsCsv: 'observations',
    uploadMetaJson: '{"meta":true}',
    uploadCompleteJson: '{"complete":true}',
    metadataBundleSha256: 'bundle-sha',
  };
}

function makeBatch(sessionId: string, totalFiles: number): BatchRecord {
  return {
    id: sessionId,
    targetBucket: 'bucket',
    uploadPrefix: 'Collections/c/Uploads/u',
    deploymentId: 'deployment',
    uploaderUser: 'user',
    uploaderSlug: 'user',
    collectionUuid: 'collection',
    description: 'description',
    startedAt: '2026-07-23T00:00:00.000Z',
    totalFiles,
    totalBytes: totalFiles * 12,
    uploadTimeZone: 'UTC',
    fileAccessMode: 'reselect-required',
  };
}

function makeSession(states: FileRecord['state'][]): LoadedSession {
  const sessionId = 'session-1';
  return {
    batch: makeBatch(sessionId, states.length),
    bundle: makeBundleRecord(sessionId),
    files: states.map((state, i) => makeRecord(sessionId, i, state)),
  };
}

function attachedFor(records: FileRecord[]): Map<string, File> {
  return new Map(records.map((r) => [r.localPath, makeFile(r.localPath, r.size)]));
}

function makeClient(records: FileRecord[], failingKeys = new Set<string>()): FakeClient {
  const byKey = new Map(records.map((r) => [r.remoteKey, r]));
  return {
    statObject: vi.fn(async (_bucket: string, key: string) => {
      const r = byKey.get(key);
      if (!r) throw Object.assign(new Error('missing'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });
      return { size: r.size, metadata: { sha256: r.sha256 } };
    }),
    writeImmutableStream: vi.fn(async (_bucket: string, key: string) => {
      if (failingKeys.has(key)) throw badRequest();
      return { etag: `etag-${key}` };
    }),
    writeImmutable: vi.fn(async () => undefined),
  };
}

async function collect(run: { done: Promise<void> }, onDone: () => UploadSnapshot | null): Promise<UploadSnapshot> {
  await run.done;
  const snap = onDone();
  expect(snap).not.toBeNull();
  return snap!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client = null;
});

describe('upload runs continue past per-file blob failures', () => {
  it('leaves a partial run open and skips metadata when some files fail', async () => {
    const session = makeSession(Array.from({ length: 6 }, () => 'pending'));
    const failing = new Set([session.files[1].remoteKey, session.files[4].remoteKey]);
    mocks.client = makeClient(session.files, failing);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: 3 },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    expect(snap.files.filter((f) => f.state === 'failed')).toHaveLength(2);
    expect(snap.files.filter((f) => f.state === 'done')).toHaveLength(4);
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });

  it('treats the per-file failure threshold as systemic', async () => {
    const session = makeSession(Array.from({ length: 15 }, () => 'pending'));
    mocks.client = makeClient(session.files, new Set(session.files.map((f) => f.remoteKey)));
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: 4 },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(snap.error).toMatch(/file failures/);
  });

  it('aborts immediately on systemic access failures', async () => {
    expect(new PreconditionFailedError('x')).toBeInstanceOf(Error);
    const session = makeSession(Array.from({ length: 3 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    mocks.client.writeImmutableStream.mockRejectedValueOnce(forbidden());
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: 1 },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('error');
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
  });

  it('publishes metadata after a clean sweep', async () => {
    const session = makeSession(Array.from({ length: 2 }, () => 'pending'));
    mocks.client = makeClient(session.files);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: 2 },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutable.mock.calls.map((c) => c[1])).toEqual([
      'Collections/c/Uploads/u/deployments.csv',
      'Collections/c/Uploads/u/media.csv',
      'Collections/c/Uploads/u/observations.csv',
      'Collections/c/Uploads/u/UploadMeta.json',
      'Collections/c/Uploads/u/UploadComplete.json',
    ]);
    expect(mocks.markBatchComplete).toHaveBeenCalledTimes(1);
  });

  it('retries only failed or pending files and then completes', async () => {
    const session = makeSession(['done', 'done', 'done', 'done', 'failed', 'pending']);
    mocks.client = makeClient(session.files);
    let last: UploadSnapshot | null = null;

    const run = resumeUpload(
      { config: CONFIG, session, attached: attachedFor(session.files), concurrency: 3 },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('done');
    expect(mocks.client.writeImmutableStream).toHaveBeenCalledTimes(2);
    expect(mocks.client.writeImmutableStream.mock.calls.map((c) => c[1])).toEqual([
      session.files[4].remoteKey,
      session.files[5].remoteKey,
    ]);
    expect(mocks.client.writeImmutable).toHaveBeenCalledTimes(5);
  });

  it('fresh runUpload can finish partial without closing the session', async () => {
    const sessionId = 'unused';
    const records = [0, 1, 2].map((i) => makeRecord(sessionId, i, 'pending'));
    const bundle: BundlePreview = {
      uploadPath: 'Collections/c/Uploads/u',
      bucket: 'bucket',
      deploymentId: 'deployment',
      fileCount: 3,
      totalBytes: 36,
      metadataBundleSha256: 'bundle-sha',
      deploymentsCsv: 'deployments',
      mediaCsv: 'media',
      observationsCsv: 'observations',
      uploadMetaJson: '{"meta":true}',
      uploadCompleteJson: '{"complete":true}',
      items: records.map((r) => ({
        id: r.localPath,
        localPath: r.localPath,
        fileName: r.fileName,
        objectName: r.sanitizedObjectName,
        key: r.remoteKey,
        file: makeFile(r.localPath, r.size),
        size: r.size,
        sha256: r.sha256,
        captureTimestamp: r.captureTimestamp,
        mediaKind: r.mediaKind,
        mimeType: r.mimeType,
      })),
    };
    mocks.buildBundle.mockResolvedValue(bundle);
    mocks.client = makeClient(records, new Set([records[1].remoteKey]));
    let last: UploadSnapshot | null = null;

    const run = runUpload(
      {
        config: CONFIG,
        dryRun: false,
        concurrency: 2,
        uploaderUser: 'user',
        fileAccessMode: 'reselect-required',
        build: {
          location: {
            key: 'deployment',
            id: 'deployment',
            name: 'Deployment',
            latitude: 1,
            longitude: 2,
            elevation: 3,
          },
          collectionUuid: 'collection',
          bucket: 'bucket',
          uploaderSlug: 'user',
          description: 'description',
          timeZone: 'UTC',
          files: [],
        },
      },
      (snap) => {
        last = snap;
      },
    );
    const snap = await collect(run, () => last);

    expect(snap.phase).toBe('partial');
    expect(snap.sessionId).toMatch(/\S/);
    expect(mocks.client.writeImmutable).not.toHaveBeenCalled();
    expect(mocks.markBatchComplete).not.toHaveBeenCalled();
  });
});
