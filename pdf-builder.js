// pdf-builder.js — builds the source (portrait half-letter) and imposed
// (landscape US Letter, saddle-stitch) PDFs with pdf-lib. Dependency-injected
// so it runs in-browser (CDN pdf-lib) and in Node (`npm i pdf-lib`).
//
// Public API:
//   buildSourcePDF(model, pdfLib, opts) -> Promise<Uint8Array>
//   buildBookletPDF(sourceBytes, pdfLib) -> Promise<Uint8Array>
//
// `model` shape:
//   {
//     event: { date, time, venue, mcName, scoutmasterMinute, troopLabels: string[] },
//     roster: { rankSections, mbSections, troopLabels } (from data.js buildRoster),
//     agenda: Array<{ item, presenter, presenterGrey?: bool }>,
//                                          // presenterGrey==true renders the
//                                          // presenter run in grey (used for
//                                          // the "(MC name here)" placeholder
//                                          // when the MC field is blank).
//     optionals: Array<{ key, item }>,     // included optional sections to render as pages
//     fleurBytes: Uint8Array | null,
//     coverTitle: string,      // e.g. "Court of Honor"
//     org: string,             // e.g. "Mid-Iowa Council · BSA"
//   }

const PT_PER_IN = 72;

// Page geometry constants
const HALF_LETTER = { w: 5.5 * PT_PER_IN, h: 8.5 * PT_PER_IN }; // portrait
const LETTER_LAND = { w: 11 * PT_PER_IN, h: 8.5 * PT_PER_IN };
const MARGIN = 0.5 * PT_PER_IN;
const CONTENT_W = HALF_LETTER.w - 2 * MARGIN;

// Type scale
const H1 = 20, H2 = 14, H3 = 11, BODY = 10;
const LEADING = (size) => size * 1.25;

// ---------- Layout engine ----------

