# Rambo — Ron Briefing
**Meeting:** 2026-07-08 | **Prepared by:** Lee

---

## What Rambo Is

Rambo is Truvid's internal finance automation bot. It does two things:

1. **Receipt intake** — anyone (employees, Yulia) can upload a receipt to Slack or email it to finance@truvid.com and it lands as a structured row in the Master DB Google Sheet automatically. Claude reads the document and extracts the data.

2. **Statement reconciliation + chase** — Yulia uploads the monthly bank statement to a Slack channel. Rambo cross-references it against the Master DB and automatically DMs anyone with an unmatched charge, following up until the receipt is submitted or escalation is triggered.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 18+ (ES modules) |
| Hosting | Railway (4 processes running in parallel) |
| AI | Claude (Anthropic API) — receipt data extraction |
| Messaging | Slack Bot API — DMs, modals, file uploads |
| Storage | Google Sheets — Master DB, chase state, error log |
| File archive | Google Drive — every receipt stored as original file |
| Email intake | Gmail API — watches finance@truvid.com |
| Statement parsing | ExcelJS — reads Yulia's Bank Hapoalim export |
| Tests | Vitest |

**4 processes run in parallel on Railway:**
- `index.js` — Gmail intake (polls every few minutes)
- `slackIntake.js` — Slack receipt intake + statement upload handler + HTTP server for Slack interactions
- `statementRambo.js` — follow-up nudge cycle (polls hourly)
- `rambo.js` — cluster-based reconciliation (hourly, for the long-running chase state machine)

---

## How a Receipt Gets In (Slack path)

1. Employee uploads a file to the receipt intake Slack channel
2. Claude extracts: provider, date, amount, currency, expense type, receipt #, paid by
3. Bot posts a "Fill in details" button as a thread reply
4. Employee clicks → pre-filled modal opens → reviews/corrects → confirms
5. Row written to Master DB with status **Pending**

**Email path:** Same extraction, no modal — row written directly.

---

## How Statement Reconciliation Works

1. Yulia uploads the Bank Hapoalim Excel to the `#statements` Slack channel
2. Rambo parses it (tested: 141 rows parsed correctly from a real Hapoalim export)
3. Cross-references against every row in Master DB
4. For each unmatched charge: DM sent to the likely owner, grouped by vendor with individual amounts
5. Owner drops their receipt right in the DM thread → Rambo reads it, matches it, writes to Master DB as **Matched**

**Nudge cadence (per unmatched charge):**
| Time | Action |
|---|---|
| T+0 | Stage 1 DM to likely owner |
| T+24h | Stage 2 follow-up DM to same person |
| T+48h | Stage 3: final personal DM + company-wide blast + Yulia DM + colored statement posted back to channel |

**Full arc tested 2026-07-07** — all 3 stages fired correctly in the test environment.

---

## Security Gatekeepers

### 1. Slack Signing Secret — all interactions verified
Every POST from Slack to our Railway endpoint is cryptographically verified using the Slack signing secret. Missing secret = process refuses to start.

### 2. @truvid.com email allowlist
Only Slack users with a `@truvid.com` email can submit receipts through the modal. Guest accounts or external collaborators see a "not authorized" modal instead.

### 3. Google Drive auth — isolated with impersonation
Drive operations impersonate the finance@ mailbox (same OAuth delegation pattern as Gmail). Service accounts have no Drive storage quota of their own — impersonation is required. Drive and Gmail each have their own auth singleton; Sheets has a third with no impersonation.

### 4. Gmail auth isolated from Sheets/Drive
Google auth is split into three singletons. Gmail and Drive impersonate finance@truvid.com. Sheets runs as the service account's own identity with no impersonation.

### 5. File size cap (10 MB)
Files larger than 10 MB are rejected before download. Prevents OOM crashes and runaway Claude API costs.

### 6. SSRF protection on file URLs
Before fetching any file from Slack, the URL is validated to be a `files.slack.com` domain. Prevents a crafted payload from tricking the bot into fetching internal Railway metadata endpoints.

### 7. Formula injection protection
AI-extracted values written to Google Sheets are sanitized — any value starting with `=`, `+`, `-`, or `@` gets a leading `'` so Sheets never evaluates it as a formula.

---

## Current Status

| Feature | Status |
|---|---|
| Gmail receipt intake | ✅ Live and processing |
| Slack receipt intake (modal flow) | ✅ Live |
| Statement parsing (Bank Hapoalim Excel) | ✅ Tested — 141 rows parsed correctly |
| Stage 1 DMs (grouped by vendor) | ✅ Tested end-to-end |
| Stage 2 follow-up nudge | ✅ Tested end-to-end |
| Stage 3 final DM + company blast + colored Excel | ✅ Tested end-to-end |
| @truvid.com allowlist | ✅ Live |
| All 7 security gatekeepers | ✅ Live |
| Anthropic API key rotation | ⏳ **Action for Ron** (see below) |

