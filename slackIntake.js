// ── SLACK RECEIPT INTAKE ──────────────────────────────────────────────────────
// Polls a designated Slack channel for receipt file uploads. When a file is
// detected, Claude attempts extraction and the bot posts a "Fill in details"
// button as a thread reply. Clicking the button opens a pre-filled modal —
// the user confirms or corrects the fields and submits, which writes the row.
//
// Also runs an HTTP server (process.env.PORT) that Slack calls for all
// interactive payloads (button clicks, modal submissions). Configure in
// Slack App → Interactivity & Shortcuts → Request URL:
//   https://<railway-service-url>/slack/interactions

import http from "http";
import crypto from "crypto";
import { getChannelHistory, downloadSlackFile, getSlackUserName, slackPost } from "./src/slackIntake.js";
import { extractReceiptData } from "./src/claude.js";
import { parseClaudeJson } from "./src/parseJson.js";
import { uploadToDrive, downloadDriveFile } from "./src/drive.js";
import {
  appendReceiptRow,
  buildReceiptRow,
  appendErrorRow,
  getSlackIntakeCursor,
  setSlackIntakeCursor,
  setReceiptStatus,
} from "./src/sheets.js";
import {
  runStatementComparison,
  buildPendingCharge,
  formatCharge,
  matchReceiptToPendingCharge,
} from "./src/statementIntake.js";
import { appendStatementChaseThread, getStatementChaseThreads, updateStatementChaseThread } from "./src/rambo/statementChase.js";
import { appendStatementRun } from "./src/rambo/statementRuns.js";
import { resolveSlackId } from "./src/rambo/slackIds.js";

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

const SHEETS_ID         = process.env.GOOGLE_SHEETS_ID;
const DRIVE_FOLDER_ID   = process.env.GOOGLE_DRIVE_FOLDER_ID || "";
const SLACK_TOKEN       = process.env.SLACK_BOT_TOKEN;
const CHANNEL_ID        = process.env.SLACK_INTAKE_CHANNEL;
const SIGNING_SECRET    = process.env.SLACK_SIGNING_SECRET || "";
const POLL_INTERVAL_MIN   = Number(process.env.SLACK_INTAKE_POLL_MINUTES) || 5;
const STATEMENTS_CHANNEL  = process.env.SLACK_STATEMENTS_CHANNEL || "";

const SUPPORTED_MIME_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

function normaliseMime(slackMime) {
  return slackMime?.replace("_", "/") ?? "";
}

const REIMBURSE_PATTERN = /\b(personal|personally|mine|my own|reimburse|reimbursement|paid myself|i paid)\b/i;

// ── SLACK API ─────────────────────────────────────────────────────────────────

async function slackApi(method, body) {
  return slackPost(SLACK_TOKEN, method, body);
}

// ── SLACK SIGNATURE VERIFICATION ─────────────────────────────────────────────

function verifySlackRequest(rawBody, timestamp, signature) {
  if (!SIGNING_SECRET) return true; // skip if not configured
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (age > 300) return false;
  const base = `v0:${timestamp}:${rawBody}`;
  const computed = "v0=" + crypto.createHmac("sha256", SIGNING_SECRET).update(base).digest("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(computed), Buffer.from(signature));
  } catch {
    return false;
  }
}

// ── MODAL BUILDER ─────────────────────────────────────────────────────────────

const CC_OPTIONS = [
  opt("4154", "4154 — Amex (Roee)"),
  opt("9037", "9037 — Amex (Ron)"),
  opt("4287", "4287 — Amex"),
  opt("5438", "5438 — Visa (Roee)"),
  opt("0375", "0375 — Visa (Ron)"),
];

const EXPENSE_TYPES = [
  "Advertising", "Business meetings", "Company event", "Computer maintenance",
  "Gas", "Gifts for Employees", "Gifts for partners", "Office equipment",
  "Other", "Parking", "Professional services", "Refreshments / Snacks",
  "Taxi/Train/Bus", "Team lunch/ Dinner",
];

function opt(value, label) {
  return { text: { type: "plain_text", text: label || value }, value };
}

