# Olive — Ron Briefing
**Meeting:** 2026-07-08 | **Prepared by:** Lee

---

## What Olive Is

Olive is Truvid's internal finance automation bot. It does two things:

1. **Receipt intake** — anyone (employees, Yulia) can upload a receipt to Slack or email it to finance@truvid.com and it lands as a structured row in the Master DB Google Sheet automatically. Claude reads the document and extracts the data.

2. **Statement reconciliation + chase** — Yulia uploads the monthly bank statement to a Slack channel. Olive cross-references it against the Master DB and automatically DMs anyone with an unmatched charge, following up until the receipt is submitted or escalation is triggered.

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
- `statementOlive.js` — follow-up nudge cycle (polls hourly)
- `travels.js` — trip registration, channel management, and nudge lifecycle for company travel

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
2. Olive parses it, cross-references against every row in Master DB
3. For each unmatched charge: DM sent to the likely owner with the charge details
4. Owner drops their receipt right in the DM thread → Olive reads it, matches it, writes to Master DB as **Matched**

**Nudge cadence (per unmatched charge):**
| Time | Action |
|---|---|
| T+0 | Stage 1 DM to likely owner |
| T+24h | Stage 2 follow-up DM to same person |
| T+48h | Stage 3: final personal DM + company-wide blast + Yulia DM + colored statement posted back to channel (red = still missing, green = matched) |

---

## Security Gatekeepers (built today, 2026-07-07)

### 1. Slack Signing Secret — all interactions verified
Every POST from Slack to our Railway endpoint is now cryptographically verified using the Slack signing secret. Before today, if the secret wasn't set the app silently accepted any request from anyone. Now: missing secret = process refuses to start.

### 2. @truvid.com email allowlist
Only Slack users with a `@truvid.com` email can submit receipts through the modal. The check happens at submission time via the Slack `users.info` API. Guest accounts, external collaborators, or anyone without a Truvid email sees a "not authorized" modal instead.

### 3. Google Drive scope restricted to `drive.file`
Previously the service account had full `drive` scope — read/write access to every file owned by any Truvid employee (via domain-wide delegation). Now it's `drive.file`: the account can only touch files it created itself. Blast radius reduced from "all company Drive files" to "receipts folder only."

### 4. Gmail auth isolated from Sheets/Drive
Google auth is now split into two singletons. Gmail (which needs to impersonate finance@truvid.com) uses its own auth object. Sheets and Drive use a separate one with no impersonation — they run as the service account's own identity. Sheets/Drive calls are no longer inadvertently made "as" the finance@ user.

### 5. File size cap (10 MB)
Files larger than 10 MB are rejected before download. Prevents OOM crashes and runaway Claude API costs from someone uploading a 500 MB video to the receipts channel.

### 6. SSRF protection on file URLs
Before fetching any file from Slack, the URL is validated to be a `files.slack.com` domain. Prevents a crafted payload from tricking the bot into fetching internal Railway metadata endpoints.

### 7. Formula injection protection
AI-extracted values written to Google Sheets are sanitized — any value starting with `=`, `+`, `-`, or `@` gets a leading `'` so Sheets never evaluates it as a formula. Protects against a receipt with `=IMPORTDATA(...)` as its merchant name exfiltrating sheet contents.

---

## Current Status

| Feature | Status |
|---|---|
| Gmail receipt intake | ✅ Live |
| Slack receipt intake (modal flow) | ✅ Live |
| Statement upload + Stage 1 DMs | ✅ Live |
| Follow-up nudge cycle (T+24h, T+48h) | ✅ Live |
| Colored statement posted after cycle | ✅ Live |
| Company-wide blast | ✅ Live (needs `SLACK_COMPANY_CHANNEL` env var set) |
| @truvid.com allowlist | ✅ Live today |
| Security hardening | ✅ Done today |
| Anthropic API key rotation | ⏳ **Action for Ron** (see below) |

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

## What's Not Built Yet

- `travels.js` — new feature, TBD
- ENR fields (owner/recurring/monthly at intake) — deferred
- Duplicate prevention in Make (detection formula exists, prevention deferred)
