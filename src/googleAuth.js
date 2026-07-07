// ── GOOGLE AUTH ───────────────────────────────────────────────────────────────
// Two auth singletons:
//   getGoogleAuth()  — Sheets + Drive (drive.file scope only, no impersonation)
//   getGmailAuth()   — Gmail only, impersonates the configured mailbox
//
// NOTE: this must be the Finance project's OWN service account — never Monica's.

import { google } from "googleapis";

const SHEETS_DRIVE_SCOPES = [
  "https://www.googleapis.com/auth/spreadsheets",
  "https://www.googleapis.com/auth/drive.file",
];

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
];

let _auth = null;
let _gmailAuth = null;

function loadCredentials() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set");
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new Error(`GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${e.message}`);
  }
}

// Used by Sheets, Drive, and all Rambo modules.
export function getGoogleAuth() {
  if (_auth) return _auth;
  _auth = new google.auth.GoogleAuth({ credentials: loadCredentials(), scopes: SHEETS_DRIVE_SCOPES });
  return _auth;
}

// Used only by src/gmail.js — requires domain-wide delegation + impersonation.
export function getGmailAuth() {
  if (_gmailAuth) return _gmailAuth;
  const impersonateUser = process.env.GMAIL_IMPERSONATE_USER || process.env.GOOGLE_IMPERSONATE_USER;
  if (!impersonateUser) throw new Error("GMAIL_IMPERSONATE_USER env var is required for Gmail access");
  _gmailAuth = new google.auth.GoogleAuth({
    credentials: loadCredentials(),
    scopes: GMAIL_SCOPES,
    clientOptions: { subject: impersonateUser },
  });
  return _gmailAuth;
}
