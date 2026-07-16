import { describe, it, expect } from "vitest";
import {
  matchReceipts,
  clusterTransactions,
  merchantSimilarity,
  dateDiffDays,
  MASTER_COL,
} from "../src/financeCrew/matcher.js";

// ── Fixture helpers ──────────────────────────────────────────────────────────
// Master DB rows are arrays in buildReceiptRow() column order (see
// src/sheets.js); statement rows are the TransactionRow shape produced by
// normalizer.js. Synthetic-but-realistic data is fine for this stage — the
// logic here is generic matching, not statement-format parsing.

function masterRow({
  expenseType = "Other",
  date = "2026-03-10",
  currency = "ILS",
  amount = "150",
  paidBy = "Organization",
  creditCard = "",
  provider = "",
  status = "Pending",
} = {}) {
  return [
    "2026-03-10T08:00:00.000Z", // Captured at
    "lee@truvid.com",           // Source
    expenseType,                // Expense type
    date,                       // Date
    currency,                   // Currency
    amount,                     // Amount
    paidBy,                     // Paid by
    creditCard,                 // Credit card
    "",                         // Cardholder
    provider,                   // Provider
    "INV-1",                    // Receipt No.
    "",                         // Comments
    "https://drive/x",          // Invoice link
    status,                     // Status
    "",                         // Matched Amex txn
  ];
}

function stmt({
  card = "",
  txnDate = "09.03.2026",
  billingDate = "10.03.2026",
  merchant = "",
  amount = 150,
  currency = "ILS",
  amountIls = null,
  refund = false,
  recurring = false,
} = {}) {
  return {
    card,
    txnDate,
    billingDate,
    merchant,
    amount,
    currency,
    amountIls: amountIls ?? amount,
    reference: "0",
    type: null,
    recurring,
    refund,
  };
}

const LINKEDIN_OWNERSHIP = {
  LinkedIn: {
    owners: ["Olivia", "Aviv", "Lee"],
    cardsSeen: ["4154", "9037"],
    recurring: true,
    aliases: ["LINKEDIN SN *01553993", "LINKEDIN JOB*01411841"],
  },
};

// ── matchReceipts ────────────────────────────────────────────────────────────

