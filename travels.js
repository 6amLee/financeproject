// ── TRAVELS POLLING PROCESS ───────────────────────────────────────────────────
// Standalone Railway process. Polls the Travels tab hourly and fires all
// scheduled nudges in the trip lifecycle:
//
//   T-7/T-3/T-1 before departure → DM Yulia: grouped eshel reminder (one
//                                  message per event, listing everyone in
//                                  that event still needing eshel at this
//                                  urgency tier)
//   T-1 before departure         → post in trip channel: "have a great
//                                  time" + receipt reminder (grouped, once
//                                  per channel per day)
//   Trip midpoint                → post in trip channel: reminder to keep
//                                  uploading receipts as you go
//   Day of return                → post in trip channel, grouped by everyone
//                                  whose OWN return date is today, each with
//                                  their own "All Receipts Uploaded!" button
//   T+3/T+7/T+11/T+13 after      → post in trip channel, grouped, listing
//   return (2-week cutoff)         only people STILL pending at that tier —
//                                  anyone who already clicked done is
//                                  dropped from later nudges but not others
//   Past T+14 cutoff, still       → DM Yulia: overdue alert per remaining
//   pending                        pending person
//
// Each nudge flag in the sheet prevents re-firing across restarts and ticks.
// Grouping is per (channel or event) + calendar day: if 3 people in the same
// channel hit the same trigger on the same day, they get ONE message, not 3.

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
}

import { getTravelRows, updateTravelRow } from "./src/travels/travelsSheet.js";
import {
  eshelGroupReminderMessage,
  dayBeforeDepartureMessage,
  midTripReminderMessage,
  returnDayGroupMessage,
  receiptsCutoffNudgeMessage,
  receiptsOverdueMessage,
  formatTravelDate,
  addDays,
  todayStr,
} from "./src/travels/travelsMessages.js";
import { slackPost } from "./src/slackIntake.js";

const REQUIRED_ENV = [
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEETS_ID",
  "SLACK_BOT_TOKEN",
];
const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missing.length > 0) {
  console.error(`travels.js: missing env vars: ${missing.join(", ")}`);
  process.exit(1);
}

const SHEETS_ID   = process.env.GOOGLE_SHEETS_ID;
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const YULIA_ID    = process.env.YULIA_SLACK_ID || "";
const POLL_MIN    = Number(process.env.TRAVELS_POLL_MINUTES) || 60;

// 2 weeks from return date — the hard cutoff shown in every post-return nudge.
const RETURN_CUTOFF_DAYS = 14;

async function dm(userId, text, blocks) {
  if (!userId) return;
  const body = { channel: userId, text };
  if (blocks) body.blocks = blocks;
  await slackPost(SLACK_TOKEN, "chat.postMessage", body);
}

async function postToChannel(channelId, text, blocks) {
  if (!channelId) return;
  const body = { channel: channelId, text };
  if (blocks) body.blocks = blocks;
  await slackPost(SLACK_TOKEN, "chat.postMessage", body);
}

// One "All Receipts Uploaded!" + "No receipts to upload" pair of buttons per
// person, each carrying its own meta so a click only marks that specific
// person (handleTravelReceiptsConfirm already looks up the row by the
// clicking user's Slack ID + eventName — unchanged by this file, works
// identically whether the button is in a DM or, as here, a shared channel
// message). One "actions" block per person keeps each pair visually grouped.
function receiptButtonsBlocks(rows) {
  return rows.map((r) => ({
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: `${r.employee}: All done ✅` },
        action_id: "travel_receipts_done",
        style: "primary",
        value: JSON.stringify({ eventName: r.event }),
      },
      {
        type: "button",
        text: { type: "plain_text", text: `${r.employee}: No receipts to upload` },
        action_id: "travel_receipts_none",
        value: JSON.stringify({ eventName: r.event }),
      },
    ],
  }));
}

function eshelButtonsBlock(rows) {
  return {
    type: "actions",
    elements: rows.map((r) => ({
      type: "button",
      text: { type: "plain_text", text: `${r.employee}: Mark eshel transferred ✅` },
      action_id: "travel_eshel_confirm",
      value: JSON.stringify({ employeeName: r.employee, employeeSlackId: r.slackId, eventName: r.event }),
    })),
  };
}

