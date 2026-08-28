/**
 * Client for the Broadcast Desk Worker (workers/social-hub).
 *
 * The console is useful with no backend at all: profiles, the library, the
 * generator, the queue and the rules all work locally. What the Worker adds is
 * the part a browser must not do — holding OAuth tokens and talking to the
 * networks.
 *
 * With no `apiBase` configured, publishing runs in DRY RUN: nothing leaves the
 * machine, and every result is flagged `simulated` so the queue never claims a
 * post went out when it did not.
 */

import { settings, log } from "./store.js";

export function isLive() {
  const s = settings();
  return Boolean(s.apiBase && s.apiBase.trim());
}

export function base() {
  return (settings().apiBase || "").replace(/\/+$/, "");
}

class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function call(path, { method = "GET", body, timeoutMs = 20000 } = {}) {
  if (!isLive()) throw new ApiError("No backend configured.", 0, null);
  const s = settings();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(base() + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(s.apiKey ? { Authorization: "Bearer " + s.apiKey } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) {
      throw new ApiError((data && (data.error || data.message)) || `Request failed (${res.status})`, res.status, data);
    }
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new ApiError("The backend did not respond in time.", 0, null);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

export async function health() {
  if (!isLive()) return { ok: false, mode: "local" };
  let info;
  try {
    info = await call("/health");
  } catch (e) {
    return { ok: false, mode: "error", error: e.message };
  }
  // /health is deliberately open, so reaching it proves nothing about the key.
  // Probe an authenticated route as well, or a wrong key looks like success
  // right up until the first post fails.
  try {
    await call("/connections");
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { ok: false, mode: "unauthorised", error: "The Worker is reachable, but it rejected this desk key." };
    }
    return { ok: false, mode: "error", error: e.message };
  }
  return { ok: true, mode: "live", ...info };
}

/* --------------------------------------------------------------- connect */

/**
 * Begin connecting an account. The Worker returns the network's authorisation
 * URL; the user approves there and the Worker stores the token against
 * `connectionId`, which is all we keep on this side.
 */
export async function startConnect(platformId, { profileId, instance, label }) {
  return call("/connect/start", {
    method: "POST",
    body: { platform: platformId, profileId, instance, label, redirect: location.origin + "/app/#/accounts" },
  });
}

/** Finish a paste-a-token style connection (Telegram bot, Discord webhook, app password). */
export async function connectToken(platformId, { profileId, label, credentials }) {
  return call("/connect/token", {
    method: "POST",
    body: { platform: platformId, profileId, label, credentials },
  });
}

export async function listConnections() {
  return call("/connections");
}

export async function disconnect(connectionId) {
  return call("/connections/" + encodeURIComponent(connectionId), { method: "DELETE" });
}

/* --------------------------------------------------------------- publish */

/**
 * Publish one composed post to many accounts at once.
 *
 * `items` is [{ accountId, connectionId, platform, text, media, target, replyTo }].
 * Returns [{ accountId, ok, url, error, simulated }] in the same order, so a
 * partial failure is visible per account rather than collapsing the whole send.
 */
export async function publish(items, { dryRun = false } = {}) {
  if (dryRun || !isLive()) return simulate(items, dryRun ? "dry run requested" : "no backend configured");
  try {
    const r = await call("/publish", { method: "POST", body: { items } });
    return (r && r.results) || [];
  } catch (e) {
    await log("publish", "Publish failed: " + e.message, { count: items.length });
    return items.map((i) => ({ accountId: i.accountId, ok: false, error: e.message }));
  }
}

function simulate(items, why) {
  return items.map((i) => ({
    accountId: i.accountId,
    ok: true,
    simulated: true,
    note: why,
    url: null,
    postedAt: new Date().toISOString(),
  }));
}

/* ----------------------------------------------------------------- feeds */

/** Mentions, replies and keyword hits the Worker has collected for the rules. */
export async function fetchFeed({ connectionIds, since } = {}) {
  if (!isLive()) return { items: [], mode: "local" };
  return call("/feed", { method: "POST", body: { connectionIds, since } });
}

/** Carry out a rule action (reply / repost / like) that the user approved. */
export async function act(action) {
  if (!isLive()) return { ok: true, simulated: true };
  return call("/act", { method: "POST", body: action });
}

/* ----------------------------------------------------------------- queue */

/**
 * Hand the queue to the Worker so its cron can send while this browser is
 * closed. Without a backend the queue is sent from this tab when it is open,
 * which is a real limitation and is surfaced in the UI rather than hidden.
 */
export async function syncQueue(entries, remove = []) {
  if (!isLive()) return { synced: 0, mode: "local" };
  return call("/queue/sync", { method: "POST", body: { posts: entries, remove } });
}

export async function fetchQueueResults(since) {
  if (!isLive()) return { results: [] };
  return call("/queue/results", { method: "POST", body: { since } });
}

export { ApiError };