describe("matchReceipts — core rules", () => {
  it("reconciles an exact amount+date+merchant match", () => {
    const master = masterRow({ provider: "Wolt", amount: "84.50" });
    const s = stmt({ merchant: "WOLT", amount: 84.5, billingDate: "10.03.2026" });
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.statementRow).toBe(s);
    expect(res.match.amountMode).toBe("exact");
  });

  it("skips Master DB rows that are not Organization + Pending", () => {
    const rows = [
      masterRow({ provider: "Wolt", paidBy: "Employee" }),
      masterRow({ provider: "Wolt", status: "Reconciled" }),
    ];
    expect(matchReceipts([stmt({ merchant: "WOLT" })], rows)).toEqual([]);
  });

  it("applies the 25% tip tolerance for Taxi/Train/Bus", () => {
    // Receipt says 50, statement charged 60 (tip added after the receipt).
    const master = masterRow({
      provider: "Gett Taxi",
      expenseType: "Taxi/Train/Bus",
      amount: "50",
    });
    const [res] = matchReceipts(
      [stmt({ merchant: "GETT TAXI", amount: 60 })],
      [master]
    );
    expect(res.status).toBe("reconciled");
    expect(res.match.amountMode).toBe("tolerance");
  });

  it('applies the 25% tip tolerance for "Team lunch/ Dinner" (exact enum spelling)', () => {
    const master = masterRow({
      provider: "Cafe Italia",
      expenseType: "Team lunch/ Dinner",
      amount: "200",
    });
    const [res] = matchReceipts(
      [stmt({ merchant: "CAFE ITALIA", amount: 245 })],
      [master]
    );
    expect(res.status).toBe("reconciled");
  });

  it("does NOT stretch the tolerance beyond +25%", () => {
    const master = masterRow({
      provider: "Gett Taxi",
      expenseType: "Taxi/Train/Bus",
      amount: "50",
    });
    const [res] = matchReceipts(
      [stmt({ merchant: "GETT TAXI", amount: 63 })], // +26%
      [master]
    );
    expect(res.status).toBe("missing");
  });

  it("does NOT apply the tip tolerance to other expense types", () => {
    // Office equipment at +20% over must not match.
    const master = masterRow({
      provider: "Office Depot",
      expenseType: "Office equipment",
      amount: "100",
    });
    const [res] = matchReceipts(
      [stmt({ merchant: "OFFICE DEPOT", amount: 120 })],
      [master]
    );
    expect(res.status).toBe("missing");
  });

  it("routes a cross-currency same-number coincidence to review, never auto-matched", () => {
    const master = masterRow({ provider: "Anthropic", currency: "USD", amount: "100" });
    const s = stmt({ merchant: "ANTHROPIC", amount: 100, currency: "ILS" });
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("review");
    expect(res.reasons).toContain("cross-currency");
    expect(res.match).toBeNull();
    expect(res.candidates).toHaveLength(1);
  });

  it("auto-reconciles an ILS receipt against a foreign-currency statement row using the bank's own amountIls conversion", () => {
    // Receipt logged in ILS (₪369.50); statement row is a USD charge that the
    // bank converted to ₪369.50 — same underlying charge, different currency
    // fields, so the naive cross-currency path used to always demote this to
    // "review" even though the bank's own conversion makes it a clean match.
    const master = masterRow({ provider: "Anthropic", currency: "ILS", amount: "369.50" });
    const s = stmt({ merchant: "ANTHROPIC", amount: 100, currency: "USD", amountIls: 369.5 });
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.amountMode).toBe("exact");
  });

  it("applies FX-fee tolerance: ILS receipt may run up to 3% under the statement's converted amount (bank fee), never over", () => {
    const master = masterRow({ provider: "Anthropic", currency: "ILS", amount: "360" }); // receipt is under
    const s = stmt({ merchant: "ANTHROPIC", amount: 100, currency: "USD", amountIls: 369.5 }); // bank charged more (fee)
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.amountMode).toBe("fx-tolerance");
  });

  it("does NOT stretch FX-fee tolerance beyond 3%, nor allow the receipt to run OVER the converted amount", () => {
    const tooFarUnder = masterRow({ provider: "Anthropic", currency: "ILS", amount: "350" }); // >3% under
    const s = stmt({ merchant: "ANTHROPIC", amount: 100, currency: "USD", amountIls: 369.5 });
    const [resUnder] = matchReceipts([s], [tooFarUnder]);
    expect(resUnder.status).toBe("missing");

    const overConverted = masterRow({ provider: "Anthropic", currency: "ILS", amount: "375" }); // over the converted figure
    const [resOver] = matchReceipts([s], [overConverted]);
    expect(resOver.status).toBe("missing");
  });

  it("still treats a non-ILS receipt against a different foreign currency as cross-currency review (conversion path only applies to ILS receipts)", () => {
    // Receipt amount matches the statement's own (non-ILS) currency figure
    // directly, but the currencies themselves differ — the ILS-conversion
    // shortcut must not kick in for a non-ILS receipt currency.
    const master = masterRow({ provider: "Anthropic", currency: "EUR", amount: "100" });
    const s = stmt({ merchant: "ANTHROPIC", amount: 100, currency: "USD", amountIls: 369.5 });
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("review");
    expect(res.reasons).toContain("cross-currency");
  });

  it("accepts billing dates across the whole [-1, +3] day window", () => {
    const master = masterRow({ provider: "Wolt", date: "2026-03-10" });
    for (const billingDate of ["09.03.2026", "10.03.2026", "13.03.2026"]) {
      const [res] = matchReceipts([stmt({ merchant: "WOLT", billingDate })], [master]);
      expect(res.status).toBe("reconciled");
    }
  });

  it("treats a date just outside the [-1, +3] window as missing", () => {
    const master = masterRow({ provider: "Wolt", date: "2026-03-10" });
    for (const billingDate of ["08.03.2026", "14.03.2026"]) {
      const [res] = matchReceipts([stmt({ merchant: "WOLT", billingDate })], [master]);
      expect(res.status).toBe("missing");
    }
  });

  it("fuzzy-matches minor merchant spelling variants (similarity ≥ 0.8)", () => {
    // Real overseas descriptor (post city-strip) vs Claude's cleaned provider.
    const master = masterRow({ provider: "Anthropic Claude Tea", currency: "USD", amount: "20" });
    const s = stmt({ merchant: "ANTHROPIC: CLAUDE TEA", amount: 20, currency: "USD" });
    const [res] = matchReceipts([s], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.merchantVia).toBe("fuzzy");
  });

  it("rejects merchants below the 0.8 similarity threshold with no alias", () => {
    const master = masterRow({ provider: "Wolt" });
    const [res] = matchReceipts([stmt({ merchant: "UBER TRIP" })], [master]);
    expect(res.status).toBe("missing");
  });

  it("matches via an ownership alias when raw strings are completely different", () => {
    // Statement descriptor bears no resemblance to the Provider name, but it
    // is a listed |-separated alias on the LinkedIn ownership row.
    const master = masterRow({ provider: "LinkedIn", amount: "569.99" });
    const s = stmt({ merchant: "LINKEDIN SN *01553993", amount: 569.99 });
    expect(merchantSimilarity(s.merchant, "LinkedIn")).toBeLessThan(0.8);
    const [res] = matchReceipts([s], [master], LINKEDIN_OWNERSHIP);
    expect(res.status).toBe("reconciled");
    expect(res.match.merchantVia).toBe("alias");
  });

  it("marks >1 plausible candidates as ambiguous, listing all of them", () => {
    const master = masterRow({ provider: "Wolt", amount: "84.50" });
    const s1 = stmt({ merchant: "WOLT", amount: 84.5, billingDate: "10.03.2026" });
    const s2 = stmt({ merchant: "WOLT", amount: 84.5, billingDate: "12.03.2026" });
    const [res] = matchReceipts([s1, s2], [master]);
    expect(res.status).toBe("ambiguous");
    expect(res.match).toBeNull();
    expect(res.candidates.map((c) => c.statementRow)).toEqual([s1, s2]);
  });

  it("never selects a refund statement row, even on a perfect field match", () => {
    const master = masterRow({ provider: "Wolt", amount: "150" });
    const refundRow = stmt({ merchant: "WOLT", amount: -150, refund: true });
    // Even with an absolute-value coincidence the row is excluded up front.
    const alsoRefund = stmt({ merchant: "WOLT", amount: 150, refund: true });
    const [res] = matchReceipts([refundRow, alsoRefund], [master]);
    expect(res.status).toBe("missing");
    expect(res.candidates).toEqual([]);
  });
});

