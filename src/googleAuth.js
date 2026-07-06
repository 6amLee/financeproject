// ── GOOGLE AUTH ───────────────────────────────────────────────────────────────
// Singleton GoogleAuth built from the Finance service account JSON.
// NOTE: this must be the Finance project's OWN service account — never Monica's.

import { google } from "googleapis";

const SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/gmail.modify",
];

let _auth = null;

export function getGoogleAuth() {
  if (_auth) return _auth;

  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");

  let credentials;
  try {
    credentials = JSON.parse(raw);
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
  }

  const options = { credentials, scopes: SCOPES };
  // Gmail requires domain-wide delegation + impersonating a real mailbox.
  const impersonateUser = process.env.GMAIL_IMPERSONATE_USER || process.env.GOOGLE_IMPERSONATE_USER;
  if (impersonateUser) {
    options.clientOptions = { subject: impersonateUser };
  }

  _auth = new google.auth.GoogleAuth(options);
  return _auth;
}
