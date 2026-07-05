// ── RACHEL STAGE 3: CHASE CADENCE ────────────────────────────────────────────
// The escalation state machine for unmatched-charge clusters, plus the Slack
// message builder/sender. The decision logic (nextChaseAction) and the message
// builder are PURE — plain data in, plain data out, `now` is always passed in
// rather than read from the clock — so they're testable without mocks. Only
// sendSlackMessage / sendChaseNudges do I/O.
//
// ── TIMELINE INTERPRETATION (design doc §Stage 3 / master doc §10) ───────────
// The doc's cadence — Stage 1: T+0, T+24h · Stage 2: T+48h, T+72h · Stage 3:
// T+96h, T+120h · Stage 4: T+144h, stop — is ONE CONTINUOUS timeline anchored
// at the original missing-charge detection (T+0 = detection). Two tells in the
// doc's wording: (a) the offsets are strictly cumulative with uniform 24h
// spacing across stage boundaries (0/24/48/72/96/120/144), which only makes
// sense measured from a single origin — a per-stage reset would have been
// written "T+0, T+24 after entering the stage"; (b) the master doc presents it
// as a single arrow-chained schedule ("Stage 1 (T+0, +24h) → Stage 2 (T+48h,
// T+72h) → …"), i.e. one clock, escalating owners along the way.
//
// Implementation: each stage spans exactly 48h of that shared timeline, with
// nudges at +0h and +24h RELATIVE to the stage's entry (stage 4: +0h only,
// then terminal). Because `advance` anchors the next stage's stageEnteredAt to
// the theoretical boundary (previous stageEnteredAt + 48h) rather than to
// `now`, the relative offsets reproduce the doc's absolute T+48/72/96/120/144
// schedule even when the poll loop wakes up late — a late poll shifts a nudge,
// never the whole schedule.
//
// ── ADVANCE vs NUDGE ─────────────────────────────────────────────────────────
// `nextChaseAction` returns ONE action per call. Crossing a stage boundary
// returns { action: "advance" } WITHOUT nudging in the same result — the
// caller applies the stage change to its state and simply calls again, which
// then yields the new stage's +0h nudge (rachel.js loops exactly like this).
// Keeping advance and nudge as separate steps means a process that was down
// for days advances through the missed stages without firing a catch-up nudge
// for every threshold it slept through — only the current stage's due nudge
// fires.

import { COLD_START_OWNERS } from "./resolver.js";

const HOUR_MS = 3_600_000;

// Each of stages 1–3 owns a 48h window with nudges at +0h and +24h relative
// to stage entry. Stage 4 nudges once at +0h (= the doc's T+144) and stops.
export const STAGE_DURATION_HOURS = 48;
export const NUDGE_OFFSETS_HOURS = [0, 24];
export const FINAL_STAGE = 4;

// Stage 3 escalation list — the 12 Managers from master doc §4 / design doc
// Stage 3. Deliberately distinct from resolver.js's COLD_START_OWNERS (the 9
// Potential Owners used at stage 2): overlapping names, different lists,
// different stages.
export const STAGE_MANAGERS = [
  "Roee",
  "Ron",
  "Elad",
  "Lee",
  "Marco",
  "Diana",
  "Aviad",
  "Aviv",
  "Olivia",
  "Rafael",
  "Bruni",
  "Gal",
];

// Stage 4 targets. The master doc refers to them only by first name ("Owner:
// Lee · Finance: Yulia · Escalation: Roee") and no name→Slack-ID/email
// convention exists anywhere in this codebase yet, so these are plain name
// strings; mapping names to real Slack user IDs is a follow-up integration
// (see resolveSlackId in sendChaseNudges).
export const STAGE_FINAL_TARGETS = ["Roee", "Yulia"];

// Accept Date objects or ISO/date strings (chase state round-trips through a
// Sheet, where everything is a string). Blank/unparseable → null.
function toMs(v) {
  if (v instanceof Date) return v.getTime();
  const s = String(v ?? "").trim();
  if (s === "") return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
}

