// data.js — CSV parsing + roster normalization for Court of Honor programs.
// Runs unmodified in the browser and in Node (ES module, no DOM/Node APIs).
//
// Input:  Scoutbook Purchase Order CSV text (First Name, Last Name, Item Type, Item Name, ...)
// Output: normalized { ranks, meritBadges, misc } model per troop, plus helpers
//         to build a combined roster with the user's grouping/sorting options.
//
// Ported from data/courts-of-honor/07-27-2026/build_program_v2.py.

export const RANK_ORDER = [
  "Scout",
  "Tenderfoot",
  "Second Class",
  "First Class",
  "Star",
  "Life",
  "Eagle",
  "Eagle Palm",
];

// Display forms (for headings). Base rank -> pretty name.
export const RANK_DISPLAY = {
  "Scout": "Scout",
  "Tenderfoot": "Tenderfoot",
  "Second Class": "Second Class",
  "First Class": "First Class",
  "Star": "Star Scout",
  "Life": "Life Scout",
  "Eagle": "Eagle Scout",
  "Eagle Palm": "Eagle Palm",
};

// Suffixes stripped from item names for display (order matters: longest first).
const ITEM_SUFFIXES = [
  " MB Emblem",
  " Rank Emblem",
  " Emblem",
  " Rank",
  " (Scouts BSA)",
  " (Silver)",
  " (Gold)",
  " (Bronze)",
];

// Items whose color qualifier is meaningful (do NOT strip). If the item's
// base name (everything before " (Color)") is in this set, we keep the color
// suffix — e.g. "Eagle Palm Pin (Gold)" must NOT become "Eagle Palm Pin"
// because Bronze / Gold / Silver distinguish Eagle Palm awards.
const KEEP_COLOR_QUALIFIER_BASES = new Set([
  "Eagle Palm Pin",
  "Eagle Palm",
]);

const COLOR_SUFFIX_RE = /\s+\((Gold|Silver|Bronze)\)$/;

/** Strip trailing decorative text so "Camping MB Emblem" -> "Camping". */
export function cleanItem(name) {
  let n = (name || "").trim();
  // Repeatedly strip until no known suffix matches (some items have two).
  let changed = true;
  while (changed) {
    changed = false;
    for (const suf of ITEM_SUFFIXES) {
      if (n.endsWith(suf)) {
        // If this is a color qualifier and the base name is one where color
        // is meaningful (Eagle Palms), don't strip.
        const colorMatch = suf.match(COLOR_SUFFIX_RE);
        if (colorMatch) {
          const base = n.slice(0, -suf.length).trim();
          if (KEEP_COLOR_QUALIFIER_BASES.has(base)) continue;
        }
        n = n.slice(0, -suf.length).trim();
        changed = true;
      }
    }
  }
  return n;
}

/** Map a Scoutbook rank string like "Life Scout" to the canonical base rank. */
export function normalizeRank(name) {
  const cleaned = cleanItem(name);
  for (const r of RANK_ORDER) {
    if (cleaned.startsWith(r)) return r;
  }
  return cleaned;
}

// --- Minimal RFC-4180-ish CSV parser (supports quoted fields with embedded commas / quotes) ---
export function parseCSV(text) {
  // Strip BOM
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = [];
  let field = "";
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else { inQuotes = false; }
      } else {
        field += c;
      }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c === "\r") { /* swallow, \n follows */ }
      else field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (rows.length === 0) return { headers: [], records: [] };
  const headers = rows[0].map((h) => h.trim());
  const records = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === "") continue; // skip blanks
    const rec = {};
    for (let c = 0; c < headers.length; c++) rec[headers[c]] = (rows[r][c] || "").trim();
    records.push(rec);
  }
  return { headers, records };
}

/**
 * Parse one PO CSV into a normalized troop model.
 *   troop.ranks:       Array<{ first, last, rank, rawRank }>
 *   troop.meritBadges: Map<"last|first", { first, last, items: string[] }>
 *   troop.misc:        Map<"last|first", { first, last, items: string[] }>
 *   troop.scoutCount:  number (unique scouts)
 *   troop.itemCount:   number (total data rows we recognized)
 */
export function parsePO(csvText, troopLabel = "") {
  const { records } = parseCSV(csvText);
  const ranks = [];
  const meritBadges = new Map();
  const misc = new Map();
  const scouts = new Set();
  let itemCount = 0;

  const ensure = (map, first, last) => {
    const key = `${last}|${first}`;
    if (!map.has(key)) map.set(key, { first, last, items: [] });
    return map.get(key);
  };

  for (const row of records) {
    const first = (row["First Name"] || "").trim();
    const last = (row["Last Name"] || "").trim();
    if (!first && !last) continue;
    const itype = (row["Item Type"] || "").trim();
    const raw = (row["Item Name"] || "").trim();
    if (!itype || !raw) continue;
    const clean = cleanItem(raw);
    scouts.add(`${last}|${first}`);
    itemCount++;
    if (itype === "Badges of Rank") {
      ranks.push({ first, last, rank: normalizeRank(raw), rawRank: clean });
    } else if (itype === "Merit Badges") {
      ensure(meritBadges, first, last).items.push(clean);
    } else if (itype === "Misc Awards") {
      ensure(misc, first, last).items.push(clean);
    }
  }
  return {
    troopLabel,
    ranks,
    meritBadges,
    misc,
    scoutCount: scouts.size,
    itemCount,
  };
}

