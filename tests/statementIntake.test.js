import { describe, it, expect } from "vitest";
import { buildNotMineBlocks } from "../src/statementIntake.js";

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
