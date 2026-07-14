// ── TRAVELS SHEET (Travels tab I/O) ──────────────────────────────────────────
// Read/write the "Travels" tab in the Master DB sheet. One row per
// employee-per-trip. Column order:
//   employee · slack_id · event · destination · departure_date · return_date ·
//   ticket_link · channel_id · channel_name · eshel_status · eshel_amount ·
//   receipts_status · employee_notified · eshel_t7_sent · eshel_t3_sent ·
//   eshel_t1_sent · departure_nudge_sent · return_nudge_sent · receipts_t7_sent ·
//   day_before_nudge_sent · mid_trip_nudge_sent · receipts_t3_sent ·
//   receipts_t11_sent · receipts_t13_sent
//
// Same patterns as chaseState.js: pure row builder, singleton sheets client,
// promise-queue-serialised writes, in-place row updates by rowNumber.

import { google } from "googleapis";
import { getGoogleAuth } from "../googleAuth.js";

const TAB_NAME = "Travels";
const DATA_RANGE = `'${TAB_NAME}'!A2:X`;

const COL = {
  employee:           0,
  slackId:            1,
  event:              2,
  destination:        3,
  departureDate:      4,
  returnDate:         5,
  ticketLink:         6,
  channelId:          7,
  channelName:        8,
  eshelStatus:        9,  // pending / confirmed / na
  eshelAmount:        10,
  receiptsStatus:     11, // pending / done / none / overdue
  employeeNotified:   12,
  eshelT7Sent:        13,
  eshelT3Sent:        14,
  eshelT1Sent:        15,
  departureNudgeSent: 16, // legacy — no longer fired (kept for existing rows/backward compat)
  returnNudgeSent:    17,
  receiptsT7Sent:     18,
  dayBeforeNudgeSent: 19,
  midTripNudgeSent:   20,
  receiptsT3Sent:     21,
  receiptsT11Sent:    22,
  receiptsT13Sent:    23,
};

let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}

function parseBool(v) {
  return /^true$/i.test(String(v ?? "").trim());
}

export async function getTravelRows(sheetId) {
  const res = await getSheets().spreadsheets.values.get({
    spreadsheetId: sheetId,
    range: DATA_RANGE,
  });
  const rows = res.data.values || [];
  return rows.map((row, i) => ({
    employee:           String(row[COL.employee]           ?? "").trim(),
    slackId:            String(row[COL.slackId]            ?? "").trim(),
    event:              String(row[COL.event]              ?? "").trim(),
    destination:        String(row[COL.destination]        ?? "").trim(),
    departureDate:      String(row[COL.departureDate]      ?? "").trim(),
    returnDate:         String(row[COL.returnDate]         ?? "").trim(),
    ticketLink:         String(row[COL.ticketLink]         ?? "").trim(),
    channelId:          String(row[COL.channelId]          ?? "").trim(),
    channelName:        String(row[COL.channelName]        ?? "").trim(),
    eshelStatus:        String(row[COL.eshelStatus]        ?? "pending").trim(),
    eshelAmount:        String(row[COL.eshelAmount]        ?? "").trim(),
    receiptsStatus:     String(row[COL.receiptsStatus]     ?? "pending").trim(),
    employeeNotified:   parseBool(row[COL.employeeNotified]),
    eshelT7Sent:        parseBool(row[COL.eshelT7Sent]),
    eshelT3Sent:        parseBool(row[COL.eshelT3Sent]),
    eshelT1Sent:        parseBool(row[COL.eshelT1Sent]),
    departureNudgeSent: parseBool(row[COL.departureNudgeSent]),
    returnNudgeSent:    parseBool(row[COL.returnNudgeSent]),
    receiptsT7Sent:     parseBool(row[COL.receiptsT7Sent]),
    dayBeforeNudgeSent: parseBool(row[COL.dayBeforeNudgeSent]),
    midTripNudgeSent:   parseBool(row[COL.midTripNudgeSent]),
    receiptsT3Sent:     parseBool(row[COL.receiptsT3Sent]),
    receiptsT11Sent:    parseBool(row[COL.receiptsT11Sent]),
    receiptsT13Sent:    parseBool(row[COL.receiptsT13Sent]),
    rowNumber: i + 2,
  }));
}

export function buildTravelRow(t) {
  return [
    String(t.employee           ?? ""),
    String(t.slackId            ?? ""),
    String(t.event              ?? ""),
    String(t.destination        ?? ""),
    String(t.departureDate      ?? ""),
    String(t.returnDate         ?? ""),
    String(t.ticketLink         ?? ""),
    String(t.channelId          ?? ""),
    String(t.channelName        ?? ""),
    String(t.eshelStatus        ?? "pending"),
    String(t.eshelAmount        ?? ""),
    String(t.receiptsStatus     ?? "pending"),
    t.employeeNotified   ? "TRUE" : "FALSE",
    t.eshelT7Sent        ? "TRUE" : "FALSE",
    t.eshelT3Sent        ? "TRUE" : "FALSE",
    t.eshelT1Sent        ? "TRUE" : "FALSE",
    t.departureNudgeSent ? "TRUE" : "FALSE",
    t.returnNudgeSent    ? "TRUE" : "FALSE",
    t.receiptsT7Sent     ? "TRUE" : "FALSE",
    t.dayBeforeNudgeSent ? "TRUE" : "FALSE",
    t.midTripNudgeSent   ? "TRUE" : "FALSE",
    t.receiptsT3Sent     ? "TRUE" : "FALSE",
    t.receiptsT11Sent    ? "TRUE" : "FALSE",
    t.receiptsT13Sent    ? "TRUE" : "FALSE",
  ];
}

let _travelsWriteQueue = Promise.resolve();

function enqueue(fn) {
  const task = _travelsWriteQueue.then(fn);
  _travelsWriteQueue = task.then(
    () => {},
    (e) => console.error("Travels sheet write error:", e.message)
  );
  return task;
}

export function appendTravelRow(sheetId, travel) {
  return enqueue(() =>
    getSheets().spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A1`,
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [buildTravelRow(travel)] },
    })
  );
}

export function updateTravelRow(sheetId, rowNumber, travel) {
  return enqueue(() =>
    getSheets().spreadsheets.values.update({
      spreadsheetId: sheetId,
      range: `'${TAB_NAME}'!A${rowNumber}:X${rowNumber}`,
      valueInputOption: "RAW",
      requestBody: { values: [buildTravelRow(travel)] },
    })
  );
}

// Convenience: look up all rows for a given event name (case-insensitive).
export function rowsForEvent(rows, eventName) {
  const norm = (s) => String(s ?? "").toLowerCase().trim();
  return rows.filter((r) => norm(r.event) === norm(eventName));
}

// Returns the channel info for an event if it already exists, else null.
export function existingChannel(rows, eventName) {
  const match = rowsForEvent(rows, eventName).find((r) => r.channelId !== "");
  return match ? { channelId: match.channelId, channelName: match.channelName } : null;
}
