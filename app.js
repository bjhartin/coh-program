// app.js — glue between the DOM and the data/pdf modules.
// Loaded as an ES module in index.html.

import { parsePO, guessTroopLabel, buildRoster, extractMeritBadgeRows } from "./data.js";
import { buildSourcePDF, buildBookletPDF } from "./pdf-builder.js";
import { buildPocketCertsPDF, pocketCertSheetCount, POCKET_CARDS_PER_SHEET } from "./pocket-cert-builder.js";

// pdf-lib via ESM CDN.
const PDF_LIB_URL = "https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/+esm";

// ---------- Defaults ----------
//
// The unified agenda / program-sections list. Each entry:
//   kind:      'required' | 'optional' | 'custom'
//     - required items cannot be removed or excluded from the program.
//     - optional items are removable; presence in the list means "show".
//     - custom items are user-added (agenda-only, no content page).
//   key:       stable identifier used by save/load and to look up optional
//              section pages in the PDF builder.
//   item:      display label (printed on the agenda page)
//   presenter: presenter text (printed after em-dash). Empty on MC-linked
//              rows; ignored while `linkedTo === "mcName"`.
//   linkedTo:  optional string. Currently only `"mcName"` — indicates the
//              row's presenter is dynamically bound to the Event Details
//              MC field. Any manual edit to the presenter input breaks the
//              link permanently (v1.2.3+).
//   included:  bool; kept for backwards compatibility with older save files.
//              v1.2.2+ ignores it — presence in the list means shown.

/** Build a fresh default agenda list (mutated freely thereafter). */
export function buildDefaultAgenda() {
  return [
    { kind: "required", key: "opening",          item: "Opening Ceremony",            presenter: "", linkedTo: "mcName", included: true },
    { kind: "required", key: "mc-intro",         item: "Welcome and Introductions",   presenter: "", linkedTo: "mcName", included: true },
    { kind: "required", key: "rank-advancement", item: "Rank Advancement",            presenter: "", linkedTo: "mcName", included: true },
    { kind: "required", key: "merit-badges",     item: "Merit Badges",                presenter: "", linkedTo: "mcName", included: true },
    { kind: "required", key: "spl-update",       item: "Senior Patrol Leader Update", presenter: "Senior Patrol Leaders",          included: true },
    { kind: "optional", key: "guest-speakers",   item: "Guest Speakers",              presenter: "",                               included: true },
    { kind: "optional", key: "additional",       item: "Additional Recognition",      presenter: "Scoutmaster",                    included: true },
    { kind: "required", key: "scoutmaster-min",  item: "Scoutmaster Minute",          presenter: "Brad Johnson and Carol Donelly", included: true },
    { kind: "required", key: "closing",          item: "Closing",                     presenter: "", linkedTo: "mcName", included: true },
  ];
}

/**
 * v1.2.3: resolve an agenda row's presenter for rendering.
 *
 * Returns `{ text, placeholder }`:
 *   - MC-linked row + non-blank MC name: text = MC name, placeholder = false
 *   - MC-linked row + blank MC name:     text = "(MC name here)", placeholder = true
 *   - un-linked row:                     text = row.presenter, placeholder = false
 *
 * The PDF builder and preview both call this so their handling stays in
 * sync. Callers can lean on `placeholder` to render the string in grey.
 */
export const MC_PLACEHOLDER = "(MC name here)";
export function resolvePresenter(row, mcName) {
  if (row && row.linkedTo === "mcName") {
    const trimmed = String(mcName || "").trim();
    return { text: trimmed || MC_PLACEHOLDER, placeholder: !trimmed };
  }
  return { text: (row && row.presenter) || "", placeholder: false };
}

// ---------- State ----------

/** All user inputs live here. Serializable to JSON for save/load. */
const state = {
  version: 2,
  troops: [
    { troopLabel: "Troop 96B", filename: "", csvText: "" },
    { troopLabel: "Troop 96G", filename: "", csvText: "" },
  ],
  event: {
    date: "",
    time: "6:30 PM",
    venue: "",
    // MC name intentionally blank — must be entered by the volunteer (v1.2).
    mcName: "",
    // Standing default per the current Scoutmaster & Committee Chair (v1.2).
    scoutmasterMinute: "Brad Johnson and Carol Donelly",
    title: "Court of Honor",
    org: "Mid-Iowa Council · BSA",
  },
  grouping: { rank: "combined", mb: "combined", mbSort: "last" },
  agenda: buildDefaultAgenda(),
  // v1.3.0: Pocket certificate defaults. `troopIdents` is a 2-slot array
  // matching `state.troops`; free-text so volunteers can enter "96 B",
  // "Troop 96", etc. `defaultDate` mirrors `event.date` unless the user
  // overrides it.
  pocket: {
    council: "Mid-Iowa Council",
    signature: "",
    defaultDate: "",
    troopIdents: ["96 B", "96 G"],
  },
};