/**
 * Extract one entry per Merit Badge row for pocket-cert generation (v1.3.0).
 *
 * Returns an ordered list of `{ scoutName, firstName, lastName, badge, dateEarned }`,
 * one per MB item in the PO CSV. Rank rows, misc-award rows, and rows with
 * blank Item Type are excluded. Badge names have BSA store suffixes stripped
 * ("Camping MB Emblem" → "Camping"). Date is passed through as the string
 * exactly as it appears in the CSV (YYYY-MM-DD from Scoutbook exports); an
 * empty string means "no date on this row — use the default".
 *
 * Ordered by (last, first, badge) so the printed sheets group by scout.
 */
export function extractMeritBadgeRows(csvText) {
  const { records } = parseCSV(csvText);
  const rows = [];
  for (const row of records) {
    const first = (row["First Name"] || "").trim();
    const last = (row["Last Name"] || "").trim();
    if (!first && !last) continue;
    const itype = (row["Item Type"] || "").trim();
    if (itype !== "Merit Badges") continue;
    const raw = (row["Item Name"] || "").trim();
    if (!raw) continue;
    const badge = cleanItem(raw);
    const dateEarned = (row["Date Earned"] || "").trim();
    rows.push({
      scoutName: `${first} ${last}`.trim(),
      firstName: first,
      lastName: last,
      badge,
      dateEarned,
    });
  }
  rows.sort((a, b) =>
    (a.lastName || "").localeCompare(b.lastName || "") ||
    (a.firstName || "").localeCompare(b.firstName || "") ||
    a.badge.localeCompare(b.badge)
  );
  return rows;
}

/** Guess a display label from a filename like "PO_T96BT_1103345.csv" -> "Troop 96B". */
export function guessTroopLabel(filename) {
  if (!filename) return "";
  const m = filename.match(/PO_T(\d+)([A-Z]+)(?:_|\.)/i);
  if (!m) return "";
  const num = m[1];
  const suf = m[2].toUpperCase();
  // Common Scoutbook conventions: BT = Boys Troop, GT = Girls Troop.
  if (suf === "BT") return `Troop ${num}B`;
  if (suf === "GT") return `Troop ${num}G`;
  return `Troop ${num}${suf}`;
}

/**
 * Given zero, one, or two parsed troops, return grouped views suitable for
 * rendering. `opts` mirrors the UI:
 *   rankGrouping:   "combined" | "byTroop"
 *   mbGrouping:     "combined" | "byTroop"
 *   mbSort:         "last" | "first"
 */
export function buildRoster(troops, opts) {
  const active = troops.filter(Boolean);
  const rankGrouping = opts?.rankGrouping || "combined";
  const mbGrouping = opts?.mbGrouping || "combined";
  const mbSort = opts?.mbSort || "last";

  const cmpLast = (a, b) =>
    (a.last || "").localeCompare(b.last || "") ||
    (a.first || "").localeCompare(b.first || "");
  const cmpFirst = (a, b) =>
    (a.first || "").localeCompare(b.first || "") ||
    (a.last || "").localeCompare(b.last || "");
  const scoutCmp = mbSort === "first" ? cmpFirst : cmpLast;

  // --- Rank advancement view ---
  function ranksByRank(rankRows) {
    const buckets = new Map();
    for (const r of rankRows) {
      const key = r.rank;
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    const groups = [];
    for (const rank of RANK_ORDER) {
      if (!buckets.has(rank)) continue;
      const scouts = buckets.get(rank).slice().sort(cmpLast);
      groups.push({ heading: RANK_DISPLAY[rank] || rank, scouts });
    }
    // Any unknown ranks (shouldn't normally happen) — append at end.
    for (const [rank, scouts] of buckets) {
      if (!RANK_ORDER.includes(rank))
        groups.push({ heading: rank, scouts: scouts.slice().sort(cmpLast) });
    }
    return groups;
  }

  const rankSections = [];
  if (rankGrouping === "byTroop") {
    for (const t of active) {
      const groups = ranksByRank(t.ranks);
      if (groups.length) rankSections.push({ troopLabel: t.troopLabel, groups });
    }
  } else {
    const combined = active.flatMap((t) => t.ranks);
    const groups = ranksByRank(combined);
    if (groups.length) rankSections.push({ troopLabel: null, groups });
  }

  // --- Merit badge view (per-scout inline with misc appended) ---
  function scoutLinesFrom(troop) {
    const keys = new Set([...troop.meritBadges.keys(), ...troop.misc.keys()]);
    const lines = [];
    for (const key of keys) {
      const mb = troop.meritBadges.get(key);
      const mi = troop.misc.get(key);
      const src = mb || mi;
      const mbItems = mb ? [...mb.items].sort((a, b) => a.localeCompare(b)) : [];
      const miItems = mi ? [...mi.items].sort((a, b) => a.localeCompare(b)) : [];
      const all = [...mbItems, ...miItems];
      if (all.length === 0) continue;
      lines.push({ first: src.first, last: src.last, items: all });
    }
    lines.sort(scoutCmp);
    return lines;
  }

  const mbSections = [];
  if (mbGrouping === "byTroop") {
    for (const t of active) {
      const lines = scoutLinesFrom(t);
      if (lines.length) mbSections.push({ troopLabel: t.troopLabel, lines });
    }
  } else {
    // Merge troops into one virtual troop.
    const merged = { meritBadges: new Map(), misc: new Map() };
    const mergeInto = (dst, src) => {
      for (const [k, v] of src) {
        if (!dst.has(k)) dst.set(k, { first: v.first, last: v.last, items: [] });
        dst.get(k).items.push(...v.items);
      }
    };
    for (const t of active) {
      mergeInto(merged.meritBadges, t.meritBadges);
      mergeInto(merged.misc, t.misc);
    }
    const lines = scoutLinesFrom(merged);
    if (lines.length) mbSections.push({ troopLabel: null, lines });
  }

  return {
    troopLabels: active.map((t) => t.troopLabel),
    rankSections,
    mbSections,
  };
}
