# @sparcd/s3-safe

The single, blessed S3 boundary for the SPARC'd static tools. Every tool that
touches storage imports this; application code never constructs an
`@aws-sdk/client-s3` `S3Client` directly.

## Guarantees

1. **Explicit bucket scope.** `SafeS3Client(cfg, readAllowlist, writeAllowlist?)`
   requires a non-empty **read** scope (exact names or `*`-globs). The
   **write** scope is a separate argument, **empty by default**: with no grant,
   every write throws `BucketNotWritableError` before any network call. In a
   static BYO-S3 app this scope is not a security boundary — IAM and CORS are.
   The value is still useful to keep call sites deliberate and to support
   managed deployments that want narrower client-side scope.
2. **Read methods + two append-only writers:**
   - `listObjects(bucket, prefix?)` → `AsyncIterable<ObjectInfo>`
   - `getObject(bucket, key)` → `Uint8Array`
   - `statObject(bucket, key)` → metadata only (used for the HEAD verify path)
   - `presignedGet(bucket, key, ttlSec)` → URL
   - `writeImmutable(bucket, key, body, opts?)` → conditional `PutObject`
     for small atomic objects (manifests, CSVs)
   - `writeImmutableStream(bucket, key, blob, opts)` → per-file streaming
     write for image blobs; single-PUT or multipart, both conditional
3. **No destructive APIs** — no `delete*`, `copy*`, overwriting `put*`, and
   **no `AbortMultipartUpload`**. A failed multipart upload leaves its parts
   in place; a **bucket lifecycle rule that aborts incomplete multipart
   uploads after N days (recommend 7) is the only cleanup mechanism and is a
   mandatory deployment requirement**. A `no-restricted-imports` lint rule
   should block `@aws-sdk/client-s3` at the application layer so this wrapper
   stays the only boundary.

## Conditional writes

Both writers send `IfNoneMatch: "*"`. On `412` they throw
`PreconditionFailedError`; on `501`/`NotImplemented` they throw
`ConditionalPutUnsupportedError`. Neither falls back to a HEAD-then-PUT path
— that TOCTOU race cannot be closed safely.

### `writeImmutableStream` and the multipart-complete spike (P4)

`writeImmutableStream` does **not** delegate to `@aws-sdk/lib-storage`'s
`Upload`. The P4 spike asked whether `Upload` can attach `IfNoneMatch` to the
**completion** step of a multipart upload. It cannot: `Upload` applies the
caller's params to `CreateMultipartUpload`, and there is no hook to set a
header on `CompleteMultipartUpload`. A precondition on *create* does not
prevent a colliding *complete*, so going through `Upload` would silently lose
the immutability guarantee on any file large enough to go multipart.

The method therefore orchestrates multipart itself (verified against
`@aws-sdk/client-s3` ≥ 3.658; `CompleteMultipartUploadRequest.IfNoneMatch`
is present):

- **Body at or under `partSize`** (default 8 MiB) → one `PutObject` with
  `IfNoneMatch: "*"`.
- **Larger** → `CreateMultipartUpload` → `UploadPart` (lazy `Blob.slice`
  parts, bounded internal concurrency) → `CompleteMultipartUpload` with
  `IfNoneMatch: "*"`.

The precomputed SHA-256 is always written as `x-amz-meta-sha256`. The native
`x-amz-checksum-sha256` header is opt-in (`nativeChecksum`) because backend
support is uneven; the portable verification path is a `HEAD` confirming
`Content-Length` and `x-amz-meta-sha256`.

**Backend enforcement (record verified versions here):** AWS S3 added
conditional `PutObject` (Aug 2024), bucket-policy enforcement (Nov 2024), and
conditional `CompleteMultipartUpload` (separately). MinIO and Cloudflare R2
also support conditional PUTs; **live enforcement of the conditional complete
on the project's MinIO endpoint is still a P4 deployment gate** — until proven
on the target backend, treat the multipart immutability guarantee as
unverified there.

## Notes

- `detectBackendDefaults` (region / path-style / secure inference) lives in
  `@sparcd/types` because it is pure string logic shared with `@sparcd/auth-ui`,
  which must not pull in the AWS SDK. This wrapper re-exports it.
