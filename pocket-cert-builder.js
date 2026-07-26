// pocket-cert-builder.js — build BSA Merit Badge pocket certificate PDFs.
//
// Each certificate is 2.5" x 3.75" and 8 of them fit on an 11" x 8.5"
// landscape US Letter sheet (2 rows x 4 columns, no gutter). The BSA
// pre-prints the card art elsewhere; this generator fills in the text
// fields (scout name, badge, date, troop, council, signature) so the
// volunteer can cut the sheet apart with a paper cutter after printing.
//
// Only Merit Badges get pocket certs from this tool — rank cards and misc
// award cards are hand-filled since BSA already pre-prints those.
//
// Layout is aligned to the reference HTML template
// (scripts/templates/pocket-cert-page.html) by measurement: the reference
// was rendered to PDF with headless Chrome and each text element's
// baseline was extracted via `pdftotext -bbox-layout`. The vertical
// offsets used below are those measured offsets (top-down, from card top)
// — see `POCKET_CARD_LAYOUT` for the fixed constants.
//
// v1.3.2: cut-guide borders removed (BSA cardstock already has its own
// perforations/borders). No stroke calls are made anywhere in this file.
//
// Public API:
//   buildPocketCertsPDF(rows, opts, pdfLib) -> Promise<Uint8Array>
//     rows: Array<{ scoutName, badge, dateEarned }>
//     opts: { defaultDate, troop, council, signature }
//     pdfLib: the pdf-lib module (import from CDN in browser, npm in Node)

const PT_PER_IN = 72;

// Sheet + card geometry (from the reference Python/HTML template).
const SHEET_W = 11 * PT_PER_IN;   // 792
const SHEET_H = 8.5 * PT_PER_IN;  // 612
const CARDS_PER_ROW = 4;
const ROWS_PER_SHEET = 2;
const CARDS_PER_SHEET = CARDS_PER_ROW * ROWS_PER_SHEET; // 8
const CARD_W = 2.5 * PT_PER_IN;   // 180
const CARD_H = 3.75 * PT_PER_IN;  // 270

// Type sizes (pt).
const SIZE_SCOUT = 12;
const SIZE_BADGE = 10;
const SIZE_DATE_UNIT = 11;
const SIZE_COUNCIL = 11;
const SIZE_SIGNATURE = 11;

// v1.3.2: Fixed text baseline offsets, expressed as distance from the
// card's top edge in top-down coordinates (matching pdftotext -bbox-layout
// output on the reference render). These are the RAW `yBot` (bottom of the
// text bounding box) from the reference render. drawCard converts each to
// a pdf-lib baseline by subtracting the font descent for the appropriate
// size — Helvetica's Descent value from the FontDescriptor is -207 (in
// 1/1000-em units), i.e. descent = 0.207 * fontSize.
//
// Measured by rendering scripts/templates/pocket-cert-page.html with
// headless Chrome (11in x 8.5in landscape) and extracting each element's
// yBot with pdftotext -bbox-layout. See v1.3.2 CHANGELOG for full notes.
export const POCKET_CARD_LAYOUT = Object.freeze({
  // Text bounding-box bottom, top-down from card top edge (pt). The
  // pdf-lib baseline is derived from this by subtracting the font descent.
  scoutNameTop: 92.54,
  badgeTop:    114.62,
  dateUnitTop: 165.08,
  councilTop:  184.58,
  signatureTop: 207.21,
  // Horizontal anchors, from card left edge (pt).
  dateLeft: 36,     // 0.5" — outer 0.25" pad + date-unit inner 0.25" pad
  rightEdge: 162,   // CARD_W - 0.25" outer pad (troop/council/signature right-align)
});

// Helvetica's font descent as a fraction of em (from the built-in
// FontDescriptor: Descent = -207 / 1000).
const HELVETICA_DESCENT_RATIO = 0.207;

/**
 * Build the pocket certificates PDF for a set of merit-badge rows.
 *
 * `rows` is expected to be pre-sorted (e.g. by extractMeritBadgeRows()).
 * Empty slots on the final sheet are left blank — v1.3.2 no longer draws
 * a cut-guide border on either filled or empty slots, since BSA cardstock
 * already has its own borders/perforations.
 */