// Whole-day difference between two YYYY-MM-DD strings, computed via the
// same UTC-midnight construction addDays uses, so it never drifts with DST.
function daysBetween(fromStr, toStr) {
  const from = new Date(fromStr);
  const to = new Date(toStr);
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

async function runEshelReminders(rows, today) {
  // Group by event: for each urgency tier, find rows at that tier's trigger
  // day that haven't been sent yet, and are still eshel-pending (T-3/T-1
  // only — T-7 fires regardless since it's the first ask).
  const tiers = [
    { urgency: "t7", flag: "eshelT7Sent", offset: -7, requirePending: false },
    { urgency: "t3", flag: "eshelT3Sent", offset: -3, requirePending: true },
    { urgency: "t1", flag: "eshelT1Sent", offset: -1, requirePending: true },
  ];

  for (const tier of tiers) {
    const due = rows.filter((r) => {
      if (!r.departureDate || r[tier.flag]) return false;
      if (tier.requirePending && r.eshelStatus !== "pending") return false;
      return today === addDays(r.departureDate, tier.offset);
    });
    if (!due.length) continue;

    const byEvent = new Map();
    for (const row of due) {
      if (!byEvent.has(row.event)) byEvent.set(row.event, []);
      byEvent.get(row.event).push(row);
    }

    for (const [eventName, eventRows] of byEvent) {
      if (!YULIA_ID) continue;
      const employees = eventRows.map((r) => ({
        employeeName: r.employee,
        departureDate: formatTravelDate(r.departureDate),
        days: daysBetween(r.departureDate, r.returnDate) + 1,
      }));
      await dm(
        YULIA_ID,
        eshelGroupReminderMessage({ eventName, employees, urgency: tier.urgency }),
        [eshelButtonsBlock(eventRows)]
      );
      for (const row of eventRows) {
        await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, [tier.flag]: true });
      }
      console.log(`Eshel ${tier.urgency} → Yulia for ${eventName} (${eventRows.length} employee(s)).`);
    }
  }
}

async function runDayBeforeDeparture(rows, today) {
  const due = rows.filter((r) => r.departureDate && !r.dayBeforeNudgeSent && today === addDays(r.departureDate, -1));
  if (!due.length) return;

  const byChannel = new Map();
  for (const row of due) {
    if (!row.channelId) continue;
    if (!byChannel.has(row.channelId)) byChannel.set(row.channelId, []);
    byChannel.get(row.channelId).push(row);
  }

  for (const [channelId, channelRows] of byChannel) {
    const { event: eventName, destination } = channelRows[0];
    await postToChannel(channelId, dayBeforeDepartureMessage({ eventName, destination }));
    for (const row of channelRows) {
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, dayBeforeNudgeSent: true });
    }
    console.log(`Day-before-departure nudge → #${channelRows[0].channelName} (${eventName}).`);
  }
}

async function runMidTrip(rows, today) {
  const due = rows.filter((r) => {
    if (!r.departureDate || !r.returnDate || r.midTripNudgeSent) return false;
    const midpoint = addDays(r.departureDate, Math.floor(daysBetween(r.departureDate, r.returnDate) / 2));
    // Skip trips too short to have a meaningful midpoint distinct from
    // departure/return day.
    if (midpoint === r.departureDate || midpoint === r.returnDate) return false;
    return today === midpoint;
  });
  if (!due.length) return;

  const byChannel = new Map();
  for (const row of due) {
    if (!row.channelId) continue;
    if (!byChannel.has(row.channelId)) byChannel.set(row.channelId, []);
    byChannel.get(row.channelId).push(row);
  }

  for (const [channelId, channelRows] of byChannel) {
    const { event: eventName, destination } = channelRows[0];
    await postToChannel(channelId, midTripReminderMessage({ eventName, destination }));
    for (const row of channelRows) {
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, midTripNudgeSent: true });
    }
    console.log(`Mid-trip nudge → #${channelRows[0].channelName} (${eventName}).`);
  }
}

