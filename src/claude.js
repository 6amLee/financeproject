// ── CLAUDE EXTRACTION ─────────────────────────────────────────────────────────
// Sends the receipt (PDF, image, or bare email body) to Claude Haiku and
// returns the raw text response. Prompt is the tuned extractor prompt from
// The_Olive_Master_Doc.md §7 — reused verbatim.

import Anthropic from "@anthropic-ai/sdk";

export const RECEIPT_PROMPT =
  "You are a receipt data extractor for Truvids finance system. Output ONLY a raw JSON object starting with a left brace and ending with a right brace. Never use code fences and never write the word json. Keys required: is_receipt, document_type, provider, date, amount, currency, receipt_no, expense_type, suggested_paid_by, cc_last4, notes. is_receipt is true only if this is a real receipt or invoice with an amount, else false. document_type is the word receipt if this is a proof of payment, or the word invoice if this is a request for payment or bill, or the word other. provider is the cleaned merchant name. currency is ILS or USD or EUR or null. amount is the final total including tax, digits with a dot decimal, no symbols. date is YYYY-MM-DD or null. receipt_no is the receipt or invoice number printed inside the document copied exactly, never the file name. expense_type is one of Advertising, Business meetings, Company event, Computer maintenance, Gas, Gifts for Employees, Gifts for partners, Office equipment, Other, Parking, Professional services, Refreshments / Snacks, Taxi/Train/Bus, Team lunch/ Dinner. suggested_paid_by is Organization or Employee or Unknown. cc_last4 is the last 4 digits of the credit or debit card number if clearly visible on the receipt as a 4-character string, else null. notes is a short summary or null. If a field is missing use null. Never invent values. All string values must be valid JSON — escape any literal double-quote characters inside a string value with a backslash.";

const IMAGE_MEDIA_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

// Pure helper — exported so the MIME-branching is unit-testable without
// hitting the Anthropic API.
export function buildContentBlocks({ mimeType, base64Data, textBody, context }) {
  const today = new Date().toISOString().slice(0, 10);
  const basePrompt = `${RECEIPT_PROMPT} Today's date is ${today} — if the date you read from the document looks implausible (e.g. more than 1 year ago, or in the future) assume it is a misread and return null for date instead.`;
  const prompt = context
    ? `${basePrompt}\n\nAdditional context from the submitter: ${context}`
    : basePrompt;

  if (base64Data && mimeType === "application/pdf") {
    return [
      {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64Data },
      },
      { type: "text", text: prompt },
    ];
  }

  if (base64Data && IMAGE_MEDIA_TYPES.has(mimeType)) {
    return [
      {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64Data },
      },
      { type: "text", text: prompt },
    ];
  }

  // Branch B — no attachment: extract from the email body text itself.
  if (textBody) {
    return [
      {
        type: "text",
        text: `${prompt}\n\nExtract from the following email body instead of a document:\n\n${textBody}`,
      },
    ];
  }

  throw new Error(
    `buildContentBlocks: nothing to extract — unsupported mimeType "${mimeType}" and no text body`
  );
}

let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic(); // reads ANTHROPIC_API_KEY from env
  return _client;
}

// Claude sometimes wraps JSON in markdown code fences despite being told not
// to (Master Doc §9 gotcha 4) — strip them before parsing.
function parseJsonLoose(rawText) {
  let text = rawText.trim();
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  if (fenceMatch) text = fenceMatch[1].trim();
  return JSON.parse(text);
}

export async function extractReceiptData({ mimeType, base64Data, textBody, context }) {
  const content = buildContentBlocks({ mimeType, base64Data, textBody, context });

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1024,
    messages: [{ role: "user", content }],
  });

  const textBlock = (response.content || []).find((b) => b.type === "text");
  if (!textBlock) throw new Error("Claude response contained no text block");
  return textBlock.text;
}

