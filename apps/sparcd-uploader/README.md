# sparcd-uploader

A static, browser-based tool for preparing and uploading SPARC'd camera-trap
image batches. Sits alongside SPARC'd. See [`plan.md`](./plan.md) for the full
design and phase breakdown.

## Status

Runtime-discovered BYO-S3 uploader.

- Shared Connection gate (`@sparcd/auth-ui`) — three fields, endpoint-inferred
  region / path-style / secure behind "Advanced".
- Tool chrome with section tabs (New upload · History · Settings), upload-state
  pill, and a light/walnut-dark theme toggle.
- Four-step flow: Drop, Inspect, Assign, Upload.
- Drag-and-drop a folder (or "Choose folder"); recursive JPEG scan via the
  File System Access entries API / `webkitdirectory`.
- EXIF, SHA-256, thumbnails, and validation run in Web Workers.
- The app discovers readable settings buckets by probing for
  `Settings/locations.json`, and discovers target collections from
  `Collections/<uuid>/collection.json`.
- Dry-run is on by default. Wet uploads use the connected credentials directly;
  IAM and bucket CORS are the real access gates.

## Develop

```sh
pnpm install          # from the repo root
pnpm --filter sparcd-uploader dev
```

Optional dev prefill: copy `.env.example` to `.env` and set
`VITE_SPARCD_S3_ENDPOINT` (endpoint only — never secrets).

## Shared packages

This app established the workspace's shared packages, all consumed as
TypeScript source (no `dist/`):

- `@sparcd/types` — `S3Config`, `Collection`, `Species`, `UserSession`, and the
  pure `detectBackendDefaults` endpoint inference.
- `@sparcd/s3-safe` — the single blessed S3 boundary (runtime scope + read
  methods + immutable writers).
- `@sparcd/auth-ui` — the shared Connection screen.
- `@sparcd/camtrap` — Camtrap-DP types and CSV/metadata writers.
