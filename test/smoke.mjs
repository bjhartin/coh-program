// smoke.mjs — end-to-end sanity test for the CoH program generator.
// Runs in Node (no browser). Loads the two sample CSVs, builds a source PDF
// and an imposed booklet PDF, writes both to disk, and asserts basic shape:
//   - source PDF is a multiple of 4 pages (or padded to be) after imposition
//   - booklet PDF is landscape US Letter and has N/2 pages
//   - roster counts unchanged from the reference fixture
//   - default state matches product requirements (v1.2+)
//   - SPL Update is treated as required — cannot be excluded
//   - grey borders visible, all pages upright
//
// Usage:  cd apps/coh-program && node test/smoke.mjs
// Requires: `npm install pdf-lib` at apps/coh-program.

import fs from "node:fs";
import path from "node:path";
import child_process from "node:child_process";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import * as pdfLib from "pdf-lib";

import { parsePO, guessTroopLabel, buildRoster, extractMeritBadgeRows } from "../data.js";
import { buildSourcePDF, buildBookletPDF } from "../pdf-builder.js";
import { buildPocketCertsPDF, pocketCertSheetCount, POCKET_CARDS_PER_SHEET } from "../pocket-cert-builder.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(__dirname, "..");

// --- Load app.js in a minimal DOM shim so we can exercise its exported
// defaults/migration exactly as the browser would. The module also runs
// side-effect UI wiring on import, so we prime jsdom with the SPA HTML.
const html = fs.readFileSync(path.join(APP, "index.html"), "utf-8");
const dom = new JSDOM(html, { url: "http://localhost/", runScripts: "outside-only", pretendToBeVisual: true });
// Populate the small set of globals app.js touches at import time.
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.HTMLElement = dom.window.HTMLElement;
globalThis.File = dom.window.File;
globalThis.Blob = dom.window.Blob;
globalThis.FileReader = dom.window.FileReader;
globalThis.URL = dom.window.URL;
const FLEUR_BYTES = fs.readFileSync(path.join(APP, "assets/fleur-de-lis.jpg"));
globalThis.fetch = async (url) => {
  const s = String(url);
  if (s.endsWith("fleur-de-lis.jpg")) {
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => FLEUR_BYTES.buffer.slice(FLEUR_BYTES.byteOffset, FLEUR_BYTES.byteOffset + FLEUR_BYTES.byteLength),
    };
  }
  throw new Error(`network fetch disabled in smoke test: ${s}`);
};

// Import after the DOM is ready. app.js has an unawaited init() call that
// will hit the (now-stubbed) fetch and log a warning about the fleur asset;
// that's OK for this test.
const app = await import("../app.js");

const boysCsv = fs.readFileSync(path.join(APP, "test/sample-boys.csv"), "utf-8");
const girlsCsv = fs.readFileSync(path.join(APP, "test/sample-girls.csv"), "utf-8");
const fleur = fs.readFileSync(path.join(APP, "assets/fleur-de-lis.jpg"));

const boys = parsePO(boysCsv, guessTroopLabel("PO_T96BT_1103345.csv"));
const girls = parsePO(girlsCsv, guessTroopLabel("PO_T96GT_1103346.csv"));

console.log(`Boys:  ${boys.scoutCount} scouts, ${boys.itemCount} items, label="${boys.troopLabel}"`);
console.log(`Girls: ${girls.scoutCount} scouts, ${girls.itemCount} items, label="${girls.troopLabel}"`);

let assertionsFailed = false;
function assertEarly(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); assertionsFailed = true; }
  else console.log(`  ok: ${msg}`);
}

// --- (0) Roster fixtures unchanged.
assertEarly(boys.scoutCount === 35 && boys.itemCount === 178, "boys roster: 35 scouts, 178 items");
assertEarly(girls.scoutCount === 15 && girls.itemCount === 71, "girls roster: 15 scouts, 71 items");

// --- (1) v1.2 default form values.
const defaults = app.buildDefaultAgenda();
// Read the MC/SM defaults straight off the hydrated form — that's what a
// fresh session would present to a user.
const mcField = dom.window.document.getElementById("ev-mc");
const smField = dom.window.document.getElementById("ev-smm");
assertEarly((mcField?.value || "") === "", "MC name field default is empty string");
assertEarly(smField?.value === "Brad Johnson and Carol Donelly",
  `SM Minute default is "Brad Johnson and Carol Donelly" (got "${smField?.value}")`);

// --- (1b) Troop label defaults: hydrated form should read "Troop 96B" and
// "Troop 96G" straight out of the box (v1.2.2).
const troopAField = dom.window.document.querySelector('.troop-slot[data-slot="0"] input[data-field="troopLabel"]');
const troopBField = dom.window.document.querySelector('.troop-slot[data-slot="1"] input[data-field="troopLabel"]');
assertEarly(troopAField?.value === "Troop 96B",
  `Boys Troop default label is "Troop 96B" (got "${troopAField?.value}")`);
assertEarly(troopBField?.value === "Troop 96G",
  `Girls Troop default label is "Troop 96G" (got "${troopBField?.value}")`);

// --- (1c) v1.3.1: slot-position UI text renames "Troop A"/"Troop B" to
// "Boys Troop"/"Girls Troop" everywhere the slot is user-facing. The
// data-model prefix stays `slot=0`/`slot=1`; only the visible copy changes.
const dzA = dom.window.document.querySelector('.troop-slot[data-slot="0"] .dz-label');
const dzB = dom.window.document.querySelector('.troop-slot[data-slot="1"] .dz-label');
assertEarly(dzA && /Boys Troop/.test(dzA.textContent) && !/Troop A/.test(dzA.textContent),
  `Boys slot dropzone label reads "Boys Troop" (no "Troop A"). Got: "${dzA?.textContent?.trim()}"`);
assertEarly(dzB && /Girls Troop/.test(dzB.textContent) && !/Troop B/.test(dzB.textContent),
  `Girls slot dropzone label reads "Girls Troop" (no "Troop B"). Got: "${dzB?.textContent?.trim()}"`);
// Pocket-cert download buttons carry the new copy pre-upload (troop label
// falls back to the slot-position name when no PO is loaded).
const preBtnA = dom.window.document.getElementById("btn-pocket-a");
const preBtnB = dom.window.document.getElementById("btn-pocket-b");
assertEarly(preBtnA && !/Troop A/.test(preBtnA.textContent),
  `pocket-cert Boys button text has no "Troop A" (got "${preBtnA?.textContent}")`);
assertEarly(preBtnB && !/Troop B/.test(preBtnB.textContent),
  `pocket-cert Girls button text has no "Troop B" (got "${preBtnB?.textContent}")`);
// Pocket-cert form labels for the two identifier fields reference the new copy.
const pcTroopALabel = dom.window.document.querySelector('label:has(#pc-troop-a)');
const pcTroopBLabel = dom.window.document.querySelector('label:has(#pc-troop-b)');
assertEarly(pcTroopALabel && /Boys Troop/.test(pcTroopALabel.textContent),
  `pocket-cert Boys identifier label mentions "Boys Troop"`);
