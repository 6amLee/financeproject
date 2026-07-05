# Truvid Receipt System — Master Build Doc

**Project:** Automated receipt intake \+ credit-card reconciliation ("The Rachel") **Owner:** Lee (Head of People) · **Finance:** Yulia · **Escalation:** Roee · **API/billing:** Ron **Last updated:** end of the Make-intake build session (intake working; dedup \+ Claude body mid-fix)

---

## 1\. What this is

Two connected systems:

- **Intake** — a receipt/invoice arrives by email, gets read automatically by Claude, and lands as one structured row in a Google Sheet (the master DB). Files are archived in Google Drive.  
- **The Rachel** — a scheduled bot (not built yet) that will check the company credit-card statement against the master DB every 24h and chase missing receipts over Slack.

Refundly is **not** integrated — it only defined the column set. The Google Sheet is the single source of truth.

One-liner: *Email → Claude reads it → row in the Master DB. Later, The Rachel checks the statement against the DB daily and chases the gaps.*

---

## 2\. Architecture — what is what

| Component | Type | Role | Status |
| :---- | :---- | :---- | :---- |
| [finance@truvid.com](mailto:finance@truvid.com) | Channel (Google Group) | Email front door; lee@ receives copies | ✅ live |
| Make scenario | Automation host | Orchestrates the intake flow | ✅ working |
| Gemini | (was considered) | Dropped — using Claude only | n/a |
| Anthropic Claude (Haiku) | AI brain | Reads the receipt → structured JSON | ⚠️ body fix in progress |
| Google Drive | Data | Raw receipt files | ✅ live |
| Master DB (Google Sheet) | Data | One row per receipt, source of truth | ✅ live |
| Vendor Ownership sheet | Data | vendor → owner map (founders filling) | ✅ sent to founders |
| Statement normalizer | Script | Flattens Yulia's Hebrew statement | ✅ built/prototyped |
| The Rachel | Bot (scheduled) | Matching \+ Slack chase | ⬜ not built |

**Skills vs bots vs brains:** The Rachel is a **bot** (runs on a 24h trigger); Claude is a **brain** (logic, invoked by the bot); the Sheet is **data**. Make is the automation host that ties them together.

---

## 3\. Current status

**✅ Working**