/**
 * Migrate an inbound session JSON to the current schema.
 *
 * Handles v1/v1.1 sessions (which used state.sections + a flat agenda of
 * {item, presenter} entries with no `kind`), v1.2 sessions (larger 10/3
 * default list), and v1.2.1 sessions (7 required + 2 optional with an
 * include checkbox on optionals). Rebuilds the current default unified
 * agenda, overlays presenter values wherever labels match, drops any item
 * whose key is no longer in the defaults, and — new in v1.2.2 — drops any
 * pre-1.2.2 optional row whose `included: false` (the user having ticked
 * it off in the old UI is now equivalent to deleting the row). Custom
 * user-added rows are always preserved. SPL is always included.
 */
export function migrateSession(loaded) {
  if (!loaded || typeof loaded !== "object") return loaded;
  const defaults = buildDefaultAgenda();
  const defaultKeys = new Set(defaults.map((d) => d.key));
  const hasNewAgenda = Array.isArray(loaded.agenda) && loaded.agenda.some((a) => a && a.kind);

  if (!hasNewAgenda) {
    // v1 / v1.1 → v1.2.3: rebuild from defaults, overlay presenters by label,
    // and drop any optional row the legacy sections flags marked as excluded.
    // The rebuild is done from a fresh buildDefaultAgenda() so MC-link
    // metadata (linkedTo: "mcName") is inherited automatically.
    if (Array.isArray(loaded.agenda)) {
      for (const old of loaded.agenda) {
        if (!old || !old.item) continue;
        const match = defaults.find((d) => d.item.toLowerCase() === String(old.item).toLowerCase());
        if (match && old.presenter && old.presenter !== "MC") {
          // Non-"MC" custom text: user had edited that row's presenter;
          // preserve their edit and break the MC link.
          match.presenter = old.presenter;
          delete match.linkedTo;
        }
      }
    }
    let dropKeys = new Set();
    if (loaded.sections && typeof loaded.sections === "object") {
      // Legacy `sections.additional === false` means the user had opted out
      // of that section in v1/v1.1; treat as deleted in v1.2.2+.
      if (loaded.sections.additional === false) dropKeys.add("additional");
      // Legacy `sections.spl` is intentionally ignored — SPL is required.
      // Legacy `sections.oa` and `sections.adultLeader` map to items that no
      // longer exist in defaults; ignore them (users can re-add as needed).
    }
    loaded.agenda = defaults.filter((d) => !dropKeys.has(d.key));
    delete loaded.sections;
  } else {
    // v1.2.x → v1.2.3: reconcile against current defaults. Keep user's
    // custom rows and any default rows that still exist (with their edited
    // label/presenter). Drop rows whose key is no longer in defaults and
    // isn't a custom row. Drop optional rows saved with `included: false`
    // (equivalent to the user deleting them in the new UI). Append any
    // missing required defaults in default order. Re-link the MC placeholder
    // rows: if a saved presenter is literally "MC" on a default row that
    // is MC-linked by design, treat it as still linked (v1.2.3).
    const preserved = [];
    const seenKeys = new Set();
    for (const a of loaded.agenda) {
      if (!a || !a.key) continue;
      if (a.kind === "custom") {
        // Custom rows saved with included:false in v1.2.x — respect that
        // as a deletion. (v1.2.2+ never writes included:false for customs.)
        if (a.included === false) continue;
        // Custom rows with presenter "MC" stay literal — never re-linked.
        preserved.push(a);
        continue;
      }
      if (!defaultKeys.has(a.key)) continue; // drop items removed from defaults
      const def = defaults.find((d) => d.key === a.key);
      // Drop optional rows that were excluded via the pre-1.2.2 checkbox.
      if (def.kind !== "required" && a.included === false) {
        seenKeys.add(a.key);
        continue;
      }
      // Determine MC-link + presenter for this row.
      const defaultIsLinked = def.linkedTo === "mcName";
      const savedPresenter = a.presenter != null ? String(a.presenter) : "";
      const savedLinked = a.linkedTo === "mcName";
      let entryPresenter, entryLinked;
      if (savedLinked) {
        // v1.2.3 session: honor the saved link.
        entryLinked = true;
        entryPresenter = "";
      } else if (defaultIsLinked && (savedPresenter === "" || savedPresenter === "MC")) {
        // Legacy v1.2.x session that stored the literal "MC" placeholder,
        // OR a v1.2.3 session where the user hasn't customised the row.
        // Re-establish the MC link.
        entryLinked = true;
        entryPresenter = "";
      } else if (defaultIsLinked) {
        // User had typed something other than "MC" on a would-be linked
        // row → link is permanently broken; keep the custom text.
        entryLinked = false;
        entryPresenter = savedPresenter;
      } else {
        // Non-linked default (e.g. SPL row, SM Minute row).
        entryLinked = false;
        entryPresenter = savedPresenter || def.presenter;
      }
      const entry = {
        kind: def.kind,
        key: def.key,
        item: a.item || def.item,
        presenter: entryPresenter,
        included: true,
      };
      if (entryLinked) entry.linkedTo = "mcName";
      preserved.push(entry);
      seenKeys.add(a.key);
    }
    // Append any REQUIRED default that was missing (SPL etc must always be
    // present); optional defaults that the user previously deleted are
    // intentionally NOT re-added.
    const missingRequired = defaults.filter((d) => d.kind === "required" && !seenKeys.has(d.key));
    if (missingRequired.length) {
      const rebuilt = [];
      const customs = preserved.filter((p) => p.kind === "custom");
      const nonCustom = preserved.filter((p) => p.kind !== "custom");
      const byKey = new Map(nonCustom.map((p) => [p.key, p]));
      for (const d of defaults) {
        const existing = byKey.get(d.key);
        if (existing) rebuilt.push(existing);
        else if (d.kind === "required") rebuilt.push({ ...d });
        // optional defaults not present in `preserved` = user deleted them; skip
      }
      rebuilt.push(...customs);
      loaded.agenda = rebuilt;
    } else {
      loaded.agenda = preserved;
    }
    // Belt-and-suspenders: force every required item to included:true.
    for (const a of loaded.agenda) if (a && a.kind === "required") a.included = true;
    delete loaded.sections;
  }
  loaded.version = 2;
  // v1.3.0: ensure a `pocket` sub-state exists so older sessions get the
  // pocket-cert defaults without clobbering any per-user overrides.
  if (!loaded.pocket || typeof loaded.pocket !== "object") {
    loaded.pocket = { council: "Mid-Iowa Council", signature: "", defaultDate: "", troopIdents: ["96 B", "96 G"] };
  } else {
    if (typeof loaded.pocket.council !== "string") loaded.pocket.council = "Mid-Iowa Council";
    if (typeof loaded.pocket.signature !== "string") loaded.pocket.signature = "";
    if (typeof loaded.pocket.defaultDate !== "string") loaded.pocket.defaultDate = "";
    if (!Array.isArray(loaded.pocket.troopIdents)) loaded.pocket.troopIdents = ["96 B", "96 G"];
    loaded.pocket.troopIdents[0] = loaded.pocket.troopIdents[0] || "96 B";
    loaded.pocket.troopIdents[1] = loaded.pocket.troopIdents[1] || "96 G";
  }
  return loaded;
}

