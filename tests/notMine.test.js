import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub googleapis + the auth singleton so nothing in this file can make a
// network request (same approach as ledger.test.js).
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

const { getNotMineEntries, appendNotMineEntry, buildNotMineRow, isExcluded } = await import(
  "../src/financeCrew/notMine.js"
);

beforeEach(() => {
  mockGet.mockReset();
  mockAppend.mockReset();
  mockAppend.mockResolvedValue({ data: {} });
});

describe("buildNotMineRow", () => {
  it("builds the row in column order", () => {
    const row = buildNotMineRow({
      userId: "U123",
      userName: "Aviad",
      scope: "charge",
      clusterKey: "9037|linkedin|2026-07",
      declaredAt: "2026-07-13T10:00:00.000Z",
    });
    expect(row).toEqual([
      "U123",
      "Aviad",
      "charge",
      "9037|linkedin|2026-07",
      "2026-07-13T10:00:00.000Z",
    ]);
  });

  it("defaults declaredAt to now when omitted", () => {
    const row = buildNotMineRow({ userId: "U1", userName: "Lee", scope: "all", clusterKey: "" });
    expect(row[4]).not.toBe("");
  });
});

describe("appendNotMineEntry", () => {
  it("appends to the Not Mine tab", async () => {
    await appendNotMineEntry("sheet-123", {
      userId: "U123",
      userName: "Aviad",
      scope: "charge",
      clusterKey: "k1",
      declaredAt: "2026-07-13T10:00:00.000Z",
    });
    expect(mockAppend).toHaveBeenCalledWith({
      spreadsheetId: "sheet-123",
      range: "'Not Mine'!A1",
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [["U123", "Aviad", "charge", "k1", "2026-07-13T10:00:00.000Z"]],
      },
    });
  });
});

describe("getNotMineEntries", () => {
  it("reads and parses rows", async () => {
    mockGet.mockResolvedValue({
      data: {
        values: [
          ["U123", "Aviad", "charge", "k1", "2026-07-13T10:00:00.000Z"],
          ["U456", "Roee", "all", "", "2026-07-13T11:00:00.000Z"],
        ],
      },
    });
    const entries = await getNotMineEntries("sheet-123");
    expect(entries).toEqual([
      { userId: "U123", userName: "Aviad", scope: "charge", clusterKey: "k1", declaredAt: "2026-07-13T10:00:00.000Z", rowNumber: 2 },
      { userId: "U456", userName: "Roee", scope: "all", clusterKey: "", declaredAt: "2026-07-13T11:00:00.000Z", rowNumber: 3 },
    ]);
  });

  it("returns [] for an empty tab", async () => {
    mockGet.mockResolvedValue({ data: {} });
    expect(await getNotMineEntries("sheet-123")).toEqual([]);
  });
});

describe("isExcluded", () => {
  const entries = [
    { userId: "U1", userName: "Aviad", scope: "charge", clusterKey: "k1" },
    { userId: "U2", userName: "Roee", scope: "all", clusterKey: "" },
  ];

  it("excludes an exact user+clusterKey match under scope=charge", () => {
    expect(isExcluded(entries, { userId: "U1", clusterKey: "k1" })).toBe(true);
  });

  it("does not exclude the same user for a different clusterKey", () => {
    expect(isExcluded(entries, { userId: "U1", clusterKey: "k2" })).toBe(false);
  });

  it("excludes every charge for a user opted out under scope=all", () => {
    expect(isExcluded(entries, { userId: "U2", clusterKey: "anything" })).toBe(true);
    expect(isExcluded(entries, { userId: "U2", clusterKey: "" })).toBe(true);
  });

  it("does not exclude a user with no matching entry", () => {
    expect(isExcluded(entries, { userId: "U3", clusterKey: "k1" })).toBe(false);
  });

  it("returns false for an empty entries list", () => {
    expect(isExcluded([], { userId: "U1", clusterKey: "k1" })).toBe(false);
  });
});
