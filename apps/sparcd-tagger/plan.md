# sparcd-tagger — implementation plan

A static, browser-based tagging interface for SPARC'd camera-trap images.
Tags persist locally in IndexedDB and sync to S3-compatible storage as
canonical Camtrap-DP metadata updates under each upload prefix.

Sits alongside SPARC'd; reads the same MinIO/R2/S3 buckets the upstream
readers use, and produces the same row/column `observations.csv` shape (the
v016 20-column layout — see Camtrap-DP encoding). It is a replacement/add-on
for the taggers in `sparcd-web` and the `sparcd` Java app. Compatibility is
the primary contract: a user can tag an image in this tool, open and re-tag
that same image in the Java app, then preview/query it in `sparcd-web` or the
static marimo notebook. Therefore S3 sync updates the canonical upload-level
`media.csv`, `observations.csv`, and `UploadMeta.json` that those tools already
read. Versioned append-only copies are allowed for audit/recovery, but they are
not the compatibility output.

> **How the upstream readers surface species — and why sidecars don't work.**
> The `sparcd-web` reader (`get_s3_images` in `server/s3/s3_access_helpers.py`)
> **lists image objects under the upload prefix, presigns the listed key, then
> decorates each image from the canonical upload-level `media.csv` and
> `observations.csv`, matched on the full object key.** It never reads a
> per-user sidecar like `<uploadPrefix>/observations/<userId>/<ISO>.csv`. The
> Java app (`Camtrap.saveTo` + `S3ConnectionManager.saveImages`) reads and
> **overwrites** canonical `deployments.csv`, `media.csv`, `observations.csv`,
> and `UploadMeta.json` in place. So append-only sidecars are invisible to both
> existing tools: **canonical replacement is the only output that shows up.** Do
> not redesign this toward sidecar-only writes.

## Source References

These are the upstream and in-repo sources behind the contracts in this plan.
Read them to confirm or extend any data-shape decision — cite by symbol, not
line number, since both repos move.

To read an upstream file, prefer the GitHub CLI for targeted lookups —
`gh api repos/<org>/<repo>/contents/<path> --jq .content | base64 -d`, piped
through `grep`/`sed` so only the lines you need enter context. If you need to
trace a behavior across many files, check the repo out into a **gitignored
workspace dir** (e.g. a sibling `../sparcd` / `../sparcd-web`, or `.reference/`)
and remove it when done — **do not clone into `/tmp`**.

- **This monorepo** — `https://github.com/culverlab/sparcd-rewrite` if the
  implementer is not already in a checkout. Local paths in this plan are
  relative to the monorepo root.
- **Java desktop tagger** — `https://github.com/culverlab/sparcd`. Canonical
  save path: `S3ConnectionManager.saveImages`,
  `S3ConnectionManager.addUpdateMetadataCamtrap`, `Camtrap.saveTo`
  (`model/image/Camtrap.java`), and the v016 column models in
  `model/image/Media.java` / `Deployments.java` / `Observations.java`.
- **Web reader** — `https://github.com/culverlab/sparcd-web` (a sibling
  checkout, if one exists, is usually at `../sparcd-web`). `get_s3_images`,
  `apply_media_timestamps`, and `apply_observation_species` in
  `server/s3/s3_access_helpers.py` define the list-under-prefix + decorate
  behavior.
- **Static marimo explorer** — `apps/sparcd-explorer/` in this monorepo, when
  present. Treat it as another reader of canonical upload-level Camtrap CSVs,
  not as the compatibility baseline when it disagrees with Java.
- **Uploader (this monorepo)** — `apps/sparcd-uploader/`. The sibling tool that
  established the shared packages and the patterns this plan reuses: runtime
  bucket discovery + `connectionId` cache keying (`src/lib/s3.ts`), the resumable
  upload journal (`src/lib/upload.ts`), and the v016 writers/shapes
  (`packages/camtrap/src/index.ts`). Read `apps/sparcd-uploader/README.md`,
  `apps/sparcd-uploader/plan.md`, and the actual uploader source together; if
  they disagree, treat the source code and tests as the current behavior.
- **Shared design system** — `docs/design-system-field-notebook.md` and the
  existing uploader UI in `apps/sparcd-uploader/src/`.

No implementation step may rely on this chat thread, a prior Claude thread, or
memory of the uploader build. If a behavior matters, it must be recoverable from
the sources above, this plan, a fixture, or a test.

## Design References

The external design bundle is the source of truth for layout, copy, and
component behavior when it is accessible; this plan is the source of truth for
data, safety, and persistence contracts. Read both side-by-side. If the design
URL is unavailable, continue with the Field Notebook design system and the
existing uploader UI as the local visual baseline rather than blocking data
contract work.

- **Latest Claude Design bundle** (Tagger, post rev-4 — time correction +
  simplified login):
  <https://api.anthropic.com/v1/design/h/13csaw3-7eZU_pYtJkQGwQ?open_file=SPARCd+Tagger.html>
  Each iteration produces a new URL; update this entry when a newer build
  supersedes it.
- [`../../docs/design-system-field-notebook.md`](../../docs/design-system-field-notebook.md)
  — locked Field Notebook v2 tokens, typography, controls, and the walnut
  dark variant.

## Goal

A keyboard-driven tagging UI that a researcher can open in a browser, tag
several hundred images in a session, save progress locally without thinking
about it, and sync to S3 when ready — while preserving the canonical metadata
contract used by the Java app, `sparcd-web`, and the marimo/static explorer.

## Static BYO-S3 security contract

