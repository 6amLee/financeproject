// ── STATEMENT INTAKE ──────────────────────────────────────────────────────────
// Parses an uploaded Bank Hapoalim Excel statement, runs it through the
// existing matcher + resolver pipeline, and returns the comparison result
// grouped by owner name. Pure processing — no Slack or Sheet writes here.

import ExcelJS from "exceljs";
import { normalizeStatement } from "./rambo/normalizer.js";
import { matchReceipts, clusterTransactions, merchantSimilarity } from "./rambo/matcher.js";
import { parseOwnershipSheet } from "./rambo/ownership.js";
import { resolveOwner } from "./rambo/resolver.js";
import { getLedgerEntries } from "./rambo/ledger.js";
import { readTabRows } from "./sheets.js";

const MASTER_DB_RANGE = "'Master DB'!A2:P";
const OWNERSHIP_RANGE = "'Vendor Ownership'!A2:J";

// ── Excel parsing ─────────────────────────────────────────────────────────────

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
      if (typeof v === "object" && v.result !== undefined) return v.result;
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

  const [masterRows, ownershipRows, ledgerEntries] = await Promise.all([
    readTabRows(sheetsId, MASTER_DB_RANGE),
    readTabRows(sheetsId, OWNERSHIP_RANGE),
    getLedgerEntries(sheetsId),
  ]);

  const { map: ownershipMap } = parseOwnershipSheet(ownershipRows);
  const matchResults = matchReceipts(statementRows, masterRows, ownershipMap);
  const clusters = clusterTransactions(statementRows, ownershipMap);

  // Statement rows with a confident reconciled match — excluded from chasing
  const matchedStatementRows = new Set(
    matchResults.filter((r) => r.status === "reconciled").map((r) => r.match.statementRow)
  );

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

  // Group by owner name — one DM per person covering all their unmatched charges
  const byOwner = new Map();
  for (const item of resolvedClusters) {
    for (const owner of item.resolution.owners) {
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
  if (charge.billingDate) parts.push(`(${charge.billingDate})`);
  if (charge.card)        parts.push(`card ...${charge.card}`);
  return parts.join(" · ");
}

// ── Re-check: does a pending charge now have a receipt in the Master DB? ──────
// Used by the nudge cycle to remove charges that have since been submitted
// via Gmail intake. Checks Pending AND Matched rows (a receipt logged via
// Gmail starts as Pending and only becomes Matched when a statement run
// explicitly reconciles it — so we treat any receipt row as a candidate).

const AMOUNT_EPSILON = 0.01;
const DATE_WINDOW    = { min: -1, max: 3 }; // billingDate − receiptDate in days

function parseDateToDay(s) {
  const str = String(s ?? "").trim();
  let match = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (match) {
    const t = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
    return Number.isNaN(t) ? null : t / 86_400_000;
  }
  match = str.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    const t = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
    return Number.isNaN(t) ? null : t / 86_400_000;
  }
  return null;
}

export function findReceiptForCharge(charge, masterRows) {
  for (const row of masterRows) {
    const provider    = String(row[9]  ?? "").trim();
    const rowAmount   = Number(String(row[5] ?? "").replace(/,/g, ""));
    const rowDate     = String(row[3]  ?? "").trim();

    if (!provider || isNaN(rowAmount) || rowAmount === 0) continue;

    // Merchant similarity ≥ 0.7
    if (merchantSimilarity(charge.merchant ?? "", provider) < 0.7) continue;

    // Amount within 1%
    const maxAmt = Math.max(Math.abs(rowAmount), Math.abs(charge.amount ?? 0), 1);
    if (Math.abs(rowAmount - (charge.amount ?? 0)) > AMOUNT_EPSILON * maxAmt) continue;

    // Date window: statement billingDate − receipt date = −1..+3 days
    if (charge.billingDate && rowDate) {
      const diff = (parseDateToDay(charge.billingDate) ?? 0) - (parseDateToDay(rowDate) ?? 0);
      if (diff < DATE_WINDOW.min || diff > DATE_WINDOW.max) continue;
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

    // Date window: billingDate − receipt date = −1..+3 days
    if (charge.billingDate && extracted.date) {
      const diff = (parseDateToDay(charge.billingDate) ?? 0) - (parseDateToDay(extracted.date) ?? 0);
      if (diff < DATE_WINDOW.min || diff > DATE_WINDOW.max) continue;
    }

    candidates.push({ charge, sim });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => b.sim - a.sim);
  return candidates[0].charge;
}