function textInput(blockId, label, initial, placeholder, optional = false, multiline = false) {
  return {
    type: "input",
    block_id: blockId,
    optional,
    label: { type: "plain_text", text: label },
    element: {
      type: "plain_text_input",
      action_id: "val",
      multiline,
      ...(initial != null && initial !== "" ? { initial_value: String(initial) } : {}),
      ...(placeholder ? { placeholder: { type: "plain_text", text: placeholder } } : {}),
    },
  };
}

function selectInput(blockId, label, options, initial, placeholder) {
  const initialOpt = initial ? options.find((o) => o.value === initial) : null;
  return {
    type: "input",
    block_id: blockId,
    label: { type: "plain_text", text: label },
    element: {
      type: "static_select",
      action_id: "val",
      options,
      ...(initialOpt ? { initial_option: initialOpt } : {}),
      ...(placeholder ? { placeholder: { type: "plain_text", text: placeholder } } : {}),
    },
  };
}

function buildConfirmView({ parsed, meta }) {
  const p = parsed || {};
  const ccLabel = CC_OPTIONS.find((o) => o.value === p.cc_last4)?.text?.text || p.cc_last4 || null;
  const lines = [
    `*Provider:* ${p.provider || "—"}`,
    `*Date of Purchase:* ${p.date || "—"}`,
    `*Amount:* ${p.amount ? `${p.amount} ${p.currency || ""}`.trim() : "—"}`,
    `*Expense Type:* ${p.expense_type || "—"}`,
    `*Paid By:* ${p.paid_by || "—"}`,
    ...(p.paid_by === "Organization" ? [`*Credit Card:* ${ccLabel || "—"}`] : []),
    ...(p.receipt_no ? [`*Receipt / Invoice #:* ${p.receipt_no}`] : []),
    ...(p.notes ? [`*Notes:* ${p.notes}`] : []),
    ...(meta?.invoiceLink ? [`*Document:* <${meta.invoiceLink}|View in Drive>`] : []),
  ];
  return {
    type: "modal",
    callback_id: "receipt_confirm",
    title: { type: "plain_text", text: "Confirm Receipt" },
    submit: { type: "plain_text", text: "Confirm & Submit" },
    close: { type: "plain_text", text: "Back" },
    private_metadata: JSON.stringify({ parsed: p, meta: meta || {} }),
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: "Please review the details below, then confirm or go back to edit." },
      },
      { type: "divider" },
      {
        type: "section",
        text: { type: "mrkdwn", text: lines.join("\n") },
      },
    ],
  };
}

