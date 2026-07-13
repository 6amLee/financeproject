// ── STATEMENT CHASE THREADS (Sheet tab I/O) ───────────────────────────────────
// One row per person per statement run being chased. Tracks the DM thread
// Olive opened, the nudge count, and the JSON list of still-pending charges.
//
// Column order:
//   run_id · user_name · user_id · dm_channel_id · thread_ts ·
//   nudge_count · last_nudge_at · pending_charges (JSON) · resolved
//
// Same singleton + queue patterns as chaseState.js / ledger.js.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

export const TAB_NAME = "Statement Chase Threads";
const DATA_RANGE = `'${TAB_NAME}'!A2:I`;

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

function parseBool(v) {
  return /^true$/i.test(String(v ?? "").trim());
}

export async function getStatementChaseThreads(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    runId:          String(row[0] ?? "").trim(),
    userName:       String(row[1] ?? "").trim(),
    userId:         String(row[2] ?? "").trim(),
    dmChannelId:    String(row[3] ?? "").trim(),
    threadTs:       String(row[4] ?? "").trim(),
    nudgeCount:     Number(row[5] ?? 0) || 0,
    lastNudgeAt:    String(row[6] ?? "").trim(),
    pendingCharges: (() => { try { return JSON.parse(row[7] ?? "[]"); } catch { return []; } })(),
    resolved:       parseBool(row[8]),
    rowNumber:      i + 2,
  }));
}

export function buildStatementChaseRow(thread) {
  return [
    String(thread.runId ?? ""),
    String(thread.userName ?? ""),
    String(thread.userId ?? ""),
    String(thread.dmChannelId ?? ""),
    String(thread.threadTs ?? ""),
    String(thread.nudgeCount ?? 0),
    String(thread.lastNudgeAt ?? ""),
    JSON.stringify(thread.pendingCharges ?? []),
    thread.resolved ? "TRUE" : "FALSE",
  ];
}

let _queue = Promise.resolve();
function enqueue(fn) {
  const task = _queue.then(fn);
  _queue = task.then(() => {}, (e) => console.error("Statement chase write error:", e.message));
  return task;
}

export function appendStatementChaseThread(sheetId, thread) {
  return enqueue(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildStatementChaseRow(thread)] },
    })
  );
}

export function updateStatementChaseThread(sheetId, rowNumber, thread) {
  return enqueue(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A${rowNumber}:I${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [buildStatementChaseRow(thread)] },
    })
  );
}
