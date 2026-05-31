# Field Notebook v2 — design system reference

The visual direction for sparcd-exploration's static tools. Locked tokens
from the Claude Design bundle (`SPARCd Field Notebook v2`). This file is the
source of truth the per-tool design prompts paste in, and the spec the
React implementation matches.

**Aesthetic:** warm, editorial, archival — like an old field journal.
Cream paper, hairline rules over fills, sharp corners, a hand-stamped
highlight for the active row. Serif display, humanist sans for UI,
monospace reserved for data. WCAG AA throughout (14 contrast pairs verified
PASS in the source).

## Color tokens

```
paper       #f4ecd8   base surface
paperHover  #efe6cc   hover on paper
panel       #fbf7eb   raised surface (chrome, cards)
panelHover  #f5efe0   hover on panel
ink         #1c1a14   primary text, primary button fill
inkSoft     #4a463b   secondary text
inkMute     #6b6555   hints / large text only (not body)
rule        #8c8166   hairline separators — hits 3:1 on paper + panel
ruleSoft    #cfc4a8   decorative rules only — never load-bearing
accent      #0b3358   ink-blue — primary action, paw mark, avatar
accentSoft  #dfe7ef   accent wash / selected backgrounds
warn        #8a3818   warning / destructive-adjacent
ok          #33602e   success / positive delta
mark        #ead8a3   hand-stamped active-row highlight — decorative, non-text
```

## Typography

```
display  'Newsreader', Georgia, serif            — headings + scientific names
body     'Inter Tight', 'Inter', system-ui       — all UI text
mono     'JetBrains Mono', ui-monospace           — data, tables, IDs, kbd
```

- **Body floor 14px.** Nothing interactive smaller than 14px.
- **Kicker** (section label): Inter Tight, 11px, weight 600, letter-spacing
  0.16em, uppercase, color `inkSoft`. Not mono.
- Scientific names render in Newsreader italic.
- Mono is reserved — data values, IDs, coordinates, timestamps, keyboard
  tokens. Never body copy or labels.

## Controls

- **Sharp corners everywhere** — `border-radius: 0`.
- **Primary button:** `ink` fill, `paper` text, 1px `ink` border, 8/16
  padding, 14px / 600.
- **Secondary button:** transparent, `ink` text, 1px `ink` border, 7/14
  padding, 14px / 500.
- **Ghost button:** transparent, `inkSoft` text, no border, 7/10 padding.
- **Hit targets ≥ 32px.**
- **Focus ring:** 2px `accent` outline + 2px `paper` offset, on
  `:focus-visible` only.
- Hairline rules (`rule`) over filled dividers. `ruleSoft` is decorative
  texture only and must never be the sole separation between regions.

## Chrome / top nav

The full SPARC'd shell (used by the Field Notebook screens that mock the
whole app):

- 56px tall, `panel` background, 1px `rule` bottom border.
- Left: paw mark (`accent`) + "SPARC'd" wordmark in Newsreader 22px / 600.
- Tabs: Home · Collections · Tag · Search · Maps. Active tab is `ink` with a
  2px `ink` underline overlapping the chrome border; inactive is `inkSoft`.
- Right: username in mono + a 32px `accent` avatar square with initials.

### Standalone-tool chrome

The static tools (sparcd-tagger, sparcd-uploader) ship as separate bundles,
so they drop the cross-app SPARC'd tabs (Home/Collections/Search/Maps) —
nothing implies navigation a single-purpose bundle can't perform. The same
top-nav tab component is **reused for the tool's own internal sections**,
so each tool has real internal navigation and still reads as family.
Chrome: paw + "SPARC'd · <Tool>" wordmark, the tool's section tabs, and the
tool's state pill, on the same 56px / `panel` / `rule` shell.

Each tool's full feature flow (not just its headline action):

- **sparcd-uploader** — New upload · History · Settings
- **sparcd-tagger** — Browse · Tag · History · Settings

Both use **one shared Connection/credentials screen** (`@sparcd/auth-ui`) as
a first-run gate and under Settings. It is **three fields — endpoint, access
key, secret key**; secure/region/path-style are inferred from the endpoint
(rare overrides behind a collapsed "Advanced" disclosure), and identity +
dry-run default live in Settings rather than the login. Identical across
tools; only the chrome label ("SPARC'd · Tagger" / "· Uploader") changes.

## Screens already designed in the bundle

- **Home** — paired hero (focus card + "Sites at a glance" notebook map)
  over a verb-card row and a dense in-progress uploads table.
- **Tagger** — single-row header (breadcrumb / counter / metadata),
  quiet active-row treatment, image-only photo frame, Inter Tight kickers.
- **Query + Results** — single-row results header, per-species summary
  band, sticky 13px mono table.

New tools (sparcd-tagger, sparcd-uploader) extend this same language to
their own screens — see the latest Claude Design bundles below.

## Latest Claude Design bundles

These are the canonical mocks each tool's plan implements against. Each
iteration produces a new URL — update these entries when a newer build
supersedes them.

- **Uploader** —
  <https://api.anthropic.com/v1/design/h/UIxTk3s58j290-DB649lmw?open_file=SPARCd+Uploader.html>
- **Tagger** —
  <https://api.anthropic.com/v1/design/h/13csaw3-7eZU_pYtJkQGwQ?open_file=SPARCd+Tagger.html>

The Connection screen is **shared**; both bundles include the same
three-field component.

## Dark variant

Both static tools ship a **dark variant of Field Notebook** — a warm,
low-glare dark surface (aged leather / dark walnut / warm charcoal), not a
cold blue-black console. It is a parallel token set, not a separate
direction: same Newsreader / Inter Tight / JetBrains Mono, same structure,
re-tuned surfaces and semantic colors to hold WCAG AA on dark. The
ink-blue accent stays recognizable (lightened for AA as needed); `warn`,
`ok`, and the `mark` active-row highlight get dark-tuned equivalents. The
two themes are a token swap, not a redraw. Dark token values land here once
the Claude Design pass produces them.
