// ── OLIVE STAGE 0: STATEMENT NORMALIZER ─────────────────────────────────────
// Pure function: an already-parsed 2D array (rows × columns) of the statement
// sheet in, flat TransactionRow objects out. No I/O in this module — the
// statement ingestion path is deliberately undecided (design doc "Open
// decisions" #1), so whichever fetch method gets picked later just hands the
// parsed grid to normalizeStatement().
//
// TransactionRow shape:
//   { card, txnDate, billingDate, merchant, amount, currency, amountIls,
//     reference, type, recurring, refund }

// Quote characters vary between exports (ASCII ' / " vs typographic ’ ” vs
// Hebrew gershayim ״), so section headers are compared with all quote-like
// characters stripped from both sides.
const stripQuotes = (s) => String(s ?? "").replace(/['"’”״]/g, "");

// Section headers as observed in the real Bank Hapoalim-style export.
// Order matters: the by-original-currency header contains the plain overseas
// header as a substring, so it must be tested first.
const SECTIONS = [
  { key: "overseasByCurrency", header: stripQuotes("פירוט עבור הכרטיסים בחו''ל בדולר") },
  { key: "overseasIls",        header: stripQuotes("פירוט עבור הכרטיסים בחו''ל") },
  { key: "domestic",           header: "פירוט עבור הכרטיסים בארץ" },
];

const RECURRING_MARKER = "הוראת קבע"; // literal "standing order" flag

// Detail rows always lead with the card's last 4 digits.
const isCardCell = (s) => /^\d{4}$/.test(s);

function cellStr(v) {
  const s = String(v ?? "").trim();
  return s === "" ? null : s;
}

// Amounts arrive as strings with thousands separators, and refunds are
// printed with a literal escaped minus (`\-150.00`) — strip separators and
// backslashes, keep the sign.
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[\\,\s]/g, "");
  if (s === "") return null;
  const n = Number(s);
  return Number.isNaN(n) ? null : n;
}

// Overseas descriptors embed a city/location prefix before `~`
// (e.g. "SAN FRANCISCO~ANTHROPIC: CLAUDE TEA") — strip everything up to and
// including the tilde so the merchant is clean for Stage 1 fuzzy matching.
function stripCityPrefix(merchant) {
  const s = String(merchant ?? "");
  const i = s.indexOf("~");
  return cellStr(i >= 0 ? s.slice(i + 1) : s);
}

// The export sometimes prints the minus on only one of a row's two amount
// columns (observed: purchase amount positive, ILS charge `\-150.00`). A
// refund is a refund — propagate the sign to both so downstream stages can
// rely on `amount < 0` ⇔ `refund === true`.
function applyRefundSign(amount, amountIls) {
  const refund = (amount ?? 0) < 0 || (amountIls ?? 0) < 0;
  if (refund) {
    if (amount !== null) amount = -Math.abs(amount);
    if (amountIls !== null) amountIls = -Math.abs(amountIls);
  }
  return { amount, amountIls, refund };
}

// ── Per-section row parsers ──────────────────────────────────────────────────
// Column layouts observed in the real file; which column holds the "original
// currency amount" shifts per section, hence one parser each.

// Domestic detail — columns:
// card, dueDate, txnDate, merchant, סכום קנייה, סכום חיוב בש''ח, אסמכתא,
// discountAmt, discountPct, indexationDesc, indexOrRate, indexAtCharge,
// תאור סוג עסקת אשראי
function parseDomesticRow(c) {
  const type = cellStr(c[12]);
  const { amount, amountIls, refund } = applyRefundSign(
    parseAmount(c[4]),
    parseAmount(c[5])
  );
  return {
    card: cellStr(c[0]),
    txnDate: cellStr(c[2]),
    billingDate: cellStr(c[1]),
    merchant: cellStr(c[3]),
    amount,
    currency: "ILS", // fixed for the domestic section
    amountIls,
    reference: cellStr(c[6]), // verbatim; NEVER a dedup/invoice key (values like "0"/"1001" repeat)
    type,
    recurring: type !== null && type.includes(RECURRING_MARKER),
    refund,
  };
}

