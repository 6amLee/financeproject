import { describe, it, expect } from "vitest";
import { parseOwnershipSheet, parseOwnersCell } from "../src/rambo/ownership.js";

// Fixture built from real rows in the actual Vendor Ownership Google Sheet
// read during the design session. Column order:
// Vendor · Owner(s) · Type · Card(s) seen · Typical amount · Currency ·
// # charges · Recurring · Statement descriptor · Notes
const HEADER = ["Vendor", "Owner(s)", "Type", "Card(s) seen", "Typical amount", "Currency", "# charges", "Recurring", "Statement descriptor", "Notes"];

const ownershipFixture = [
  HEADER,
  ["LinkedIn", "Olivia, Aviv, Lee + other people", "Recurring/SaaS", "4154, 9037", "varies (570-3,204)", "ILS, USD", "4", "yes", "LINKEDIN SN *01553993 | LINKEDIN JOB*01411841", ""],
  ["Anthropic", "Ron", "Recurring/SaaS", "9037", "varies (3-800)", "USD", "17", "yes", "ANTHROPIC: CLAUDE TEA | CLAUDE.AI SUBSCRIPTIO", ""],
  ["Holmes Place", "Roee, Ron", "Recurring/SaaS", "5438, 9037", "428.32", "ILS", "2", "yes", "הולמס פלייס - הו”ק ר", ""],
  ["Uber", "", "One-off", "4154, 9037", "varies (0-126)", "EUR, USD", "25", "", "UBER TRIP | UBER UBER *TRIP HELP", ""],
];

describe("parseOwnershipSheet", () => {
  const { map, needsReview } = parseOwnershipSheet(ownershipFixture);

  it("skips the header row", () => {
    expect(map.Vendor).toBeUndefined();
    expect(Object.keys(map)).toEqual(["LinkedIn", "Anthropic", "Holmes Place", "Uber"]);
  });

  it("parses messy free-text owners, filtering '+ other people' junk", () => {
    expect(map.LinkedIn.owners).toEqual(["Olivia", "Aviv", "Lee"]);
  });

  it("parses a clean comma-separated owner list", () => {
    expect(map["Holmes Place"].owners).toEqual(["Roee", "Ron"]);
  });

  it("parses a single owner", () => {
    expect(map.Anthropic.owners).toEqual(["Ron"]);
  });

  it("gives a blank-owner vendor an empty owners array without crashing, and does NOT flag it for review", () => {
    // A blank Owner(s) cell is intentional per the sheet's own instructions
    // (one-off charges rarely need an owner) — Stage 2 falls through to
    // ledger history / cold start, so it stays out of needsReview.
    expect(map.Uber.owners).toEqual([]);
    expect(needsReview).toEqual([]);
  });

  it("flags rows whose non-blank owner text yields zero clean names", () => {
    const junkRow = ["Wolt", "+ other people", "One-off", "9037", "80", "ILS", "3", "", "WOLT", ""];
    const result = parseOwnershipSheet([HEADER, junkRow]);
    expect(result.map.Wolt.owners).toEqual([]);
    expect(result.needsReview).toEqual([junkRow]);
    // The vendor still stays in the map so its aliases/cards remain usable.
    expect(result.map.Wolt.aliases).toEqual(["WOLT"]);
  });

  it("captures |-separated Statement descriptor aliases as an array", () => {
    expect(map.LinkedIn.aliases).toEqual(["LINKEDIN SN *01553993", "LINKEDIN JOB*01411841"]);
    expect(map.Anthropic.aliases).toEqual(["ANTHROPIC: CLAUDE TEA", "CLAUDE.AI SUBSCRIPTIO"]);
    expect(map.Uber.aliases).toEqual(["UBER TRIP", "UBER UBER *TRIP HELP"]);
  });

  it("keeps a single Hebrew descriptor as a one-element alias array", () => {
    expect(map["Holmes Place"].aliases).toEqual(["הולמס פלייס - הו”ק ר"]);
  });

  it("splits multi-value Card(s) seen cells", () => {
    expect(map.LinkedIn.cardsSeen).toEqual(["4154", "9037"]);
    expect(map.Anthropic.cardsSeen).toEqual(["9037"]);
  });

  it("parses the Recurring flag", () => {
    expect(map.LinkedIn.recurring).toBe(true);
    expect(map.Uber.recurring).toBe(false);
  });

  it("ignores empty rows and rows without a vendor name", () => {
    const result = parseOwnershipSheet([HEADER, [], ["", "Ron"], ["Anthropic", "Ron", "", "9037", "", "USD", "1", "yes", "ANTHROPIC", ""]]);
    expect(Object.keys(result.map)).toEqual(["Anthropic"]);
  });
});

describe("parseOwnersCell", () => {
  it("trims inconsistent spacing", () => {
    expect(parseOwnersCell("  Roee ,  Ron  ").owners).toEqual(["Roee", "Ron"]);
  });

  it("distinguishes blank from unparseable", () => {
    expect(parseOwnersCell("")).toEqual({ owners: [], blank: true });
    expect(parseOwnersCell(null)).toEqual({ owners: [], blank: true });
    expect(parseOwnersCell("+ other people")).toEqual({ owners: [], blank: false });
  });
});
