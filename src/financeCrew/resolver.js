// ── FINANCECREW STAGE 2: OWNERSHIP RESOLVER ─────────────────────────────────
// Pure decision logic, no I/O: given an unmatched charge's vendor/card/cluster
// plus the parsed ownership map (ownership.js), past ledger entries
// (ledger.js's getLedgerEntries shape) and the cold-start list, rank who to
// nudge. Candidates are tried in the design-doc order, stopping at the first
// non-empty result:
//   1. vendor_map      — Vendor Ownership sheet says who owns this vendor
//   2. vendor_history  — most recent CONFIRMED ledger entry for this vendor
//   3. card_history    — confirmed ledger entries for this card, recency-
//                        weighted (see below)
//   4. cold_start      — the 9 Potential Owners from master doc §4
//
// Recency weighting (card_history): exponential decay with a 30-day
// half-life, measured relative to the NEWEST confirmed entry for the card
// (not to "now", so results are deterministic and don't drift as the clock
// advances). Each entry contributes 0.5^(ageDays/30) to every owner it names;
// the owner(s) with the top summed score win. This handles access churn — a
// single recent resolution for a new cardholder outweighs a stack of
// months-old ones for the previous holder, while genuinely recent repeat
// resolutions still accumulate.
//
// KNOWN LIMITATION (per design doc Stage 1/2): when a cluster's amounts
// differ per owner (identicalAmounts === false, e.g. LinkedIn Recruiter
// 3203.88 vs Sales Navigator 569.99), the doc wants specific amount deltas
// matched to specific owners via the ownership sheet's per-product notes.
// ownership.js does not expose per-product ownership (only owners/cardsSeen/
// recurring/aliases), so we fall back to targeting the full owner set and
// attach a `note` explaining why. Revisit once ownership.js parses per-
// product notes.

export const COLD_START_OWNERS = [
  "Roee",
  "Ron",
  "Elad",
  "Lee",
  "Marco",
  "Diana",
  "Richard",
  "Aviv",
  "Nadav",
];

const HALF_LIFE_DAYS = 30;
const DAY_MS = 86_400_000;

// Same normalization the matcher uses for vendor-name comparison: case-fold,
// trim, collapse internal whitespace.
const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/\s+/g, " ");

function toTime(v) {
  const t = Date.parse(String(v ?? ""));
  return Number.isNaN(t) ? 0 : t;
}

// Ledger entries store resolvedOwner as an array (getLedgerEntries splits the
// comma-joined cell), but accept a plain comma-joined string too.
function ownersOf(entry) {
  const v = entry?.resolvedOwner;
  const list = Array.isArray(v) ? v : String(v ?? "").split(",");
  return list.map((s) => String(s).trim()).filter((s) => s !== "");
}

// Multi-owner clustering rule: >1 owner means the resolution targets the
// whole owner SET (ambiguous which specific person). When the cluster's
// amounts DIFFER per owner we'd ideally narrow to a specific owner via
// per-product ownership — not available yet (see module header), so the
// result carries a `note` flagging the limitation.
function buildResult(owners, source, cluster) {
  const result = {
    owners,
    source,
    targetType: owners.length > 1 ? "owner_set" : "owner",
  };
  if (owners.length > 1 && cluster?.identicalAmounts === false) {
    result.note =
      "amounts differ per owner but per-product ownership is not available from ownership.js; targeting the full owner set";
  }
  return result;
}

export function resolveOwner({
  vendor,
  card,
  cluster,
  ownershipMap = {},
  ledgerEntries = [],
  coldStartList = COLD_START_OWNERS,
}) {
  // 1. Vendor→owner map. Case-insensitive vendor lookup, matching how the
  //    matcher resolves Provider names against the ownership map.
  const vendorNorm = norm(vendor);
  const vendorKey =
    vendorNorm === ""
      ? undefined
      : Object.keys(ownershipMap).find((k) => norm(k) === vendorNorm);
  const mapOwners = vendorKey ? ownershipMap[vendorKey].owners || [] : [];
  if (mapOwners.length > 0) {
    return buildResult([...mapOwners], "vendor_map", cluster);
  }

  // Only CONFIRMED resolutions teach the resolver anything — an unconfirmed
  // nudge that never got an answer is not evidence of ownership.
  const confirmed = (ledgerEntries || []).filter((e) => e?.confirmed === true);

  // 2. Learned vendor history: most recent confirmed entry for this exact
  //    vendor wins outright.
  const vendorHistory = confirmed
    .filter((e) => vendorNorm !== "" && norm(e.vendor) === vendorNorm)
    .sort((a, b) => toTime(b.resolvedAt) - toTime(a.resolvedAt));
  for (const entry of vendorHistory) {
    const owners = ownersOf(entry);
    if (owners.length > 0) return buildResult(owners, "vendor_history", cluster);
  }

  // 3. Learned card history, recency-weighted (any vendor on this card).
  const cardNorm = String(card ?? "").trim();
  const cardHistory = confirmed.filter(
    (e) => cardNorm !== "" && String(e.card ?? "").trim() === cardNorm
  );
  if (cardHistory.length > 0) {
    const newest = Math.max(...cardHistory.map((e) => toTime(e.resolvedAt)));
    const scores = new Map();
    for (const entry of cardHistory) {
      const ageDays = (newest - toTime(entry.resolvedAt)) / DAY_MS;
      const weight = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
      for (const owner of ownersOf(entry)) {
        scores.set(owner, (scores.get(owner) ?? 0) + weight);
      }
    }
    if (scores.size > 0) {
      const top = Math.max(...scores.values());
      const owners = [...scores]
        .filter(([, score]) => Math.abs(score - top) < 1e-9)
        .map(([owner]) => owner);
      return buildResult(owners, "card_history", cluster);
    }
  }

  // 4. Cold start.
  return buildResult([...coldStartList], "cold_start", cluster);
}
