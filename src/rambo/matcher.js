// ── RAMBO STAGE 1: STATEMENT ↔ MASTER DB MATCHER ────────────────────────────
// Pure functions, no I/O: statement TransactionRows (from normalizer.js),
// Master DB rows (arrays in buildReceiptRow column order, as read back from
// the Sheet), and the parsed ownership map (from ownership.js) in — match
// results and clusters out.
//
// IMPORTANT DEVIATION FROM THE DESIGN DOC: the doc's Stage 1 section lists
// card-last-4 as a hard filter. That was overridden after the doc was written
// (doc "Open decisions" #2): the intake service's Credit card / Cardholder
// columns are always blank (not derivable from a receipt alone), so card
// matching here is a SOFT SIGNAL only. Amount + date + merchant carry the
// match on their own. If card data IS present on both sides (future
// backfill), an agreeing card boosts confidence and a disagreeing card is a
// negative signal — but missing card data never blocks a match.

// Master DB column indices, per src/sheets.js buildReceiptRow().
export const MASTER_COL = {
  capturedAt: 0,
  source: 1,
  expenseType: 2,
  date: 3,
  currency: 4,
  amount: 5,
  paidBy: 6,
  creditCard: 7,
  cardholder: 8,
  provider: 9,
  receiptNo: 10,
  comments: 11,
  invoiceLink: 12,
  status: 13,
  matchedCcTxn: 14,
  documentType: 15,
  trip: 16,
};

// Expense types where the statement amount may exceed the receipt amount by
// up to 25% (tip added after the receipt was issued). Exact strings from the
// master doc §4 dropdown — note the space in "Team lunch/ Dinner".
const TIP_TOLERANCE_TYPES = new Set(["Team lunch/ Dinner", "Taxi/Train/Bus"]);
const TIP_TOLERANCE = 1.25;

const MERCHANT_SIMILARITY_THRESHOLD = 0.8;
const DATE_WINDOW_DAYS = { min: -1, max: 3 }; // statement billingDate − receipt Date
const AMOUNT_EPSILON = 0.005;

// ── Merchant similarity ──────────────────────────────────────────────────────

// Case-fold, trim, collapse internal whitespace. Used both for fuzzy scoring
// and (exactly, no fuzz) as the clustering key.
export function normalizeMerchant(s) {
  return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

// Classic two-row Levenshtein — implemented locally per the no-new-deps rule.
export function levenshtein(a, b) {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1) // substitution
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

// Normalized similarity in [0, 1]: 1 − distance / max length, computed on
// normalized (case-folded, whitespace-collapsed) strings.
export function merchantSimilarity(a, b) {
  const na = normalizeMerchant(a);
  const nb = normalizeMerchant(b);
  if (na === "" && nb === "") return 1;
  if (na === "" || nb === "") return 0;
  const maxLen = Math.max(na.length, nb.length);
  return 1 - levenshtein(na, nb) / maxLen;
}

// ── Date handling ────────────────────────────────────────────────────────────
// The statement writes DD.MM.YYYY; the Master DB `Date` column comes from
// Claude's extraction prompt, which specifies YYYY-MM-DD. Parse both (plus a
// full ISO timestamp, defensively) to a UTC day number.

function parseDateToUtcDay(s) {
  const str = String(s ?? "").trim();
  let y, m, d;
  let match = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/); // DD.MM.YYYY
  if (match) {
    [, d, m, y] = match;
  } else {
    match = str.match(/^(\d{4})-(\d{2})-(\d{2})/); // YYYY-MM-DD / ISO timestamp
    if (match) [, y, m, d] = match;
  }
  if (!match) return null;
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
  return Number.isNaN(t) ? null : t / 86_400_000;
}

// Signed whole-day difference: (statement billing date) − (receipt date).
// Returns null when either side is missing/unparseable.
export function dateDiffDays(statementDate, receiptDate) {
  const a = parseDateToUtcDay(statementDate);
  const b = parseDateToUtcDay(receiptDate);
  if (a === null || b === null) return null;
  return a - b;
}

// ── Candidate evaluation ─────────────────────────────────────────────────────

function parseMasterAmount(v) {
  const n = Number(String(v ?? "").replace(/,/g, ""));
  return Number.isNaN(n) || String(v ?? "").trim() === "" ? null : n;
}

const norm = (v) => String(v ?? "").trim();