/** Derived: cached parsed troops. Rebuilt whenever CSVs change. */
let parsedTroops = [null, null];

// Cached JPEG bytes of the fleur-de-lis (loaded once on init).
let fleurBytes = null;

// Cached pdf-lib module (loaded on first PDF action).
let pdfLibPromise = null;
function loadPdfLib() {
  if (!pdfLibPromise) pdfLibPromise = import(PDF_LIB_URL);
  return pdfLibPromise;
}

// ---------- Utilities ----------

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function downloadBytes(bytes, filename, mime = "application/octet-stream") {
  const blob = new Blob([bytes], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function fetchBytes(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Fetch ${url}: ${resp.status}`);
  return new Uint8Array(await resp.arrayBuffer());
}

// ---------- CSV upload handling ----------

function updateSlotSummary(slot, parsed) {
  const el = $(`.troop-slot[data-slot="${slot}"] .dz-summary`);
  const dz = $(`.troop-slot[data-slot="${slot}"] .dropzone`);
  if (parsed) {
    el.textContent = `${parsed.scoutCount} scouts, ${parsed.itemCount} items`;
    dz.classList.add("loaded");
  } else {
    el.textContent = "";
    dz.classList.remove("loaded");
  }
}

async function handleCSVFile(slot, file) {
  const text = await file.text();
  state.troops[slot].filename = file.name;
  state.troops[slot].csvText = text;
  const labelInput = $(`.troop-slot[data-slot="${slot}"] input[data-field="troopLabel"]`);
  if (!labelInput.value.trim()) {
    labelInput.value = guessTroopLabel(file.name);
    state.troops[slot].troopLabel = labelInput.value;
  }
  reparseTroop(slot);
  refresh();
}

function reparseTroop(slot) {
  const s = state.troops[slot];
  if (!s.csvText) { parsedTroops[slot] = null; updateSlotSummary(slot, null); return; }
  const label = s.troopLabel || guessTroopLabel(s.filename) || `Troop ${slot + 1}`;
  parsedTroops[slot] = parsePO(s.csvText, label);
  updateSlotSummary(slot, parsedTroops[slot]);
}

function wireDropzones() {
  for (const slot of [0, 1]) {
    const root = $(`.troop-slot[data-slot="${slot}"]`);
    const dz = $(".dropzone", root);
    const fileInput = $('input[type="file"]', dz);
    const labelInput = $('input[data-field="troopLabel"]', root);

    dz.addEventListener("click", () => fileInput.click());
    dz.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") fileInput.click(); });
    dz.addEventListener("dragover", (e) => { e.preventDefault(); dz.classList.add("drag"); });
    dz.addEventListener("dragleave", () => dz.classList.remove("drag"));
    dz.addEventListener("drop", async (e) => {
      e.preventDefault();
      dz.classList.remove("drag");
      const file = e.dataTransfer.files[0];
      if (file) await handleCSVFile(slot, file);
    });
    fileInput.addEventListener("change", async (e) => {
      const file = e.target.files[0];
      if (file) await handleCSVFile(slot, file);
    });
    labelInput.addEventListener("input", (e) => {
      state.troops[slot].troopLabel = e.target.value;
      reparseTroop(slot);
      refresh();
    });

    // Load-sample buttons for quick demoing.
    const sampleBtn = $('[data-action="load-sample"]', root);
    if (sampleBtn) sampleBtn.addEventListener("click", async () => {
      const name = sampleBtn.dataset.sample;
      try {
        const resp = await fetch(`./test/${name}`);
        if (!resp.ok) throw new Error(`Sample ${name} not available: ${resp.status}`);
        const text = await resp.text();
        const fauxFile = new File([text], name, { type: "text/csv" });
        await handleCSVFile(slot, fauxFile);
      } catch (err) {
        alert(`Could not load sample: ${err.message}`);
      }
    });
  }
}

// ---------- Event / sections / grouping wiring ----------

function wireEventForm() {
  const bind = (id, path) => {
    const el = $(id);
    el.addEventListener("input", () => {
      const parts = path.split(".");
      let obj = state;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = el.value;
      refresh();
    });
  };
  bind("#ev-date", "event.date");
  bind("#ev-time", "event.time");
  bind("#ev-venue", "event.venue");
  bind("#ev-mc", "event.mcName");
  bind("#ev-smm", "event.scoutmasterMinute");
  bind("#ev-title", "event.title");
  bind("#ev-org", "event.org");
  // v1.2.3: whenever the MC field changes, live-update every MC-linked
  // presenter input in the agenda table (in place, so focus is preserved).
  $("#ev-mc").addEventListener("input", updateMcLinkedPresenterInputs);
}

function wireSections() {
  const bindSel = (id, key) => {
    const el = $(id);
    el.addEventListener("change", () => { state.grouping[key] = el.value; refresh(); });
  };
  bindSel("#grp-rank", "rank");
  bindSel("#grp-mb", "mb");
  bindSel("#grp-mbsort", "mbSort");
}

// ---------- Program Sections & Agenda editor ----------

/**
 * Render the merged agenda / program-sections table. Each row shows an
 * item label, presenter, and controls:
 *   - required rows: "Required" badge, no delete button
 *   - all other rows (kind: 'optional' or 'custom'): no badge, delete button
 * Every row supports up/down reordering and inline edits of both fields.
 * The 'optional' vs 'custom' distinction is kept under the hood so that
 * optional rows still generate a matching booklet content page; the UI
 * treats them identically.
 */
function renderAgenda() {
  const tbody = $("#agenda-table tbody");
  tbody.innerHTML = "";
  const mcName = String(state.event.mcName || "");
  state.agenda.forEach((row, idx) => {
    const tr = document.createElement("tr");
    tr.dataset.kind = row.kind || "custom";
    if (row.linkedTo === "mcName") tr.dataset.linkedTo = "mcName";
    const isRequired = row.kind === "required";
    const badge = isRequired
      ? `<span class="badge badge-required">Required</span>`
      : "";
    const delBtn = !isRequired
      ? `<button type="button" data-a="del" title="Delete">✕</button>`
      : "";
    // MC-linked rows: show the current MC name in the input (live-updated
    // by wireEventForm when the MC field changes), and expose a grey
    // "(MC name here)" placeholder when the MC name is blank. The stored
    // row.presenter stays "" while linked. Any keystroke breaks the link.
    const linked = row.linkedTo === "mcName";
    const presenterValue = linked ? mcName : (row.presenter || "");
    const presenterPlaceholder = linked ? MC_PLACEHOLDER : "";
    tr.innerHTML = `
      <td class="col-badge">${badge}</td>
      <td><input type="text" data-k="item" value="${escapeHtml(row.item)}" /></td>
      <td><input type="text" data-k="presenter" value="${escapeHtml(presenterValue)}" placeholder="${escapeHtml(presenterPlaceholder)}" /></td>
      <td class="row-actions">
        <button type="button" data-a="up" title="Move up">↑</button>
        <button type="button" data-a="down" title="Move down">↓</button>
        ${delBtn}
      </td>`;
    const itemInp = tr.querySelector('input[data-k="item"]');
    itemInp.addEventListener("input", () => { row.item = itemInp.value; refresh(); });
    const presInp = tr.querySelector('input[data-k="presenter"]');
    presInp.addEventListener("input", () => {
      // Any user input on the presenter cell breaks the MC link permanently
      // (v1.2.3: "once broken, stays broken"). If the field was MC-linked
      // the stored presenter until now was ""; from here on out we store
      // exactly what the user typed.
      if (row.linkedTo === "mcName") {
        delete row.linkedTo;
        tr.removeAttribute("data-linked-to");
        presInp.removeAttribute("placeholder");
      }
      row.presenter = presInp.value;
      refresh();
    });
    tr.querySelectorAll("button[data-a]").forEach((btn) => {
      btn.addEventListener("click", () => {
        const a = btn.dataset.a;
        if (a === "del" && !isRequired) state.agenda.splice(idx, 1);
        else if (a === "up" && idx > 0) [state.agenda[idx - 1], state.agenda[idx]] = [state.agenda[idx], state.agenda[idx - 1]];
        else if (a === "down" && idx < state.agenda.length - 1) [state.agenda[idx + 1], state.agenda[idx]] = [state.agenda[idx], state.agenda[idx + 1]];
        renderAgenda();
        refresh();
      });
    });
    tbody.appendChild(tr);
  });
}

/**
 * v1.2.3: When the Event Details MC field changes, live-update all
 * MC-linked presenter inputs in the agenda table without re-rendering the
 * whole tbody (so focus and cursor position are preserved).
 */
function updateMcLinkedPresenterInputs() {
  const mcName = String(state.event.mcName || "");
  const rows = $$('#agenda-table tbody tr[data-linked-to="mcName"]');
  for (const tr of rows) {
    const inp = tr.querySelector('input[data-k="presenter"]');
    if (inp && document.activeElement !== inp) inp.value = mcName;
  }
}

function wireAgenda() {
  $("#btn-add-agenda").addEventListener("click", () => {
    state.agenda.push({
      kind: "custom",
      key: `custom-${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`,
      item: "New item",
      presenter: "",
      included: true,
    });
    renderAgenda();
    refresh();
  });
}

function escapeHtml(s) {
  return String(s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// ---------- Model + preview ----------

function currentModel() {
  const roster = buildRoster(parsedTroops, {
    rankGrouping: state.grouping.rank,
    mbGrouping: state.grouping.mb,
    mbSort: state.grouping.mbSort,
  });
  // Agenda-page entries: every row still present in state.agenda. Since
  // v1.2.2 there is no include-checkbox — the user removes an unwanted row
  // via the delete button instead — so the presence of a row means "show".
  // Presenter is resolved via resolvePresenter(): MC-linked rows swap in
  // the current MC name (or a grey placeholder if it's blank), unlinked
  // rows print their stored value verbatim.
  const mcName = state.event.mcName;
  const agenda = state.agenda
    .filter((a) => a && a.item)
    .map((a) => {
      const p = resolvePresenter(a, mcName);
      return { item: a.item, presenter: p.text, presenterGrey: p.placeholder };
    });
  // Rows whose kind is "optional" still generate a matching booklet content
  // page (the "optional" bookkeeping distinguishes them from "custom" rows,
  // which are agenda-only). Custom rows are intentionally not rendered as
  // their own content pages.
  const optionals = state.agenda
    .filter((a) => a && a.kind === "optional" && a.item)
    .map((a) => ({ key: a.key, item: a.item }));
  return {
    event: {
      date: prettyDate(state.event.date),
      time: state.event.time,
      venue: state.event.venue,
      mcName: state.event.mcName,
      scoutmasterMinute: state.event.scoutmasterMinute,
      troopLabels: parsedTroops.filter(Boolean).map((t) => t.troopLabel),
    },
    agenda,
    optionals,
    roster,
    fleurBytes,
    coverTitle: state.event.title || "Court of Honor",
    org: state.event.org || "",
  };
}

function prettyDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

// Simple HTML preview — mirrors the source PDF structure. Not pixel-exact,
// but close enough for volunteers to verify content before printing.
function renderPreview() {
  const model = currentModel();
  const container = $("#preview");
  container.innerHTML = "";

  const addPage = (html) => {
    const p = document.createElement("section");
    p.className = "pv-page";
    p.innerHTML = html;
    container.appendChild(p);
    const idx = container.children.length;
    const num = document.createElement("div");
    num.className = "page-num";
    num.textContent = String(idx);
    p.appendChild(num);
  };

  // Cover
  const troopLine = (model.event.troopLabels || []).filter(Boolean).join("  &  ") || "Scout Troop";
  addPage(`
    <div style="height: 60px"></div>
    <p class="center" style="font-weight:700; font-size:18pt; margin:6px 0;">${escapeHtml(troopLine)}</p>
    <p class="center" style="font-size:11pt; margin:0 0 12px 0;">${escapeHtml(model.org)}</p>
    <img class="cover-img" src="./assets/fleur-de-lis.jpg" alt="" />
    <div class="cover-title">${escapeHtml(model.coverTitle)}</div>
    <p class="center" style="font-size:14pt;">${escapeHtml(model.event.date || "")}</p>
    <p class="center" style="font-size:12pt;">${escapeHtml(model.event.time || "")}</p>
    <div style="height: 20px"></div>
    ${(model.event.venue || "").split(/\r?\n/).map((l) => `<p class="center" style="font-size:12pt; margin:2px 0;">${escapeHtml(l)}</p>`).join("")}
  `);

  // Agenda
  addPage(`
    <h1>Program</h1>
    ${model.agenda.map((a) => {
      if (!a.presenter) return `<div class="agenda-line"><strong>${escapeHtml(a.item)}</strong></div>`;
      const cls = a.presenterGrey ? ' class="presenter-placeholder"' : "";
      return `<div class="agenda-line"><strong>${escapeHtml(a.item)}</strong>  —  <span${cls}>${escapeHtml(a.presenter)}</span></div>`;
    }).join("")}
  `);

  // Rank Advancement
  if (model.roster.rankSections.length) {
    let html = `<h1>Rank Advancement</h1>`;
    for (const sec of model.roster.rankSections) {
      if (sec.troopLabel) html += `<h2>${escapeHtml(sec.troopLabel)}</h2>`;
      for (const g of sec.groups) {
        html += `<h3>${escapeHtml(g.heading)}</h3><ul>${g.scouts.map((s) => `<li>${escapeHtml(s.first + " " + s.last)}</li>`).join("")}</ul>`;
      }
    }
    addPage(html);
  }

  // Merit Badges
  if (model.roster.mbSections.length) {
    let html = `<h1>Merit Badges</h1>`;
    for (const sec of model.roster.mbSections) {
      if (sec.troopLabel) html += `<h2>${escapeHtml(sec.troopLabel)}</h2>`;
      for (const line of sec.lines) {
        html += `<div class="scout-line"><strong>${escapeHtml(line.first + " " + line.last)}</strong> — ${escapeHtml(line.items.join(", "))}</div>`;
      }
    }
    addPage(html);
  }

  // Optional sections are NOT rendered as their own booklet pages —
  // they appear as line items on the "Program" agenda page above.

  // Oath & Law
  addPage(`
    <h1>Scout Oath</h1>
    <p class="center">On my honor I will do my best</p>
    <p class="center">to do my duty to God and my country</p>
    <p class="center">and to obey the Scout Law;</p>
    <p class="center">to help other people at all times;</p>
    <p class="center">to keep myself physically strong,</p>
    <p class="center">mentally awake, and morally straight.</p>
    <div style="height: 24px"></div>
    <h1>Scout Law</h1>
    <p class="center">A Scout is trustworthy, loyal, helpful, friendly,</p>
    <p class="center">courteous, kind, obedient, cheerful, thrifty,</p>
    <p class="center">brave, clean, and reverent.</p>
  `);

  // Acknowledgments
  const troops = (model.event.troopLabels || []).filter(Boolean);
  const troopsPhrase = troops.length ? troops.join(" and ") : "our troops";
  addPage(`
    <h1>Acknowledgments</h1>
    <p>With gratitude to:</p>
    <ul>
      <li>Our chartered organization and meeting home</li>
      <li>Mid-Iowa Council, Boy Scouts of America</li>
      <li>The Scoutmasters, Assistant Scoutmasters, and Committee members of ${escapeHtml(troopsPhrase)}</li>
      <li>Merit badge counselors who make advancement possible</li>
      <li>Parents and families whose support drives every Scout's journey</li>
      <li>Every Scout — for your effort, leadership, and Scout Spirit</li>
    </ul>
    <div style="height: 18px"></div>
    <p class="center" style="font-weight:700; font-size:12pt;">Congratulations to all Scouts recognized tonight!</p>
  `);

  // Update download-enabled state
  const anyTroop = parsedTroops.some(Boolean);
  $("#btn-source").disabled = !anyTroop;
  $("#btn-booklet").disabled = !anyTroop;

  // v1.3.0: refresh pocket cert button labels / enablement.
  updatePocketButtons();
}

// ---------- Pocket certificates (v1.3.0) ----------

/**
 * Recompute the MB row count for a slot from its parsed troop, and update
 * the corresponding download button's label + disabled state. Called on
 * every refresh() so any change to CSVs / troop labels / event date is
 * reflected in the button copy live.
 */
function updatePocketButtons() {
  for (const slot of [0, 1]) {
    const btn = $(`#btn-pocket-${slot === 0 ? "a" : "b"}`);
    if (!btn) continue;
    const troop = parsedTroops[slot];
    const label = state.troops[slot]?.troopLabel || (slot === 0 ? "Boys Troop" : "Girls Troop");
    if (!troop || !state.troops[slot]?.csvText) {
      btn.disabled = true;
      btn.textContent = `Download ${label} Pocket Certificates PDF`;
      continue;
    }
    const rows = extractMeritBadgeRows(state.troops[slot].csvText);
    const sheets = pocketCertSheetCount(rows.length);
    btn.disabled = rows.length === 0;
    btn.textContent = rows.length === 0
      ? `Download ${label} Pocket Certificates PDF (no MB items)`
      : `Download ${label} Pocket Certificates PDF (${rows.length} cards on ${sheets} sheet${sheets === 1 ? "" : "s"})`;
  }
}

/** Format an ISO YYYY-MM-DD into "Month D, YYYY" (used as the default date). */
function prettyDateForPocket(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-").map(Number);
  if (!y) return iso;
  const dt = new Date(y, (m || 1) - 1, d || 1);
  return dt.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });
}

