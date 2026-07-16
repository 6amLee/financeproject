// ── STATEMENT INTAKE ──────────────────────────────────────────────────────────
// Parses an uploaded Bank Hapoalim Excel statement, runs it through the
// existing matcher + resolver pipeline, and returns the comparison result
// grouped by owner name. Pure processing — no Slack or Sheet writes here.

import ExcelJS from "exceljs";
import { normalizeStatement } from "./financeCrew/normalizer.js";
import { matchReceipts, clusterTransactions, merchantSimilarity, dateDiffDays, DATE_WINDOW_DAYS } from "./financeCrew/matcher.js";
import { parseOwnershipSheet } from "./financeCrew/ownership.js";
import { resolveOwner } from "./financeCrew/resolver.js";
import { getLedgerEntries } from "./financeCrew/ledger.js";
import { getNotMineEntries, isExcluded } from "./financeCrew/notMine.js";
import { resolveSlackId } from "./financeCrew/slackIds.js";
import { readTabRows } from "./sheets.js";

const MASTER_DB_RANGE = "'Master DB'!A2:R";
const OWNERSHIP_RANGE = "'Vendor Ownership'!A2:J";

// ── Excel parsing ─────────────────────────────────────────────────────────────

// DD.MM.YYYY — the format every date-consuming call site in normalizer.js /
// matcher.js expects (see matcher.js's parseDateToUtcDay). A UTC-based
// format avoids the cell's local-timezone Date drifting the day number.
export function formatDateCell(d) {
  const day   = String(d.getUTCDate()).padStart(2, "0");
  const month = String(d.getUTCMonth() + 1).padStart(2, "0");
  const year  = d.getUTCFullYear();
  return `${day}.${month}.${year}`;
}

export async function parseStatementExcel(base64Data) {
  const buffer = Buffer.from(base64Data, "base64");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("Excel file has no worksheets");
  const grid = [];
  worksheet.eachRow({ includeEmpty: true }, (row) => {
    // exceljs row.values is 1-indexed; slice(1) normalises to 0-indexed
    const cells = row.values.slice(1).map((v) => {
      if (v === null || v === undefined) return null;
      // A date-formatted cell comes back as a native Date, not a string —
      // String(dateObj) (what every downstream cellStr()/parseDateToUtcDay
      // call does) produces "Tue Jun 02 2026 00:00:00 GMT+0000..." which
      // parseDateToUtcDay can't parse, silently making every such row's
      // billing period "unknown" and falling through to cold-start owner
      // resolution. Format it the same way the statement's own text cells
      // are written (DD.MM.YYYY) so it flows through identically.
      if (v instanceof Date) return formatDateCell(v);
      if (typeof v === "object" && v.result !== undefined) {
        return v.result instanceof Date ? formatDateCell(v.result) : v.result;
      }
      if (typeof v === "object" && v.text !== undefined) return v.text;
      return v;
    });
    grid.push(cells);
  });
  return grid;
}

// ── Full comparison pipeline ──────────────────────────────────────────────────

export async function runStatementComparison({ base64Data, sheetsId }) {
  const grid = await parseStatementExcel(base64Data);
  const statementRows = normalizeStatement(grid);
  if (statementRows.length === 0) {
    throw new Error("Statement parsed to zero rows — check the file is a Bank Hapoalim Excel export");
  }

  const [masterRows, ownershipRows, ledgerEntries, notMineEntries] = await Promise.all([
    readTabRows(sheetsId, MASTER_DB_RANGE),
    readTabRows(sheetsId, OWNERSHIP_RANGE).catch(() => []),  // tab may not exist yet
    getLedgerEntries(sheetsId).catch(() => []),               // tab may not exist yet
    getNotMineEntries(sheetsId).catch(() => []),              // tab may not exist yet
  ]);

  const { map: ownershipMap } = parseOwnershipSheet(ownershipRows);
  const matchResults = matchReceipts(statementRows, masterRows, ownershipMap);
  const clusters = clusterTransactions(statementRows, ownershipMap);

  // Statement rows excluded from chasing: a confident "reconciled" match, or
  // a "review" match (a plausible Master DB receipt already exists — the
  // only open question is a currency/card mismatch a human should resolve
  // directly against that row, not something re-nudging the person
  // resolves). "ambiguous" (2+ candidates, genuinely unresolved) and
  // "missing" (0 candidates) stay in the chase pool. A "review" result's
  // candidates can be more than one (e.g. several cross-currency
  // possibilities) — exclude all of them, not just the first.
  const matchedStatementRows = new Set(
    matchResults
      .filter((r) => r.status === "reconciled" || r.status === "review")
      .flatMap((r) => r.candidates.map((c) => c.statementRow))
  );

  // Surfaced in the Stage 1 channel summary so review/ambiguous cases are
  // visible instead of silently falling through.
  const reviewCount = matchResults.filter((r) => r.status === "review").length;
  const ambiguousCount = matchResults.filter((r) => r.status === "ambiguous").length;

  // Clusters with at least one unmatched transaction + resolved owner
  const resolvedClusters = [];
  for (const cluster of clusters) {
    const pendingTxns = cluster.transactions.filter((t) => !matchedStatementRows.has(t));
    if (pendingTxns.length === 0) continue;
    const resolution = resolveOwner({
      vendor: cluster.vendor ?? cluster.merchant,
      card: cluster.card,
      cluster,
      ownershipMap,
      ledgerEntries,
    });
    resolvedClusters.push({ cluster, resolution, pendingTxns });
  }

  // Group by owner name — one DM per person covering all their unmatched
  // charges. Skip anyone who's opted out (globally, via "None of these are
  // mine") or this specific charge (via a per-charge "Not mine" dismissal) —
  // filtered here so an excluded person is never even selected as a
  // recipient, not just hidden after the fact.
  const byOwner = new Map();
  for (const item of resolvedClusters) {
    for (const owner of item.resolution.owners) {
      const userId = resolveSlackId(owner);
      if (userId && isExcluded(notMineEntries, { userId, clusterKey: item.cluster.key })) continue;
      if (!byOwner.has(owner)) byOwner.set(owner, []);
      byOwner.get(owner).push(item);
    }
  }

  return {
    statementRows,
    matchResults,
    resolvedClusters,
    byOwner,                   // Map<ownerName, [{cluster, resolution, pendingTxns}]>
    totalCharges:    statementRows.filter((r) => !r.refund).length,
    matchedCount:    matchedStatementRows.size,
    unmatchedCount:  resolvedClusters.reduce((s, { pendingTxns }) => s + pendingTxns.length, 0),
    reviewCount,               // "review": a plausible Master DB receipt exists but needs a human look (currency/card mismatch) — excluded from chasing, not nudged
    ambiguousCount,            // "ambiguous": 2+ plausible receipts — still nudged, but worth flagging as noisy/duplicate-prone
  };
}