// Given a new trip/event name and the list of distinct existing event names,
// returns the existing name it most likely refers to (e.g. "Programmatic NY"
// vs "Programmatic New York"), or null if none is a plausible match.
export async function findMatchingTripName(newEventName, existingEventNames) {
  if (!existingEventNames.length) return null;

  const prompt =
    `A finance bot is registering a new company trip named "${newEventName}". ` +
    `Here is the list of existing trip names already in the system:\n` +
    existingEventNames.map((n) => `- ${n}`).join("\n") +
    `\n\nIs "${newEventName}" very likely referring to the SAME trip as one of these existing names ` +
    `(e.g. an abbreviation, alternate spelling, or reordering of the same event/destination)? ` +
    `Output ONLY a raw JSON object starting with a left brace and ending with a right brace, no code fences. ` +
    `Keys: match (the exact existing name string it matches, or null if none plausibly match), confidence (high or low). ` +
    `Only return a match with confidence "high" if you are quite sure — different trips to the same city in different ` +
    `months, or genuinely different events, should return null.`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });

  const textBlock = (response.content || []).find((b) => b.type === "text");
  if (!textBlock) return null;

  try {
    const parsed = parseJsonLoose(textBlock.text);
    if (parsed.confidence === "high" && existingEventNames.includes(parsed.match)) {
      return parsed.match;
    }
  } catch (e) {
    console.warn(`findMatchingTripName: malformed Claude response — ${e.message}`);
  }
  return null;
}

// Classifies a free-text DM question about travel (e.g. "who's going to
// Programmatic NY?", "how much did DMEXCO cost so far?", or "when is Aviad's
// flight for Programmatic NY?") against the list of known trip event names
// and (optionally) the known employee names on that trip. Returns
// { intent, eventName, employeeName } where intent is "roster", "cost",
// "employee_detail", or null if the question isn't a recognisable travel
// question or doesn't match any known trip. Claude only classifies — actual
// numbers/rosters/dates always come from the sheet, never from the model.
export async function classifyTravelQuestion(question, existingEventNames, employeeNames = []) {
  if (!existingEventNames.length) return { intent: null, eventName: null, employeeName: null };

  const employeeList = employeeNames.length
    ? `\n\nKnown employee names (across all trips):\n${employeeNames.map((n) => `- ${n}`).join("\n")}`
    : "";

  const prompt =
    `A Slack bot handles questions about company trips. Known trip names:\n` +
    existingEventNames.map((n) => `- ${n}`).join("\n") +
    employeeList +
    `\n\nUser's question: "${question}"\n\n` +
    `Output ONLY a raw JSON object starting with a left brace and ending with a right brace, no code fences. ` +
    `Keys:\n` +
    `intent — one of "roster" (asking who is/was attending a trip), "cost" (asking how much a trip cost or spent), ` +
    `"employee_detail" (asking about a specific person's trip details, e.g. their flight/departure/return dates or destination), ` +
    `or null if this isn't a travel question or you can't tell.\n` +
    `eventName — the exact matching name from the known trip list above, or null if no trip is clearly referenced or none match.\n` +
    `employeeName — only relevant when intent is "employee_detail": the exact matching name from the known employee list above ` +
    `that the question is asking about, or null if not applicable or no clear match.`;

  const response = await getClient().messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 256,
    messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
  });

  const textBlock = (response.content || []).find((b) => b.type === "text");
  if (!textBlock) return { intent: null, eventName: null, employeeName: null };

  try {
    const parsed = parseJsonLoose(textBlock.text);
    const intent = ["roster", "cost", "employee_detail"].includes(parsed.intent) ? parsed.intent : null;
    const eventName = existingEventNames.includes(parsed.eventName) ? parsed.eventName : null;
    const employeeName = employeeNames.includes(parsed.employeeName) ? parsed.employeeName : null;
    return { intent, eventName, employeeName };
  } catch (e) {
    console.warn(`classifyTravelQuestion: malformed Claude response — ${e.message}`);
    return { intent: null, eventName: null, employeeName: null };
  }
}
