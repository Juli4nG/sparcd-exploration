# sparcd-tagger — implementation plan

A static, browser-based tagging interface for SPARC'd camera-trap images.
Tags persist locally in IndexedDB and sync to S3-compatible storage as
immutable, timestamped Camtrap-DP CSV files under each upload prefix.

Sits alongside SPARC'd; reads the same MinIO/R2/S3 buckets the Java and
Next.js apps read, and produces the same row/column `observations.csv`
shape they ingest. It does **not** overwrite the canonical upload-level
`observations.csv`; it writes append-only versions that a later importer,
review step, or updated reader can merge into canonical data.

## Design references

The Claude Design bundle is the source of truth for layout, copy, and
component behavior; this plan is the source of truth for data, safety, and
persistence contracts. Read both side-by-side.

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
about it, and sync to S3 when ready — with zero risk of overwriting or
destroying prior work.

## Stack

- **Vite + React 18 + TypeScript** — single-page app, fast dev, static bundle
- **Tailwind + shadcn/ui** — UI primitives
- **TanStack Query** — S3 fetch cache and request dedup
- **TanStack Virtual** — virtualized image lists for large uploads
- **Zustand** — edit/UI state
- **Dexie.js** — IndexedDB wrapper, draft persistence
- **react-hotkeys-hook** — keyboard shortcuts
- **react-zoom-pan-pinch** — full-size image inspection
- **`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`** — portable across
  MinIO, AWS S3, and Cloudflare R2 (config-only swap)
- **papaparse** — Camtrap-DP CSV read/write
- **fuse.js** — fuzzy search for species autocomplete

## Shared packages

Lives under `packages/` in this monorepo. Internal-only; no `dist/`,
consumers bundle the source via Vite + pnpm workspace resolution.

### `packages/s3-safe` → `@sparcd/s3-safe`

The single, blessed S3 boundary. Every tool that touches storage imports
this. It enforces three guardrails the application code cannot bypass:

1. **Bucket allowlist** — pattern or explicit list, validated at client
   construction. Operations on out-of-allowlist buckets throw before any
   network call.
2. **Read methods only**, plus one append-only writer:
   - `listObjects(bucket, prefix)` → `AsyncIterable<ObjectInfo>`
   - `getObject(bucket, key)` → `Uint8Array`
   - `statObject(bucket, key)` → metadata only
   - `presignedGet(bucket, key, ttlSec)` → URL
   - `writeImmutable(bucket, key, body)` → conditional `PutObject` with
     `IfNoneMatch: "*"`, throwing on `412 PreconditionFailed` if `key`
     already exists
3. **No destructive APIs exposed** — no `delete*`, `copy*`, or overwriting
   `put*`. Lint rule (`no-restricted-imports`) prevents reintroduction at
   the application layer.

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

Pure TypeScript. No React, no S3.

- Types: `Deployment`, `Media`, `Observation`, plus a `CamtrapBundle` that
  groups all three for one upload.
- Reader: takes raw CSV strings (deployments.csv, media.csv,
  observations.csv) → parsed objects, with the column-index mapping
  (no header row) handled in one place.
- Writer: serializes back to the same byte-identical shape SPARC'd's Java
  ingestor reads. Round-trip stable.
- Validators: schema checks, lat/lng sanity (the swapped-column bug we hit
  in the marimo notebook), tag-string parser for the `[COMMONNAME:Owl]`
  format.
- Tag marker grammar: `tags` is a concatenated list of bracketed markers
  `[PREFIX:value]`. Reserved prefixes for v0 are `COMMONNAME` and
  `REQUESTED_SPECIES`. The parser must preserve and tolerate unknown
  prefixes so future tools can add markers without breaking old readers.

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
                              writeImmutable() → <uploadPrefix>/observations/<userId>/<ISO>.csv
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
  button.

### Performance & interaction (implementer concern, not the design pass)

Snappiness and keyboard latency are first-class requirements — the tool
lives or dies on them. Not a Claude Design concern; these are build
decisions:

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
static builds, `import.meta.env` may prefill non-secret values such as
endpoint, region, bucket allowlist, and path defaults, but must never embed
real access keys or secret keys. Users enter S3 credentials at runtime.
The Java and sparcd-web apps use a different model (server-issued token);
we don't share UI with them by design — different auth shape.