/** Resolve the default date for pocket-cert rows that have no per-row date. */
function pocketDefaultDate() {
  const explicit = (state.pocket.defaultDate || "").trim();
  const iso = explicit || state.event.date || "";
  return prettyDateForPocket(iso);
}

/** Sanitize a troop label for use in a filename. "Troop 96B" → "Troop-96B". */
function slugForFilename(s) {
  return String(s || "troop").replace(/[^\w-]+/g, "-").replace(/^-+|-+$/g, "") || "troop";
}

async function downloadPocketCertsForSlot(slot) {
  const status = $("#pc-status");
  const troop = parsedTroops[slot];
  if (!troop || !state.troops[slot]?.csvText) {
    status.textContent = "Upload the PO for that troop first.";
    return;
  }
  const rows = extractMeritBadgeRows(state.troops[slot].csvText);
  if (!rows.length) {
    status.textContent = "No merit-badge rows found in that PO.";
    return;
  }
  const label = state.troops[slot].troopLabel || (slot === 0 ? "Boys Troop" : "Girls Troop");
  status.textContent = `Building ${label} pocket certificates…`;
  try {
    const pdfLib = await loadPdfLib();
    const bytes = await buildPocketCertsPDF(rows, {
      defaultDate: pocketDefaultDate(),
      troop: state.pocket.troopIdents[slot] || "",
      council: state.pocket.council || "",
      signature: state.pocket.signature || "",
    }, pdfLib);
    downloadBytes(bytes, `${slugForFilename(label)}-pocket-certificates.pdf`, "application/pdf");
    const sheets = pocketCertSheetCount(rows.length);
    status.textContent = `${label} pocket certificates downloaded (${rows.length} cards on ${sheets} sheet${sheets === 1 ? "" : "s"}). Print at 100% scale, no fit-to-page, then cut on the grey guides.`;
  } catch (err) {
    console.error(err);
    status.textContent = "Failed: " + err.message;
  }
}

