import { describe, it, expect } from "vitest";
import { parseClaudeJson } from "../src/parseJson.js";

const validObject = {
  is_receipt: true,
  provider: "Anthropic",
  date: "2026-07-01",
  amount: "200.00",
  currency: "USD",
  receipt_no: "INV-12345",
  expense_type: "Professional services",
  suggested_paid_by: "Organization",
  notes: "Max plan 20x",
};

describe("parseClaudeJson", () => {
  it("parses raw JSON with no fence", () => {
    expect(parseClaudeJson(JSON.stringify(validObject))).toEqual(validObject);
  });

  it("strips a ```json fence", () => {
    const wrapped = "```json\n" + JSON.stringify(validObject) + "\n```";
    expect(parseClaudeJson(wrapped)).toEqual(validObject);
  });

  it("strips a plain ``` fence", () => {
    const wrapped = "```\n" + JSON.stringify(validObject) + "\n```";
    expect(parseClaudeJson(wrapped)).toEqual(validObject);
  });

  it("tolerates surrounding whitespace around a fenced block", () => {
    const wrapped = "  \n```json\n" + JSON.stringify(validObject) + "\n```\n  ";
    expect(parseClaudeJson(wrapped)).toEqual(validObject);
  });

  it("throws when a required key is missing", () => {
    const { receipt_no, ...withoutReceiptNo } = validObject;
    expect(() => parseClaudeJson(JSON.stringify(withoutReceiptNo))).toThrow(
      /missing required keys: receipt_no/
    );
  });

  it("accepts null values for required keys (presence, not truthiness)", () => {
    const withNulls = { ...validObject, receipt_no: null, notes: null, date: null };
    expect(parseClaudeJson(JSON.stringify(withNulls))).toEqual(withNulls);
  });

  it("returns the parsed object for a valid full object", () => {
    const parsed = parseClaudeJson(JSON.stringify(validObject));
    expect(parsed.provider).toBe("Anthropic");
    expect(parsed.is_receipt).toBe(true);
  });

  it("throws a clear error on non-JSON input", () => {
    expect(() => parseClaudeJson("Sorry, I can't read this document.")).toThrow(
      /not valid JSON/
    );
  });
});