async function runReturnDay(rows, today) {
  const due = rows.filter((r) => r.returnDate && !r.returnNudgeSent && today === r.returnDate);
  if (!due.length) return;

  const byChannel = new Map();
  for (const row of due) {
    if (!row.channelId) continue;
    if (!byChannel.has(row.channelId)) byChannel.set(row.channelId, []);
    byChannel.get(row.channelId).push(row);
  }

  for (const [channelId, channelRows] of byChannel) {
    const { event: eventName } = channelRows[0];
    const deadline = formatTravelDate(addDays(channelRows[0].returnDate, RETURN_CUTOFF_DAYS));
    const text = returnDayGroupMessage({
      eventName,
      employees: channelRows.map((r) => ({ employeeName: r.employee })),
      deadline,
    });
    await postToChannel(channelId, text, receiptButtonsBlocks(channelRows));
    for (const row of channelRows) {
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, returnNudgeSent: true });
    }
    console.log(`Return-day nudge → #${channelRows[0].channelName} (${eventName}, ${channelRows.length} employee(s)).`);
  }
}

async function runCutoffNudges(rows, today) {
  const tiers = [
    { urgency: "t3",    flag: "receiptsT3Sent",  offset: 3 },
    { urgency: "t7",    flag: "receiptsT7Sent",  offset: 7 },
    { urgency: "t11",   flag: "receiptsT11Sent", offset: 11 },
    { urgency: "final", flag: "receiptsT13Sent", offset: 13 },
  ];

  for (const tier of tiers) {
    const due = rows.filter((r) =>
      r.returnDate && !r[tier.flag] && r.receiptsStatus === "pending" &&
      today === addDays(r.returnDate, tier.offset)
    );
    if (!due.length) continue;

    const byChannel = new Map();
    for (const row of due) {
      if (!row.channelId) continue;
      if (!byChannel.has(row.channelId)) byChannel.set(row.channelId, []);
      byChannel.get(row.channelId).push(row);
    }

    for (const [channelId, channelRows] of byChannel) {
      const { event: eventName } = channelRows[0];
      const deadline = formatTravelDate(addDays(channelRows[0].returnDate, RETURN_CUTOFF_DAYS));
      const text = receiptsCutoffNudgeMessage({
        eventName,
        employees: channelRows.map((r) => ({ employeeName: r.employee })),
        deadline,
        urgency: tier.urgency,
      });
      await postToChannel(channelId, text, receiptButtonsBlocks(channelRows));
      for (const row of channelRows) {
        await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, [tier.flag]: true });
      }
      console.log(`Receipts ${tier.urgency} cutoff nudge → #${channelRows[0].channelName} (${eventName}, ${channelRows.length} pending).`);
    }
  }
}

async function runOverdueAlerts(rows, today) {
  const overdue = rows.filter((r) =>
    r.returnDate && r.receiptsT13Sent && r.receiptsStatus === "pending" &&
    today > addDays(r.returnDate, RETURN_CUTOFF_DAYS)
  );
  for (const row of overdue) {
    if (!YULIA_ID) continue;
    await dm(YULIA_ID, receiptsOverdueMessage({ employeeName: row.employee, eventName: row.event }));
    await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, receiptsStatus: "overdue" });
    console.log(`Receipts overdue → Yulia for ${row.employee} (${row.event}).`);
  }
}

async function runTravelsCheck() {
  const today = todayStr();
  const rows  = await getTravelRows(SHEETS_ID);
  const active = rows.filter((r) => r.slackId && r.receiptsStatus !== "cancelled");

  await runEshelReminders(active, today);
  await runDayBeforeDeparture(active, today);
  await runMidTrip(active, today);
  await runReturnDay(active, today);
  await runCutoffNudges(active, today);
  await runOverdueAlerts(active, today);
}

async function poll() {
  try {
    await runTravelsCheck();
  } catch (e) {
    console.error("Travels poll error:", e.message);
  }
  setTimeout(poll, POLL_MIN * 60 * 1000);
}

console.log(`Travels process starting — polling every ${POLL_MIN} min`);
poll();
