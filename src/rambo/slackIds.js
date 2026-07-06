// ── SLACK ID MAP ──────────────────────────────────────────────────────────────
// Single source of truth for name → Slack user ID. Imported by rambo.js,
// statementRambo.js, and slackIntake.js so the mapping is never duplicated.
// Two names (Gal, Nadav) had multiple matches — confirmed with Lee.

export const SLACK_ID_BY_NAME = {
  Ron:     "U05KWG707DG",
  Roee:    "U057W53SUEN",
  Elad:    "U064M72MVFS",
  Lee:     "U06LG6L3E1H",
  Marco:   "U06AERTAPR6",
  Diana:   "U06TWLVF1R6",
  Aviad:   "U05QEAJDK09",
  Aviv:    "U05820C9SSV",
  Richard: "U088RRKVDGT",
  Olivia:  "U06231ZUM0S",
  Bruni:   "U09R1PHQMGC",
  Rafael:  "U06SLH4C0CA",
  Gal:     "U06PZV5K6LC",
  Nadav:   "U07L3GS96KE",
  Yulia:   "U088YU5HD4H",
};

export function resolveSlackId(name) {
  return SLACK_ID_BY_NAME[name] ?? null;
}
