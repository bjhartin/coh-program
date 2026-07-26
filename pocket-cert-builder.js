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
// Ported from scripts/generate_mb_pocket_certificates.py (HTML/CSS version).
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

// Card interior padding (golden-ratio-ish, matches pocket-cert-page.html).
const PAD_TOP = 0.618 * PT_PER_IN;
const PAD_BOTTOM = 0.382 * PT_PER_IN;
const PAD_X = 0.25 * PT_PER_IN;

// Type sizes (pt).
const SIZE_SCOUT = 12;
const SIZE_BADGE = 10;
const SIZE_DATE_UNIT = 11;
const SIZE_COUNCIL = 11;
const SIZE_SIGNATURE = 11;

// Vertical rhythm between card lines (approximates the HTML template).
const GAP_BADGE_TO_DATE = 0.43125 * PT_PER_IN; // 31 pt
const GAP_LINE_TO_LINE = 0.10 * PT_PER_IN;     // 7.2 pt
const GAP_SIGNATURE_TOP = 0.1125 * PT_PER_IN;  // 8.1 pt

// Cut-guide border (matches the CSS `border: 1px dashed #ccc` from the
// HTML template — kept solid + light so it survives printer thresholding).
const CUT_STROKE = 0.25;
function cutGrey(rgb) { return rgb(0.8, 0.8, 0.8); }

/**
 * Build the pocket certificates PDF for a set of merit-badge rows.
 *
 * `rows` is expected to be pre-sorted (e.g. by extractMeritBadgeRows()).
 * Empty slots on the final sheet are drawn as blank framed cards so the
 * cut-guide grid is complete for the entire printed sheet.
 */
export async function buildPocketCertsPDF(rows, opts, pdfLib) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const pdf = await PDFDocument.create();
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  // Pragmatic v1: use Helvetica-Oblique for the signature. pdf-lib's
  // built-ins don't ship a script/cursive face; substituting a script
  // font from a CDN is possible but adds a network dep. See README.
  const script = await pdf.embedFont(StandardFonts.HelveticaOblique);

  const cutColor = cutGrey(rgb);
  const defaultDate = String(opts.defaultDate || "").trim();
  const troop = String(opts.troop || "").trim();
  const council = String(opts.council || "").trim();
  const signature = String(opts.signature || "").trim();

  const totalSheets = Math.max(1, Math.ceil(rows.length / CARDS_PER_SHEET));
  for (let s = 0; s < totalSheets; s++) {
    const page = pdf.addPage([SHEET_W, SHEET_H]);
    for (let i = 0; i < CARDS_PER_SHEET; i++) {
      const col = i % CARDS_PER_ROW;
      const row = Math.floor(i / CARDS_PER_ROW);
      // PDF y-axis is bottom-up; the top row of cards should be visually
      // at the top of the printed sheet.
      const x = col * CARD_W;
      const y = SHEET_H - (row + 1) * CARD_H;
      // Cut-guide border (drawn on every slot, filled or not).
      page.drawRectangle({
        x, y, width: CARD_W, height: CARD_H,
        borderColor: cutColor,
        borderWidth: CUT_STROKE,
      });
      const rowIdx = s * CARDS_PER_SHEET + i;
      if (rowIdx >= rows.length) continue; // leave slot blank (still has border)
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

// Draw one filled certificate at the given card rect. Text roughly matches
// the HTML template's `flex-direction: column; justify-content: center;`
// layout — we hand-place vertical positions to mirror the CSS margins.
function drawCard(page, rect, data, fonts) {
  const { x, y, width, height } = rect;
  const { helv, script } = fonts;
  const innerLeft = x + PAD_X;
  const innerRight = x + width - PAD_X;
  const innerTop = y + height - PAD_TOP;

  const drawCentered = (text, size, font, baselineY) => {
    if (!text) return;
    const w = font.widthOfTextAtSize(String(text), size);
    page.drawText(String(text), {
      x: x + (width - w) / 2,
      y: baselineY,
      size,
      font,
    });
  };
  const drawLeft = (text, size, font, baselineY) => {
    if (!text) return;
    page.drawText(String(text), { x: innerLeft, y: baselineY, size, font });
  };
  const drawRight = (text, size, font, baselineY) => {
    if (!text) return;
    const w = font.widthOfTextAtSize(String(text), size);
    page.drawText(String(text), { x: innerRight - w, y: baselineY, size, font });
  };

  // Scout name (12pt, centered near top).
  let cursorY = innerTop - SIZE_SCOUT;
  drawCentered(data.scoutName, SIZE_SCOUT, helv, cursorY);

  // Merit badge (10pt, centered slightly below).
  cursorY -= (SIZE_SCOUT * 0.6 + SIZE_BADGE); // small gap between name and badge
  drawCentered(data.badge, SIZE_BADGE, helv, cursorY);

  // Blank space then date + troop on the same baseline (space-between).
  cursorY -= GAP_BADGE_TO_DATE + SIZE_DATE_UNIT;
  drawLeft(data.date, SIZE_DATE_UNIT, helv, cursorY);
  drawRight(data.troop, SIZE_DATE_UNIT, helv, cursorY);

  // Council right-aligned below.
  cursorY -= GAP_LINE_TO_LINE + SIZE_COUNCIL;
  drawRight(data.council, SIZE_COUNCIL, helv, cursorY);

  // Signature (script/oblique), right-aligned last line.
  cursorY -= GAP_SIGNATURE_TOP + SIZE_SIGNATURE;
  // Don't drop below the bottom padding; if the layout somehow overflowed
  // the card, clamp to the bottom padding line.
  const minY = y + PAD_BOTTOM;
  if (cursorY < minY) cursorY = minY;
  drawRight(data.signature, SIZE_SIGNATURE, script, cursorY);
}
