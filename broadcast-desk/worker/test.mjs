/**
 * social-hub — self-contained tests.
 *
 * Runs the real Worker module against an in-memory KV with the outbound
 * network stubbed, so nothing here touches a live network or needs wrangler:
 *
 *     node workers/social-hub/test.mjs
 *
 * Covers the things that would be expensive to get wrong: tokens are unreadable
 * at rest, the desk key is actually required, PKCE is used where it should be,
 * a fan-out reports per account, the cron sends only what is due and never
 * twice, and the hourly ceiling holds.
 */

import worker from "./src/worker.js";
import { seal, unseal, safeEqual } from "./src/lib.js";

const kv = new Map();
const HUB = {
  async get(k) { return kv.has(k) ? kv.get(k) : null; },
  async put(k, v) { kv.set(k, v); },
  async delete(k) { kv.delete(k); },
  async list({ prefix }) { return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
};
const env = {
  HUB, DESK_KEY: "desk-secret", TOKEN_KEY: "token-secret",
  ALLOWED_ORIGINS: "https://rulloenterprises.com",
  PUBLIC_URL: "https://hub.example.workers.dev",
  X_CLIENT_ID: "xcid", X_CLIENT_SECRET: "xsec",
  FANOUT_GAP_MS: "0",
};
const pendingWork = [];
const ctx = { waitUntil: (p) => { pendingWork.push(p); return p; } };
const settle = () => Promise.all(pendingWork.splice(0));
const call = (path, opts = {}) => worker.fetch(new Request("https://hub.example.workers.dev" + path, {
  ...opts,
  headers: { "Content-Type": "application/json", Authorization: "Bearer desk-secret", ...(opts.headers || {}) },
}), env, ctx);

let failures = 0;
const check = async (label, fn) => {
  try { const r = await fn(); console.log("ok    " + label + (r ? "  ::  " + r : "")); }
  catch (e) { failures++; console.log("FAIL  " + label + "  ::  " + e.message); }
};
process.on("beforeExit", () => {
  console.log(failures ? `\n${failures} failing` : "\nall passing");
  process.exitCode = failures ? 1 : 0;
});

await check("seal/unseal round-trips", async () => {
  const packed = await seal(env, { accessToken: "abc", nested: [1, 2] });
  if (packed.includes("abc")) throw new Error("plaintext leaked into the sealed value");
  const back = await unseal(env, packed);
  if (back.accessToken !== "abc") throw new Error("bad round trip");
  return "ciphertext " + packed.slice(0, 18) + "…";
});

await check("safeEqual", async () => {
  if (!safeEqual("a", "a") || safeEqual("a", "b") || safeEqual("ab", "a")) throw new Error("wrong");
  return "ok";
});

await check("health is open", async () => {
  const r = await worker.fetch(new Request("https://hub.example.workers.dev/health"), env, ctx);
  const d = await r.json();
  if (!d.ok) throw new Error(JSON.stringify(d));
  return d.version;
});

await check("unauthorised without the desk key", async () => {
  const r = await worker.fetch(new Request("https://hub.example.workers.dev/connections"), env, ctx);
  if (r.status !== 401) throw new Error("status " + r.status);
  return "401";
});

await check("oauth start builds a PKCE url", async () => {
  const r = await call("/connect/start", { method: "POST", body: JSON.stringify({ platform: "x", profileId: "p1", label: "test" }) });
  const d = await r.json();
  if (!d.url) throw new Error(JSON.stringify(d));
  const u = new URL(d.url);
  if (u.searchParams.get("code_challenge_method") !== "S256") throw new Error("no pkce");
  if (u.searchParams.get("redirect_uri") !== "https://hub.example.workers.dev/oauth/callback") throw new Error("bad redirect");
  if (!kv.has("state:" + u.searchParams.get("state"))) throw new Error("state not stored");
  return u.host + u.pathname;
});

await check("expired oauth state is refused", async () => {
  const r = await worker.fetch(new Request("https://hub.example.workers.dev/oauth/callback?code=x&state=nope"), env, ctx);
  const t = await r.text();
  if (r.status !== 400 || !/expired/.test(t)) throw new Error("status " + r.status);
  return "400 html";
});

await check("token connect probes and stores", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => {
    if (String(u).includes("api.telegram.org")) {
      return new Response(JSON.stringify({ ok: true, result: { username: "rullo_bot", id: 42 } }), { status: 200 });
    }
    return realFetch(u);
  };
  const r = await call("/connect/token", { method: "POST", body: JSON.stringify({
    platform: "telegram", profileId: "p1", label: "channel",
    credentials: { botToken: "123:abc", chatId: "@rullo" },
  })});
  globalThis.fetch = realFetch;
  const d = await r.json();
  if (!d.connectionId) throw new Error(JSON.stringify(d));
  const stored = kv.get("conn:" + d.connectionId);
  if (stored.includes("123:abc")) throw new Error("bot token stored in the clear");
  return d.connectionId;
});