Follow the uploader's static BYO-S3 security model
(`apps/sparcd-uploader/README.md` and `apps/sparcd-uploader/plan.md`). This
tagger is a **static browser app**: no backend service, no trusted server
session, no server-side environment variables at runtime. A security review
must treat the bundle as untrusted client code.

**Decision.** Users bring their own S3-compatible endpoint, credentials,
settings bucket, and collection bucket. Official SPARC'd deployments use the
same model: credentials are scoped by IAM/provider policy and CORS, not by
bucket names compiled into the app.

**Enforceable controls.**

- **IAM / provider policy** limits which buckets, prefixes, and S3 actions
  the supplied credentials can use.
- **Bucket CORS** limits which hosted app origins can make browser S3 calls.
- **`@sparcd/s3-safe`** is the only S3 client boundary. It exposes read
  methods, immutable append-only writers, and one reviewed conditional
  replacement method for canonical Camtrap metadata. No delete or copy API.
- **Sync protocol controls**: dry-run-by-default, `HEAD`/ETag verification,
  pre-write conflict detection, immutable pre-write snapshots, and
  conditional canonical replacement.

**Non-controls.**

- Build-time `VITE_*` bucket allowlists are **not** used for authorization —
  they are not enforceable in a static app and would break BYO-S3 users.
- Client-side bucket discovery is **not** authorization. It only finds
  buckets the supplied credentials and CORS policy already expose.

## Stack

- **Vite + React 18 + TypeScript** — single-page app, fast dev, static bundle
- **Tailwind + Field Notebook bespoke components** — match the uploader
  (`apps/sparcd-uploader`); do not introduce shadcn/ui unless the shared design
  system changes first
- **TanStack Query** — S3 fetch cache and request dedup. **Key every query on a
  `connectionId`**, not on endpoint+access-key alone, and clear the S3 client
  cache on connect/disconnect, so reconnecting with new credentials never serves
  a previous connection's cached data (pattern in
  `apps/sparcd-uploader/src/lib/s3.ts`).
- **TanStack Virtual** — virtualized image lists for large uploads
- **Zustand** — edit/UI state
- **Dexie.js** — IndexedDB wrapper, draft persistence
- **react-hotkeys-hook** — keyboard shortcuts
- **react-zoom-pan-pinch** — full-size image inspection
- **`@sparcd/s3-safe` only for S3** — app code never imports
  `@aws-sdk/client-s3`; presigned image URLs come from
  `SafeS3Client.presignedGet`
- **Vitest** — shared contract tests for Camtrap CSV, upload metadata,
  uploader fixtures, tagger merge output, and wrapper safety behavior
- **`@sparcd/camtrap` CSV parser/writer** — extend the existing writer with the
  readers/merge helpers needed here; use PapaParse internally only if the
  package needs a CSV engine
- **fuse.js** — fuzzy search for species autocomplete

## Shared packages

Lives under `packages/` in this monorepo. Internal-only; no `dist/`,
consumers bundle the source via Vite + pnpm workspace resolution.

### `packages/s3-safe` → `@sparcd/s3-safe`

Exists in the monorepo (`packages/s3-safe/`); the tagger needs one reviewed
extension because Java-compatible tagging must replace canonical metadata. This
is the single, blessed S3 boundary; every tool that touches storage imports it.
The tagger uses the read methods, `writeImmutable` for audit snapshots, and a
new conditional replacement method for canonical `media.csv` /
`observations.csv` / `UploadMeta.json`. It does **not** need
`writeImmutableStream` (the uploader's per-file multipart writer; the tagger
never streams large blobs). Existing surface plus required extension:

1. **Bucket allowlists, not a security boundary in a static app.** The
   constructor is `(cfg, readAllowlist, writeAllowlist = [])` — a separate,
   opt-in **write allowlist that is empty by default** (`BucketNotWritableError`
   is the hard stop). In a BYO-S3 static app the tagger passes broad runtime
   scope (`*`) for both, exactly as the uploader does; IAM/policy + CORS are
   the real gate (see Static BYO-S3 security contract). The allowlist scopes
   *object* operations only.
2. **Read methods**, plus the tagger write surface:
   - `listObjects(bucket, prefix)` → `AsyncIterable<ObjectInfo>`
   - `getObject(bucket, key)` → `Uint8Array`
   - `statObject(bucket, key)` → metadata only
   - `presignedGet(bucket, key, ttlSec)` → URL
   - `listBuckets()` → bucket names; **intentionally not allowlist-gated**
     (it reads no object data) — the discovery primitive the tagger uses to
     find the settings and collection buckets at runtime
   - `writeImmutable(bucket, key, body)` → conditional `PutObject` with
     `IfNoneMatch: "*"`, throwing `PreconditionFailedError` (412) if `key`
     already exists, or `ConditionalPutUnsupportedError` (501) if the backend
     does not enforce the precondition (no silent HEAD-then-PUT fallback)
   - `replaceIfUnchanged(bucket, key, body, { etag, contentType })` →
     conditional `PutObject` with `IfMatch: <etag>` for canonical metadata
     replacement. This is a narrow compatibility exception for
     `media.csv`, `observations.csv`, and `UploadMeta.json`, not a general
     overwrite API.
     It throws a typed conflict if the remote object changed after the draft
     was loaded.
3. **No destructive APIs exposed** — no `delete*` or `copy*`. Direct
   `@aws-sdk/client-s3` imports are forbidden outside `packages/s3-safe/src/`
   by a lint rule added before app code writes to S3.