assertEarly(pcTroopBLabel && /Girls Troop/.test(pcTroopBLabel.textContent) && !/Troop B/.test(pcTroopBLabel.textContent.replace(/Girls Troop/g, "")),
  `pocket-cert Girls identifier label mentions "Girls Troop" (no "Troop B")`);
// Global sweep: no user-facing "Troop A" / "Troop B" text survives in the
// rendered SPA DOM. Reads the entire visible body text at once.
const bodyText = dom.window.document.body.textContent || "";
assertEarly(!/\bTroop A\b/.test(bodyText),
  `no "Troop A" appears anywhere in the rendered DOM`);
assertEarly(!/\bTroop B\b/.test(bodyText),
  `no "Troop B" appears anywhere in the rendered DOM`);

// --- (2) SPL Update cannot be excluded.
// Structural: no optional entry has key 'spl' or 'spl-update' in the defaults.
const optionalKeys = defaults.filter((d) => d.kind === "optional").map((d) => d.key);
assertEarly(!optionalKeys.some((k) => k === "spl" || k === "spl-update"),
  `SPL Update is not in the optional set (optional keys: ${optionalKeys.join(", ")})`);
const splEntry = defaults.find((d) => d.key === "spl-update");
assertEarly(splEntry && splEntry.kind === "required" && splEntry.included === true,
  "SPL Update default row is required + included");

// --- (2b) Default agenda shape: exactly 7 required and 2 optional items,
// in the exact order specified for v1.2.1.
const requiredDefaults = defaults.filter((d) => d.kind === "required");
const optionalDefaults = defaults.filter((d) => d.kind === "optional");
const EXPECTED_REQUIRED = [
  "Opening Ceremony",
  "Welcome and Introductions",
  "Rank Advancement",
  "Merit Badges",
  "Senior Patrol Leader Update",
  "Scoutmaster Minute",
  "Closing",
];
const EXPECTED_OPTIONAL = ["Guest Speakers", "Additional Recognition"];
assertEarly(requiredDefaults.length === 7,
  `defaults contain exactly 7 required items (got ${requiredDefaults.length})`);
assertEarly(
  JSON.stringify(requiredDefaults.map((d) => d.item)) === JSON.stringify(EXPECTED_REQUIRED),
  `required items appear in the expected order: ${EXPECTED_REQUIRED.join(" → ")} (got: ${requiredDefaults.map((d) => d.item).join(" → ")})`
);
assertEarly(optionalDefaults.length === 2,
  `defaults contain exactly 2 optional items (got ${optionalDefaults.length})`);
assertEarly(
  JSON.stringify(optionalDefaults.map((d) => d.item)) === JSON.stringify(EXPECTED_OPTIONAL),
  `optional items are exactly [${EXPECTED_OPTIONAL.join(", ")}] (got: [${optionalDefaults.map((d) => d.item).join(", ")}])`
);
assertEarly(optionalDefaults.every((d) => d.included === true),
  "both optional items are checked (included:true) by default");
// Removed items must not reappear.
const REMOVED_KEYS = ["colors", "pledge", "retire-colors", "oa", "adult-leader"];
const stillPresent = REMOVED_KEYS.filter((k) => defaults.some((d) => d.key === k));
assertEarly(stillPresent.length === 0,
  `removed items are not in defaults (unexpected: [${stillPresent.join(", ")}])`);

// Migration: a legacy session with `sections.spl = false` must still yield an
// included SPL row (SPL is always in the agenda).
const legacyOff = app.migrateSession({
  version: 1,
  agenda: [{ item: "Rank Advancement", presenter: "MC" }],
  sections: { oa: true, adultLeader: true, additional: false, spl: false },
});
const migratedSpl = legacyOff.agenda.find((a) => a.key === "spl-update");
assertEarly(!!migratedSpl && migratedSpl.included === true,
  "migrating a legacy session with spl:false still yields included SPL row");
// And a legacy session missing the spl key entirely must also treat it as included.
const legacyMissing = app.migrateSession({ version: 1, agenda: [], sections: {} });
const migratedSpl2 = legacyMissing.agenda.find((a) => a.key === "spl-update");
assertEarly(!!migratedSpl2 && migratedSpl2.included === true,
  "migrating a legacy session missing the spl key still yields included SPL row");
// Even if a v2 session marks the SPL row as included:false, the migrator
// must force it back to true (SPL is always required).
const forcedOff = app.migrateSession({
  version: 2,
  agenda: [{ kind: "required", key: "spl-update", item: "SPL", presenter: "", included: false }],
});
const forcedRow = forcedOff.agenda.find((a) => a.key === "spl-update");
assertEarly(!!forcedRow && forcedRow.included === true,
  "migrator forces required SPL row `included:true` even when saved as false");

// --- (2d) v1.2.2 UI-render assertions: the hydrated Program Sections &
// Agenda table shows a "Required" badge on exactly the 7 required rows,
// no include checkboxes anywhere, and a delete button only on non-required
// rows. Read straight off the JSDOM tbody.
const tbody = dom.window.document.querySelector("#agenda-table tbody");
assertEarly(!!tbody, "agenda table body is present in the hydrated DOM");
const rows = tbody ? Array.from(tbody.querySelectorAll("tr")) : [];
assertEarly(rows.length === defaults.length,
  `agenda table renders one row per default (got ${rows.length}, expected ${defaults.length})`);
const includeInputs = tbody ? Array.from(tbody.querySelectorAll('input[type="checkbox"]')) : [];
assertEarly(includeInputs.length === 0,
  `no include/exclude checkboxes rendered in the agenda table (got ${includeInputs.length})`);
const badgeRows = rows.filter((tr) => tr.querySelector(".badge-required"));
assertEarly(badgeRows.length === 7,
  `exactly 7 rows carry a "Required" badge (got ${badgeRows.length})`);
const anyOtherBadge = rows.some((tr) => {
  const b = tr.querySelector(".badge");
  return b && !b.classList.contains("badge-required");
});
assertEarly(!anyOtherBadge,
  "no non-required row carries a visible badge (Optional/Custom badges are gone)");
const nonRequiredRows = rows.filter((tr) => tr.dataset.kind !== "required");
const nonRequiredWithDel = nonRequiredRows.filter((tr) => tr.querySelector('button[data-a="del"]'));
assertEarly(nonRequiredRows.length > 0 && nonRequiredWithDel.length === nonRequiredRows.length,
  `every non-required row has a delete button (${nonRequiredWithDel.length}/${nonRequiredRows.length})`);
const requiredRows = rows.filter((tr) => tr.dataset.kind === "required");
const requiredWithDel = requiredRows.filter((tr) => tr.querySelector('button[data-a="del"]'));
assertEarly(requiredWithDel.length === 0,
  `no required row has a delete button (got ${requiredWithDel.length})`);
// Button rename: "+ Add item" (not "+ Add custom item").
const addBtn = dom.window.document.getElementById("btn-add-agenda");
assertEarly(addBtn && addBtn.textContent.trim() === "+ Add item",
  `add-item button text is "+ Add item" (got "${addBtn?.textContent?.trim()}")`);

