// ── THE RACHEL — STATEMENT RECONCILIATION + SLACK CHASE ──────────────────────
// Separate entry point from index.js, per the design doc's explicit decision:
// intake polls Gmail every few minutes, the chase cadence is measured in
// hours, so they are different processes with different intervals. Run with
// --once for a single cycle (local testing) and/or --dry-run to log intended
// Slack messages instead of sending (and skip all state writes), so the
// cadence can be verified before real nudges go out to real people.
//
// Restart safety: there is no in-process last-run bookkeeping to carry across
// restarts (same as index.js) — the double-fire protection for nudges lives
// in the PERSISTED chase state (lastNudgeAt in the "Rachel Chase State" tab),
// which nextChaseAction consults, so a restarted process never re-sends a
// nudge whose threshold already fired.

import { normalizeStatement } from "./src/rachel/normalizer.js";
import { parseOwnershipSheet } from "./src/rachel/ownership.js";
import { matchReceipts, clusterTransactions } from "./src/rachel/matcher.js";
import { resolveOwner } from "./src/rachel/resolver.js";
import { getLedgerEntries } from "./src/rachel/ledger.js";
import {
  getChaseStates,
  appendChaseState,
  updateChaseState,
} from "./src/rachel/chaseState.js";
import {
  nextChaseAction,
  buildChaseMessage,
  getChaseRecipients,
  sendChaseNudges,
} from "./src/rachel/chase.js";
import { readTabRows } from "./src/sheets.js";

// Load .env for local runs if this Node version supports it (20.12+).
// On Railway env vars are injected directly, so this is best-effort.
if (typeof process.loadEnvFile === "function") {
  try { process.loadEnvFile(); } catch { /* no .env file — fine */ }
}

const runOnce = process.argv.includes("--once");
const dryRun = process.argv.includes("--dry-run");

// SLACK_BOT_TOKEN is exempt under --dry-run: nothing is sent, so cadence can
// be verified before the Finance Slack app even exists (design doc open
// decision #3 — the token hasn't been created yet).
const REQUIRED_ENV = [
  "GOOGLE_SERVICE_ACCOUNT_JSON",
  "GOOGLE_SHEETS_ID",
  ...(dryRun ? [] : ["SLACK_BOT_TOKEN"]),
];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length > 0) {
  console.error(`Missing required env vars: ${missingEnv.join(", ")} — see .env.example`);
  process.exit(1);
}

const SHEETS_ID = process.env.GOOGLE_SHEETS_ID;
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || "";
// Separate from index.js's POLL_INTERVAL_MINUTES — different cadence for a
// different loop. Chase thresholds are 24h apart, so hourly is plenty.
const RACHEL_POLL_INTERVAL_MINUTES =
  Number(process.env.RACHEL_POLL_INTERVAL_MINUTES) || 60;

// Master DB columns A–O per sheets.js buildReceiptRow / matcher.js MASTER_COL.
const MASTER_DB_RANGE = "'Master DB'!A2:O";
// Vendor Ownership columns per ownership.js COL (10 columns, A–J).
const OWNERSHIP_RANGE = "'Vendor Ownership'!A2:J";

// ── STATEMENT INGESTION — INTEGRATION POINT, DELIBERATELY NOT WIRED ──────────
// How the statement file reaches Rachel is explicitly undecided (design doc
// "Open decisions" #1 — Drive-folder watch vs email-forward vs something
// else). Whichever method gets picked must return the statement as an
// already-parsed 2D array (rows × columns) for normalizeStatement(). Until
// then this returns null and each cycle logs and skips — do NOT invent a
// Drive path or email search here.
// TODO(ingestion): replace with the real statement fetch once decided.
async function fetchStatementGrid() {
  return null;
}

