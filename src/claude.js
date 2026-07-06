// ── CLAUDE EXTRACTION ─────────────────────────────────────────────────────────
// Sends the receipt (PDF, image, or bare email body) to Claude Haiku and
// returns the raw text response. Prompt is the tuned extractor prompt from
// The_Rambo_Master_Doc.md §7 — reused verbatim.

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