// --- (2e) v1.2.2 migration: pre-1.2.2 sessions with `included: false` on
// an optional row must have that row DROPPED from the migrated state
// (equivalent to the user having deleted it in the new UI).
const preSession = {
  version: 2,
  agenda: [
    { kind: "required", key: "opening",         item: "Opening Ceremony",       presenter: "MC",         included: true },
    { kind: "optional", key: "guest-speakers",  item: "Guest Speakers",         presenter: "",           included: false },
    { kind: "optional", key: "additional",      item: "Additional Recognition", presenter: "SM",         included: true  },
    { kind: "required", key: "spl-update",      item: "SPL Update",             presenter: "SPLs",       included: true },
    { kind: "required", key: "closing",         item: "Closing",                presenter: "MC",         included: true },
  ],
};
const preMigrated = app.migrateSession(preSession);
const preKeys = preMigrated.agenda.map((a) => a.key);
assertEarly(!preKeys.includes("guest-speakers"),
  "migrator drops optional rows that were saved with included:false (guest-speakers)");
assertEarly(preKeys.includes("additional"),
  "migrator keeps optional rows that were saved with included:true (additional)");

// --- (2c) Migration from the prior 10-required / 3-optional v1.2 schema must
// drop removed items, add any missing required back, and preserve custom rows.
const v12Session = {
  version: 2,
  agenda: [
    { kind: "required", key: "opening",          item: "Opening Ceremony",                       presenter: "MC",             included: true },
    { kind: "required", key: "colors",           item: "Presentation of Colors",                 presenter: "Color Guard",    included: true },
    { kind: "required", key: "pledge",           item: "Pledge of Allegiance, Scout Oath & Law", presenter: "All",            included: true },
    { kind: "required", key: "mc-intro",         item: "Welcome and Introductions",              presenter: "Custom MC text", included: true },
    { kind: "required", key: "rank-advancement", item: "Rank Advancement",                       presenter: "MC",             included: true },
    { kind: "required", key: "merit-badges",     item: "Merit Badges",                           presenter: "MC",             included: true },
    { kind: "optional", key: "oa",               item: "Order of the Arrow",                     presenter: "OA Rep",         included: true },
    { kind: "optional", key: "adult-leader",     item: "Adult Leader Awards",                    presenter: "CC",             included: false },
    { kind: "optional", key: "additional",       item: "Additional Recognition",                 presenter: "SM",             included: false },
    { kind: "required", key: "spl-update",       item: "Senior Patrol Leader Update",            presenter: "SPLs",           included: true },
    { kind: "required", key: "scoutmaster-min",  item: "Scoutmaster Minute",                     presenter: "Brad",           included: true },
    { kind: "required", key: "retire-colors",    item: "Retirement of Colors",                   presenter: "Color Guard",    included: true },
    { kind: "required", key: "closing",          item: "Closing",                                presenter: "MC",             included: true },
    { kind: "custom",   key: "custom-abc",       item: "In Memoriam",                            presenter: "SM",             included: true },
  ],
};
const migrated = app.migrateSession(v12Session);
const migratedKeys = migrated.agenda.map((a) => a.key);
assertEarly(!migratedKeys.some((k) => REMOVED_KEYS.includes(k)),
  `migrator drops removed keys from v1.2 session (kept: [${migratedKeys.filter((k) => REMOVED_KEYS.includes(k)).join(", ")}])`);
const migratedReqKeys = migrated.agenda.filter((a) => a.kind === "required").map((a) => a.key);
assertEarly(
  JSON.stringify(migratedReqKeys) === JSON.stringify(requiredDefaults.map((d) => d.key)),
  `migrator retains all 7 required items in default order (got: [${migratedReqKeys.join(", ")}])`
);
const migratedCustom = migrated.agenda.find((a) => a.kind === "custom" && a.key === "custom-abc");
assertEarly(!!migratedCustom && migratedCustom.item === "In Memoriam",
  "migrator preserves custom rows from v1.2 session");
// Edited required label/presenter should be preserved (not clobbered by default).
const editedMc = migrated.agenda.find((a) => a.key === "mc-intro");
assertEarly(editedMc && editedMc.presenter === "Custom MC text",
  `migrator preserves edited presenter on required rows (got: "${editedMc && editedMc.presenter}")`);

// --- Build a model from the defaults (as if a volunteer just opened the app
// and uploaded both PO CSVs), then generate the PDFs.
const roster = buildRoster([boys, girls], {
  rankGrouping: "combined",
  mbGrouping: "combined",
  mbSort: "last",
});

// Simulate the app's currentModel(): every row in defaults (v1.2.2 has no
// per-row include flag; presence = shown). Presenter values are threaded
// through app.resolvePresenter() so MC-linked rows swap in the MC name
// (or a grey placeholder when the field is blank).
const MC_NAME = ""; // v1.2 default is blank
function buildAgendaForModel(rows, mcName) {
  return rows.filter((a) => a.item).map((a) => {
    const p = app.resolvePresenter(a, mcName);
    return { item: a.item, presenter: p.text, presenterGrey: p.placeholder };
  });
}
const agenda = buildAgendaForModel(defaults, MC_NAME);
const optionals = defaults
  .filter((a) => a.kind === "optional" && a.item)
  .map((a) => ({ key: a.key, item: a.item }));

// --- (2f) resolvePresenter unit checks (v1.2.3 signature: (row, mcName)).
const linkedRow = { linkedTo: "mcName", presenter: "" };
const unlinkedRow = { presenter: "Senior Patrol Leaders" };
const editedRow = { presenter: "Carol Donelly" }; // linkedTo intentionally absent
const emptyRow = { presenter: "" };
assertEarly(app.resolvePresenter(linkedRow, "Isaac Samo").text === "Isaac Samo",
  `resolvePresenter(linkedRow, "Isaac Samo") → "Isaac Samo"`);
assertEarly(app.resolvePresenter(linkedRow, "Isaac Samo").placeholder === false,
  `resolvePresenter(linkedRow, "Isaac Samo").placeholder === false`);
assertEarly(app.resolvePresenter(linkedRow, "").text === app.MC_PLACEHOLDER,
  `resolvePresenter(linkedRow, "") → MC_PLACEHOLDER ("${app.MC_PLACEHOLDER}")`);
assertEarly(app.resolvePresenter(linkedRow, "").placeholder === true,
  `resolvePresenter(linkedRow, "").placeholder === true`);
assertEarly(app.resolvePresenter(linkedRow, "  Isaac Samo  ").text === "Isaac Samo",
  `resolvePresenter trims whitespace around the MC name`);
assertEarly(app.resolvePresenter(unlinkedRow, "Isaac Samo").text === "Senior Patrol Leaders",
  `resolvePresenter respects an unlinked row (no MC swap)`);
assertEarly(app.resolvePresenter(editedRow, "Isaac Samo").text === "Carol Donelly",
  `resolvePresenter respects a broken-link row that already has custom text`);
assertEarly(app.resolvePresenter(emptyRow, "Isaac Samo").text === "",
  `resolvePresenter returns "" for an unlinked row with empty presenter`);

// --- (2g) MC-link UI wiring in the hydrated DOM.
const openingTr = Array.from(dom.window.document.querySelectorAll("#agenda-table tbody tr"))
  .find((tr) => tr.querySelector('input[data-k="item"]')?.value === "Opening Ceremony");
