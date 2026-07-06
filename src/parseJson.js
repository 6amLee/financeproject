// ── PARSE CLAUDE JSON ─────────────────────────────────────────────────────────
// Claude sometimes wraps its JSON in markdown code fences despite the prompt
// forbidding it (Master Doc §9 gotcha 4). Strip fences, parse, validate keys.

const REQUIRED_KEYS = [
  "is_receipt",
  "document_type",
  "provider",
  "date",
  "amount",
  "currency",
  "receipt_no",
  "expense_type",
  "suggested_paid_by",
  "cc_last4",
  "notes",
];

export function parseClaudeJson(rawText) {
  if (typeof rawText !== "string") {
    throw new Error(`parseClaudeJson expected a string, got ${typeof rawText}`);
  }

  let text = rawText.trim();

  // Strip a leading ```json / ``` fence and a trailing ``` fence, if present.
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `Claude response is not valid JSON: ${e.message} — raw response starts with: ${rawText.slice(0, 200)}`
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Claude response parsed to something other than a JSON object");
  }

  // Key PRESENCE only — null is a valid value per the prompt's own rules.
  const missing = REQUIRED_KEYS.filter((k) => !(k in parsed));
  if (missing.length > 0) {
    throw new Error(`Claude JSON is missing required keys: ${missing.join(", ")}`);
  }

  return parsed;
}