// ── Pending charge serialisation ──────────────────────────────────────────────
// Stored as JSON in the Statement Chase Threads tab. Contains enough fields
// to re-match against the Master DB without re-downloading the original file.

export function buildPendingCharge(txn, clusterKey) {
  return {
    clusterKey,
    merchant:    txn.merchant    ?? null,
    amount:      txn.amount      ?? null,
    currency:    txn.currency    ?? null,
    amountIls:   txn.amountIls   ?? null,
    card:        txn.card        ?? null,
    billingDate: txn.billingDate ?? null,
    txnDate:     txn.txnDate     ?? null,
  };
}

// Human-readable single line for Slack messages.
export function formatCharge(charge) {
  const parts = [];
  if (charge.merchant) parts.push(`*${charge.merchant}*`);
  if (charge.amount != null) {
    parts.push(`${charge.amount}${charge.currency ? ` ${charge.currency}` : ""}`);
  }
  if (charge.card) parts.push(`card ...${charge.card}`);
  return parts.join(" · ");
}

// ── Not-mine buttons ──────────────────────────────────────────────────────────
// Shared by handleStatementUpload (Stage 1) and statementFinanceCrew.js (Stage 2/3):
// one Slack section block per vendor/cluster with its amounts, plus a
// per-charge "Not mine" button, followed by a single "None of these are
// mine" button for the whole message. Both button values carry
// { userId, userName, runId, clusterKey } so the interaction handler can
// record the opt-out without re-deriving context.
//
// leadText/trailerText must NOT re-embed the charge list themselves (no
// calling formatChargeList internally) — the per-vendor blocks below ARE the
// charge list; a caller that also inlines it into leadText would duplicate it.
export function buildNotMineBlocks({ leadText, trailerText, charges, userId, userName, runId }) {
  const groups = new Map();
  for (const c of charges) {
    const key = c.clusterKey ?? `${c.merchant}|${c.card}`;
    if (!groups.has(key)) groups.set(key, { clusterKey: key, merchant: c.merchant, card: c.card, amounts: [] });
    groups.get(key).amounts.push({ amount: c.amount, currency: c.currency });
  }

  const blocks = [
    { type: "section", text: { type: "mrkdwn", text: leadText } },
  ];

  for (const { clusterKey, merchant, card, amounts } of groups.values()) {
    const header = [merchant ? `*${merchant}*` : "*Unknown*", card ? `card ...${card}` : null]
      .filter(Boolean).join(" · ");
    const amtLines = amounts
      .map(({ amount, currency }) => `  - ${amount}${currency ? ` ${currency}` : ""}`)
      .join("\n");
    blocks.push({
      type: "section",
      text: { type: "mrkdwn", text: `${header}\n${amtLines}` },
    });
    blocks.push({
      type: "actions",
      elements: [{
        type: "button",
        text: { type: "plain_text", text: "Not mine" },
        action_id: "statement_not_mine_charge",
        value: JSON.stringify({ userId, userName, runId, clusterKey }),
      }],
    });
  }

  if (trailerText) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text: trailerText } });
  }

  blocks.push({ type: "divider" });
  blocks.push({
    type: "actions",
    elements: [{
      type: "button",
      text: { type: "plain_text", text: "None of these are mine" },
      style: "danger",
      action_id: "statement_not_mine_all",
      value: JSON.stringify({ userId, userName, runId }),
    }],
  });

  return blocks;
}

