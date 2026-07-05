import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub googleapis + the auth singleton so nothing in this file can make a
// network request (same approach as claude.test.js's Anthropic SDK stub).
const mockGet = vi.fn();
const mockAppend = vi.fn(async () => ({ data: {} }));
vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: { values: { get: mockGet, append: mockAppend } },
    })),
  },
}));
vi.mock("../src/googleAuth.js", () => ({
  getGoogleAuth: vi.fn(() => ({})),
}));

const { getLedgerEntries, appendLedgerEntry, buildLedgerRow } = await import(
  "../src/rachel/ledger.js"
);

beforeEach(() => {
  mockGet.mockReset();
  mockAppend.mockReset();
  mockAppend.mockResolvedValue({ data: {} });
});

describe("buildLedgerRow", () => {
  it("builds the row in the documented column order, comma-joining owners", () => {
    const row = buildLedgerRow({
      vendor: "LinkedIn",
      card: "9037",
      resolvedOwner: ["Olivia", "Aviv", "Lee"],
      resolvedAt: "2026-07-05T10:00:00.000Z",
      resolutionSource: "vendor_map",
      confirmed: true,
    });
    expect(row).toEqual([
      "LinkedIn",
      "9037",
      "Olivia, Aviv, Lee",
      "2026-07-05T10:00:00.000Z",
      "vendor_map",
      "TRUE",
    ]);
  });

  it("writes FALSE for unconfirmed entries and accepts a string owner", () => {
    const row = buildLedgerRow({
      vendor: "Anthropic",
      card: "4154",
      resolvedOwner: "Ron",
      resolvedAt: "2026-07-05T10:00:00.000Z",
      resolutionSource: "cold_start",
      confirmed: false,
    });
    expect(row[2]).toBe("Ron");
    expect(row[5]).toBe("FALSE");
  });
});

describe("appendLedgerEntry", () => {
  it("appends the built row to the Rachel Ledger tab with the sheets.js append options", async () => {
    await appendLedgerEntry("sheet-123", {
      vendor: "LinkedIn",
      card: "9037",
      resolvedOwner: ["Olivia", "Aviv", "Lee"],
      resolvedAt: "2026-07-05T10:00:00.000Z",
      resolutionSource: "vendor_map",
      confirmed: true,
    });
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      range: "'Rachel Ledger'!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [
          [
            "LinkedIn",
            "9037",
            "Olivia, Aviv, Lee",
            "2026-07-05T10:00:00.000Z",
            "vendor_map",
            "TRUE",
          ],
        ],
      },
    });
  });

  it("serialises concurrent appends through the queue in call order", async () => {
    const order = [];
    let releaseFirst;
    mockAppend
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            releaseFirst = () => {
              order.push("first");
              resolve({ data: {} });
            };
          })
      )
      .mockImplementationOnce(async () => {
        order.push("second");
        return { data: {} };
      });

    const entry = (vendor) => ({
      vendor,
      card: "9037",
      resolvedOwner: ["Lee"],
      resolvedAt: "2026-07-05T10:00:00.000Z",
      resolutionSource: "vendor_map",
      confirmed: true,
    });
    const p1 = appendLedgerEntry("sheet-123", entry("A"));
    const p2 = appendLedgerEntry("sheet-123", entry("B"));

    // Second append must not start while the first is in flight.
    await Promise.resolve();
    expect(mockAppend).toHaveBeenCalledTimes(1);
    releaseFirst();
    await Promise.all([p1, p2]);
    expect(order).toEqual(["first", "second"]);
  });
});

describe("getLedgerEntries", () => {
  it("reads the data range and parses rows into resolver's record shape", async () => {
    mockGet.mockResolvedValue({
      data: {
        values: [
          ["LinkedIn", "9037", "Olivia, Aviv, Lee", "2026-06-01T00:00:00.000Z", "vendor_map", "TRUE"],
          ["Anthropic", "4154", "Ron", "2026-06-15T00:00:00.000Z", "card_history", "FALSE"],
        ],
      },
    });

    const entries = await getLedgerEntries("sheet-123");

    expect(mockGet).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      range: "'Rachel Ledger'!A2:F",
    });
    expect(entries).toEqual([
      {
        vendor: "LinkedIn",
        card: "9037",
        resolvedOwner: ["Olivia", "Aviv", "Lee"],
        resolvedAt: "2026-06-01T00:00:00.000Z",
        resolutionSource: "vendor_map",
        confirmed: true,
      },
      {
        vendor: "Anthropic",
        card: "4154",
        resolvedOwner: ["Ron"],
        resolvedAt: "2026-06-15T00:00:00.000Z",
        resolutionSource: "card_history",
        confirmed: false,
      },
    ]);
  });

  it("parses confirmed case-insensitively and treats blank/junk as false", async () => {
    mockGet.mockResolvedValue({
      data: {
        values: [
          ["A", "1", "Lee", "2026-06-01T00:00:00.000Z", "vendor_map", "true"],
          ["B", "2", "Ron", "2026-06-01T00:00:00.000Z", "vendor_map", ""],
          ["C", "3", "Aviv", "2026-06-01T00:00:00.000Z", "vendor_map", "yes"],
          ["D", "4", "Diana", "2026-06-01T00:00:00.000Z", "vendor_map"],
        ],
      },
    });
    const entries = await getLedgerEntries("sheet-123");
    expect(entries.map((e) => e.confirmed)).toEqual([true, false, false, false]);
  });

  it("returns [] for an empty tab and defaults missing cells safely", async () => {
    mockGet.mockResolvedValue({ data: {} });
    expect(await getLedgerEntries("sheet-123")).toEqual([]);

    mockGet.mockResolvedValue({ data: { values: [["OnlyVendor"]] } });
    expect(await getLedgerEntries("sheet-123")).toEqual([
      {
        vendor: "OnlyVendor",
        card: "",
        resolvedOwner: [],
        resolvedAt: "",
        resolutionSource: "",
        confirmed: false,
      },
    ]);
  });
});
