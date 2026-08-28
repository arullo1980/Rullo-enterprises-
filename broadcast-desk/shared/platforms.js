/**
 * Network catalogue — the single source of truth for what each network is,
 * what it can carry, and how it wants to be talked to.
 *
 * Shared by all three parts of the product: the renderer uses it to render and
 * validate, the Electron main process uses it to route a post, and the Worker
 * uses it to do the same when the cron sends unattended.
 *
 * Fields that matter:
 *
 *   auth        oauth2      redirect the operator to the network
 *               app-token   the operator pastes a token they generated
 *               app-password  a scoped app password, never an account password
 *   redirect    loopback    a desktop app may use http://127.0.0.1:PORT
 *               https       the network refuses loopback; needs the relay Worker
 *   media       what the network will accept, and whether a post needs it
 *   delivery    binary      we upload the bytes ourselves
 *               url         the network fetches the file from a public URL,
 *                           so it has to be hosted somewhere first
 *   cost        per-post charges, where the network charges
 *   review      what the network demands before you may act for other people
 */

export const PLATFORMS = [
  /* ---------------------------------------------------------- the eleven */
  {
    id: "x",
    name: "X",
    aka: "Twitter",
    abbr: "X",
    color: "#0F1419",
    limit: 280,
    limitPremium: 25000,
    auth: "oauth2",
    redirect: "loopback",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: true, poll: true },
    media: { required: false, kinds: ["image", "video"], max: 4, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 512 * 1024 * 1024 },
    delivery: "binary",
    // X moved to pay-per-use in February 2026. A link makes a post 13x dearer,
    // which is why the composer treats links on X as a blocked default.
    cost: { perPost: 0.015, perPostWithLink: 0.20, currency: "USD",
            note: "Pay-per-use. A post containing a link costs $0.20 instead of $0.015." },
    review: "Paid API access. No free tier for new developers since Feb 2026.",
    docs: "https://developer.x.com/en/docs/x-api",
  },
  {
    id: "instagram",
    name: "Instagram",
    abbr: "IG",
    color: "#E1306C",
    limit: 2200,
    auth: "oauth2",
    redirect: "https",
    scopes: ["instagram_business_basic", "instagram_business_content_publish"],
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: true, dm: true, poll: false },
    media: { required: true, kinds: ["image", "video"], max: 10, formats: ["jpg", "mp4"], maxBytes: 100 * 1024 * 1024,
             note: "JPEG only for images. Aspect between 4:5 and 1.91:1." },
    // Meta's servers fetch the file themselves, so it must be publicly reachable
    // before the post can be created. That is what the R2 bucket is for.
    delivery: "url",
    review: "Business/Creator account, Meta app review and business verification before you can post for other people.",
    docs: "https://developers.facebook.com/docs/instagram-platform/content-publishing/",
  },
  {
    id: "tiktok",
    name: "TikTok",
    abbr: "TT",
    color: "#010101",
    limit: 2200,
    auth: "oauth2",
    redirect: "https",
    scopes: ["video.publish", "video.upload", "user.info.basic"],
    clientKeyParam: "client_key",
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: true, dm: false, poll: false },
    media: { required: true, kinds: ["video"], max: 1, formats: ["mp4", "mov", "webm"], maxBytes: 4 * 1024 * 1024 * 1024 },
    delivery: "binary",
    review: "Until the app passes TikTok's Content Posting audit every upload is SELF_ONLY (private), capped at 5 users per 24h.",
    unaudited: { privacy: "SELF_ONLY", note: "Unaudited: posts land private and only the account owner can see them." },
    docs: "https://developers.tiktok.com/doc/content-posting-api-get-started",
  },
  {
    id: "facebook",
    name: "Facebook Page",
    abbr: "FB",
    color: "#1877F2",
    limit: 63206,
    auth: "oauth2",
    redirect: "https",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
    can: { post: true, reply: true, repost: false, quote: false, like: true, mention: true, dm: true, poll: false },
    media: { required: false, kinds: ["image", "video"], max: 10, formats: ["jpg", "png", "mp4"], maxBytes: 1024 * 1024 * 1024 },
    delivery: "binary",
    review: "Pages only — personal timelines are not postable by third-party apps. Meta app review for other people's Pages.",
    docs: "https://developers.facebook.com/docs/pages-api",
  },
  {
    id: "telegram",
    name: "Telegram",
    abbr: "TG",
    color: "#26A5E4",
    limit: 4096,
    captionLimit: 1024,
    auth: "app-token",
    needsTarget: "chat id",
    can: { post: true, reply: true, repost: true, quote: false, like: false, mention: true, dm: true, poll: true },
    media: { required: false, kinds: ["image", "video"], max: 10, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 50 * 1024 * 1024 },
    delivery: "binary",
    review: "None. A bot token from @BotFather; the bot must be an admin of the channel.",
    docs: "https://core.telegram.org/bots/api",
  },
  {
    id: "discord",
    name: "Discord",
    abbr: "DC",
    color: "#5865F2",
    limit: 2000,
    auth: "app-token",
    needsTarget: "webhook url",
    can: { post: true, reply: false, repost: false, quote: false, like: false, mention: true, dm: false, poll: false },
    media: { required: false, kinds: ["image", "video"], max: 10, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 25 * 1024 * 1024 },
    delivery: "binary",
    review: "None. A channel webhook, no bot needed.",
    docs: "https://discord.com/developers/docs/resources/webhook",
  },
  {
    id: "reddit",
    name: "Reddit",
    abbr: "RE",
    color: "#FF4500",
    limit: 40000,
    titleLimit: 300,
    auth: "oauth2",
    redirect: "loopback",
    scopes: ["submit", "identity", "read", "history", "edit"],
    basicAuth: true,
    needsTarget: "subreddit",
    needsTitle: true,
    can: { post: true, reply: true, repost: false, quote: false, like: true, mention: true, dm: true, poll: false },
    media: { required: false, kinds: ["image", "video"], max: 20, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 100 * 1024 * 1024 },
    delivery: "url",
    review: "None. Free developer app. Subreddit rules bite harder than the API does.",
    docs: "https://www.reddit.com/dev/api/",
  },
  {
    id: "tumblr",
    name: "Tumblr",
    abbr: "TU",
    color: "#001935",
    limit: 4096,
    auth: "oauth2",
    redirect: "loopback",
    scopes: ["basic", "write", "offline_access"],
    pkce: true,
    needsTarget: "blog identifier",
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: false, poll: false },
    media: { required: false, kinds: ["image", "video"], max: 10, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 100 * 1024 * 1024 },
    delivery: "binary",
    review: "None. Free developer app.",
    docs: "https://www.tumblr.com/docs/en/api/v2",
  },
  {
    id: "wordpress",
    name: "WordPress",
    abbr: "WP",
    color: "#21759B",
    limit: 200000,
    auth: "app-password",
    needsTarget: "site url",
    needsTitle: true,
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: false, dm: false, poll: false },
    media: { required: false, kinds: ["image", "video"], max: 20, formats: ["jpg", "png", "gif", "mp4", "pdf"], maxBytes: 512 * 1024 * 1024 },
    delivery: "binary",
    // Easily the least friction of the eleven: the client makes one Application
    // Password in their own profile and nothing else is needed.
    review: "None. A per-site Application Password — no OAuth app, no approval.",
    docs: "https://developer.wordpress.org/rest-api/",
  },
  {
    id: "vimeo",
    name: "Vimeo",
    abbr: "VM",
    color: "#1AB7EA",
    limit: 5000,
    titleLimit: 128,
    auth: "oauth2",
    redirect: "loopback",
    scopes: ["public", "private", "upload", "edit", "video_files"],
    needsTitle: true,
    can: { post: true, reply: false, repost: false, quote: false, like: true, mention: false, dm: false, poll: false },
    media: { required: true, kinds: ["video"], max: 1, formats: ["mp4", "mov", "avi", "wmv"], maxBytes: 8 * 1024 * 1024 * 1024 },
    // tus resumable upload: large files, survives a dropped connection.
    delivery: "tus",
    review: "None beyond a free developer app, though upload quota depends on the Vimeo plan.",
    docs: "https://developer.vimeo.com/api/upload/videos",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    abbr: "PI",
    color: "#E60023",
    limit: 800,
    titleLimit: 100,
    auth: "oauth2",
    redirect: "https",
    scopes: ["pins:read", "pins:write", "boards:read"],
    basicAuth: true,
    needsTarget: "board id",
    can: { post: true, reply: true, repost: true, quote: false, like: false, mention: false, dm: false, poll: false },
    media: { required: true, kinds: ["image", "video"], max: 1, formats: ["jpg", "png", "gif"], maxBytes: 20 * 1024 * 1024 },
    // Pinterest accepts base64 as well as a URL, so no hosting is needed.
    delivery: "base64",
    review: "None for a trial app; standard access needs a short review.",
    docs: "https://developers.pinterest.com/docs/api/v5/",
  },

  /* -------------------------------------------------- already built, free */
  /* Not on the request list, but implemented, tested and costing nothing to
     keep. All three connect without any review process. */
  {
    id: "bluesky",
    name: "Bluesky",
    abbr: "BS",
    color: "#0085FF",
    limit: 300,
    auth: "app-password",
    extra: true,
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: false, poll: false },
    media: { required: false, kinds: ["image"], max: 4, formats: ["jpg", "png"], maxBytes: 1024 * 1024 },
    delivery: "binary",
    review: "None. An app password from the account's own settings.",
    docs: "https://docs.bsky.app/",
  },
  {
    id: "mastodon",
    name: "Mastodon",
    abbr: "MA",
    color: "#6364FF",
    limit: 500,
    auth: "oauth2",
    redirect: "loopback",
    needsInstance: true,
    extra: true,
    scopes: ["read", "write:statuses", "write:media"],
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: true, poll: true },
    media: { required: false, kinds: ["image", "video"], max: 4, formats: ["jpg", "png", "gif", "mp4"], maxBytes: 40 * 1024 * 1024 },
    delivery: "binary",
    review: "None. Each instance is its own OAuth server.",
    docs: "https://docs.joinmastodon.org/client/intro/",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    abbr: "IN",
    color: "#0A66C2",
    limit: 3000,
    auth: "oauth2",
    redirect: "https",
    extra: true,
    scopes: ["w_member_social", "openid", "profile"],
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: false, poll: true },
    media: { required: false, kinds: ["image", "video"], max: 9, formats: ["jpg", "png", "mp4"], maxBytes: 200 * 1024 * 1024 },
    delivery: "binary",
    review: "The 'Share on LinkedIn' product must be granted on the app.",
    docs: "https://learn.microsoft.com/en-us/linkedin/marketing/",
  },
];