function wirePocketCerts() {
  const bind = (id, path) => {
    const el = $(id);
    el.addEventListener("input", () => {
      const parts = path.split(".");
      let obj = state;
      for (let i = 0; i < parts.length - 1; i++) obj = obj[parts[i]];
      obj[parts[parts.length - 1]] = el.value;
      refresh();
    });
  };
  bind("#pc-council", "pocket.council");
  bind("#pc-signature", "pocket.signature");
  bind("#pc-default-date", "pocket.defaultDate");
  const troopA = $("#pc-troop-a");
  const troopB = $("#pc-troop-b");
  troopA.addEventListener("input", () => { state.pocket.troopIdents[0] = troopA.value; });
  troopB.addEventListener("input", () => { state.pocket.troopIdents[1] = troopB.value; });
  $("#btn-pocket-a").addEventListener("click", () => downloadPocketCertsForSlot(0));
  $("#btn-pocket-b").addEventListener("click", () => downloadPocketCertsForSlot(1));
}

// ---------- PDF downloads ----------

function wireDownloads() {
  $("#btn-source").addEventListener("click", async () => {
    const status = $("#dl-status");
    status.textContent = "Building source PDF…";
    try {
      const pdfLib = await loadPdfLib();
      const bytes = await buildSourcePDF(currentModel(), pdfLib);
      downloadBytes(bytes, `coh-program-source-${(state.event.date || "undated")}.pdf`, "application/pdf");
      status.textContent = "Source PDF downloaded.";
    } catch (err) {
      console.error(err);
      status.textContent = "Failed: " + err.message;
    }
  });
  $("#btn-booklet").addEventListener("click", async () => {
    const status = $("#dl-status");
    status.textContent = "Building booklet PDF…";
    try {
      const pdfLib = await loadPdfLib();
      const src = await buildSourcePDF(currentModel(), pdfLib);
      const bytes = await buildBookletPDF(src, pdfLib);
      downloadBytes(bytes, `coh-program-booklet-${(state.event.date || "undated")}.pdf`, "application/pdf");
      status.textContent = "Booklet PDF downloaded. Print duplex long-edge (the printer default), US Letter, no scaling, then fold each sheet in half along the vertical center.";
    } catch (err) {
      console.error(err);
      status.textContent = "Failed: " + err.message;
    }
  });
}