---

## Still To Decide / Build

### Needs a decision before go-live

**Vendor Ownership tab** — currently empty. Without it, Rambo can't tell who owns which charge and falls back to DMing the entire cold-start list (all 9 people). This tab maps vendor names to their usual owner/card. Yulia needs to populate it before the first real statement run, or owners won't be targeted correctly.

**`Rambo Ledger` tab** — currently missing from the Google Sheet. Rambo learns from confirmed receipt submissions and uses this to improve owner resolution over time. Needs to be created (headers: vendor, card, resolved_owner, resolved_at, resolution_source, confirmed).

**Receipt match feedback** — when someone drops a receipt in the DM thread, Rambo currently silently matches or fails. We need to add a reply: "✅ Matched to your JAPANIKA charge of 2,196 ILS" or "❌ This receipt doesn't match any of your open charges — still missing: [list]."

### Minor fixes queued

- **Amount display bug** — overseas ILS charges show `null` for the amount in DMs (the amount is stored in `amountIls` but the display reads `amount`). Small fix, not blocking.
- **Duplicate chase threads** — the test runs created multiple chase threads in the sheet for the same run. Need a one-time cleanup before go-live.

### Not built yet

- ENR fields (owner/recurring/monthly at intake) — deferred
- Duplicate prevention in Make — detection formula exists, prevention deferred

---

## Roadmap (from Ron meeting, 2026-07-08)

### 1. Credit card → charge association
Some statement rows carry a card last-4, some don't. Before owner resolution can be reliable, every charge needs a card number attached. Needs investigation into which statement sections omit it and how to backfill (possibly from the cluster or from the Vendor Ownership tab).

### 2. Proactive nudge before statement upload
If Lee submitted a Wolt receipt during July, Rambo should DM Lee near month-end: *"Hey, you submitted a Wolt receipt for $340 this month — do you have any other Wolt receipts to add before the statement closes?"* Two benefits: catches missing receipts early, and pre-associates Lee with Wolt so when Yulia uploads the statement, those charges auto-assign to Lee first instead of hitting cold-start. **Needs planning** — when does the nudge fire, what triggers it, how does the pre-association feed into the resolver?

### 3. "These aren't mine" rejection during nudge cycle
When someone receives a nudge DM listing charges, they should be able to reply "these aren't mine" (or similar) and Rambo stops chasing them for those specific charges. The charge shouldn't be dropped entirely — it should be re-routed (escalate to Yulia, or open for someone else to claim). **Needs planning** — what happens to a rejected charge, who sees it next?

### 4. Prompt optimization — reduce AI call volume
Claude is called once per receipt attachment. Some emails have 5–6 attachments; some attachments aren't receipts at all. Opportunities to reduce cost: pre-filter by file type/size before sending to Claude, batch multiple attachments from the same email into one call, cache results for identical files. **Needs scoping.**

### 5. Failed receipt handling with confirmation flow
When a receipt can't be parsed (blurry photo, out-of-focus, wrong language), Rambo should reply to the submitter: *"I couldn't read this receipt — can you confirm: provider, amount, date?"* and record from their reply. **Slack only** (email path doesn't have a clean reply channel). Currently Rambo logs to an error sheet but doesn't notify the person.

### 6. Travels — separate branch, big build
Group travel expense tracking. Example: 4 employees at DMEXCO for several days — flights, hotels, meals all need to be captured and attributed. This is a distinct enough feature to live on its own branch (`travels.js` placeholder already exists). Needs its own planning session before any build starts.

---

## Action for Ron

The Anthropic API key needs to be rotated. The current key (`sk-ant-api03-...`) was read in a Claude Code session and should be treated as potentially exposed.

**Steps:**
1. Go to console.anthropic.com → API Keys
2. Create a new key
3. Update `ANTHROPIC_API_KEY` in Railway environment variables
4. Delete the old key

This is the only outstanding item that requires Ron's access.

---

## Go-Live Checklist

- [ ] Ron rotates Anthropic API key
- [ ] Yulia populates the Vendor Ownership tab
- [ ] Create `Rambo Ledger` tab in the Google Sheet
- [ ] Fix amount display bug (overseas ILS charges showing `null`)
- [ ] Add receipt match feedback in DM thread
- [ ] Clean up test chase threads from the sheet
- [ ] Set `SLACK_COMPANY_CHANNEL` to the real company channel
- [ ] Remove `STATEMENT_DRY_RUN`, `STATEMENT_NUDGE_INTERVAL_MINUTES`, `STATEMENT_RAMBO_POLL_MINUTES` test overrides from Railway
- [ ] Run one real statement upload with Yulia present
