# The Rachel — Design Doc (Stage 0–3: Normalizer, Matching, Ownership Resolution, Slack Chase)

> **Naming note:** the Railway service running this code was renamed to **Luna** after this doc and the underlying code were written. Code file/function names (`rachel.js`, `chase.js`, `Rachel Ledger`/`Rachel Chase State` sheet tabs, etc.) were intentionally left unchanged — only the Railway service name and its `LUNA_POLL_INTERVAL_MINUTES` env var follow the rename. "The Rachel" below refers to the same system now running as the Luna service.

## Context

The Node.js receipt-intake service (emails → Claude → Master DB rows) is built, pushed to `github.com/6amLee/financeproject`, and blocked only on Ron issuing a rotated Anthropic key. The Master Doc's §10 describes "The Rachel" — the second half of the system: reconcile the credit-card statement against the Master DB daily and chase missing receipts over Slack. It was never built; only Stage 0 (statement normalizer) was "prototyped." This doc designs all four stages end-to-end, grounded in two real files read this session:

- **Real statement export** (a Bank Hapoalim-style Hebrew credit card statement): confirmed 5 sections — previous-charges summary, domestic-by-card summary, overseas-by-card summary, domestic transaction detail, overseas transaction detail (further split into an ILS-converted block and a by-original-currency block for USD/other). Confirmed real quirks: reference numbers (אסמכתא) are often trivial/reused (`0`, `1001`) so can't be a match key; recurring flag is literal (`הוראת קבע` = standing order); refunds appear as negative amounts in the same detail rows (not separate); overseas descriptors embed a city prefix before `~` (e.g. `SAN FRANCISCO~ANTHROPIC: CLAUDE TEA`) that must be stripped before fuzzy matching; which column holds "original currency amount" shifts depending on which of the 3 detail sections a row came from.
- **Real Vendor Ownership sheet**: `Owner(s)` column is free text, not clean CSV (`"Olivia, Aviv, Lee + other people"`, inconsistent spacing/trailing junk). Some rows intentionally have no owner (one-off travel/restaurant charges — sheet's own instructions say these rarely need one). `Card(s) seen` and `Typical amount` can hold multiple values (`"4154, 9037"`, `"varies (570-3,204)"`). `Statement descriptor` holds multiple aliases separated by `|`.

Decisions made this session: best-effort parse the messy Owner(s) column with a manual-review flag for anything that doesn't yield clean names (rather than requiring a sheet cleanup pass first); Rachel runs as a **separate entry point** in the same `financeproject` repo (its own poll loop, not merged into the existing email-intake `index.js`, since intake polls every few minutes but chase cadence is measured in hours); **how the statement file reaches Rachel is explicitly undecided** — do not build a specific ingestion path (neither a Drive-folder watch nor an email-based one) until that's settled. The normalizer is designed as a pure function that takes already-extracted file content in and returns flat rows out, so it's ready to plug into whichever ingestion method gets picked later.

## Architecture

New entry point `rachel.js` alongside the existing `index.js`, sharing the existing `src/googleAuth.js` singleton and following the same style as `src/sheets.js` (pure builder functions separate from I/O, promise-queue for concurrent Sheets writes). New modules under `src/rachel/`:

```
rachel.js                          — poll loop entry point (separate from index.js)
  └─ src/rachel/normalizer.js      — Stage 0: raw statement text/rows → flat transaction rows
  └─ src/rachel/ownership.js       — loads + best-effort-parses Vendor Ownership sheet
  └─ src/rachel/matcher.js         — Stage 1: match statement rows ↔ Master DB receipt rows
  └─ src/rachel/resolver.js        — Stage 2: rank who to nudge per unmatched charge
  └─ src/rachel/ledger.js          — learning ledger: read/write resolution history to a Sheet tab
  └─ src/rachel/chase.js           — Stage 3: cadence state machine + Slack message sending
  └─ src/sheets.js (extended)      — add ledger + chase-state read/write helpers
```

### Stage 0 — Normalizer (`src/rachel/normalizer.js`)

Pure function `normalizeStatement(rawSections)` → `TransactionRow[]`, where each row is:
```
{ card, txnDate, billingDate, merchant, amount, currency, amountIls, reference, type, recurring, refund }
```

Logic, keyed off section headers actually observed in the real file:
- Section `פירוט עבור הכרטיסים בארץ` (domestic detail): `amount` = `סכום קנייה`, `currency` = `ILS` (fixed), `amountIls` = `סכום חיוב בש''ח`. `recurring` = true iff `תאור סוג עסקת אשראי` contains `הוראת קבע`. `refund` = true iff amount is negative (strip the literal `-` prefix, parse sign).
- Section `פירוט עבור הכרטיסים בחו''ל` (overseas, ILS-converted block): `amount`/`currency` = the row's own `מטבע מקורי` + amount column (already ILS in the sample, but read the currency column rather than assuming). `merchant`: strip the city/location prefix before `~`.
- Section `פירוט עבור הכרטיסים בחו''ל בדולר` (overseas, by-original-currency block): `amount` = `סכום קנייה`, `currency` = `מטבע`, `amountIls` = the converted-amount column present in that section (note: despite the section name being "בדולר", the observed converted column isn't always USD — e.g. BRL/JPY/HKD rows appear with their own converted figure; treat that column as "amountConverted" generically, not hardcoded USD).
- Skip summary/header sections entirely (previous-charges, domestic-summary, overseas-summary) — they're recap totals, not transaction rows.
- `reference` = the אסמכתא column verbatim, but the matcher (Stage 1) must never treat it as a dedup or invoice-number key (confirmed unreliable — values like `0`, `1001` repeat across unrelated vendors).

Input format decision deferred (see Open decisions): write `normalizeStatement` to accept an already-parsed 2D array of the sheet (rows × columns) rather than assuming a specific fetch path — keeps ingestion pluggable.

### Stage 1 — Matching (`src/rachel/matcher.js`)

For each Master-DB row where `Paid by = Organization` and `Status = Pending`, find candidate statement rows:
- Card last-4 matches `Credit card` column (note: Master DB's `Credit card`/`Cardholder` columns are currently always blank per the existing `buildReceiptRow` — Stage 1 needs these populated; either backfill from the receipt's payment metadata if Claude can extract it, or match on amount+date+merchant alone without the card filter, treating card-match as a *scoring boost* rather than a hard requirement. Flag this as a decision needed before Stage 1 is fully wired — the doc assumed card would be present but current intake doesn't populate it).
- Amount: exact match in same currency; +25% tolerance band for `expense_type` in `{Team lunch/Dinner, Taxi/Train/Bus}` (tip variance); cross-currency amounts go to `review`, never auto-matched.
- Date: statement `billingDate` within [-1, +3] days of the receipt's `Date`.
- Merchant: fuzzy match (Levenshtein-based or similar, threshold ≥0.8) between statement `merchant` (post city-strip) and Master DB `Provider`, OR exact match against any `|`-separated alias in the Vendor Ownership sheet's `Statement descriptor` for that vendor.
- Exactly one candidate passes all four → `Reconciled`. Zero or ambiguous (>1 candidate) → `review`/`ambiguous`, surfaced for manual look rather than guessed.
- Negative-amount statement rows are refunds: exclude entirely from "missing receipt" logic (never generate a chase for a refund).

**Multi-owner clustering**: group statement rows by `(card, merchant-normalized, amount-or-amount-bucket, billing period)`. Compare cluster size to count of matched Master DB rows in the same cluster. If cluster size > matched count, the delta is "missing" — chase for that many. If all cluster amounts are identical, the chase targets the *owner set* (ambiguous which specific person); if amounts differ per owner (e.g. LinkedIn Recruiter vs Sales Navigator), match specific amount deltas to the specific owner from the Vendor Ownership sheet's per-product notes.

### Stage 2 — Ownership resolution (`src/rachel/resolver.js` + `src/rachel/ledger.js`)

`resolveOwner(vendor, card, cluster)` ranks candidates in this order, stopping at the first non-empty result:
1. Vendor→owner map (from `ownership.js`'s parsed Vendor Ownership sheet).
2. Learned vendor history — read the ledger tab for prior successful resolutions for this exact vendor.
3. Learned card history, recency-weighted — prior resolutions for this card, weighted toward more recent entries (handles access churn: someone stops using a card, a new person starts).
4. Cold start — the 9 Potential Owners list from the doc §4 (Roee, Ron, Elad, Lee, Marco, Diana, Richard, Aviv, Nadav).

Every resolution (whether a receipt eventually gets matched to a person, or a chase gets a confirmed response) writes a row to a new Sheet tab, e.g. `Rachel Ledger`: `vendor, card, resolved_owner, resolved_at, resolution_source (vendor_map|vendor_history|card_history|cold_start), confirmed (bool)`. This is the self-maintaining piece — no manual card-access list needed.

**Ownership sheet parsing** (`src/rachel/ownership.js`): split `Owner(s)` on commas, trim each fragment, drop fragments that don't look like a name (e.g. `"+ other people"`, empty strings) via a simple heuristic (fragment contains only letters/spaces, length ≥2, not a known filler phrase). Rows where this yields zero clean names get collected into a `needsReview` list returned alongside the parsed map — surfaced in Rachel's own log/report rather than silently dropped or guessed.

### Stage 3 — Chase cadence (`src/rachel/chase.js`)

State machine per unmatched-charge-cluster, persisted in a Sheet tab (e.g. `Rachel Chase State`): `cluster_id, vendor, amount, stage (1-4), stage_entered_at, last_nudge_at, resolved (bool)`.

Cadence (hours, tunable via env var or a config object — doc gives concrete defaults):
- Stage 1 — likely owner (from resolver): nudge at T+0 and T+24h if still unresolved.
- Stage 2 — Potential Owners list: T+48h, T+72h.
- Stage 3 — Managers list (Roee, Ron, Elad, Lee, Marco, Diana, Aviad, Aviv, Olivia, Rafael, Bruni, Gal): T+96h, T+120h.
- Stage 4 — Roee+Yulia: T+144h, then stop (no further auto-escalation).

Each tick of `rachel.js`'s poll loop: re-run matching (a previously-missing receipt may have since landed via the intake service) — if now matched, mark `resolved = true` and stop chasing (doc: "found receipt re-enters intake" — this is just re-running Stage 1 each cycle, no special re-entry code needed). Otherwise, check if current time has crossed the next nudge threshold for the cluster's stage; if so, send the Slack message and advance/repeat within the stage per the cadence table; if the current stage's last nudge has passed, advance to the next stage.

Slack sending: reuse the existing Monica pattern (native `fetch` to Slack's Web API, no SDK) — new small helper, not a dependency on Monica's actual Slack client code (separate repo, separate bot token — Finance needs its own Slack app/bot token, same reasoning as the separate Google service account decision made earlier).

## Key files to create

- `rachel.js` — poll loop entry point, `--once` flag for local testing (mirrors `index.js`'s existing pattern).
- `src/rachel/normalizer.js` — pure function, Stage 0 logic above.
- `src/rachel/ownership.js` — load + best-effort parse Vendor Ownership sheet, return `{ map, needsReview }`.
- `src/rachel/matcher.js` — Stage 1 matching + clustering logic.
- `src/rachel/resolver.js` — Stage 2 ranking logic.
- `src/rachel/ledger.js` — read/write the Rachel Ledger tab.
- `src/rachel/chase.js` — Stage 3 state machine + Slack nudge sending.
- `src/sheets.js` — extend with generic tab read/write helpers reusable by ledger.js and chase.js (currently hardcoded to `Master DB` only).
- `tests/normalizer.test.js` — unit tests against fixture rows drawn from the real statement sections read this session (refund detection, recurring flag, city-prefix stripping, currency-column selection per section).
- `tests/matcher.test.js` — unit tests for the matching rules (tolerance band, date window, ambiguous-candidate handling, multi-owner clustering).
- `tests/ownership.test.js` — unit tests for messy Owner(s) parsing against the real rows read this session (e.g. the LinkedIn row's `"Olivia, Aviv, Lee + other people"`).

## Open decisions (not resolved yet)

1. **Statement ingestion path** — explicitly deferred. Normalizer is built input-agnostic; a follow-up decision is needed on Drive-folder-watch vs email-forward vs something else before Rachel can run unattended.
2. **Card/Cardholder columns are blank in Master DB** — current intake service never populates them (not derivable from a receipt alone). Stage 1's card-match rule needs either a backfill mechanism or to become a soft signal rather than a hard filter. Decision needed before wiring matching for real.
3. **Slack app/bot token for Finance** — doesn't exist yet; needs creating in Slack admin, separate from Monica's bot, before Stage 3 can send anything.

## Verification

- `npm test` — new normalizer/matcher/ownership unit tests, run against fixtures drawn from the real files read this session (not synthetic data), so passing tests are directly evidence against Truvid's actual statement/ownership format.
- Manual: once ingestion path is decided, run `node rachel.js --once` against a real statement + the current (small, 3-row) Master DB, inspect console output for match/review/missing classification before wiring any real Slack sends.
- Stage 3 dry-run: add a `--dry-run` flag that logs intended Slack messages instead of sending, so cadence logic can be verified over several simulated ticks before real nudges go out to real people.
