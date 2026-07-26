# Court of Honor Program Generator

A tiny static web app that turns two Scoutbook **Purchase Order** CSVs into a
print-ready, half-letter booklet **program** for a BSA Court of Honor.

- Single page, no backend, no build step.
- Vanilla ES modules loaded straight from GitHub. Volunteers who inherit this
  can open it in a browser and read the source right there.
- Ports the logic from [`data/courts-of-honor/07-27-2026/build_program_v2.py`](../../data/courts-of-honor/) —
  see the [CoH data folders](../../data/courts-of-honor/) for real examples
  of the inputs and reference outputs. (Note: the top-level `data/` folder is
  git-ignored — those paths exist only in the maintainer's local working copy.
  The self-contained samples used by this app live under [`./test/`](./test).)

## Running it

### Locally (fastest)

Serve the folder over HTTP so ES-module imports resolve properly:

```bash
cd apps/coh-program
python3 -m http.server 8000
# then open http://localhost:8000
```

You *can* also open `index.html` directly from a `file://` URL, but browsers
will refuse to `fetch()` the local sample CSVs and the bundled fleur-de-lis
image, so uploads still work but the sample-loader buttons and the cover
logo won't. Use `python3 -m http.server` for the best experience.

### On the web

The app auto-deploys to GitHub Pages on every push to `main` via
[`.github/workflows/deploy-coh-program.yml`](../../.github/workflows/deploy-coh-program.yml).

Once the workflow finishes the site is at:

- <https://bjhartin.github.io/scouts-advancement/> (or, if the workflow
  publishes to a subfolder in the future, `.../scouts-advancement/coh-program/`)

If you're forking this: replace `bjhartin` with your GitHub owner and enable
Pages for the repository (Settings → Pages → **Source: GitHub Actions**).

## How to use it (volunteer flow)

The app is six numbered steps down the page. Fill them out top to bottom:

1. **Upload POs.** Drop the Scoutbook PO CSV for each troop into the two
   slots. The troop label auto-fills from the filename (`PO_T96BT_...` →
   *Troop 96B*).
2. **Fill event details.** Date, time, venue, MC (blank by default — the
   volunteer types the current MC's name), cover title, council line. The
   Scoutmaster Minute presenters field is pre-filled with the current
   Scoutmaster / Committee Chair defaults.
3. **Program Sections & Agenda.** One unified ordered list that drives both
   the printed agenda page and which content sections the booklet renders.
   Two visual categories:
   - **Required** rows (Opening Ceremony, Welcome & Introductions, Rank
     Advancement, Merit Badges, Senior Patrol Leader Update, Scoutmaster
     Minute, Closing) carry a *Required* badge and are always included.
     You can reorder, re-label, or change the presenter, but you can't
     remove them.
   - **Everything else** — the two default suggestions (Guest Speakers,
     Additional Recognition) plus anything you add with *+ Add item* — has
     no badge, no include checkbox, and a ✕ delete button. To omit a
     suggested row, just delete it; to re-add it later or drop in something
     new (Presentation of Colors, In Memoriam, a guest speaker, etc.),
     click *+ Add item* and type the label + presenter.

   The same step also has the grouping options: whether to combine troops in
   the rank and merit-badge lists, and whether to sort merit badges by first
   or last name.
4. **Preview.** Scroll through the browser rendering of each half-letter page.
5. **Download.** Two buttons:
   - **Source PDF** — 5.5"×8.5" portrait, natural page order (for archival
     or re-imposition with a different tool).
   - **Booklet PDF** — 11"×8.5" landscape, pre-imposed for saddle-stitch
     duplex printing. **Print duplex long-edge (the printer default),
     US Letter, no scaling, then fold each sheet in half along the vertical
     center.** Every page is placed upright (no rotation) and framed with a
     thin grey border inset 1/4" from each half-sheet edge so nothing lands
     in the printer's non-printable margin.
6. **Pocket Certificates.** Generate BSA **Merit Badge pocket certificates**
   as a PDF — 8 cards per landscape US Letter sheet, ready to cut apart
   with a paper cutter. One button per troop; the label updates live to
   show the card count and sheet count (e.g. *Download Troop 96B Pocket
   Certificates PDF (160 cards on 20 sheets)*). Fill in:
   - **Council** (default *Mid-Iowa Council*)
   - **Signature** — free text, rendered in an oblique typeface as the
     signing Scoutmaster / Advancement Chair's name. Leave blank to omit.
   - **Default date earned** — used only for PO rows that have no *Date
     Earned* value. Falls back to the Event Date if you leave it blank.
   - **Troop identifier on cards** — free text per troop. Some legacy
     card conventions render as *96 B* with a space; type whatever you
     want on the printed cards. Defaults *96 B* / *96 G*.

   Only merit badges get pocket certs from this tool — ranks and misc
   awards use BSA's pre-printed cards, which are hand-filled. Print at
   100% scale (no fit-to-page) and cut on the light grey guides that
   frame every card slot.

   **Font limitation.** pdf-lib's standard font set doesn't include a
   cursive/script face, so the signature is rendered with
   `Helvetica-Oblique` — a sloped sans that reads as a signature at
   11pt but isn't a true script. Embedding a Google Font (Great Vibes,
   Kalam, etc.) would add fidelity but require a network fetch that
   breaks the "open the file directly from disk" story. If that
   tradeoff feels acceptable, patch `pocket-cert-builder.js` to embed
   the font of your choice with `pdf.embedFont(bytes)`.

