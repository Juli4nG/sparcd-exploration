# sparcd-uploader

A static, browser-based tool for preparing and (later) uploading SPARC'd
camera-trap image batches. Sits alongside SPARC'd. See [`plan.md`](./plan.md)
for the full design and phase breakdown.

## Status — P0

Local-only scaffold. No S3 reads or writes.

- Shared Connection gate (`@sparcd/auth-ui`) — three fields, endpoint-inferred
  region / path-style / secure behind "Advanced".
- Tool chrome with section tabs (New upload · History · Settings), upload-state
  pill, and a light/walnut-dark theme toggle.
- Four-step indicator; **Drop** and **Inspect** are live.
- Drag-and-drop a folder (or "Choose folder"); recursive JPEG scan via the
  File System Access entries API / `webkitdirectory`.
- Virtualized file list (`@tanstack/react-virtual`) — filename + size, with
  `J`/`K` to move and `D` to drop the active file.

EXIF, hashing, thumbnails, and validation are P1; assignment is P2; CSV
generation is P3; uploads are P4.

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
- `@sparcd/s3-safe` — the single blessed S3 boundary (allowlist + read methods
  + `writeImmutable`). Not exercised until P2/P4.
- `@sparcd/auth-ui` — the shared Connection screen.
- `@sparcd/camtrap` — Camtrap-DP types; reader/writer land in P3.