// Amount rule: exact match; for tip-tolerance expense types the statement may
// run OVER the receipt by up to 25% (never under — a tip only adds).
function amountMatches(receiptAmount, statementAmount, expenseType) {
  if (Math.abs(statementAmount - receiptAmount) < AMOUNT_EPSILON) {
    return "exact";
  }
  if (
    TIP_TOLERANCE_TYPES.has(expenseType) &&
    statementAmount >= receiptAmount - AMOUNT_EPSILON &&
    statementAmount <= receiptAmount * TIP_TOLERANCE + AMOUNT_EPSILON
  ) {
    return "tolerance";
  }
  return null;
}

// Merchant rule: fuzzy similarity ≥ 0.8 against Provider, OR exact
// case-insensitive match against any ownership-sheet alias for that vendor
// (looked up by the Provider name, case-insensitively).
function merchantMatches(statementMerchant, provider, ownershipMap) {
  const similarity = merchantSimilarity(statementMerchant, provider);
  if (similarity >= MERCHANT_SIMILARITY_THRESHOLD) {
    return { via: "fuzzy", score: similarity };
  }
  const vendorKey = Object.keys(ownershipMap || {}).find(
    (k) => normalizeMerchant(k) === normalizeMerchant(provider)
  );
  const aliases = vendorKey ? ownershipMap[vendorKey].aliases || [] : [];
  const target = normalizeMerchant(statementMerchant);
  if (aliases.some((a) => normalizeMerchant(a) === target)) {
    return { via: "alias", score: 1 };
  }
  return null;
}

// Card is a SOFT signal (see module header). Both sides present and equal →
// "agree"; both present and different → "disagree"; anything missing →
// "unknown" (no effect — never blocks).
function cardSignal(statementCard, masterCard) {
  const s = norm(statementCard);
  const m = norm(masterCard);
  if (s === "" || m === "") return "unknown";
  return s === m ? "agree" : "disagree";
}

// Confidence: base tops out at 0.9 so an agreeing card has visible headroom
// to boost above the no-card-data case. Disagreeing card knocks it down.
function scoreCandidate({ merchantScore, amountMode, dayDiff, card }) {
  const amountScore = amountMode === "exact" ? 1 : 0.8;
  const dateScore = Math.max(0, 1 - Math.abs(dayDiff) * 0.1);
  let confidence =
    0.9 * (0.6 * merchantScore + 0.2 * amountScore + 0.2 * dateScore);
  if (card === "agree") confidence += 0.1;
  if (card === "disagree") confidence -= 0.25;
  return Math.min(1, Math.max(0, confidence));
}

