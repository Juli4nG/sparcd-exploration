// The app's single point of contact with `@sparcd/s3-safe`. This is a static
// BYO-S3 app: bucket access is discovered at runtime from the connected
// credentials, not baked into the JS bundle. IAM/CORS and the wrapper's
// append-only methods are the real safety boundaries.

import { SafeS3Client, BucketNotAllowedError } from '@sparcd/s3-safe';
import type { S3Config } from '@sparcd/types';
import { LOCATIONS_KEY, parseLocations, type LocationsParse } from './locations';

// Client-side bucket allowlists are not a security boundary in a static app.
// They exist only because the wrapper requires an explicit scope; the connected
// user's IAM policy and bucket CORS decide what the app can actually touch.
const RUNTIME_BUCKET_SCOPE = ['*'];

// Cache the client by a stable identity of the connection so repeated reads
// (e.g. revisiting Assign) reuse one SDK client.
let cached: { key: string; client: SafeS3Client } | null = null;

function configKey(cfg: S3Config): string {
  return `${cfg.endpoint}|${cfg.region}|${cfg.accessKey}|${cfg.forcePathStyle}|${cfg.secure}`;
}

export function getClient(cfg: S3Config): SafeS3Client {
  const key = configKey(cfg);
  if (cached?.key === key) return cached.client;
  const client = new SafeS3Client(cfg, RUNTIME_BUCKET_SCOPE, RUNTIME_BUCKET_SCOPE);
  cached = { key, client };
  return client;
}

/**
 * Discover buckets that contain `Settings/locations.json`. Name preferences
 * keep official SPARC'd buckets first, but any readable bucket with the marker
 * works for BYO-S3 deployments.
 */
export async function discoverSettingsBuckets(client: SafeS3Client): Promise<string[]> {
  const buckets = await client.listBuckets();
  const found: string[] = [];
  await Promise.all(
    buckets.map(async (bucket) => {
      try {
        await client.statObject(bucket, LOCATIONS_KEY);
        found.push(bucket);
      } catch {
        // Not a settings bucket, not readable, or blocked by CORS. Keep probing.
      }
    }),
  );
  return found.sort((a, b) => settingsRank(a) - settingsRank(b) || a.localeCompare(b));
}

function settingsRank(bucket: string): number {
  if (bucket.startsWith('sparcd-settings-')) return 0;
  if (bucket === 'sparcd') return 1;
  return 2;
}

export async function discoverSettingsBucket(client: SafeS3Client): Promise<string> {
  const buckets = await discoverSettingsBuckets(client);
  if (buckets[0]) return buckets[0];
  throw new Error(
    `No readable settings bucket found. The connected credentials must be able to HEAD/GET "${LOCATIONS_KEY}" in one visible bucket, and that bucket must allow this web origin via CORS.`,
  );
}

export type LocationsResult = LocationsParse & { settingsBucket: string };

/**
 * Read + parse the location registry. Network/CORS failures surface as a
 * `Failed to fetch`-style error with no HTTP status, so we translate the
 * common cases into actionable messages — this is the "validate browser CORS
 * read behavior" surface for P2.
 */
export async function fetchLocations(cfg: S3Config): Promise<LocationsResult> {
  const client = getClient(cfg);
  const settingsBucket = await discoverSettingsBucket(client);
  let bytes: Uint8Array;
  try {
    bytes = await client.getObject(settingsBucket, LOCATIONS_KEY);
  } catch (err) {
    throw translateReadError(err, settingsBucket);
  }
  const text = new TextDecoder().decode(bytes);
  const parsed = parseLocations(text);
  return { ...parsed, settingsBucket };
}

export type CollectionRef = { key: string; bucket: string; uuid: string };

const COLLECTION_JSON =
  /^Collections\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/collection\.json$/;

/** Discover collections by looking for `Collections/<uuid>/collection.json`. */
export async function listCollections(cfg: S3Config): Promise<CollectionRef[]> {
  const client = getClient(cfg);
  const buckets = await client.listBuckets();
  const found: CollectionRef[] = [];
  const seen = new Set<string>();
  await Promise.all(
    buckets.map(async (bucket) => {
      try {
        for await (const obj of client.listObjects(bucket, 'Collections/')) {
          const m = obj.key.match(COLLECTION_JSON);
          if (!m) continue;
          const uuid = m[1].toLowerCase();
          const key = `${bucket}::${uuid}`;
          if (seen.has(key)) continue;
          seen.add(key);
          found.push({ key, bucket, uuid });
        }
      } catch {
        // Bucket is not readable/listable for collections, or CORS blocked it.
      }
    }),
  );
  return found.sort((a, b) => a.bucket.localeCompare(b.bucket) || a.uuid.localeCompare(b.uuid));
}

/** Read a collection's display name from its `collection.json`, or null. */
export async function fetchCollectionName(cfg: S3Config, ref: CollectionRef): Promise<string | null> {
  try {
    const bytes = await getClient(cfg).getObject(ref.bucket, `Collections/${ref.uuid}/collection.json`);
    const doc = JSON.parse(new TextDecoder().decode(bytes)) as { nameProperty?: string };
    return doc.nameProperty?.trim() || null;
  } catch {
    return null;
  }
}

function translateReadError(err: unknown, bucket: string): Error {
  if (err instanceof BucketNotAllowedError) return err;
  const e = err as { name?: string; message?: string; $metadata?: { httpStatusCode?: number } };
  const status = e.$metadata?.httpStatusCode;
  if (status === 404 || e.name === 'NoSuchKey') {
    return new Error(`"${LOCATIONS_KEY}" not found in bucket "${bucket}".`);
  }
  if (status === 403 || e.name === 'AccessDenied') {
    return new Error(`Access denied reading "${LOCATIONS_KEY}" — check the key's read permissions.`);
  }
  // No HTTP status from a browser fetch almost always means the request never
  // completed: a CORS preflight rejection or a network/DNS/TLS failure.
  if (status === undefined) {
    return new Error(
      `Could not reach the endpoint to read "${LOCATIONS_KEY}". If the endpoint is correct, ` +
        `the bucket's CORS policy likely needs to allow GET/HEAD from this origin.`,
    );
  }
  return new Error(`Failed to read "${LOCATIONS_KEY}" (HTTP ${status}).`);
}
