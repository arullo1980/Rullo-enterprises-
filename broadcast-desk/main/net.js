/**
 * Sending.
 *
 * Every post the app sends itself goes through here, which makes this the one
 * place the guards have to hold:
 *
 *   - the X link rule, because a link turns a $0.015 post into a $0.20 one
 *   - the monthly spend ceiling, checked before the request, not after
 *   - spacing between accounts, because twelve posts in the same second is
 *     the signature every network scores as automation
 *
 * A fan-out never collapses into one verdict. Ten accounts accepting and one
 * rejecting is ten successes and one failure, reported per account.
 */

const { shared } = require("./shared.js");
const vault = require("./vault.js");
const media = require("./media.js");
const relay = require("./relay.js");
const settings = require("./settings.js");
const { ensureFresh } = require("./oauth.js");

/** Media plumbing handed to the adapters. */
function ioFor(onProgress) {
  return {
    userAgent: settings.get().userAgent,
    read: async (ref) => media.read(ref),
    // Only Instagram and Reddit link posts need this; everything else uploads
    // bytes directly from disk and never touches the relay.
    publicUrl: async (ref) => {
      const file = media.read(ref);
      if (file.url) return file.url;
      if (!relay.configured()) {
        throw new Error(
          "This network fetches media from a public URL rather than accepting an upload, " +
          "so it needs the relay configured (Settings → Relay)."
        );
      }
      return relay.hostMedia(file);
    },
    onProgress,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Reasons this exact item must not be sent. Checked before any network call,
 * so a blocked post costs nothing.
 */
async function guard(item) {
  const { platforms } = await shared();
  const s = settings.get();
  const p = platforms.platform(item.platform);
  const problems = [];

  if (!String(item.text || "").trim() && !(item.media || []).length) {
    problems.push("The post is empty.");
  }
  const count = platforms.countFor(item.platform, item.text || "");
  const limit = item.premium && p.limitPremium ? p.limitPremium : p.limit;
  if (count > limit) problems.push(`${count - limit} characters over ${p.name}'s ${limit.toLocaleString()} limit.`);

  if ((p.media || {}).required && !(item.media || []).length) {
    problems.push(`${p.name} needs ${(p.media.kinds || []).join(" or ")}.`);
  }
  for (const ref of item.media || []) {
    if (!media.exists(ref)) problems.push(`The file ${ref.name || ref.path} is no longer on this machine.`);
    else problems.push(...platforms.checkMedia(item.platform, ref));
  }
  if (p.needsTarget && !item.target) problems.push(`${p.name} needs a ${p.needsTarget}.`);
  if (p.needsTitle && !item.title && !String(item.text || "").trim()) {
    problems.push(`${p.name} needs a title.`);
  }

  const cost = platforms.costOf(item.platform, item.text || "");
  if (cost.link && item.platform === "x" && s.spend.blockLinksOnX && !item.allowLinkCost) {
    problems.push(
      `This post contains a link, which costs $${p.cost.perPostWithLink.toFixed(2)} on X ` +
      `instead of $${p.cost.perPost.toFixed(3)}. Remove the link, or allow the charge on this post.`
    );
  }
  if (cost.amount && settings.wouldExceed(cost.amount)) {
    problems.push(
      `This would take X spending past the $${s.spend.monthlyCapUsd} monthly cap ` +
      `($${settings.spentThisMonth().toFixed(2)} used so far). Raise the cap in Settings to continue.`
    );
  }
  return { problems, cost };
}

/** Send one item. Never throws — a failure is a result, not an exception. */
async function publishOne(item, onProgress) {
  const { adapters } = await shared();
  try {
    const checked = await guard(item);
    if (checked.problems.length) {
      return { accountId: item.accountId, ok: false, error: checked.problems.join(" ") };
    }

    const stored = vault.get(item.connectionId);
    if (!stored) {
      return { accountId: item.accountId, ok: false, error: "That account is not connected on this machine." };
    }
    const conn = await ensureFresh(stored);

    const result = await adapters.publish(conn, item, ioFor(onProgress));
    if (checked.cost.amount) settings.recordSpend(checked.cost.amount);

    return {
      accountId: item.accountId,
      ok: true,
      url: result.url || null,
      remoteId: result.remoteId || null,
      note: result.note || null,
      cost: checked.cost.amount || 0,
      postedAt: new Date().toISOString(),
    };
  } catch (e) {
    return { accountId: item.accountId, ok: false, error: String(e.message || e) };
  }
}

/** Fan out, serially and spaced. Progress is reported per item as it lands. */
async function publishMany(items, onEvent) {
  const gap = Number(settings.get().fanoutGapMs || 0);
  const results = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (onEvent) onEvent({ phase: "start", index: i, total: items.length, accountId: item.accountId });
    const result = await publishOne(item, (p) =>
      onEvent && onEvent({ phase: "progress", index: i, accountId: item.accountId, ...p }));
    results.push(result);
    if (onEvent) onEvent({ phase: "done", index: i, total: items.length, result });
    if (gap && i < items.length - 1) await new Promise((r) => setTimeout(r, gap));
  }
  return results;
}

async function actOne(action) {
  const { adapters } = await shared();
  try {
    const stored = vault.get(action.connectionId);
    if (!stored) return { ok: false, error: "That account is not connected on this machine." };
    const conn = await ensureFresh(stored);
    const r = await adapters.act(conn, action, ioFor());
    return { ok: true, ...r };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** What a set of items would cost, for the composer to show before sending. */
async function estimate(items) {
  const { platforms } = await shared();
  let total = 0;
  const lines = [];
  for (const item of items) {
    const c = platforms.costOf(item.platform, item.text || "");
    if (c.amount) {
      total += c.amount;
      lines.push({ accountId: item.accountId, platform: item.platform, amount: c.amount, reason: c.reason, link: c.link });
    }
  }
  return {
    total,
    lines,
    spentThisMonth: settings.spentThisMonth(),
    cap: settings.get().spend.monthlyCapUsd,
    wouldExceed: settings.wouldExceed(total),
  };
}

module.exports = { publishOne, publishMany, actOne, estimate, guard };
