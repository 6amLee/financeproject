// ── TRAVELS MESSAGES (pure message builders) ──────────────────────────────────
// All DM and notification text for the travels flow. Pure functions — no I/O,
// no Slack calls. Callers supply the data; these return the text to send.

import { formatTotals } from "./travelsSummary.js";

// ── REGISTRATION ─────────────────────────────────────────────────────────────

export function employeeRegistrationMessage({ employeeName, eventName, destination, departureDate, returnDate, channelName }) {
  return (
    `Hey ${employeeName}! ✈️ You're registered for *${eventName}* in ${destination}.\n\n` +
    `*Departure:* ${departureDate}\n` +
    `*Return:* ${returnDate}\n\n` +
    `Drop all your trip receipts (taxi, meals, hotel, insurance — everything) in <#${channelName}>. ` +
    `FinanceCrew will process them automatically.`
  );
}

// Sent to Yulia each time an employee is added — shows the full current roster.
export function yuliaRosterUpdateMessage({ eventName, destination, employees }) {
  const roster = employees
    .map((e) => `• *${e.employee}* — ${e.departureDate} → ${e.returnDate}`)
    .join("\n");
  return (
    `📋 *${eventName}* trip update — ${employees.length} employee(s) registered:\n\n` +
    `${roster}\n\n` +
    `*Destination:* ${destination}`
  );
}

// ── ESHEL NUDGES (to Yulia) ──────────────────────────────────────────────────

// Grouped: one DM per event covering every employee still needing eshel at
// this urgency tier, rather than one DM per person. `employees` is
// [{ employeeName, departureDate, days }], days = trip length in whole days.
export function eshelGroupReminderMessage({ eventName, employees, urgency }) {
  const prefix =
    urgency === "t1" ? `⚠️ *Final reminder* — ` :
    urgency === "t3" ? `🔔 *Follow-up* — ` : "";
  const lines = employees
    .map((e) => `• *${e.employeeName}* — departs ${e.departureDate}, ${e.days} day${e.days === 1 ? "" : "s"}`)
    .join("\n");
  const plural = employees.length === 1 ? "still needs" : "still need";
  return (
    `${prefix}Hey Yulia, the following ${employees.length === 1 ? "person" : "people"} flying to *${eventName}* ${plural} eshel transferred:\n\n` +
    `${lines}\n\n` +
    `Please transfer and mark each one done below.`
  );
}

export function eshelConfirmedToYuliaMessage({ employeeName, amount }) {
  return `✅ Eshel for *${employeeName}* marked as confirmed — ₪${amount} transferred.`;
}

// ── ESHEL CONFIRMED (to employee) ────────────────────────────────────────────

export function eshelDepositedMessage({ employeeName, amount, eventName }) {
  return (
    `Hey ${employeeName}! 💸 Your travel allowance (eshel) of *₪${amount}* for *${eventName}* has been deposited. ` +
    `Have a great trip!`
  );
}

// ── DEPARTURE NUDGE (to employee) ────────────────────────────────────────────

// Posted in the trip channel the day before departure — one message for the
// whole group, not per person.
export function dayBeforeDepartureMessage({ eventName, destination }) {
  return (
    `Have a great time in *${destination}*! ✈️\n\n` +
    `Reminder: upload your receipts directly to this channel as you go — just drop the file and I'll walk you through it. ` +
    `No need to save them up for when you're back.`
  );
}

// Posted in the trip channel once, at the midpoint of the trip.
export function midTripReminderMessage({ eventName, destination }) {
  return (
    `👋 Just a reminder while you're still in *${destination}* — keep dropping receipts here in this channel as you go, ` +
    `it's much easier than trying to gather them all at once when you're back.`
  );
}

// ── RETURN / CUTOFF NUDGES (posted in the trip channel, grouped) ────────────

// One message per channel, listing everyone whose OWN return date is today.
// Each person gets their own "All Receipts Uploaded!" button underneath their
// name — clicking it only marks that person, not the others in the message.
export function returnDayGroupMessage({ eventName, employees, deadline }) {
  const names = employees.map((e) => `*${e.employeeName}*`).join(", ");
  return (
    `Welcome back, ${names}! 🏠\n\n` +
    `You have until *${deadline}* to upload any remaining *${eventName}* receipts to this channel. ` +
    `Once you're done, use your button below:`
  );
}

