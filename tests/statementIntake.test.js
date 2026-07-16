import { describe, it, expect } from "vitest";
import { buildNotMineBlocks, findReceiptForCharge, matchReceiptToPendingCharge } from "../src/statementIntake.js";

// Master DB column indices used by findReceiptForCharge: D=date(3), E=currency(4), F=amount(5), J=provider(9).
function masterRow({ date, amount, provider, currency = "" }) {
  const row = new Array(10).fill("");
  row[3] = date;
  row[4] = currency;
  row[5] = String(amount);
  row[9] = provider;
  return row;
}

describe("findReceiptForCharge", () => {
  it("matches when the date is within the -1..+3 day window", () => {
    const charge = { merchant: "Uber", amount: 100, billingDate: "05.07.2026" };
    const rows = [masterRow({ date: "2026-07-03", amount: 100, provider: "Uber" })];
    expect(findReceiptForCharge(charge, rows)).toBe(rows[0]);
  });

  it("rejects when the date is outside the window", () => {
    const charge = { merchant: "Uber", amount: 100, billingDate: "05.07.2026" };
    const rows = [masterRow({ date: "2026-06-01", amount: 100, provider: "Uber" })];
    expect(findReceiptForCharge(charge, rows)).toBeNull();
  });

  it("does not reject a match just because one date is unparseable — skips the date filter instead of comparing against 1970-01-01", () => {
    const charge = { merchant: "Uber", amount: 100, billingDate: "05.07.2026" };
    // A garbled/manually-edited date cell that parseDateToUtcDay can't parse.
    const rows = [masterRow({ date: "not-a-date", amount: 100, provider: "Uber" })];
    expect(findReceiptForCharge(charge, rows)).toBe(rows[0]);
  });

  it("still matches when currency is blank on either side (legacy rows) — preserves prior lenient behavior", () => {
    const charge = { merchant: "Uber", amount: 100, billingDate: "05.07.2026" }; // no currency field
    const rows = [masterRow({ date: "2026-07-03", amount: 100, provider: "Uber" })]; // no currency
    expect(findReceiptForCharge(charge, rows)).toBe(rows[0]);
  });

  it("matches an ILS receipt against a foreign-currency charge using the statement's own amountIls conversion", () => {
    const charge = {
      merchant: "Anthropic", amount: 100, currency: "USD", amountIls: 369.5, billingDate: "05.07.2026",
    };
    const rows = [masterRow({ date: "2026-07-03", amount: 369.5, currency: "ILS", provider: "Anthropic" })];
    expect(findReceiptForCharge(charge, rows)).toBe(rows[0]);
  });

  it("does NOT cross-match two unrelated same-priced charges in different, both-known currencies (false-positive this used to allow)", () => {
    // Same merchant/amount number, but a EUR charge should never satisfy a
    // USD charge just because the raw numbers coincide.
    const charge = { merchant: "Anthropic", amount: 100, currency: "USD", billingDate: "05.07.2026" };
    const rows = [masterRow({ date: "2026-07-03", amount: 100, currency: "EUR", provider: "Anthropic" })];
    expect(findReceiptForCharge(charge, rows)).toBeNull();
  });
});

describe("matchReceiptToPendingCharge", () => {
  it("matches within the date window", () => {
    const extracted = { amount: 100, provider: "Uber", date: "2026-07-03" };
    const charges = [{ merchant: "Uber", amount: 100, billingDate: "05.07.2026", clusterKey: "k1" }];
    expect(matchReceiptToPendingCharge(extracted, charges)).toBe(charges[0]);
  });

  it("does not reject a match just because the extracted date is unparseable", () => {
    const extracted = { amount: 100, provider: "Uber", date: "garbage" };
    const charges = [{ merchant: "Uber", amount: 100, billingDate: "05.07.2026", clusterKey: "k1" }];
    expect(matchReceiptToPendingCharge(extracted, charges)).toBe(charges[0]);
  });
});

