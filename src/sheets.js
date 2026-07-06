// ── GOOGLE SHEETS (Master DB) ─────────────────────────────────────────────────
// One row per receipt. Appends are serialised through a promise queue so
// concurrent appends in one poll tick don't race on the tab (same pattern as
// Monica's _sheetsWriteQueue).

import { google } from "googleapis";
import { getGoogleAuth } from "./googleAuth.js";

const SHEET_NAME = "Master DB";
// Master Doc §8: Receipt No. is column K — the dedup key.
const RECEIPT_NO_RANGE = `'${SHEET_NAME}'!K2:K`;

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

export async function getExistingReceiptNumbers(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: RECEIPT_NO_RANGE,
  });
  const rows = res.data.values || [];
  return new Set(
    rows.map((r) => (r[0] ?? "").toString().trim()).filter((v) => v !== "")
  );
}

// Generic tab read (design doc: extend sheets.js with generic helpers
// reusable by the Rambo modules). Used by rambo.js to read Master DB rows
// and the Vendor Ownership tab. Read-only — doesn't touch the write queue.
export async function readTabRows(sheetId, rangeA1) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: rangeA1,
  });
  return res.data.values || [];
}

let _sheetsWriteQueue = Promise.resolve();

export function appendReceiptRow(sheetId, rowValues) {
  const task = _sheetsWriteQueue.then(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${SHEET_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [rowValues] },
    })
  );
  // Keep the queue alive even if this append fails; the error still
  // propagates to the caller via `task`.
  _sheetsWriteQueue = task.then(
    () => {},
    (e) => console.error("Sheets append error:", e.message)
  );
  return task;
}

// Column order per Master Doc §4:
// Captured at · Source · Expense type · Date · Currency · Amount · Paid by ·
// Credit card · Cardholder · Provider · Receipt No. · Comments · Invoice link ·
// Status · Matched Amex txn
export function buildReceiptRow({ parsed, sourceEmail, invoiceLink }) {
  const cell = (v) => (v === null || v === undefined ? "" : v);
  return [
    new Date().toISOString(),        // Captured at
    cell(sourceEmail),               // Source
    cell(parsed.expense_type),       // Expense type
    cell(parsed.date),               // Date
    cell(parsed.currency),           // Currency
    cell(parsed.amount),             // Amount
    cell(parsed.suggested_paid_by),  // Paid by
    "",                              // Credit card (not derivable from receipt)
    "",                              // Cardholder (not derivable from receipt)
    cell(parsed.provider),           // Provider
    cell(parsed.receipt_no),         // Receipt No.
    cell(parsed.notes),              // Comments
    cell(invoiceLink),               // Invoice link
    "Pending",                       // Status
    "",                              // Matched Amex txn
  ];
}