export const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

/** The networks this desk is actually being run for, in the operator's order. */
export const PRIMARY = PLATFORMS.filter((p) => !p.extra);
export const EXTRA = PLATFORMS.filter((p) => p.extra);

export function platform(id) {
  return PLATFORM_MAP[id] || {
    id, name: id, abbr: String(id || "?").slice(0, 2).toUpperCase(),
    color: "#7E765F", limit: 1000, can: {}, auth: "app-token",
    media: { required: false, kinds: [], max: 0 }, delivery: "binary",
  };
}

/** Effective character limit for an account (X Premium and similar override). */
export function limitFor(account) {
  const p = platform(account && account.platform);
  if (account && account.premium && p.limitPremium) return p.limitPremium;
  return p.limit;
}

/**
 * X counts a URL as a fixed 23 characters however long it is, and several
 * networks count graphemes rather than UTF-16 units. Being slightly
 * conservative is right: an off-by-one that truncates a client's post is worse
 * than refusing one character early.
 */
export function countFor(platformId, text) {
  const t = text || "";
  if (platformId === "x") return t.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try { return [...new Intl.Segmenter().segment(t)].length; } catch (e) { /* fall through */ }
  }
  return [...t].length;
}

const LINK_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|me|uk|us|shop|link)\b\S*/i;