class PageWriter {
  constructor(pdf, fonts) {
    this.pdf = pdf;
    this.fonts = fonts; // { regular, bold }
    this.pages = [];
    this._newPage();
  }
  _newPage() {
    const page = this.pdf.addPage([HALF_LETTER.w, HALF_LETTER.h]);
    this.pages.push(page);
    this.page = page;
    this.y = HALF_LETTER.h - MARGIN;
  }
  // Force a page break at the current point.
  pageBreak() { this._newPage(); }
  // Ensure at least `needed` points remain; otherwise start new page.
  ensure(needed) {
    if (this.y - needed < MARGIN) this._newPage();
  }
  // Move the cursor without drawing.
  space(pts) {
    this.y -= pts;
    if (this.y < MARGIN) this._newPage();
  }
  // Draw a heading centered on the page.
  drawHeadingCentered(text, size = H1, extraSpace = 8) {
    const lead = LEADING(size);
    this.ensure(lead + extraSpace);
    const font = this.fonts.bold;
    const w = font.widthOfTextAtSize(text, size);
    this.page.drawText(text, {
      x: (HALF_LETTER.w - w) / 2,
      y: this.y - size,
      size,
      font,
    });
    this.y -= lead + extraSpace;
  }
  // Wrap and draw a paragraph. Supports {bold: boolean, size, indent, align}.
  drawParagraph(text, opts = {}) {
    const size = opts.size || BODY;
    const font = opts.bold ? this.fonts.bold : this.fonts.regular;
    const indent = opts.indent || 0;
    const align = opts.align || "left";
    const width = CONTENT_W - indent;
    const words = String(text).split(/\s+/);
    const lines = [];
    let cur = "";
    for (const w of words) {
      const trial = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(trial, size) <= width) cur = trial;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    const lead = LEADING(size);
    for (const line of lines) {
      this.ensure(lead);
      let x = MARGIN + indent;
      if (align === "center") {
        const w = font.widthOfTextAtSize(line, size);
        x = (HALF_LETTER.w - w) / 2;
      }
      this.page.drawText(line, { x, y: this.y - size, size, font });
      this.y -= lead;
    }
    if (opts.spaceAfter) this.space(opts.spaceAfter);
  }
  // Draw a paragraph consisting of runs: [{text, bold, color?}]. No inter-run wrapping.
  drawRuns(runs, opts = {}) {
    const size = opts.size || BODY;
    const indent = opts.indent || 0;
    const width = CONTENT_W - indent;
    const lead = LEADING(size);
    // Flatten runs into a list of tokens with formatting.
    const tokens = [];
    for (const run of runs) {
      const font = run.bold ? this.fonts.bold : this.fonts.regular;
      const parts = String(run.text).split(/(\s+)/);
      for (const p of parts) if (p.length) tokens.push({ text: p, font, size, color: run.color || null, isSpace: /^\s+$/.test(p) });
    }
    // Greedy line-wrap on tokens.
    const lines = [];
    let line = [];
    let lineWidth = 0;
    for (const tok of tokens) {
      const w = tok.font.widthOfTextAtSize(tok.text, tok.size);
      if (lineWidth + w > width && line.length > 0 && !(line.length === 0 && tok.isSpace)) {
        // Trim trailing whitespace from line
        while (line.length && line[line.length - 1].isSpace) line.pop();
        lines.push(line);
        line = [];
        lineWidth = 0;
        if (tok.isSpace) continue;
      }
      line.push(tok);
      lineWidth += w;
    }
    while (line.length && line[line.length - 1].isSpace) line.pop();
    if (line.length) lines.push(line);
    for (const ln of lines) {
      this.ensure(lead);
      let x = MARGIN + indent;
      for (const tok of ln) {
        const drawOpts = { x, y: this.y - tok.size, size: tok.size, font: tok.font };
        if (tok.color) drawOpts.color = tok.color;
        this.page.drawText(tok.text, drawOpts);
        x += tok.font.widthOfTextAtSize(tok.text, tok.size);
      }
      this.y -= lead;
    }
    if (opts.spaceAfter) this.space(opts.spaceAfter);
  }
  drawBullet(text, opts = {}) {
    const size = opts.size || BODY;
    const font = this.fonts.regular;
    const lead = LEADING(size);
    this.ensure(lead);
    const bulletIndent = 12;
    const textX = MARGIN + bulletIndent + 8;
    this.page.drawText("•", { x: MARGIN + bulletIndent, y: this.y - size, size, font: this.fonts.bold });
    // Wrap the text like drawParagraph but at textX.
    const width = HALF_LETTER.w - MARGIN - textX;
    const words = String(text).split(/\s+/);
    let cur = "";
    const lines = [];
    for (const w of words) {
      const trial = cur ? cur + " " + w : w;
      if (font.widthOfTextAtSize(trial, size) <= width) cur = trial;
      else { if (cur) lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) { this.y -= lead; this.ensure(lead); }
      this.page.drawText(lines[i], { x: textX, y: this.y - size, size, font });
    }
    this.y -= lead;
    if (opts.spaceAfter) this.space(opts.spaceAfter);
  }
}

// ---------- Source PDF ----------