// ── NAME → SLACK ID ───────────────────────────────────────────────────────────
// Static map, looked up once via Slack's user search for everyone across all
// four escalation lists (Potential Owners, Managers, Roee+Yulia). Two names
// ("Gal", "Nadav") had more than one Slack match — confirmed with Lee which
// account is correct before adding them here. Falls back to null (warn +
// skip, never guess) for anyone not in this map, e.g. a name typo'd on the
// Vendor Ownership sheet or a future hire not yet added below.
const SLACK_ID_BY_NAME = {
  Ron: "U05KWG707DG",
  Roee: "U057W53SUEN",
  Elad: "U064M72MVFS",
  Lee: "U06LG6L3E1H",
  Marco: "U06AERTAPR6",
  Diana: "U06TWLVF1R6",
  Aviad: "U05QEAJDK09",
  Aviv: "U05820C9SSV",
  Richard: "U088RRKVDGT",
  Olivia: "U06231ZUM0S",
  Bruni: "U09R1PHQMGC",
  Rafael: "U06SLH4C0CA",
  Gal: "U06PZV5K6LC",
  Nadav: "U07L3GS96KE",
  Yulia: "U088YU5HD4H",
};

function resolveSlackId(name) {
  return SLACK_ID_BY_NAME[name] ?? null;
}

// Persist a chase state row: append when new, in-place update otherwise.
// Under --dry-run nothing is written — persisted state must stay untouched so
// a later real run replays the same cadence decisions.
async function persistState(state, isNew) {
  if (dryRun) {
    console.log(
      `[dry-run] Would ${isNew ? "append" : "update"} chase state ${state.clusterId}: ` +
        `stage ${state.stage}, lastNudgeAt ${state.lastNudgeAt || "(none)"}, resolved ${state.resolved}`
    );
    return;
  }
  if (isNew) await appendChaseState(SHEETS_ID, state);
  else await updateChaseState(SHEETS_ID, state.rowNumber, state);
}

// One unmatched-charge cluster through the Stage 3 state machine:
// resolve owner → advance stages as needed → nudge if due → persist.
async function processCluster({ cluster, missingCount, existingState, ownershipMap, ledgerEntries, now }) {
  // Fully accounted for: a previously-open chase gets closed — a found
  // receipt (landed via intake since the last tick) stops the chase.
  if (missingCount <= 0) {
    if (existingState && !existingState.resolved) {
      await persistState({ ...existingState, resolved: true }, false);
      console.log(`Cluster ${cluster.key}: now fully matched — chase resolved.`);
    }
    return;
  }

  if (existingState?.resolved) return; // terminal — a resolved chase never reopens

  const isNew = !existingState;
  let state = existingState ?? {
    clusterId: cluster.key,
    vendor: cluster.vendor ?? cluster.merchant,
    // Identical amounts → the per-charge amount; mixed amounts → the cluster
    // total (the message targets the owner set either way; see resolver.js's
    // per-product limitation note).
    amount: cluster.identicalAmounts
      ? cluster.transactions[0]?.amount ?? null
      : cluster.transactions.reduce((sum, t) => sum + (t.amount ?? 0), 0),
    stage: 1,
    stageEnteredAt: now.toISOString(),
    lastNudgeAt: "",
    resolved: false,
  };

  const resolution = resolveOwner({
    vendor: cluster.vendor ?? cluster.merchant,
    card: cluster.card,
    cluster,
    ownershipMap,
    ledgerEntries,
  });
  if (resolution.note) console.log(`Cluster ${cluster.key}: ${resolution.note}`);

  // Apply advances until the machine yields a nudge/wait/stop — a process
  // that slept through stage boundaries walks forward without catch-up
  // nudges (see chase.js module header). Guard is belt-and-braces: the
  // machine can advance at most 3 times (stages 1→4).
  let changed = isNew;
  for (let guard = 0; guard < 8; guard++) {
    const action = nextChaseAction({ clusterState: state, now });

    if (action.action === "advance") {
      state = { ...state, stage: action.toStage, stageEnteredAt: action.stageEnteredAt };
      changed = true;
      continue;
    }

    if (action.action === "nudge") {
      const recipients = getChaseRecipients({
        stage: action.stage,
        resolvedOwners: resolution.owners,
      });
      const text = buildChaseMessage({
        vendor: state.vendor,
        amount: state.amount,
        currency: cluster.transactions[0]?.currency ?? null,
        cluster,
        owners: resolution.owners,
        stage: action.stage,
      });
      const { sent, skipped } = await sendChaseNudges({
        token: SLACK_BOT_TOKEN,
        recipients,
        text,
        resolveSlackId,
        dryRun,
      });
      // lastNudgeAt is recorded even if every recipient was skipped for lack
      // of a Slack-ID mapping: the cadence is time-based, and retrying the
      // same threshold every tick would just spam warnings forever. The
      // skip warnings are the operator's signal to wire the mapping.
      state = { ...state, lastNudgeAt: now.toISOString() };
      changed = true;
      console.log(
        `Cluster ${cluster.key}: stage ${action.stage} nudge (+${action.thresholdHours}h) — ` +
          `${sent} sent, ${skipped} skipped.`
      );
    }
    break; // nudge, wait and stop all end the loop
  }

  if (changed) await persistState(state, isNew);
}

