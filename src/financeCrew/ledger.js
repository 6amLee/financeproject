// ── FINANCECREW LEDGER (learning-ledger Sheet tab read) ─────────────────────
// Reads the "FinanceCrew Ledger" tab: one row per resolution, the record
// resolver.js's card/vendor history learning consumes. Column order:
//   vendor · card · resolved_owner (comma-joined if multiple) ·
//   resolved_at (ISO string) · resolution_source · confirmed (TRUE/FALSE)
//
// Read-only — nothing in the live pipeline writes to this tab yet (the write
// side, appendLedgerEntry, was never wired to anything and was removed).

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

const TAB_NAME = "FinanceCrew Ledger";
// Row 1 is the header; data starts at A2.
const DATA_RANGE = `'${TAB_NAME}'!A2:F`;

// Deliberately duplicates the 3-line singleton getter from src/sheets.js
// instead of extracting a shared helper: pulling one out would mean touching
// the live Master DB code path for the sake of three lines, which fails the
// "only refactor if obviously correct and risk-free" bar. Each module keeps
// its own lazily-built client over the same shared getGoogleAuth() singleton.
let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

// Sheets stores booleans as the strings TRUE/FALSE; anything else (blank,
// junk) parses as false — an unconfirmable ledger row must never teach the
// resolver anything.
function parseConfirmed(v) {
  return /^true$/i.test(String(v ?? "").trim());
}

function splitOwners(raw) {
  return String(raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

// Reads the full ledger tab into the record shape resolver.js consumes:
// { vendor, card, resolvedOwner: string[], resolvedAt, resolutionSource,
//   confirmed: boolean }.
export async function getLedgerEntries(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row) => ({
    vendor: String(row[0] ?? "").trim(),
    card: String(row[1] ?? "").trim(),
    resolvedOwner: splitOwners(row[2]),
    resolvedAt: String(row[3] ?? "").trim(),
    resolutionSource: String(row[4] ?? "").trim(),
    confirmed: parseConfirmed(row[5]),
  }));
}