export async function buildSourcePDF(model, pdfLib) {
  const { PDFDocument, StandardFonts, rgb } = pdfLib;
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const w = new PageWriter(pdf, { regular, bold });

  // ---- COVER ----
  w.space(60);
  const troopLine = (model.event.troopLabels || []).filter(Boolean).join("  &  ") || "Scout Troop";
  w.drawParagraph(troopLine, { align: "center", bold: true, size: 18, spaceAfter: 6 });
  w.drawParagraph(model.org || "Mid-Iowa Council · BSA", { align: "center", size: 11, spaceAfter: 18 });
  if (model.fleurBytes && model.fleurBytes.length) {
    try {
      const img = await pdf.embedJpg(model.fleurBytes);
      const targetW = 2 * PT_PER_IN;
      const scale = targetW / img.width;
      const targetH = img.height * scale;
      w.ensure(targetH + 12);
      w.page.drawImage(img, {
        x: (HALF_LETTER.w - targetW) / 2,
        y: w.y - targetH,
        width: targetW,
        height: targetH,
      });
      w.y -= targetH + 18;
    } catch (_) { /* skip on decode error */ }
  }
  w.drawParagraph(model.coverTitle || "Court of Honor", { align: "center", bold: true, size: 28, spaceAfter: 24 });
  if (model.event.date) w.drawParagraph(model.event.date, { align: "center", size: 14, spaceAfter: 6 });
  if (model.event.time) w.drawParagraph(model.event.time, { align: "center", size: 12, spaceAfter: 24 });
  if (model.event.venue) {
    for (const line of String(model.event.venue).split(/\r?\n/))
      w.drawParagraph(line, { align: "center", size: 12, spaceAfter: 2 });
  }
  w.pageBreak();

  // ---- AGENDA ----
  w.drawHeadingCentered("Program", H1, 12);
  const PLACEHOLDER_GREY = rgb(0.55, 0.55, 0.55);
  for (const item of (model.agenda || [])) {
    const runs = [{ text: item.item || "", bold: true }];
    if (item.presenter) {
      const run = { text: "  —  " + item.presenter, bold: false };
      if (item.presenterGrey) run.color = PLACEHOLDER_GREY;
      runs.push(run);
    }
    w.drawRuns(runs, { size: BODY, spaceAfter: 4 });
  }
  w.pageBreak();

  // ---- RANK ADVANCEMENT ----
  if (model.roster.rankSections.length) {
    w.drawHeadingCentered("Rank Advancement", H1, 10);
    for (const section of model.roster.rankSections) {
      if (section.troopLabel) w.drawParagraph(section.troopLabel, { bold: true, size: H2, spaceAfter: 4 });
      for (const group of section.groups) {
        w.ensure(LEADING(H3) + LEADING(BODY));
        w.drawParagraph(group.heading, { bold: true, size: H3, spaceAfter: 2 });
        for (const s of group.scouts) w.drawBullet(`${s.first} ${s.last}`, { size: BODY });
        w.space(4);
      }
    }
    w.pageBreak();
  }

  // ---- MERIT BADGES ----
  if (model.roster.mbSections.length) {
    w.drawHeadingCentered("Merit Badges", H1, 10);
    for (const section of model.roster.mbSections) {
      if (section.troopLabel) w.drawParagraph(section.troopLabel, { bold: true, size: H2, spaceAfter: 4 });
      for (const line of section.lines) {
        const runs = [
          { text: `${line.first} ${line.last}`, bold: true },
          { text: " — " + line.items.join(", "), bold: false },
        ];
        w.drawRuns(runs, { size: BODY, indent: 6, spaceAfter: 2 });
      }
    }
    w.pageBreak();
  }

  // ---- Optional sections ----
  // Optional agenda items (Guest Speakers, Additional Recognition, etc.) are
  // NOT rendered as their own booklet pages — they already appear as line
  // items on the "Program" agenda page above. model.optionals is retained
  // in the model for potential future use but intentionally not iterated.

  // ---- Scout Oath & Law ----
  w.drawHeadingCentered("Scout Oath", H1, 10);
  for (const line of [
    "On my honor I will do my best",
    "to do my duty to God and my country",
    "and to obey the Scout Law;",
    "to help other people at all times;",
    "to keep myself physically strong,",
    "mentally awake, and morally straight.",
  ]) w.drawParagraph(line, { align: "center", size: 12, spaceAfter: 2 });
  w.space(24);
  w.drawHeadingCentered("Scout Law", H1, 10);
  for (const line of [
    "A Scout is trustworthy, loyal, helpful, friendly,",
    "courteous, kind, obedient, cheerful, thrifty,",
    "brave, clean, and reverent.",
  ]) w.drawParagraph(line, { align: "center", size: 12, spaceAfter: 2 });
  w.pageBreak();

  // ---- Acknowledgments ----
  w.drawHeadingCentered("Acknowledgments", H1, 12);
  w.drawParagraph("With gratitude to:", { size: 11, spaceAfter: 6 });
  const troops = (model.event.troopLabels || []).filter(Boolean);
  const troopsPhrase = troops.length ? troops.join(" and ") : "our troops";
  const ackLines = [
    "Our chartered organization and meeting home",
    "Mid-Iowa Council, Boy Scouts of America",
    `The Scoutmasters, Assistant Scoutmasters, and Committee members of ${troopsPhrase}`,
    "Merit badge counselors who make advancement possible",
    "Parents and families whose support drives every Scout's journey",
    "Every Scout — for your effort, leadership, and Scout Spirit",
  ];
  for (const line of ackLines) w.drawBullet(line, { size: BODY, spaceAfter: 3 });
  w.space(18);
  w.drawParagraph("Congratulations to all Scouts recognized tonight!", {
    align: "center", bold: true, size: 12,
  });

  return await pdf.save();
}

