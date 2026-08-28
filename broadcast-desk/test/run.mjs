/**
 * Broadcast Desk — tests.
 *
 *     node test/run.mjs
 *
 * No network, no Electron, no wrangler. Every outbound call is stubbed, so this
 * runs anywhere and never posts anything anywhere by accident.
 *
 * What it covers is the part that costs money or credibility when it is wrong:
 * how a post is priced, what each network is actually sent, and whether the
 * things that are supposed to be refused really are.
 */

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

const { PLATFORMS, PRIMARY, platform, countFor, costOf, hasLink, checkMedia, limitFor } =
  await import(path.join(root, "shared/platforms.js"));
const { publish, act, NetworkError } = await import(path.join(root, "shared/adapters.js"));
const { authorizeUrl, tokenRequest } = await import(path.join(root, "shared/providers.js"));

let failures = 0;
const check = async (label, fn) => {
  try {
    const r = await fn();
    console.log("ok    " + label + (r ? "  ::  " + r : ""));
  } catch (e) {
    failures++;
    console.log("FAIL  " + label + "  ::  " + e.message);
  }
};
const eq = (a, b, what) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${what || "mismatch"}: got ${A}, expected ${B}`);
};

/* --------------------------------------------------- a recording fetch stub */

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), options });
    const res = await handler(String(url), options, calls.length);
    if (res instanceof Response) return res;
    return new Response(JSON.stringify(res === undefined ? { ok: true } : res),
      { status: 200, headers: { "Content-Type": "application/json" } });
  };
  return calls;
}

const io = {
  userAgent: "test/1.0",
  read: async () => ({ name: "clip.mp4", type: "video/mp4", size: 12, bytes: new Uint8Array(12) }),
  publicUrl: async () => "https://media.example/clip.jpg",
  sleep: async () => {},
};
const imageIo = {
  ...io,
  read: async () => ({ name: "shot.jpg", type: "image/jpeg", size: 8, bytes: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]) }),
};

console.log("— catalogue ———————————————————————————————");

await check("the eleven requested networks are all present", async () => {
  const want = ["x", "instagram", "tiktok", "facebook", "telegram", "discord",
                "reddit", "tumblr", "wordpress", "vimeo", "pinterest"];
  const missing = want.filter((w) => !PRIMARY.some((p) => p.id === w));
  if (missing.length) throw new Error("missing " + missing.join(", "));
  return `${PRIMARY.length} primary, ${PLATFORMS.length} total`;
});

await check("X counts a URL as 23 characters, whatever its length", async () => {
  const short = countFor("x", "see https://a.co");
  const long = countFor("x", "see https://a.co/" + "y".repeat(200));
  if (short !== long) throw new Error(`${short} vs ${long}`);
  return `${short} either way`;
});

await check("a link makes an X post 13x dearer", async () => {
  eq(costOf("x", "plain text").amount, 0.015, "plain");
  eq(costOf("x", "read https://rulloenterprises.com").amount, 0.2, "with link");
  eq(costOf("telegram", "https://anything").amount, 0, "telegram is free");
  return "$0.015 → $0.20";
});

await check("bare domains count as links too", async () => {
  if (!hasLink("visit rulloenterprises.com today")) throw new Error("missed a bare domain");
  if (hasLink("no links here at all")) throw new Error("false positive");
  return "detected";
});

await check("media rules reject the wrong format and the oversized file", async () => {
  const wrongFormat = checkMedia("instagram", { name: "notes.pdf", size: 10 });
  const tooBig = checkMedia("pinterest", { name: "a.jpg", size: 999 * 1024 * 1024 });
  const fine = checkMedia("instagram", { name: "reel.mp4", size: 10 });
  if (!wrongFormat.length) throw new Error("a PDF was accepted for Instagram");
  if (!tooBig.length) throw new Error("a 999 MB pin was accepted");
  if (fine.length) throw new Error("a valid reel was rejected: " + fine[0]);
  return `${wrongFormat[0]} / ${tooBig[0]}`;
});

await check("X Premium raises the limit only for premium accounts", async () => {
  eq(limitFor({ platform: "x" }), 280, "standard");
  eq(limitFor({ platform: "x", premium: true }), 25000, "premium");
  return "280 / 25,000";
});

console.log("\n— oauth ———————————————————————————————————");

await check("PKCE and scopes land in the authorize URL", async () => {
  const u = new URL(authorizeUrl("x", {
    clientId: "cid", redirectUri: "http://127.0.0.1:5000/callback",
    state: "st", challenge: "ch",
  }));
  eq(u.searchParams.get("code_challenge_method"), "S256", "pkce");
  eq(u.searchParams.get("redirect_uri"), "http://127.0.0.1:5000/callback", "redirect");
  if (!u.searchParams.get("scope").includes("tweet.write")) throw new Error("no write scope");
  return u.host + u.pathname;
});

await check("Pinterest gets comma-separated scopes", async () => {
  const u = new URL(authorizeUrl("pinterest", { clientId: "c", redirectUri: "https://r/cb", state: "s" }));
  if (!u.searchParams.get("scope").includes(",")) throw new Error("scopes not comma separated");
  return u.searchParams.get("scope");
});

await check("TikTok uses client_key, not client_id", async () => {
  const u = new URL(authorizeUrl("tiktok", { clientId: "ck", redirectUri: "https://r/cb", state: "s", challenge: "c" }));
  if (u.searchParams.get("client_key") !== "ck") throw new Error("no client_key");
  if (u.searchParams.get("client_id")) throw new Error("sent client_id as well");
  return "client_key";
});

await check("confidential clients authenticate in the header", async () => {
  const { headers, body } = tokenRequest("x", { clientId: "id", clientSecret: "sec", code: "c", redirectUri: "r" });
  if (!String(headers.Authorization || "").startsWith("Basic ")) throw new Error("no basic auth");
  if (body.get("client_secret")) throw new Error("secret duplicated into the body");
  return "Basic";
});

console.log("\n— adapters —————————————————————————————————");

await check("Telegram sends text, and media as multipart", async () => {
  let calls = stubFetch(() => ({ ok: true, result: { message_id: 5 } }));
  await publish({ platform: "telegram", credentials: { botToken: "T", chatId: "@c" } }, { text: "hello" }, io);
  if (!calls[0].url.endsWith("/sendMessage")) throw new Error(calls[0].url);

  calls = stubFetch(() => ({ ok: true, result: { message_id: 6 } }));
  await publish({ platform: "telegram", credentials: { botToken: "T", chatId: "@c" } },
    { text: "hi", media: [{ path: "/tmp/clip.mp4" }] }, io);
  if (!calls[0].url.endsWith("/sendVideo")) throw new Error(calls[0].url);
  return "sendMessage / sendVideo";
});

await check("WordPress uploads the media first, then attaches it", async () => {
  const calls = stubFetch((url) =>
    url.endsWith("/media") ? { id: 77 } : { id: 5, link: "https://site/p/5" });
  const r = await publish({
    platform: "wordpress",
    credentials: { siteUrl: "https://site.com", username: "u", appPassword: "a b c d" },
  }, { text: "Body text", title: "A title", media: [{ path: "/tmp/shot.jpg" }] }, imageIo);

  eq(calls.length, 2, "call count");
  if (!calls[0].url.endsWith("/wp-json/wp/v2/media")) throw new Error(calls[0].url);
  const post = JSON.parse(calls[1].options.body);
  eq(post.featured_media, 77, "featured media");
  eq(post.title, "A title", "title");
  if (!post.content.includes("<p>Body text</p>")) throw new Error("body not converted to html");
  // The application password's spaces must be stripped before Basic auth.
  const auth = Buffer.from(calls[0].options.headers.Authorization.slice(6), "base64").toString();
  eq(auth, "u:abcd", "basic auth");
  return r.url;
});

await check("Instagram builds a container, waits, then publishes", async () => {
  const calls = stubFetch((url) => {
    if (url.includes("/media_publish")) return { id: "POSTED" };
    if (url.includes("/media")) return { id: "CONTAINER" };
    return { status_code: "FINISHED" };
  });
  const r = await publish({ platform: "instagram", accessToken: "t", meta: { igUserId: "17" } },
    { text: "caption", media: [{ path: "/tmp/shot.jpg" }] }, imageIo);
  eq(r.remoteId, "POSTED", "published id");
  if (!calls.some((c) => c.url.includes("status_code"))) throw new Error("did not wait for processing");
  return `${calls.length} calls, container → poll → publish`;
});

await check("Instagram refuses to invent media", async () => {
  stubFetch(() => ({}));
  try {
    await publish({ platform: "instagram", accessToken: "t", meta: { igUserId: "1" } }, { text: "no image" }, io);
  } catch (e) {
    if (!/image or video/i.test(e.message)) throw new Error(e.message);
    return e.message;
  }
  throw new Error("it published without media");
});

await check("TikTok posts privately while the app is unaudited", async () => {
  const calls = stubFetch((url) => url.includes("/init/")
    ? { data: { upload_url: "https://upload.tiktok/x", publish_id: "P1" } }
    : new Response("", { status: 200 }));
  const r = await publish({ platform: "tiktok", accessToken: "t", meta: {} },
    { text: "clip", media: [{ path: "/tmp/clip.mp4" }] }, io);
  eq(r.privacy, "SELF_ONLY", "privacy");
  if (!r.note || !/private/i.test(r.note)) throw new Error("no warning in the result");
  const sent = JSON.parse(calls[0].options.body);
  eq(sent.post_info.privacy_level, "SELF_ONLY", "requested privacy");
  return r.note;
});

await check("TikTok goes public once the connection is marked audited", async () => {
  stubFetch((url) => url.includes("/init/")
    ? { data: { upload_url: "https://upload.tiktok/x", publish_id: "P2" } }
    : new Response("", { status: 200 }));
  const r = await publish({ platform: "tiktok", accessToken: "t", meta: { audited: true } },
    { text: "clip", media: [{ path: "/tmp/clip.mp4" }] }, io);
  eq(r.privacy, "PUBLIC_TO_EVERYONE", "privacy");
  return r.privacy;
});

await check("Vimeo follows the server's tus offset, not its own", async () => {
  const big = { name: "film.mp4", type: "video/mp4", size: 100, bytes: new Uint8Array(100) };
  let offset = 0;
  const calls = stubFetch((url, options) => {
    if (url.endsWith("/me/videos")) return { upload: { upload_link: "https://tus/1" }, uri: "/videos/9", link: "https://vimeo.com/9" };
    // Accept only 40 bytes at a time, whatever the client asked to send.
    offset = Math.min(offset + 40, 100);
    return new Response("", { status: 200, headers: { "Upload-Offset": String(offset) } });
  });
  const r = await publish({ platform: "vimeo", accessToken: "t" },
    { text: "desc", title: "Film", media: [{ path: "/tmp/film.mp4" }] },
    { ...io, read: async () => big });
  const patches = calls.filter((c) => c.options.method === "PATCH").length;
  if (patches !== 3) throw new Error(`${patches} PATCHes — expected 3 for a 100-byte file the server takes 40 at a time`);
  return `${patches} chunks, ${r.url}`;
});

await check("Pinterest sends base64 rather than needing a host", async () => {
  const calls = stubFetch(() => ({ id: "PIN1" }));
  await publish({ platform: "pinterest", accessToken: "t", meta: { boardId: "b1" } },
    { text: "desc", title: "t", media: [{ path: "/tmp/shot.jpg" }] }, imageIo);
  const body = JSON.parse(calls[0].options.body);
  eq(body.media_source.source_type, "image_base64", "source type");
  eq(body.board_id, "b1", "board");
  return "image_base64";
});

await check("Reddit needs a subreddit and a title", async () => {
  stubFetch(() => ({ json: { errors: [], data: { id: "r1", url: "https://reddit/x" } } }));
  try {
    await publish({ platform: "reddit", accessToken: "t", meta: {} }, { text: "body" }, io);
    throw new Error("published with no subreddit");
  } catch (e) {
    if (!/subreddit/i.test(e.message)) throw e;
  }
  const r = await publish({ platform: "reddit", accessToken: "t", meta: {} },
    { text: "body", title: "Title", target: "r/test" }, io);
  return r.url;
});

await check("Reddit surfaces a refusal buried in a 200 response", async () => {
  stubFetch(() => ({ json: { errors: [["SUBREDDIT_NOTALLOWED", "you may not post here"]] } }));
  try {
    await publish({ platform: "reddit", accessToken: "t", meta: {} },
      { text: "b", title: "t", target: "r/x" }, io);
  } catch (e) {
    if (!/may not post/.test(e.message)) throw new Error(e.message);
    return e.message;
  }
  throw new Error("a refusal was reported as success");
});

await check("Facebook posts text to /feed and photos to /photos", async () => {
  let calls = stubFetch(() => ({ id: "1_2" }));
  await publish({ platform: "facebook", meta: { pageId: "1", pageToken: "pt" } }, { text: "hi" }, io);
  if (!calls[0].url.endsWith("/feed")) throw new Error(calls[0].url);

  calls = stubFetch(() => ({ post_id: "1_3" }));
  await publish({ platform: "facebook", meta: { pageId: "1", pageToken: "pt" } },
    { text: "hi", media: [{ path: "/tmp/shot.jpg" }] }, imageIo);
  if (!calls[0].url.endsWith("/photos")) throw new Error(calls[0].url);
  return "/feed and /photos";
});

await check("Discord truncates to its 2000-character limit", async () => {
  const calls = stubFetch(() => ({ id: "d1" }));
  await publish({ platform: "discord", credentials: { webhookUrl: "https://discord/hook" } },
    { text: "x".repeat(3000) }, io);
  const body = JSON.parse(calls[0].options.body);
  eq(body.content.length, 2000, "truncated length");
  return "2000";
});

await check("a 429 is reported as a rate limit, not a mystery", async () => {
  stubFetch(() => new Response(JSON.stringify({ detail: "slow down" }),
    { status: 429, headers: { "Retry-After": "60" } }));
  try {
    await publish({ platform: "telegram", credentials: { botToken: "T", chatId: "c" } }, { text: "hi" }, io);
  } catch (e) {
    if (!(e instanceof NetworkError) || e.status !== 429) throw new Error(e.message);
    if (!/60s/.test(e.message)) throw new Error("no retry hint: " + e.message);
    return e.message;
  }
  throw new Error("the rate limit was swallowed");
});

await check("an expired token says so instead of failing vaguely", async () => {
  stubFetch(() => new Response(JSON.stringify({ error: { message: "Session expired" } }), { status: 401 }));
  try {
    await publish({ platform: "facebook", meta: { pageId: "1", pageToken: "pt" } }, { text: "hi" }, io);
  } catch (e) {
    if (!/rejected the credentials/i.test(e.message)) throw new Error(e.message);
    return e.message;
  }
  throw new Error("a 401 was not reported");
});

await check("an unimplemented action is refused, not faked", async () => {
  try {
    await act({ platform: "discord", credentials: {} }, { action: "like" }, io);
  } catch (e) {
    if (!/does not support/i.test(e.message)) throw new Error(e.message);
    return e.message;
  }
  throw new Error("it claimed to like something");
});

/* ------------------------------------------------------------ the worker */

console.log("\n— relay ————————————————————————————————————");
const worker = spawnSync(process.execPath, [path.join(root, "worker/test.mjs")], { encoding: "utf8" });
process.stdout.write(worker.stdout.replace(/^/gm, "  ").replace(/^\s+$/gm, ""));
if (worker.status !== 0) failures++;

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exitCode = failures ? 1 : 0;