### Persistence — local

- **Dexie schema** v1:
  - `drafts` table:
    `{ id (bucket+uploadPrefix+mediaPath), bucket, uploadPrefix, mediaPath,
    baseObservationKey, baseCsvHash, label, count, freeTags,
    requestedSpecies, questionable, timeOverride, lastEdited, dirty }`
    (`timeOverride` = optional corrected timestamp for this one image, on
    top of the upload offset; null when unset.)
    `label` holds the applied species **or** a non-animal label like
    **Ghost** — Ghost is just another label, not a separate `blank` flag. A
    SPARC'd observation is **species + count only** — there is no `behavior`
    field (the Java `SpeciesEntry` model carries exactly species + amount).
    The exact value/encoding (how Ghost and species land in
    `observations.csv`) follows the upstream SPARC'd convention; the
    implementer confirms it against the sparcd-web and SPARC'd Java
    codebases at build time rather than inventing it here.
  - `uploads` table:
    `{ id (bucket+uploadPrefix), bucket, uploadPrefix, loadedAt,
    latestRemoteObservationKey, latestRemoteCsvHash, timeOffset }`
    (`timeOffset` = signed Δ y/mo/d/h/m/s applied to every image in the
    upload; null when unset.)
  - `sessions` table:
    `{ sessionId, userId, startedAt, finishedAt, syncedAt, syncedKey,
    syncedCsvHash }`
- **Grounding rule.** When an upload has no prior append-only version under
  `<uploadPrefix>/observations/<userId>/`, the draft is grounded on the
  canonical upload-level `observations.csv`; `baseObservationKey = null`
  and `baseCsvHash` is the hash of that canonical file. When an
  append-only version exists, `baseObservationKey` is the most recent
  versioned key and `baseCsvHash` is its hash. Sync-time conflict
  detection compares the current remote `latestRemoteCsvHash` for that
  upload against the draft's `baseCsvHash`; mismatch triggers the
  conflict view before any write.
- **`requestedSpecies` field.** When a tagger needs a species not in
  `Settings/species.json`, the combobox lets them tag with a free-text
  `requestedSpecies` string plus the existing `freeTags`. The sync export
  records the request in the existing `tags` column, for example
  `[REQUESTED_SPECIES:<value>]`, so the output keeps the existing
  `observations.csv` row/column shape while still giving downstream admins
  a machine-readable request. This is the committed answer to open
  question #3.
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
  - Lists existing `<uploadPrefix>/observations/<userId>/*.csv` for the
    upload.
  - Loads the latest, diffs against local drafts.
  - Shows a confirmation dialog: N additions, M modifications, 0 deletions
    (deletions are not a thing — we never erase).
- Write:
  - `writeImmutable(bucket, "<uploadPrefix>/observations/<userId>/<ISO>.csv", serialized)`
  - On 412/PreconditionFailed (key collision), bumps timestamp and retries
    once — never overwrites.
  - Records `syncedAt` and CSV hash in Dexie.
- Recovery view: lists every
  `<uploadPrefix>/observations/<userId>/*.csv` for the upload, lets the user
  inspect or restore any version into the local draft.

The existing canonical `observations.csv` remains read-only in this tool.
The first sync implementation produces reviewable append-only output; direct
consumption by Java/Next requires a separate reader/importer change.

## Safety design

The "absolutely no accidental writes" bar from your earlier ask is
load-bearing. Four layers, each redundant:

1. **IAM policy** — separate access key whose policy permits only
   `s3:ListBucket`, `s3:GetObject`, and `s3:PutObject` on
   `arn:aws:s3:::sparcd-test-*` (or the explicit test-bucket ARN list), with
   writes scoped to `Collections/*/Uploads/*/observations/*` where the
   backend supports object-prefix conditions.
   **No `s3:DeleteObject`.** Belt + suspenders below in case the policy
   is ever misconfigured.