export async function buildPocketCertsPDF(rows, opts, pdfLib) {
  const { PDFDocument, StandardFonts } = pdfLib;
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  // Pragmatic v1: use Helvetica-Oblique for the signature. pdf-lib's
  // built-ins don't ship a script/cursive face; substituting a script
  // font from a CDN is possible but adds a network dep. See README.
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const defaultDate = String(opts.defaultDate || "").trim();
  const troop = String(opts.troop || "").trim();
  const council = String(opts.council || "").trim();
  const signature = String(opts.signature || "").trim();

  const totalSheets = Math.max(1, Math.ceil(rows.length / CARDS_PER_SHEET));
  for (let s = 0; s < totalSheets; s++) {
    const page = pdf.addPage([SHEET_W, SHEET_H]);
    for (let i = 0; i < CARDS_PER_SHEET; i++) {
      const rowIdx = s * CARDS_PER_SHEET + i;
      if (rowIdx >= rows.length) continue; // leave slot blank (no border either)
      const col = i % CARDS_PER_ROW;
      const rowY = Math.floor(i / CARDS_PER_ROW);
      // Card rect in pdf-lib bottom-up coordinates.
      const x = col * CARD_W;
      const y = SHEET_H - (rowY + 1) * CARD_H;
      const r = rows[rowIdx];
      const dateStr = (r.dateEarned && String(r.dateEarned).trim()) || defaultDate;
      drawCard(page, { x, y, width: CARD_W, height: CARD_H }, {
        scoutName: r.scoutName || "",
        badge: r.badge || "",
        date: dateStr,
        troop,
        council,
        signature,
      }, { helv, script });
    }
  }

  return await pdf.save();
}

// Compute the total sheets produced for a given row count (used by the UI to
// build the "N cards on M sheets" button label). Exported so app.js can call
// it without re-implementing the CARDS_PER_SHEET math.
export function pocketCertSheetCount(rowCount) {
  if (!rowCount) return 0;
  return Math.ceil(rowCount / CARDS_PER_SHEET);
}

export const POCKET_CARDS_PER_SHEET = CARDS_PER_SHEET;

/**
 * Draw one filled certificate at the given card rect using the fixed
 * measured baselines from POCKET_CARD_LAYOUT. No stroke operations
 * are issued — cut-guide borders were removed in v1.3.2.
 *
 * `rect.y` is the card's bottom edge in pdf-lib bottom-up coordinates
 * (rect.y + rect.height = card top edge).
 */
function drawCard(page, rect, data, fonts) {
  const { x, y, width, height } = rect;
  const { helv, script } = fonts;
  const cardTop = y + height; // bottom-up top edge

  // Convert a "target yBot from card top" (as measured in the reference
  // render) to a pdf-lib baseline y-coordinate by subtracting the font
  // descent for the given size.
  const baselineY = (yBotTop, size) => cardTop - (yBotTop - HELVETICA_DESCENT_RATIO * size);

  const drawCentered = (text, size, font, yBotTop) => {
    if (!text) return;
    const t = String(text);
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, {
      x: x + (width - w) / 2,
      y: baselineY(yBotTop, size),
      size,
      font,
    });
  };
  const drawLeftAt = (text, size, font, yBotTop, leftOffset) => {
    if (!text) return;
    page.drawText(String(text), {
      x: x + leftOffset,
      y: baselineY(yBotTop, size),
      size,
      font,
    });
  };
  const drawRightAt = (text, size, font, yBotTop, rightOffset) => {
    if (!text) return;
    const t = String(text);
    const w = font.widthOfTextAtSize(t, size);
    page.drawText(t, {
      x: x + rightOffset - w,
      y: baselineY(yBotTop, size),
      size,
      font,
    });
  };

  const L = POCKET_CARD_LAYOUT;
  // Scout name (12pt, centered).
  drawCentered(data.scoutName, SIZE_SCOUT, helv, L.scoutNameTop);
  // Merit badge (10pt, centered).
  drawCentered(data.badge, SIZE_BADGE, helv, L.badgeTop);
  // Date (left-aligned at 0.5" from card left) + Troop (right-aligned to
  // 0.25" from card right) on the same baseline.
  drawLeftAt(data.date, SIZE_DATE_UNIT, helv, L.dateUnitTop, L.dateLeft);
  drawRightAt(data.troop, SIZE_DATE_UNIT, helv, L.dateUnitTop, L.rightEdge);
  // Council (right-aligned).
  drawRightAt(data.council, SIZE_COUNCIL, helv, L.councilTop, L.rightEdge);
  // Signature (script font, right-aligned, last line).
  drawRightAt(data.signature, SIZE_SIGNATURE, script, L.signatureTop, L.rightEdge);
}
