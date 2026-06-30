# Merge-Readiness Report — `feat/mobile-responsive`

## Merge verdict: **Ready after must-fixes**

Build and typecheck pass, and the mobile work is well-executed: nearly every touch-target bump correctly restores desktop density behind a breakpoint, and the two highest-profile known risks (A, D) are confirmed but bounded and cosmetic. The branch is **not** byte-identical at desktop, however: one confirmed **must-fix** desktop-density regression (`MetadataPreview` tab strip, ungated `min-h-[44px]`) plus two confirmed desktop-rendering regressions on dialog close buttons violate the project's explicit byte-identical-at-lg rule, and all three are one-line breakpoint-gating fixes. Land those, and the branch is mergeable; the remaining items are mobile-efficacy gaps and nitpicks safe to follow up.

## Must-fix before merge

These are confirmed and either rated must-fix or are should-fix items that change desktop rendering (violating the byte-identical-at-lg rule).

| File:line | Issue | Fix |
|---|---|---|
| `apps/sparcd-uploader/src/components/MetadataPreview.tsx:112` | **(must-fix)** Tab buttons changed `px-3 py-2` → `min-h-[44px] px-3 py-2.5` with **no breakpoint prefix**, so the tab strip is taller/less dense at ≥lg. The only unprefixed touch bump in the whole diff; every sibling (`Upload`, `History`, `PublishedUploads`) uses the `sm:min-h-0` restore pattern. | `min-h-[44px] sm:min-h-0 px-3 py-2.5 sm:py-2` |
| `apps/sparcd-tagger/src/components/SyncDialog.tsx:122` | Close button went from a bare content-sized glyph (`text-[18px] leading-none`) to `w-11 h-11 grid place-items-center md:w-7 md:h-7`. The `md:` box applies at ≥lg, turning the flush-right × into a 28×28 centered box — shifts the glyph ~9px left and enlarges the hit area vs. main. (Siblings TimeShift/Bulk already had a `w-7 h-7` box, so theirs restore cleanly; this one is a net-new desktop box.) | Gate the box below md: `max-md:w-11 max-md:h-11 max-md:grid max-md:place-items-center … text-[18px] leading-none` (no `md:` box). |
| `apps/sparcd-tagger/src/components/SnapshotsDialog.tsx:46` | Same pattern as SyncDialog — bare glyph → `w-11 h-11 grid place-items-center md:w-7 md:h-7`; at ≥lg the × becomes a 28×28 box, shifting ~9px left in the `justify-between`/`h-12` header. (Other changes in this file — `max-w-[520px]`, `90dvh` cap, `60vh→60dvh`, md-gated btn padding — are desktop-safe.) | `max-md:w-11 max-md:h-11 max-md:grid max-md:place-items-center … text-[18px] leading-none` |

> Note: a later sweep rated the two close-button items as nitpicks (visual impact is only a ~9px glyph offset). They are listed here because they are genuine, easily-gated violations of the byte-identical-at-lg rule — the same class of defect as MetadataPreview. If the team chooses to relax strict desktop parity for sub-pixel-scale glyph shifts, both can drop to should-fix; the MetadataPreview fix remains mandatory.

## Should-fix (follow-up OK)

Confirmed mobile-efficacy gaps. None breaks desktop; all are recoverable annoyances, safe to land as a fast-follow.

- **`apps/sparcd-tagger/src/components/Overview.tsx:207` (KNOWN RISK A)** — burst-select pill gets `[@media(hover:none)]:min-h-11` (44px) but the band is pinned to `BAND_H=30px` (estimateSize :110, wrapper :134) with no `overflow:hidden`; pill overflows ~7px into neighbour rows → mis-tap edge strip. Make `BAND_H` coarse-pointer-aware, or cap the pill at `h-[28px]` with horizontal padding.
- **`apps/sparcd-uploader/src/components/FileList.tsx:9,112-125,173-179` (KNOWN RISK D)** — base `grid-cols-[44px_1fr_auto]`; the `auto` status track sizes per-row independently across separate grid containers, so filename truncation/right edge is ragged row-to-row. Use a deterministic last track (`44px minmax(0,1fr) 11.5rem`) with a matching header width.
- **`apps/sparcd-uploader/src/components/RunMonitor.tsx:54-82`** — mobile two-row grid; error rows (`f.error`) reach ~54px but the virtualizer pins rows at 40px with no `overflow:hidden`, overlapping the next file. Bump `ROW`/`estimateSize` on small screens (e.g. `min-h-[56px] sm:h-[40px]`). (Plain non-error rows fit; impact is confined to failed-upload rows.)
- **`apps/sparcd-uploader/src/index.css` + `apps/sparcd-tagger/src/index.css:64-72`** — the `@media(max-width:640px){input,textarea,select{font-size:16px}}` guard is an element selector (0,0,1) that loses to Tailwind `text-[14px]` class utilities (0,1,0); iOS focus auto-zoom is **not** prevented on the very fields it targets. Add `!important`, or convert fields to `text-base sm:text-[14px]`.
- **`apps/sparcd-uploader/src/components/DeploymentPicker.tsx:154`, `CollectionPicker.tsx:118`** — bottom-sheet promoted correctly, but filter input stays `text-[14px]` → still auto-zooms on iOS. `text-[16px] sm:text-[14px]`.
- **`apps/sparcd-uploader/src/components/CaptureTimeEditor.tsx:11`** — row stacked and clear button enlarged, but the dominant `datetime-local` input keeps `text-[13px]` → zooms on focus. `text-[16px] sm:text-[13px]`. (Same untouched sub-16px controls in `Assign.tsx:207,225,254`.)
- **`apps/sparcd-tagger/src/components/AppliedSpecies.tsx:103-110`** — remove ✕ bumped to 44px but the per-chip count `<input>` stays `w-10 … text-[12px]` (~22px, sub-44px + auto-zoom). Give it a touch hit area and 16px font on small screens, or use +/− steppers.

