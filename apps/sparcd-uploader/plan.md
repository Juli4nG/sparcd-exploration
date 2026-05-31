# sparcd-uploader — implementation plan

A static, browser-based upload tool for SPARC'd camera-trap image batches.
Takes a local folder of JPEGs, extracts EXIF, lets the user assign a
deployment (camera location), generates the Camtrap-DP CSV trio plus
`UploadMeta.json`, uploads image blobs to S3, and publishes the completed
bundle metadata under a fresh upload prefix in an S3-compatible bucket.

Sits alongside SPARC'd; produces upload bundles whose layout matches the
existing Java and Next.js readers under
`Collections/<uuid>/Uploads/<timestamp>_<user>/` once the bundle is
complete. Tagging is deferred to
[sparcd-tagger](../sparcd-tagger/plan.md) — initial uploads always carry an
empty `observations.csv` so downstream tools have a stable canonical base
file to hash.

## Design references

The Claude Design bundle is the source of truth for layout, copy, and
component behavior; this plan is the source of truth for data, safety, and
persistence contracts. Read both side-by-side.

- **Latest Claude Design bundle** (Uploader, post rev-4 — simplified login):
  <https://api.anthropic.com/v1/design/h/UIxTk3s58j290-DB649lmw?open_file=SPARCd+Uploader.html>
  Each iteration produces a new URL; update this entry when a newer build
  supersedes it. The Connection screen is **shared** with the Tagger; both
  bundles include the same Connection component.
- [`../../docs/design-system-field-notebook.md`](../../docs/design-system-field-notebook.md)
  — locked Field Notebook v2 tokens, typography, controls, and the walnut
  dark variant.

## Goal

A researcher can drag a folder of camera-trap images into the browser,
confirm the deployment and EXIF timestamps look right, and upload a
complete Camtrap-DP-shaped bundle to S3 — without a desktop install, with
visible per-file progress, and with resume-on-failure so a flaky connection
doesn't lose work. After a closed tab, the app resumes automatically when
the browser grants persistent file handles; otherwise it asks the user to
reselect the same folder and reconciles by relative path, size, and hash.

## Stack

Same shape as the tagger; additions reflect the upload-specific work.

- **Vite + React 18 + TypeScript** — static SPA, same build target
- **Tailwind + shadcn/ui** — UI primitives
- **TanStack Query** — S3 fetch cache (deployment/location reads)
- **TanStack Virtual** — virtualized file list for big batches
- **Zustand** — upload-session state
- **Dexie.js** — IndexedDB for resumable upload state
- **`@aws-sdk/client-s3`** — same client as the tagger; portable across
  MinIO / AWS S3 / Cloudflare R2
- **`exifr`** — EXIF parsing (timestamps, camera model, optional GPS)
- **Web Workers** — file hashing and EXIF parsing off the main thread, to
  keep the UI responsive on multi-thousand-image batches
- **`p-limit`** — bounded concurrency for parallel PUTs

No multipart upload in v0; v0 rejects files above the single-PUT ceiling
(see Out of scope). Multipart lands in P6 if real batches need it.

## Shared packages

Reuses everything the tagger established:

- **`@sparcd/s3-safe`** — same wrapper. The `writeImmutable` semantics
  (atomic `PutObject` with `IfNoneMatch: "*"`, no fallback) fit upload
  PUTs exactly: every object lands at a deterministic new key, so the
  conditional check prevents accidental collision with an in-flight or
  prior upload.
- **`@sparcd/camtrap`** — the reader becomes a writer-of-record here. The
  uploader builds `Deployment`, `Media`, and (empty) `Observation`
  collections in memory and serializes via the same round-trip-stable
  encoder the tagger reads.
- **`@sparcd/types`** — `Collection`, `Species`, `UserSession`, etc.
- **`@sparcd/auth-ui`** — the shared credentials/connection screen, the
  same component the tagger uses; parameterized only by the tool name in
  the chrome. Produces the `S3Config` consumed by `@sparcd/s3-safe`.

