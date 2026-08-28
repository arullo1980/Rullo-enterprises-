/**
 * Starter content.
 *
 * Loaded once, on first run, so the console opens with something to look at
 * rather than nine empty tables. Everything here is example data and is meant
 * to be edited or deleted — Settings has a "reset workspace" that clears it.
 */

import { putMany, put, all, saveSettings, uid } from "./store.js";

const KEYWORDS = [
  "cross-border payments", "mobile top-up", "airtime", "data bundle", "gift cards",
  "remittance", "prepaid", "instant delivery", "carrier coverage", "bill pay",
];
const PHRASES = [
  "Sending airtime home should take seconds, not an afternoon.",
  "The receipt should be readable without a magnifying glass.",
  "Coverage in 150+ countries, one checkout.",
  "No account to open, no minimum to hit.",
  "If a top-up fails, you should know before you close the tab.",
];
const HASHTAGS = ["#topup", "#airtime", "#giftcards", "#remittance", "#fintech", "#prepaid"];
const CTAS = [
  "Have a look:", "Try it here:", "Details:", "Start here:", "See the coverage list:",
];
const EMOJI = ["📱", "🌍", "⚡", "🎁", "💳"];

function libRow(kind, text, tags) {
  return { id: uid("lib"), kind, text, tags, weight: 1, useCount: 0, lastUsed: null, profileIds: [], platformIds: [] };
}

export async function seedIfEmpty() {
  if (all("profiles").length) return false;

  const personal = await put("profiles", {
    name: "Personal",
    kind: "personal",
    color: "#0E7C55",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    notes: "My own accounts. Voice is first person, informal.",
  });
  const business = await put("profiles", {
    name: "Rullo Enterprises",
    kind: "business",
    color: "#B8963F",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    notes: "The storefront. Voice is plain and useful — no hype, no emoji storms.",
  });
  const client = await put("profiles", {
    name: "Example Client",
    kind: "client",
    color: "#2E3E63",
    client: { company: "Example Client Ltd", contact: "", email: "", startedAt: new Date().toISOString().slice(0, 10) },
    timezone: "UTC",
    notes: "Managed on their behalf. They authorise once on each network; we never hold their password.",
  });

  // Placeholders across the networks this desk is set up for. Edit or delete
  // them — Settings has a reset that clears everything seeded here.
  await putMany("accounts", [
    { id: uid("acc"), profileId: personal.id, platform: "x", handle: "yourhandle", displayName: "You", status: "disconnected" },
    { id: uid("acc"), profileId: personal.id, platform: "telegram", handle: "yourchannel", target: "@yourchannel", displayName: "You", status: "disconnected" },
    { id: uid("acc"), profileId: business.id, platform: "x", handle: "rulloenterprises", displayName: "Rullo Enterprises", status: "disconnected" },
    { id: uid("acc"), profileId: business.id, platform: "facebook", handle: "rulloenterprises", displayName: "Rullo Enterprises", status: "disconnected" },
    { id: uid("acc"), profileId: business.id, platform: "instagram", handle: "rulloenterprises", displayName: "Rullo Enterprises", status: "disconnected" },
    { id: uid("acc"), profileId: business.id, platform: "wordpress", handle: "rulloenterprises", target: "https://rulloenterprises.com", displayName: "Rullo Enterprises", status: "disconnected" },
    { id: uid("acc"), profileId: client.id, platform: "instagram", handle: "exampleclient", displayName: "Example Client", status: "disconnected" },
    { id: uid("acc"), profileId: client.id, platform: "tiktok", handle: "exampleclient", displayName: "Example Client", status: "disconnected" },
    { id: uid("acc"), profileId: client.id, platform: "wordpress", handle: "exampleclient", target: "https://exampleclient.com", displayName: "Example Client", status: "disconnected" },
  ]);

  await putMany("library", [
    ...KEYWORDS.map((k) => libRow("keyword", k, ["fintech"])),
    ...PHRASES.map((p) => libRow("phrase", p, ["value"])),
    ...HASHTAGS.map((h) => libRow("hashtag", h, ["fintech"])),
    ...CTAS.map((c) => libRow("cta", c, ["storefront"])),
    ...EMOJI.map((e) => libRow("emoji", e, ["storefront"])),
    libRow("link", "https://rulloenterprises.com", ["storefront"]),
  ]);

  await putMany("templates", [
    {
      id: uid("tpl"),
      name: "Storefront — value message",
      body: "{[emoji:storefront] |}[phrase:value]\n\n{We do|Rullo Enterprises does} [keyword:fintech] {without the drama|in one checkout}. [cta:storefront] [link:storefront] [hashtag:fintech]",
      tags: ["storefront", "evergreen"],
      profileIds: [business.id],
      platformIds: [],
      notes: "Evergreen. Reads fine on X, LinkedIn and Bluesky.",
    },
    {
      id: uid("tpl"),
      name: "Mention — friendly reply",
      body: "{Thanks for the mention|Appreciate the tag}, [author]! {If you need|If you're after} [keyword:fintech], {we've got you|that's exactly what we do}. [cta:storefront] [link:storefront]",
      tags: ["reply"],
      profileIds: [business.id],
      platformIds: [],
      notes: "Used by the mention rule. Deliberately short.",
    },
  ]);

  await saveSettings({ onboarded: false });
  return true;
}

/** Sample feed items so the rule simulator has something to chew on. */
export function sampleFeed(accounts) {
  const acc = (accounts || [])[0] || { id: "sample", platform: "x" };
  const mk = (kind, text, author, extra = {}) => ({
    id: uid("smp"),
    kind,
    accountId: acc.id,
    platform: acc.platform,
    text,
    author,
    at: new Date(Date.now() - Math.random() * 6e6).toISOString(),
    lang: "en",
    url: "",
    ...extra,
  });
  return [
    mk("mention", "@rulloenterprises does your airtime top-up work for Nigeria?", { handle: "ada_k", name: "Ada K", followers: 812, verified: false }),
    mk("mention", "shoutout to @rulloenterprises, gift cards arrived instantly", { handle: "mikez", name: "Mike Z", followers: 46, verified: false }),
    mk("search", "anyone know a decent site for international mobile top-up that isn't a scam", { handle: "trav_ler", name: "Traveller", followers: 3400, verified: true }),
    mk("search", "cheapest way to send data bundle to family abroad?", { handle: "nia_w", name: "Nia W", followers: 190, verified: false }),
    mk("reply", "how long does delivery usually take?", { handle: "ada_k", name: "Ada K", followers: 812, verified: false }, { isReply: true }),
    mk("search", "buy followers cheap dm me top-up", { handle: "spam_bot_9", name: "GROW FAST", followers: 12, verified: false }),
    mk("follower", "", { handle: "new_follower", name: "New Follower", followers: 240, verified: false }),
  ];
}
