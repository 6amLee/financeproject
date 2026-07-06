import { describe, it, expect } from "vitest";
import { resolveOwner, COLD_START_OWNERS } from "../src/rambo/resolver.js";

// Minimal cluster in matcher.js's clusterTransactions output shape.
function makeCluster(overrides = {}) {
  return {
    key: "9037|linkedin|2026-06",
    card: "9037",
    merchant: "linkedin",
    vendor: "LinkedIn",
    period: "2026-06",
    transactions: [],
    count: 1,
    identicalAmounts: true,
    ...overrides,
  };
}

// Ledger entry in getLedgerEntries's parsed shape.
function makeEntry(overrides = {}) {
  return {
    vendor: "LinkedIn",
    card: "9037",
    resolvedOwner: ["Aviv"],
    resolvedAt: "2026-06-01T00:00:00.000Z",
    resolutionSource: "vendor_map",
    confirmed: true,
    ...overrides,
  };
}

describe("resolveOwner", () => {
  it("returns vendor-map owners with source vendor_map, even when ledger history also exists", () => {
    const result = resolveOwner({
      vendor: "Anthropic",
      card: "4154",
      cluster: makeCluster({ vendor: "Anthropic" }),
      ownershipMap: { Anthropic: { owners: ["Ron"], cardsSeen: ["4154"], recurring: true, aliases: [] } },
      ledgerEntries: [
        // History says Lee — the vendor map must still win.
        makeEntry({ vendor: "Anthropic", resolvedOwner: ["Lee"] }),
      ],
    });
    expect(result).toEqual({ owners: ["Ron"], source: "vendor_map", targetType: "owner" });
  });

  it("vendor map lookup is case-insensitive", () => {
    const result = resolveOwner({
      vendor: "anthropic",
      card: "4154",
      cluster: makeCluster({ vendor: "anthropic" }),
      ownershipMap: { Anthropic: { owners: ["Ron"], cardsSeen: [], recurring: true, aliases: [] } },
      ledgerEntries: [],
    });
    expect(result.source).toBe("vendor_map");
    expect(result.owners).toEqual(["Ron"]);
  });

  it("falls through to confirmed vendor history when the vendor map has no owner", () => {
    const result = resolveOwner({
      vendor: "Figma",
      card: "4154",
      cluster: makeCluster({ vendor: "Figma" }),
      // Vendor present but ownerless (intentional-blank case from ownership.js).
      ownershipMap: { Figma: { owners: [], cardsSeen: [], recurring: true, aliases: [] } },
      ledgerEntries: [
        makeEntry({ vendor: "Figma", resolvedOwner: ["Marco"], resolvedAt: "2026-05-01T00:00:00.000Z" }),
        makeEntry({ vendor: "Figma", resolvedOwner: ["Diana"], resolvedAt: "2026-06-20T00:00:00.000Z" }),
      ],
    });
    // Most recent confirmed vendor entry wins.
    expect(result.owners).toEqual(["Diana"]);
    expect(result.source).toBe("vendor_history");
  });

  it("ignores unconfirmed vendor-history entries", () => {
    const result = resolveOwner({
      vendor: "Figma",
      card: "",
      cluster: makeCluster({ vendor: "Figma" }),
      ownershipMap: {},
      ledgerEntries: [
        makeEntry({ vendor: "Figma", resolvedOwner: ["Marco"], confirmed: false }),
      ],
    });
    // Nothing confirmed anywhere → cold start, not Marco.
    expect(result.source).toBe("cold_start");
  });

  it("falls through to confirmed card history when there is no vendor map or vendor history", () => {
    const result = resolveOwner({
      vendor: "Some New Vendor",
      card: "9037",
      cluster: makeCluster({ vendor: null, merchant: "some new vendor" }),
      ownershipMap: {},
      ledgerEntries: [
        makeEntry({ vendor: "LinkedIn", card: "9037", resolvedOwner: ["Aviv"] }),
      ],
    });
    expect(result.owners).toEqual(["Aviv"]);
    expect(result.source).toBe("card_history");
  });

  it("card history is recency-weighted: the more recent owner wins", () => {
    const result = resolveOwner({
      vendor: "Some New Vendor",
      card: "9037",
      cluster: makeCluster(),
      ownershipMap: {},
      ledgerEntries: [
        // Marco used to hold this card; Diana is the recent resolution.
        makeEntry({ vendor: "Notion", card: "9037", resolvedOwner: ["Marco"], resolvedAt: "2026-01-01T00:00:00.000Z" }),
        makeEntry({ vendor: "Slack", card: "9037", resolvedOwner: ["Diana"], resolvedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    expect(result.owners).toEqual(["Diana"]);
    expect(result.source).toBe("card_history");
  });

  it("recency decay beats raw count: one recent entry outweighs several stale ones", () => {
    const result = resolveOwner({
      vendor: "Some New Vendor",
      card: "9037",
      cluster: makeCluster(),
      ownershipMap: {},
      ledgerEntries: [
        // Two 5-month-old entries for Marco: 2 × 0.5^(~151/30) ≈ 0.06,
        // far below Diana's fresh weight of 1.0.
        makeEntry({ vendor: "Notion", card: "9037", resolvedOwner: ["Marco"], resolvedAt: "2026-01-01T00:00:00.000Z" }),
        makeEntry({ vendor: "Miro", card: "9037", resolvedOwner: ["Marco"], resolvedAt: "2026-01-02T00:00:00.000Z" }),
        makeEntry({ vendor: "Slack", card: "9037", resolvedOwner: ["Diana"], resolvedAt: "2026-06-01T00:00:00.000Z" }),
      ],
    });
    expect(result.owners).toEqual(["Diana"]);
    expect(result.source).toBe("card_history");
  });

  it("card history ignores entries for other cards and unconfirmed entries", () => {
    const result = resolveOwner({
      vendor: "Some New Vendor",
      card: "9037",
      cluster: makeCluster(),
      ownershipMap: {},
      ledgerEntries: [
        makeEntry({ card: "4154", resolvedOwner: ["Marco"] }), // other card
        makeEntry({ card: "9037", resolvedOwner: ["Elad"], confirmed: false }),
      ],
    });
    expect(result.source).toBe("cold_start");
  });

  it("falls back to the cold-start list when nothing else matches", () => {
    const result = resolveOwner({
      vendor: "Brand New Vendor",
      card: "0000",
      cluster: makeCluster({ vendor: null }),
      ownershipMap: {},
      ledgerEntries: [],
    });
    expect(result.owners).toEqual([
      "Roee", "Ron", "Elad", "Lee", "Marco", "Diana", "Richard", "Aviv", "Nadav",
    ]);
    expect(result.owners).toEqual(COLD_START_OWNERS);
    expect(result.source).toBe("cold_start");
    // 9 candidates is inherently an owner-set target.
    expect(result.targetType).toBe("owner_set");
  });

  it("respects a caller-provided coldStartList", () => {
    const result = resolveOwner({
      vendor: "Brand New Vendor",
      card: "0000",
      cluster: makeCluster({ vendor: null }),
      ownershipMap: {},
      ledgerEntries: [],
      coldStartList: ["Lee"],
    });
    expect(result).toEqual({ owners: ["Lee"], source: "cold_start", targetType: "owner" });
  });

  it("identicalAmounts + multiple vendor owners → targetType owner_set with all owners", () => {
    const result = resolveOwner({
      vendor: "LinkedIn",
      card: "9037",
      cluster: makeCluster({ identicalAmounts: true }),
      ownershipMap: {
        LinkedIn: {
          owners: ["Olivia", "Aviv", "Lee"],
          cardsSeen: ["9037"],
          recurring: true,
          aliases: ["LINKEDIN SN *01553993", "LINKEDIN JOB*01411841"],
        },
      },
      ledgerEntries: [],
    });
    expect(result.owners).toEqual(["Olivia", "Aviv", "Lee"]);
    expect(result.source).toBe("vendor_map");
    expect(result.targetType).toBe("owner_set");
  });

  // Real-data case from the design doc: the LinkedIn row parses to
  // owners ["Olivia", "Aviv", "Lee"], and the real statement carried two
  // DIFFERENT amounts on the same card/month (569.99 Sales Navigator vs
  // 3203.88 Recruiter), i.e. identicalAmounts === false. The doc wants
  // per-product narrowing here, but ownership.js doesn't expose per-product
  // ownership yet — so the documented limitation applies: still target the
  // full owner set, correctly populated.
  it("real LinkedIn data with differing amounts falls back to owner_set (documented limitation)", () => {
    const cluster = makeCluster({
      identicalAmounts: false,
      count: 2,
      transactions: [
        { card: "9037", merchant: "LINKEDIN SN *01553993", amount: 569.99, billingDate: "02.06.2026", refund: false },
        { card: "9037", merchant: "LINKEDIN JOB*01411841", amount: 3203.88, billingDate: "02.06.2026", refund: false },
      ],
    });
    const result = resolveOwner({
      vendor: "LinkedIn",
      card: "9037",
      cluster,
      ownershipMap: {
        LinkedIn: {
          owners: ["Olivia", "Aviv", "Lee"],
          cardsSeen: ["9037"],
          recurring: true,
          aliases: ["LINKEDIN SN *01553993", "LINKEDIN JOB*01411841"],
        },
      },
      ledgerEntries: [],
    });
    expect(result.targetType).toBe("owner_set");
    expect(result.owners).toEqual(["Olivia", "Aviv", "Lee"]);
    expect(result.source).toBe("vendor_map");
    // The limitation is surfaced, not silent.
    expect(result.note).toMatch(/per-product ownership/);
  });

  it("single-owner resolutions carry targetType owner and no limitation note", () => {
    const result = resolveOwner({
      vendor: "Anthropic",
      card: "4154",
      cluster: makeCluster({ vendor: "Anthropic", identicalAmounts: false }),
      ownershipMap: { Anthropic: { owners: ["Ron"], cardsSeen: [], recurring: true, aliases: [] } },
      ledgerEntries: [],
    });
    expect(result.targetType).toBe("owner");
    expect(result.note).toBeUndefined();
  });

  it("accepts comma-joined resolvedOwner strings from raw ledger rows", () => {
    const result = resolveOwner({
      vendor: "Figma",
      card: "4154",
      cluster: makeCluster({ vendor: "Figma" }),
      ownershipMap: {},
      ledgerEntries: [
        makeEntry({ vendor: "Figma", resolvedOwner: "Olivia, Aviv" }),
      ],
    });
    expect(result.owners).toEqual(["Olivia", "Aviv"]);
    expect(result.source).toBe("vendor_history");
    expect(result.targetType).toBe("owner_set");
  });
});