**`IfNoneMatch: "*"` backend support.** Conditional writes require:
AWS S3 added conditional `PutObject` support in August 2024, then added
bucket-policy enforcement for conditional writes in November 2024. MinIO
and Cloudflare R2 also support conditional PUTs, but the `@sparcd/s3-safe`
README must record the exact backend versions tested for this project.
If the backend responds with `501 NotImplemented` (or returns a 200
success without enforcing the precondition), `writeImmutable` must throw a
distinct `ConditionalPutUnsupported` error and the wrapper must **not**
silently fall back to a `HEAD`-then-`PUT` path — that fallback has a
TOCTOU race the wrapper cannot close, and silently accepting it would
defeat the safety design.

**`IfMatch` backend support.** Canonical compatibility sync additionally
requires conditional replacement with `IfMatch` against the reviewed ETag for
`media.csv`, `observations.csv`, and `UploadMeta.json`. P0/P4 tests must prove
the wrapper sends the header, treats stale ETags as typed conflicts, and does
not fall back to an unconditional PUT. Live browser CORS must expose enough
`HEAD` metadata for this check to work on the target endpoint.

This is stricter than the Java desktop app, which writes with unconditional
`PutObject` and performs no ETag/concurrency check. Tagger `IfMatch` protects
tagger-vs-tagger and tagger-vs-uploader/static-tool writes; it cannot prevent a
concurrent or later Java save from overwriting canonical tagger output.

**P4 design gate.** Do not silently downgrade to Java's last-writer-wins write
behavior. If the target endpoint does not enforce `IfMatch` from browser S3
calls, canonical sync stays disabled for that endpoint and the tool remains
local-only/export-only until the backend/policy is fixed. A deliberately unsafe
Java-compatible overwrite mode would be a separate, operator-approved feature,
not P4 fallback behavior.

Endpoint config is the same shape for all three backends:

```ts
type S3Config = {
  endpoint: string;        // host[:port] or https://host
  region: string;          // "us-east-1" | "auto" | etc.
  accessKey: string;
  secretKey: string;
  forcePathStyle: boolean; // true for MinIO; false for AWS/R2
  secure?: boolean;        // when no scheme on endpoint
};
```

Helpers detect the backend from the endpoint and fill defaults:
- `*.r2.cloudflarestorage.com` → `region: "auto"`, `forcePathStyle: false`
- `*.amazonaws.com` → `region: <from URL>`, `forcePathStyle: false`
- anything else → MinIO defaults (`region: "us-east-1"`, `forcePathStyle: true`)

Browser-direct S3 is a hard requirement for this app. P0 must verify the
target endpoint's CORS policy allows the static app origin to call
`ListBucket`, `GetObject`, `HeadObject`, and eventually `PutObject`, and
that signed or presigned image URLs render in `<img>` without canvas access
requirements.

### `packages/camtrap` → `@sparcd/camtrap`

Pure TypeScript. No React, no S3. The package exists in the monorepo
(`packages/camtrap/src/index.ts`); the writer the tagger needs is already there
— the uploader builds against it but always emits an empty `observations.csv`,
leaving the row serializer for the tagger. The tagger extends this package with
readers, merge helpers, and shared fixtures so uploader and tagger tests prove
the same data contract.

- Types: `Deployment`, `Media`, `Observation`, plus a `CamtrapBundle` that
  groups all three for one upload. `Observation` already carries `timestamp`,
  `scientificName`, `count`, and `tags`.
- Reader: **to be added in P0**. Takes raw CSV strings (`deployments.csv`,
  `media.csv`, `observations.csv`) → parsed objects, with the fixed v016
  column-index mapping (no header row) handled in one place. It must
  round-trip rows from Java and `sparcd-web` fixtures and preserve unrelated
  rows when the tagger changes one image.
- Writer: `serializeObservations` emits the v016 **20-column** shape
  byte-for-byte (QUOTE_ALL, LF-terminated). **Column semantics are pinned in
  code (`packages/camtrap/src/index.ts`), not to be re-derived:**
  - col 4 `timestamp` — the corrected ISO timestamp
  - col 8 `scientific_name` + col 9 `count` — the SPARC'd observation
    (species + count only; there is no behaviour field)
  - **col 19 `comments`** — where the bracketed tag markers live (see grammar
    below). There is **no dedicated `tags` column**; everything bracketed
    lands in `comments`.
- Merge helpers: **to be added in P0/P1**. Given canonical media +
  observations and local draft edits, replace the media row and all observation
  rows for the edited media IDs, preserve unrelated rows, filter zero-count
  rows the same way `sparcd-web` does, update media timestamp col 4 when time
  corrections are synced, and update `UploadMeta.json` with Java-compatible
  `imagesWithSpecies` delta semantics.
- Validators: schema checks, lat/lng sanity (latitude and longitude columns are
  easy to transpose — validate ranges), row-count checks, and tag-string parser
  for the `[COMMONNAME:Owl]` format.
- Tag marker grammar: the col-19 `comments` field holds a concatenated list
  of bracketed markers `[PREFIX:value]`. Reserved prefixes for v0 are
  `COMMONNAME` and `REQUESTED_SPECIES`. The parser must preserve and tolerate
  unknown prefixes so future tools can add markers without breaking old
  readers.

### `packages/types` → `@sparcd/types`

Minimal TS types that span more than one package:
- `Collection { bucket, uuid, name, organization }`
- `Species { genus, species, commonName, scientificName }` (plus the tree
  form used by `Settings/species.json`)
- `UserSession { userId, displayName }` for stamping immutable writes

### `packages/auth-ui` → `@sparcd/auth-ui` *(shared from day one)*