2. **`@sparcd/s3-safe` wrapper** — the only S3 client allowed in app code.
   No destructive methods exposed. Lint rule blocks direct
   `@aws-sdk/client-s3` imports anywhere except `packages/s3-safe/src/`.
3. **Bucket allowlist** — `S3_TEST_BUCKETS` env var, enforced at wrapper
   construction. Anything outside throws.
4. **Immutable writes** — every save is a new timestamped key. The wrapper
   uses conditional `PutObject` with `IfNoneMatch: "*"`; a preflight `HEAD`
   may be used for friendlier errors, but it is never the overwrite-safety
   mechanism.

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
rewritten in place. Corrections are stored locally (`uploads.timeOffset`,
`drafts.timeOverride`), applied on display, and emitted as the corrected
timestamp in the append-only synced output. The exact write encoding
follows the upstream SPARC'd convention; the implementer confirms it against
sparcd-web / the Java app rather than inventing it here.

## Sequence/burst grouping

Default heuristic: same deployment + image timestamps within `60s` of each
other → same burst. Threshold configurable per-session (slider, 5s–600s).

Bursts render as visual bands in `ImageList`. The "Apply to whole burst"
button is one keystroke.

## Species / label autocomplete

- Load `Settings/species.json` once at session start.
- P0 validates the exact object path and JSON shape against the test bucket;
  the current marimo explorer proves CSV/media reads, not this species file.
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
  detection in this tool.

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
| **P0** | Scaffold app + 4 packages (`s3-safe`, `camtrap`, `types`, `auth-ui`); shared Connection screen; image viewer reads from hardcoded test bucket; verify browser CORS for list/get/head and validate `Settings/species.json` path/shape | None |
| **P1** | Single-image tag editing; Dexie drafts; J/K nav; species autocomplete | None |
| **P2** | Sequence/burst grouping; full keyboard set; cheatsheet modal | None |
| **P3** | Batch tagging (multi-select); recovery view (local-only at this stage) | None |
| **P4** | Append-immutable sync under `<uploadPrefix>/observations/<userId>/` — **only after manual review of `@sparcd/s3-safe` conditional write implementation and endpoint-specific CORS/PUT preflight** | First writes, dry-run by default |
| **P5** | Cross-version recovery (load any prior versioned observations CSV from S3 into local) | Reads only |
| **P6** | Internal navigation sections beyond the tagging core: Browse, History (surfaces the P5 recovery capability), Settings | Reads only |

P0–P3 are fully usable as a local-only tagger. The S3 write path doesn't
exist in the build until P4, which means the safety wrapper can be
reviewed in isolation before any real bucket is at risk.

## Open questions for before P0

1. **User identity for the immutable write path.** The IAM access key
   stamps the bucket-side writer; we also want a logical `userId` baked
   into the object key so two researchers can sync from the same browser
   profile without collision. Options: prompt at session start, derive
   from access key, or pin to a config file. Lean: prompt + persist.
2. **First test bucket.** Need a concrete bucket name (or naming pattern)
   that's confirmed write-allowed for the test IAM key, so the
   `S3_TEST_BUCKETS` allowlist starts populated and P0 has somewhere to
   point at without changes.
3. ~~**Species hierarchy edits.**~~ Resolved: tagger never edits the
   hierarchy; missing species fall through to the `requestedSpecies`
   field (see Persistence — local), exported through the existing `tags`
   column for an upstream admin to act on. Cross-referenced in the Dexie
   schema.
4. **Canonical merge path.** Who or what promotes a reviewed append-only
   version from `<uploadPrefix>/observations/<userId>/<ISO>.csv` into the
   canonical upload-level `observations.csv`, if existing Java/Next readers
   need to see the new tags? Lean: keep promotion out of this tagger until
   the append-only review workflow is proven. Cross-link: this is the
   tagging-side half of the uploader's **Reader sentinel rollout** question.

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
  We don't have a pre-classifier today. Keep an optional per-image
  prediction slot in the data model, but the tagger works fully without it.
- **Guided tour / first-run walkthrough.** A short interactive tour of the
  overview → focus → tag → sync flow for new users. Out of scope for MVP.