- Email intake end to end: finance@ → Make grabs it → attachment saved to Drive → Claude reads it → row written to Master DB.  
- **Multiple PDFs in one email** → multiple rows (confirmed with Ron's 3 Anthropic receipts).  
- **is\_receipt gate** — junk that isn't a receipt is dropped before the Sheet.  
- **Duplicate detection** via a sheet formula (see §8).

**⚠️ Mid-fix**

- The `data` field in the Claude API body (base64 of the PDF) keeps breaking on `{{toBase64(...)}}` syntax. See §7 for the two fix paths — the **Set Variable** method is the recommended escape.  
- `receipt_no` currently sometimes captures the **file name** instead of the number inside the PDF. Prompt updated to fix; needs a clean run to confirm.

**⬜ Not built yet**

- Duplicate *prevention* in Make (only detection exists).  
- Branch B — body-only e-receipts (LinkedIn/SaaS emails with no attachment).  
- The Rachel (matching \+ Slack chase).  
- ENR fields (owner / recurring / monthly-yearly at intake) — deliberately deferred.

---

## 4\. The data assets

### Master DB (Google Sheet) — one row per receipt

Columns (form order \+ ops): `Captured at · Source · Expense type* · Date* · Currency* · Amount* · Paid by* · Credit card* (if Organization) · Cardholder · Provider · Receipt No.* · Comments · Invoice link* · Status · Matched Amex txn` \+ hidden **Dup Check** column.

- `Paid by` ∈ {Employee, Organization}. **Only Organization rows get reconciled** by The Rachel. Employee \= reimbursement list for Yulia.  
- `Status` ∈ {Pending, Reconciled, Missing receipt, Reimburse (employee)}. New rows start **Pending**.  
- Expense type dropdown (14): Advertising, Business meetings, Company event, Computer maintenance, Gas, Gifts for Employees, Gifts for partners, Office equipment, Other, Parking, Professional services, Refreshments / Snacks, Taxi/Train/Bus, Team lunch/ Dinner.

### Company cards (14)

`4154 ILS/$/€ Amex Roee` · `9037 ILS/$/€ Amex Ron` · `4287 ILS/$ Amex` · `5438 ILS/$/€ Visa Roee` · `0375 ILS/$/€ Visa Ron`

### Vendor Ownership sheet (seeded from the real statement)

64 real vendors, recurring/SaaS sorted to top. Founders fill the **Owner(s)** column. Multi-owner supported (LinkedIn \= 3 products at 3 amounts on 2 cards). Escalation lists live in the same workbook.

### Escalation lists (for The Rachel's chase)

- **Stage 2 — Potential Owners (9):** Roee, Ron, Elad, Lee, Marco, Diana, Richard, Aviv, Nadav  
- **Stage 3 — Managers (12):** Roee, Ron, Elad, Lee, Marco, Diana, Aviad, Aviv, Olivia, Rafael, Bruni, Gal

---

## 5\. The Make scenario — module by module

Flow (left to right):

`Watch emails (2) → Router (7) → [Has attachment] → List attachments (21) → Drive Upload (22) → Anthropic Claude (25) → Parse JSON (28) → [is_receipt gate] → Add a Row (29)`

| \# | Module | Key settings |
| :---- | :---- | :---- |
| 2 | **Gmail – Watch emails** | Connection: [lee@truvid.com](mailto:lee@truvid.com) · **Folder \= All Mail** · **Label \= Finance Stuff** · Criteria \= All emails · Include \= Attachments, Media |
| 7 | **Router** | Route "Has attachment" \= filter `Has attachment` **Exists**. Second route \= fallback (Branch B — not built yet) |
| 21 | **Gmail – List email attachments and media** | Message ID ← Watch emails · Include \= Attachments, Media |
| 22 | **Google Drive – Upload a File** | Folder ID (manual): `1WLrMvSqBjOPZNJgZcXF-D16Q00UN7nFO` · File Name ← 21 Filename · Data ← 21 Data |
| 25 | **Anthropic Claude – Make an API Call** | URL `/v1/messages` · POST · headers `anthropic-version: 2023-06-01`, `content-type: application/json` · Body in §7 |
| — | **is\_receipt gate** | Filter between Claude/Parse JSON: `is_receipt` \= true |
| 28 | **JSON – Parse JSON** | JSON string \= mapped `text` from Claude Body → content → text (fence-strip no longer needed once prompt forces raw JSON) |
| 29 | **Google Sheets – Add a Row** | Master DB · maps Parse JSON fields → columns · Invoice link ← Drive 22 Web View/Content Link · Source \= Email · Status \= Pending |

**Scheduling:** turn **OFF** when not testing (no spend cap confirmed yet). Turn on only once Ron confirms a spend cap.

---

## 6\. Connections & credentials

- **Gmail** — [lee@truvid.com](mailto:lee@truvid.com) (receives finance@ group copies)  
- **Google Drive** — "Receipts to my Google Drive"  
- **Google Sheets** — Master DB  
- **Anthropic** — API key from Ron (Thursday). Model: `claude-haiku-4-5`.  
- ⬜ **TODO: confirm spend cap** with Ron (\~$20/mo) before leaving scheduling on.

---

## 7\. The Claude extraction — prompt, body, and the blocker

### The clean API body (paste into module 25 Body)

```json
{
  "model": "claude-haiku-4-5",
  "max_tokens": 1024,
  "messages": [
    {
      "role": "user",
      "content": [
        {
          "type": "document",
          "source": {
            "type": "base64",
            "media_type": "application/pdf",
            "data": "DATA_GOES_HERE"
          }
        },
        {
          "type": "text",
          "text": "You are a receipt data extractor for Truvids finance system. Output ONLY a raw JSON object starting with a left brace and ending with a right brace. Never use code fences and never write the word json. Keys required: is_receipt, provider, date, amount, currency, receipt_no, expense_type, suggested_paid_by, notes. is_receipt is true only if this is a real receipt or invoice with an amount, else false. provider is the cleaned merchant name. currency is ILS or USD or EUR or null. amount is the final total including tax, digits with a dot decimal, no symbols. date is YYYY-MM-DD or null. receipt_no is the receipt or invoice number printed inside the document copied exactly, never the file name. expense_type is one of Advertising, Business meetings, Company event, Computer maintenance, Gas, Gifts for Employees, Gifts for partners, Office equipment, Other, Parking, Professional services, Refreshments / Snacks, Taxi/Train/Bus, Team lunch/ Dinner. suggested_paid_by is Organization or Employee or Unknown. notes is a short summary or null. If a field is missing use null. Never invent values."
        }
      ]
    }
  ]
}
```

### THE BLOCKER: the `data` field (base64 of the PDF)

The file bytes come from **module 21 (List attachments) → Data** and must be base64-encoded. Typing `{{toBase64(...)}}` in the body keeps breaking because:

- Clicking the Data **chip** inserts `{{21.data}}` (its own braces) → nesting → `{{toBase64({{21.data}})}}` → **"Invalid IML."**  
- Missing capital B, missing `)`, or nested braces all produce errors.

**Fix path A (inline, fragile):** the value must read EXACTLY, as pure typed text, no chip:

```
{{toBase64(21.data)}}
```

One outer `{{ }}`, capital B, `21.data` bare inside. No colored chip.

**Fix path B (RECOMMENDED — ends the problem):** move base64 out of the body.

1. Add **Tools → Set variable** module between Drive (22) and Claude (25).  
2. Variable name: `pdf_b64` · Value: type `toBase64(`, click the **21 → Data** chip, type `)`. (Clean field, no JSON, no quote conflict.)  
3. In the Claude body, set `"data": "{{pdf_b64}}"` — a plain variable reference, no function in the body.

### Testing rule (bit us repeatedly)

**Always test with a full "Run once" on a FRESH email — never "Run this module only."** Module-only runs feed stale/empty data to the file modules and cause false "invalid base64" / "control character" errors. A full run delivers a real PDF.

---

## 8\. Duplicates

**Detection (built) — sheet formula.** In the Master DB, column **Dup Check** (P), per-row:

```
=IF(K2="","",IF(COUNTIF($K$2:$K,K2)>1,"DUPLICATE",""))
```

(K \= Receipt No. column.) Flags any repeated receipt number. Yulia/Lee filter for "DUPLICATE" weekly and delete redundant copies.

**Dedup key lesson:** must be **Receipt No.**, NOT Provider+Amount — three monthly Anthropic receipts are all $200/9037/"Max plan 20x" and differ ONLY by receipt number \+ date. Amount-based dedup would wrongly kill legit recurring receipts.

**Prevention (deferred):** Search Rows → count filter (only add if 0 existing). Canvas threading was too fiddly to finish; revisit fresh. Detection formula covers the gap meanwhile.

---

## 9\. Hard-won gotchas (read before resuming)

1. **Trigger "no new data":** Watch emails only grabs mail newer than the last seen. Every test needs a FRESH email \+ **Choose where to start → From now on**. Re-running on an old email \= nothing.  
2. **Group inbox:** finance@ is a Google Group; its mail skips the Inbox. Watching **Folder \= All Mail \+ Label \= Finance Stuff** is what finally worked. (A Gmail filter labels the incoming mail; do NOT rely on Inbox.)  
3. **Run once vs Run this module only:** always full Run once for file-dependent modules.  
4. **Code fences:** Claude sometimes wraps JSON in ```` ```json ````. Prompt now forces raw JSON (start `{`, end `}`, no fences). Keep an eye out; a fence-strip in Parse JSON is the backup.  
5. **receipt\_no \= filename:** Claude was grabbing the PDF filename. Prompt fixed to copy the number printed inside the doc.  
6. **Make expressions:** never hand-type `{{...}}` references — but the `toBase64` case is the exception where the chip causes nesting; use the Set Variable escape (§7 path B).  
7. **Multiple attachments:** already handled natively — List attachments emits one bundle per file, so N files → N rows. No extra build.

---

## 10\. The Rachel (matching \+ chase) — spec summary (not built)

**Stage 0 — statement normalizer (✅ prototyped).** Yulia's export is a stable 4-section Hebrew report (domestic / overseas-ILS / overseas-USD / overseas-EUR \+ summary). A script flattens it to: card · txn\_date · billing\_date · merchant · amount · currency · amount\_ils · reference · type · recurring · refund. Format confirmed stable.

**Matching (Organization rows only).** Per statement line, auto-reconcile when ALL: card last-4 matches · amount (exact same-currency; \+25% tolerance for tips on Team lunch/Taxi; cross-currency → review) · date within −1 to \+3 days · merchant fuzzy ≥ 0.8 or known alias · exactly one candidate. Else → review / ambiguous / missing.

**Multi-owner:** cluster by card+vendor+amount+period, reconcile by count (e.g. 3 LinkedIn charges, 2 receipts → 1 missing). Identical amounts → nudge the owner set; different amounts → target the specific owner.

**Ownership resolution (self-maintaining, no manual card-access list):** rank who to nudge — (1) vendor→owner map, (2) learned vendor history, (3) learned card history (recency-weighted), (4) cold-start \= the 9 Potential Owners. Every resolution writes to a learning ledger → next time targets the right person. Recency weighting handles access churn automatically.

**Chase cadence (hours tunable):** Stage 1 likely owner (T+0, \+24h) → Stage 2 Potential Owners (T+48h, \+72h) → Stage 3 Managers (T+96h, \+120h) → Stage 4 Roee+Yulia (T+144h, stop). Found receipt re-enters intake.

**Statement quirks found in real data:** reference (אסמכתא) ≠ invoice number · הוראת קבע flag \= recurring (free subscription detection) · negative lines \= refunds (skip, not "missing") · overseas: match on original amount+currency, not ILS.

---

## 11\. To-do (priority order)

1. **Finish the Claude body base64** — use Set Variable method (§7 path B). Then full fresh-email Run once.  
2. **Confirm Receipt No.** now captures the real number (not filename).  
3. **Confirm spend cap** with Ron → then leave scheduling ON.  
4. **Clean the Master DB** — delete test/duplicate rows.  
5. **Duplicate prevention** in Make (Search Rows \+ count filter) — revisit fresh.  
6. **Branch B** — body-only e-receipts (no attachment): Claude reads email body; Invoice link \= Gmail message link; later body→PDF→Drive.  
7. **Founders return** the Vendor Ownership sheet → build the ownership map.  
8. **Build The Rachel** — normalizer → matching → Slack chase (per §10).  
9. **ENR** (owner/recurring/monthly at intake) — later.

---

## 12\. How to resume (quick start)

1. Open the Make scenario; make sure scheduling is OFF until spend cap confirmed.  
2. Fix the Claude `data` field via Set Variable (§7B).  
3. Watch emails → Choose where to start → From now on.  
4. Forward a fresh PDF to finance@ → confirm it gets the **Finance Stuff** label.  
5. **Run once** (whole scenario). Check: Drive has the file · Claude returns clean JSON · a real row lands in the Master DB with the correct Receipt No.  
6. If any module errors, read the ORIGIN in the log and check §9 gotchas first.