function buildModal({ prepped, meta }) {
  const p = prepped || {};
  // CC field is hidden when the submitter is paying personally — no company card involved.
  const showCC = p.paid_by !== "Employee";
  return {
    type: "modal",
    callback_id: "receipt_form",
    title: { type: "plain_text", text: "Receipt Details" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    private_metadata: JSON.stringify(meta || {}),
    blocks: [
      textInput("provider", "Provider / Merchant", p.provider, "e.g. Rami Levi, Wolt, Amazon"),
      {
        type: "input",
        block_id: "date",
        label: { type: "plain_text", text: "Date of Purchase" },
        element: {
          type: "datepicker",
          action_id: "val",
          ...(p.date ? { initial_date: p.date } : {}),
          placeholder: { type: "plain_text", text: "Select date" },
        },
      },
      textInput("amount", "Amount", p.amount, "e.g. 150.00"),
      selectInput("currency", "Currency",
        ["ILS", "USD", "EUR"].map((c) => opt(c)),
        p.currency, "Select currency"
      ),
      selectInput("expense_type", "Expense Type",
        EXPENSE_TYPES.map((e) => opt(e)),
        p.expense_type, "Select type"
      ),
      // dispatch_action: re-render the modal when Paid By changes so the
      // CC field appears (Organization) or disappears (Employee) immediately.
      {
        type: "input",
        block_id: "paid_by",
        dispatch_action: true,
        label: { type: "plain_text", text: "Paid By" },
        element: {
          type: "static_select",
          action_id: "val",
          options: [opt("Organization"), opt("Employee")],
          ...(p.paid_by ? { initial_option: opt(p.paid_by) } : {}),
          placeholder: { type: "plain_text", text: "Select" },
        },
      },
      ...(showCC ? [selectInput("cc_last4", "Credit Card (required for organization expenses)",
        CC_OPTIONS, p.cc_last4, "Select card")] : []),
      textInput("receipt_no", "Receipt / Invoice # (optional)", p.receipt_no, "as printed on document", true),
      textInput("notes", "Notes (optional)", p.notes, "Any additional context", true, true),
    ],
  };
}

// ── HTTP SERVER ───────────────────────────────────────────────────────────────

const server = http.createServer((req, res) => {
  const isInteractions = req.url === "/slack/interactions";
  const isEvents       = req.url === "/slack/events";
  if (req.method !== "POST" || (!isInteractions && !isEvents)) {
    res.writeHead(404); res.end(); return;
  }

  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", async () => {
    const rawBody = Buffer.concat(chunks).toString();
    console.log(`Slack request received: ${req.method} ${req.url} (${rawBody.length} bytes)`);

    if (!verifySlackRequest(
      rawBody,
      req.headers["x-slack-request-timestamp"] || "",
      req.headers["x-slack-signature"] || ""
    )) {
      console.error("Slack signature verification failed — check SLACK_SIGNING_SECRET");
      res.writeHead(403); res.end("Forbidden"); return;
    }

    // ── Events API ──────────────────────────────────────────────────────────
    if (isEvents) {
      let event;
      try { event = JSON.parse(rawBody); } catch {
        res.writeHead(400); res.end(); return;
      }
      if (event.type === "url_verification") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ challenge: event.challenge }));
        return;
      }
      if (event.type === "event_callback") {
        res.writeHead(200); res.end();
        const ev = event.event;
        if (ev?.files?.length) {
          const isStatements = STATEMENTS_CHANNEL && ev.channel === STATEMENTS_CHANNEL;
          const isDm         = !isStatements && ev.channel?.startsWith("D");
          const handler      = isStatements ? handleStatementUpload
                             : isDm        ? handleDmReceipt
                             :               handleIncomingMessage;
          handler(ev).catch((e) => console.error("Event handler error:", e.message));
        }
        return;
      }
      res.writeHead(200); res.end();
      return;
    }

    // ── Interactions ─────────────────────────────────────────────────────────
    let payload;
    try {
      payload = JSON.parse(new URLSearchParams(rawBody).get("payload") || "{}");
    } catch (e) {
      console.error("Failed to parse Slack payload:", e.message);
      res.writeHead(400); res.end(); return;
    }

    console.log(`Slack payload type: ${payload.type}, action: ${payload.actions?.[0]?.action_id || payload.view?.callback_id || "n/a"}`);

    try {
      if (payload.type === "block_actions") {
        const action = payload.actions?.[0];

        if (action?.action_id === "open_receipt_modal") {
          const data = JSON.parse(action.value);
          const result = await slackApi("views.open", {
            trigger_id: payload.trigger_id,
            view: buildModal(data),
          });
          console.log(`views.open result: ok=${result.ok}`);
        }

        // Paid By changed — re-render modal to show/hide CC field.
        if (action?.block_id === "paid_by") {
          const cv = payload.view?.state?.values || {};
          const newPaidBy = action.selected_option?.value;
          const currentPrepped = {
            provider:     cv.provider?.val?.value ?? null,
            date:         cv.date?.val?.selected_date ?? null,
            amount:       cv.amount?.val?.value ?? null,
            currency:     cv.currency?.val?.selected_option?.value ?? null,
            expense_type: cv.expense_type?.val?.selected_option?.value ?? null,
            paid_by:      newPaidBy,
            cc_last4:     cv.cc_last4?.val?.selected_option?.value ?? null,
            receipt_no:   cv.receipt_no?.val?.value ?? null,
            notes:        cv.notes?.val?.value ?? null,
          };
          const meta = JSON.parse(payload.view?.private_metadata || "{}");
          await slackApi("views.update", {
            view_id: payload.view.id,
            view: buildModal({ prepped: currentPrepped, meta }),
          });
        }

        res.writeHead(200); res.end(); return;
      }

      if (payload.type === "view_submission" && payload.view?.callback_id === "receipt_form") {
        const vals = payload.view.state.values;
        const pick = (blockId) => {
          const b = vals[blockId]?.val;
          return b?.value ?? b?.selected_option?.value ?? b?.selected_date ?? null;
        };
        const paidBy = vals.paid_by?.val?.selected_option?.value;
        const cc    = vals.cc_last4?.val?.selected_option?.value;

        // Validate: Organization expense requires a credit card selection.
        if (paidBy === "Organization" && !cc) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            response_action: "errors",
            errors: { cc_last4: "Required for organization expenses — select the card used" },
          }));
          return;
        }

        // Push confirmation view — user reviews and clicks "Confirm & Submit" or "Back".
        const meta = JSON.parse(payload.view.private_metadata || "{}");
        const parsed = {
          provider:     pick("provider"),
          date:         pick("date"),
          amount:       pick("amount"),
          currency:     pick("currency"),
          expense_type: pick("expense_type"),
          paid_by:      paidBy,
          cc_last4:     cc || null,
          receipt_no:   pick("receipt_no") || null,
          notes:        pick("notes") || null,
        };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({
          response_action: "push",
          view: buildConfirmView({ parsed, meta }),
        }));
        return;
      }

      if (payload.type === "view_submission" && payload.view?.callback_id === "receipt_confirm") {
        // User confirmed — ack immediately and write to sheet in background.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ response_action: "clear" }));
        const { parsed, meta } = JSON.parse(payload.view.private_metadata || "{}");
        writeReceiptToSheet({ parsed, meta }).catch((e) =>
          console.error("Receipt confirm error:", e.message)
        );
        return;
      }
    } catch (e) {
      console.error("Interaction handler error:", e.message, e.stack);
    }

    res.writeHead(200); res.end();
  });
});

