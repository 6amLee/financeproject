import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub googleapis + the auth singleton so nothing in this file can make a
// network request (same approach as statementChase.test.js).
const mockClear = vi.fn(async () => ({ data: {} }));
const mockUpdate = vi.fn(async () => ({ data: {} }));
vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: { values: { clear: mockClear, update: mockUpdate } },
    })),
  },
}));
vi.mock("../src/googleAuth.js", () => ({
  getGoogleAuth: vi.fn(() => ({})),
}));

const { buildStatementStatusRow, writeStatementStatusTab, TAB_NAME } =
  await import("../src/financeCrew/statementStatus.js");

beforeEach(() => {
  mockClear.mockReset();
  mockUpdate.mockReset();
  mockClear.mockResolvedValue({ data: {} });
  mockUpdate.mockResolvedValue({ data: {} });
});

describe("buildStatementStatusRow", () => {
  it("maps a still-pending charge to a 'No' row with the right stage label", () => {
    const row = buildStatementStatusRow({
      runId: "run_1",
      person: "Aviad",
      charge: { merchant: "Wolt", amount: 84.5, currency: "ILS", billingDate: "10.03.2026" },
      accountedFor: false,
      nudgeCount: 2,
      lastChecked: "2026-07-16T10:00:00.000Z",
    });
    expect(row).toEqual([
      "run_1", "Aviad", "Wolt", "84.5", "ILS", "10.03.2026", "No", "Stage 2", "2026-07-16T10:00:00.000Z",
    ]);
  });

  it("maps an accounted-for charge to a 'Yes' row", () => {
    const row = buildStatementStatusRow({
      runId: "run_1",
      person: "Roee",
      charge: { merchant: "Anthropic", amount: 55.84, currency: "USD", billingDate: "09.07.2026" },
      accountedFor: true,
      nudgeCount: 1,
    });
    expect(row[6]).toBe("Yes");
    expect(row[7]).toBe("Stage 1");
  });

  it("labels nudgeCount >= 3 as the final stage", () => {
    const row = buildStatementStatusRow({
      runId: "run_1", person: "Ron", charge: {}, accountedFor: false, nudgeCount: 3,
    });
    expect(row[7]).toBe("Stage 3 (final)");
  });

  it("uses stageOverride instead of the nudgeCount-derived label when provided", () => {
    const row = buildStatementStatusRow({
      runId: "run_1", person: "Ron", charge: {}, accountedFor: false, nudgeCount: 3,
      stageOverride: "Complete — still missing",
    });
    expect(row[7]).toBe("Complete — still missing");
  });

  it("defaults missing charge fields to empty strings rather than throwing", () => {
    const row = buildStatementStatusRow({ runId: "run_1", person: "Lee", charge: {}, accountedFor: false });
    expect(row.slice(2, 6)).toEqual(["", "", "", ""]);
  });
});

describe("writeStatementStatusTab", () => {
  it("clears the data range before writing the header + fresh rows", async () => {
    const entries = [
      { runId: "run_1", person: "Aviad", charge: { merchant: "Wolt", amount: 84.5, currency: "ILS", billingDate: "10.03.2026" }, accountedFor: false, nudgeCount: 1, lastChecked: "2026-07-16T10:00:00.000Z" },
    ];
    await writeStatementStatusTab("sheet123", entries);

    expect(mockClear).toHaveBeenCalledWith({
      spreadsheetId: "sheet123",
      range: `'${TAB_NAME}'!A2:I`,
    });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    const call = mockUpdate.mock.calls[0][0];
    expect(call.spreadsheetId).toBe("sheet123");
    expect(call.range).toBe(`'${TAB_NAME}'!A1`);
    expect(call.requestBody.values[0]).toEqual([
      "Run ID", "Person", "Merchant", "Amount", "Currency", "Billing Date",
      "Accounted For", "Nudge Stage", "Last Checked",
    ]);
    expect(call.requestBody.values[1][0]).toBe("run_1");
  });

  it("writes just the header when entries is empty (clears stale rows without leaving old data)", async () => {
    await writeStatementStatusTab("sheet123", []);
    expect(mockClear).toHaveBeenCalledOnce();
    const call = mockUpdate.mock.calls[0][0];
    expect(call.requestBody.values).toHaveLength(1); // header only
  });

  it("clears before writing, in that order", async () => {
    const order = [];
    mockClear.mockImplementation(async () => { order.push("clear"); return { data: {} }; });
    mockUpdate.mockImplementation(async () => { order.push("update"); return { data: {} }; });
    await writeStatementStatusTab("sheet123", []);
    expect(order).toEqual(["clear", "update"]);
  });
});
