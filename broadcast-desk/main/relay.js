/**
 * The relay — this app's only cloud dependency.
 *
 * It exists for exactly three jobs a program running on your desk cannot do:
 *
 *   1. Take the OAuth callback for networks that refuse a 127.0.0.1 redirect
 *      (Meta, TikTok, Pinterest, LinkedIn).
 *   2. Host media at a public URL for networks that fetch the file themselves
 *      rather than accepting an upload (Instagram; Reddit link posts).
 *   3. Send scheduled posts while this machine is off.
 *
 * Everything else happens locally. Job 3 is the one that requires a copy of a
 * token to live in the cloud, so it is opt-in per account and the account list
 * says plainly which accounts have one.
 */

const { net } = require("electron");
const settings = require("./settings.js");

class RelayError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "RelayError";
    this.status = status;
  }
}

function configured() {
  const s = settings.get();
  return Boolean(s.relayUrl && s.relayKey);
}

function base() {
  return String(settings.get().relayUrl || "").replace(/\/+$/, "");
}

async function call(path, { method = "GET", body, timeoutMs = 30000 } = {}) {
  if (!configured()) throw new RelayError("No relay is configured.", 0);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await net.fetch(base() + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + settings.get().relayKey,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text }; }
    if (!res.ok) throw new RelayError((data && (data.error || data.message)) || `Relay returned ${res.status}`, res.status);
    return data;
  } catch (e) {
    if (e.name === "AbortError") throw new RelayError("The relay did not respond in time.", 0);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function health() {
  if (!configured()) return { ok: false, mode: "local" };
  try {
    const info = await call("/health");
    await call("/connections");            // proves the key, which /health does not
    return { ok: true, mode: "live", ...info };
  } catch (e) {
    if (e.status === 401 || e.status === 403) {
      return { ok: false, mode: "unauthorised", error: "The relay is reachable, but it rejected this desk key." };
    }
    return { ok: false, mode: "error", error: e.message };
  }
}

/* ----------------------------------------------------------- media hosting */

/**
 * Put a local file somewhere Instagram's servers can fetch it.
 * Returns a URL that expires — hosting a client's unpublished creative
 * indefinitely on a public URL is not something to do by accident.
 */
async function hostMedia(file) {
  const slot = await call("/media/slot", {
    method: "POST",
    body: { name: file.name, type: file.type, size: file.size },
  });
  const put = await net.fetch(slot.uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file.bytes,
  });
  if (!put.ok) throw new RelayError(`Media upload failed (${put.status}).`, put.status);
  return slot.publicUrl;
}

/* ------------------------------------------------------------------ oauth */

/** Begin a flow the relay has to finish, because the network wants HTTPS. */
async function startHostedAuth(platform, opts) {
  return call("/connect/start", { method: "POST", body: { platform, ...opts } });
}

/** Collect the finished connection, tokens included, once the user approves. */
async function pickup(connectionId) {
  return call("/connect/pickup", { method: "POST", body: { connectionId } });
}

async function pushConnection(conn) {
  return call("/connections/store", { method: "POST", body: { connection: conn } });
}

async function dropConnection(connectionId) {
  return call("/connections/" + encodeURIComponent(connectionId), { method: "DELETE" });
}

/* ------------------------------------------------------------------ queue */

async function syncQueue(entries, remove = []) {
  return call("/queue/sync", { method: "POST", body: { posts: entries, remove } });
}

async function queueResults(since) {
  return call("/queue/results", { method: "POST", body: { since } });
}

async function feed(connectionIds, since) {
  return call("/feed", { method: "POST", body: { connectionIds, since } });
}

module.exports = {
  configured, health, hostMedia, startHostedAuth, pickup,
  pushConnection, dropConnection, syncQueue, queueResults, feed, call, RelayError,
};
