// ── STATEMENT STATUS (Sheet tab I/O) ──────────────────────────────────────────
// A rolling, always-current view of the latest statement run's charges — one
// row per pending charge, refreshed on every nudge-poll cycle (and via the
// /financecrewstatement status command) so Yulia can open the sheet directly
// instead of waiting for a Slack DM. Fully rewritten each refresh (not
// appended) since it reflects "current state", not history.
//
// Column order:
//   run_id · person · merchant · amount · currency · billing_date ·
//   accounted_for · nudge_stage · last_checked

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

export const TAB_NAME = "Statement Status";
const HEADER = [
  "Run ID", "Person", "Merchant", "Amount", "Currency", "Billing Date",
  "Accounted For", "Nudge Stage", "Last Checked",
];
const DATA_RANGE = `'${TAB_NAME}'!A2:I`;

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

function stageLabel(n) {
  return n <= 1 ? "Stage 1" : n === 2 ? "Stage 2" : "Stage 3 (final)";
}

// One row per charge across all threads in a run, both still-pending and
// resolved-since-last-check — callers pass a flat list already computed
// (accountedFor is a plain boolean, not re-derived here; this module is pure
// Sheet I/O, same separation as statementRuns.js / statementChase.js).
export function buildStatementStatusRow({ runId, person, charge, accountedFor, nudgeCount, lastChecked }) {
  return [
    String(runId ?? ""),
    String(person ?? ""),
    String(charge?.merchant ?? ""),
    String(charge?.amount ?? ""),
    String(charge?.currency ?? ""),
    String(charge?.billingDate ?? ""),
    accountedFor ? "Yes" : "No",
    stageLabel(nudgeCount ?? 1),
    String(lastChecked ?? new Date().toISOString()),
  ];
}

let _queue = Promise.resolve();
function enqueue(fn) {
  const task = _queue.then(fn);
  _queue = task.then(() => {}, (e) => console.error("Statement status write error:", e.message));
  return task;
}

// Full rewrite: clear the existing data range, then write the header + fresh
// rows. `entries` is an array of the same shape buildStatementStatusRow takes.
export function writeStatementStatusTab(sheetId, entries) {
  return enqueue(async () => {
    const sheets = getSheets();
    await sheets.spreadsheets.values.clear({ spreadsheetId: sheetId, range: DATA_RANGE });
    const rows = entries.map(buildStatementStatusRow);
    await sheets.spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      requestBody: { values: [HEADER, ...rows] },
    });
  });
}