No new package introduced by this tool. If a third app later needs EXIF
parsing, lift `exifr`-driven extraction into a `@sparcd/exif` package at
that point — not now.

### Wrapper changes needed in `@sparcd/s3-safe`

The current method set covers single-PUT uploads:

- `listObjects`, `getObject`, `statObject`, `presignedGet`
- `writeImmutable(bucket, key, body)` — atomic conditional `PutObject`

The uploader's needs are **already covered** by the existing surface;
nothing new is required for v0. A future multipart-capable variant in P6
would add `writeImmutableLarge(bucket, key, blob, {onProgress})` with the
same `IfNoneMatch: "*"` guarantee at the `CompleteMultipartUpload` step.

## Architecture

### Data flow

```
Local folder ─drop─►  File list                                            ─┐
                          │                                                  │
                          ▼                                                  │
                  Web Worker pool                                            │
                   ├─ EXIF parse  (timestamps, model, GPS)                  │
                   └─ SHA-256 hash (dedup + integrity)                      │
                          │                                                  │
                          ▼                                                  │
Settings/locations.json ─►  Deployment picker  ─►  Bundle builder            │
                                                       │                     │
                                                       ▼                     │
                                            Camtrap-DP CSVs + completion    │
                                                       │                     │
                                                       ▼                     │
                                            Upload queue (p-limit, Dexie)   │
                                                       │                     │
                                                       ▼                     ▼
                       writeImmutable() → blobPrefix images, then uploadPrefix CSVs + manifest
```

### Layout

Four-step linear flow rather than a three-pane editor; the upload task is
naturally sequential.

1. **Drop** — drag-and-drop or "Choose folder" picker. Recursive scan.
2. **Inspect** — virtualized file list with thumbnail, filename, EXIF
   timestamp, dimensions, file size, hash, and validation state. Rows
   that fail validation surface inline reasons; bulk "drop invalid" or
   "fix manually" actions.
3. **Assign** — deployment picker (combobox over
   `Settings/locations.json`, path/shape validated in P2), uploader-user
   field, upload description,
   target collection (bucket). Preview the five metadata files
   (`UploadMeta.json`, `UploadComplete.json`, `deployments.csv`,
   `media.csv`, `observations.csv`) inline before commit.
4. **Upload** — progress per file + aggregate. Dry-run toggle on by
   default for the first session. After completion: summary, links, and
   a "Next batch" button that keeps the deployment and uploader fields.

### Login screen

The shared `@sparcd/auth-ui` connection screen — the same component the
tagger uses, parameterized only by the tool name in the chrome
("SPARC'd · Uploader"). **Three fields — endpoint, access key, secret
key** — with secure/region/path-style inferred from the endpoint (rare
overrides behind an "Advanced" disclosure); identity + dry-run default live
in Settings. Same `.env`-during-dev-only-non-secret-prefill rule. Both apps
consume it from day one; it is not duplicated per tool.

### Persistence — local

Dexie tracks every upload-session state needed for resume.

- **Dexie schema** v1:
  - `batches` table:
    `{ id (sessionId), targetBucket, uploadPrefix, blobPrefix,
    deploymentId, uploaderUser, description, startedAt, completedAt,
    totalFiles, totalBytes, fileAccessMode }`
    where `fileAccessMode` is `persistent-handle` when a durable
    `FileSystemDirectoryHandle` is stored, or `reselect-required` when the
    user must reselect the folder before resume.
  - `files` table:
    `{ id (sessionId+localPath), sessionId, localPath, fileName,
    relPathInBundle, sanitizedObjectName, size, sha256, exifTimestamp,
    exifCamera, state (pending|uploading|done|failed), remoteKey,
    remoteETag, attempt, lastError }`
  - `bundles` table:
    `{ sessionId, uploadMetaJson, deploymentsCsv, mediaCsv,
    observationsCsv, uploadCompleteJson, csvHashes }`
- **File access contract.** Browser paths are not durable capabilities. On
  Chromium, the app stores the chosen `FileSystemDirectoryHandle` in
  IndexedDB when permission is granted and revalidates permission before
  resuming. On browsers without durable handles, or when permission is
  revoked, resume shows a "Reselect folder" step and reconciles files by
  relative path, size, and SHA-256 before queuing remaining work. The app
  never claims it can upload bytes after a browser restart from `localPath`
  alone.
