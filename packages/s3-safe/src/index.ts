// The single, blessed S3 boundary. Every tool that touches storage imports
// this. It enforces guardrails the application code cannot bypass:
//
//   1. Bucket allowlist — validated at construction and on every call.
//   2. Read methods only, plus one append-only writer (`writeImmutable`).
//   3. No destructive APIs — no delete*, copy*, or overwriting put*.
//
// `writeImmutableStream` (the uploader's per-file streaming writer over
// `@aws-sdk/lib-storage`) is a P4 addition and is intentionally absent here.
// See ../README.md for backend support notes.

import {
  S3Client,
  ListBucketsCommand,
  ListObjectsV2Command,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Config } from '@sparcd/types';

export type { S3Config } from '@sparcd/types';
export { detectBackendDefaults } from '@sparcd/types';

export type ObjectInfo = {
  key: string;
  size: number;
  lastModified?: Date;
  etag?: string;
};

export type ObjectStat = {
  size: number;
  lastModified?: Date;
  etag?: string;
  contentType?: string;
  metadata: Record<string, string>;
};

/** Thrown when a bucket outside the allowlist is touched. */
export class BucketNotAllowedError extends Error {
  constructor(bucket: string) {
    super(`Bucket "${bucket}" is not in the allowlist`);
    this.name = 'BucketNotAllowedError';
  }
}

/**
 * Thrown when the backend does not enforce the `IfNoneMatch: "*"`
 * precondition (501 NotImplemented, or a silent 200). The wrapper never
 * falls back to HEAD-then-PUT — that race cannot be closed safely.
 */
export class ConditionalPutUnsupportedError extends Error {
  constructor(message = 'Backend did not enforce IfNoneMatch precondition') {
    super(message);
    this.name = 'ConditionalPutUnsupportedError';
  }
}

/** Thrown by `writeImmutable` when the key already exists (412). */
export class PreconditionFailedError extends Error {
  constructor(key: string) {
    super(`Object already exists at "${key}"`);
    this.name = 'PreconditionFailedError';
  }
}

function endpointUrl(cfg: S3Config): string {
  if (/^https?:\/\//i.test(cfg.endpoint)) return cfg.endpoint;
  const scheme = cfg.secure === false ? 'http' : 'https';
  return `${scheme}://${cfg.endpoint}`;
}

// Allowlist entries are exact bucket names or globs where `*` matches any
// run of non-`/` characters (`s3:*`-style prefix conditions are separate).
function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp(`^${escaped}$`);
}

export class SafeS3Client {
  private readonly client: S3Client;
  private readonly allow: RegExp[];

  constructor(cfg: S3Config, allowlist: string[]) {
    if (allowlist.length === 0) {
      throw new Error('SafeS3Client requires a non-empty bucket allowlist');
    }
    this.allow = allowlist.map(globToRegExp);
    this.client = new S3Client({
      endpoint: endpointUrl(cfg),
      region: cfg.region,
      forcePathStyle: cfg.forcePathStyle,
      credentials: { accessKeyId: cfg.accessKey, secretAccessKey: cfg.secretKey },
    });
  }

  private assertAllowed(bucket: string): void {
    if (!this.allow.some((re) => re.test(bucket))) {
      throw new BucketNotAllowedError(bucket);
    }
  }

  /**
   * List bucket names. This is the discovery primitive (e.g. finding the
   * settings bucket) and returns names only, so it is intentionally *not*
   * gated by the allowlist — the allowlist scopes object operations, and a
   * caller still cannot read or write a disallowed bucket's objects.
   */
  async listBuckets(): Promise<string[]> {
    const res = await this.client.send(new ListBucketsCommand({}));
    return (res.Buckets ?? []).map((b) => b.Name!).filter(Boolean);
  }

  async *listObjects(bucket: string, prefix?: string): AsyncIterable<ObjectInfo> {
    this.assertAllowed(bucket);
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          ContinuationToken: token,
        }),
      );
      for (const o of res.Contents ?? []) {
        yield {
          key: o.Key!,
          size: o.Size ?? 0,
          lastModified: o.LastModified,
          etag: o.ETag,
        };
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
  }

  async getObject(bucket: string, key: string): Promise<Uint8Array> {
    this.assertAllowed(bucket);
    const res = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return res.Body!.transformToByteArray();
  }

  async statObject(bucket: string, key: string): Promise<ObjectStat> {
    this.assertAllowed(bucket);
    const res = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return {
      size: res.ContentLength ?? 0,
      lastModified: res.LastModified,
      etag: res.ETag,
      contentType: res.ContentType,
      metadata: res.Metadata ?? {},
    };
  }

  async presignedGet(bucket: string, key: string, ttlSec: number): Promise<string> {
    this.assertAllowed(bucket);
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: ttlSec,
    });
  }

  /**
   * Atomic, append-only write: conditional `PutObject` with
   * `IfNoneMatch: "*"`. Throws `PreconditionFailedError` (412) if `key`
   * exists, or `ConditionalPutUnsupportedError` if the backend won't
   * enforce the precondition. No HEAD-then-PUT fallback, ever.
   */
  async writeImmutable(
    bucket: string,
    key: string,
    body: Uint8Array | string,
    opts: { contentType?: string; metadata?: Record<string, string> } = {},
  ): Promise<void> {
    this.assertAllowed(bucket);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          IfNoneMatch: '*',
          ContentType: opts.contentType,
          Metadata: opts.metadata,
        }),
      );
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      const status = e.$metadata?.httpStatusCode;
      if (status === 412 || e.name === 'PreconditionFailed') {
        throw new PreconditionFailedError(key);
      }
      if (status === 501 || e.name === 'NotImplemented') {
        throw new ConditionalPutUnsupportedError();
      }
      throw err;
    }
  }
}
