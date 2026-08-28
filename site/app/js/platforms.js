/**
 * Platform catalog.
 *
 * One entry per network the desk can drive. Everything the UI needs to render,
 * validate and route a post lives here, so adding a network is a matter of
 * adding a row here plus an adapter in workers/social-hub/src/platforms/.
 *
 * `auth` describes how an account gets connected:
 *   oauth2      — user is redirected to the network, we store the returned token
 *   app-token   — user pastes a long-lived token they generated themselves
 *   app-password— user pastes a scoped app password (never their real password)
 *
 * We never ask for, transmit or store a network account's primary password —
 * not for our own accounts and not for a client's. Client accounts are
 * connected by the client authorising our app, which is also the only way that
 * survives the client changing their password or turning on 2FA.
 */

export const PLATFORMS = [
  {
    id: "x",
    name: "X",
    aka: "Twitter",
    abbr: "X",
    color: "#0F1419",
    limit: 280,
    limitPremium: 25000,
    media: 4,
    threads: true,
    auth: "oauth2",
    scopes: ["tweet.read", "tweet.write", "users.read", "offline.access"],
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: true, poll: true },
    docs: "https://developer.x.com/en/docs/x-api",
    note: "Write access requires a paid API tier. Repost = retweet.",
  },
  {
    id: "bluesky",
    name: "Bluesky",
    abbr: "BS",
    color: "#0085FF",
    limit: 300,
    media: 4,
    threads: true,
    auth: "app-password",
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: false, poll: false },
    docs: "https://docs.bsky.app/",
    note: "Connect with an app password from Settings, never the account password.",
  },
  {
    id: "mastodon",
    name: "Mastodon",
    abbr: "MA",
    color: "#6364FF",
    limit: 500,
    media: 4,
    threads: true,
    auth: "oauth2",
    scopes: ["read", "write:statuses", "write:media"],
    needsInstance: true,
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: true, poll: true },
    docs: "https://docs.joinmastodon.org/client/intro/",
    note: "Character limit varies by instance; 500 is the default.",
  },
  {
    id: "threads",
    name: "Threads",
    abbr: "TH",
    color: "#000000",
    limit: 500,
    media: 20,
    threads: true,
    auth: "oauth2",
    scopes: ["threads_basic", "threads_content_publish", "threads_manage_replies"],
    can: { post: true, reply: true, repost: true, quote: true, like: false, mention: true, dm: false, poll: false },
    docs: "https://developers.facebook.com/docs/threads",
  },
  {
    id: "linkedin",
    name: "LinkedIn",
    abbr: "IN",
    color: "#0A66C2",
    limit: 3000,
    media: 9,
    auth: "oauth2",
    scopes: ["w_member_social", "r_liteprofile"],
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: false, poll: true },
    docs: "https://learn.microsoft.com/en-us/linkedin/marketing/",
    note: "Personal profiles and company pages use different endpoints — pick the right one when connecting.",
  },
  {
    id: "facebook",
    name: "Facebook Page",
    abbr: "FB",
    color: "#1877F2",
    limit: 63206,
    media: 10,
    auth: "oauth2",
    scopes: ["pages_manage_posts", "pages_read_engagement", "pages_show_list"],
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: true, poll: false },
    docs: "https://developers.facebook.com/docs/pages-api",
    note: "Pages only. Personal Facebook timelines cannot be posted to by third-party apps.",
  },
  {
    id: "instagram",
    name: "Instagram",
    abbr: "IG",
    color: "#E1306C",
    limit: 2200,
    media: 10,
    requiresMedia: true,
    auth: "oauth2",
    scopes: ["instagram_business_content_publish", "instagram_business_basic"],
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: true, dm: true, poll: false },
    docs: "https://developers.facebook.com/docs/instagram-platform",
    note: "Business/Creator accounts only, and every post needs an image or video.",
  },
  {
    id: "tiktok",
    name: "TikTok",
    abbr: "TT",
    color: "#010101",
    limit: 2200,
    media: 1,
    requiresMedia: true,
    auth: "oauth2",
    scopes: ["video.publish", "user.info.basic"],
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: true, dm: false, poll: false },
    docs: "https://developers.tiktok.com/doc/content-posting-api-get-started",
    note: "Video only. Unaudited apps can only publish to private/self-view.",
  },
  {
    id: "youtube",
    name: "YouTube",
    abbr: "YT",
    color: "#FF0000",
    limit: 5000,
    media: 1,
    requiresMedia: true,
    auth: "oauth2",
    scopes: ["https://www.googleapis.com/auth/youtube.upload"],
    can: { post: true, reply: true, repost: false, quote: false, like: true, mention: false, dm: false, poll: false },
    docs: "https://developers.google.com/youtube/v3",
    note: "Community posts are not in the public API — this covers uploads and comments.",
  },
  {
    id: "pinterest",
    name: "Pinterest",
    abbr: "PI",
    color: "#E60023",
    limit: 500,
    media: 1,
    requiresMedia: true,
    auth: "oauth2",
    scopes: ["pins:write", "boards:read"],
    can: { post: true, reply: true, repost: true, quote: false, like: false, mention: false, dm: false, poll: false },
    docs: "https://developers.pinterest.com/docs/api/v5/",
    note: "Every pin needs a board and an image.",
  },
  {
    id: "reddit",
    name: "Reddit",
    abbr: "RE",
    color: "#FF4500",
    limit: 40000,
    media: 20,
    auth: "oauth2",
    scopes: ["submit", "identity", "read", "history"],
    needsTarget: "subreddit",
    can: { post: true, reply: true, repost: true, quote: false, like: true, mention: true, dm: true, poll: false },
    docs: "https://www.reddit.com/dev/api/",
    note: "Each post needs a target subreddit, and subreddit rules bite harder than the API does.",
  },
  {
    id: "tumblr",
    name: "Tumblr",
    abbr: "TU",
    color: "#001935",
    limit: 4096,
    media: 10,
    auth: "oauth2",
    scopes: ["write"],
    can: { post: true, reply: true, repost: true, quote: true, like: true, mention: true, dm: false, poll: false },
    docs: "https://www.tumblr.com/docs/en/api/v2",
  },
  {
    id: "telegram",
    name: "Telegram",
    abbr: "TG",
    color: "#26A5E4",
    limit: 4096,
    media: 10,
    auth: "app-token",
    needsTarget: "chat id",
    can: { post: true, reply: true, repost: true, quote: false, like: false, mention: true, dm: true, poll: true },
    docs: "https://core.telegram.org/bots/api",
    note: "Uses a bot token from @BotFather; the bot must be an admin of the channel.",
  },
  {
    id: "discord",
    name: "Discord",
    abbr: "DC",
    color: "#5865F2",
    limit: 2000,
    media: 10,
    auth: "app-token",
    needsTarget: "webhook url",
    can: { post: true, reply: true, repost: false, quote: false, like: false, mention: true, dm: false, poll: true },
    docs: "https://discord.com/developers/docs/resources/webhook",
    note: "A channel webhook is the simplest route and needs no bot.",
  },
];