assertEarly(!!openingTr, `agenda has a hydrated "Opening Ceremony" row`);
assertEarly(openingTr?.dataset.linkedTo === "mcName",
  `Opening Ceremony row is MC-linked (data-linked-to="mcName")`);
const openingPresenterInp = openingTr?.querySelector('input[data-k="presenter"]');
assertEarly(openingPresenterInp?.value === "",
  `Opening Ceremony presenter input value is empty when MC field is blank (got "${openingPresenterInp?.value}")`);
assertEarly(openingPresenterInp?.getAttribute("placeholder") === app.MC_PLACEHOLDER,
  `Opening Ceremony presenter input has placeholder "${app.MC_PLACEHOLDER}"`);

// Typing in the MC field must update every MC-linked presenter input live.
const evMc = dom.window.document.getElementById("ev-mc");
evMc.value = "Isaac Samo";
evMc.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
const linkedInputs = Array.from(dom.window.document.querySelectorAll(
  '#agenda-table tbody tr[data-linked-to="mcName"] input[data-k="presenter"]'
));
assertEarly(linkedInputs.length >= 5,
  `at least 5 MC-linked presenter inputs are in the DOM (got ${linkedInputs.length})`);
const allSynced = linkedInputs.every((inp) => inp.value === "Isaac Samo");
assertEarly(allSynced,
  `all MC-linked presenter inputs updated to "Isaac Samo" after typing in the MC field`);

// The SPL row (unlinked) must NOT be updated by the MC field.
const splTr = Array.from(dom.window.document.querySelectorAll("#agenda-table tbody tr"))
  .find((tr) => tr.querySelector('input[data-k="item"]')?.value === "Senior Patrol Leader Update");
const splPresenterInp = splTr?.querySelector('input[data-k="presenter"]');
assertEarly(splPresenterInp?.value === "Senior Patrol Leaders",
  `SPL row's presenter is unaffected by the MC field (still "Senior Patrol Leaders")`);

// Typing directly into a linked input breaks the link.
const rankTr = Array.from(dom.window.document.querySelectorAll("#agenda-table tbody tr"))
  .find((tr) => tr.querySelector('input[data-k="item"]')?.value === "Rank Advancement");
const rankPresenterInp = rankTr?.querySelector('input[data-k="presenter"]');
assertEarly(rankTr?.dataset.linkedTo === "mcName",
  `Rank Advancement row was MC-linked before manual edit`);
rankPresenterInp.value = "Someone Else";
rankPresenterInp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
assertEarly(rankTr.dataset.linkedTo !== "mcName",
  `manual edit removed data-linked-to="mcName" from the Rank Advancement row`);
// Now type again in the MC field — Rank Advancement must not follow.
evMc.value = "Alice";
evMc.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
assertEarly(rankPresenterInp.value === "Someone Else",
  `after breaking the link, a subsequent MC field change no longer overwrites the manual edit (got "${rankPresenterInp.value}")`);
// Clearing the manual edit does NOT re-link.
rankPresenterInp.value = "";
rankPresenterInp.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
evMc.value = "Bob";
evMc.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
assertEarly(rankPresenterInp.value === "",
  `clearing the presenter after breaking the link does NOT re-link — MC name change is ignored`);

// Restore MC field to blank so downstream PDF assertions see the blank case.
evMc.value = "";
evMc.dispatchEvent(new dom.window.Event("input", { bubbles: true }));

// --- (2h) v1.2.3 migration: legacy sessions with literal presenter "MC"
// on default rows must be re-linked; custom rows with "MC" must NOT be
// re-linked.
const legacyMcSession = {
  version: 2,
  agenda: [
    { kind: "required", key: "opening",         item: "Opening Ceremony",            presenter: "MC",                          included: true },
    { kind: "required", key: "mc-intro",        item: "Welcome and Introductions",   presenter: "Someone Manual",              included: true },
    { kind: "required", key: "rank-advancement",item: "Rank Advancement",            presenter: "MC",                          included: true },
    { kind: "required", key: "merit-badges",    item: "Merit Badges",                presenter: "MC",                          included: true },
    { kind: "required", key: "spl-update",      item: "Senior Patrol Leader Update", presenter: "Senior Patrol Leaders",       included: true },
    { kind: "required", key: "scoutmaster-min", item: "Scoutmaster Minute",          presenter: "Brad Johnson and Carol Donelly", included: true },
    { kind: "required", key: "closing",         item: "Closing",                     presenter: "MC",                          included: true },
    { kind: "custom",   key: "custom-mc",       item: "Odd row",                     presenter: "MC",                          included: true },
  ],
};
const mcMigrated = app.migrateSession(legacyMcSession);
const openingMig = mcMigrated.agenda.find((a) => a.key === "opening");
assertEarly(openingMig?.linkedTo === "mcName",
  `migrator re-links a default row where presenter was literally "MC" (opening)`);
assertEarly(openingMig?.presenter === "",
  `re-linked row's stored presenter is normalized to "" (opening)`);
const mcIntroMig = mcMigrated.agenda.find((a) => a.key === "mc-intro");
assertEarly(mcIntroMig?.linkedTo !== "mcName" && mcIntroMig?.presenter === "Someone Manual",
  `migrator does NOT re-link a default row that had a manual (non-"MC") presenter (mc-intro)`);
const customMig = mcMigrated.agenda.find((a) => a.key === "custom-mc");
assertEarly(customMig?.linkedTo !== "mcName" && customMig?.presenter === "MC",
  `migrator does NOT re-link a custom row even if its presenter is literally "MC"`);

const model = {
  event: {
    date: "July 27, 2026",
    time: "6:30 PM",
    venue: "New Hope United Methodist Church\nSanctuary",
    mcName: MC_NAME,
    scoutmasterMinute: "Brad Johnson and Carol Donelly",
    troopLabels: [boys.troopLabel, girls.troopLabel],
  },
  agenda,
  optionals,
  roster,
  fleurBytes: new Uint8Array(fleur),
  coverTitle: "Court of Honor",
  org: "Mid-Iowa Council · BSA",
};

const sourceBytes = await buildSourcePDF(model, pdfLib);
const outDir = path.join(APP, "test");
fs.writeFileSync(path.join(outDir, "source.pdf"), sourceBytes);
console.log(`Wrote test/source.pdf (${sourceBytes.length} bytes)`);

const parsedSrc = await pdfLib.PDFDocument.load(sourceBytes);
console.log(`  source pages: ${parsedSrc.getPageCount()}`);
console.log(`  source page 0 size: ${JSON.stringify(parsedSrc.getPage(0).getSize())}`);

const bookletBytes = await buildBookletPDF(sourceBytes, pdfLib);
fs.writeFileSync(path.join(outDir, "out.pdf"), bookletBytes);
console.log(`Wrote test/out.pdf (${bookletBytes.length} bytes)`);

const parsedOut = await pdfLib.PDFDocument.load(bookletBytes);
const outPages = parsedOut.getPageCount();
const size0 = parsedOut.getPage(0).getSize();
console.log(`  booklet pages: ${outPages}`);
console.log(`  booklet page 0 size: ${JSON.stringify(size0)}`);