At any time you can hit **Save session** to download a JSON snapshot of
every field (including the raw CSVs), so you can re-open the same CoH next
year without re-typing anything. Load it back with **Load session**.
Sessions saved by older versions of the app are auto-migrated on load — the
old separate `sections` and `agenda` fields are merged into the new unified
list, and SPL Update is force-enabled since it's now a required row.

## Data model

Every PO CSV row must include at least `First Name`, `Last Name`, `Item Type`,
and `Item Name`. `Item Type` is one of:

| Item Type       | How we render it                                              |
| --------------- | ------------------------------------------------------------- |
| `Badges of Rank`| Rank Advancement section, grouped by rank in canonical order  |
| `Merit Badges`  | Merit Badges section, comma-separated inline under each scout |
| `Misc Awards`   | Appended to that scout's Merit Badges line                    |

Item names are cleaned by stripping decorative suffixes (`Emblem`,
`MB Emblem`, `Rank`, `Rank Emblem`, ` (Scouts BSA)`, ` (Silver)`, etc.). Rank
strings are normalized to a canonical base name (`Life Scout Rank Emblem` →
`Life`) so that they group correctly regardless of Scoutbook's wording.

Canonical rank order (as printed):

1. Scout
2. Tenderfoot
3. Second Class
4. First Class
5. Star Scout
6. Life Scout
7. Eagle Scout
8. Eagle Palm

Within a rank, scouts are sorted alphabetically by last name. The Merit
Badges list is one alphabetical roster by last (or optionally first) name,
with each scout's badges comma-separated and misc awards appended.

## Booklet imposition (how the print artifact works)

Half-letter portrait pages are padded to the next multiple of 4 with blank
pages, then arranged two-up on landscape US Letter sheets in the standard
saddle-stitch order. For a booklet of *N* pages (multiple of 4), sheet
*s* (1-indexed, *s* = 1..*N*/4) carries:

- **Front:** *left* = page *N* − 2(*s* − 1),  *right* = page 2*s* − 1
- **Back:**  *left* = page 2*s*,               *right* = page *N* − 2*s* + 1

Pages are emitted front, back, front, back… so that when you print the
output duplex with flip on **short** edge and fold each sheet in half, you
get a proper booklet in reading order. This mirrors what `pdfjam --booklet
true --landscape --paper letterpaper` produces (the previous, LibreOffice-
+ TeX-based pipeline in
[`data/courts-of-honor/07-27-2026/make-booklet.sh`](../../data/courts-of-honor/07-27-2026/make-booklet.sh)).

## File layout

```
apps/coh-program/
├── index.html         Entry point — semantic HTML with tagged form controls
├── styles.css         Small dark-mode-aware stylesheet
├── app.js             DOM glue: state, upload/drop, agenda editor, preview
├── data.js            CSV parser + roster normalization (Node + browser)
├── pdf-builder.js     pdf-lib page layout + saddle-stitch imposition
├── pocket-cert-builder.js  pdf-lib layout for BSA MB pocket certificates (8-up)
├── assets/
│   └── fleur-de-lis.jpg  Cover logo (also used as favicon)
├── test/
│   ├── sample-boys.csv    Copy of a real Scoutbook PO for demoing
│   ├── sample-girls.csv
│   ├── smoke.mjs          Node end-to-end test (see below)
│   ├── source.pdf         Regenerated by the smoke test
│   └── out.pdf            Regenerated by the smoke test — reference booklet
├── package.json       Only for the Node smoke test (pdf-lib)
├── README.md
└── CHANGELOG.md
```

## Extending the app

Small, non-technical-friendly changes:

- **Add an agenda default:** edit `state.agenda` in `app.js`.
- **Change the cover title default:** `state.event.title` in `app.js`.
- **Rewrite the acknowledgments list:** search for `ackLines` in
  `pdf-builder.js`.
- **Change type sizes:** the `H1`, `H2`, `H3`, `BODY` constants at the top
  of `pdf-builder.js`.

Larger changes:

- **New optional section** — add an entry to the `optionals` array in both
  `pdf-builder.js` (`buildSourcePDF`) and `app.js` (`renderPreview`), then
  add a matching checkbox in `index.html`.
- **New grouping option** — extend the `opts` handling in
  `data.js#buildRoster` and add a `<select>` in `index.html`.
- **New rank** — insert into `RANK_ORDER` and `RANK_DISPLAY` in `data.js`.

## Testing

There's a Node smoke test that exercises the entire data → PDF pipeline
using the sample CSVs:

```bash
cd apps/coh-program
npm install         # first time only, installs pdf-lib for the test
node test/smoke.mjs
```

It writes `test/source.pdf`, `test/out.pdf`, and `test/pocket-boys.pdf`
and asserts that the imposed booklet is 6 landscape US-Letter pages, that
the pocket-cert PDF is `ceil(N/8)` landscape pages, and a broad set of
per-row text-render assertions on the pocket cards (scout / badge / date /
council / signature / troop identifier).

## Future work

- Custom fonts / theming beyond Helvetica (including a true script font
  for pocket-cert signatures)
- Full WYSIWYG rich-text editing of individual scout lines
- Auto-diff against the previous CoH (what's changed since last time?)
- Historical Eagle standing recognition list
- Multi-page cover art / photos
- Non-BSA (Girl Scouts, Trail Life, etc.) templates
- Avery 5162 mailing-label sheet for scout pocket-cert distribution (the
  Python source has this — port when needed)
