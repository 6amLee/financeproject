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
    `Rambo will process them automatically.`
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

export function eshelReminderMessage({ employeeName, eventName, departureDate, urgency }) {
  const prefix =
    urgency === "t1" ? `⚠️ *Final reminder* — ` :
    urgency === "t3" ? `🔔 *Follow-up* — ` : "";
  return (
    `${prefix}Hey Yulia, *${employeeName}* is flying to *${eventName}* on ${departureDate}.\n\n` +
    `Please transfer their eshel before they depart and mark it done below.`
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

export function departureDayMessage({ employeeName, eventName, channelName }) {
  return (
    `Have a great trip, ${employeeName}! 🛫 Safe travels to *${eventName}*.\n\n` +
    `Remember: drop all receipts (meals, taxi, anything work-related) in <#${channelName}> as you go. ` +
    `Rambo will handle the rest.`
  );
}

// ── RETURN NUDGES (to employee) ───────────────────────────────────────────────

export function returnDayMessage({ employeeName, eventName, channelName, deadline }) {
  return {
    text:
      `Welcome back from *${eventName}*, ${employeeName}! 🏠\n\n` +
      `You have until *${deadline}* to upload any remaining receipts to <#${channelName}>. ` +
      `Once you're done, let us know:`,
    buttons: receiptConfirmButtons(),
  };
}

export function receiptsT7NudgeMessage({ employeeName, eventName, channelName, uploadCount }) {
  const uploadLine =
    uploadCount > 0
      ? `You've uploaded *${uploadCount} receipt${uploadCount === 1 ? "" : "s"}* so far.`
      : `We haven't seen any receipts from you yet.`;
  return {
    text:
      `Hey ${employeeName}, your *${eventName}* receipt deadline is today! ${uploadLine}\n\n` +
      `Are there any more receipts in <#${channelName}>, or are you all done?`,
    buttons: receiptConfirmButtons(),
  };
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

function receiptConfirmButtons() {
  return [
    { text: "All done ✅", value: "receipts_done", action_id: "travel_receipts_done" },
    { text: "No receipts to upload", value: "receipts_none", action_id: "travel_receipts_none" },
  ];
}

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