// ── matchReceipts ────────────────────────────────────────────────────────────
// For each Master DB row with Paid by = "Organization" and Status = "Pending",
// classify against the statement:
//   "reconciled" — exactly one candidate passed amount+date+merchant
//   "review"     — needs a human: cross-currency near-match, or a single
//                  otherwise-clean candidate whose card disagrees (judgment
//                  call: a clean amount+date+merchant hit with a wrong card is
//                  more likely a data-entry error than a real non-match, so we
//                  demote to review instead of hard-rejecting)
//   "ambiguous"  — more than one candidate passed; all listed, none guessed
//   "missing"    — zero candidates
// Refund statement rows are excluded entirely — never a candidate.
export function matchReceipts(statementRows, masterDbRows, ownershipMap = {}) {
  const eligibleStatements = (statementRows || []).filter((r) => !r.refund);
  const results = [];

  (masterDbRows || []).forEach((masterRow, masterIndex) => {
    if (norm(masterRow[MASTER_COL.paidBy]) !== "Organization") return;
    if (norm(masterRow[MASTER_COL.status]) !== "Pending") return;

    const provider = masterRow[MASTER_COL.provider];
    const expenseType = norm(masterRow[MASTER_COL.expenseType]);
    const receiptAmount = parseMasterAmount(masterRow[MASTER_COL.amount]);
    const receiptCurrency = norm(masterRow[MASTER_COL.currency]);
    const receiptDate = masterRow[MASTER_COL.date];
    const masterCard = masterRow[MASTER_COL.creditCard];

    const candidates = [];
    const crossCurrency = [];

    for (const stmt of eligibleStatements) {
      if (receiptAmount === null || stmt.amount === null) continue;

      const dayDiff = dateDiffDays(stmt.billingDate, receiptDate);
      if (dayDiff === null || dayDiff < DATE_WINDOW_DAYS.min || dayDiff > DATE_WINDOW_DAYS.max) continue;

      const merchant = merchantMatches(stmt.merchant, provider, ownershipMap);
      if (!merchant) continue;

      const amountMode = amountMatches(receiptAmount, stmt.amount, expenseType);
      if (amountMode === null) continue;

      // Currency gate LAST, so an amount+date+merchant hit in a different (or
      // unverifiable) currency can be surfaced as a review candidate rather
      // than silently dropped. Same currency on both sides is required for an
      // auto-match; a missing currency on either side can't be verified, so
      // it also routes to review rather than auto-matching.
      const stmtCurrency = norm(stmt.currency);
      const sameCurrency =
        receiptCurrency !== "" &&
        stmtCurrency !== "" &&
        receiptCurrency.toUpperCase() === stmtCurrency.toUpperCase();

      const card = cardSignal(stmt.card, masterCard);
      const candidate = {
        statementRow: stmt,
        merchantVia: merchant.via,
        merchantScore: merchant.score,
        amountMode,
        dayDiff,
        cardSignal: card,
        confidence: scoreCandidate({
          merchantScore: merchant.score,
          amountMode,
          dayDiff,
          card,
        }),
      };
      (sameCurrency ? candidates : crossCurrency).push(candidate);
    }

    const base = { masterIndex, masterRow };
    if (candidates.length === 1) {
      const match = candidates[0];
      if (match.cardSignal === "disagree") {
        // Soft-signal override: don't hard-reject, don't auto-reconcile.
        results.push({
          ...base,
          status: "review",
          match,
          candidates,
          reasons: ["card-mismatch"],
        });
      } else {
        results.push({ ...base, status: "reconciled", match, candidates });
      }
    } else if (candidates.length > 1) {
      results.push({ ...base, status: "ambiguous", match: null, candidates });
    } else if (crossCurrency.length > 0) {
      results.push({
        ...base,
        status: "review",
        match: null,
        candidates: crossCurrency,
        reasons: ["cross-currency"],
      });
    } else {
      results.push({ ...base, status: "missing", match: null, candidates: [] });
    }
  });

  return results;
}

// ── clusterTransactions ──────────────────────────────────────────────────────
// Group statement rows by (card, normalized merchant, billing period). The
// merchant key is exact after case-folding/whitespace-collapsing — no fuzz —
// but statement descriptors that are listed ownership-sheet aliases are
// canonicalized to their vendor name first, so e.g. the two real LinkedIn
// descriptors ("LINKEDIN SN *01553993" and "LINKEDIN JOB*01411841") land in
// one LinkedIn cluster. Billing period is year-month of the billingDate.
//
// `identicalAmounts` tells Stage 2 whether a "missing" chase must target the
// owner SET (all charges look the same) or can be narrowed to a specific
// amount/product (amounts differ per owner). The owner-targeting itself is
// Stage 2's job — this only computes the grouping and the flag.
// Refund rows are excluded (never chased).
export function clusterTransactions(statementRows, ownershipMap = {}) {
  // alias (normalized) → canonical vendor name
  const aliasToVendor = {};
  for (const [vendor, info] of Object.entries(ownershipMap)) {
    for (const alias of info.aliases || []) {
      aliasToVendor[normalizeMerchant(alias)] = vendor;
    }
  }

  const clusters = new Map();
  for (const row of statementRows || []) {
    if (row.refund) continue;
    const normalized = normalizeMerchant(row.merchant);
    const vendor = aliasToVendor[normalized];
    const merchantKey = vendor ? normalizeMerchant(vendor) : normalized;

    const day = parseDateToUtcDay(row.billingDate);
    const period =
      day === null
        ? "unknown"
        : new Date(day * 86_400_000).toISOString().slice(0, 7); // YYYY-MM

    const card = norm(row.card);
    const key = `${card}|${merchantKey}|${period}`;
    if (!clusters.has(key)) {
      clusters.set(key, {
        key,
        card,
        merchant: merchantKey,
        vendor: vendor ?? null,
        period,
        transactions: [],
      });
    }
    clusters.get(key).transactions.push(row);
  }

  return Array.from(clusters.values()).map((c) => ({
    ...c,
    count: c.transactions.length,
    identicalAmounts: c.transactions.every(
      (t) => Math.abs(t.amount - c.transactions[0].amount) < AMOUNT_EPSILON
    ),
  }));
}