server.listen(process.env.PORT || 3000, () => {
  console.log(`Slack interactions server listening on port ${process.env.PORT || 3000}`);
});

// ── SHEET WRITE ───────────────────────────────────────────────────────────────

async function writeReceiptToSheet({ parsed, meta }) {
  const cardholder = parsed.paid_by === "Employee" ? (meta.userName || "") : "";

  await appendReceiptRow(
    SHEETS_ID,
    buildReceiptRow({
      parsed: {
        is_receipt: true,
        document_type: "receipt",
        suggested_paid_by: parsed.paid_by,
        ...parsed,
      },
      sourceEmail: `slack:${meta.userName || "unknown"}`,
      invoiceLink: meta.invoiceLink || "",
      cardholder,
    })
  );

  console.log(`Receipt submitted: ${parsed.provider} · ${parsed.amount} ${parsed.currency} by ${meta.userName}`);

  try {
    await slackApi("chat.postMessage", {
      channel: meta.channelId,
      thread_ts: meta.msgTs,
      text: `✅ Logged: *${parsed.provider || "receipt"}* · ${parsed.amount || "?"} ${parsed.currency || ""}`,
    });
  } catch (e) {
    console.warn("Confirmation message failed:", e.message);
  }
}

// ── STATEMENT UPLOAD HANDLER ─────────────────────────────────────────────────