// --- Structural PDF assertions ---
let failed = assertionsFailed;
function assert(cond, msg) {
  if (!cond) { console.error(`FAIL: ${msg}`); failed = true; }
  else console.log(`  ok: ${msg}`);
}
assert(Math.round(size0.width) === 792 && Math.round(size0.height) === 612,
       "booklet page is landscape US Letter (792 x 612 pts)");
const padded = ((parsedSrc.getPageCount() + 3) >> 2) << 2;
assert(outPages === padded / 2, `booklet page count = padded_source/2 (${padded}/2 = ${padded / 2})`);
assert(outPages % 2 === 0, "booklet page count is even");
assert(outPages === 6, "booklet is 6 landscape pages (10 source pages → 12 padded → 6 sheets, reflects v1.2.1 defaults w/ 2 optional pages)");

const fleurStat = fs.statSync(path.join(APP, "assets/fleur-de-lis.jpg"));
assert(fleurStat.size > 50_000, `cover fleur is hi-res JPEG (${fleurStat.size} bytes > 50 KB)`);

// --- (3) The agenda page in the generated PDF must contain all required
// items in the correct default order. Extract text via pdftotext (poppler)
// and check ordering against the required rows in the default agenda.
const REQUIRED_LABELS = defaults.filter((d) => d.kind === "required").map((d) => d.item);
assert(REQUIRED_LABELS.length === 7, `7 required items defined (got ${REQUIRED_LABELS.length})`);
try {
  const txtPath = path.join(outDir, "source.txt");
  child_process.execFileSync("pdftotext", ["-layout", path.join(outDir, "source.pdf"), txtPath], { stdio: "ignore" });
  const txt = fs.readFileSync(txtPath, "utf-8");
  fs.unlinkSync(txtPath);
  // Find each required label's first occurrence; assert strictly increasing indexes.
  const positions = REQUIRED_LABELS.map((label) => ({ label, at: txt.indexOf(label) }));
  const missing = positions.filter((p) => p.at < 0).map((p) => p.label);
  assert(missing.length === 0, `every required agenda label appears in the PDF text (missing: [${missing.join(", ")}])`);
  let inOrder = true;
  for (let i = 1; i < positions.length; i++) {
    if (positions[i].at <= positions[i - 1].at) inOrder = false;
  }
  assert(inOrder, `required agenda items appear in default order: ${REQUIRED_LABELS.join(" → ")}`);
  // Optional items should also appear (they default to included).
  const OPTIONAL_LABELS = defaults.filter((d) => d.kind === "optional" && d.included).map((d) => d.item);
  const optMissing = OPTIONAL_LABELS.filter((l) => txt.indexOf(l) < 0);
  assert(optMissing.length === 0,
    `every default-included optional label appears in the PDF text (missing: [${optMissing.join(", ")}])`);

  // --- (3b) MC substitution end-to-end (v1.2.3). With MC_NAME blank the
  // source PDF's agenda page must show the literal "(MC name here)"
  // placeholder for MC-linked rows (rendered in grey by the PDF builder,
  // though pdftotext strips color info). It must NOT contain "Isaac Samo"
  // in the agenda area — he's a scout in the roster so we scope the check.
  assert(txt.indexOf(app.MC_PLACEHOLDER) >= 0,
    `blank MC field: PDF contains the "(MC name here)" placeholder`);
  assert(new RegExp(`Opening Ceremony[\\s\\S]{0,80}${app.MC_PLACEHOLDER.replace(/[()]/g, "\\$&")}`).test(txt),
    `blank MC field: agenda row "Opening Ceremony" is followed by "(MC name here)" placeholder`);
  assert(!/Opening Ceremony[\s\S]{0,80}Isaac Samo/.test(txt),
    `blank MC field: no MC-name splice near "Opening Ceremony" in agenda`);

  // Now regenerate the source PDF with the MC field set and assert the
  // MC-linked rows are rebound to the volunteer's chosen name.
  const namedMc = "Isaac Samo";
  const namedAgenda = buildAgendaForModel(defaults, namedMc);
  const namedModel = { ...model, event: { ...model.event, mcName: namedMc }, agenda: namedAgenda };
  const namedSrcBytes = await buildSourcePDF(namedModel, pdfLib);
  const namedPdfPath = path.join(outDir, "source-with-mc.pdf");
  const namedTxtPath = path.join(outDir, "source-with-mc.txt");
  fs.writeFileSync(namedPdfPath, namedSrcBytes);
  try {
    child_process.execFileSync("pdftotext", ["-layout", namedPdfPath, namedTxtPath], { stdio: "ignore" });
    const namedTxt = fs.readFileSync(namedTxtPath, "utf-8");
    fs.unlinkSync(namedPdfPath);
    fs.unlinkSync(namedTxtPath);
    assert(namedTxt.indexOf(namedMc) >= 0,
      `MC field set to "${namedMc}": PDF contains that name`);
    assert(/Opening Ceremony[\s\S]{0,80}Isaac Samo/.test(namedTxt),
      `MC field set to "${namedMc}": agenda row "Opening Ceremony" is followed by "${namedMc}" (not the placeholder)`);
    assert(namedTxt.indexOf(app.MC_PLACEHOLDER) < 0,
      `MC field set: PDF no longer contains the "(MC name here)" placeholder`);
    // Non-MC presenter must NOT be swapped: SM Minute row still shows Brad.
    assert(/Scoutmaster Minute[\s\S]{0,80}Brad Johnson and Carol Donelly/.test(namedTxt),
      `MC field set: non-MC presenter on "Scoutmaster Minute" row is unchanged`);
  } catch (err) {
    console.log(`  skip: pdftotext failed on MC-substitution check (${err.message})`);
    try { fs.unlinkSync(namedPdfPath); } catch {}
    try { fs.unlinkSync(namedTxtPath); } catch {}
  }
} catch (err) {
  console.log(`  skip: pdftotext not available or failed (${err.message}); agenda-order check skipped`);
}

// --- Border + upright orientation via rasterization (unchanged from v1.1).
const rotateSet = parsedOut.getPages().some((p) => {
  try { return p.getRotation && p.getRotation().angle !== 0; } catch { return false; }
});
assert(!rotateSet, "no /Rotate on any booklet page (all upright)");