- **Resume contract.** On reopen, any `batches` row without
  `completedAt` is offered as a resumable session. Files in state
  `done` are skipped after a `statObject` size/hash metadata sanity check;
  `pending` / `failed` are queued once local file access is restored.
- **Schema versioning.** Same rule as the tagger: Dexie's versioning API
  with forward-carrying `upgrade` callbacks; no ad-hoc store mutations.
- **Discard local state.** Per-batch button to drop the session row plus
  its files. Never touches remote state.

### Persistence — S3 sync (i.e. the upload itself)

- **Prefix choice.** The new upload prefix is
  `Collections/<uuid>/Uploads/<ISO>_<uploaderUser>/`. Collision risk is
  near-zero with second-resolution timestamps. If any final-prefix
  metadata write returns 412, the uploader abandons that prefix, bumps the
  timestamp by one second, and retries with a fresh upload prefix.
  `UploadComplete.json` is the source of truth for whether a prefix is
  publishable.
- **Blob staging.** Image bytes are uploaded first under a non-discovered
  blob prefix:
  `Collections/<uuid>/UploadBlobs/<sessionId>/<sha256>.<ext>`. The
  canonical `media.csv` stores these full object keys in `media_path`, so
  existing image display code can presign the media path directly even
  though the bytes are outside the upload prefix. This avoids exposing a
  half-populated upload directory while large files are still transferring.
- **Order of operations.**
  1. Stream image PUTs to `blobPrefix` in parallel under `p-limit` (default 4, slider
     2–16). Each is `writeImmutable`, so a retry never overwrites.
  2. Generate the final bundle metadata from successfully uploaded blobs.
  3. Write `deployments.csv`, `media.csv`, and the always-empty
     `observations.csv` under `uploadPrefix`.
  4. Write `UploadMeta.json` under `uploadPrefix`.
  5. Write `UploadComplete.json` last under `uploadPrefix`; this is the
     completion sentinel for new SPARC'd tools.
- **Partial-publish rule.** S3 has no atomic directory publish, and this
  wrapper intentionally exposes no `copy` or overwrite APIs. Therefore P4
  may write final-prefix CSV/metadata files only in test buckets. Before
  production-bucket writes, every reader this project controls must ignore
  upload prefixes that lack `UploadComplete.json`, and existing Java/Next
  reader behavior must be verified or updated. The completed layout still
  matches the existing upload shape, but the visibility contract is
  sentinel-based for safety.
- **Final CSV timing.** The three CSVs are written after the blobs because
  they reference media paths from step 1, so deferring them lets us record
  actual sizes and `remoteETag` values in `media.csv` if the schema needs
  it.
- **Hash sanity.** SHA-256 is the app's integrity digest. For each blob PUT,
  send the SHA-256 as object metadata and, where the backend supports it,
  as a checksum header. After upload, `statObject` must confirm size and
  SHA-256 metadata. ETag is stored for diagnostics only; it is not treated
  as a portable content hash across S3-compatible backends.
- **No deletes, ever.** A partial upload leaves orphan objects in the
  blob prefix or an incomplete final prefix; recovery is to re-run the same
  session (skips verified `done` files, completes the rest) or abandon and
  start a new prefix. Cleanup is an explicit future admin operation, not
  part of this tool.
- **The existing canonical upload tree stays read-only** in this tool —
  the uploader creates new prefixes, never modifies existing ones.

## Safety design

Higher bar than the tagger because every byte written is a canonical
data byte, not an append-only sidecar. Four layers, same redundancy
shape as the tagger:

1. **IAM policy** — separate access key whose policy permits
   `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` on the test
   buckets only, with prefix conditions where the backend supports them:
   `Collections/*/UploadBlobs/*` and `Collections/*/Uploads/*` for writes,
   `Settings/locations.json` for reads. **No `s3:DeleteObject`** at the
   policy level.