async function handleStatementUpload(msg) {
  const files = msg.files || [];
  const excelFile = files.find((f) =>
    f.name?.endsWith(".xlsx") || f.name?.endsWith(".xls") ||
    (f.mimetype || "").includes("spreadsheet") || (f.mimetype || "").includes("excel")
  );
  if (!excelFile) {
    console.log("Statement upload: no Excel file found — ignoring.");
    return;
  }

  const uploaderName = msg.user ? await getSlackUserName(SLACK_TOKEN, msg.user) : "unknown";
  console.log(`Statement upload from ${uploaderName}: ${excelFile.name}`);

  let base64Data;
  try {
    base64Data = await downloadSlackFile(SLACK_TOKEN, excelFile.url_private);
  } catch (e) {
    console.error(`Failed to download statement: ${e.message}`);
    await slackApi("chat.postMessage", {
      channel: STATEMENTS_CHANNEL,
      thread_ts: msg.ts,
      text: `❌ Couldn't download "${excelFile.name}" — please try uploading again.`,
    }).catch(() => {});
    return;
  }

  // Upload to Drive so the nudge cycle can re-download for colored output.
  let driveFileId = null;
  try {
    const webViewLink = await uploadToDrive({
      filename: excelFile.name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      base64Data,
      folderId: DRIVE_FOLDER_ID,
    });
    const match = webViewLink.match(/\/d\/([^/]+)/);
    driveFileId = match?.[1] ?? null;
  } catch (e) {
    console.warn(`Statement Drive upload failed: ${e.message}`);
  }

  let comparison;
  try {
    comparison = await runStatementComparison({ base64Data, sheetsId: SHEETS_ID });
  } catch (e) {
    console.error(`Statement comparison failed: ${e.message}`);
    await slackApi("chat.postMessage", {
      channel: STATEMENTS_CHANNEL,
      thread_ts: msg.ts,
      text: `❌ Failed to process the statement: ${e.message}`,
    }).catch(() => {});
    return;
  }

  const runId = `run_${Date.now()}`;
  await appendStatementRun(SHEETS_ID, {
    runId,
    channelId:   STATEMENTS_CHANNEL,
    messageTs:   msg.ts,
    driveFileId: driveFileId || "",
    startedAt:   new Date().toISOString(),
    status:      "active",
  });

  const { byOwner } = comparison;
  let dmCount = 0;
  for (const [ownerName, items] of byOwner) {
    const slackId = resolveSlackId(ownerName);
    if (!slackId) {
      console.warn(`No Slack ID for owner "${ownerName}" — skipping DM.`);
      continue;
    }

    const pendingCharges = [];
    for (const { cluster, pendingTxns } of items) {
      for (const txn of pendingTxns) {
        pendingCharges.push(buildPendingCharge(txn, cluster.key));
      }
    }
    if (!pendingCharges.length) continue;

    const chargeList = pendingCharges.map((c, i) => `${i + 1}. ${formatCharge(c)}`).join("\n");
    const stage1Text =
      `Hi ${ownerName} 👋 Yulia has uploaded the latest bank statement and I found ` +
      `*${pendingCharges.length} charge(s)* that don't yet have a matching receipt on file:\n\n` +
      `${chargeList}\n\n` +
      `If any of these are yours, drop the receipt(s) right here in this chat — one at a time. ` +
      `I'll match them automatically.`;

    try {
      const conv     = await slackApi("conversations.open", { users: slackId });
      const dmChanId = conv.channel.id;
      const dmResult = await slackApi("chat.postMessage", { channel: dmChanId, text: stage1Text });
      const threadTs = dmResult.message?.ts || dmResult.ts;

      await appendStatementChaseThread(SHEETS_ID, {
        runId,
        userName:      ownerName,
        userId:        slackId,
        dmChannelId:   dmChanId,
        threadTs,
        nudgeCount:    1,
        lastNudgeAt:   new Date().toISOString(),
        pendingCharges,
        resolved:      false,
      });

      dmCount++;
      console.log(`Stage 1 DM sent to ${ownerName} (${pendingCharges.length} charges).`);
    } catch (e) {
      console.error(`Failed to DM ${ownerName}: ${e.message}`);
    }
  }

  await slackApi("chat.postMessage", {
    channel: STATEMENTS_CHANNEL,
    thread_ts: msg.ts,
    text:
      `✅ Statement processed: *${comparison.totalCharges}* total charges, ` +
      `*${comparison.matchedCount}* already matched, ` +
      `*${comparison.unmatchedCount}* unaccounted. ` +
      `DMs sent to *${dmCount}* person(s). ` +
      `I'll follow up automatically if charges remain open.`,
  }).catch(() => {});
}

// ── DM RECEIPT HANDLER ────────────────────────────────────────────────────────

