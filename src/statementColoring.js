// ── STATEMENT COLORING ────────────────────────────────────────────────────────
// Takes the original Excel buffer and a set of unmatched cluster keys, then
// returns a new buffer with charge rows colored:
//   red  (#FFC7CE) — still unmatched after all 3 nudge rounds
//   green (#C6EFCE) — all other card-led rows (matched or refund)
//
// Row identification: transaction rows always start with a 4-digit card number
// (the isCardCell invariant from normalizer.js). Each row is mapped to the
// cluster key format "card|normalizedMerchant|YYYY-MM" so we can compare
// against the unmatched set without re-running the full pipeline.

import ExcelJS from "exceljs";

const GREEN = { type: "pattern", pattern: "solid", fgColor: { argb: "FFC6EFCE" } };
const RED   = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFC7CE" } };

function normMerchant(s) {
  return String(s ?? "").toLowerCase().trim().replace(/\s+/g, " ");
}

function billingDateToPeriod(v) {
  const s = String(v ?? "").trim();
  const match = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!match) return null;
  const [, , m, y] = match;
  return `${y}-${String(m).padStart(2, "0")}`;
}

// Rebuild the cluster key for a raw Excel row so we can look it up in the
// unmatched set. Column layout mirrors normalizer.js parseDomesticRow / the
// overseas parsers — card is always col 0, billingDate col 1, merchant col 3.
function rowToClusterKey(cells) {
  const card    = String(cells[0] ?? "").trim();
  const period  = billingDateToPeriod(cells[1]) ?? "unknown";
  // Strip city prefix (overseas rows: "CITY~MERCHANT")
  const raw     = String(cells[3] ?? "");
  const tilde   = raw.indexOf("~");
  const merchant = normMerchant(tilde >= 0 ? raw.slice(tilde + 1) : raw);
  return `${card}|${merchant}|${period}`;
}

export async function colorStatementExcel({ base64Data, unmatchedKeys }) {
  const buffer   = Buffer.from(base64Data, "base64");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw new Error("No worksheet found for coloring");

  worksheet.eachRow({ includeEmpty: false }, (row) => {
    const cells = row.values.slice(1);
    const first = String(cells[0] ?? "").trim();
    if (!/^\d{4}$/.test(first)) return; // not a transaction row — skip

    const key   = rowToClusterKey(cells);
    const fill  = unmatchedKeys.has(key) ? RED : GREEN;

    row.eachCell({ includeEmpty: true }, (cell) => { cell.fill = fill; });
    row.commit();
  });

  const arrayBuffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}
