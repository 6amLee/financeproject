import { describe, it, expect } from "vitest";
import {
  nextChaseAction,
  buildChaseMessage,
  getChaseRecipients,
  STAGE_MANAGERS,
  STAGE_FINAL_TARGETS,
} from "../src/olive/chase.js";
import { COLD_START_OWNERS } from "../src/olive/resolver.js";

// Pure-logic tests only: nextChaseAction and buildChaseMessage take plain
// data in and return plain data out — no clock mocking (now is a parameter),
// no Slack, no Sheets. sendSlackMessage/sendChaseNudges are thin I/O wrappers
// tested by not being tested (see the build report).

const HOUR_MS = 3_600_000;
// T0 = the ORIGINAL missing-charge detection instant. All of the design doc's
// T+48/72/96/120/144 offsets in these tests are measured from this single
// origin — the continuous-timeline interpretation (see chase.js header).
const T0 = new Date("2026-07-01T09:00:00.000Z");
const at = (hours) => new Date(T0.getTime() + hours * HOUR_MS);

const freshState = (overrides = {}) => ({
  clusterId: "9037|linkedin|2026-07",
  vendor: "LinkedIn",
  amount: 569.99,
  stage: 1,
  stageEnteredAt: T0.toISOString(),
  lastNudgeAt: "",
  resolved: false,
  ...overrides,
});

describe("nextChaseAction — stage 1 cadence (T+0, T+24h)", () => {
  it("nudges immediately when freshly detected (now === stageEnteredAt)", () => {
    const action = nextChaseAction({ clusterState: freshState(), now: at(0) });
    expect(action).toMatchObject({ action: "nudge", stage: 1 });
  });

  it("waits at +12h once the T+0 nudge has fired (before the T+24 threshold)", () => {
    const state = freshState({ lastNudgeAt: T0.toISOString() });
    expect(nextChaseAction({ clusterState: state, now: at(12) })).toEqual({
      action: "wait",
    });
  });

  it("nudges at +25h — the T+24 threshold has passed and hasn't fired yet", () => {
    // lastNudgeAt records the T+0 nudge only; T+24 is still unfired.
    const state = freshState({ lastNudgeAt: T0.toISOString() });
    const action = nextChaseAction({ clusterState: state, now: at(25) });
    expect(action).toMatchObject({ action: "nudge", stage: 1, thresholdHours: 24 });
  });

  it("does not re-fire the T+24 threshold once it has nudged", () => {
    const state = freshState({ lastNudgeAt: at(25).toISOString() });
    expect(nextChaseAction({ clusterState: state, now: at(30) })).toEqual({
      action: "wait",
    });
  });
});

describe("nextChaseAction — continuous timeline across stages", () => {
  // INTERPRETATION UNDER TEST: the doc's T+48/72/96/120/144 are cumulative
  // offsets from the ORIGINAL detection (T0), not per-stage restarts. So the
  // stage 1 → 2 boundary is at T0+48h, and the advance action anchors the new
  // stageEnteredAt to that theoretical boundary — NOT to `now` — so a late
  // poll never shifts the rest of the schedule.
  it("advances 1 → 2 at T+48h from ORIGINAL detection, anchored to the boundary", () => {
    const state = freshState({ lastNudgeAt: at(25).toISOString() });
    const action = nextChaseAction({ clusterState: state, now: at(49) }); // poll woke up 1h late
    expect(action).toEqual({
      action: "advance",
      toStage: 2,
      stageEnteredAt: at(48).toISOString(), // T0 + 48h, not T0 + 49h
    });
  });

  it("after applying the advance, the same tick's re-call fires stage 2's T+48 nudge", () => {
    // olive.js applies "advance" and calls again — no nudge is skipped.
    const advanced = freshState({
      stage: 2,
      stageEnteredAt: at(48).toISOString(),
      lastNudgeAt: at(25).toISOString(), // last nudge was stage 1's T+24
    });
    const action = nextChaseAction({ clusterState: advanced, now: at(49) });
    expect(action).toMatchObject({ action: "nudge", stage: 2, thresholdHours: 0 });
  });

  it("stage 2 fires its second nudge at the cumulative T+72h", () => {
    const state = freshState({
      stage: 2,
      stageEnteredAt: at(48).toISOString(),
      lastNudgeAt: at(48).toISOString(), // T+48 nudge fired on time
    });
    expect(nextChaseAction({ clusterState: state, now: at(71) })).toEqual({
      action: "wait",
    });
    expect(
      nextChaseAction({ clusterState: state, now: at(72) })
    ).toMatchObject({ action: "nudge", stage: 2, thresholdHours: 24 });
  });

  it("walks 2 → 3 at T+96h and 3 → 4 at T+144h on the same shared clock", () => {
    const stage2 = freshState({
      stage: 2,
      stageEnteredAt: at(48).toISOString(),
      lastNudgeAt: at(72).toISOString(),
    });
    expect(nextChaseAction({ clusterState: stage2, now: at(96) })).toEqual({
      action: "advance",
      toStage: 3,
      stageEnteredAt: at(96).toISOString(),
    });

    const stage3 = freshState({
      stage: 3,
      stageEnteredAt: at(96).toISOString(),
      lastNudgeAt: at(120).toISOString(),
    });
    expect(nextChaseAction({ clusterState: stage3, now: at(144) })).toEqual({
      action: "advance",
      toStage: 4,
      stageEnteredAt: at(144).toISOString(),
    });
  });
});

