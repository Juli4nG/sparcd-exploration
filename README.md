# sparcd-exploration

A workspace for building small, focused, mostly-static tools that work
alongside [SPARC'd](https://github.com/CulverLab/sparcd-web) — each one
tuned end-to-end for a single feature.

A shared landing page ties them together at the deploy root, and the tools
share a connection gate and a saved-login session so you authenticate once
and move between them.

## The tools

- **`apps/sparcd-explorer`** — a [marimo](https://marimo.io) notebook that
  connects to the SPARC'd MinIO backend, bins camera locations into H3
  hexagons, and serves an interactive species-richness report. Exports to a
  static Pyodide bundle that runs entirely in the browser
  (see [Static deploy](#static-deploy)).
- **`apps/sparcd-uploader`** — a static, browser-based tool for preparing and
  uploading camera-trap image batches. Drop a folder; it scans JPEGs and runs
  EXIF, SHA-256, thumbnails, and validation in Web Workers, then writes the
  canonical Camtrap-DP layout through an append-only S3 boundary. Dry-run by
  default.
- **`apps/sparcd-tagger`** — a static, browser-based tagging interface for
  camera-trap images. It reads the same buckets, renders an upload's images
  from presigned URLs, and writes back the canonical Camtrap-DP metadata the
  other readers already consume.
- **`apps/sparcd-home`** — the shared landing page and app switcher served at
  the deploy root.

Each app's `README.md` and `plan.md` carry its full design and phase
breakdown.

## Approach

- **Alongside SPARC'd.** SPARC'd is the system of record; the tools here
  read from it and add focused views on top.
- **One tool, one job.** Each app in `apps/` solves a single concrete user
  problem (a specific report, a specific view, a specific export). When a new
  need shows up, we add a new app.
- **Static where possible.** Prefer designs that can ship as a static bundle
  (Pyodide / WASM, prebuilt data files, signed S3 URLs). Each tool stays
  cheap to host, easy to share, and free of server-side state.
- **Bring your own S3.** The browser tools have no backend and no server-side
  secret. Users supply an S3-compatible endpoint and credentials; IAM/provider
  policy and bucket CORS are the real access gates. Writes go through
  `@sparcd/s3-safe`, an append-only boundary with no delete, copy, or
  overwrite API.
- **Optimize per feature.** With a narrow scope per app, we pick the best
  primitives for that job — data model, layout, interactions — without
  compromise for anything else.

## Layout

```
apps/
  sparcd-home/       # shared landing page + app switcher (static HTML)
  sparcd-explorer/   # marimo notebooks for data exploration (Python, uv)
  sparcd-uploader/   # batch prep + upload, BYO-S3 (TS, Vite)
  sparcd-tagger/     # tagging interface, BYO-S3 (TS, Vite)
packages/
  auth-ui/           # shared connection gate + saved-login session
  camtrap/           # Camtrap-DP data contract (readers, merge, time-shift)
  s3-safe/           # append-only S3 client boundary
  types/             # shared TypeScript types
```

## Toolchain

- **Node** ≥ 20 + **pnpm** 10 — workspace + task runner
- **Turborepo** — pipeline orchestration across apps/packages
- **uv** — Python env/deps for any Python-based app (e.g. marimo)

## Quick start

```sh
pnpm install                                  # installs turbo and JS workspaces

pnpm --filter sparcd-uploader dev             # Vite dev server (uploader)
pnpm --filter sparcd-tagger dev               # Vite dev server (tagger)

pnpm --filter @sparcd/sparcd-explorer install:py   # uv sync for the marimo app
pnpm dev --filter @sparcd/sparcd-explorer     # marimo edit --watch
```

Or run every app's `dev` task at once:

```sh
pnpm dev
```

The Vite apps prefill the S3 endpoint from a gitignored
`apps/<name>/.env` (`VITE_SPARCD_S3_ENDPOINT`). Credentials are never
prefilled — they are entered at runtime.

## Adding a new app

1. `mkdir apps/<name>`
2. Add a `package.json` with `name`, `private: true`, and at least `dev` /
   `build` scripts. Python apps wrap `uv run …` in their npm scripts.
3. `pnpm install` to pick it up via the workspace.
4. Tasks defined in [`turbo.json`](./turbo.json) (`dev`, `build`, `lint`,
   `start`, `check`, `test`) will run across whichever apps implement them.

## Static deploy

`.github/workflows/pages.yml` builds the landing page and each web tool and
publishes them via GitHub Pages on every push that touches `apps/**`. The
landing page sits at the root, with each tool under its own path
(`/explorer`, `/uploader`, `/tagger`). Live at:

<https://juli4ng.github.io/sparcd-exploration/>

The deployed pages run entirely in the visitor's browser — the explorer runs
Python via Pyodide, and the Vite tools talk to S3 directly. SPARC'd
credentials are entered in the connection gate; there is no server-side
secret. The S3/MinIO endpoint must permit CORS from the Pages origin for data
fetches and uploads to succeed.

## Background notes

`architecture.md`, `architecture-pwa.md`, `codex-brief.md`,
`multi-user-question.md`, and `plan-p2p-no-s3.md` are early exploration
notes kept for reference. The current direction is the "Approach" section
above.