// Overseas, ILS-converted block — columns:
// card, dueDate, txnDate, merchant-with-city-prefix, amountILS,
// amountOriginal, currency, reference
// Read the currency column rather than assuming ILS, per the design doc.
function parseOverseasIlsRow(c) {
  const { amount, amountIls, refund } = applyRefundSign(
    parseAmount(c[5]),
    parseAmount(c[4])
  );
  return {
    card: cellStr(c[0]),
    txnDate: cellStr(c[2]),
    billingDate: cellStr(c[1]),
    merchant: stripCityPrefix(c[3]),
    amount,
    currency: cellStr(c[6]),
    amountIls,
    reference: cellStr(c[7]),
    type: null, // no transaction-type column in this section
    recurring: false,
    refund,
  };
}

// Overseas, by-original-currency block — columns:
// card, dueDate, txnDate, merchant-with-city-prefix, amountOriginal, currency,
// amountConverted, notes
// NOTE: despite the section name being "בדולר", the converted column is a
// generic converted figure (BRL/JPY rows carry their own conversion), not
// hardcoded USD. Per the design doc it is still surfaced as `amountIls` to
// keep one flat row shape — Stage 1 must treat it as "converted amount", and
// must send cross-currency amounts to review rather than auto-matching.
function parseOverseasByCurrencyRow(c) {
  const { amount, amountIls, refund } = applyRefundSign(
    parseAmount(c[4]),
    parseAmount(c[6])
  );
  return {
    card: cellStr(c[0]),
    txnDate: cellStr(c[2]),
    billingDate: cellStr(c[1]),
    merchant: stripCityPrefix(c[3]),
    amount,
    currency: cellStr(c[5]),
    amountIls,
    reference: null, // this section carries a notes column, not an אסמכתא
    type: null,
    recurring: false,
    refund,
  };
}

const PARSERS = {
  domestic: parseDomesticRow,
  overseasIls: parseOverseasIlsRow,
  overseasByCurrency: parseOverseasByCurrencyRow,
};

// Returns a section key when the row is a known detail-section title, `null`
// when it's some other section title (summary/recap — enter skip mode), or
// `undefined` when it isn't a section title at all (e.g. a column-header row).
function detectSection(cells) {
  const nonEmpty = cells.map((c) => String(c ?? "").trim()).filter((c) => c !== "");
  const joined = stripQuotes(nonEmpty.join(" "));
  for (const { key, header } of SECTIONS) {
    if (joined.includes(header)) return key;
  }
  // The account-number metadata row ("מספר חשבון 12-174-232330 תאריך הפקה...")
  // appears after every section header as a single cell. It is not a section
  // boundary — skip it without resetting the current section.
  if (nonEmpty.length === 1 && nonEmpty[0].includes("מספר חשבון")) return undefined;
  // Heuristic for "some other section is starting" (previous-charges recap,
  // domestic/overseas summaries): section titles in the export occupy a
  // single cell, whereas column-header rows have several populated cells.
  // A single-cell unrecognised title therefore resets to skip mode so any
  // card-led recap rows underneath it are not mistaken for transactions.
  if (nonEmpty.length === 1) return null;
  return undefined;
}

export function normalizeStatement(rawSections) {
  const out = [];
  let section = null; // null ⇒ summary/unknown section: rows are skipped

  for (const row of rawSections || []) {
    const cells = Array.isArray(row) ? row : [row];
    const first = String(cells[0] ?? "").trim();

    if (isCardCell(first)) {
      // Card-led rows are transactions only inside a known detail section;
      // summary sections also lead with card numbers but are recap totals.
      if (section) out.push(PARSERS[section](cells));
      continue;
    }

    const detected = detectSection(cells);
    if (detected !== undefined) section = detected;
    // `undefined` ⇒ column-header/noise row: skip without leaving the section.
  }

  return out;
}