async function handleDmReceipt(msg) {
  const files = msg.files || [];
  if (!files.length || !msg.thread_ts) return;

  let allThreads;
  try {
    allThreads = await getStatementChaseThreads(SHEETS_ID);
  } catch (e) {
    console.error(`handleDmReceipt: could not load chase threads: ${e.message}`);
    return;
  }

  const thread = allThreads.find(
    (t) => t.dmChannelId === msg.channel && t.threadTs === msg.thread_ts && !t.resolved
  );
  if (!thread) return; // not a statement chase thread — ignore

  const file     = files[0];
  const mimeType = normaliseMime(file.mimetype);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    await slackApi("chat.postMessage", {
      channel:   msg.channel,
      thread_ts: msg.thread_ts,
      text: `I can't read that file type (${file.mimetype || "unknown"}). Please send a PDF or image.`,
    }).catch(() => {});
    return;
  }

  let base64Data;
  try {
    base64Data = await downloadSlackFile(SLACK_TOKEN, file.url_private);
  } catch (e) {
    console.error(`DM receipt download failed: ${e.message}`);
    return;
  }

  let invoiceLink = "";
  try {
    invoiceLink = await uploadToDrive({ filename: file.name, mimeType, base64Data, folderId: DRIVE_FOLDER_ID });
  } catch (e) {
    console.warn(`DM receipt Drive upload failed: ${e.message}`);
  }

  let extracted = null;
  try {
    const context = `Receipt submitted by ${thread.userName} to resolve an outstanding charge.`;
    const rawText = await extractReceiptData({ mimeType, base64Data, context });
    extracted = parseClaudeJson(rawText);
  } catch (e) {
    console.warn(`DM receipt extraction failed: ${e.message}`);
  }

  if (!extracted) {
    await slackApi("chat.postMessage", {
      channel:   msg.channel,
      thread_ts: msg.thread_ts,
      text: `I had trouble reading that receipt. Could you send a clearer version?`,
    }).catch(() => {});
    return;
  }

  const matched = matchReceiptToPendingCharge(extracted, thread.pendingCharges);
  if (!matched) {
    const chargeList = thread.pendingCharges.map((c, i) => `${i + 1}. ${formatCharge(c)}`).join("\n");
    await slackApi("chat.postMessage", {
      channel:   msg.channel,
      thread_ts: msg.thread_ts,
      text:
        `I couldn't match that receipt to any of your outstanding charges.\n` +
        `Please double-check the amount and merchant name. Outstanding charges:\n` +
        chargeList,
    }).catch(() => {});
    return;
  }

  // Write to Master DB with Status = "Matched" from the start.
  const rowValues = buildReceiptRow({
    parsed: {
      is_receipt:        true,
      document_type:     "receipt",
      suggested_paid_by: extracted.suggested_paid_by ?? "Organization",
      ...extracted,
    },
    sourceEmail: `slack-dm:${thread.userName}`,
    invoiceLink,
    cardholder: thread.userName,
  });
  rowValues[13] = "Matched"; // N column — override default "Pending"
  await appendReceiptRow(SHEETS_ID, rowValues);

  const remaining   = thread.pendingCharges.filter((c) => c.clusterKey !== matched.clusterKey);
  const allResolved = remaining.length === 0;

  await updateStatementChaseThread(SHEETS_ID, thread.rowNumber, {
    ...thread,
    pendingCharges: remaining,
    resolved:       allResolved,
  });

  await slackApi("chat.postMessage", {
    channel:   msg.channel,
    thread_ts: msg.thread_ts,
    text:
      `✅ Matched to *${formatCharge(matched)}* and logged.\n` +
      (allResolved
        ? `You're all clear! All your outstanding charges are now accounted for. 🎉`
        : `*${remaining.length}* charge(s) still outstanding:\n` +
          remaining.map((c, i) => `${i + 1}. ${formatCharge(c)}`).join("\n")),
  }).catch(() => {});
}

// ── MESSAGE HANDLER (shared by Events API and poll) ───────────────────────────

// Tracks message timestamps we've already processed so the poll fallback
// doesn't double-post the button when the Events API already handled it.
const recentlyProcessed = new Set();

async function handleIncomingMessage(msg) {
  const files = msg.files || [];
  if (!files.length) return;

  if (files.length > 1) {
    await slackApi("chat.postMessage", {
      channel: msg.channel || CHANNEL_ID,
      thread_ts: msg.ts,
      text:
        `Whoa! 📎 ${files.length} attachments at once? Bold strategy.\n\n` +
        `I work one receipt at a time — please re-upload each receipt as a *separate message*. ` +
        `I'll be right here waiting. Promise. 🤌`,
    }).catch(() => {});
    return;
  }

  if (recentlyProcessed.has(msg.ts)) {
    console.log(`Skipping already-processed message ${msg.ts}`);
    return;
  }
  recentlyProcessed.add(msg.ts);
  // Trim the set to avoid unbounded growth across a long-running process.
  if (recentlyProcessed.size > 500) {
    recentlyProcessed.delete(recentlyProcessed.values().next().value);
  }

  const userName = msg.user ? await getSlackUserName(SLACK_TOKEN, msg.user) : "unknown";
  for (const file of files) {
    try {
      await processSlackFile({ file, msg, userName });
    } catch (e) {
      console.error(`Error processing "${file.name}" from ${userName}:`, e.message);
      appendErrorRow(SHEETS_ID, {
        service: "slack-intake",
        sender: userName,
        attachment: file.name,
        error: e.message,
      }).catch(() => {});
    }
  }
}

