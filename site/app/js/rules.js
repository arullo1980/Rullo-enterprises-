/**
 * Rule engine.
 *
 * A rule is "when X shows up on these accounts, do Y, no more than this
 * often". The user builds them ad hoc in the rule adder; this module holds
 * the shape, the matching, the rate limiting and the plain-English rendering
 * so the builder, the simulator and the Worker all agree on what a rule means.
 *
 * The caps are not decoration. Every network's automation policy is written in
 * terms of volume and repetition, and an unthrottled reply rule is the fastest
 * way to lose an account — a client's account most of all. Rules therefore
 * carry limits by default, and default to staging their actions for approval.
 */

export const TRIGGERS = {
  mention:  { label: "Someone mentions the account", needsTerms: false, feeds: ["mention"] },
  reply:    { label: "Someone replies to the account", needsTerms: false, feeds: ["reply"] },
  keyword:  { label: "A post matches keywords", needsTerms: true, feeds: ["search"] },
  hashtag:  { label: "A post uses a hashtag", needsTerms: true, feeds: ["search"] },
  follower: { label: "The account gains a follower", needsTerms: false, feeds: ["follower"] },
  dm:       { label: "The account receives a direct message", needsTerms: false, feeds: ["dm"] },
};

export const ACTIONS = {
  reply:  { label: "Reply to it", needsMessage: true },
  quote:  { label: "Quote it with a comment", needsMessage: true },
  repost: { label: "Repost it", needsMessage: false },
  like:   { label: "Like it", needsMessage: false },
  post:   { label: "Post a new message", needsMessage: true },
  dm:     { label: "Send a direct message", needsMessage: true },
};

export const MATCH_MODES = {
  any:    "any of these terms",
  all:    "all of these terms",
  phrase: "this exact phrase",
  regex:  "this regular expression",
};

export function blankRule() {
  return {
    name: "",
    enabled: false,
    profileIds: [],
    accountIds: [],
    trigger: {
      type: "mention",
      terms: [],
      matchMode: "any",
      exclude: [],
      minFollowers: 0,
      language: "",
      skipReplies: false,
      skipReposts: true,
      verifiedOnly: false,
    },
    action: {
      type: "reply",
      source: "template",
      templateIds: [],
      libraryTags: [],
      text: "",
    },
    limits: {
      perHour: 6,
      perDay: 40,
      cooldownMin: 5,
      maxPerAuthor: 1,
      days: [0, 1, 2, 3, 4, 5, 6],
      activeHours: { from: "08:00", to: "22:00", enabled: true },
    },
    safety: {
      requireApproval: true,
      skipIfInteractedBefore: true,
    },
    stats: { matched: 0, acted: 0, skipped: 0 },
  };
}

/* -------------------------------------------------------------- matching */

function normalise(s) {
  return String(s || "").toLowerCase();
}

