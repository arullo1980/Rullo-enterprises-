/**
 * Shared helpers: request auth, JSON responses, CORS, KV access and the
 * encryption that keeps access tokens unreadable at rest.
 *
 * Tokens are the whole reason this Worker exists. They are encrypted with
 * AES-GCM under a key derived from the TOKEN_KEY secret, so a KV dump on its
 * own is not a set of live credentials.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ------------------------------------------------------------------ http */

export function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra },
  });
}

export function corsHeaders(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allow = allowed.includes(origin) ? origin : (allowed[0] || "");
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

/** Constant-time-ish comparison so a wrong key cannot be guessed byte by byte. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a || ""));
  const y = enc.encode(String(b || ""));
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/** Every /api route requires the desk key. The OAuth callback does not — the
 *  network calls it, and it is protected by the one-time state value instead. */
export function authorised(request, env) {
  const header = request.headers.get("Authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "");
  return Boolean(env.DESK_KEY) && safeEqual(token, env.DESK_KEY);
}

/* ------------------------------------------------------------ encryption */

async function keyFor(env) {
  if (!env.TOKEN_KEY) throw new Error("TOKEN_KEY secret is not set.");
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(env.TOKEN_KEY));
  return crypto.subtle.importKey("raw", digest, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(env, value) {
  const key = await keyFor(env);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = enc.encode(JSON.stringify(value));
  const box = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, data);
  return b64(iv) + "." + b64(new Uint8Array(box));
}

export async function unseal(env, packed) {
  const [ivPart, boxPart] = String(packed || "").split(".");
  if (!ivPart || !boxPart) throw new Error("Malformed sealed value.");
  const key = await keyFor(env);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(ivPart) }, key, unb64(boxPart)
  );
  return JSON.parse(dec.decode(plain));
}

export function b64(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function unb64(str) {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "=".repeat((4 - (s.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------- kv */

export const KEY = {
  connection: (id) => `conn:${id}`,
  connectionList: "conn:index",
  state: (s) => `state:${s}`,
  queued: (iso, id) => `queue:${iso}:${id}`,
  result: (id) => `result:${id}`,
  feed: (accountId) => `feed:${accountId}`,
  pickup: (id) => `pickup:${id}`,
  media: (id) => `media:${id}`,
  rate: (connectionId, bucket) => `rate:${connectionId}:${bucket}`,
};

export function id(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(9));
  return `${prefix}_${b64(bytes)}`;
}

export async function saveConnection(env, conn) {
  await env.HUB.put(KEY.connection(conn.id), await seal(env, conn));
  const index = JSON.parse((await env.HUB.get(KEY.connectionList)) || "[]");
  const meta = { id: conn.id, platform: conn.platform, label: conn.label, profileId: conn.profileId, connectedAt: conn.connectedAt };
  const next = index.filter((c) => c.id !== conn.id).concat([meta]);
  await env.HUB.put(KEY.connectionList, JSON.stringify(next));
  return meta;
}

export async function loadConnection(env, connectionId) {
  const packed = await env.HUB.get(KEY.connection(connectionId));
  if (!packed) return null;
  return unseal(env, packed);
}

export async function dropConnection(env, connectionId) {
  await env.HUB.delete(KEY.connection(connectionId));
  const index = JSON.parse((await env.HUB.get(KEY.connectionList)) || "[]");
  await env.HUB.put(KEY.connectionList, JSON.stringify(index.filter((c) => c.id !== connectionId)));
}

export async function listConnections(env) {
  return JSON.parse((await env.HUB.get(KEY.connectionList)) || "[]");
}

/**
 * Per-connection rate ceiling, applied on top of whatever caps a rule carries.
 * The desk can be wrong or misconfigured; this is the floor that keeps a bug
 * from turning into a suspended account.
 */
export async function withinRate(env, connectionId, perHour) {
  const bucket = new Date().toISOString().slice(0, 13);   // hour resolution
  const key = KEY.rate(connectionId, bucket);
  const used = Number((await env.HUB.get(key)) || 0);
  if (used >= perHour) return false;
  await env.HUB.put(key, String(used + 1), { expirationTtl: 7200 });
  return true;
}

export function nowIso() {
  return new Date().toISOString();
}