// ---------- Booklet imposition ----------
//
// Given N portrait pages (pad to multiple of 4 with blanks), lay them out
// two-up on landscape US Letter, in the standard saddle-stitch order so that
// printing duplex short-edge and folding in half yields a proper booklet.
//
// For a booklet of N pages (multiple of 4), sheet s (1-indexed, s=1..N/4)
// carries these source pages:
//   sheet s front: [left = N - 2(s-1)] [right = 2s - 1]
//   sheet s back : [left = 2s]         [right = N - 2s + 1]
// Output pages are emitted front, back, front, back… so a duplex short-edge
// print produces s sheets that fold correctly.

export async function buildBookletPDF(sourceBytes, pdfLib) {
  const { PDFDocument, rgb } = pdfLib;
  const src = await PDFDocument.load(sourceBytes);
  const N = ((src.getPageCount() + 3) >> 2) << 2; // round up to multiple of 4
  const padded = await PDFDocument.create();
  // Copy source pages, add blanks to pad.
  const srcCount = src.getPageCount();
  const srcSize = src.getPage(0).getSize();
  const copied = await padded.copyPages(src, src.getPageIndices());
  for (const p of copied) padded.addPage(p);
  for (let i = srcCount; i < N; i++) {
    const blank = padded.addPage([srcSize.width, srcSize.height]);
    // Force a Contents stream so pdf-lib can embed this page (blank pages
    // otherwise have no Contents and embedPages() rejects them).
    blank.drawRectangle({ x: 0, y: 0, width: 0.01, height: 0.01, opacity: 0 });
  }

  const out = await PDFDocument.create();
  // Embed all padded pages so we can place them on landscape sheets.
  const embedded = await out.embedPages(padded.getPages());

  const sheetW = LETTER_LAND.w;
  const sheetH = LETTER_LAND.h;
  const halfW = sheetW / 2;
  const srcW = HALF_LETTER.w;
  const srcH = HALF_LETTER.h;
  // Fit each source page into a half-sheet.
  const scale = Math.min(halfW / srcW, sheetH / srcH);
  const drawW = srcW * scale;
  const drawH = srcH * scale;
  const y = (sheetH - drawH) / 2;

  // 1/4" (18pt) thin grey border inset on each half-sheet. This survives all
  // printer non-printable margins and gives a clean visual frame after fold.
  const BORDER_INSET = 18;
  const BORDER_STROKE = 0.5;
  const BORDER_GREY = rgb(0.65, 0.65, 0.65);
  const drawBorder = (page, offsetX) => {
    page.drawRectangle({
      x: offsetX + BORDER_INSET,
      y: BORDER_INSET,
      width: halfW - 2 * BORDER_INSET,
      height: sheetH - 2 * BORDER_INSET,
      borderColor: BORDER_GREY,
      borderWidth: BORDER_STROKE,
    });
  };

  const nSheets = N / 4;
  // No rotation: every source page is placed upright on the landscape sheet
  // so it displays right-side up in a PDF viewer. Print duplex long-edge
  // (the printer default) and fold each sheet in half along the vertical
  // center to produce a correctly ordered saddle-stitched booklet.
  const place = (page, embedIdx, x) => {
    page.drawPage(embedded[embedIdx], { x, y, width: drawW, height: drawH });
  };
  for (let s = 1; s <= nSheets; s++) {
    // FRONT of sheet s: left = N - 2(s-1), right = 2s - 1
    const frontLeftIdx = (N - 2 * (s - 1)) - 1;
    const frontRightIdx = (2 * s - 1) - 1;
    const front = out.addPage([sheetW, sheetH]);
    place(front, frontLeftIdx, 0);
    place(front, frontRightIdx, halfW);
    drawBorder(front, 0);
    drawBorder(front, halfW);
    // BACK of sheet s: left = 2s, right = N - 2s + 1
    const backLeftIdx = (2 * s) - 1;
    const backRightIdx = (N - 2 * s + 1) - 1;
    const back = out.addPage([sheetW, sheetH]);
    place(back, backLeftIdx, 0);
    place(back, backRightIdx, halfW);
    drawBorder(back, 0);
    drawBorder(back, halfW);
  }

  return await out.save();
}

// Export geometry for the UI preview.
export const GEOMETRY = { HALF_LETTER, LETTER_LAND, MARGIN, PT_PER_IN };
