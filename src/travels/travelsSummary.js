// ── TRAVELS SUMMARY (trip cost query) ────────────────────────────────────────
// Reads Master DB receipts tagged to a specific trip and returns a per-employee
// breakdown. Used by both the /rambotravels summary command and the natural-
// language DM handler ("how much did DMEXCO cost?").
//
// Amounts are grouped per currency — we don't attempt live exchange-rate
// conversion. ILS totals are shown where all receipts are ILS; mixed-currency
// trips show per-currency subtotals per employee.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";
import { MASTER_COL } from "../rambo/matcher.js";

const MASTER_DB_RANGE = "'Master DB'!A2:Q";

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

const norm = (s) => String(s ?? "").toLowerCase().trim();

// Returns { rows, pendingEmployees } where rows is an array of
// { employee, receipts: [{provider, amount, currency}], totals: {ILS: n, USD: n, ...} }
// and pendingEmployees is the list of trip employees with receipts_status=pending.
export async function buildTripSummary(sheetId, eventName, travelRows) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: MASTER_DB_RANGE,
  });

  const masterRows = res.data.values || [];
  const normEvent = norm(eventName);

  // Filter to receipts tagged to this trip.
  const tripReceipts = masterRows.filter(
    (row) => norm(row[MASTER_COL.trip] ?? "") === normEvent
  );

  // Group by cardholder (employee who submitted).
  const byEmployee = new Map();
  for (const row of tripReceipts) {
    const employee = String(row[MASTER_COL.cardholder] ?? row[MASTER_COL.source] ?? "Unknown").trim();
    const provider = String(row[MASTER_COL.provider] ?? "").trim();
    const amount   = parseFloat(String(row[MASTER_COL.amount] ?? "").replace(/,/g, "")) || 0;
    const currency = String(row[MASTER_COL.currency] ?? "ILS").trim().toUpperCase();

    if (!byEmployee.has(employee)) byEmployee.set(employee, { receipts: [], totals: {} });
    const entry = byEmployee.get(employee);
    entry.receipts.push({ provider, amount, currency });
    entry.totals[currency] = (entry.totals[currency] ?? 0) + amount;
  }

  const rows = [...byEmployee.entries()].map(([employee, data]) => ({
    employee,
    receipts: data.receipts,
    totals: data.totals,
    // Convenience: single ILS total when all receipts are ILS.
    totalIls: Object.keys(data.totals).length === 1 && data.totals["ILS"]
      ? data.totals["ILS"]
      : null,
  }));

  const pendingEmployees = travelRows
    .filter((r) => norm(r.event) === normEvent && r.receiptsStatus === "pending")
    .map((r) => r.employee);

  return { rows, pendingEmployees };
}

// Formats a per-employee totals object into a readable string.
// e.g. { ILS: 1200, USD: 340 } → "₪1,200 + $340"
export function formatTotals(totals) {
  const symbols = { ILS: "₪", USD: "$", EUR: "€" };
  return Object.entries(totals)
    .map(([cur, amt]) => `${symbols[cur] ?? cur}${amt.toLocaleString()}`)
    .join(" + ");
}
