// ── GOOGLE DRIVE ──────────────────────────────────────────────────────────────
// Archives the raw receipt file and returns a shareable link for the sheet.

import { Readable } from "node:stream";
import { google } from "googleapis";
import { getDriveAuth } from "./googleAuth.js";

let _drive = null;
function getDrive() {
  if (!_drive) _drive = google.drive({ version: "v3", auth: getDriveAuth() });
  return _drive;
}

// Download a Drive file by ID and return it as a base64 string.
// Used by statementOlive.js to re-load the original statement Excel for
// re-matching and coloring without keeping it in memory between poll cycles.
export async function downloadDriveFile(fileId) {
  const res = await getDrive().files.get(
    { fileId, alt: "media" },
    { responseType: "arraybuffer" }
  );
  return Buffer.from(res.data).toString("base64");
}

export async function uploadToDrive({ filename, mimeType, base64Data, folderId }) {
  const res = await getDrive().files.create({
    requestBody: {
      name: filename,
      parents: folderId ? [folderId] : undefined,
    },
    media: {
      mimeType,
      body: Readable.from(Buffer.from(base64Data, "base64")),
    },
    fields: "id, webViewLink",
    supportsAllDrives: true,
  });

  if (!res.data.webViewLink) {
    throw new Error(`Drive upload of "${filename}" returned no webViewLink`);
  }
  return res.data.webViewLink;
}