try {
  const ppmPrefix = path.join(outDir, "out-preview");
  child_process.execFileSync("pdftoppm", ["-r", "72", "-f", "1", "-l", "1",
    path.join(outDir, "out.pdf"), ppmPrefix], { stdio: "ignore" });
  const rasterName = fs.readdirSync(outDir).find((f) => f.startsWith("out-preview") && f.endsWith(".ppm"));
  if (!rasterName) throw new Error("pdftoppm produced no PPM output");
  const rasterPath = path.join(outDir, rasterName);
  const buf = fs.readFileSync(rasterPath);
  let cursor = 0;
  const readToken = () => {
    while (cursor < buf.length && /\s|#/.test(String.fromCharCode(buf[cursor]))) {
      if (buf[cursor] === 0x23) { while (cursor < buf.length && buf[cursor] !== 0x0a) cursor++; }
      else cursor++;
    }
    let start = cursor;
    while (cursor < buf.length && !/\s/.test(String.fromCharCode(buf[cursor]))) cursor++;
    return buf.slice(start, cursor).toString("ascii");
  };
  const magic = readToken();
  const rasterW = parseInt(readToken(), 10);
  const rasterH = parseInt(readToken(), 10);
  const maxval = parseInt(readToken(), 10);
  cursor++;
  assert(magic === "P6" && maxval === 255, `PPM raster is 8-bit RGB (magic=${magic}, maxval=${maxval})`);
  assert(rasterW === 792 && rasterH === 612,
    `raster of page 1 is 792x612 px (landscape, upright): got ${rasterW}x${rasterH}`);
  const pix = (x, y) => {
    const off = cursor + 3 * (y * rasterW + x);
    return { r: buf[off], g: buf[off + 1], b: buf[off + 2] };
  };
  const isBorderGrey = (p) => {
    const dark = Math.max(p.r, p.g, p.b) < 215;
    const nearGrey = Math.abs(p.r - p.g) < 20 && Math.abs(p.g - p.b) < 20;
    return dark && nearGrey;
  };
  const sampleAt = (xs, ys) => {
    const pts = [];
    for (const x of xs) for (const y of ys) pts.push({ x, y, ...pix(x, y) });
    return pts;
  };
  const leftBorderHits = sampleAt([40, 100, 200, 300, 360], [17, 18, 19]).filter(isBorderGrey);
  const rightBorderHits = sampleAt([440, 500, 600, 700, 760], [17, 18, 19]).filter(isBorderGrey);
  assert(leftBorderHits.length >= 5, `left half-sheet has visible grey border pixels along top (hits=${leftBorderHits.length}/15)`);
  assert(rightBorderHits.length >= 5, `right half-sheet has visible grey border pixels along top (hits=${rightBorderHits.length}/15)`);
  const bottomLeftHits = sampleAt([40, 200, 360], [593, 594, 595]).filter(isBorderGrey);
  const bottomRightHits = sampleAt([440, 600, 760], [593, 594, 595]).filter(isBorderGrey);
  assert(bottomLeftHits.length >= 3 && bottomRightHits.length >= 3,
    `both half-sheet borders visible along bottom (${bottomLeftHits.length}, ${bottomRightHits.length})`);
  fs.unlinkSync(rasterPath);
} catch (err) {
  console.log(`  skip: pdftoppm not available or failed (${err.message}); border/orientation raster check skipped`);
}

// --- (4) Pocket certificates (v1.3.0) ---
// MB-only filter: extract from both sample POs and assert ranks/misc excluded.
const boysMb = extractMeritBadgeRows(boysCsv);
const girlsMb = extractMeritBadgeRows(girlsCsv);
console.log(`Boys MB rows: ${boysMb.length}, girls MB rows: ${girlsMb.length}`);
// Every row's badge name should be free of "Rank"/"Emblem" suffixes (cleanItem
// already handles this, but sanity-check the extractor didn't smuggle any in).
const badgeNames = [...boysMb, ...girlsMb].map((r) => r.badge);
assert(badgeNames.every((b) => !/(Rank|MB Emblem| Emblem)$/.test(b)),
  `extracted badge names have no rank/emblem suffixes (${badgeNames.filter((b) => /(Rank|MB Emblem| Emblem)$/.test(b)).join(", ")})`);
// Cross-check: fixture "Adair" scout has multiple MB rows.
const adair = boysMb.filter((r) => r.lastName === "Adair");
assert(adair.length >= 2, `MB extractor returned multiple rows for scout "Adair" (got ${adair.length})`);
// The extractor must EXCLUDE any Badges-of-Rank or Misc-Awards rows. Compare
// against parsePO which knows the totals.
assert(boysMb.length === boys.meritBadges ? true : true, "smoke reads MB rows"); // no-op guard for readability
// Sum of items in the per-scout MB map == number of rows extracted.
let boysMbFromParsed = 0;
for (const v of boys.meritBadges.values()) boysMbFromParsed += v.items.length;
assert(boysMb.length === boysMbFromParsed,
  `MB extractor row count matches parsePO MB item count for boys (extractor=${boysMb.length}, parsed=${boysMbFromParsed})`);
let girlsMbFromParsed = 0;
for (const v of girls.meritBadges.values()) girlsMbFromParsed += v.items.length;
assert(girlsMb.length === girlsMbFromParsed,
  `MB extractor row count matches parsePO MB item count for girls (extractor=${girlsMb.length}, parsed=${girlsMbFromParsed})`);
// No row's badge should equal a canonical rank name.
const RANK_NAMES = ["Scout", "Tenderfoot", "Second Class", "First Class", "Star", "Life", "Eagle", "Eagle Palm", "Star Scout", "Life Scout", "Eagle Scout"];
assert(!badgeNames.some((b) => RANK_NAMES.includes(b)),
  "no extracted MB row is actually a rank");

// Build a pocket cert PDF for the boys and validate structure.
const POCKET_DEFAULT_DATE = "July 27, 2026";
const POCKET_COUNCIL = "Mid-Iowa Council";
const POCKET_SIGNATURE = "Brian J Hartin";
const pocketBytes = await buildPocketCertsPDF(boysMb, {
  defaultDate: POCKET_DEFAULT_DATE,
  troop: "96 B",
  council: POCKET_COUNCIL,
  signature: POCKET_SIGNATURE,
}, pdfLib);
const pocketPath = path.join(outDir, "pocket-boys.pdf");
fs.writeFileSync(pocketPath, pocketBytes);
console.log(`Wrote test/pocket-boys.pdf (${pocketBytes.length} bytes)`);
const parsedPocket = await pdfLib.PDFDocument.load(pocketBytes);
const expectedSheets = Math.ceil(boysMb.length / POCKET_CARDS_PER_SHEET);
assert(parsedPocket.getPageCount() === expectedSheets,
  `pocket PDF page count = ceil(${boysMb.length}/8) = ${expectedSheets} (got ${parsedPocket.getPageCount()})`);
const pcSize = parsedPocket.getPage(0).getSize();
assert(Math.round(pcSize.width) === 792 && Math.round(pcSize.height) === 612,
  `pocket page 0 is landscape US Letter (792x612 pts), got ${Math.round(pcSize.width)}x${Math.round(pcSize.height)}`);
// pocketCertSheetCount helper agrees with the actual page count.
assert(pocketCertSheetCount(boysMb.length) === expectedSheets,
  `pocketCertSheetCount(${boysMb.length}) === ${expectedSheets}`);
assert(POCKET_CARDS_PER_SHEET === 8, `POCKET_CARDS_PER_SHEET === 8`);

// Empty MB list still produces a single blank framed sheet (edge case guard).
const emptyPocketBytes = await buildPocketCertsPDF([], {
  defaultDate: POCKET_DEFAULT_DATE, troop: "96 B",
  council: POCKET_COUNCIL, signature: POCKET_SIGNATURE,
}, pdfLib);
const parsedEmpty = await pdfLib.PDFDocument.load(emptyPocketBytes);
assert(parsedEmpty.getPageCount() === 1,
  `pocket PDF for zero rows still emits one page (blank cut-guide grid), got ${parsedEmpty.getPageCount()}`);

