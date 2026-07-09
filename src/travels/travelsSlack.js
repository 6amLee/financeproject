// ── TRAVELS SLACK (channel operations) ───────────────────────────────────────
// Create, populate, and archive per-trip Slack channels.
// Requires bot scopes: channels:manage, channels:read, channels:history.
//
// Channel naming: travel-{slug}-{mmm}{yy}
//   "DMEXCO" + "2026-09-15" → "travel-dmexco-sep26"

import { slackPost } from "../slackIntake.js";

// Converts an event name + departure date into a clean Slack channel name.
export function tripChannelName(eventName, departureDate) {
  const slug = String(eventName ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const d = new Date(departureDate);
  const month = isNaN(d) ? "" : d.toLocaleString("en-GB", { month: "short" }).toLowerCase();
  const year = isNaN(d) ? "" : String(d.getFullYear()).slice(2);
  return `travel-${slug}-${month}${year}`;
}

// Creates the trip channel and returns { channelId, channelName }.
// If a channel with that name already exists, returns the existing one.
export async function createTripChannel(token, eventName, departureDate) {
  const name = tripChannelName(eventName, departureDate);

  const res = await slackPost(token, "conversations.create", { name, is_private: false });

  if (res.ok) {
    return { channelId: res.channel.id, channelName: name };
  }

  // Channel already exists — look it up.
  if (res.error === "name_taken") {
    const list = await slackPost(token, "conversations.list", {
      types: "public_channel",
      limit: 1000,
      exclude_archived: true,
    });
    const existing = (list.channels || []).find((c) => c.name === name);
    if (existing) return { channelId: existing.id, channelName: name };
  }

  throw new Error(`Failed to create/find channel "${name}": ${res.error}`);
}

// Invites a user (by Slack ID) to the trip channel.
export async function addEmployeeToChannel(token, channelId, slackUserId) {
  const res = await slackPost(token, "conversations.invite", {
    channel: channelId,
    users: slackUserId,
  });
  // already_in_channel is fine — not an error.
  if (!res.ok && res.error !== "already_in_channel") {
    throw new Error(`conversations.invite failed: ${res.error}`);
  }
}

// Archives the trip channel.
export async function archiveTripChannel(token, channelId) {
  const res = await slackPost(token, "conversations.archive", { channel: channelId });
  if (!res.ok && res.error !== "already_archived") {
    throw new Error(`conversations.archive failed: ${res.error}`);
  }
}

// Counts how many file uploads exist in a channel from a specific user.
// Used for the activity-aware T+7 nudge.
export async function countUserUploadsInChannel(token, channelId, slackUserId) {
  let count = 0;
  let cursor;

  do {
    const params = { channel: channelId, limit: 200 };
    if (cursor) params.cursor = cursor;

    const res = await slackPost(token, "conversations.history", params);
    if (!res.ok) break;

    for (const msg of res.messages || []) {
      if (msg.user === slackUserId && msg.files?.length > 0) {
        count += msg.files.length;
      }
    }

    cursor = res.response_metadata?.next_cursor;
  } while (cursor);

  return count;
}