One credentials/connection screen, shared by every JS tool (tagger,
uploader, future tools). Two known consumers exist by design, so this is
shared from the start rather than duplicated. The component is
parameterized only by the tool name shown in the chrome ("SPARC'd ·
Tagger" / "· Uploader"). The form is **three fields — endpoint, access
key, secret key** — with secure/region/path-style inferred from the
endpoint (rare overrides behind an "Advanced" disclosure). It produces the
`S3Config` consumed by `@sparcd/s3-safe` and is identical everywhere.
Depends on `@sparcd/types` for the config shape.

## Compatibility test standard

Before implementing tagger S3 writes, add a shared Vitest contract harness that
both `sparcd-uploader` and `sparcd-tagger` consume. This is step 1 because the
data contract is more important than UI polish or storage plumbing.

### Shared fixture layout

Create durable golden fixtures under a shared test-data location, not inside
one app:

- `packages/camtrap/test/fixtures/java-v016/` — canonical `deployments.csv`,
  `media.csv`, `observations.csv`, `UploadMeta.json`, and `species.json`
  shaped like the Java app writes them.
- `packages/camtrap/test/fixtures/sparcd-web-v016/` — the same files shaped
  like current `sparcd-web` Python helpers write/read them. `sparcd-web` is
  newer and may be inconsistent, so Java fixtures are the compatibility
  baseline when behavior differs.
- `packages/camtrap/test/fixtures/uploader-empty-v016/` — a new uploader
  bundle with empty canonical `observations.csv`, matching
  `sparcd-uploader`.
- `packages/camtrap/test/fixtures/tagger-edited-v016/` — expected canonical
  output after common tagger operations: add species, retag species, detag an
  image, multi-species rows, Ghost (`Casper`), timestamp correction in
  `media.csv` col 4 and observation col 4, Java-compatible
  `UploadMeta.json.imagesWithSpecies` delta, mandatory `editComments`, and
  requested-species marker in comments.

Fixtures should be small enough for fast tests but large enough to cover
multiple images, nested paths, multiple deployments when relevant, and one
unrelated row that must survive every merge unchanged.

### Required Vitest coverage

- **Round-trip shape.** Parse fixture CSVs and serialize them without changing
  fixed column counts, row order, quoting policy, or unrelated rows.
- **Uploader contract.** `sparcd-uploader` output parses as valid v016
  Camtrap data and exposes an empty canonical `observations.csv` base for the
  tagger.
- **Tagger merge contract.** Applying draft edits to canonical observations
  and media produces exactly the `tagger-edited-v016` golden output.
- **Retro-compatibility contract.** The edited golden output can be read by
  lightweight Java-compatible and `sparcd-web`-compatible parsers in tests:
  species lives in observation col 8, count in col 9, common name in col 19
  as `[COMMONNAME:<name>]`, and media IDs match the full object keys used by
  `media.csv`.
- **Timestamp display contract.** Corrected capture time is written to
  `media.csv` col 4 because Java and `sparcd-web` decorate displayed image
  timestamps from media rows. Observation col 4 is also updated for edited
  observation rows, but it is not enough by itself.
- **Reader listing contract.** Adding tagger snapshot folders under an upload
  prefix must not add visible images. The current `sparcd-web`
  `get_s3_images` recurses subfolders but only returns `.jpg` and `.mp4`
  objects, so snapshot prefixes must contain only CSV/JSON/manifest files and
  tests/verification must prove the image list is unchanged before and after a
  snapshot subtree exists.
- **UploadMeta contract.** `imagesWithSpecies` follows the Java save delta:
  `prior - detaggedCount + retaggedCount`, where detagged means "was tagged,
  now species-present is empty" and retagged means "was untagged, now
  species-present is non-empty." This deliberately matches Java's maintained
  tally, even if a stored `UploadMeta.json` has drifted from a clean recompute.
  Tests include a drifted-value fixture so the choice is explicit. A future
  admin repair flow may recompute and reconcile drift, but normal tagger sync
  does not.
- **Edit comment contract.** Every successful canonical sync appends an
  `UploadMeta.json.editComments` entry in the Java style:
  `Edited by <user> on <timestamp>`, where `<timestamp>` uses Java's
  `uuuu.MM.dd.HH.mm.ss` format.
- **No accidental data loss.** Retag/detag tests prove the merge only replaces
  rows for edited media IDs and never drops unrelated observations,
  deployments, or media rows.
- **Partial-sync resume contract.** Simulate failures after `media.csv` and
  after `observations.csv`. Retry must verify already-written objects by hash,
  continue from the first pending object, and conflict if any written or pending
  object changed remotely.
- **Snapshot collision contract.** Simulate a 412 on the immutable snapshot
  prefix. The tagger bumps the snapshot stamp by +1s, retries once, writes
  `manifest.json` last, and recovery ignores prefixes without a manifest.
- **Wrapper safety.** Unit tests cover the future `replaceIfUnchanged`
  behavior with mocked S3 responses: success on matching ETag, conflict on
  stale ETag, no fallback overwrite, no delete/copy command.

Root scripts should include `pnpm test` / `turbo run test`, and each package
or app with data-contract code should expose a `test` script. S3 integration
tests stay separate and opt-in; the default Vitest suite must run offline.

## Architecture

### Data flow

```
S3 bucket  ─presigned GET─►  <img>                                   ─┐
                                                                      │ tags
Settings/species.json  ─fetch─►  Fuse index in memory                  │ flow
                                                                      ▼
        ┌──────────────────────────────────────────────────────────────┐
        │  React app                                                    │
        │  ┌─────────┐  ┌──────────────┐  ┌────────────┐                │
        │  │ ImageList│  │ ImageViewer │  │ TagPanel   │                │
        │  └─────────┘  └──────────────┘  └────────────┘                │
        │       ▲              ▲                ▲                       │
        │       └──────┬───────┴────────────────┘                       │
        │              ▼                                                │
        │       Zustand store ──auto-save──► Dexie (IndexedDB)         │
        └──────────────────────────────────────┬───────────────────────┘
                                               │ manual "Sync"
                                               ▼
                         immutable snapshot + conditional canonical replace
                                               │
                                               ├─ replaceIfUnchanged() → <uploadPrefix>/media.csv
                                               ├─ replaceIfUnchanged() → <uploadPrefix>/observations.csv
                                               └─ replaceIfUnchanged() → <uploadPrefix>/UploadMeta.json
```

### Layout

Three-pane CSS grid:

- **Overview** — the primary working surface, with two view modes
  (file-explorer style) switched by a segmented control: **grid** of
  thumbnail cards, and a denser **list** whose rows each carry a tiny
  thumbnail + metadata. Both group by burst/sequence (visual bands) and
  share one selection model: single, range (Shift), additive (Cmd/Ctrl),
  whole-burst. This is where most of an upload gets cleared — bulk-tagging
  a selection in one action.
- **Focus** — `ImageViewer`, the single-image detail view drilled into
  from a thumbnail: pan/zoom, image adjustments for hard night frames,
  prev/next, timestamp + deployment overlay. For careful IDs, not bulk.
- **Right** — `TagPanel`. Species selector + count. (A SPARC'd observation
  is species + count only — there is no behavior field; see the data note
  below.) Submit applies to **all selected images at once**.
- **Top bar** — collection picker, sync status (`local-only` /
  `unsynced edits` / `synced @ <time>` / `conflict`), keyboard cheatsheet
  button. **Collection discovery reuses the uploader's runtime model**
  (`apps/sparcd-uploader/src/lib/s3.ts`): list visible buckets, keep
  `sparcd-<uuid>` candidates, read `Collections/<uuid>/collection.json`, and key
  selection as `bucket::uuid`. If collection discovery later becomes
  bucket-name-agnostic, update uploader and tagger together; do not let the
  tagger invent a divergent collection model.

### Performance & interaction

Snappiness and keyboard latency are first-class requirements — the tool
lives or dies on them. These are implementation requirements, separate from
visual design:

- **Virtualized thumbnail grid** (TanStack Virtual) — only mount visible
  cells; a 5,000-image upload must scroll at 60fps.
- **Thumbnail strategy** — request small presigned-URL thumbnails, lazy +
  progressive load, `loading="lazy"` / `IntersectionObserver`, decode off
  the main thread (`createImageBitmap`), and an LRU cache so revisiting a
  burst is instant. Camera-trap originals are 1–5MB; never load originals
  into the grid.
- **Keybindings** — global handler with no per-render re-binding; actions
  dispatch synchronously and update local (Zustand) state optimistically,
  so `J`/`K`/species keys never wait on I/O. Dexie writes are debounced and
  off the hot path.
- **Selection at scale** — selection state is index ranges, not per-cell
  React state, so selecting a 2,000-image burst doesn't re-render 2,000
  components.
- **CORS error translation** — reuse the uploader's mapping: 404 → "not found",
  403 → "access denied", and a status-less browser fetch failure → "endpoint
  unreachable or the bucket CORS policy needs to allow GET/HEAD from this
  origin." A **live in-browser CORS preflight against the endpoint is still
  unconfirmed** and this origin may need adding to the bucket CORS policy.

### Login screen

**Three fields only: endpoint, access key, secret key** (the marimo Python
explorer's pattern). Everything else is *inferred*, not asked:

- **Secure (HTTPS)** from the endpoint scheme (`https://` → secure; default
  secure when no scheme).
- **Region + path-style** auto-detected from the endpoint host by
  `@sparcd/s3-safe` (R2 / AWS / MinIO — see the detection rules above). No
  preset dropdown, region field, or path-style toggle on the main screen.
- Rare manual region / path-style overrides live behind a collapsed
  **"Advanced"** disclosure, hidden by default.
- Per-tool **identity** and **dry-run default** live in **Settings**, not
  the login gate.

Values prefill from `.env` during local development only. In deployable
static builds, `import.meta.env` may prefill non-secret convenience values
such as endpoint, region, and path defaults, but must never embed real access
keys or secret keys, and **never a bucket allowlist as an authorization
boundary** (buckets are discovered at runtime — see the security contract).
Users enter S3 credentials at runtime. The Java and sparcd-web apps use a
different model (server-issued token); this tool does not share auth UI with
them.

### Persistence — local

- **Dexie schema** v1:
  - `drafts` table:
    `{ id (bucket+uploadPrefix+mediaPath), bucket, uploadPrefix, mediaPath,
    baseMediaETag, baseMediaHash, baseObservationsETag,
    baseObservationsHash, baseUploadMetaETag, baseUploadMetaHash,
    auditSnapshotKey, label, count, freeTags, requestedSpecies, questionable,
    timeOverride, lastEdited, dirty }`
    (`timeOverride` = optional corrected timestamp for this one image, on
    top of the upload offset; null when unset.)
    `label` holds the applied species **or** a non-animal label like
    **Ghost** — Ghost is just another label, not a separate `blank` flag. A
    SPARC'd observation is **species + count only** — there is no `behavior`
    field. The value/encoding (how Ghost and species land in
    `observations.csv`) is **already pinned** by the existing
    `serializeObservations`: species → col 8 `scientific_name` + col 9
    `count`; bracketed markers → col 19 `comments`. Ghost is encoded as a
    label through the same path, not a separate flag.
  - `uploads` table:
    `{ id (bucket+uploadPrefix), bucket, uploadPrefix, loadedAt,
    mediaETag, mediaHash, observationsETag, observationsHash, uploadMetaETag,
    uploadMetaHash, timeOffset }`
    (`timeOffset` = signed Δ y/mo/d/h/m/s applied to every image in the
    upload; null when unset.)
  - `sessions` table:
    `{ sessionId, userId, startedAt, finishedAt, syncedAt, syncedKey,
    syncedCsvHash }`
- **Grounding rule.** The uploader **always writes an empty canonical
  `observations.csv`** on initial upload (its open question resolved), so a
  stable base file is guaranteed — no absent-file case to handle. Every draft
  is grounded on the canonical upload-level `media.csv`, `observations.csv`,
  and `UploadMeta.json` loaded at session start. Sync-time conflict detection
  compares current remote ETag/hash values for all three files against the
  stored base values; mismatch triggers the conflict view before any canonical
  write.
- **`requestedSpecies` field.** When a tagger needs a species not in
  `Settings/species.json`, the combobox lets them tag with a free-text
  `requestedSpecies` string plus the existing `freeTags`. The sync export
  records the request as a `[REQUESTED_SPECIES:<value>]` marker in the col-19
  `comments` field (alongside `[COMMONNAME:…]`), so the output keeps the
  `observations.csv` row/column shape while still giving downstream admins a
  machine-readable request. The tagger never edits the species hierarchy itself
  (see Out of scope).
- **Schema versioning.** Future schema changes use Dexie's versioning API
  (`db.version(N).stores({...}).upgrade(...)`). No ad-hoc store mutations
  outside that ladder; every bump ships with an `upgrade` callback that
  carries v(N-1) drafts forward, never destructively.
- Auto-save on every keystroke (debounced 200 ms). Recovery on next open
  surfaces any `dirty` drafts.
- Per-upload "Discard local changes" button — affects only that upload.

### Persistence — S3 sync

- "Sync" button is the only path that writes to S3.
- Pre-write:
  - `HEAD` + load canonical `<uploadPrefix>/media.csv`,
    `<uploadPrefix>/observations.csv`, and `<uploadPrefix>/UploadMeta.json`.
  - If any ETag/hash differs from the draft base, enter the conflict view:
    reload remote, show local-vs-remote media/observation/meta diffs, and
    require the user to merge or discard local edits before retrying.
  - Diff local drafts against canonical media and observations. Show a
    confirmation dialog: timestamp corrections, N additions, M modifications,
    D removals. A removal means "remove this species row from this media item"
    and is required for re-tagging compatibility; it is not an object delete.
  - Write immutable audit snapshots of the pre-change canonical files under
    `<uploadPrefix>/.sparcd-tagger-snapshots/<userId>/<ISO>/` using
    `writeImmutable`. These snapshots are for recovery only. Snapshot prefixes
    contain only non-image files (`media.csv`, `observations.csv`,
    `UploadMeta.json`, `manifest.json`) so recursive image readers do not
    surface them.
  - Snapshot `manifest.json` is written last. If `writeImmutable` returns 412
    for a snapshot key, bump the snapshot stamp by +1s, rebuild the snapshot
    prefix, and retry once, matching the uploader's re-stamp pattern. Recovery
    only lists snapshot prefixes with a complete manifest; partial prefixes are
    ignored unless an operator inspects them manually.
- Write:
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/media.csv", serialized, { etag: baseMediaETag })`
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/observations.csv", serialized, { etag: baseObservationsETag })`
  - `replaceIfUnchanged(bucket, "<uploadPrefix>/UploadMeta.json", serialized, { etag: baseUploadMetaETag })`
  - `UploadMeta.json.imagesWithSpecies` follows Java's running delta:
    `prior - detaggedCount + retaggedCount`. Detagged/retagged are computed
    from the same before/after species-present state used for the edited
    media rows, not from a full-bundle recompute.
  - `UploadMeta.json.editComments` is appended on every successful sync with
    the Java-style `Edited by <user> on <timestamp>` entry, using
    `uuuu.MM.dd.HH.mm.ss` for the timestamp.
  - S3 has no atomic three-object transaction. The write order is `media.csv`
    first, `observations.csv` second, `UploadMeta.json` third: if the final
    metadata write fails, existing tools can still read the new timestamp/tags,
    but the upload tile count or edit comment may be stale until the tagger
    retries. If the observations write fails after `media.csv`, readers may
    show corrected capture time before species changes. The recovery view must
    detect and repair either partial-sync state.
  - Persist a per-object sync journal before the first canonical write:
    object key, base ETag, intended SHA-256, status (`pending` / `written`),
    and new ETag when available. On failure after any canonical PUT, retry is a
    resume, not a blind whole-sync retry:
    1. Re-HEAD/load the three canonical objects.
    2. For objects marked `written`, require the remote hash to equal the
       intended hash; otherwise enter conflict repair because another writer
       changed a partially synced object.
    3. For remaining `pending` objects, require the remote ETag/hash to still
       match the stored base before writing with that current ETag.
    4. Continue from the first pending object forward (`media.csv` →
       `observations.csv` → `UploadMeta.json`), recording each new ETag.
    5. When all three objects are verified/written, clear the journal and mark
       the draft synced.
  - On a conditional conflict, do not retry blind. Reload, show conflict UI,
    and require an explicit merge.
  - Records `syncedAt`, new ETags, and hashes in Dexie.
- Recovery view: lists local snapshots and remote
  `.sparcd-tagger-snapshots/<userId>/<ISO>/` versions, lets the user inspect
  or restore one by running the same conditional canonical replacement flow.

The canonical files are no longer read-only in this tool. Updating them is the
point of S3 sync because current Java, `sparcd-web`, and marimo/static preview
tools read those files and ignore append-only sidecars.

## Safety design

"Absolutely no accidental writes" is a load-bearing requirement for this tool.
Four layers, each redundant:

1. **IAM policy** — separate access key whose policy permits only
   `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` on
   `arn:aws:s3:::sparcd-test-*` (or the explicit test-bucket ARN list), with
   writes scoped to canonical compatibility files and audit snapshots:
   `Collections/*/Uploads/*/media.csv`,
   `Collections/*/Uploads/*/observations.csv`,
   `Collections/*/Uploads/*/UploadMeta.json`, and
   `Collections/*/Uploads/*/.sparcd-tagger-snapshots/*` where the backend
   supports object-prefix conditions.
   **No `s3:DeleteObject`.** Belt + suspenders below in case the policy
   is ever misconfigured.
2. **`@sparcd/s3-safe` wrapper** — the only S3 client allowed in app code.
   No destructive methods exposed. Lint rule blocks direct
   `@aws-sdk/client-s3` imports anywhere except `packages/s3-safe/src/`.
3. **Runtime permissions, not build-time bucket gates** — this is a static
   BYO-S3 app, so bucket names are never compiled into the bundle as a security
   boundary: a static bundle can't enforce that, and a hardcoded allowlist
   breaks BYO-S3 users. The connected credentials' IAM policy and bucket CORS
   decide what the browser can read or write. The app discovers the
   settings/collection buckets by probing for marker objects, keeps dry-run on
   by default, and uses only the reviewed wrapper APIs.
4. **Conditional canonical replacement** — every sync snapshots the old
   canonical files immutably, then replaces only `media.csv`,
   `observations.csv`, and `UploadMeta.json` with `IfMatch` against the ETags
   the user reviewed. A stale ETag is a conflict, never an automatic overwrite.

Plus a **dry-run toggle** on the sync action, on by default for the first
session. Until the user explicitly turns dry-run off, sync logs what it
would do and writes nothing.

## Time correction

Camera clocks drift / are misconfigured (DST, timezone), and corrected
timestamps drive downstream activity analysis. Two levels, mirroring the
SPARC'd Java app's `TimeShiftController` (signed offsets in
year/month/day/hour/minute/second with a live preview) and per-image
`setDateTaken`:

- **Upload-level offset** — a signed Δ (y/mo/d/h/m/s) applied to every image
  in the upload. Set from the Tag workspace / upload-scoped Settings, with a
  live "original → corrected" preview and a persistent active-offset
  indicator.
- **Per-image override** — edit one image's timestamp in the Focus view, on
  top of the upload offset.

**Non-destructive.** Originals (EXIF / canonical CSV timestamps) are never
rewritten locally outside the reviewed sync path. Corrections are stored locally
(`uploads.timeOffset`, `drafts.timeOverride`), applied on display, and emitted
as the corrected timestamp in the canonical synced output. The corrected
display/capture timestamp must be written to `media.csv` col 4
(`Media.timestamp`), because Java and `sparcd-web` decorate image capture time
from media rows. Edited observation rows also carry the corrected timestamp in
`observations.csv` col 4 (`Observation.timestamp`), per the existing
`serializeObservations`, but writing observations alone is not sufficient.

## Sequence/burst grouping

Default heuristic: same deployment + image timestamps within `60s` of each
other → same burst. Threshold configurable per-session (slider, 5s–600s).

Bursts render as visual bands in `ImageList`. The "Apply to whole burst"
button is one keystroke.

## Species / label autocomplete

- Load `Settings/species.json` once at session start. **It lives in the
  settings bucket, not the per-collection bucket** — `Settings/locations.json`
  resolves the same way (prefer `sparcd-settings-*`, fall back to legacy
  `sparcd`), discovered by probing visible buckets for the marker. P0 reuses
  that discovery (`apps/sparcd-uploader/src/lib/s3.ts`) for `species.json`
  rather than assuming the collection bucket.
- P0 validates the exact object path and JSON shape against the live bucket.
  Watch for the same **id-is-not-unique** contract `locations.json` has (ids
  repeat with different data; upstream keys by a composite) — confirm whether
  species keys are unique before keying anything on them.
- Build a Fuse index over `commonName` + `scientificName` + `genus`.
- **Persistent, scrollable, browsable list — not only a type-to-filter
  popover.** Volunteers don't know the list cold; scanning to recognize a
  species is core workflow. Each row shows an **example thumbnail** of the
  animal + common name + scientific name + its assigned key (if any). Filter
  box at top; hierarchy (Genus → Species) drillable.
- **Per-species, user-assignable, persistent keybindings — not rotating
  numeric keys.** Each species can carry a stable key the user assigns once
  (shown as a kbd badge on its row, with an "assign key" affordance);
  pressing it tags that species; bindings are suppressed while the filter
  box is focused. This matches the SPARC'd Java app, where each species has
  a persisted `keyBinding` in `species.json` — so it is data-compatible.
  Rotating 1–9 "recent" keys are **not** used: they can't build muscle
  memory on a large list.
- "Recent / frequent this session" affects only **list ordering** (floats
  local fauna to the top), never key assignment.
- Example-image source is a build decision (per-species reference image or a
  representative already-tagged frame), sourced from the upstream SPARC'd
  species data / sparcd-web / Java app — not invented here.
- The vocabulary includes non-animal labels — notably **Ghost** (empty /
  false-trigger frame, shown as a text chip not a photo) — applied exactly
  like a species through the same list + bulk-tag path. Ghost is a core
  manual label, not a separate mechanism, and there is no automated ghost
  detection in this tool. Compatibility default: because Java keys detag/retag
  on whether `getSpeciesPresent().isEmpty()`, Ghost/Casper counts as
  species-present when encoded as a species/label row. That means Ghost-tagged
  images count toward `UploadMeta.json.imagesWithSpecies` and can be
  "retagged" from Java's perspective. Confirm before P0 whether this semantic
  should remain; changing it would intentionally diverge from Java behavior.

## Keyboard shortcuts (initial set)

| Key | Action |
|---|---|
| `J` / `K` | Next / previous image |
| `Shift+J` / `Shift+K` | Next / previous burst |
| `Space` | Open species autocomplete |
| `Enter` | Confirm selection |
| _assigned key_ | Apply the species/label bound to that key (user-assignable, persistent per species; suppressed while the filter box is focused) |
| `G` | Default binding for **Ghost** (empty / false-trigger frame) — a normal pre-bound label, common enough to ship bound |
| `X` | Mark as "questionable" |
| `Cmd/Ctrl+A` | Select current burst |
| `Cmd/Ctrl+S` | Save draft (auto-saves anyway; manual confirm) |
| `?` | Toggle cheatsheet modal |

## Phased delivery

| Phase | Scope | S3 writes |
|---|---|---|
| **P0** | **Shared Vitest contract harness first**: root/package `test` scripts, Java-baseline and `sparcd-web` fixture data, uploader-empty fixture, tagger-edited golden fixture; extend `@sparcd/camtrap` with v016 readers/merge helpers; prove uploader output parses and tagger merge output matches golden files; scaffold app, reuse the four existing shared packages (`s3-safe`, `camtrap`, `types`, `auth-ui`); shared Connection screen; existing uploader collection discovery (`sparcd-<uuid>` candidates); image viewer reads from a discovered collection; verify browser CORS for list/get/head; validate `Settings/species.json` path/shape | None |
| **P1** | Single-image tag editing; Dexie drafts; J/K nav; species autocomplete | None |
| **P2** | Sequence/burst grouping; full keyboard set; cheatsheet modal | None |
| **P3** | Batch tagging (multi-select); recovery view (local-only at this stage) | None |
| **P4** | Compatibility sync: immutable pre-write snapshots plus conditional canonical replacement of `<uploadPrefix>/media.csv`, `<uploadPrefix>/observations.csv`, and `<uploadPrefix>/UploadMeta.json`; explicit per-object resume journal for partial three-file writes; snapshot-prefix +1s re-stamp on 412; verified that `.sparcd-tagger-snapshots/` does not change the reader image list; only after manual review of `replaceIfUnchanged`, mocked wrapper tests, fixture-backed merge tests, and endpoint-specific CORS/PUT preflight | First writes, dry-run by default |
| **P5** | Snapshot/version recovery: load prior snapshots into local, restore through the same conditional canonical replacement flow | Same as P4 only on restore |
| **P6** | Internal navigation sections beyond the tagging core: Browse, History (surfaces the P5 recovery capability), Settings | Reads only |

P0–P3 are fully usable as a local-only tagger. The S3 write path doesn't
exist in the build until P4, which means the safety wrapper can be
reviewed in isolation before any real bucket is at risk.

## Open questions for before P0

1. **User identity for snapshots and edit comments.** The IAM access key
   stamps the bucket-side writer; the tagger also needs a logical `userId` for
   audit snapshot paths and mandatory `UploadMeta.json.editComments` entries.
   Options: prompt at session start, derive from access key, or pin to a
   config file. Lean: prompt + persist.
2. **First write-allowed bucket/credentials.** Not a build-time allowlist
   (that idea is gone — see Static BYO-S3 security contract); a concrete
   credential set whose IAM policy permits conditional `PUT` on canonical
   `media.csv` / `observations.csv` / `UploadMeta.json` and immutable snapshot
   writes on a real bucket, so P4 has somewhere to test compatibility writes.
3. **Conditional replacement backend support.** Verify the target MinIO/R2/S3
   endpoints enforce `IfMatch` on `PutObject` from browser SDK calls and expose
   enough `HEAD` metadata/ETag via CORS. This is a P4 go/no-go gate: if a
   backend cannot enforce this, P4 does not write canonical metadata on that
   backend. The plan does not allow an automatic fallback to Java's
   unconditional overwrite behavior.
4. **Ghost/Casper counting semantics.** Compatibility default is that
   Ghost/Casper counts as species-present because Java treats any non-empty
   `speciesPresent` as tagged. Confirm before P0 that this is the intended
   user-facing meaning; otherwise the plan must document the intentional Java
   divergence and fixture expectations.

## Out of scope (explicit, for future tools)

- Image upload (tagger reads only; new images come from SPARC'd's upload
  flow)
- User management / permissions admin
- Species hierarchy admin
- Bulk export to formats other than Camtrap-DP CSV
- Map / spatial reports (that's the marimo explorer's job)

### Future ideas (post-MVP, noted so they aren't lost)

- **Automated ghost _prediction_ as an add-on.** Manual Ghost tagging is a
  core MVP label (see Species / label autocomplete) — this future item is
  only the *automated* part. A separate offline pass (e.g. the existing TF
  "Ghost" detector) would write a per-image predictions sidecar; the tagger
  could *optionally* consume it as advisory hints — pre-select likely-empty
  frames for the human to confirm with `G`, never auto-tag or auto-discard.
  No pre-classifier is in scope for MVP. Keep an optional per-image prediction
  slot in the data model, but the tagger works fully without it.
- **Guided tour / first-run walkthrough.** A short interactive tour of the
  overview → focus → tag → sync flow for new users. Out of scope for MVP.
