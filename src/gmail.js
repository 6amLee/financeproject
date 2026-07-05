// ── GMAIL ─────────────────────────────────────────────────────────────────────
// finance@ is a Google Group so its mail skips the Inbox — a Gmail filter
// applies the watch label (Master Doc §9 gotcha 2). We list by that label,
// and swap it for the processed label once a message is handled.

import { google } from "googleapis";
import { getGoogleAuth } from "./googleAuth.js";

let _gmail = null;
function getGmail() {
  if (!_gmail) _gmail = google.gmail({ version: "v1", auth: getGoogleAuth() });
  return _gmail;
}

function watchLabelName() {
  return process.env.GMAIL_WATCH_LABEL || "Finance Stuff";
}
function processedLabelName() {
  return process.env.GMAIL_PROCESSED_LABEL || "Finance Processed";
}

let _labelIds = null;
async function resolveLabelIds() {
  if (_labelIds) return _labelIds;
  const gmail = getGmail();
  const res = await gmail.users.labels.list({ userId: "me" });
  const labels = res.data.labels || [];
  const byName = (name) => labels.find((l) => l.name === name)?.id;

  const watchId = byName(watchLabelName());
  if (!watchId) {
    throw new Error(`Gmail watch label not found: "${watchLabelName()}" — create it (a filter should apply it to finance@ mail)`);
  }

  let processedId = byName(processedLabelName());
  if (!processedId) {
    const created = await gmail.users.labels.create({
      userId: "me",
      requestBody: {
        name: processedLabelName(),
        labelListVisibility: "labelShow",
        messageListVisibility: "show",
      },
    });
    processedId = created.data.id;
    console.log(`Gmail: created missing processed label "${processedLabelName()}"`);
  }

  _labelIds = { watchId, processedId };
  return _labelIds;
}

// (a) Messages carrying the watch label that don't yet have the processed label.
export async function listUnprocessedMessages() {
  const gmail = getGmail();
  const { watchId, processedId } = await resolveLabelIds();

  const res = await gmail.users.messages.list({
    userId: "me",
    labelIds: [watchId],
    maxResults: 50,
  });
  const messages = res.data.messages || [];

  const unprocessed = [];
  for (const m of messages) {
    const meta = await gmail.users.messages.get({
      userId: "me",
      id: m.id,
      format: "minimal",
    });
    if (!(meta.data.labelIds || []).includes(processedId)) unprocessed.push(m.id);
  }
  return unprocessed;
}

function decodePart(data) {
  return Buffer.from(data, "base64url").toString("utf8");
}

function extractSenderEmail(fromHeader) {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
}

// (b) Attachments (filename, mimeType, base64 data) + plain text body + sender.
export async function getMessageContent(messageId) {
  const gmail = getGmail();
  const res = await gmail.users.messages.get({
    userId: "me",
    id: messageId,
    format: "full",
  });

  const payload = res.data.payload || {};
  const headers = payload.headers || [];
  const fromHeader = headers.find((h) => h.name.toLowerCase() === "from")?.value || "";
  const subject = headers.find((h) => h.name.toLowerCase() === "subject")?.value || "";

  const attachmentRefs = [];
  let textBody = "";

  const walk = (part) => {
    if (!part) return;
    if (part.filename && part.body?.attachmentId) {
      attachmentRefs.push({
        filename: part.filename,
        mimeType: part.mimeType,
        attachmentId: part.body.attachmentId,
      });
    } else if (part.mimeType === "text/plain" && part.body?.data && !textBody) {
      textBody = decodePart(part.body.data);
    }
    for (const child of part.parts || []) walk(child);
  };
  walk(payload);

  const attachments = [];
  for (const ref of attachmentRefs) {
    const att = await gmail.users.messages.attachments.get({
      userId: "me",
      messageId,
      id: ref.attachmentId,
    });
    attachments.push({
      filename: ref.filename,
      mimeType: ref.mimeType,
      // Gmail returns base64url; the Anthropic and Drive APIs want standard base64.
      base64Data: Buffer.from(att.data.data, "base64url").toString("base64"),
    });
  }

  return {
    messageId,
    from: extractSenderEmail(fromHeader),
    subject,
    attachments,
    textBody,
  };
}

// (c) Swap labels so the message is never reprocessed.
export async function markProcessed(messageId) {
  const gmail = getGmail();
  const { watchId, processedId } = await resolveLabelIds();
  await gmail.users.messages.modify({
    userId: "me",
    id: messageId,
    requestBody: {
      removeLabelIds: [watchId],
      addLabelIds: [processedId],
    },
  });
}
