# @sparcd/s3-safe

The single, blessed S3 boundary for the SPARC'd static tools. Every tool that
touches storage imports this; application code never constructs an
`@aws-sdk/client-s3` `S3Client` directly.

## Guarantees

1. **Bucket allowlist** — `SafeS3Client` requires a non-empty allowlist at
   construction (exact names or `*`-globs). Every method validates the bucket
   before any network call and throws `BucketNotAllowedError` otherwise.
2. **Read methods + one append-only writer:**
   - `listObjects(bucket, prefix?)` → `AsyncIterable<ObjectInfo>`
   - `getObject(bucket, key)` → `Uint8Array`
   - `statObject(bucket, key)` → metadata only
   - `presignedGet(bucket, key, ttlSec)` → URL
   - `writeImmutable(bucket, key, body, opts?)` → conditional `PutObject`
     with `IfNoneMatch: "*"`
3. **No destructive APIs** — no `delete*`, `copy*`, or overwriting `put*`.
   A `no-restricted-imports` lint rule should block `@aws-sdk/client-s3` at
   the application layer so this wrapper stays the only boundary.

## Conditional writes

`writeImmutable` sends `IfNoneMatch: "*"`. On `412` it throws
`PreconditionFailedError`; on `501`/`NotImplemented` it throws
`ConditionalPutUnsupportedError`. It never falls back to a HEAD-then-PUT path
— that TOCTOU race cannot be closed safely.

**Backend support (record verified versions here):** AWS S3 added conditional
`PutObject` in Aug 2024 and bucket-policy enforcement in Nov 2024. MinIO and
Cloudflare R2 also support conditional PUTs; exact tested versions land here
once verified against the project endpoints.

## Notes

- `detectBackendDefaults` (region / path-style / secure inference) lives in
  `@sparcd/types` because it is pure string logic shared with `@sparcd/auth-ui`,
  which must not pull in the AWS SDK. This wrapper re-exports it.
- `writeImmutableStream` (per-file streaming over `@aws-sdk/lib-storage`,
  used by the uploader) is a **P4** addition and is intentionally not yet
  present.
