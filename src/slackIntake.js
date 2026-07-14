// ── SLACK INTAKE HELPERS ───────────────────────────────────────────────────────
// Slack Web API calls needed for the receipt intake channel: read channel
// history, download a file, resolve a user display name. Uses native fetch
// (same pattern as FinanceCrew's sendSlackMessage — no SDK dependency).

const SLACK_API = "https://slack.com/api";

async function slackGet(token, method, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${SLACK_API}/${method}?${qs}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
  return data;
}

export async function slackPost(token, method, body) {
  const res = await fetch(`${SLACK_API}/${method}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack ${method} error: ${data.error}`);
  return data;
}

// Messages in channelId posted strictly after `oldest` (Slack timestamp string,
// e.g. "1234567890.123456"). Returns newest-first; caller reverses if needed.
export async function getChannelHistory(token, channelId, oldest) {
  const data = await slackGet(token, "conversations.history", {
    channel: channelId,
    oldest,
    limit: "100",
    inclusive: "false",
  });
  return data.messages || [];
}

// Download a Slack file URL and return the content as a base64 string.
// Slack file URLs require an Authorization header — they are not public.
export async function downloadSlackFile(token, url) {
  if (!url.startsWith("https://files.slack.com/")) {
    throw new Error(`Refusing to fetch non-Slack URL: ${url}`);
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`Slack file download failed (${res.status}): ${url}`);
  const buffer = await res.arrayBuffer();
  return Buffer.from(buffer).toString("base64");
}

// Resolve a Slack user ID to a human-readable display name.
// Falls back to the raw userId on any API error so a bad lookup never
// blocks receipt processing.
export async function getSlackUserName(token, userId) {
  try {
    const data = await slackGet(token, "users.info", { user: userId });
    return (
      data.user?.profile?.display_name ||
      data.user?.real_name ||
      userId
    );
  } catch {
    return userId;
  }
}