// ── POLLING LOOP ──────────────────────────────────────────────────────────────

async function processSlackFile({ file, msg, userName }) {
  const mimeType = normaliseMime(file.mimetype);
  if (!SUPPORTED_MIME_TYPES.has(mimeType)) {
    console.warn(`Skipping unsupported file "${file.name}" (${file.mimetype})`);
    return;
  }

  const base64Data = await downloadSlackFile(SLACK_TOKEN, file.url_private);

  // Upload to Drive immediately so the link is embedded in the modal.
  let invoiceLink = "";
  try {
    invoiceLink = await uploadToDrive({
      filename: file.name,
      mimeType,
      base64Data,
      folderId: DRIVE_FOLDER_ID,
    });
  } catch (e) {
    console.warn(`Drive upload failed for "${file.name}": ${e.message}`);
  }

  // Best-effort Claude extraction — failures just leave the modal empty.
  let prepped = {};
  try {
    const context = msg.text?.trim()
      ? `Submitted via Slack by ${userName}. Their message: "${msg.text.trim()}"`
      : `Submitted via Slack by ${userName}.`;
    const rawText = await extractReceiptData({ mimeType, base64Data, context });
    const parsed = parseClaudeJson(rawText);
    prepped = {
      provider:    parsed.provider    ?? null,
      date:        parsed.date        ?? null,
      amount:      parsed.amount   != null ? String(parsed.amount) : null,
      currency:    parsed.currency    ?? null,
      expense_type: parsed.expense_type ?? null,
      paid_by:     parsed.suggested_paid_by ?? null,
      cc_last4:    parsed.cc_last4 ? String(parsed.cc_last4) : null,
      receipt_no:  parsed.receipt_no  ?? null,
      notes:       parsed.notes       ?? null,
    };
    if (REIMBURSE_PATTERN.test(msg.text || "")) prepped.paid_by = "Employee";
  } catch (e) {
    console.warn(`Claude extraction failed for "${file.name}": ${e.message} — modal opens with empty fields`);
  }

  // Slack button value limit is 2000 chars — truncate notes if needed.
  if (prepped.notes && prepped.notes.length > 150) prepped.notes = prepped.notes.slice(0, 150);

  const meta = { invoiceLink, channelId: CHANNEL_ID, userId: msg.user, userName, msgTs: msg.ts };

  await slackApi("chat.postMessage", {
    channel: CHANNEL_ID,
    thread_ts: msg.ts,
    text: `Receipt from ${userName} — click to fill in details`,
    blocks: [
      {
        type: "section",
        text: {
          type: "mrkdwn",
          text: `*Receipt received* from *${userName}*\nI've pre-filled what I could read — please review and submit.`,
        },
      },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            text: { type: "plain_text", text: "📋  Fill in details" },
            style: "primary",
            action_id: "open_receipt_modal",
            value: JSON.stringify({ prepped, meta }),
          },
        ],
      },
    ],
  });

  console.log(`Posted receipt prompt for "${file.name}" from ${userName}`);
}

async function pollCycle() {
  console.log(`Slack intake cycle started at ${new Date().toISOString()}`);
  try {
    let cursor = await getSlackIntakeCursor(SHEETS_ID);
    if (!cursor) {
      cursor = String((Date.now() / 1000 - 86400).toFixed(6));
      console.log("No cursor found — defaulting to 24h ago.");
    }

    const messages = await getChannelHistory(SLACK_TOKEN, CHANNEL_ID, cursor);
    const ordered = [...messages].reverse(); // oldest-first

    if (ordered.length === 0) {
      console.log("No new messages.");
      return;
    }

    for (const msg of ordered) {
      await handleIncomingMessage(msg);       // no-op if already handled by Events API
      await setSlackIntakeCursor(SHEETS_ID, msg.ts);
    }

    console.log(`Slack intake: processed ${ordered.length} message(s).`);
  } catch (e) {
    console.error("Slack intake cycle failed:", e.message);
  }
}

const runOnce = process.argv.includes("--once");

if (runOnce) {
  await pollCycle();
  console.log("Single Slack intake cycle complete (--once).");
} else {
  console.log(`Slack intake running — polling every ${POLL_INTERVAL_MIN} minute(s).`);
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MIN * 60 * 1000);
}