async function pollCycle() {
  console.log(`Rachel cycle started at ${new Date().toISOString()}${dryRun ? " [dry-run]" : ""}`);
  try {
    const grid = await fetchStatementGrid();
    if (!grid) {
      console.log(
        "No statement available — ingestion path not decided yet (design doc open decision #1); skipping cycle."
      );
      return;
    }

    const statementRows = normalizeStatement(grid);
    const [masterRows, ownershipRows, ledgerEntries, chaseStates] = await Promise.all([
      readTabRows(SHEETS_ID, MASTER_DB_RANGE),
      readTabRows(SHEETS_ID, OWNERSHIP_RANGE),
      getLedgerEntries(SHEETS_ID),
      getChaseStates(SHEETS_ID),
    ]);

    const { map: ownershipMap, needsReview } = parseOwnershipSheet(ownershipRows);
    if (needsReview.length > 0) {
      console.warn(
        `Ownership sheet: ${needsReview.length} row(s) with unparseable Owner(s) text need manual review.`
      );
    }

    // Re-run matching every tick: a previously-missing receipt may have since
    // landed via the intake service, which is what resolves an open chase.
    const matchResults = matchReceipts(statementRows, masterRows, ownershipMap);
    const clusters = clusterTransactions(statementRows, ownershipMap);

    // Per-cluster matched counts: reconciled results reference the exact
    // statement row objects the clusters hold, so identity lookup works.
    const matchedStatementRows = new Set(
      matchResults
        .filter((r) => r.status === "reconciled")
        .map((r) => r.match.statementRow)
    );
    const stateByClusterId = new Map(chaseStates.map((s) => [s.clusterId, s]));

    const now = new Date();
    for (const cluster of clusters) {
      try {
        const matchedCount = cluster.transactions.filter((t) =>
          matchedStatementRows.has(t)
        ).length;
        await processCluster({
          cluster,
          missingCount: cluster.count - matchedCount,
          existingState: stateByClusterId.get(cluster.key),
          ownershipMap,
          ledgerEntries,
          now,
        });
      } catch (e) {
        // One bad cluster must not kill the cycle — log and move on (same
        // per-item pattern as index.js's per-message handling).
        console.error(`Error processing cluster ${cluster.key}:`, e.message);
      }
    }
  } catch (e) {
    console.error("Rachel cycle failed:", e.message);
  }
}

if (runOnce) {
  await pollCycle();
  console.log("Single Rachel cycle complete (--once).");
} else {
  console.log(`The Rachel running — polling every ${RACHEL_POLL_INTERVAL_MINUTES} minute(s).`);
  await pollCycle();
  setInterval(pollCycle, RACHEL_POLL_INTERVAL_MINUTES * 60 * 1000);
}