export const PLATFORM_MAP = Object.fromEntries(PLATFORMS.map((p) => [p.id, p]));

export function platform(id) {
  return PLATFORM_MAP[id] || {
    id, name: id, abbr: (id || "?").slice(0, 2).toUpperCase(),
    color: "#7E765F", limit: 1000, media: 0, can: {}, auth: "app-token",
  };
}

/** Effective character limit for an account (accounts may override, e.g. X Premium). */
export function limitFor(account) {
  const p = platform(account && account.platform);
  if (account && account.premium && p.limitPremium) return p.limitPremium;
  return p.limit;
}

/**
 * X counts URLs as a fixed 23 characters no matter how long they are, and
 * Bluesky counts graphemes rather than UTF-16 code units. Close enough
 * matters here: an off-by-one that silently truncates a client's post is
 * worse than being slightly conservative.
 */
export function countFor(platformId, text) {
  const t = text || "";
  if (platformId === "x") {
    return t.replace(/https?:\/\/\S+/g, "x".repeat(23)).length;
  }
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    try {
      return [...new Intl.Segmenter().segment(t)].length;
    } catch (e) { /* fall through */ }
  }
  return [...t].length;
}

/** Platforms that can carry out a given rule action. */
export function platformsThatCan(action) {
  return PLATFORMS.filter((p) => p.can[action]);
}