describe("matchReceipts — card as a soft signal (design-doc override)", () => {
  const base = { provider: "Wolt", amount: "150" };

  it("matches with NO card data on either side (card absence never blocks)", () => {
    // Master DB Credit card is always blank today (buildReceiptRow writes "");
    // amount+date+merchant must carry the match alone.
    const master = masterRow({ ...base, creditCard: "" });
    const [res] = matchReceipts([stmt({ merchant: "WOLT", card: "" })], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.cardSignal).toBe("unknown");
  });

  it("matches when only ONE side has a card value", () => {
    const master = masterRow({ ...base, creditCard: "" });
    const [res] = matchReceipts([stmt({ merchant: "WOLT", card: "9037" })], [master]);
    expect(res.status).toBe("reconciled");
    expect(res.match.cardSignal).toBe("unknown");
  });

  it("boosts confidence when cards are present and agree", () => {
    const noCard = matchReceipts(
      [stmt({ merchant: "WOLT", card: "" })],
      [masterRow({ ...base, creditCard: "" })]
    )[0];
    const agreeing = matchReceipts(
      [stmt({ merchant: "WOLT", card: "9037" })],
      [masterRow({ ...base, creditCard: "9037" })]
    )[0];
    expect(agreeing.status).toBe("reconciled");
    expect(agreeing.match.cardSignal).toBe("agree");
    expect(agreeing.match.confidence).toBeGreaterThan(noCard.match.confidence);
  });

  it("demotes a disagreeing card to review — negative signal, not a hard rejection", () => {
    // Judgment call (documented in matcher.js): a clean amount+date+exact-
    // merchant hit with a wrong card is more likely a data-entry issue than a
    // genuine non-match, so it surfaces for a human instead of being dropped.
    const master = masterRow({ ...base, creditCard: "4154" });
    const [res] = matchReceipts([stmt({ merchant: "WOLT", card: "9037" })], [master]);
    expect(res.status).toBe("review");
    expect(res.reasons).toContain("card-mismatch");
    // The pairing is still surfaced — not rejected as "missing".
    expect(res.match).not.toBeNull();
    expect(res.match.cardSignal).toBe("disagree");
    // And it scores below the equivalent agreeing-card match.
    const agreeing = matchReceipts(
      [stmt({ merchant: "WOLT", card: "9037" })],
      [masterRow({ ...base, creditCard: "9037" })]
    )[0];
    expect(res.match.confidence).toBeLessThan(agreeing.match.confidence);
  });
});

// ── clusterTransactions ──────────────────────────────────────────────────────

