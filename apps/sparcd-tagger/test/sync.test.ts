import { describe, it, expect } from 'vitest';
import {
  serializeCsvRows,
  serializeUploadMeta,
  buildUploadMeta,
  MEDIA_COL,
  OBS_COL,
  MEDIA_COLUMN_COUNT,
  OBS_COLUMN_COUNT,
} from '@sparcd/camtrap';
import {
  buildSyncPlan,
  runSync,
  snapshotStamp,
  type CanonicalState,
  type SyncIO,
  type SyncPlan,
} from '../src/lib/sync';
import type { SyncJournal } from '../src/lib/syncJournal';
import { sha256Hex } from '../src/lib/hash';
import type { TagImage } from '../src/lib/workspace';
import type { DraftRecord } from '../src/lib/db';

const PREFIX = 'Collections/uuid/Uploads/2024.01.15.10.00.00/';
const DEP = 'uuid:SAN15';
const K1 = `${PREFIX}IMG001.JPG`;
const K2 = `${PREFIX}IMG002.JPG`;

function mediaRow(key: string, ts: string): string[] {
  const r = new Array<string>(MEDIA_COLUMN_COUNT).fill('');
  r[MEDIA_COL.mediaId] = key;
  r[MEDIA_COL.deploymentId] = DEP;
  r[MEDIA_COL.sequenceId] = key;
  r[MEDIA_COL.timestamp] = ts;
  r[MEDIA_COL.filePath] = key;
  r[MEDIA_COL.fileName] = key.split('/').pop()!;
  r[MEDIA_COL.mediaType] = 'image/jpeg';
  r[MEDIA_COL.favorite] = 'false';
  return r;
}

function obsRow(key: string, ts: string, sci: string): string[] {
  const r = new Array<string>(OBS_COLUMN_COUNT).fill('');
  r[OBS_COL.observationId] = `${key}:0`;
  r[OBS_COL.deploymentId] = DEP;
  r[OBS_COL.mediaId] = key;
  r[OBS_COL.timestamp] = ts;
  r[OBS_COL.cameraSetup] = 'false';
  r[OBS_COL.scientificName] = sci;
  r[OBS_COL.count] = '1';
  r[OBS_COL.countNew] = '0';
  return r;
}

const MEDIA_CSV = serializeCsvRows([
  mediaRow(K1, '2024-01-10T08:00:00'),
  mediaRow(K2, '2024-01-10T08:00:30'),
]);
const OBS_CSV = serializeCsvRows([obsRow(K1, '2024-01-10T08:00:00', 'Puma concolor')]);
const META_CSV = serializeUploadMeta(
  buildUploadMeta({
    uploadUser: 'orig',
    date: new Date('2024-01-15T10:00:00Z'),
    imageCount: 2,
    imagesWithSpecies: 1,
    bucket: 'sparcd-x',
    uploadPath: PREFIX,
    description: '',
  }),
);

async function canonical(): Promise<CanonicalState> {
  return {
    media: { text: MEDIA_CSV, etag: '"media-1"', hash: await sha256Hex(MEDIA_CSV) },
    observations: { text: OBS_CSV, etag: '"obs-1"', hash: await sha256Hex(OBS_CSV) },
    uploadMeta: { text: META_CSV, etag: '"meta-1"', hash: await sha256Hex(META_CSV) },
  };
}

const IMAGES: TagImage[] = [
  { key: K1, fileName: 'IMG001.JPG', deploymentId: DEP, baseTimestamp: '2024-01-10T08:00:00', baseLabel: 'Puma concolor', baseCommonName: '', baseCount: 1, baseRequested: '' },
  { key: K2, fileName: 'IMG002.JPG', deploymentId: DEP, baseTimestamp: '2024-01-10T08:00:30', baseLabel: '', baseCommonName: '', baseCount: 0, baseRequested: '' },
];

function draft(over: Partial<DraftRecord>): DraftRecord {
  return {
    id: '', bucket: 'sparcd-x', uploadPrefix: PREFIX, mediaPath: '', deploymentId: DEP,
    label: '', commonName: '', count: 0, requestedSpecies: '', freeTags: '',
    questionable: false, timeOverride: null, lastEdited: '', dirty: true, ...over,
  };
}

// Add a species to the untagged IMG002.
const ADD_DRAFTS: Record<string, DraftRecord> = {
  [K2]: draft({ mediaPath: K2, label: 'Canis latrans', commonName: 'Coyote', count: 1 }),
};

const NOW = new Date('2024-01-20T14:30:00');

type Recorder = {
  snapshots: { key: string; body: string }[];
  replaces: { key: string; etag: string }[];
  journals: SyncJournal[];
  cleared: number;
};

