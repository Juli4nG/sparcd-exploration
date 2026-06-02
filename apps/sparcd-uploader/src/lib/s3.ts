// The app's single point of contact with `@sparcd/s3-safe`. P2 is read-only:
// discover the settings bucket and fetch `Settings/locations.json`. Writes
// land in P4. One client is cached per S3Config so TanStack Query and later
// phases share it instead of reconstructing the AWS SDK client per call.

import { SafeS3Client, BucketNotAllowedError } from '@sparcd/s3-safe';
import type { S3Config } from '@sparcd/types';
import { LOCATIONS_KEY, parseLocations, type LocationsParse } from './locations';

// Read allowlist: the settings bucket plus per-collection buckets, all under
// the `sparcd` family. Override with a comma-separated VITE_S3_BUCKETS.
// `sparcd-*` covers both `sparcd-settings-*` and the `sparcd-<uuid>` buckets.
const DEFAULT_ALLOWLIST = ['sparcd', 'sparcd-*'];

function allowlist(): string[] {
  const raw = import.meta.env.VITE_S3_BUCKETS as string | undefined;
  if (!raw) return DEFAULT_ALLOWLIST;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

// Write allowlist: empty by default — wet uploads are refused until a test
// bucket is named in VITE_S3_WRITE_BUCKETS (comma-separated). Reads stay broad
// (the `sparcd-*` read allowlist) while writes stay pinned to vetted buckets.
// This is the env half of the plan's "S3_TEST_BUCKETS, enforced at wrapper
// construction" safety layer; the production lift is a separate, reviewed step.
export function writeAllowlist(): string[] {
  const raw = import.meta.env.VITE_S3_WRITE_BUCKETS as string | undefined;
  if (!raw) return [];
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Whether `bucket` is currently write-enabled (matches the write allowlist). */
export function isWriteEnabled(bucket: string): boolean {
  return writeAllowlist().some((pattern) => {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*') + '$');
    return re.test(bucket);
  });
}

// Cache the client by a stable identity of the connection so repeated reads
// (e.g. revisiting Assign) reuse one SDK client.
let cached: { key: string; client: SafeS3Client } | null = null;

function configKey(cfg: S3Config): string {
  return `${cfg.endpoint}|${cfg.region}|${cfg.accessKey}|${cfg.forcePathStyle}|${cfg.secure}`;
}

export function getClient(cfg: S3Config): SafeS3Client {
  const key = configKey(cfg);
  if (cached?.key === key) return cached.client;
  const client = new SafeS3Client(cfg, allowlist(), writeAllowlist());
  cached = { key, client };
  return client;
}

/**
 * Find the settings bucket the SPARC'd way: prefer a `sparcd-settings-*`
 * bucket, fall back to the legacy `sparcd` bucket. Throws a clear error if
 * neither is visible to these credentials.
 */
export async function discoverSettingsBucket(client: SafeS3Client): Promise<string> {
  const buckets = await client.listBuckets();
  const settings = buckets.find((b) => b.startsWith('sparcd-settings-'));
  if (settings) return settings;
  if (buckets.includes('sparcd')) return 'sparcd';
  throw new Error(
    'No settings bucket found (looked for "sparcd-settings-*" or legacy "sparcd").',
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

export type CollectionRef = { bucket: string; uuid: string };

// A per-collection bucket is `sparcd-<uuid>`; the settings bucket (`sparcd`,
// `sparcd-settings-*`) is not a collection.
const COLLECTION_BUCKET = /^sparcd-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Discover the collection buckets visible to these credentials (names only). */
export async function listCollections(cfg: S3Config): Promise<CollectionRef[]> {
  const buckets = await getClient(cfg).listBuckets();
  return buckets
    .map((b) => {
      const m = b.match(COLLECTION_BUCKET);
      return m ? { bucket: b, uuid: m[1] } : null;
    })
    .filter((c): c is CollectionRef => c !== null)
    .sort((a, b) => a.bucket.localeCompare(b.bucket));
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
