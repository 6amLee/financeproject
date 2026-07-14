// ── STATEMENT FINANCECREW — NUDGE POLL CYCLE ─────────────────────────────────
// Separate entry point from slackIntake.js. Statement comparison and Stage 1
// DMs are fired immediately when Yulia uploads a file (via slackIntake.js).
// This process owns the follow-up nudge cycle: every hour it checks open
// Statement Chase Threads and fires Stage 2 (Day 1) or Stage 3 (Day 2) nudges
// when the 24h threshold has passed. After Stage 3 it notifies Yulia and posts
// the colored Excel back to the statements channel.

import { slackPost } from "./src/slackIntake.js";
import {
  getStatementChaseThreads,
  updateStatementChaseThread,
} from "./src/financeCrew/statementChase.js";
import {
  getStatementRuns,
  updateStatementRun,
} from "./src/financeCrew/statementRuns.js";
import { readTabRows } from "./src/sheets.js";
import {
  findReceiptForCharge,
  formatCharge,
  buildNotMineBlocks,
} from "./src/statementIntake.js";
import { downloadDriveFile } from "./src/drive.js";
import { colorStatementExcel } from "./src/statementColoring.js";

if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env — Railway injects directly */ }
}

const REQUIRED_ENV = ["GOOGLE_SERVICE_ACCOUNT_JSON", "GOOGLE_SHEETS_ID", "SLACK_BOT_TOKEN"];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")} — see .env.example`);
  process.exit(1);
}

const SHEETS_ID          = process.env.GOOGLE_SHEETS_ID;
const SLACK_TOKEN        = process.env.SLACK_BOT_TOKEN;
const STATEMENTS_CHANNEL = process.env.SLACK_STATEMENTS_CHANNEL || "";
const COMPANY_CHANNEL    = process.env.SLACK_COMPANY_CHANNEL    || "";
const YULIA_SLACK_ID     = process.env.YULIA_SLACK_ID           || "U088YU5HD4H";
const POLL_INTERVAL_MIN  = Number(process.env.STATEMENT_FINANCECREW_POLL_MINUTES) || 60;
const NUDGE_INTERVAL_MS  = process.env.STATEMENT_NUDGE_INTERVAL_MINUTES
  ? Number(process.env.STATEMENT_NUDGE_INTERVAL_MINUTES) * 60 * 1000
  : 24 * 60 * 60 * 1000; // default 24 hours between stages

const MASTER_DB_RANGE = "'Master DB'!A2:P";

async function slackApi(method, body) {
  return slackPost(SLACK_TOKEN, method, body);
}

// ── Nudge message builders ────────────────────────────────────────────────────

function buildStage2Lead(userName, charges) {
  const vendorCount = new Set(charges.map((c) => c.clusterKey ?? c.merchant)).size;
  return (
    `Hi ${userName} — following up on the charges I flagged yesterday. ` +
    `*${vendorCount} vendor(s)* still have no receipt on file. ` +
    `Please check your inbox, ask your team, and submit anything missing here ASAP — ` +
    `one receipt at a time, right in this chat. If something below isn't yours, use the buttons.`
  );
}

const STAGE2_TRAILER =
  `_If you submitted a receipt recently and it's not here yet, it may still be processing — I'll re-check automatically._`;

function buildStage3Lead(userName, charges) {
  const vendorCount = new Set(charges.map((c) => c.clusterKey ?? c.merchant)).size;
  return (
    `Hi ${userName} — this is the final personal reminder. ` +
    `*${vendorCount} vendor(s)* remain unaccounted for after two rounds of reminders. ` +
    `If something below isn't yours, use the buttons.`
  );
}

const STAGE3_TRAILER = `A company-wide alert is going out now. Please submit before end of day.`;

function buildCompanyBlast(allOutstanding) {
  const lines = allOutstanding
    .flatMap(({ charges }) => charges.map((c) => `• ${formatCharge(c)}`))
    .join("\n");
  const total = allOutstanding.reduce((s, { charges }) => s + charges.length, 0);
  return (
    `📢 *Finance: ${total} unaccounted charge(s) — immediate action required*\n\n` +
    `The following charges from the latest statement have no corresponding receipt ` +
    `after multiple personal reminders. If any of these are yours, submit the receipt ` +
    `by replying in your Finance DM or dropping it in the receipts channel — *right now*.\n\n` +
    `${lines}\n\n` +
    `Every unresolved expense will be escalated to management and flagged for formal review. ` +
    `This is not optional — receipts are a legal and accounting requirement. ` +
    `No further automated reminders will be sent.`
  );
}

