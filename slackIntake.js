// ── SLACK RECEIPT INTAKE ──────────────────────────────────────────────────────
// Polls a designated Slack channel for receipt file uploads from employees.
// Complements the Gmail intake (index.js): employees can drop a receipt image
// or PDF directly into the channel instead of emailing finance@.
//
// Two expense types are handled transparently:
//   - Employee expense (paid personally, needs reimbursement): Claude determines
//     suggested_paid_by from the receipt content; if the employee's message
//     text contains reimbursement hints ("personal", "mine", "reimburse"),
//     that is passed to Claude as context. The submitter's name fills the
//     Cardholder column so Finance knows who to pay back.
//   - Organization expense (employee forwarding a company-card receipt):
//     Claude returns suggested_paid_by = "Organization"; Cardholder is blank.
//
// Cursor: the Slack timestamp of the last-processed message is stored in the
// "Slack Intake State" tab (cell A2). On first run (no cursor) defaults to 24h
// ago so stale channel history is not replayed.
//
// Run with --once for a single cycle (local testing).

import { getChannelHistory, downloadSlackFile, getSlackUserName } from "./src/slackIntake.js";
import { extractReceiptData } from "./src/claude.js";
import { parseClaudeJson } from "./src/parseJson.js";
import { uploadToDrive } from "./src/drive.js";
import {
  getExistingReceiptNumbers,
  appendReceiptRow,
  buildReceiptRow,
  appendErrorRow,
  getSlackIntakeCursor,
  setSlackIntakeCursor,
} from "./src/sheets.js";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
}

const REQUIRED_ENV = [
  "ANTHROPIC_API_KEY",
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEETS_ID",
  "SLACK_BOT_TOKEN",
  "SLACK_INTAKE_CHANNEL",
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")} — see .env.example`);
  process.exit(1);
}

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID = process.env.SLACK_INTAKE_CHANNEL;
const POLL_INTERVAL_MINUTES = Number(process.env.SLACK_INTAKE_POLL_MINUTES) || 5;

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Slack's mimetype field uses underscores for some types (e.g. "image_png").
// Normalise to standard MIME before checking.
function normaliseMime(slackMime) {
  return slackMime?.replace("_", "/") ?? "";
}

// Crude check for reimbursement intent in the employee's message text.
const REIMBURSE_PATTERN = /\b(personal|personally|mine|my own|reimburse|reimbursement|paid myself|i paid)\b/i;

async function processSlackFile({ file, userName, messageText, existingReceiptNumbers }) {
  const mimeType = normaliseMime(file.mimetype);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    console.warn(`Skipping unsupported file "${file.name}" (${file.mimetype})`);
    return;
  }

  const base64Data = await downloadSlackFile(SLACK_TOKEN, file.url_private);

  const invoiceLink = await uploadToDrive({
    filename: file.name,
    mimeType,
    base64Data,
    folderId: DRIVE_FOLDER_ID,
  });

  // Pass the employee's message as context so Claude can factor in any
  // explicit reimbursement signal ("this is personal", etc.).
  const context = messageText?.trim()
    ? `Submitted via Slack by ${userName}. Their message: "${messageText.trim()}"`
    : `Submitted via Slack by ${userName}.`;

  const rawText = await extractReceiptData({ mimeType, base64Data, context });
  const parsed = parseClaudeJson(rawText);

  if (parsed.is_receipt !== true) {
    console.log(`Not a receipt (is_receipt=${parsed.is_receipt}) — skipping "${file.name}"`);
    return;
  }

  const receiptNo = (parsed.receipt_no ?? "").toString().trim();
  if (receiptNo && existingReceiptNumbers.has(receiptNo)) {
    console.log(`Duplicate receipt_no "${receiptNo}" (${parsed.provider}) — skipping`);
    return;
  }

  // If the receipt is an employee expense OR the message hints at reimbursement,
  // record the submitter as the cardholder so Finance knows who to pay back.
  const isEmployeeExpense =
    parsed.suggested_paid_by === "Employee" ||
    REIMBURSE_PATTERN.test(messageText || "");
  const cardholder = isEmployeeExpense ? userName : "";

  await appendReceiptRow(
    SHEETS_ID,
    buildReceiptRow({
      parsed,
      sourceEmail: `slack:${userName}`,
      invoiceLink,
      cardholder,
    })
  );

  if (receiptNo) existingReceiptNumbers.add(receiptNo);
  console.log(
    `Added row: ${parsed.provider} · ${parsed.amount} ${parsed.currency} · ` +
    `receipt ${receiptNo || "(none)"} · submitted by ${userName}` +
    (cardholder ? " [employee expense]" : "")
  );
}

async function pollCycle() {
  console.log(`Slack intake cycle started at ${new Date().toISOString()}`);
  try {
    let cursor = await getSlackIntakeCursor(SHEETS_ID);

    // First run: default to 24h ago so existing channel history isn't replayed.
    if (!cursor) {
      cursor = String((Date.now() / 1000 - 86400).toFixed(6));
      console.log("No cursor found — defaulting to 24h ago.");
    }

    const messages = await getChannelHistory(SLACK_TOKEN, CHANNEL_ID, cursor);

    // conversations.history returns newest-first; process oldest-first so the
    // cursor advances incrementally even if a later message errors.
    const ordered = [...messages].reverse();

    if (ordered.length === 0) {
      console.log("No new messages.");
      return;
    }

    const existingReceiptNumbers = await getExistingReceiptNumbers(SHEETS_ID);

    for (const msg of ordered) {
      const files = msg.files || [];
      const messageText = msg.text || "";
      const userName = msg.user ? await getSlackUserName(SLACK_TOKEN, msg.user) : "unknown";

      for (const file of files) {
        try {
          await processSlackFile({ file, userName, messageText, existingReceiptNumbers });
        } catch (e) {
          console.error(`Error processing file "${file.name}" from ${userName}:`, e.message);
          appendErrorRow(SHEETS_ID, {
            service: "slack-intake",
            sender: userName,
            attachment: file.name,
            error: e.message,
          }).catch(() => {});
        }
      }

      // Advance the cursor after each message so a crash mid-batch doesn't
      // replay already-processed messages on the next run.
      await setSlackIntakeCursor(SHEETS_ID, msg.ts);
    }

    console.log(`Slack intake: processed ${ordered.length} message(s).`);
  } catch (e) {
    console.error("Slack intake cycle failed:", e.message);
    appendErrorRow(SHEETS_ID, {
      service: "slack-intake",
      error: `Cycle failed: ${e.message}`,
    }).catch(() => {});
  }
}

const runOnce = process.argv.includes("--once");

if (runOnce) {
  await pollCycle();
  console.log("Single Slack intake cycle complete (--once).");
} else {
  console.log(`Slack intake running — polling every ${POLL_INTERVAL_MINUTES} minute(s).`);
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MINUTES * 60 * 1000);
}