2. **`@sparcd/s3-safe` wrapper** — same single boundary. Same lint rule.
3. **Bucket allowlist** — `S3_TEST_BUCKETS` env var, enforced at wrapper
   construction. Production bucket lift happens only after a recorded
   manual review of: the wrapper, the upload sequence (blob staging,
   final-prefix sentinel, conditional PUTs, no overwrite paths), reader
   handling for `UploadComplete.json`, and the dry-run logs from a
   successful test-bucket run.
4. **Completion sentinel** — `UploadComplete.json` is the final
   coordinating object. If two researchers race for the same timestamp,
   any 412 on a final-prefix metadata object makes the loser abandon that
   prefix, re-stamp, and retry on a fresh prefix.

Plus a **dry-run toggle** on the upload action, on by default for the
first session. Dry-run logs every PUT the run would issue (bucket, key,
size, hash) and writes nothing.

## Validation rules

Per file, before the file can be queued:

- File type is JPEG. Other types are rejected in v0 (see Out of scope).
- File size ≤ single-PUT ceiling (5 GiB on AWS / R2 / MinIO; default
  uploader rejection threshold is 100 MiB to keep batches sane until P6).
- EXIF parses successfully; `DateTimeOriginal` (or fallback) is present
  and yields a parseable timestamp. Files without timestamps go into a
  "needs attention" bucket with a manual-entry affordance.
- File is unique within the session (SHA-256 dedup). Duplicates show as
  warnings, not errors — researcher can choose to keep or drop.

Per batch, before upload can start:

- A deployment is selected.
- All files in the batch are valid (or explicitly accepted as
  warnings).
- `uploaderUser` is non-empty and normalized to a safe slug:
  lowercase ASCII letters, digits, `_`, and `-`; no slashes, whitespace,
  control characters, or path traversal-looking segments.
- Each bundle-relative filename is normalized before it becomes an object
  key: Unicode normalized, path separators collapsed to `/`, `.` / `..`
  segments rejected, control characters removed, and collisions resolved
  deterministically with a short hash suffix.

## Camtrap-DP CSV generation

`deployments.csv` — one row, sourced from the chosen deployment in
`Settings/locations.json`. `deployment_id` is
`<collection-uuid>:<location-id>` to match the existing convention seen
in the Educational Test collection.

`media.csv` — one row per file. `media_path` is the full S3 object key for
the uploaded blob under
`Collections/<uuid>/UploadBlobs/<sessionId>/<sha256>.<ext>`.
`file_name` is the local filename, and `deployment_id` matches the single
row in `deployments.csv`. `mime_type` is `image/jpeg`.

`observations.csv` — always written as an empty file in v0. Observations
are written later by sparcd-tagger as append-only versions under
`<uploadPrefix>/observations/<userId>/`. Always writing the empty canonical
file gives the tagger a stable base hash and avoids reader-specific
absence behavior.

`UploadMeta.json` — matches the shape we already verified from the
Educational Test bucket:

```json
{
  "uploadUser": "<uploaderUser>",
  "uploadDate": { "date": {...}, "time": {...} },
  "imagesWithSpecies": 0,
  "imageCount": <n>,
  "editComments": [],
  "bucket": "<targetBucket>",
  "uploadPath": "Collections/<uuid>/Uploads/<ISO>_<uploaderUser>",
  "description": "<userDescription>"
}
```

`UploadComplete.json` — final sentinel written last:

```json
{
  "schemaVersion": 1,
  "uploadPath": "Collections/<uuid>/Uploads/<ISO>_<uploaderUser>",
  "blobPrefix": "Collections/<uuid>/UploadBlobs/<sessionId>/",
  "fileCount": <n>,
  "bundleSha256": "<hash of UploadMeta + CSV payloads>",
  "completedAt": "<ISO timestamp>"
}
```

`bundleSha256` is deterministic: concatenate, in this exact order, the
JSON-canonical UTF-8 bytes of `UploadMeta.json`, then the UTF-8 bytes of
`deployments.csv`, `media.csv`, and `observations.csv`; compute SHA-256
over that byte stream.