function buildYuliaUpdate(allOutstanding) {
  const total = allOutstanding.reduce((s, { charges }) => s + charges.length, 0);
  if (total === 0) {
    return `Hi Yulia 👋 Great news — all charges from the latest statement have been accounted for after the nudge cycle. Nothing outstanding.`;
  }
  const lines = allOutstanding
    .map(({ userName, charges }) =>
      `• *${userName}*: ${charges.map((c) => formatCharge(c)).join(" | ")}`
    )
    .join("\n");
  return (
    `Hi Yulia 👋 The statement chase cycle is complete. ` +
    `*${total} charge(s)* across ${allOutstanding.length} person(s) remain unaccounted for ` +
    `after 3 rounds of nudges. A company-wide alert has been posted.\n\n` +
    `${lines}\n\n` +
    `The colored statement has been posted to the statements channel.`
  );
}

// ── Re-check outstanding charges against current Master DB ────────────────────

async function recheckPending(pendingCharges) {
  if (!pendingCharges?.length) return [];
  const masterRows = await readTabRows(SHEETS_ID, MASTER_DB_RANGE);
  return pendingCharges.filter((charge) => findReceiptForCharge(charge, masterRows) === null);
}

// ── Stage 3: company blast + Yulia notification + colored Excel ───────────────

