// ── STATEMENT CHASE THREADS (Sheet tab I/O) ───────────────────────────────────
// One row per person per statement run being chased. Tracks the DM thread
// FinanceCrew opened, the nudge count, and the JSON list of still-pending charges.
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

// Atomic remove-one-charge (or resolve-everything): re-reads the row fresh
// from the sheet and writes back INSIDE the same queued task, so two "Not
// mine" clicks arriving close together can never both read the same stale
// pendingCharges and have the second silently undo the first. Returns the
// updated thread, or null if no matching open thread exists.
//
// scope "charge": drop clusterKey from pendingCharges; resolved if none left.
// scope "all": clear pendingCharges and mark resolved unconditionally.
export function removePendingCharge(sheetId, { runId, userId, scope, clusterKey }) {
  return enqueue(async () => {
    const res = await getSheets().spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: DATA_RANGE,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(
      (row) =>
        String(row[0] ?? "").trim() === runId &&
        String(row[2] ?? "").trim() === userId &&
        !parseBool(row[8])
    );
    if (rowIndex === -1) return null;

    const raw = rows[rowIndex];
    const current = {
      runId:          String(raw[0] ?? "").trim(),
      userName:       String(raw[1] ?? "").trim(),
      userId:         String(raw[2] ?? "").trim(),
      dmChannelId:    String(raw[3] ?? "").trim(),
      threadTs:       String(raw[4] ?? "").trim(),
      nudgeCount:     Number(raw[5] ?? 0) || 0,
      lastNudgeAt:    String(raw[6] ?? "").trim(),
      pendingCharges: (() => { try { return JSON.parse(raw[7] ?? "[]"); } catch { return []; } })(),
      resolved:       false,
    };

    const updated = scope === "all"
      ? { ...current, pendingCharges: [], resolved: true }
      : (() => {
          const remaining = current.pendingCharges.filter((c) => c.clusterKey !== clusterKey);
          return { ...current, pendingCharges: remaining, resolved: remaining.length === 0 };
        })();

    await getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A${rowIndex + 2}:I${rowIndex + 2}`,
      valueInputOption: "RAW",
      requestBody: { values: [buildStatementChaseRow(updated)] },
    });

    return updated;
  });
}