describe("nextChaseAction — stage 4 is terminal", () => {
  const stage4 = (overrides = {}) =>
    freshState({
      stage: 4,
      stageEnteredAt: at(144).toISOString(),
      lastNudgeAt: at(120).toISOString(), // stage 3's last nudge
      ...overrides,
    });

  it("fires its single nudge at T+144h", () => {
    const action = nextChaseAction({ clusterState: stage4(), now: at(144) });
    expect(action).toMatchObject({ action: "nudge", stage: 4 });
  });

  it("never nudges or advances again after the T+144 nudge — ever", () => {
    const done = stage4({ lastNudgeAt: at(144).toISOString() });
    // 1 hour, 1 day, 1 month, 1 year later: always terminal, never an action.
    for (const hours of [145, 168, 144 + 24 * 30, 144 + 24 * 365]) {
      const action = nextChaseAction({ clusterState: done, now: at(hours) });
      expect(action).toEqual({ action: "stop", reason: "exhausted" });
    }
  });
});

describe("nextChaseAction — resolved stops everything", () => {
  it("returns stop regardless of timing once resolved, even mid-nudge-window", () => {
    // Timing that would otherwise be an immediate stage 1 nudge…
    const resolved = freshState({ resolved: true });
    expect(nextChaseAction({ clusterState: resolved, now: at(0) })).toEqual({
      action: "stop",
      reason: "resolved",
    });
    // …and timing that would otherwise be an advance or a stage 4 nudge.
    const resolvedLate = freshState({
      stage: 4,
      stageEnteredAt: at(144).toISOString(),
      resolved: true,
    });
    expect(nextChaseAction({ clusterState: resolvedLate, now: at(200) })).toEqual({
      action: "stop",
      reason: "resolved",
    });
  });
});

describe("buildChaseMessage", () => {
  const input = (stage) => ({
    vendor: "LinkedIn",
    amount: 569.99,
    currency: "USD",
    cluster: { card: "9037", period: "2026-07", count: 3 },
    owners: ["Olivia", "Aviv", "Lee"],
    stage,
  });

  it("produces different text per stage, escalating by stage 4", () => {
    const stage1 = buildChaseMessage(input(1));
    const stage4 = buildChaseMessage(input(4));
    expect(stage1).not.toEqual(stage4);
    // Stage 4 reads as escalated/urgent; stage 1 stays a friendly first ask.
    expect(stage4).toMatch(/overdue/i);
    expect(stage1).not.toMatch(/overdue/i);
  });

  it("includes the vendor and amount at every stage", () => {
    for (const stage of [1, 2, 3, 4]) {
      const text = buildChaseMessage(input(stage));
      expect(text).toContain("LinkedIn");
      expect(text).toContain("569.99 USD");
    }
  });

  it("degrades gracefully when cluster details are missing", () => {
    const text = buildChaseMessage({
      vendor: "Anthropic",
      amount: 200,
      currency: "USD",
      cluster: null,
      owners: [],
      stage: 1,
    });
    expect(text).toContain("Anthropic");
    expect(text).toContain("200 USD");
  });
});

describe("getChaseRecipients", () => {
  it("targets the resolver's owners at stage 1", () => {
    expect(
      getChaseRecipients({ stage: 1, resolvedOwners: ["Olivia", "Aviv"] })
    ).toEqual(["Olivia", "Aviv"]);
  });

  it("targets the 9 Potential Owners at stage 2 and the 12 Managers at stage 3", () => {
    expect(getChaseRecipients({ stage: 2, resolvedOwners: ["Olivia"] })).toEqual(
      COLD_START_OWNERS
    );
    expect(getChaseRecipients({ stage: 3, resolvedOwners: ["Olivia"] })).toEqual(
      STAGE_MANAGERS
    );
    // Distinct lists for distinct stages (master doc §4): 9 vs 12 names.
    expect(COLD_START_OWNERS).toHaveLength(9);
    expect(STAGE_MANAGERS).toHaveLength(12);
    expect(STAGE_MANAGERS).not.toEqual(COLD_START_OWNERS);
  });

  it("targets Roee + Yulia at stage 4", () => {
    expect(getChaseRecipients({ stage: 4, resolvedOwners: ["Olivia"] })).toEqual([
      "Roee",
      "Yulia",
    ]);
    expect(STAGE_FINAL_TARGETS).toEqual(["Roee", "Yulia"]);
  });
});