// ── Re-check: does a pending charge now have a receipt in the Master DB? ──────
// Used by the nudge cycle to remove charges that have since been submitted
// via Gmail intake. Checks Pending AND Matched rows (a receipt logged via
// Gmail starts as Pending and only becomes Matched when a statement run
// explicitly reconciles it — so we treat any receipt row as a candidate).

const AMOUNT_EPSILON = 0.01;
const DATE_WINDOW    = DATE_WINDOW_DAYS; // billingDate − receiptDate in days — shared with matcher.js

export function findReceiptForCharge(charge, masterRows) {
  const chargeCurrency = String(charge.currency ?? "").trim().toUpperCase();

  for (const row of masterRows) {
    const provider     = String(row[9]  ?? "").trim();
    const rowAmount    = Number(String(row[5] ?? "").replace(/,/g, ""));
    const rowDate      = String(row[3]  ?? "").trim();
    const rowCurrency  = String(row[4]  ?? "").trim().toUpperCase();

    if (!provider || isNaN(rowAmount) || rowAmount === 0) continue;

    // Merchant similarity ≥ 0.7
    if (merchantSimilarity(charge.merchant ?? "", provider) < 0.7) continue;

    // Currency-aware amount check: same currency (or either side blank/
    // unverifiable, preserving the original lenient behavior) compares
    // directly against the charge's original amount. Only when BOTH
    // currencies are known and genuinely differ do we require a resolved
    // comparison — a receipt logged in ILS against a foreign-currency charge
    // compares against the statement's own converted amountIls instead (the
    // bank's actual conversion), so it can't cross-match two unrelated
    // same-priced charges in different currencies (the false-positive risk
    // this used to have) while still not being blocked by missing data.
    const bothCurrenciesKnown = chargeCurrency !== "" && rowCurrency !== "";
    const sameCurrency = !bothCurrenciesKnown || chargeCurrency === rowCurrency;
    const useConverted = bothCurrenciesKnown && !sameCurrency && rowCurrency === "ILS" && charge.amountIls != null;
    if (bothCurrenciesKnown && !sameCurrency && !useConverted) continue;

    const compareAmount = useConverted ? charge.amountIls : (charge.amount ?? 0);
    const maxAmt = Math.max(Math.abs(rowAmount), Math.abs(compareAmount), 1);
    if (Math.abs(rowAmount - compareAmount) > AMOUNT_EPSILON * maxAmt) continue;

    // Date window: statement billingDate − receipt date = −1..+3 days.
    // dateDiffDays returns null for an unparseable date — skip the filter
    // rather than treating it as a 1970-01-01 mismatch (a bug this used to
    // have with a local, buggy parseDateToDay + `?? 0` fallback).
    if (charge.billingDate && rowDate) {
      const diff = dateDiffDays(charge.billingDate, rowDate);
      if (diff !== null && (diff < DATE_WINDOW.min || diff > DATE_WINDOW.max)) continue;
    }

    return row; // first match wins — good enough for a "has receipt?" check
  }
  return null;
}

// ── Receipt → pending charge matching (DM thread submissions) ─────────────────
// When someone drops a receipt into their DM thread, match the Claude-extracted
// data against the stored pending charges for that person.

export function matchReceiptToPendingCharge(extracted, pendingCharges) {
  if (!pendingCharges?.length) return null;
  const extractedAmount = Number(extracted?.amount);
  if (isNaN(extractedAmount)) return null;

  const candidates = [];
  for (const charge of pendingCharges) {
    if (charge.amount == null) continue;

    // Amount: within 1% (handles minor rounding differences)
    const maxAmt = Math.max(Math.abs(extractedAmount), Math.abs(charge.amount), 1);
    if (Math.abs(extractedAmount - charge.amount) > AMOUNT_EPSILON * maxAmt) continue;

    // Merchant similarity ≥ 0.65 (slightly looser — receipt providers often
    // differ more from statement descriptors than two-system fields do)
    const sim = merchantSimilarity(charge.merchant ?? "", extracted.provider ?? "");
    if (sim < 0.65) continue;

    // Date window: billingDate − receipt date = −1..+3 days. dateDiffDays
    // returns null for an unparseable date — skip the filter rather than
    // falling back to a bogus 1970-01-01 comparison.
    if (charge.billingDate && extracted.date) {
      const diff = dateDiffDays(charge.billingDate, extracted.date);
      if (diff !== null && (diff < DATE_WINDOW.min || diff > DATE_WINDOW.max)) continue;
    }

    candidates.push({ charge, sim });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.sim - a.sim);
  return candidates[0].charge;
}