/** Does this text contain something a network would treat as a link? */
export function hasLink(text) {
  return LINK_RE.test(String(text || ""));
}

/**
 * What this post will cost on this network, and why.
 * Only X charges per post today; everything else returns zero.
 */
export function costOf(platformId, text) {
  const p = platform(platformId);
  if (!p.cost) return { amount: 0, currency: "USD", reason: "free" };
  const link = hasLink(text);
  return {
    amount: link ? p.cost.perPostWithLink : p.cost.perPost,
    currency: p.cost.currency,
    reason: link ? "post contains a link" : "plain post",
    link,
    saving: link ? p.cost.perPostWithLink - p.cost.perPost : 0,
  };
}

export function platformsThatCan(action) {
  return PLATFORMS.filter((p) => p.can[action]);
}

/** Does a file look acceptable to this network? Extension and size only. */
export function checkMedia(platformId, file) {
  const p = platform(platformId);
  const m = p.media || {};
  const problems = [];
  const ext = String(file.name || file.path || "").split(".").pop().toLowerCase();
  if (m.formats && m.formats.length && !m.formats.includes(ext)) {
    problems.push(`${p.name} does not accept .${ext} (needs ${m.formats.join(", ")}).`);
  }
  if (m.maxBytes && file.size > m.maxBytes) {
    problems.push(`${(file.size / 1048576).toFixed(0)} MB is over ${p.name}'s ${(m.maxBytes / 1048576).toFixed(0)} MB limit.`);
  }
  return problems;
}
