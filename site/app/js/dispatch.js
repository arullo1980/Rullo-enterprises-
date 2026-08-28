/**
 * Dispatch — turning a composed message into per-account sends.
 *
 * Shared by the composer (post now) and the queue (send due posts) so both
 * take exactly the same path: render per account, check the account can carry
 * the post, hand it to the API, record what happened per account.
 *
 * A fan-out never collapses to a single success/failure. Nine accounts
 * accepting and one rejecting is nine successes and one failure, recorded
 * separately, because that is what you have to act on.
 */

import * as store from "./store.js";
import { platform, limitFor, countFor } from "./platforms.js";
import { spin, makeDraw, contextValues } from "./spinner.js";
import * as api from "./api.js";

/**
 * Render the message for one account.
 * With `uniquePerAccount`, each account gets its own spin of the template;
 * otherwise every account gets the identical rendered text.
 */
export function renderFor(template, account, { draw, at } = {}) {
  const profile = store.get("profiles", account.profileId);
  const pl = platform(account.platform);
  return spin(template, {
    draw,
    values: contextValues({ account, profile, platformName: pl.name, at }),
  });
}

/** Build a draw function limited to what this account is allowed to use. */
export function drawFor(account) {
  return makeDraw(store.all("library"), {
    filter: (r) =>
      (!(r.profileIds || []).length || r.profileIds.includes(account.profileId)) &&
      (!(r.platformIds || []).length || r.platformIds.includes(account.platform)),
  });
}

/** Problems that would stop this text going out on this account. */
export function checkAccount(account, text, { hasMedia = false, live = api.isLive() } = {}) {
  const pl = platform(account.platform);
  const problems = [];
  const count = countFor(pl.id, text);
  const limit = limitFor(account);
  if (!text.trim()) problems.push("The message is empty.");
  if (count > limit) problems.push(`${count - limit} characters over the ${limit.toLocaleString()} limit.`);
  if (pl.requiresMedia && !hasMedia) problems.push(`${pl.name} needs an image or video.`);
  if (pl.needsTarget && !account.target) problems.push(`${pl.name} needs a ${pl.needsTarget} — set it on the account.`);
  if (live && account.status !== "connected") problems.push("Account is not connected.");
  const notes = !live && account.status !== "connected"
    ? ["Not connected — this send is simulated."] : [];
  return { problems, notes, count, limit, over: Math.max(0, count - limit) };
}

/**
 * Resolve a post record into the concrete per-account payloads.
 * Returns [{ account, text, problems }] in account order.
 */
export function resolve(post) {
  const at = post.scheduledAt || new Date().toISOString();
  return (post.accountIds || []).map((id) => {
    const account = store.get("accounts", id);
    if (!account) return { account: null, id, text: "", problems: ["Account no longer exists."], picked: [] };

    // Text already settled at compose time wins; otherwise spin it now, which
    // is what makes a queued post arrive as a fresh variation.
    let text = post.perAccountText && post.perAccountText[id];
    let picked = [];
    if (!text) {
      if (!post.uniquePerAccount && post.renderedText) {
        text = post.renderedText;
      } else {
        const draw = drawFor(account);
        text = renderFor(post.body, account, { draw, at });
        picked = draw.picked;
      }
    }
    const { problems } = checkAccount(account, text, { hasMedia: (post.media || []).length > 0 });
    return { account, id, text, problems, picked };
  });
}

/**
 * Send a post. Accounts with blocking problems are skipped and recorded as
 * failures rather than silently dropped.
 *
 * Returns the updated post record.
 */
export async function send(post, { dryRun = false } = {}) {
  const resolved = resolve(post);
  const sendable = resolved.filter((r) => r.account && !r.problems.length);
  const blocked = resolved.filter((r) => !r.account || r.problems.length);

  const items = sendable.map((r) => ({
    accountId: r.account.id,
    connectionId: r.account.connectionId || null,
    platform: r.account.platform,
    handle: r.account.handle,
    target: r.account.target || null,
    instance: r.account.instance || null,
    text: r.text,
    media: post.media || [],
    replyTo: post.replyTo || null,
  }));

  const apiResults = items.length ? await api.publish(items, { dryRun }) : [];

  const results = resolved.map((r) => {
    if (!r.account || r.problems.length) {
      return { accountId: r.id, ok: false, error: r.problems.join(" "), text: r.text };
    }
    const found = apiResults.find((x) => x.accountId === r.account.id) || { ok: false, error: "No response for this account." };
    return { ...found, accountId: r.account.id, text: r.text };
  });

  const sentOk = results.filter((r) => r.ok);
  const now = new Date().toISOString();

  for (const r of sentOk) {
    const acc = store.get("accounts", r.accountId);
    if (acc) await store.put("accounts", { ...acc, lastPostedAt: now, postCount: (acc.postCount || 0) + 1 });
  }

  // Only credit the library for text that actually went out.
  await creditLibrary(
    resolved.filter((r) => sentOk.some((s) => s.accountId === r.id)).flatMap((r) => r.picked || [])
  );

  const updated = await store.put("posts", {
    ...post,
    status: results.length && sentOk.length === results.length ? "sent"
          : sentOk.length ? "partial" : "failed",
    sentAt: now,
    simulated: results.some((r) => r.simulated),
    results,
    perAccountText: Object.fromEntries(resolved.map((r) => [r.id, r.text])),
  });

  await store.log("publish",
    `${sentOk.length}/${results.length} accounts ${results.some((r) => r.simulated) ? "simulated" : "posted"}` +
    (blocked.length ? `, ${blocked.length} blocked` : ""),
    { postId: updated.id });

  return updated;
}

/** Mark that library entries were consumed, so rotation and stats stay honest. */
export async function creditLibrary(draws) {
  const now = new Date().toISOString();
  const counts = new Map();
  for (const row of draws) {
    if (!row || !row.id) continue;
    counts.set(row.id, (counts.get(row.id) || 0) + 1);
  }
  for (const [id, n] of counts) {
    const row = store.get("library", id);
    if (row) await store.put("library", { ...row, useCount: (row.useCount || 0) + n, lastUsed: now });
  }
}

/**
 * Resolve queued posts into what the Worker's cron needs: fully rendered text
 * per connection. Spinning happens here rather than on the Worker so the
 * generator and the library stay on this side.
 *
 * Posts whose accounts are not connected are left out — the Worker has nothing
 * to send them through, and a queue entry it cannot fulfil is just noise.
 */
export function toQueueEntries(posts) {
  const entries = [];
  for (const post of posts) {
    const items = resolve(post)
      .filter((r) => r.account && r.account.connectionId && !r.problems.length)
      .map((r) => ({
        accountId: r.account.id,
        connectionId: r.account.connectionId,
        platform: r.account.platform,
        text: r.text,
        media: post.media || [],
        target: r.account.target || null,
      }));
    if (items.length) entries.push({ id: post.id, scheduledAt: post.scheduledAt, items });
  }
  return entries;
}
