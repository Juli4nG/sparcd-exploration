import { describe, it, expect } from 'vitest';
import {
  SafeS3Client,
  BucketNotAllowedError,
  listCollections,
  parseCollectionKey,
  translateReadError,
} from '../src/index';

// `listCollections` only ever calls `listBuckets()` and `getObject()`, so a
// duck-typed stub covering those two is enough to exercise its filtering,
// parsing, skip-on-error, and sort behavior without a live backend.
function fakeClient(
  buckets: string[],
  objects: Record<string, unknown | Error>,
): SafeS3Client {
  return {
    async listBuckets() {
      return buckets;
    },
    async getObject(bucket: string, key: string) {
      const hit = objects[`${bucket}/${key}`];
      if (hit === undefined || hit instanceof Error) throw hit ?? new Error('NoSuchKey');
      return new TextEncoder().encode(JSON.stringify(hit));
    },
  } as unknown as SafeS3Client;
}

describe('parseCollectionKey', () => {
  it('splits a `bucket::uuid` key', () => {
    expect(parseCollectionKey('sparcd-ABC::abc')).toEqual({ bucket: 'sparcd-ABC', uuid: 'abc' });
  });
});

describe('listCollections', () => {
  it('keeps only `sparcd-<uuid>` buckets, skips unreadable markers, and sorts by name', async () => {
    const client = fakeClient(
      // `other` lacks the prefix; bare `sparcd-` has nothing after it; `sparcd-NOPE`
      // is a candidate whose marker GET fails and must be skipped, not fatal.
      ['sparcd-ZED', 'sparcd-ALF', 'other-bucket', 'sparcd-', 'sparcd-NOPE'],
      {
        'sparcd-ZED/Collections/zed/collection.json': {
          nameProperty: 'Zebra',
          organizationProperty: 'Org Z',
        },
        'sparcd-ALF/Collections/alf/collection.json': { nameProperty: 'Alpha' },
        'sparcd-NOPE/Collections/nope/collection.json': new Error('AccessDenied'),
      },
    );

    const result = await listCollections(client);

    // Alpha sorts before Zebra; the prefix-only and non-prefixed buckets and the
    // unreadable candidate are all absent.
    expect(result.map((c) => c.bucket)).toEqual(['sparcd-ALF', 'sparcd-ZED']);
    expect(result[0]).toEqual({
      key: 'sparcd-ALF::alf',
      bucket: 'sparcd-ALF',
      uuid: 'alf', // lowercased from the bucket suffix
      name: 'Alpha',
      organization: null, // absent organizationProperty → null
    });
    expect(result[1].organization).toBe('Org Z');
  });
});

describe('translateReadError', () => {
  const meta = (httpStatusCode?: number) => ({ $metadata: { httpStatusCode } });

  it('passes a BucketNotAllowedError through untouched', () => {
    const err = new BucketNotAllowedError('sparcd-x');
    expect(translateReadError(err, 'thing')).toBe(err);
  });

  it('maps 404 / NoSuchKey to a not-found message', () => {
    expect(translateReadError(meta(404), 'UploadMeta.json').message).toBe(
      'UploadMeta.json not found.',
    );
    expect(translateReadError({ name: 'NoSuchKey' }, 'UploadMeta.json').message).toBe(
      'UploadMeta.json not found.',
    );
  });

  it('maps 403 / AccessDenied to a permissions message', () => {
    expect(translateReadError(meta(403), 'x').message).toMatch(/Access denied reading x/);
    expect(translateReadError({ name: 'AccessDenied' }, 'x').message).toMatch(/Access denied/);
  });

  it('maps a status-less failure to the CORS / unreachable message', () => {
    // The browser-direct-to-S3 case: a CORS preflight rejection aborts before
    // any HTTP response, so there is no status code.
    expect(translateReadError(meta(undefined), 'x').message).toMatch(/CORS policy/);
  });

  it('falls back to the HTTP status for any other failure', () => {
    expect(translateReadError(meta(500), 'x').message).toBe('Failed to read x (HTTP 500).');
  });
});