function termHit(text, term, mode) {
  const t = normalise(text);
  if (mode === "regex") {
    try { return new RegExp(term, "i").test(text); } catch (e) { return false; }
  }
  const needle = normalise(term);
  if (!needle) return false;
  // Word-ish boundary so "top-up" does not match inside "laptop-updated".
  if (/^[\w#@'-]+$/.test(needle)) {
    const re = new RegExp(`(^|[^\\w#@])${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\w'-])`, "i");
    return re.test(" " + text + " ");
  }
  return t.includes(needle);
}

/**
 * Does `item` satisfy `rule`? Returns { ok, reason } — the reason is shown in
 * the simulator so a rule that quietly matches nothing is diagnosable.
 */
export function matches(rule, item) {
  const t = rule.trigger || {};
  const spec = TRIGGERS[t.type] || TRIGGERS.mention;

  if (!spec.feeds.includes(item.kind)) {
    return { ok: false, reason: `item is a ${item.kind}, rule listens for ${t.type}` };
  }
  if (rule.accountIds && rule.accountIds.length && item.accountId &&
      !rule.accountIds.includes(item.accountId)) {
    return { ok: false, reason: "not one of this rule's accounts" };
  }

  const text = item.text || "";
  const terms = (t.terms || []).filter(Boolean);

  if (spec.needsTerms) {
    if (!terms.length) return { ok: false, reason: "no terms configured" };
    if (t.matchMode === "all") {
      const missing = terms.find((term) => !termHit(text, term, t.matchMode));
      if (missing) return { ok: false, reason: `missing term "${missing}"` };
    } else if (t.matchMode === "phrase") {
      if (!normalise(text).includes(normalise(terms.join(" ")))) {
        return { ok: false, reason: "phrase not present" };
      }
    } else {
      if (!terms.some((term) => termHit(text, term, t.matchMode))) {
        return { ok: false, reason: "no term matched" };
      }
    }
  } else if (terms.length) {
    // Optional narrowing on mention/reply triggers.
    if (!terms.some((term) => termHit(text, term, t.matchMode))) {
      return { ok: false, reason: "no term matched" };
    }
  }

  const excluded = (t.exclude || []).filter(Boolean).find((term) => termHit(text, term, "any"));
  if (excluded) return { ok: false, reason: `excluded by "${excluded}"` };

  const author = item.author || {};
  if (t.minFollowers && (author.followers || 0) < Number(t.minFollowers)) {
    return { ok: false, reason: `author has ${author.followers || 0} followers, minimum is ${t.minFollowers}` };
  }
  if (t.verifiedOnly && !author.verified) return { ok: false, reason: "author is not verified" };
  if (t.language && item.lang && item.lang !== t.language) {
    return { ok: false, reason: `language is ${item.lang}, rule wants ${t.language}` };
  }
  if (t.skipReplies && item.isReply) return { ok: false, reason: "item is a reply" };
  if (t.skipReposts && item.isRepost) return { ok: false, reason: "item is a repost" };

  return { ok: true, reason: "matched" };
}

/* ---------------------------------------------------------------- limits */

function hhmm(s) {
  const [h, m] = String(s || "0:00").split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}

/**
 * Can this rule fire right now, given what it has already done?
 * `recent` is a list of { at, ruleId, authorHandle }.
 */
export function canRunNow(rule, recent = [], now = new Date(), item = null) {
  const l = rule.limits || {};
  const mine = recent.filter((r) => r.ruleId === rule.id);

  if (l.days && l.days.length && !l.days.includes(now.getDay())) {
    return { ok: false, reason: "outside the rule's active days" };
  }
  if (l.activeHours && l.activeHours.enabled) {
    const m = now.getHours() * 60 + now.getMinutes();
    const from = hhmm(l.activeHours.from), to = hhmm(l.activeHours.to);
    const inside = from <= to ? (m >= from && m < to) : (m >= from || m < to);
    if (!inside) return { ok: false, reason: "outside the rule's active hours" };
  }

  const since = (ms) => mine.filter((r) => now - new Date(r.at) < ms).length;
  if (l.perHour && since(36e5) >= l.perHour) {
    return { ok: false, reason: `hourly cap reached (${l.perHour}/hour)` };
  }
  if (l.perDay && since(864e5) >= l.perDay) {
    return { ok: false, reason: `daily cap reached (${l.perDay}/day)` };
  }
  if (l.cooldownMin && mine.length) {
    const last = mine.reduce((a, b) => (new Date(a.at) > new Date(b.at) ? a : b));
    const gap = (now - new Date(last.at)) / 60000;
    if (gap < l.cooldownMin) {
      return { ok: false, reason: `cooling down (${Math.ceil(l.cooldownMin - gap)} min left)` };
    }
  }
  if (l.maxPerAuthor && item && item.author && item.author.handle) {
    const seen = mine.filter((r) => r.authorHandle === item.author.handle).length;
    if (seen >= l.maxPerAuthor) {
      return { ok: false, reason: `already acted on @${item.author.handle} ${seen}×` };
    }
  }
  return { ok: true, reason: "within limits" };
}

/* --------------------------------------------------------------- summary */

/**
 * Render a rule as a sentence. This is the thing that stops a mis-built rule
 * from shipping: if the sentence does not read like what you meant, it is not
 * what you meant.
 */
export function summarize(rule, { accounts = [], profiles = [], templates = [] } = {}) {
  const t = rule.trigger || {};
  const a = rule.action || {};
  const l = rule.limits || {};
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const tok = (s) => `<span class="tok">${esc(s)}</span>`;

  const named = rule.accountIds && rule.accountIds.length
    ? rule.accountIds.map((id) => {
        const acc = accounts.find((x) => x.id === id);
        return acc ? `@${acc.handle}` : "an account";
      })
    : (rule.profileIds || []).map((id) => {
        const p = profiles.find((x) => x.id === id);
        return p ? p.name : "a profile";
      });
  const on = named.length
    ? named.slice(0, 3).map(tok).join(", ") + (named.length > 3 ? ` and ${named.length - 3} more` : "")
    : "<b>no accounts yet</b>";

  const terms = (t.terms || []).filter(Boolean);
  let when;
  if (t.type === "keyword" || t.type === "hashtag") {
    when = `a post matches ${esc(MATCH_MODES[t.matchMode] || "any of these terms")} ${terms.map(tok).join(", ") || "<b>(no terms yet)</b>"}`;
  } else if (t.type === "follower") {
    when = "the account gains a follower";
  } else if (t.type === "dm") {
    when = "the account receives a direct message";
  } else {
    when = `someone ${t.type === "reply" ? "replies to" : "mentions"} the account`;
    if (terms.length) when += ` and the text matches ${terms.map(tok).join(", ")}`;
  }

  const excludes = (t.exclude || []).filter(Boolean);
  const filters = [];
  if (excludes.length) filters.push(`skip anything containing ${excludes.map(tok).join(", ")}`);
  if (t.minFollowers) filters.push(`only authors with ${tok(Number(t.minFollowers).toLocaleString() + "+")} followers`);
  if (t.verifiedOnly) filters.push("verified authors only");
  if (t.language) filters.push(`${tok(t.language)} only`);
  if (t.skipReposts) filters.push("ignore reposts");
  if (t.skipReplies) filters.push("ignore replies");

  const actLabel = (ACTIONS[a.type] || ACTIONS.reply).label.toLowerCase();
  let does = actLabel;
  if ((ACTIONS[a.type] || {}).needsMessage) {
    if (a.source === "template" && a.templateIds && a.templateIds.length) {
      const names = a.templateIds
        .map((id) => (templates.find((x) => x.id === id) || {}).name)
        .filter(Boolean);
      does += ` using ${names.length ? names.map(tok).join(" or ") : "a template"}`;
    } else if (a.source === "library" && a.libraryTags && a.libraryTags.length) {
      does += ` built from library entries tagged ${a.libraryTags.map(tok).join(", ")}`;
    } else if (a.source === "text" && a.text) {
      does += ` with ${tok(a.text.slice(0, 60) + (a.text.length > 60 ? "…" : ""))}`;
    } else {
      does += " <b>(no message source set)</b>";
    }
  }

  const caps = [];
  if (l.perHour) caps.push(`${tok(l.perHour + "/hour")}`);
  if (l.perDay) caps.push(`${tok(l.perDay + "/day")}`);
  if (l.cooldownMin) caps.push(`at least ${tok(l.cooldownMin + " min")} apart`);
  if (l.maxPerAuthor) caps.push(`${tok(l.maxPerAuthor + "×")} per author`);
  if (l.activeHours && l.activeHours.enabled) {
    caps.push(`only between ${tok(l.activeHours.from)} and ${tok(l.activeHours.to)}`);
  }

  const approval = (rule.safety || {}).requireApproval
    ? "Actions wait in the inbox for your approval before they go out."
    : "<b>Actions go out automatically, without review.</b>";

  return `On ${on}, when ${when}, ${does}.` +
    (filters.length ? ` Filters: ${filters.join("; ")}.` : "") +
    (caps.length ? ` Capped at ${caps.join(", ")}.` : " <b>No rate caps set.</b>") +
    ` ${approval}`;
}

/** Problems that should stop a rule being enabled. */
export function validateRule(rule) {
  const problems = [];
  if (!rule.name || !rule.name.trim()) problems.push("Give the rule a name.");
  if (!(rule.accountIds || []).length && !(rule.profileIds || []).length) {
    problems.push("Choose at least one account or profile for the rule to act on.");
  }
  const spec = TRIGGERS[(rule.trigger || {}).type];
  if (spec && spec.needsTerms && !(rule.trigger.terms || []).filter(Boolean).length) {
    problems.push("This trigger needs at least one term to match on.");
  }
  const act = ACTIONS[(rule.action || {}).type];
  if (act && act.needsMessage) {
    const a = rule.action;
    const hasSource = (a.source === "template" && (a.templateIds || []).length) ||
                      (a.source === "library" && (a.libraryTags || []).length) ||
                      (a.source === "text" && a.text && a.text.trim());
    if (!hasSource) problems.push("This action sends a message, so it needs a message source.");
  }
  const l = rule.limits || {};
  if (!l.perHour && !l.perDay) {
    problems.push("Set at least an hourly or daily cap — an uncapped rule will get the account limited.");
  }
  return problems;
}

/** Run a rule over sample items and report what it would do. */
export function simulate(rule, items, { recent = [], now = new Date() } = {}) {
  const results = [];
  const fired = [];
  for (const item of items) {
    const m = matches(rule, item);
    if (!m.ok) { results.push({ item, ok: false, reason: m.reason }); continue; }
    const limit = canRunNow(rule, recent.concat(fired), now, item);
    if (!limit.ok) { results.push({ item, ok: false, reason: limit.reason, matched: true }); continue; }
    fired.push({ at: now.toISOString(), ruleId: rule.id, authorHandle: (item.author || {}).handle });
    results.push({ item, ok: true, reason: "would " + (ACTIONS[rule.action.type] || {}).label.toLowerCase() });
  }
  return {
    results,
    wouldAct: results.filter((r) => r.ok).length,
    matchedButHeld: results.filter((r) => !r.ok && r.matched).length,
  };
}