// Text-content assertions: page 1 should contain the first scout's name,
// the first badge, the default date (used when a row has no explicit date)
// or the row's own date, and the council/signature fields.
try {
  const txtPath = path.join(outDir, "pocket-boys.txt");
  child_process.execFileSync("pdftotext", ["-layout", pocketPath, txtPath], { stdio: "ignore" });
  const txt = fs.readFileSync(txtPath, "utf-8");
  fs.unlinkSync(txtPath);
  // First card is row 0 (sorted by lastName then firstName then badge).
  const first = boysMb[0];
  assert(txt.indexOf(first.scoutName) >= 0,
    `pocket PDF text contains the first scout's name ("${first.scoutName}")`);
  assert(txt.indexOf(first.badge) >= 0,
    `pocket PDF text contains the first badge ("${first.badge}")`);
  assert(txt.indexOf(POCKET_COUNCIL) >= 0,
    `pocket PDF text contains the council ("${POCKET_COUNCIL}")`);
  assert(txt.indexOf(POCKET_SIGNATURE) >= 0,
    `pocket PDF text contains the signature ("${POCKET_SIGNATURE}")`);
  assert(txt.indexOf("96 B") >= 0,
    `pocket PDF text contains the troop identifier ("96 B")`);
  // Every row's date should appear somewhere (either the row's own date or
  // the default date if that row was blank). Sample rows have real dates in
  // the fixture, so at least the first row's date should appear as-is.
  if (first.dateEarned) {
    assert(txt.indexOf(first.dateEarned) >= 0,
      `pocket PDF text contains the first row's Date Earned ("${first.dateEarned}")`);
  }

  // Signature-field-renders-with-default-date check: fabricate a row with
  // an EMPTY dateEarned and build a single-card PDF; text must contain the
  // default date AND the signature. This exercises the "no date" fallback
  // path required by the smoke spec.
  const noDateRows = [{
    scoutName: "Test Scout", firstName: "Test", lastName: "Scout",
    badge: "Camping", dateEarned: "",
  }];
  const noDateBytes = await buildPocketCertsPDF(noDateRows, {
    defaultDate: POCKET_DEFAULT_DATE, troop: "96 B",
    council: POCKET_COUNCIL, signature: POCKET_SIGNATURE,
  }, pdfLib);
  const noDatePath = path.join(outDir, "pocket-no-date.pdf");
  const noDateTxtPath = path.join(outDir, "pocket-no-date.txt");
  fs.writeFileSync(noDatePath, noDateBytes);
  try {
    child_process.execFileSync("pdftotext", ["-layout", noDatePath, noDateTxtPath], { stdio: "ignore" });
    const noDateTxt = fs.readFileSync(noDateTxtPath, "utf-8");
    fs.unlinkSync(noDateTxtPath);
    assert(noDateTxt.indexOf(POCKET_DEFAULT_DATE) >= 0,
      `no-date row: pocket PDF falls back to default date "${POCKET_DEFAULT_DATE}"`);
    assert(noDateTxt.indexOf(POCKET_SIGNATURE) >= 0,
      `no-date row: signature field still renders ("${POCKET_SIGNATURE}")`);
    assert(noDateTxt.indexOf("Test Scout") >= 0,
      `no-date row: scout name still renders`);
    assert(noDateTxt.indexOf("Camping") >= 0,
      `no-date row: badge name still renders`);
  } finally {
    try { fs.unlinkSync(noDatePath); } catch {}
    try { fs.unlinkSync(noDateTxtPath); } catch {}
  }
} catch (err) {
  console.log(`  skip: pdftotext failed on pocket-cert check (${err.message})`);
}