function fakeIO(
  current: CanonicalState,
  opts: {
    snapshotFailsOn?: (key: string) => boolean;
    replaceError?: (key: string) => Error | null;
  } = {},
): { io: SyncIO; rec: Recorder } {
  const rec: Recorder = { snapshots: [], replaces: [], journals: [], cleared: 0 };
  const io: SyncIO = {
    loadCanonical: async () => current,
    writeSnapshot: async (key, body) => {
      if (opts.snapshotFailsOn?.(key))
        throw Object.assign(new Error('exists'), { name: 'PreconditionFailedError', $metadata: { httpStatusCode: 412 } });
      rec.snapshots.push({ key, body });
    },
    replace: async (key, _body, etag) => {
      const err = opts.replaceError?.(key);
      if (err) throw err;
      rec.replaces.push({ key, etag });
      return { etag: `"new-${key.split('/').pop()}"` };
    },
    saveJournal: async (j) => rec.journals.push(structuredClone(j)),
    clearJournal: async () => void rec.cleared++,
    now: () => NOW,
  };
  return { io, rec };
}

const baseFrom = (c: CanonicalState) => ({
  media: { etag: c.media.etag },
  observations: { etag: c.observations.etag },
  uploadMeta: { etag: c.uploadMeta.etag },
});

describe('buildSyncPlan', () => {
  it('classifies an addition and emits one observation edit', () => {
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    expect(plan.summary).toEqual({ additions: 1, modifications: 0, removals: 0, timeCorrections: 0 });
    expect(plan.tagEdits).toHaveLength(1);
    expect(plan.tagEdits[0].mediaId).toBe(K2);
    expect(plan.tagEdits[0].observations[0].scientificName).toBe('Canis latrans');
    expect(plan.timeEdits).toHaveLength(0);
  });

  it('classifies a detag as a removal with empty observations', () => {
    const plan = buildSyncPlan(IMAGES, { [K1]: draft({ mediaPath: K1, label: '' }) }, null);
    expect(plan.summary.removals).toBe(1);
    expect(plan.tagEdits[0].observations).toEqual([]);
  });

  it('ignores a questionable-only toggle (no canonical change)', () => {
    const plan = buildSyncPlan(
      IMAGES,
      { [K1]: draft({ mediaPath: K1, label: 'Puma concolor', count: 1, questionable: true }) },
      null,
    );
    expect(plan.tagEdits).toHaveLength(0);
    expect(plan.timeEdits).toHaveLength(0);
  });

  it('emits a time-only media edit for a per-image override that keeps the tag', () => {
    const plan = buildSyncPlan(
      IMAGES,
      { [K1]: draft({ mediaPath: K1, label: 'Puma concolor', count: 1, timeOverride: '2024-01-10T09:00:00' }) },
      null,
    );
    expect(plan.tagEdits).toHaveLength(0);
    expect(plan.timeEdits).toHaveLength(1);
    expect(plan.timeEdits[0].mediaTimestamp).toBe('2024-01-10T09:00:00');
    expect(plan.summary.timeCorrections).toBe(1);
  });
});

describe('runSync — dry-run default writes nothing', () => {
  it('returns the planned writes and touches no I/O', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan, dryRun: true },
      io,
    );
    expect(res.status).toBe('dry-run');
    if (res.status === 'dry-run') {
      // observations changed + UploadMeta always changes; media is untouched.
      expect(res.writes.map((w) => w.role).sort()).toEqual(['observations', 'uploadMeta']);
      expect(res.snapshotPrefix).toContain('.sparcd-tagger-snapshots/jg/');
    }
    expect(rec.snapshots).toHaveLength(0);
    expect(rec.replaces).toHaveLength(0);
  });

  it('reports noop when there is nothing to sync', async () => {
    const cur = await canonical();
    const { io } = fakeIO(cur);
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan: emptyPlan(), dryRun: false },
      io,
    );
    expect(res.status).toBe('noop');
  });
});

