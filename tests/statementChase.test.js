import { describe, it, expect, vi, beforeEach } from "vitest";

// Stub googleapis + the auth singleton so nothing in this file can make a
// network request (same approach as ledger.test.js / notMine.test.js).
const mockGet = vi.fn();
const mockUpdate = vi.fn(async () => ({ data: {} }));
vi.mock("googleapis", () => ({
  google: {
    sheets: vi.fn(() => ({
      spreadsheets: { values: { get: mockGet, update: mockUpdate } },
    })),
  },
}));
vi.mock("../src/googleAuth.js", () => ({
  getGoogleAuth: vi.fn(() => ({})),
}));

const { removePendingCharge } = await import("../src/olive/statementChase.js");

beforeEach(() => {
  mockGet.mockReset();
  mockUpdate.mockReset();
  mockUpdate.mockResolvedValue({ data: {} });
});

function row({ runId, userName, userId, dmChannelId = "D1", threadTs = "1.1", nudgeCount = 1, lastNudgeAt = "2026-07-13T00:00:00.000Z", pendingCharges, resolved = false }) {
  return [runId, userName, userId, dmChannelId, threadTs, String(nudgeCount), lastNudgeAt, JSON.stringify(pendingCharges), resolved ? "TRUE" : "FALSE"];
}

describe("removePendingCharge", () => {
  it("removes only the matching clusterKey and keeps the thread open when charges remain", async () => {
    mockGet.mockResolvedValue({
      data: {
        values: [
          row({
            runId: "run_1", userName: "Aviad", userId: "U1",
            pendingCharges: [{ clusterKey: "k1" }, { clusterKey: "k2" }],
          }),
        ],
      },
    });

    const updated = await removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "charge", clusterKey: "k1" });

    expect(updated.pendingCharges).toEqual([{ clusterKey: "k2" }]);
    expect(updated.resolved).toBe(false);
    expect(mockUpdate).toHaveBeenCalledWith({
      spreadsheetId: "sheet-1",
      range: "'Statement Chase Threads'!A2:I2",
      valueInputOption: "RAW",
      requestBody: { values: [row({
        runId: "run_1", userName: "Aviad", userId: "U1",
        pendingCharges: [{ clusterKey: "k2" }], resolved: false,
      })] },
    });
  });

  it("marks the thread resolved once the last charge is removed", async () => {
    mockGet.mockResolvedValue({
      data: { values: [row({ runId: "run_1", userName: "Aviad", userId: "U1", pendingCharges: [{ clusterKey: "k1" }] })] },
    });

    const updated = await removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "charge", clusterKey: "k1" });

    expect(updated.pendingCharges).toEqual([]);
    expect(updated.resolved).toBe(true);
  });

  it("scope=all clears every charge and resolves regardless of clusterKey", async () => {
    mockGet.mockResolvedValue({
      data: {
        values: [row({
          runId: "run_1", userName: "Aviad", userId: "U1",
          pendingCharges: [{ clusterKey: "k1" }, { clusterKey: "k2" }, { clusterKey: "k3" }],
        })],
      },
    });

    const updated = await removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "all", clusterKey: "" });

    expect(updated.pendingCharges).toEqual([]);
    expect(updated.resolved).toBe(true);
  });

  it("returns null when no open thread matches runId+userId", async () => {
    mockGet.mockResolvedValue({
      data: { values: [row({ runId: "run_1", userName: "Aviad", userId: "U1", pendingCharges: [{ clusterKey: "k1" }] })] },
    });

    expect(await removePendingCharge("sheet-1", { runId: "run_OTHER", userId: "U1", scope: "charge", clusterKey: "k1" })).toBeNull();
    expect(await removePendingCharge("sheet-1", { runId: "run_1", userId: "U_OTHER", scope: "charge", clusterKey: "k1" })).toBeNull();
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it("ignores an already-resolved row even with a matching runId+userId", async () => {
    mockGet.mockResolvedValue({
      data: { values: [row({ runId: "run_1", userName: "Aviad", userId: "U1", pendingCharges: [], resolved: true })] },
    });

    expect(await removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "charge", clusterKey: "k1" })).toBeNull();
  });

  it("two sequential removals never let the second undo the first (queue serialises the read+write)", async () => {
    // First call sees the original 2-charge list; its write must land before
    // the second call's get() fires, so the second call reads the TRIMMED
    // list rather than the original.
    let sheetState = row({
      runId: "run_1", userName: "Aviad", userId: "U1",
      pendingCharges: [{ clusterKey: "k1" }, { clusterKey: "k2" }],
    });
    mockGet.mockImplementation(async () => ({ data: { values: [sheetState] } }));
    mockUpdate.mockImplementation(async ({ requestBody }) => {
      sheetState = requestBody.values[0];
      return { data: {} };
    });

    const p1 = removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "charge", clusterKey: "k1" });
    const p2 = removePendingCharge("sheet-1", { runId: "run_1", userId: "U1", scope: "charge", clusterKey: "k2" });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Whichever ran second must have seen the first's write already applied.
    expect(r2.pendingCharges).toEqual([]);
    expect(r2.resolved).toBe(true);
    expect(r1.pendingCharges).toEqual([{ clusterKey: "k2" }]);
  });
});