describe("clusterTransactions", () => {
  it("clusters the real LinkedIn example: different amounts, one vendor, one period → identicalAmounts: false", () => {
    // Two different LinkedIn products (Sales Navigator vs Recruiter) on the
    // same card in the same billing month, at 569.99 and 3203.88 — the alias
    // canonicalization folds both descriptors into one LinkedIn cluster.
    const rows = [
      stmt({ card: "9037", merchant: "LINKEDIN SN *01553993", amount: 569.99, billingDate: "02.03.2026" }),
      stmt({ card: "9037", merchant: "LINKEDIN JOB*01411841", amount: 3203.88, billingDate: "15.03.2026" }),
    ];
    const clusters = clusterTransactions(rows, LINKEDIN_OWNERSHIP);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].vendor).toBe("LinkedIn");
    expect(clusters[0].count).toBe(2);
    expect(clusters[0].identicalAmounts).toBe(false);
    expect(clusters[0].period).toBe("2026-03");
  });

  it("flags identical-amount clusters (chase targets the owner set)", () => {
    const rows = [
      stmt({ card: "9037", merchant: "HOLMES PLACE", amount: 428.32, billingDate: "02.03.2026" }),
      stmt({ card: "9037", merchant: "Holmes  Place", amount: 428.32, billingDate: "02.03.2026" }),
    ];
    const clusters = clusterTransactions(rows, {});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].identicalAmounts).toBe(true);
  });

  it("uses case-folded/whitespace-trimmed merchant as an exact grouping key (no fuzz)", () => {
    const rows = [
      stmt({ card: "9037", merchant: "WOLT", amount: 80, billingDate: "02.03.2026" }),
      stmt({ card: "9037", merchant: "  wolt ", amount: 90, billingDate: "05.03.2026" }),
      stmt({ card: "9037", merchant: "WOLTY", amount: 80, billingDate: "05.03.2026" }), // 1 char off — separate cluster
    ];
    const clusters = clusterTransactions(rows, {});
    expect(clusters).toHaveLength(2);
    const wolt = clusters.find((c) => c.merchant === "wolt");
    expect(wolt.count).toBe(2);
    expect(wolt.identicalAmounts).toBe(false);
  });

  it("splits clusters by card and by billing period", () => {
    const rows = [
      stmt({ card: "9037", merchant: "WOLT", billingDate: "02.03.2026" }),
      stmt({ card: "4154", merchant: "WOLT", billingDate: "02.03.2026" }), // other card
      stmt({ card: "9037", merchant: "WOLT", billingDate: "02.04.2026" }), // other month
    ];
    expect(clusterTransactions(rows, {})).toHaveLength(3);
  });

  it("excludes refunds from clustering (never chased)", () => {
    const rows = [
      stmt({ card: "9037", merchant: "WOLT", amount: 80, billingDate: "02.03.2026" }),
      stmt({ card: "9037", merchant: "WOLT", amount: -80, billingDate: "03.03.2026", refund: true }),
    ];
    const clusters = clusterTransactions(rows, {});
    expect(clusters).toHaveLength(1);
    expect(clusters[0].count).toBe(1);
  });
});

// ── merchantSimilarity / date helpers ────────────────────────────────────────

describe("merchantSimilarity", () => {
  it("is 1 for identical strings regardless of case/whitespace", () => {
    expect(merchantSimilarity("Wolt", " WOLT ")).toBe(1);
  });

  it("scores minor variants above the 0.8 threshold", () => {
    expect(merchantSimilarity("ANTHROPIC: CLAUDE TEA", "Anthropic Claude Tea")).toBeGreaterThanOrEqual(0.8);
  });

  it("scores unrelated merchants low", () => {
    expect(merchantSimilarity("WOLT", "UBER TRIP")).toBeLessThan(0.5);
  });

  it("handles empty inputs", () => {
    expect(merchantSimilarity("", "")).toBe(1);
    expect(merchantSimilarity("WOLT", "")).toBe(0);
  });
});

describe("dateDiffDays", () => {
  it("diffs statement DD.MM.YYYY against Master DB YYYY-MM-DD", () => {
    expect(dateDiffDays("13.03.2026", "2026-03-10")).toBe(3);
    expect(dateDiffDays("09.03.2026", "2026-03-10")).toBe(-1);
    expect(dateDiffDays("01.04.2026", "2026-03-31")).toBe(1); // month boundary
  });

  it("returns null for unparseable dates", () => {
    expect(dateDiffDays("not a date", "2026-03-10")).toBeNull();
    expect(dateDiffDays("10.03.2026", null)).toBeNull();
  });
});