describe("buildNotMineBlocks", () => {
  it("groups charges by clusterKey into one section+button pair each", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      charges: [
        { clusterKey: "k1", merchant: "LinkedIn", card: "4154", amount: 100, currency: "USD" },
        { clusterKey: "k1", merchant: "LinkedIn", card: "4154", amount: 50, currency: "USD" },
        { clusterKey: "k2", merchant: "Uber", card: "9037", amount: 30, currency: "ILS" },
      ],
      userId: "U123",
      userName: "Aviad",
      runId: "run_1",
    });

    const chargeButtons = blocks.filter(
      (b) => b.type === "actions" && b.elements[0].action_id === "statement_not_mine_charge"
    );
    expect(chargeButtons).toHaveLength(2);

    const linkedinSection = blocks.find(
      (b) => b.type === "section" && b.text.text.includes("LinkedIn")
    );
    expect(linkedinSection.text.text).toBe("*LinkedIn* · card ...4154\n  - 100 USD\n  - 50 USD");
  });

  it("encodes userId/userName/runId/clusterKey in each per-charge button value", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      charges: [{ clusterKey: "k1", merchant: "LinkedIn", card: "4154", amount: 100, currency: "USD" }],
      userId: "U123",
      userName: "Aviad",
      runId: "run_1",
    });
    const button = blocks.find((b) => b.type === "actions" && b.elements[0].action_id === "statement_not_mine_charge");
    expect(JSON.parse(button.elements[0].value)).toEqual({
      userId: "U123", userName: "Aviad", runId: "run_1", clusterKey: "k1",
    });
  });

  it("always appends exactly one global 'None of these are mine' button, without a clusterKey", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      charges: [
        { clusterKey: "k1", merchant: "A", card: "1", amount: 1, currency: "ILS" },
        { clusterKey: "k2", merchant: "B", card: "2", amount: 2, currency: "ILS" },
      ],
      userId: "U1",
      userName: "Lee",
      runId: "run_9",
    });
    const globalButtons = blocks.filter(
      (b) => b.type === "actions" && b.elements[0].action_id === "statement_not_mine_all"
    );
    expect(globalButtons).toHaveLength(1);
    expect(JSON.parse(globalButtons[0].elements[0].value)).toEqual({
      userId: "U1", userName: "Lee", runId: "run_9",
    });
  });

  it("falls back to merchant|card as the group key when clusterKey is missing", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      charges: [
        { merchant: "A", card: "1", amount: 1, currency: "ILS" },
        { merchant: "A", card: "1", amount: 2, currency: "ILS" },
      ],
      userId: "U1",
      userName: "Lee",
      runId: "run_9",
    });
    const chargeButtons = blocks.filter(
      (b) => b.type === "actions" && b.elements[0].action_id === "statement_not_mine_charge"
    );
    expect(chargeButtons).toHaveLength(1); // both charges collapse into the same fallback group
  });

  it("includes trailerText as its own section right before the divider, when provided", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      trailerText: "trailer note",
      charges: [{ clusterKey: "k1", merchant: "A", card: "1", amount: 1, currency: "ILS" }],
      userId: "U1",
      userName: "Lee",
      runId: "run_9",
    });
    const dividerIndex = blocks.findIndex((b) => b.type === "divider");
    expect(blocks[dividerIndex - 1]).toEqual({
      type: "section",
      text: { type: "mrkdwn", text: "trailer note" },
    });
  });

  it("omits a trailer section when trailerText is not provided", () => {
    const blocks = buildNotMineBlocks({
      leadText: "lead",
      charges: [{ clusterKey: "k1", merchant: "A", card: "1", amount: 1, currency: "ILS" }],
      userId: "U1",
      userName: "Lee",
      runId: "run_9",
    });
    const dividerIndex = blocks.findIndex((b) => b.type === "divider");
    expect(blocks[dividerIndex - 1].type).toBe("actions"); // the per-charge button, not a trailer section
  });
});