// Post-return cutoff nudges (T+3/T+7/T+11/T+13 from return) — only lists
// people STILL pending at this urgency tier; anyone who already clicked
// "All Receipts Uploaded!" is dropped from the message entirely.
export function receiptsCutoffNudgeMessage({ eventName, employees, deadline, urgency }) {
  const prefix =
    urgency === "final" ? `⚠️ *Final reminder — deadline is tomorrow* — ` :
    urgency === "t11"   ? `🔔 ` :
    urgency === "t7"    ? `🔔 ` : "";
  const names = employees.map((e) => `*${e.employeeName}*`).join(", ");
  return (
    `${prefix}Hey ${names} — still waiting on *${eventName}* receipts from you. ` +
    `The cutoff is *${deadline}*. Drop anything outstanding right here in this channel, ` +
    `or use your button below once you're done:`
  );
}

// ── OVERDUE ALERT (to Yulia) ─────────────────────────────────────────────────

export function receiptsOverdueMessage({ employeeName, eventName }) {
  return (
    `⚠️ Hey Yulia — *${employeeName}* hasn't confirmed their *${eventName}* receipts and the deadline has passed. ` +
    `You may want to follow up with them directly.`
  );
}

// ── CANCELLATION ─────────────────────────────────────────────────────────────

export function tripCancelledToEmployeeMessage({ employeeName, eventName }) {
  return `Hey ${employeeName}, the *${eventName}* trip has been cancelled. The travel channel will be archived.`;
}

export function tripCancelledToYuliaMessage({ eventName, employeeNames }) {
  return (
    `🚫 The *${eventName}* trip has been cancelled.\n\n` +
    `Affected employees: ${employeeNames.join(", ")}\n\n` +
    `All scheduled nudges have been stopped and the channel will be archived.`
  );
}

// ── TRIP COST SUMMARY ─────────────────────────────────────────────────────────

export function tripCostSummaryMessage({ eventName, rows, pendingEmployees }) {
  if (rows.length === 0) {
    return `No receipts have been logged for *${eventName}* yet.`;
  }

  const lines = rows.map((r) => {
    const receiptList = r.receipts.map((rx) => rx.provider).join(", ");
    const countLabel = `${r.receipts.length} receipt${r.receipts.length === 1 ? "" : "s"}`;
    return `• *${r.employee}* — ${formatTotals(r.totals)} (${countLabel}: ${receiptList})`;
  });

  // Grand total, per currency (handles mixed-currency trips correctly).
  const grandTotals = {};
  for (const r of rows) {
    for (const [cur, amt] of Object.entries(r.totals)) {
      grandTotals[cur] = (grandTotals[cur] ?? 0) + amt;
    }
  }
  const pending = pendingEmployees.length > 0
    ? `\n\n⏳ *Receipts not yet confirmed:* ${pendingEmployees.join(", ")}`
    : "";

  return (
    `*${eventName} — Trip Cost Summary*\n` +
    `─────────────────────────\n` +
    lines.join("\n") + "\n" +
    `─────────────────────────\n` +
    `*Total: ${formatTotals(grandTotals)}*` +
    pending
  );
}

// ── NATURAL-LANGUAGE Q&A (DM) ─────────────────────────────────────────────────

export function tripRosterMessage({ eventName, rows }) {
  if (rows.length === 0) {
    return `No one is currently registered for *${eventName}*.`;
  }
  const lines = rows.map(
    (r) => `• *${r.employee}* — ${formatTravelDate(r.departureDate)} → ${formatTravelDate(r.returnDate)}`
  );
  return `*${eventName} — Roster*\n${lines.join("\n")}`;
}

export function unknownTravelQuestionMessage() {
  return "I couldn't tell which trip you're asking about, or what you'd like to know. Try something like \"who's going to DMEXCO?\", \"how much did DMEXCO cost?\", or \"when is Aviad's flight for DMEXCO?\"";
}

export function employeeDetailMessage({ eventName, row }) {
  if (!row) {
    return `I couldn't find that person registered for *${eventName}*.`;
  }
  return (
    `*${row.employee} — ${eventName}*\n` +
    `*Destination:* ${row.destination}\n` +
    `*Departure:* ${formatTravelDate(row.departureDate)}\n` +
    `*Return:* ${formatTravelDate(row.returnDate)}`
  );
}

// ── SHARED HELPERS ────────────────────────────────────────────────────────────

// Formats a date string (YYYY-MM-DD) for display: "25 Sep 2026"
export function formatTravelDate(dateStr) {
  const d = new Date(dateStr);
  if (isNaN(d)) return dateStr;
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

// Returns YYYY-MM-DD for a date N days from a given YYYY-MM-DD string.
export function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Returns today's date as YYYY-MM-DD (UTC).
export function todayStr() {
  return new Date().toISOString().slice(0, 10);
}