## Keyboard shortcuts (initial set)

Smaller than the tagger; this tool is mouse-friendly by nature.

| Key | Action |
|---|---|
| `Enter` | Advance to next step |
| `Esc` | Cancel current step / close modal |
| `J` / `K` | Next / previous file in the inspect list |
| `D` | Drop selected file from the batch |
| `?` | Toggle cheatsheet modal |

## Phased delivery

| Phase | Scope | S3 writes |
|---|---|---|
| **P0** | Scaffold app, reuse the four shared packages (`s3-safe`, `camtrap`, `types`, `auth-ui`); shared Connection screen; drag-drop folder, virtualized file list (no S3 reads/writes) | None |
| **P1** | EXIF parse + SHA-256 hash in Web Workers; thumbnail generation; validation rules; safe user/file key normalization | None |
| **P2** | Deployment picker reading `Settings/locations.json`; validate exact path, JSON shape, and browser CORS read behavior | Reads only |
| **P3** | In-memory Camtrap-DP CSV generation; preview `UploadMeta.json`, `UploadComplete.json`, and the three CSVs inline; verify completed shape against an existing Educational Test upload | Reads only |
| **P4** | Append-only `writeImmutable` to test bucket with blob staging, final-prefix CSVs, and `UploadComplete.json` written last — **only after manual review of `@sparcd/s3-safe` + the upload sequence**; dry-run on by default | First writes, to test bucket |
| **P5** | Resume on failure (Dexie-tracked file state plus persistent handles or reselect-folder reconciliation); skip verified already-uploaded blobs; size/SHA-256 metadata sanity check | Same as P4 |
| **P6** | Multipart support for files above the single-PUT ceiling; production-bucket allowlist lift gated on reader sentinel support and a second review | Same scope as before |

P0–P3 are fully usable as a local-only "prepare an upload bundle" tool
with no S3 writes. P4 is the first write phase; P6 is the only phase
that may touch non-test buckets.

## Open questions for before P0

1. **`uploaderUser` provenance.** Free text vs. tied to S3 access key
   identity vs. SPARC'd user accounts. The existing Educational Test
   uploads use a short username (`smalusa`); we'd want consistency.
   Lean: free-text field, persisted in Dexie, pre-filled from last
   session.
2. **First test bucket(s).** Needs a concrete name (or naming pattern)
   confirmed write-allowed for the test IAM key. Same blocker as the
   tagger's question 2 — shared answer.
3. ~~**`observations.csv` on empty uploads.**~~ Resolved: always write an
   empty canonical `observations.csv`. P3 still verifies that existing
   readers tolerate an empty file, but absence is no longer an option.
4. **Deployment-creation flow.** Out of scope for this tool. If a
   researcher needs a deployment not yet in `Settings/locations.json`,
   they request one upstream; the upload waits. Confirm this is
   acceptable workflow-wise vs. needing an admin-tool path.
5. **Concurrent upload sessions.** What if two researchers race for the
   same `<ISO>_<uploaderUser>` prefix? Conditional PUTs on final-prefix
   metadata resolve it, but should the loser auto-retry with a
   `<ISO+1s>_<uploaderUser>` prefix or surface the collision? Lean:
   auto-retry once, then surface.
6. **Reader sentinel rollout.** Which existing Java / Next / explorer
   readers need to ignore prefixes without `UploadComplete.json` before
   uploader writes are allowed outside test buckets? Lean: make this a
   production-lift gate, not a P0 blocker. Cross-link: this is the
   uploader-side half of the tagger's **Canonical merge path** question.

## Out of scope (explicit, for future tools)

- Tagging within the upload flow — that's sparcd-tagger
- Map / spatial reports — that's the marimo explorer
- Deployment creation / editing — out, see open question 4
- Video files — out in v0; the Camtrap-DP schema supports them but the
  validation, transcoding, and multipart story is its own project
- RAW image formats — out in v0; JPEG only
- User management / permissions admin
- Files above the single-PUT ceiling — out until P6
- Modifying existing uploads — never; the tool only creates new prefixes