describe('runSync — live write path', () => {
  it('snapshots all three files (+manifest last), replaces changed files in order, clears the journal', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan, dryRun: false },
      io,
    );

    expect(res.status).toBe('synced');
    // Snapshot set is the full pre-change canonical state, manifest written last.
    expect(rec.snapshots.map((s) => s.key.split('/').pop())).toEqual([
      'media.csv', 'observations.csv', 'UploadMeta.json', 'manifest.json',
    ]);
    // Only changed canonical files are replaced, media first then meta — here
    // media is unchanged so it's observations then UploadMeta.
    expect(rec.replaces.map((r) => r.key.split('/').pop())).toEqual([
      'observations.csv', 'UploadMeta.json',
    ]);
    expect(rec.replaces[0].etag).toBe('"obs-1"'); // wrote against the reviewed ETag
    expect(rec.cleared).toBe(1);
    if (res.status === 'synced') expect(res.summary.additions).toBe(1);
  });

  it('enters the conflict view when a canonical file changed since grounding', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    const staleBase = { ...baseFrom(cur), observations: { etag: '"obs-OLD"' } };
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: staleBase, plan, dryRun: false },
      io,
    );
    expect(res.status).toBe('conflict');
    if (res.status === 'conflict') expect(res.role).toBe('observations');
    expect(rec.replaces).toHaveLength(0); // nothing written on conflict
  });

  it('re-stamps the snapshot +1s and retries once on a 412 collision', async () => {
    const cur = await canonical();
    const firstStamp = snapshotStamp(NOW);
    const { io, rec } = fakeIO(cur, { snapshotFailsOn: (key) => key.includes(firstStamp) });
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan, dryRun: false },
      io,
    );
    expect(res.status).toBe('synced');
    // Every recorded snapshot landed under the bumped (+1s) prefix, manifest last.
    const bumped = snapshotStamp(new Date(NOW.getTime() + 1000));
    expect(rec.snapshots.every((s) => s.key.includes(bumped))).toBe(true);
    expect(rec.snapshots.at(-1)!.key.endsWith('manifest.json')).toBe(true);
  });

  it('reports unsupported when the backend will not enforce IfMatch (501)', async () => {
    const cur = await canonical();
    const { io } = fakeIO(cur, {
      replaceError: () => Object.assign(new Error('no'), { name: 'ConditionalPutUnsupportedError' }),
    });
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan, dryRun: false },
      io,
    );
    expect(res.status).toBe('unsupported');
  });
});

describe('reader-listing contract — snapshot subtree adds no images', () => {
  // The sparcd-web reader recurses subfolders but returns only .jpg/.mp4. So
  // every object the snapshot writes must be a non-image under the snapshots
  // prefix, or it would show up as a taggable image.
  const IMAGE_EXT = /\.(jpe?g|mp4)$/i;

  it('writes only non-image files under .sparcd-tagger-snapshots/', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const plan = buildSyncPlan(IMAGES, ADD_DRAFTS, null);
    await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan, dryRun: false },
      io,
    );
    expect(rec.snapshots.length).toBeGreaterThan(0);
    for (const s of rec.snapshots) {
      expect(s.key).toContain(`${PREFIX}.sparcd-tagger-snapshots/`);
      expect(IMAGE_EXT.test(s.key)).toBe(false);
    }
  });
});

describe('runSync — resume a partial sync from the journal', () => {
  it('verifies the written object and continues from the first pending one', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const journal: SyncJournal = {
      id: `sparcd-x::${PREFIX}`,
      bucket: 'sparcd-x',
      uploadPrefix: PREFIX,
      snapshotPrefix: `${PREFIX}.sparcd-tagger-snapshots/jg/stamp/`,
      user: 'jg',
      startedAt: NOW.toISOString(),
      objects: [
        { role: 'media', key: `${PREFIX}media.csv`, baseETag: '"media-1"', body: cur.media.text, intendedHash: cur.media.hash, status: 'written', newETag: '"media-2"' },
        { role: 'observations', key: `${PREFIX}observations.csv`, baseETag: '"obs-1"', body: 'OBSBODY', intendedHash: await sha256Hex('OBSBODY'), status: 'pending' },
        { role: 'uploadMeta', key: `${PREFIX}UploadMeta.json`, baseETag: '"meta-1"', body: 'METABODY', intendedHash: await sha256Hex('METABODY'), status: 'pending' },
      ],
    };
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan: emptyPlan(), dryRun: false, resumeJournal: journal },
      io,
    );
    expect(res.status).toBe('synced');
    // Media was already written, so resume only writes the two pending objects.
    expect(rec.replaces.map((r) => r.key.split('/').pop())).toEqual(['observations.csv', 'UploadMeta.json']);
    expect(rec.cleared).toBe(1);
  });

  it('a dry-run never writes, even with a resume journal present', async () => {
    const cur = await canonical();
    const { io, rec } = fakeIO(cur);
    const journal: SyncJournal = {
      id: `sparcd-x::${PREFIX}`,
      bucket: 'sparcd-x',
      uploadPrefix: PREFIX,
      snapshotPrefix: `${PREFIX}.sparcd-tagger-snapshots/jg/stamp/`,
      user: 'jg',
      startedAt: NOW.toISOString(),
      objects: [
        { role: 'observations', key: `${PREFIX}observations.csv`, baseETag: '"obs-1"', body: 'OBSBODY', intendedHash: await sha256Hex('OBSBODY'), status: 'pending' },
      ],
    };
    const res = await runSync(
      { bucket: 'sparcd-x', uploadPrefix: PREFIX, user: 'jg', base: baseFrom(cur), plan: emptyPlan(), dryRun: true, resumeJournal: journal },
      io,
    );
    expect(res.status).toBe('dry-run');
    expect(rec.replaces).toHaveLength(0);
    expect(rec.cleared).toBe(0);
  });
});

function emptyPlan(): SyncPlan {
  return { tagEdits: [], timeEdits: [], summary: { additions: 0, modifications: 0, removals: 0, timeCorrections: 0 } };
}
