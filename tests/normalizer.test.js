import { describe, it, expect } from "vitest";
import { normalizeStatement } from "../src/olive/normalizer.js";

// Fixture built from real rows in the actual Hebrew statement export read
// during the design session — real section titles, real Hebrew merchants,
// real escaped-minus refund formatting.
const statementFixture = [
  // ── Summary sections (recap totals — must produce zero output rows) ──
  ["פירוט חיובים קודמים"],
  ["כרטיס", "סכום חיוב"],
  ["9037", "22,411.36"],
  ["ריכוז עסקאות בארץ"],
  ["כרטיס", "סך קניות", "סך חיובים"],
  ["9037", "14,201.90", "14,201.90"],
  ["5438", "8,733.00", "8,733.00"],

  // ── Domestic detail ──
  ["פירוט עבור הכרטיסים בארץ"],
  ["כרטיס", "תאריך חיוב", "תאריך עסקה", "שם בית עסק", "סכום קנייה", "סכום חיוב בש''ח", "אסמכתא", "סכום הנחה", "אחוז הנחה", "תאור הצמדה", "מדד/שער", "מדד בחיוב", "תאור סוג עסקת אשראי"],
  ["9037", "02.06.2026", "27.05.2026", "פנגו חשבונית חודשית", "549.02", "549.02", "9409033", "", "", "ללא הצמדה", "", "", "הוראת קבע"],
  ["9037", "02.06.2026", "12.05.2026", "רשת פנאי וקהילה מתנ”", "150.00", "\\-150.00", "7001004", "", "", "ללא הצמדה", "", "", "עסקה רגילה"],
  ["5438", "15.06.2026", "10.06.2026", "פריוריטי סופטוור בע”", "8,733.00", "8,733.00", "7002114", "", "", "ללא הצמדה", "", "", "הוראת קבע"],

  // ── Overseas detail, ILS-converted block ──
  ['פירוט עבור הכרטיסים בחו"ל'],
  ["כרטיס", "תאריך חיוב", "תאריך עסקה", "שם בית עסק", "סכום חיוב בש''ח", "סכום מקורי", "מטבע מקורי", "אסמכתא"],
  ["9037", "02.06.2026", "19.05.2026", "DUBLIN       ~LINKEDIN RECRUITER P3", "569.99", "569.99", "ILS", "0"],
  ["9037", "02.06.2026", "11.05.2026", "LNKD.IN/BILL ~LINKEDIN SN *01553993", "3,203.88", "3,203.88", "ILS", "0"],

  // ── Overseas detail, by-original-currency block ──
  ['פירוט עבור הכרטיסים בחו"ל בדולר'],
  ["כרטיס", "תאריך חיוב", "תאריך עסקה", "שם בית עסק", "סכום קנייה", "מטבע", "סכום חיוב", "הערות"],
  ["9037", "02.06.2026", "26.05.2026", "SAN FRANCISCO~ANTHROPIC: CLAUDE TEA", "800.00", "USD", "800.00", ""],
  ["9037", "02.06.2026", "27.05.2026", ".SAO PAULO    ~UBER UBER *TRIP HELP", "120.97", "BRL", "24.78", ""],
  ["9037", "02.06.2026", "07.05.2026", "MINAMITORISHI~ETIHAD AIRWAYS MINAMI", "16,710.00", "JPY", "110.09", ""],
];