await check("publish fans out and reports per account", async () => {
  const conns = JSON.parse(kv.get("conn:index"));
  const cid = conns[0].id;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes("sendMessage")) {
      const body = JSON.parse(o.body);
      if (body.text.includes("BOOM")) return new Response(JSON.stringify({ ok: false, description: "chat not found" }), { status: 400 });
      return new Response(JSON.stringify({ ok: true, result: { message_id: 7 } }), { status: 200 });
    }
    return realFetch(u, o);
  };
  const r = await call("/publish", { method: "POST", body: JSON.stringify({ items: [
    { accountId: "a1", connectionId: cid, platform: "telegram", text: "hello world" },
    { accountId: "a2", connectionId: cid, platform: "telegram", text: "BOOM" },
    { accountId: "a3", connectionId: "conn_missing", platform: "telegram", text: "orphan" },
  ]})});
  globalThis.fetch = realFetch;
  const d = await r.json();
  const summary = d.results.map((x) => `${x.accountId}:${x.ok ? "ok" : "fail"}`).join(" ");
  if (summary !== "a1:ok a2:fail a3:fail") throw new Error(summary + " " + JSON.stringify(d.results));
  return summary;
});

await check("cron drains only what is due", async () => {
  const conns = JSON.parse(kv.get("conn:index"));
  const cid = conns[0].id;
  const past = new Date(Date.now() - 6e4).toISOString();
  const future = new Date(Date.now() + 864e5).toISOString();
  await call("/queue/sync", { method: "POST", body: JSON.stringify({ posts: [
    { id: "due1", scheduledAt: past, items: [{ accountId: "a1", connectionId: cid, platform: "telegram", text: "due" }] },
    { id: "later", scheduledAt: future, items: [{ accountId: "a1", connectionId: cid, platform: "telegram", text: "later" }] },
  ]})});
  const realFetch = globalThis.fetch;
  let sent = 0;
  globalThis.fetch = async (u, o) => {
    if (String(u).includes("sendMessage")) { sent++; return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); }
    return realFetch(u, o);
  };
  await worker.scheduled({}, env, ctx);
  await settle();
  globalThis.fetch = realFetch;
  if (sent !== 1) throw new Error("sent " + sent + ", expected 1");
  const left = [...kv.keys()].filter((k) => k.startsWith("queue:"));
  if (left.length !== 1 || !left[0].endsWith(":later")) throw new Error("queue left: " + left);
  const res = await (await call("/queue/results", { method: "POST", body: "{}" })).json();
  if (!res.results.length || res.results[0].postId !== "due1") throw new Error(JSON.stringify(res));
  return "1 sent, 1 held, result recorded";
});

await check("hourly ceiling stops a runaway", async () => {
  const conns = JSON.parse(kv.get("conn:index"));
  const cid = conns[0].id;
  const capped = { ...env, MAX_POSTS_PER_HOUR: "3" };
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, o) => String(u).includes("sendMessage")
    ? new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 })
    : realFetch(u, o);
  const items = Array.from({ length: 6 }, (_, i) => ({ accountId: "a" + i, connectionId: cid, platform: "telegram", text: "hi" }));
  const r = await worker.fetch(new Request("https://hub.example.workers.dev/publish", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer desk-secret" },
    body: JSON.stringify({ items }),
  }), capped, ctx);
  globalThis.fetch = realFetch;
  const d = await r.json();
  const okCount = d.results.filter((x) => x.ok).length;
  const capMsgs = d.results.filter((x) => /ceiling/.test(x.error || "")).length;
  if (okCount > 3 || capMsgs < 1) throw new Error(`ok=${okCount} capped=${capMsgs}`);
  return `${okCount} sent, ${capMsgs} refused by the ceiling`;
});

await check("cors reflects an allowed origin", async () => {
  const r = await worker.fetch(new Request("https://hub.example.workers.dev/health", {
    headers: { Origin: "https://rulloenterprises.com" },
  }), env, ctx);
  const got = r.headers.get("Access-Control-Allow-Origin");
  if (got !== "https://rulloenterprises.com") throw new Error("got " + got);
  return got;
});
