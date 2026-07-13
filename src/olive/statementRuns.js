// ── STATEMENT RUNS (Sheet tab I/O) ────────────────────────────────────────────
// One row per statement file Yulia uploads. Stores the Drive file ID of the
// original Excel so the nudge cycle can re-download it for re-matching and
// coloring. Column order:
//   run_id · channel_id · message_ts · drive_file_id · started_at · status
//
// status values: "active" | "complete" | "all_resolved"

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

export const TAB_NAME = "Statement Runs";
const DATA_RANGE = `'${TAB_NAME}'!A2:F`;

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

export async function getStatementRuns(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    runId:       String(row[0] ?? "").trim(),
    channelId:   String(row[1] ?? "").trim(),
    messageTs:   String(row[2] ?? "").trim(),
    driveFileId: String(row[3] ?? "").trim(),
    startedAt:   String(row[4] ?? "").trim(),
    status:      String(row[5] ?? "active").trim() || "active",
    rowNumber:   i + 2,
  }));
}

export function buildStatementRunRow(run) {
  return [
    String(run.runId ?? ""),
    String(run.channelId ?? ""),
    String(run.messageTs ?? ""),
    String(run.driveFileId ?? ""),
    String(run.startedAt ?? new Date().toISOString()),
    String(run.status ?? "active"),
  ];
}

let _queue = Promise.resolve();
function enqueue(fn) {
  const task = _queue.then(fn);
  _queue = task.then(() => {}, (e) => console.error("Statement runs write error:", e.message));
  return task;
}

export function appendStatementRun(sheetId, run) {
  return enqueue(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildStatementRunRow(run)] },
    })
  );
}

export function updateStatementRun(sheetId, rowNumber, run) {
  return enqueue(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A${rowNumber}:F${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [buildStatementRunRow(run)] },
    })
  );
}
