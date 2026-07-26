# Changelog

All notable changes to the Court of Honor Program Generator will be tracked
here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [1.3.0] — 2026-07-26

### Added

- **Pocket Certificates step** (new Step 6). Generates BSA Merit Badge
  pocket certificates as a PDF — 8 cards per landscape US Letter sheet,
  ready to cut apart with a paper cutter. Only merit badges are printed;
  ranks and misc awards use BSA's pre-printed cards (hand-filled).
  - Per-troop download button ("Download Troop 96B Pocket Certificates PDF
    (160 cards on 20 sheets)"), with the count/sheet math updating live as
    the PO is uploaded or the troop label changes.
  - New form fields: **Council** (default "Mid-Iowa Council"), **Signature**
    (blank — volunteer types the signing Scoutmaster / Advancement Chair),
    **Default date earned** (falls back to the Event Date if left blank —
    used only for PO rows with no per-row Date Earned), **Troop identifier
    on cards** for each troop (defaults "96 B" / "96 G" — free text so
    volunteers can match legacy card conventions).
  - Filenames follow the convention `<Troop-Label>-pocket-certificates.pdf`
    (e.g. `Troop-96B-pocket-certificates.pdf`).
- New `data.js` export **`extractMeritBadgeRows(csvText)`** — returns an
  ordered list of `{ scoutName, firstName, lastName, badge, dateEarned }`
  suitable for pocket-cert generation. Filters out ranks and misc awards,
  strips BSA store suffixes, sorts by last/first/badge.
- New module **`pocket-cert-builder.js`** — pure pdf-lib PDF assembly for
  the 2x4 pocket-cert grid, with cut-guide borders on every card slot
  (including blank slots on the final sheet) so the printed cut-line grid
  is complete.

### Design decision — new step vs. augmenting Download

Chose a **separate Step 6** rather than folding pocket certs into the
existing Download step. Pocket certs have their own inputs (Council,
Signature, per-troop card identifier, default-date-earned override) that
don't belong in Event Details, and they produce a distinct family of
artifacts on a different print workflow (cut-apart cards, not folded
booklet). Grouping the new inputs under Download would have crowded that
step and hidden fields that don't affect the program PDFs. The tradeoff
is one more step down the page; the volunteer flow reads naturally
top-to-bottom regardless.

### Under the hood

- `state.pocket = { council, signature, defaultDate, troopIdents[] }`
  is a new sub-state. `migrateSession()` backfills it on any pre-1.3
  session (missing fields → defaults; partial overrides honored).
- Pocket-cert card layout ports the padding, type sizes, and vertical
  rhythm from `scripts/generate_mb_pocket_certificates.py` /
  `scripts/templates/pocket-cert-page.html` (0.618" top / 0.382" bottom
  padding, 12/10/11/11pt type sizes, 0.43125" gap under the badge).
- Signature is rendered with `StandardFonts.HelveticaOblique`. pdf-lib's
  standard fonts don't include a cursive/script face; using an embedded
  Google Font (Great Vibes, Kalam, etc.) would work but adds a network
  dependency incompatible with the "open the file directly" story. Noted
  as a known limitation in the README.

### Tests

- 27 new smoke assertions covering: MB-only filter (no ranks/emblem
  suffixes leaking through), extractor row count agreement with
  `parsePO()`, PDF page count = `ceil(N/8)`, page-0 size = 792×612 pt,
  scout/badge/council/signature/troop text rendering on page 1, default
  date fallback when the row has no Date Earned, single blank sheet for
  the zero-rows edge case, form-field default values, and migration
  backfill.

## [1.2.3] — 2026-07-26

### Changed

- **MC-linked agenda rows now bind dynamically to the MC field.** In prior
  releases these rows stored the literal placeholder string `"MC"` in the
  presenter cell; the substitution to the actual MC name happened only at
  PDF-render time and left the user staring at `"MC"` in the input.
  From v1.2.3 the row carries a `linkedTo: "mcName"` flag and an empty
  `presenter`. The presenter input reads its value from the current MC
  field live, and shows a grey HTML `placeholder` of `(MC name here)` when
  the MC field is blank.
- Typing into an MC-linked presenter input **permanently breaks the
  link** — the row switches to `linkedTo: undefined` and stores whatever
  the volunteer typed. Clearing that field afterward does NOT re-link
  (least-surprise). Any subsequent change to the MC field is ignored for
  that row.
- The PDF/preview renders **`(MC name here)` in grey** as the presenter
  for MC-linked rows when the MC field is empty, so the printed program
  visibly flags the gap. When the MC field is set, the same rows show the
  actual name in normal text.
- Custom rows added via *+ Add item* are never MC-linked, even if the
  volunteer types the literal word "MC" as the presenter.

### Migration

- Legacy sessions (v1.2.2 and earlier) with `presenter: "MC"` on default
  rows have their MC link re-established during load. Sessions where the
  volunteer had edited a would-be-linked row's presenter to something
  else are treated as permanently broken links (their edit wins).
- Custom rows whose presenter happens to be literally `"MC"` are NOT
  re-linked — they retain the literal text.

### Under the hood

- `resolvePresenter(row, mcName)` now returns `{ text, placeholder }`
  (was: a plain string). Exported alongside the new `MC_PLACEHOLDER`
  constant (`"(MC name here)"`) for use by the PDF builder, the preview,
  and the smoke test. `pdf-builder.js` gained per-run `color` support in
  its `drawRuns` helper so it can render the placeholder in grey via
  `rgb(0.55, 0.55, 0.55)`.

### Tests

- Smoke test expanded to 76 assertions (from 56). New coverage:
  - `resolvePresenter` unit tests exercise all 4 code paths (linked+name,
    linked+blank, unlinked, custom-text row with a broken link) and
    verify the return-shape includes `placeholder`.
  - DOM-render assertions verify the Opening Ceremony row's presenter
    input has `value=""` + `placeholder="(MC name here)"` at boot, gains
    an `Isaac Samo` value after dispatching an `input` event on the MC
    field, and reverts to `""` when the MC field is cleared.
  - Manual-edit assertion: typing into a linked row's presenter input
    removes the `data-linked-to="mcName"` marker and prevents further
    MC-driven updates. Clearing the manual edit does NOT re-link.
  - Migration assertion: a v1.2.2-shaped session with `presenter: "MC"`
    on default rows migrates to `linkedTo: "mcName"` + `presenter: ""`.
    A default row that was manually edited to a non-"MC" value stays
    unlinked with the manual text. A custom row with `presenter: "MC"`
    stays as literal text (not re-linked).
  - PDF assertions: when MC is blank the generated PDF contains
    `(MC name here)` after `Opening Ceremony`; when MC is set to
    `Isaac Samo` the placeholder is gone and the name appears in its
    place; Scoutmaster Minute row's presenter is unchanged either way.

## [1.2.2] — 2026-07-26

### Changed

- **Simplified the Program Sections & Agenda editor.** Only the 7 required
  rows now carry a visible "Required" badge. All other rows — the two
  default suggestions (Guest Speakers, Additional Recognition) and anything
  the volunteer adds via *+ Add item* — render with no badge, so the UI has
  just two visual categories: "Required" and everything else.
- **Removed the include/exclude checkbox from non-required rows.** To omit a
  suggested row (e.g. skip Guest Speakers at a given CoH) the volunteer now
  clicks the row's ✕ delete button, just like any other row. Required rows
  still have no delete button.
- Renamed the add button from "+ Add custom item" to just "+ Add item".
  Typing a label that matches a former default (e.g. "Presentation of
  Colors", "Order of the Arrow") receives no special treatment — it's just
  a normal added row.
- **Troop display names now default** to `Troop 96B` (Troop A) and
  `Troop 96G` (Troop B). Volunteers editing them by hand still works
  exactly as before; PO-filename-based inference kicks in when the field
  is blank at upload time.
- **MC-presented agenda rows now reflect the MC field.** Any row whose
  stored presenter is the symbolic `MC` renders as the actual MC name from
  the Event Details step in both the live preview and the generated PDF.
  If the MC field is blank the row still shows the literal `MC` (visible
  placeholder). Manual edits to a row's presenter are respected — only the
  exact value `MC` is treated as a placeholder. Implemented as an exported
  helper `resolvePresenter(presenter, mcName)` used by both the preview and
  the PDF builder.

### Migration

- Pre-1.2.2 sessions with an optional row saved as `included: false` now
  have that row dropped entirely on load (equivalent to the user having
  deleted it in the new UI). Rows saved as `included: true` are kept.
- The `kind: 'optional'` distinction still exists under the hood so that
  those rows continue to generate a matching booklet content page; only the
  render layer treats them identically to `kind: 'custom'`.

### Tests

- Smoke test now asserts (a) zero `input[type=checkbox]` inside the agenda
  table, (b) exactly 7 rows carry the `.badge-required` class and no other
  row carries any `.badge`, (c) every non-required row exposes a
  `button[data-a="del"]`, (d) no required row exposes a delete button, and
  (e) the add-item button reads exactly `+ Add item`. A new migration case
  feeds a pre-1.2.2 session with `guest-speakers` marked `included:false`
  and asserts the migrator drops that row while retaining the other
  `included:true` optional row.
- Smoke test also verifies the new v1.2.2 event-form defaults
  (`Troop 96B` / `Troop 96G`) and the MC-substitution behavior end-to-end:
  the exported `resolvePresenter()` helper has unit-level assertions for
  the four substitution cases (swap, blank, whitespace-trim, respect
  manual edits) plus PDF-level assertions that regenerate the source PDF
  twice — once with the MC field blank (agenda rows show literal `MC`)
  and once with the field set to `Isaac Samo` (agenda rows show that
  name; the Scoutmaster Minute row's `Brad Johnson and Carol Donelly`
  presenter is unchanged).

## [1.2.1] — 2026-07-26

### Changed

- **Default agenda trimmed and re-scoped per the user's canonical list.**
  Required rows are now exactly 7 items in this order: Opening Ceremony,
  Welcome and Introductions, Rank Advancement, Merit Badges, Senior Patrol
  Leader Update, Scoutmaster Minute, Closing. Optional rows are exactly 2:
  Guest Speakers and Additional Recognition — both **checked by default**
  (the volunteer un-checks them if they don't apply to a given CoH).
- **Removed from defaults entirely:** Presentation of Colors,
  Pledge/Oath/Law, Retirement of Colors, Order of the Arrow, Adult Leader
  Awards, MC Introduction. Any of these can be re-added on a per-CoH basis
  as a Custom row via *+ Add custom item*.
- `migrateSession()` now reconciles prior v1.2 sessions (which had a larger
  10-required / 3-optional list) against the new defaults: rows whose key
  is no longer in defaults are dropped; missing required rows are inserted
  in default order; user-added Custom rows are preserved as-is; edited
  labels / presenter text on surviving rows are preserved.

### Tests

- Smoke test now asserts the exact shape of the new defaults (7 required in
  order, 2 optional both checked, none of the removed keys reappear) and a
  new migration case that feeds a full v1.2-shaped session through
  `migrateSession()` and verifies removed items drop, required items are
  present in default order, custom rows are preserved, and edited presenter
  text on required rows survives. Booklet page-count assertion updated
  from 4 to 6 landscape pages (10 source pages → 12 padded → 6 sheets)
  because the two default-included optional pages now show up in the
  generated PDF.

## [1.2.0] — 2026-07-26

### Changed

- **Program sections and Agenda are now one step (step 3 of 5).** The
  separate "Program sections" and "Agenda" steps have been merged into a
  single ordered list titled *Program Sections & Agenda*, with the roster
  grouping/sort options moved inside the same step. Overall step count is
  now 5 (was 6): Upload POs → Event details → Program Sections & Agenda →
  Preview → Download.
- Agenda default labels and order are now derived from the most-recently-
  updated docx at
  `data/courts-of-honor/07-27-2026/Court of Honor Program - Jul 27 2026 (booklet-flow) - manual edits.docx`
  where they map, with two BSA-traditional items ("Presentation of Colors"
  and "Pledge of Allegiance, Scout Oath & Law") inserted in traditional
  positions since the docx doesn't include them explicitly.
- **MC name** field is no longer prefilled — the volunteer must enter it.
- **Scoutmaster Minute presenter(s)** field now defaults to
  `Brad Johnson and Carol Donelly` (the current Scoutmaster / Committee Chair).
- **SPL Update is no longer optional** — always included in both the agenda
  page and the program body.

### Added

- Unified agenda / program-sections model. Each row is one of:
  - **Required** — locked in, can be reordered / re-labelled / re-presenter'd
    but cannot be removed or excluded.
  - **Optional** — Order of the Arrow, Adult Leader Awards, Additional
    Recognition. Each has an *Include* checkbox that adds the row to the
    agenda and prints a matching content page.
  - **Custom** — user-added rows (e.g. memorials, guest speakers). Fully
    editable and removable; agenda-only (no content page).
- `migrateSession()` in `app.js` — safely upgrades v1/v1.1 session JSONs to
  the new unified schema. Old `state.sections` flags are mapped onto the
  optional entries' `included` flag; legacy `spl` flag is ignored (SPL is
  always required now). Old `agenda` entries have their presenter text
  preserved wherever the label matches a new default.
- Smoke test now covers:
  - MC field default is empty string.
  - SM Minute default is `Brad Johnson and Carol Donelly`.
  - SPL Update is required (not in the optional set; migrator forces
    `included: true` for legacy sessions setting it false or omitting it).
  - All 10 required agenda items appear in the generated PDF's text in the
    correct default order (verified via `pdftotext`).

## [1.1.0] — 2026-07-26

### Changed

- Replaced the cover fleur-de-lis with a high-resolution version (920×1041
  source, composited on white for JPEG embedding) so the logo stays crisp at
  print resolution. The reference asset is mirrored to
  `data/courts-of-honor/07-27-2026/assets/fleur-de-lis-hires.png`.
- Booklet-imposition print flow is now **duplex long-edge** (the printer
  default), fold along vertical center. Updated the in-app status text and
  the README instructions to match. The imposition order is unchanged and
  matches the pypdf reference in
  `data/courts-of-honor/07-27-2026/make-booklet.sh`.

### Added

- Thin grey border (0.5pt stroke, RGB 0.65 grey) inset 1/4" (18pt) on every
  half-sheet of every booklet page. Survives all printer non-printable
  margins.
- Smoke-test now asserts:
  - Roster counts unchanged (35 boys / 178 items, 15 girls / 71 items).
  - Cover fleur-de-lis is the hi-res JPEG (> 50 KB).
  - No `/Rotate` on any booklet page (all upright).
  - Rasterized page 1 is 792×612 px landscape.
  - Grey border pixels present along the top and bottom of both half-sheets.

## [1.0.0] — 2026-07-26

### Added

- Initial release.
- Two-troop upload with drag-and-drop CSV parsing (Scoutbook PO format).
- Event details form (date, time, venue, MC, cover title, org line).
- Optional sections: Order of the Arrow, Adult Leader Awards, Additional
  Recognition, SPL Update.
- Grouping options: rank by-troop vs. combined, merit badges by-troop vs.
  combined, MB sort by first vs. last name.
- Editable agenda list with add / remove / reorder.
- Live HTML preview of half-letter pages.
- Source PDF (5.5"×8.5" portrait) and imposed booklet PDF (11"×8.5"
  landscape, saddle-stitch order for duplex short-edge printing).
- Save / load session as JSON so volunteers can archive a CoH's inputs next
  to the CoH folder and re-open it next year.
- GitHub Pages deployment via
  `.github/workflows/deploy-coh-program.yml`.
- Node-based smoke test (`test/smoke.mjs`) that regenerates a booklet PDF
  from the July 27 2026 sample POs and asserts a 4-landscape-page booklet.