## Verdict on the 4 known risks

- **(A) Overview burst-select pill overflowing BAND_H — CONFIRMED (should-fix).** Pill grows to 44px in a 30px band with no overflow clip; ~7px spill into neighbour rows creates a real mis-tap strip on the primary mobile interaction. The audit's paired fix (raise band height on touch) was **not** applied, so the touch fix is internally inconsistent. Desktop correctly gated. **Action:** fix on follow-up — make `BAND_H` touch-aware.
- **(B) tagger Chrome StatePill hidden below sm — CONFIRMED, downgraded to nitpick / ACCEPTABLE.** The pill really does vanish on phone (`hidden sm:flex`, Chrome.tsx:61). But the Tag workflow keeps a phone-visible `{nDirty} unsaved · discard` indicator and a Sync button (`Tag.tsx:579-597`, ungated), the S3 sync path is deferred (P4), and the author documented this as an intentional density tradeoff. Gap is limited to Browse/History/Settings on phone. **Action:** accept as-is; an optional compact status dot is a nice enhancement, not required.
- **(C) DropZone coarse-pointer proxy — FALSE-ALARM / ACCEPTABLE.** No desktop regression (`min-h-11 md:min-h-0` restores desktop; fine-pointer desktops keep `webkitdirectory`). The named "victim" devices (touch Chromebook, Surface) actually expose `showDirectoryPicker` and never hit the coarse branch; the only downgraded case (coarse-primary + no File System Access, e.g. touch Firefox) is rare, documented in-code (lines 12-15), and surfaced to the user. **Action:** none — intentional, documented trade-off.
- **(D) FileList status-column alignment — CONFIRMED (should-fix).** `auto` last track sizes independently per row across separate grid containers; status width varies ('Needs attention' vs 'OK'), so the 1fr filename column ends at a different x per row → ragged edge on the 390px Inspect step the refactor set out to fix. Cosmetic (selection/remove still work). Desktop's fixed 6-track template preserved behind `sm:`. **Action:** fix on follow-up — deterministic last track + matching header width.

## False alarms dismissed

Reviewers raised these; independent verification cleared all five (no desktop regression, no functional defect):

1. **`Tag.tsx` toolbar** `flex-wrap`/`min-h-10` unprefixed — all 5 new controls are `lg:hidden` and the search input is fixed `w-28` (nothing grows with content), so it never wraps at ≥lg; visually identical to main.
2. **`SpeciesPanel.tsx` assign/clear buttons** `inline-flex` unprefixed — they're flex children; own display value doesn't affect parent layout, single text node, touch sizing reverted at `md:`. Inert.
3. **DropZone coarse-pointer proxy (C)** — documented, accepted trade-off; named victim devices don't actually downgrade (see C above).
4. **`CaptureTimeEditor.tsx` clear button** `grid place-items-center` on desktop — button is content-sized flex child holding a single glyph; `grid` centering is visually identical, `md:px-1` restores padding.
5. **Tagger dialogs** `max-h-[90dvh]`/`overflow-y-auto` unconditional — no prior max-height existed; the `grid place-items-center` backdrop previously clipped tall content off-screen with no scroll. The change makes a previously-broken overflow case reachable — strictly better, nothing regressed.

## Uncertain (needs browser)

None. Every finding was settled from source/diff; the CSS-cascade and grid-sizing claims are deterministic. (The iOS auto-zoom fixes (B/C-adjacent should-fixes) are determined by specificity, not behavior, so no device check is required — though a 390px iOS Safari smoke test after the `!important`/font-size fixes is a reasonable final confidence check.)

## Nitpicks (optional polish)

- **`Overview.tsx:280-293, 336-349`** — drill chevron is `<span role="button" tabIndex={-1}>` nested inside the cell `<button>` (invalid HTML content model / ARIA nesting). Behaviorally correct (`stopPropagation` → `onDrill`), gated to touch. Render the cell as a `<div>` with a real `<button>` affordance if strict validity matters.
- **`Cheatsheet.tsx:51`** — added `max-h-[90dvh] overflow-y-auto` unprefixed; applies at ≥lg but the short 3-column grid is far under 90dvh, so no scrollbar appears. Gate with `lg:max-h-none lg:overflow-visible` for strict parity, or leave (benign).
- **`PerImageTime.tsx:47,87`** — `flex-wrap min-w-0` unprefixed on both spans; input is gated (`sm:w-[160px]`) so no wrap triggers at normal footer width. `sm:flex-nowrap` for strict parity.
- **`PublishedUploads.tsx:192`** — `{n} edits` toggle bumped to `min-h-[40px]`, 4px under the 44px floor its siblings use. `min-h-[44px] sm:min-h-0` to match.