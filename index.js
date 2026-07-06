// ── RECEIPT INTAKE ────────────────────────────────────────────────────────────
// Replaces the Make.com scenario: Gmail (Finance Stuff label) → Drive → Claude
// → Master DB row. Run with --once for a single poll cycle (local testing);
// default keeps polling on an interval (Railway).

import { listUnprocessedMessages, getMessageContent, markProcessed } from "./src/gmail.js";
import { extractReceiptData } from "./src/claude.js";
import { parseClaudeJson } from "./src/parseJson.js";
import { uploadToDrive } from "./src/drive.js";
import { getExistingReceiptNumbers, appendReceiptRow, buildReceiptRow } from "./src/sheets.js";

// Load .env for local runs if this Node version supports it (20.12+).
// On Railway env vars are injected directly, so this is best-effort.
if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
}

const REQUIRED_ENV = ["ANTHROPIC_API_KEY", "GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEETS_ID"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")} — see .env.example`);
  process.exit(1);
}

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const POLL_INTERVAL_MINUTES = Number(process.env.POLL_INTERVAL_MINUTES) || 5;

const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function gmailPermalink(messageId) {
  return `https://mail.google.com/mail/u/0/#all/${messageId}`;
}

// Extract from one attachment: archive to Drive, read with Claude.
// Returns { parsed, invoiceLink } or null if the mimeType is unsupported.
async function processAttachment(attachment) {
  const { filename, mimeType, base64Data } = attachment;
  const isPdf = mimeType === "application/pdf";
  const isImage = IMAGE_MIME_TYPES.has(mimeType);

  if (!isPdf && !isImage) {
    console.warn(`Skipping unsupported attachment "${filename}" (${mimeType})`);
    return null;
  }

  const invoiceLink = await uploadToDrive({
    filename,
    mimeType,
    base64Data,
    folderId: DRIVE_FOLDER_ID,
  });
  const rawText = await extractReceiptData({ mimeType, base64Data });
  return { parsed: parseClaudeJson(rawText), invoiceLink };
}

async function processMessage(messageId, existingReceiptNumbers) {
  const { from, subject, attachments, textBody } = await getMessageContent(messageId);
  console.log(`Processing message ${messageId} from ${from} — "${subject}" (${attachments.length} attachment(s))`);

  const extractions = [];

  if (attachments.length > 0) {
    for (const attachment of attachments) {
      const result = await processAttachment(attachment);
      if (result) extractions.push(result);
    }
  } else {
    // Branch B — body-only e-receipt (LinkedIn/SaaS emails with no attachment).
    if (!textBody.trim()) {
      console.warn(`Message ${messageId} has no attachments and no text body — nothing to extract`);
    } else {
      const rawText = await extractReceiptData({ textBody });
      extractions.push({
        parsed: parseClaudeJson(rawText),
        invoiceLink: gmailPermalink(messageId),
      });
    }
  }

  for (const { parsed, invoiceLink } of extractions) {
    if (parsed.is_receipt !== true) {
      console.log(`Not a receipt (is_receipt=${parsed.is_receipt}) — skipping row`);
      continue;
    }
    const receiptNo = (parsed.receipt_no ?? "").toString().trim();
    if (receiptNo && existingReceiptNumbers.has(receiptNo)) {
      console.log(`Duplicate receipt_no "${receiptNo}" (${parsed.provider}) — skipping row`);
      continue;
    }
    await appendReceiptRow(SHEETS_ID, buildReceiptRow({ parsed, sourceEmail: from, invoiceLink }));
    if (receiptNo) existingReceiptNumbers.add(receiptNo);
    console.log(`Added row: ${parsed.provider} · ${parsed.amount} ${parsed.currency} · ${parsed.document_type || "receipt"} ${receiptNo || "(none)"}`);
  }

  // Swap labels so the message isn't reprocessed on the next tick.
  await markProcessed(messageId);
}

async function pollCycle() {
  console.log(`Poll cycle started at ${new Date().toISOString()}`);
  try {
    const messageIds = await listUnprocessedMessages();
    if (messageIds.length === 0) {
      console.log("No unprocessed messages.");
      return;
    }

    const existingReceiptNumbers = await getExistingReceiptNumbers(SHEETS_ID);

    for (const messageId of messageIds) {
      try {
        await processMessage(messageId, existingReceiptNumbers);
      } catch (e) {
        // One bad email must not kill the cycle — leave its labels alone so
        // it's retried next tick, log, and move on.
        console.error(`Error processing message ${messageId}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Poll cycle failed:", e.message);
  }
}

const runOnce = process.argv.includes("--once");

if (runOnce) {
  await pollCycle();
  console.log("Single poll cycle complete (--once).");
} else {
  console.log(`Receipt intake running — polling every ${POLL_INTERVAL_MINUTES} minute(s).`);
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MINUTES * 60 * 1000);
}