async function handleStage3(runId, allThreads) {
  const runThreads = allThreads.filter((t) => t.runId === runId);

  const allOutstanding = [];
  for (const thread of runThreads) {
    if (thread.pendingCharges?.length) {
      const stillPending = await recheckPending(thread.pendingCharges);
      if (stillPending.length) {
        allOutstanding.push({ userName: thread.userName, charges: stillPending });
      }
    }
  }

  // Stage 3 DM — personal final warning
  for (const thread of runThreads) {
    if (!thread.pendingCharges?.length) continue;
    const stillPending = allOutstanding.find((o) => o.userName === thread.userName)?.charges ?? [];
    if (!stillPending.length) continue;
    const leadText = buildStage3Lead(thread.userName, stillPending);
    try {
      await slackApi("chat.postMessage", {
        channel: thread.dmChannelId,
        thread_ts: thread.threadTs,
        text: leadText,
        blocks: buildNotMineBlocks({
          leadText, trailerText: STAGE3_TRAILER, charges: stillPending,
          userId: thread.userId, userName: thread.userName, runId: thread.runId,
        }),
      });
    } catch (e) {
      console.warn(`Stage 3 DM to ${thread.userName} failed: ${e.message}`);
    }
  }

  // Company-wide blast
  if (COMPANY_CHANNEL && allOutstanding.length) {
    try {
      await slackApi("chat.postMessage", {
        channel: COMPANY_CHANNEL,
        text: buildCompanyBlast(allOutstanding),
      });
      console.log(`Run ${runId}: company blast posted (${allOutstanding.length} people, ${allOutstanding.reduce((s, o) => s + o.charges.length, 0)} charges).`);
    } catch (e) {
      console.warn(`Company blast failed: ${e.message}`);
    }
  }

  // DM Yulia
  try {
    const conv = await slackApi("conversations.open", { users: YULIA_SLACK_ID });
    await slackApi("chat.postMessage", {
      channel: conv.channel.id,
      text: buildYuliaUpdate(allOutstanding),
    });
    console.log(`Run ${runId}: Yulia notified.`);
  } catch (e) {
    console.warn(`Yulia notification failed: ${e.message}`);
  }

  // Colored Excel
  if (STATEMENTS_CHANNEL) {
    try {
      const runs = await getStatementRuns(SHEETS_ID);
      const run = runs.find((r) => r.runId === runId);
      if (run?.driveFileId) {
        const unmatchedKeys = new Set(
          allOutstanding.flatMap(({ charges }) => charges.map((c) => c.clusterKey))
        );
        const base64Data  = await downloadDriveFile(run.driveFileId);
        const coloredBuf  = await colorStatementExcel({ base64Data, unmatchedKeys });

        // Slack's new 3-step file upload (files.upload v1 is deprecated).
        const filename = `statement_reviewed_${runId}.xlsx`;
        const mimeType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

        // Step 1: get upload URL
        const urlRes = await fetch(
          `https://slack.com/api/files.getUploadURLExternal?filename=${encodeURIComponent(filename)}&length=${coloredBuf.length}`,
          { headers: { Authorization: `Bearer ${SLACK_TOKEN}` } }
        );
        const urlData = await urlRes.json();
        if (!urlData.ok) throw new Error(`files.getUploadURLExternal: ${urlData.error}`);

        // Step 2: upload the bytes
        await fetch(urlData.upload_url, {
          method: "POST",
          headers: { "Content-Type": mimeType },
          body: coloredBuf,
        });

        // Step 3: complete + share to channel
        const completeRes = await fetch("https://slack.com/api/files.completeUploadExternal", {
          method: "POST",
          headers: { Authorization: `Bearer ${SLACK_TOKEN}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            files: [{ id: urlData.file_id }],
            channel_id: STATEMENTS_CHANNEL,
            initial_comment: `Statement review complete — red = no receipt after 3 nudges.`,
          }),
        });
        const completeData = await completeRes.json();
        if (!completeData.ok) throw new Error(`files.completeUploadExternal: ${completeData.error}`);

        console.log(`Run ${runId}: colored statement posted.`);

        // Mark run as complete
        const runRow = runs.find((r) => r.runId === runId);
        if (runRow) {
          await updateStatementRun(SHEETS_ID, runRow.rowNumber, { ...runRow, status: "complete" });
        }
      }
    } catch (e) {
      console.warn(`Colored statement failed for run ${runId}: ${e.message}`);
    }
  }
}

// ── Poll cycle ────────────────────────────────────────────────────────────────

async function pollCycle() {
  console.log(`Statement FinanceCrew cycle started at ${new Date().toISOString()}`);
  try {
    const threads = await getStatementChaseThreads(SHEETS_ID);
    const openThreads = threads.filter((t) => !t.resolved && t.nudgeCount < 3);

    if (openThreads.length === 0) {
      console.log("No open statement chase threads.");
      return;
    }

    const now = Date.now();
    const stage3RunIds = new Set();

    for (const thread of openThreads) {
      try {
        const lastMs = thread.lastNudgeAt ? Date.parse(thread.lastNudgeAt) : 0;
        if (now - lastMs < NUDGE_INTERVAL_MS) continue; // not yet 24h

        const stillPending = await recheckPending(thread.pendingCharges);

        if (!stillPending.length) {
          await updateStatementChaseThread(SHEETS_ID, thread.rowNumber, {
            ...thread, pendingCharges: [], resolved: true,
          });
          console.log(`Thread for ${thread.userName} (run ${thread.runId}): all resolved — closing.`);
          continue;
        }

        const nextCount = thread.nudgeCount + 1; // 2 or 3

        if (nextCount === 2) {
          const leadText = buildStage2Lead(thread.userName, stillPending);
          await slackApi("chat.postMessage", {
            channel: thread.dmChannelId,
            thread_ts: thread.threadTs,
            text: leadText,
            blocks: buildNotMineBlocks({
              leadText, trailerText: STAGE2_TRAILER, charges: stillPending,
              userId: thread.userId, userName: thread.userName, runId: thread.runId,
            }),
          });
          console.log(`Stage 2 nudge → ${thread.userName} (${stillPending.length} charges).`);
        }

        await updateStatementChaseThread(SHEETS_ID, thread.rowNumber, {
          ...thread,
          nudgeCount:     nextCount,
          lastNudgeAt:    new Date().toISOString(),
          pendingCharges: stillPending,
          resolved:       false,
        });

        if (nextCount === 3) stage3RunIds.add(thread.runId);
      } catch (e) {
        console.error(`Error processing thread for ${thread.userName}:`, e.message);
      }
    }

    for (const runId of stage3RunIds) {
      await handleStage3(runId, threads);
    }
  } catch (e) {
    console.error("Statement FinanceCrew cycle failed:", e.message);
  }
}

const runOnce = process.argv.includes("--once");
if (runOnce) {
  await pollCycle();
  console.log("Single statement FinanceCrew cycle complete (--once).");
} else {
  console.log(`Statement FinanceCrew running — polling every ${POLL_INTERVAL_MIN} minute(s).`);
  await pollCycle();
  setInterval(pollCycle, POLL_INTERVAL_MIN * 60 * 1000);
}