// ---------- Save / load session ----------

function wireSaveLoad() {
  $("#btn-save").addEventListener("click", () => {
    // Deep copy state (already serializable).
    const blob = JSON.stringify(state, null, 2);
    downloadBytes(new TextEncoder().encode(blob), `coh-session-${state.event.date || "draft"}.json`, "application/json");
  });
  $("#load-session").addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      const loaded = migrateSession(JSON.parse(text));
      // Merge into state (loose validation — the migrator does the heavy lifting).
      Object.assign(state, loaded);
      hydrateForm();
      for (const slot of [0, 1]) reparseTroop(slot);
      renderAgenda();
      refresh();
    } catch (err) {
      alert("Could not load session: " + err.message);
    } finally {
      e.target.value = "";
    }
  });
}

// Push current state into form fields (used after load).
function hydrateForm() {
  for (const slot of [0, 1]) {
    const root = $(`.troop-slot[data-slot="${slot}"]`);
    $('input[data-field="troopLabel"]', root).value = state.troops[slot]?.troopLabel || "";
  }
  $("#ev-date").value = state.event.date || "";
  $("#ev-time").value = state.event.time || "";
  $("#ev-venue").value = state.event.venue || "";
  $("#ev-mc").value = state.event.mcName || "";
  $("#ev-smm").value = state.event.scoutmasterMinute || "";
  $("#ev-title").value = state.event.title || "";
  $("#ev-org").value = state.event.org || "";
  $("#grp-rank").value = state.grouping.rank;
  $("#grp-mb").value = state.grouping.mb;
  $("#grp-mbsort").value = state.grouping.mbSort;
  // Pocket-cert fields (v1.3.0).
  $("#pc-council").value = state.pocket?.council ?? "Mid-Iowa Council";
  $("#pc-signature").value = state.pocket?.signature ?? "";
  $("#pc-default-date").value = state.pocket?.defaultDate ?? "";
  $("#pc-troop-a").value = state.pocket?.troopIdents?.[0] ?? "96 B";
  $("#pc-troop-b").value = state.pocket?.troopIdents?.[1] ?? "96 G";
}

// ---------- Refresh (debounced) ----------

const refresh = debounce(() => renderPreview(), 80);

// ---------- Init ----------

async function init() {
  wireDropzones();
  wireEventForm();
  wireSections();
  wireAgenda();
  renderAgenda();
  wireDownloads();
  wirePocketCerts();
  wireSaveLoad();
  hydrateForm();

  try {
    fleurBytes = await fetchBytes("./assets/fleur-de-lis.jpg");
  } catch (err) {
    console.warn("Could not load fleur-de-lis asset; cover will lack the logo.", err);
  }

  renderPreview();
}

init();