// ── nextChaseAction ──────────────────────────────────────────────────────────
// clusterState: { clusterId, vendor, amount, stage (1-4), stageEnteredAt,
//                 lastNudgeAt, resolved } — the "Rachel Chase State" tab shape.
// now: Date (or parseable string).
//
// Returns exactly one of:
//   { action: "stop", reason }                — terminal: resolved, or stage
//                                               4's single nudge already fired
//   { action: "advance", toStage,
//     stageEnteredAt }                        — crossed a stage boundary; the
//                                               included stageEnteredAt is the
//                                               THEORETICAL boundary (entry +
//                                               48h, not `now`) so the shared
//                                               timeline never drifts. No
//                                               nudge this call — apply and
//                                               call again (see module header)
//   { action: "nudge", stage, thresholdHours }— send the stage's message now
//   { action: "wait" }                        — nothing due yet
//
// Threshold-fired tracking: lastNudgeAt is the timestamp of the most recent
// nudge. A threshold at stageEnteredAt + H is considered fired iff
// lastNudgeAt >= that instant — so a nudge never double-fires for the same
// threshold, and if the process slept past several thresholds, one late nudge
// covers everything due up to when it fired.
export function nextChaseAction({ clusterState, now }) {
  if (clusterState.resolved) return { action: "stop", reason: "resolved" };

  const enteredMs = toMs(clusterState.stageEnteredAt);
  const nowMs = toMs(now);
  if (enteredMs === null || nowMs === null) return { action: "wait" };

  const lastNudgeMs = toMs(clusterState.lastNudgeAt);
  const stage = Number(clusterState.stage) || 1;
  const firedAt = (offsetHours) =>
    lastNudgeMs !== null && lastNudgeMs >= enteredMs + offsetHours * HOUR_MS;

  // Stage 4: one nudge at +0h (the doc's T+144), then terminal — no further
  // escalation, no further nudges, ever.
  if (stage >= FINAL_STAGE) {
    if (firedAt(0)) return { action: "stop", reason: "exhausted" };
    if (nowMs >= enteredMs) {
      return { action: "nudge", stage: FINAL_STAGE, thresholdHours: 0 };
    }
    return { action: "wait" };
  }

  // Stages 1–3: past the 48h window → advance (anchored to the boundary).
  if (nowMs - enteredMs >= STAGE_DURATION_HOURS * HOUR_MS) {
    return {
      action: "advance",
      toStage: stage + 1,
      stageEnteredAt: new Date(
        enteredMs + STAGE_DURATION_HOURS * HOUR_MS
      ).toISOString(),
    };
  }

  // Within the window: fire the LATEST threshold that is due and unfired.
  // (Checking from the highest offset down means a single nudge covers all
  // thresholds passed while asleep; if the latest due threshold already
  // fired, every earlier one necessarily did too — lastNudgeAt is monotonic.)
  const dueOffsets = [...NUDGE_OFFSETS_HOURS]
    .sort((a, b) => b - a)
    .filter((h) => nowMs >= enteredMs + h * HOUR_MS);
  if (dueOffsets.length > 0 && !firedAt(dueOffsets[0])) {
    return { action: "nudge", stage, thresholdHours: dueOffsets[0] };
  }
  return { action: "wait" };
}

