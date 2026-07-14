// ── NOT MINE (Sheet tab I/O) ─────────────────────────────────────────────────
// One row per opt-out a person records via the "Not mine" / "None of these
// are mine" buttons on a statement-chase DM. Two scopes:
//   "charge" — this person is never offered THIS specific clusterKey again
//              (e.g. a recurring subscription they've dismissed before).
//   "all"    — this person is never selected as a likely owner for ANY
//              charge in future statement runs (a durable per-person opt-out).
//
// Column order: user_id · user_name · scope (charge|all) · cluster_key
// (blank when scope=all) · declared_at (ISO)
//
// Same singleton + queue patterns as statementChase.js / ledger.js.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

export const TAB_NAME = "Not Mine";
const DATA_RANGE = `'${TAB_NAME}'!A2:E`;

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

export async function getNotMineEntries(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    userId:     String(row[0] ?? "").trim(),
    userName:   String(row[1] ?? "").trim(),
    scope:      String(row[2] ?? "").trim(),
    clusterKey: String(row[3] ?? "").trim(),
    declaredAt: String(row[4] ?? "").trim(),
    rowNumber:  i + 2,
  }));
}

export function buildNotMineRow(entry) {
  return [
    String(entry.userId ?? ""),
    String(entry.userName ?? ""),
    String(entry.scope ?? ""),
    String(entry.clusterKey ?? ""),
    String(entry.declaredAt ?? new Date().toISOString()),
  ];
}

let _queue = Promise.resolve();
function enqueue(fn) {
  const task = _queue.then(fn);
  _queue = task.then(() => {}, (e) => console.error("Not Mine write error:", e.message));
  return task;
}

export function appendNotMineEntry(sheetId, entry) {
  return enqueue(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildNotMineRow(entry)] },
    })
  );
}

// Pure decision helper — given the full list of Not Mine entries and a
// candidate (userId, clusterKey), is this person excluded from being offered
// this charge? True if they've opted out of everything, or this specific
// charge by clusterKey.
export function isExcluded(notMineEntries, { userId, clusterKey }) {
  return (notMineEntries || []).some((e) => {
    if (e.userId !== userId) return false;
    if (e.scope === "all") return true;
    if (e.scope === "charge" && e.clusterKey === clusterKey) return true;
    return false;
  });
}
