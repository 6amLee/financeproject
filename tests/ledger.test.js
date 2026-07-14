import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub googleapis + the auth singleton so nothing in this file can make a
// network request (same approach as claude.test.js's Anthropic SDK stub).
const mockGet = vi.fn();
vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: { values: { get: mockGet } },
    })),
  },
}));
vi.mock("../src/googleAuth.js", () => ({
  getGoogleAuth: vi.fn(() => ({})),
}));

const { getLedgerEntries } = await import("../src/financeCrew/ledger.js");

beforeEach(() => {
  mockGet.mockReset();
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
      range: "'FinanceCrew Ledger'!A2:F",
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
