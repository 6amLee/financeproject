// ── RACHEL CHASE STATE (Sheet tab I/O) ───────────────────────────────────────
// Read/write the "Rachel Chase State" tab: one row per unmatched-charge
// cluster being chased, persisting the Stage 3 state machine between poll
// ticks (and across restarts — lastNudgeAt in the sheet is what stops a
// restarted process from re-firing a nudge that already went out). Column
// order per the design doc's Stage 3 section:
//   cluster_id · vendor · amount · stage (1-4) · stage_entered_at (ISO) ·
//   last_nudge_at (ISO, blank until first nudge) · resolved (TRUE/FALSE)
//
// New sibling module rather than additions to ledger.js: same granularity
// (one module per Rachel tab), same patterns as ledger.js/sheets.js — pure
// row builder separate from I/O, lazily-built singleton client over the
// shared getGoogleAuth(), promise-queue-serialised writes.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

const TAB_NAME = "Rachel Chase State";
// Row 1 is the header; data starts at A2.
const DATA_RANGE = `'${TAB_NAME}'!A2:G`;

// Same deliberate 3-line duplication as ledger.js (see the comment there):
// each tab module keeps its own lazily-built client over the shared auth
// singleton rather than touching the live Master DB code path.
let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

// Sheets stores booleans as the strings TRUE/FALSE; blank/junk → false.
function parseBool(v) {
  return /^true$/i.test(String(v ?? "").trim());
}

function parseNumber(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return String(v ?? "").trim() === "" || Number.isNaN(n) ? null : n;
}

// Reads the full tab into the clusterState shape chase.js's nextChaseAction
// consumes, plus `rowNumber` (1-based sheet row) so updates can target the
// row in place.
export async function getChaseStates(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    clusterId: String(row[0] ?? "").trim(),
    vendor: String(row[1] ?? "").trim(),
    amount: parseNumber(row[2]),
    stage: parseNumber(row[3]) ?? 1,
    stageEnteredAt: String(row[4] ?? "").trim(),
    lastNudgeAt: String(row[5] ?? "").trim(),
    resolved: parseBool(row[6]),
    rowNumber: i + 2, // data starts at sheet row 2
  }));
}

// Pure row builder, separate from the write I/O (same pattern as
// sheets.js buildReceiptRow / ledger.js buildLedgerRow).
export function buildChaseStateRow(state) {
  return [
    String(state.clusterId ?? ""),
    String(state.vendor ?? ""),
    state.amount === null || state.amount === undefined ? "" : String(state.amount),
    String(state.stage ?? 1),
    String(state.stageEnteredAt ?? ""),
    String(state.lastNudgeAt ?? ""),
    state.resolved ? "TRUE" : "FALSE",
  ];
}

// One queue for BOTH appends and in-place updates to this tab: an update
// racing an append on the same tab is exactly the interleaving the queue
// exists to prevent. Separate from sheets.js's and ledger.js's queues for
// the same reason theirs are separate from each other (different tabs).
let _chaseWriteQueue = Promise.resolve();

function enqueue(fn) {
  const task = _chaseWriteQueue.then(fn);
  // Keep the queue alive even if this write fails; the error still
  // propagates to the caller via `task`.
  _chaseWriteQueue = task.then(
    () => {},
    (e) => console.error("Chase state write error:", e.message)
  );
  return task;
}

export function appendChaseState(sheetId, state) {
  return enqueue(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildChaseStateRow(state)] },
    })
  );
}

// In-place update of an existing state row (rowNumber from getChaseStates).
export function updateChaseState(sheetId, rowNumber, state) {
  return enqueue(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A${rowNumber}:G${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [buildChaseStateRow(state)] },
    })
  );
}
