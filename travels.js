// ── TRAVELS POLLING PROCESS ───────────────────────────────────────────────────
// Standalone Railway process. Polls the Travels tab hourly and fires all
// scheduled nudges in the trip lifecycle:
//
//   T-7 before departure  → DM Yulia: eshel reminder + confirm button
//   T-3 before departure  → DM Yulia: follow-up if eshel not confirmed
//   T-1 before departure  → DM Yulia: final follow-up if eshel not confirmed
//   Day of departure      → DM employee: bon voyage + receipt reminder
//   Day of return         → DM employee: welcome back + receipt buttons
//   T+7 after return      → DM employee: activity-aware receipt nudge
//   T+7 no response       → DM Yulia: overdue alert
//
// Each nudge flag in the sheet prevents re-firing across restarts and ticks.

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
}

import { getTravelRows, updateTravelRow } from "./src/travels/travelsSheet.js";
import { countUserUploadsInChannel } from "./src/travels/travelsSlack.js";
import {
  eshelReminderMessage,
  departureDayMessage,
  returnDayMessage,
  receiptsT7NudgeMessage,
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

async function dm(userId, text, blocks) {
  if (!userId) return;
  const body = { channel: userId, text };
  if (blocks) body.blocks = blocks;
  await slackPost(SLACK_TOKEN, "chat.postMessage", body);
}

function receiptButtons(meta) {
  return [{
    type: "actions",
    elements: [
      {
        type: "button",
        text: { type: "plain_text", text: "All done ✅" },
        action_id: "travel_receipts_done",
        value: JSON.stringify(meta),
        style: "primary",
      },
      {
        type: "button",
        text: { type: "plain_text", text: "No receipts to upload" },
        action_id: "travel_receipts_none",
        value: JSON.stringify(meta),
      },
    ],
  }];
}

function eshelButton(meta) {
  return [{
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "Mark eshel transferred ✅" },
      action_id: "travel_eshel_confirm",
      value: JSON.stringify(meta),
      style: "primary",
    }],
  }];
}

async function runTravelsCheck() {
  const today = todayStr();
  const rows  = await getTravelRows(SHEETS_ID);

  for (const row of rows) {
    if (!row.slackId || !row.departureDate || !row.returnDate) continue;
    if (row.receiptsStatus === "cancelled") continue;

    const dep    = row.departureDate;
    const ret    = row.returnDate;
    const t7pre  = addDays(dep, -7);
    const t3pre  = addDays(dep, -3);
    const t1pre  = addDays(dep, -1);
    const t7post = addDays(ret,  7);

    const eshelMeta = {
      employeeName:    row.employee,
      employeeSlackId: row.slackId,
      eventName:       row.event,
    };

    // T-7: eshel reminder to Yulia.
    if (today === t7pre && !row.eshelT7Sent && YULIA_ID) {
      await dm(YULIA_ID,
        eshelReminderMessage({ employeeName: row.employee, eventName: row.event, departureDate: formatTravelDate(dep), urgency: "t7" }),
        eshelButton(eshelMeta)
      );
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, eshelT7Sent: true });
      console.log(`Eshel T-7 → Yulia for ${row.employee} (${row.event})`);
    }

    // T-3: eshel follow-up if still pending.
    if (today === t3pre && !row.eshelT3Sent && row.eshelStatus === "pending" && YULIA_ID) {
      await dm(YULIA_ID,
        eshelReminderMessage({ employeeName: row.employee, eventName: row.event, departureDate: formatTravelDate(dep), urgency: "t3" }),
        eshelButton(eshelMeta)
      );
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, eshelT3Sent: true });
      console.log(`Eshel T-3 → Yulia for ${row.employee} (${row.event})`);
    }

    // T-1: eshel final follow-up.
    if (today === t1pre && !row.eshelT1Sent && row.eshelStatus === "pending" && YULIA_ID) {
      await dm(YULIA_ID,
        eshelReminderMessage({ employeeName: row.employee, eventName: row.event, departureDate: formatTravelDate(dep), urgency: "t1" }),
        eshelButton(eshelMeta)
      );
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, eshelT1Sent: true });
      console.log(`Eshel T-1 → Yulia for ${row.employee} (${row.event})`);
    }

    // Day of departure: bon voyage DM.
    if (today === dep && !row.departureNudgeSent) {
      await dm(row.slackId,
        departureDayMessage({ employeeName: row.employee, eventName: row.event, channelName: row.channelId })
      );
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, departureNudgeSent: true });
      console.log(`Departure nudge → ${row.employee} (${row.event})`);
    }

    // Day of return: welcome back + receipt buttons.
    if (today === ret && !row.returnNudgeSent) {
      const deadline = formatTravelDate(t7post);
      const { text } = returnDayMessage({ employeeName: row.employee, eventName: row.event, channelName: row.channelId, deadline });
      await dm(row.slackId, text, receiptButtons({ eventName: row.event }));
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, returnNudgeSent: true });
      console.log(`Return nudge → ${row.employee} (${row.event})`);
    }

    // T+7 after return: activity-aware receipt nudge.
    if (today === t7post && !row.receiptsT7Sent && row.receiptsStatus === "pending") {
      let uploadCount = 0;
      if (row.channelId && row.slackId) {
        try {
          uploadCount = await countUserUploadsInChannel(SLACK_TOKEN, row.channelId, row.slackId);
        } catch (e) {
          console.warn(`Could not count uploads for ${row.employee}: ${e.message}`);
        }
      }
      const { text } = receiptsT7NudgeMessage({
        employeeName: row.employee,
        eventName:    row.event,
        channelName:  row.channelId,
        uploadCount,
      });
      await dm(row.slackId, text, receiptButtons({ eventName: row.event }));
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, receiptsT7Sent: true });
      console.log(`Receipts T+7 nudge → ${row.employee} (${row.event}, ${uploadCount} uploads)`);
    }

    // T+7 no response: overdue alert to Yulia, mark row overdue.
    if (today > t7post && row.receiptsT7Sent && row.receiptsStatus === "pending" && YULIA_ID) {
      await dm(YULIA_ID, receiptsOverdueMessage({ employeeName: row.employee, eventName: row.event }));
      await updateTravelRow(SHEETS_ID, row.rowNumber, { ...row, receiptsStatus: "overdue" });
      console.log(`Receipts overdue → Yulia for ${row.employee} (${row.event})`);
    }
  }
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