// ── buildChaseMessage ────────────────────────────────────────────────────────
// Pure: plain data in, Slack message text out. Tone escalates with the stage
// but stays professional and non-alarming throughout (per the design doc —
// clear and simple, no over-engineered copywriting).
export function buildChaseMessage({ vendor, amount, currency, cluster, owners, stage }) {
  const amountText = [amount, currency]
    .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
    .join(" ");
  const vendorText = String(vendor ?? "").trim() || "an unrecognised vendor";
  const charge =
    (amountText ? `a ${amountText} charge` : "a charge") + ` from ${vendorText}`;

  const details = [];
  if (cluster?.card) details.push(`card ending ${cluster.card}`);
  if (cluster?.period && cluster.period !== "unknown") {
    details.push(`billing period ${cluster.period}`);
  }
  if (cluster?.count > 1) details.push(`${cluster.count} charges in this group`);
  const detailText = details.length > 0 ? ` (${details.join(", ")})` : "";

  switch (stage) {
    case 1:
      return (
        `Hi! Rachel from Finance here. I found ${charge} on the company card${detailText}, ` +
        `but no matching receipt in the system. If this one is yours, could you forward ` +
        `the receipt to finance@truvid.com? Thanks!`
      );
    case 2:
      return (
        `Hi, Rachel from Finance again. There's still no receipt for ${charge}${detailText}. ` +
        `You're on the potential-owners list for this card — if this charge is yours, or you ` +
        `know whose it is, please forward the receipt to finance@truvid.com or reply here.`
      );
    case 3:
      return (
        `Heads up from Finance: the receipt for ${charge}${detailText} is now overdue — ` +
        `no one has claimed it after several reminders` +
        (owners && owners.length > 0 ? ` (likely owner(s): ${owners.join(", ")})` : "") +
        `. Could you help track down who made this purchase? Receipts go to finance@truvid.com.`
      );
    default:
      return (
        `Final escalation from Rachel: the receipt for ${charge}${detailText} is seriously ` +
        `overdue and still unclaimed after the full reminder cycle (likely owner, potential ` +
        `owners, managers). No further automatic reminders will be sent — flagging for your ` +
        `decision on next steps.`
      );
  }
}

// ── getChaseRecipients ───────────────────────────────────────────────────────
// Who gets the message at each stage:
//   1 — the resolver's owners for this cluster (resolver.js resolveOwner)
//   2 — the 9 Potential Owners (resolver.js COLD_START_OWNERS)
//   3 — the 12 Managers (STAGE_MANAGERS above)
//   4 — Roee + Yulia
export function getChaseRecipients({ stage, resolvedOwners = [] }) {
  switch (stage) {
    case 1:
      return [...resolvedOwners];
    case 2:
      return [...COLD_START_OWNERS];
    case 3:
      return [...STAGE_MANAGERS];
    default:
      return [...STAGE_FINAL_TARGETS];
  }
}

// ── sendSlackMessage ─────────────────────────────────────────────────────────
// Native fetch against Slack's chat.postMessage — same "no SDK, plain fetch"
// pattern as Monica (design doc: separate Slack app/bot token for Finance;
// see design doc open decision #3 — that token doesn't exist yet). The token
// is a PARAMETER, never read from process.env here, so the caller controls
// its source and tests can inject.
export async function sendSlackMessage({ token, channelOrUserId, text }) {
  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ channel: channelOrUserId, text }),
  });
  if (!res.ok) {
    throw new Error(`Slack chat.postMessage HTTP ${res.status}`);
  }
  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Slack chat.postMessage failed: ${data.error || "unknown error"}`);
  }
  return data;
}

// ── sendChaseNudges ──────────────────────────────────────────────────────────
// Fan a nudge out to a list of recipient NAMES. No name→Slack-ID mapping
// exists anywhere in this codebase yet, so the lookup is pluggable:
// `resolveSlackId(name)` → channel/user ID or null. When no resolver is
// provided, or it returns nothing for a name, we log a warning and SKIP that
// recipient — never crash, never guess an ID. `dryRun` logs the message that
// WOULD be sent instead of sending (design doc's Stage 3 verification flag).
// Returns { sent, skipped } counts for the caller's cycle log.
export async function sendChaseNudges({
  token,
  recipients,
  text,
  resolveSlackId = null,
  dryRun = false,
  log = console,
}) {
  let sent = 0;
  let skipped = 0;
  for (const name of recipients || []) {
    if (dryRun) {
      log.log(`[dry-run] Would Slack ${name}: ${text}`);
      sent += 1;
      continue;
    }
    const destination = resolveSlackId ? resolveSlackId(name) : null;
    if (!destination) {
      log.warn(
        `No Slack ID mapping for "${name}" — skipping nudge (name→Slack-ID resolver not wired yet)`
      );
      skipped += 1;
      continue;
    }
    await sendSlackMessage({ token, channelOrUserId: destination, text });
    sent += 1;
  }
  return { sent, skipped };
}