describe("normalizeStatement", () => {
  const rows = normalizeStatement(statementFixture);
  const byMerchant = (m) => rows.find((r) => r.merchant === m);

  it("skips summary/header sections entirely and emits only detail rows", () => {
    // 3 domestic + 2 overseas-ILS + 3 by-original-currency = 8; the three
    // card-led summary rows and every header row must not leak through.
    expect(rows).toHaveLength(8);
    expect(rows.some((r) => r.amountIls === 22411.36)).toBe(false);
    expect(rows.some((r) => r.amountIls === 14201.9)).toBe(false);
  });

  it("returns an empty array for a summary-only statement", () => {
    expect(
      normalizeStatement([
        ["פירוט חיובים קודמים"],
        ["כרטיס", "סכום חיוב"],
        ["9037", "22,411.36"],
      ])
    ).toEqual([]);
  });

  it("returns an empty array for empty/undefined input", () => {
    expect(normalizeStatement([])).toEqual([]);
    expect(normalizeStatement(undefined)).toEqual([]);
  });

  it("a summary section title after a detail section leaves detail mode", () => {
    expect(
      normalizeStatement([
        ["פירוט עבור הכרטיסים בארץ"],
        ["9037", "02.06.2026", "27.05.2026", "פנגו חשבונית חודשית", "549.02", "549.02", "9409033", "", "", "ללא הצמדה", "", "", "הוראת קבע"],
        ["ריכוז עסקאות בארץ"],
        ["9037", "14,201.90"],
      ])
    ).toHaveLength(1);
  });

  describe("domestic detail rows", () => {
    it("parses card, dates, amounts, currency and reference", () => {
      const pango = byMerchant("פנגו חשבונית חודשית");
      expect(pango).toMatchObject({
        card: "9037",
        billingDate: "02.06.2026",
        txnDate: "27.05.2026",
        amount: 549.02,
        currency: "ILS",
        amountIls: 549.02,
        reference: "9409033",
        type: "הוראת קבע",
      });
    });

    it("parses thousands separators", () => {
      expect(byMerchant("פריוריטי סופטוור בע”")).toMatchObject({
        card: "5438",
        amount: 8733,
        amountIls: 8733,
      });
    });

    it("sets recurring=true only for הוראת קבע rows", () => {
      expect(byMerchant("פנגו חשבונית חודשית").recurring).toBe(true);
      expect(byMerchant("פריוריטי סופטוור בע”").recurring).toBe(true);
      expect(byMerchant("רשת פנאי וקהילה מתנ”").recurring).toBe(false);
    });

    it("flags the escaped-minus row as a refund with negative amounts", () => {
      const refund = byMerchant("רשת פנאי וקהילה מתנ”");
      expect(refund.refund).toBe(true);
      expect(refund.amount).toBe(-150);
      expect(refund.amountIls).toBe(-150);
    });

    it("non-refund rows have refund=false", () => {
      expect(byMerchant("פנגו חשבונית חודשית").refund).toBe(false);
    });
  });

  describe("overseas ILS-converted block", () => {
    it("strips the city prefix up to and including ~ with no stray whitespace", () => {
      const li = byMerchant("LINKEDIN RECRUITER P3");
      expect(li).toBeDefined();
      expect(li.merchant).toBe("LINKEDIN RECRUITER P3");
      expect(byMerchant("LINKEDIN SN *01553993")).toBeDefined();
    });

    it("reads the currency column rather than assuming, and both amounts", () => {
      expect(byMerchant("LINKEDIN RECRUITER P3")).toMatchObject({
        card: "9037",
        amount: 569.99,
        currency: "ILS",
        amountIls: 569.99,
        reference: "0",
        recurring: false,
        refund: false,
      });
      expect(byMerchant("LINKEDIN SN *01553993").amount).toBe(3203.88);
    });
  });

  describe("overseas by-original-currency block", () => {
    it("preserves the actual original currency instead of assuming USD", () => {
      expect(byMerchant("UBER UBER *TRIP HELP").currency).toBe("BRL");
      expect(byMerchant("ETIHAD AIRWAYS MINAMI").currency).toBe("JPY");
      expect(byMerchant("ANTHROPIC: CLAUDE TEA").currency).toBe("USD");
    });

    it("keeps original amount and the section's converted amount separate", () => {
      expect(byMerchant("UBER UBER *TRIP HELP")).toMatchObject({
        amount: 120.97,
        amountIls: 24.78,
      });
      expect(byMerchant("ETIHAD AIRWAYS MINAMI")).toMatchObject({
        amount: 16710,
        amountIls: 110.09,
      });
    });

    it("strips city prefixes with leading dots and padded whitespace", () => {
      // ".SAO PAULO    ~UBER UBER *TRIP HELP" and "MINAMITORISHI~ETIHAD..."
      expect(byMerchant("UBER UBER *TRIP HELP")).toBeDefined();
      expect(byMerchant("ETIHAD AIRWAYS MINAMI")).toBeDefined();
      expect(byMerchant("ANTHROPIC: CLAUDE TEA")).toBeDefined();
    });
  });
});