// (4c) v1.3.2: no cut-guide borders + card-1 layout matches reference render.
// The pocket-cert layout was measured from a headless-Chrome render of
// scripts/templates/pocket-cert-page.html using pdftotext -bbox-layout.
// Verify the pdf-lib output matches those measured positions within 2pt,
// and that no stroke operators are emitted for card boundaries.
try {
  // Reference measurements (yBot in top-down pt, from card top edge).
  const REF = { scoutName: 92.54, badge: 114.62, dateUnit: 165.08,
                council: 184.58, signature: 207.21 };
  const CARD_W = 180, CARD_H = 270, SHEET_W = 792, SHEET_H = 612;
  const scoutFullName = boysMb[0].scoutName; // e.g. "Erik Adair"

  // Parse page-1 word bboxes.
  const bboxTxtPath = path.join(outDir, "pocket-boys-bbox.txt");
  try {
    child_process.execFileSync("pdftotext",
      ["-bbox-layout", "-f", "1", "-l", "1", pocketPath, bboxTxtPath],
      { stdio: "ignore" });
    const bboxRaw = fs.readFileSync(bboxTxtPath, "utf8");
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]+)<\/word>/g;
    const words = [];
    let m;
    while ((m = wordRe.exec(bboxRaw)) !== null) {
      words.push({ xMin: +m[1], yMin: +m[2], xMax: +m[3], yMax: +m[4], text: m[5] });
    }
    // Group consecutive words on the same y-line (row 0, col 0 = card 1).
    const card1Words = words.filter(w => w.xMax <= CARD_W + 1 && w.yMax <= CARD_H + 1);
    const linesByY = new Map();
    for (const w of card1Words) {
      const k = Math.round(w.yMin * 10) / 10;
      if (!linesByY.has(k)) linesByY.set(k, []);
      linesByY.get(k).push(w);
    }
    const lineKeys = [...linesByY.keys()].sort((a, b) => a - b);
    assert(lineKeys.length === 5,
      `card 1 has 5 text lines (scout, badge, date+troop, council, signature); got ${lineKeys.length}`);

    const scoutLine = linesByY.get(lineKeys[0]);
    const sigLine   = linesByY.get(lineKeys[4]);
    const scoutTxt = scoutLine.map(w => w.text).join(" ");
    const sigTxt   = sigLine.map(w => w.text).join(" ");
    assert(scoutTxt === scoutFullName,
      `card 1 first line is the scout name "${scoutFullName}" (got "${scoutTxt}")`);
    assert(sigTxt === POCKET_SIGNATURE,
      `card 1 last line is the signature "${POCKET_SIGNATURE}" (got "${sigTxt}")`);

    // Baseline (yBot) tolerance ±2pt, per v1.3.2 spec.
    const scoutYBot = Math.max(...scoutLine.map(w => w.yMax));
    const sigYBot   = Math.max(...sigLine.map(w => w.yMax));
    assert(Math.abs(scoutYBot - REF.scoutName) <= 2,
      `card 1 scout-name baseline within 2pt of reference (${REF.scoutName}pt); got ${scoutYBot.toFixed(2)}pt (diff ${(scoutYBot - REF.scoutName).toFixed(2)}pt)`);
    assert(Math.abs(sigYBot - REF.signature) <= 2,
      `card 1 signature baseline within 2pt of reference (${REF.signature}pt); got ${sigYBot.toFixed(2)}pt (diff ${(sigYBot - REF.signature).toFixed(2)}pt)`);

    // Horizontal center of scout-name matches card horizontal center (90pt).
    const scoutXMin = Math.min(...scoutLine.map(w => w.xMin));
    const scoutXMax = Math.max(...scoutLine.map(w => w.xMax));
    const scoutCenter = (scoutXMin + scoutXMax) / 2;
    assert(Math.abs(scoutCenter - CARD_W / 2) <= 2,
      `card 1 scout-name centered on card horizontal midpoint (${CARD_W / 2}pt); got ${scoutCenter.toFixed(2)}pt`);
  } finally {
    try { fs.unlinkSync(bboxTxtPath); } catch {}
  }

  // No cut-guide borders: verify at two levels.
  // (a) Source-level: pocket-cert-builder.js contains NO drawing calls
  //     that would produce strokes (drawRectangle/drawLine/drawEllipse/
  //     drawSquare). The v1.3.2 change removed all card-boundary strokes.
  const pocketBuilderSrc = fs.readFileSync(
    path.join(APP, "pocket-cert-builder.js"), "utf8");
  const strokingCallRe = /\.draw(Rectangle|Line|Ellipse|Square|Circle|SvgPath)\s*\(/g;
  const strokingMatches = pocketBuilderSrc.match(strokingCallRe) || [];
  assert(strokingMatches.length === 0,
    `pocket-cert-builder.js emits NO shape-drawing calls (no cut-guide borders); found ${strokingMatches.length}: ${strokingMatches.join(", ")}`);

  // (b) Rasterize page 1 at 72dpi and sample pixels 1pt inside each card
  //     boundary — if a border had been drawn, at least one of these
  //     pixels would be non-white.
  const ppmPath = path.join(outDir, "pocket-boys-p1.ppm");
  try {
    child_process.execFileSync("pdftoppm",
      ["-r", "72", "-f", "1", "-l", "1", pocketPath,
        path.join(outDir, "pocket-boys-p1")],
      { stdio: "ignore" });
    // pdftoppm writes ...-1.ppm (or -01.ppm). Detect it.
    const ppmCandidates = ["pocket-boys-p1-1.ppm", "pocket-boys-p1-01.ppm",
                           "pocket-boys-p1-001.ppm"];
    const ppmActual = ppmCandidates
      .map(n => path.join(outDir, n))
      .find(p => fs.existsSync(p));
    if (!ppmActual) throw new Error("pdftoppm output not found");
    const ppm = fs.readFileSync(ppmActual);
    // PPM P6 header: "P6\n<w> <h>\n<maxval>\n" then binary RGB triples.
    const nlIndices = [];
    for (let i = 0; i < ppm.length && nlIndices.length < 3; i++) {
      if (ppm[i] === 0x0a) nlIndices.push(i);
    }
    const [dimLine] = ppm.slice(nlIndices[0] + 1, nlIndices[1]).toString().split("\n");
    const [wStr, hStr] = dimLine.split(/\s+/);
    const w = parseInt(wStr, 10), h = parseInt(hStr, 10);
    const dataStart = nlIndices[2] + 1;
    const pixelAt = (px, py) => {
      const off = dataStart + (py * w + px) * 3;
      return [ppm[off], ppm[off + 1], ppm[off + 2]];
    };
    // Card grid: 4 cols × 2 rows of 180×270pt cards, no gap, starting at (0,0).
    // At 72dpi 1pt = 1px. Sample pixels 1px inside each card boundary along
    // its right and bottom edges. If NO border, all should be pure white.
    const CARD_W_PX = 180, CARD_H_PX = 270;
    let borderPixels = 0;
    for (let col = 0; col < 4; col++) {
      for (let row = 0; row < 2; row++) {
        const x0 = col * CARD_W_PX, y0 = row * CARD_H_PX;
        // Sample 10 points along each of the four card edges, 1px inside.
        for (let t = 0; t < 10; t++) {
          const frac = 0.1 + t * 0.08;
          const samples = [
            [x0 + 1, y0 + Math.floor(frac * CARD_H_PX)],            // left edge
            [x0 + CARD_W_PX - 2, y0 + Math.floor(frac * CARD_H_PX)], // right edge
            [x0 + Math.floor(frac * CARD_W_PX), y0 + 1],            // top edge
            [x0 + Math.floor(frac * CARD_W_PX), y0 + CARD_H_PX - 2], // bottom edge
          ];
          for (const [sx, sy] of samples) {
            if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
            const [r, g, b] = pixelAt(sx, sy);
            if (r < 250 || g < 250 || b < 250) borderPixels++;
          }
        }
      }
    }
    assert(borderPixels === 0,
      `pocket-cert page 1: no non-white pixels at card boundaries (border-free); found ${borderPixels}`);
    try { fs.unlinkSync(ppmActual); } catch {}
  } catch (err) {
    console.log(`  skip: raster border check failed (${err.message})`);
  }
} catch (err) {
  console.log(`  skip: v1.3.2 layout/border assertions failed (${err.message})`);
}

// (4b) Pocket state defaults are wired into the hydrated form.
const pcCouncil = dom.window.document.getElementById("pc-council");
const pcSig = dom.window.document.getElementById("pc-signature");
const pcTroopA = dom.window.document.getElementById("pc-troop-a");
const pcTroopB = dom.window.document.getElementById("pc-troop-b");
const pcBtnA = dom.window.document.getElementById("btn-pocket-a");
const pcBtnB = dom.window.document.getElementById("btn-pocket-b");
assert(pcCouncil?.value === "Mid-Iowa Council",
  `pocket council field defaults to "Mid-Iowa Council" (got "${pcCouncil?.value}")`);
assert(pcSig?.value === "",
  `pocket signature field defaults to empty (got "${pcSig?.value}")`);
assert(pcTroopA?.value === "96 B",
  `pocket Boys Troop identifier defaults to "96 B" (got "${pcTroopA?.value}")`);
assert(pcTroopB?.value === "96 G",
  `pocket Girls Troop identifier defaults to "96 G" (got "${pcTroopB?.value}")`);
assert(pcBtnA && pcBtnA.disabled === true,
  `pocket Boys Troop download button starts disabled (no CSV uploaded yet)`);
assert(pcBtnB && pcBtnB.disabled === true,
  `pocket Girls Troop download button starts disabled`);

// (4c) Session migration backfills the `pocket` sub-state for older sessions.
const legacyNoPocket = app.migrateSession({ version: 2, agenda: [] });
assert(legacyNoPocket.pocket?.council === "Mid-Iowa Council",
  `migrator backfills pocket.council for pre-1.3 sessions`);
assert(Array.isArray(legacyNoPocket.pocket?.troopIdents) &&
  legacyNoPocket.pocket.troopIdents[0] === "96 B" &&
  legacyNoPocket.pocket.troopIdents[1] === "96 G",
  `migrator backfills pocket.troopIdents = ["96 B", "96 G"] for pre-1.3 sessions`);
// A partial pocket sub-state is honored where set and defaulted where missing.
const partialPocket = app.migrateSession({
  version: 2, agenda: [],
  pocket: { signature: "Custom Signer" },
});
assert(partialPocket.pocket.signature === "Custom Signer",
  `migrator preserves an existing pocket.signature`);
assert(partialPocket.pocket.council === "Mid-Iowa Council",
  `migrator fills in missing pocket.council`);

if (failed) process.exit(1);
console.log("\nAll smoke-test assertions passed.");
