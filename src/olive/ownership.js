// ── OLIVE: VENDOR OWNERSHIP SHEET PARSER ────────────────────────────────────
// Best-effort parse of the (messy, free-text) Vendor Ownership sheet.
// Input-agnostic like the normalizer: takes the already-fetched 2D array
// (rows × columns) — the Sheets fetch itself lives with the caller, not here.
//
// Returns { map, needsReview }:
//   map         — { [vendorName]: { owners, cardsSeen, recurring, aliases } }
//   needsReview — raw rows whose non-blank Owner(s) text yielded zero clean
//                 names (surfaced in Olive's report, never silently dropped)

// Column order per the real sheet:
// Vendor · Owner(s) · Type · Card(s) seen · Typical amount · Currency ·
// # charges · Recurring · Statement descriptor · Notes
const COL = {
  vendor: 0,
  owners: 1,
  cardsSeen: 3,
  recurring: 7,
  descriptor: 8,
};

// A fragment "looks like a name" when it's letters (any script — owners may
// be written in Hebrew), spaces and common name punctuation, at least 2
// chars, and not a known filler phrase.
const NAME_RE = /^[\p{L}][\p{L}'’. -]*$/u;
const FILLER_RE = /\b(other|others|people|etc\.?|various|unknown|misc|team|everyone|anyone|tbd|n\/a|none)\b/i;

function looksLikeName(fragment) {
  return fragment.length >= 2 && NAME_RE.test(fragment) && !FILLER_RE.test(fragment);
}

// Best-effort heuristic per the design doc: split the free-text Owner(s)
// cell, trim each fragment, drop fragments that don't look like a name.
// We split on `+` as well as commas — the real sheet writes things like
// "Olivia, Aviv, Lee + other people", and a comma-only split would lose
// "Lee" inside the junk tail instead of recovering it.
export function parseOwnersCell(raw) {
  const text = String(raw ?? "").trim();
  if (text === "") return { owners: [], blank: true };
  const owners = text
    .split(/[,+]/)
    .map((f) => f.trim())
    .filter(looksLikeName);
  return { owners, blank: false };
}

function splitList(raw, separator) {
  return String(raw ?? "")
    .split(separator)
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

function parseRecurring(raw) {
  return /^(yes|y|true)$/i.test(String(raw ?? "").trim());
}

const isHeaderRow = (row) => /vendor/i.test(String(row?.[COL.vendor] ?? ""));

export function parseOwnershipSheet(rows) {
  const map = {};
  const needsReview = [];

  for (const row of rows || []) {
    if (!Array.isArray(row) || isHeaderRow(row)) continue;
    const vendor = String(row[COL.vendor] ?? "").trim();
    if (vendor === "") continue;

    const { owners, blank } = parseOwnersCell(row[COL.owners]);

    // Ownerless-vendor decision: a genuinely BLANK Owner(s) cell is
    // intentional per the sheet's own instructions (one-off travel/restaurant
    // charges rarely need an owner), so the vendor stays in the map with
    // owners: [] and does NOT go to needsReview — Stage 2's resolver simply
    // falls through to ledger history / cold start. Only rows with NON-BLANK
    // owner text that parsed to zero clean names are flagged for review:
    // that's genuinely unreadable data, not a deliberate omission. Keeping
    // both kinds in the map (rather than omitting them) preserves their
    // aliases/cards for Stage 1 descriptor matching either way.
    if (!blank && owners.length === 0) needsReview.push(row);

    map[vendor] = {
      owners,
      cardsSeen: splitList(row[COL.cardsSeen], ","),
      recurring: parseRecurring(row[COL.recurring]),
      // Statement descriptor holds multiple |-separated aliases.
      aliases: splitList(row[COL.descriptor], "|"),
    };
  }

  return { map, needsReview };
}
