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

// Error Log tab columns: Logged at · Service · Message ID · Sender · Subject · Attachment · Error
const ERROR_LOG_SHEET = "Error Log";

export function appendErrorRow(sheetId, { service, messageId, sender, subject, attachment, error }) {
  const task = _sheetsWriteQueue.then(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${ERROR_LOG_SHEET}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [[
          new Date().toISOString(),
          service || "",
          messageId || "",
          sender || "",
          subject || "",
          attachment || "",
          error || "",
        ]],
      },
    })
  );
  _sheetsWriteQueue = task.then(
    () => {},
    (e) => console.error("Error Log append failed:", e.message)
  );
  return task;
}

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

// ── SLACK INTAKE CURSOR ───────────────────────────────────────────────────────
// "Slack Intake State" tab: a single data cell (A2) holding the Slack message
// timestamp of the last-processed message. Slack timestamps are strings like
// "1234567890.123456" — stored as-is, compared as strings (lexicographic order
// works because they're zero-padded Unix seconds with a fixed-width decimal).
const SLACK_INTAKE_TAB = "Slack Intake State";

export async function getSlackIntakeCursor(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: `'${SLACK_INTAKE_TAB}'!A2`,
  });
  return (res.data.values || [])[0]?.[0] || "";
}

export function setSlackIntakeCursor(sheetId, ts) {
  const task = _sheetsWriteQueue.then(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${SLACK_INTAKE_TAB}'!A2`,
      valueInputOption: "RAW",
      requestBody: { values: [[ts]] },
    })
  );
  _sheetsWriteQueue = task.then(
    () => {},
    (e) => console.error("Slack cursor write error:", e.message)
  );
  return task;
}

// Update the Status column (N, index 13) of a specific Master DB row.
// rowNumber is 1-based (as returned by getStatementChaseThreads / any Sheet read).
// Used by the statement intake DM flow when a receipt is matched to a charge.
export function setReceiptStatus(sheetId, rowNumber, status) {
  const task = _sheetsWriteQueue.then(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${SHEET_NAME}'!N${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [[status]] },
    })
  );
  _sheetsWriteQueue = task.then(
    () => {},
    (e) => console.error("Status update error:", e.message)
  );
  return task;
}

// Known company cards — last 4 digits → card type + cardholder.
// If the receipt shows one of these, paid_by is forced to Organization and
// the credit card column is populated automatically.
const COMPANY_CARDS = {
  "4154": { type: "Amex", cardholder: "Roee" },
  "9037": { type: "Amex", cardholder: "Ron"  },
  "4287": { type: "Amex", cardholder: null   },
  "5438": { type: "Visa", cardholder: "Roee" },
  "0375": { type: "Visa", cardholder: "Ron"  },
};

// Matches the sheet dropdown format: "5438 ILS Visa Roee", "5438 $ Visa Roee", etc.
function creditCardLabel(last4, currency, cardInfo) {
  const cur = currency === "USD" ? "$" : currency === "EUR" ? "€" : (currency || "");
  const parts = [last4, cur, cardInfo.type, cardInfo.cardholder].filter(Boolean);
  return parts.join(" ");
}

// Column order per Master Doc §4:
// Captured at · Source · Expense type · Date · Currency · Amount · Paid by ·
// Credit card · Cardholder · Provider · Receipt No. · Comments · Invoice link ·
// Status · Matched CC txn · Document type · Trip
export function buildReceiptRow({ parsed, sourceEmail, invoiceLink, cardholder = "", trip = "" }) {
  const cell = (v) => (v === null || v === undefined ? "" : v);
  // Prefix formula-like values with a single quote so Sheets treats them as text.
  const sanitize = (v) => { const s = String(cell(v)); return s && /^[=+\-@]/.test(s) ? `'${s}` : s; };

  // cc_last4 on a known company card is harder evidence than Claude's guess —
  // override paid_by, credit card label, and cardholder from the map.
  const last4 = parsed.cc_last4 ? String(parsed.cc_last4).trim() : null;
  const cardInfo = last4 ? COMPANY_CARDS[last4] : null;
  const paidBy        = cardInfo ? "Organization" : cell(parsed.suggested_paid_by);
  const creditCard    = cardInfo ? creditCardLabel(last4, parsed.currency, cardInfo) : "";
  const cardholderOut = cardholder || (cardInfo?.cardholder ?? "");

  return [
    new Date().toISOString(),        // A: Captured at
    cell(sourceEmail),               // B: Source
    sanitize(parsed.expense_type),   // C: Expense type
    cell(parsed.date),               // D: Date
    cell(parsed.currency),           // E: Currency
    cell(parsed.amount),             // F: Amount
    paidBy,                          // G: Paid by
    creditCard,                      // H: Credit card
    cardholderOut,                   // I: Cardholder
    sanitize(parsed.provider),       // J: Provider
    sanitize(parsed.receipt_no),     // K: Receipt No.
    sanitize(parsed.notes),          // L: Comments
    cell(invoiceLink),               // M: Invoice link
    "Pending",                       // N: Status
    "",                              // O: Matched CC txn
    sanitize(parsed.document_type),  // P: Document type (receipt / invoice / other)
    sanitize(trip),                  // Q: Trip (event name, e.g. "DMEXCO")
  ];
}
