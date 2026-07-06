// ── RAMBO LEDGER (learning-ledger Sheet tab I/O) ────────────────────────────
// Read/write the "Rambo Ledger" tab: one row per resolution, the
// self-maintaining record Stage 2's resolver learns from. Column order:
//   vendor · card · resolved_owner (comma-joined if multiple) ·
//   resolved_at (ISO string) · resolution_source · confirmed (TRUE/FALSE)
//
// Follows src/sheets.js's exact patterns: pure builder separate from I/O,
// singleton sheets client, promise-queue-serialised appends.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

const TAB_NAME = "Rambo Ledger";
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

// Pure row builder, separate from the append I/O (same pattern as
// sheets.js's buildReceiptRow). Accepts resolvedOwner as array or string.
export function buildLedgerRow(entry) {
  const owners = Array.isArray(entry.resolvedOwner)
    ? entry.resolvedOwner
    : splitOwners(entry.resolvedOwner);
  return [
    String(entry.vendor ?? ""),
    String(entry.card ?? ""),
    owners.join(", "),
    String(entry.resolvedAt ?? new Date().toISOString()),
    String(entry.resolutionSource ?? ""),
    entry.confirmed ? "TRUE" : "FALSE",
  ];
}

// The ledger has its OWN write queue, deliberately separate from sheets.js's
// _sheetsWriteQueue: ledger appends and Master DB receipt appends target
// different tabs, so serialising them against each other would only add
// latency. Appends to THIS tab still serialise among themselves, which is
// the property the queue exists for.
let _ledgerWriteQueue = Promise.resolve();

export function appendLedgerEntry(sheetId, entry) {
  const task = _ledgerWriteQueue.then(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildLedgerRow(entry)] },
    })
  );
  // Keep the queue alive even if this append fails; the error still
  // propagates to the caller via `task`.
  _ledgerWriteQueue = task.then(
    () => {},
    (e) => console.error("Ledger append error:", e.message)
  );
  return task;
}
