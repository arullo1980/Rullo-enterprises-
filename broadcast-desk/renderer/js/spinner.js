/**
 * Message generator.
 *
 * This is the part TweetAdder was actually good at: you write one template,
 * it produces a large pool of distinguishable messages so a campaign does not
 * read as the same sentence pasted forty times.
 *
 * Two mechanisms compose:
 *
 *   spintax   {morning|afternoon} — inline alternatives, nestable, with
 *             optional weights: {often^5|rarely^1}
 *   tokens    [keyword:fintech]   — a draw from the keyword/phrase library,
 *             filtered by kind and tag
 *
 * Everything is parsed to an AST once, so counting the size of the pool is
 * exact rather than sampled, and a template with only two real variations
 * cannot quietly pretend to be a hundred.
 */

/* --------------------------------------------------------------- parsing */

const TOKEN_RE = /^\[([a-z][a-z0-9_]*)(?::([^\]]*))?\]/i;

/**
 * Token kinds the generator understands. `library` tokens draw from the
 * keyword/phrase store; the rest come from the posting context.
 */
export const TOKENS = {
  keyword:  { library: "keyword",  desc: "A keyword from the library" },
  phrase:   { library: "phrase",   desc: "A phrase or sentence from the library" },
  hashtag:  { library: "hashtag",  desc: "A hashtag from the library" },
  link:     { library: "link",     desc: "A link from the library" },
  cta:      { library: "cta",      desc: "A call to action from the library" },
  emoji:    { library: "emoji",    desc: "An emoji from the library" },
  handle:   { ctx: "handle",       desc: "The posting account's handle" },
  account:  { ctx: "accountName",  desc: "The posting account's display name" },
  profile:  { ctx: "profileName",  desc: "The profile the post belongs to" },
  platform: { ctx: "platformName", desc: "The network being posted to" },
  date:     { ctx: "date",         desc: "Today's date" },
  time:     { ctx: "time",         desc: "The time the post goes out" },
  day:      { ctx: "day",          desc: "Day of the week" },
  author:   { ctx: "author",       desc: "Author of the post being replied to" },
  subject:  { ctx: "subject",      desc: "Text that triggered a rule" },
};

class ParseError extends Error {}

/**
 * Parse a template into an AST of nodes:
 *   { t: "text",   v }
 *   { t: "token",  name, arg }
 *   { t: "choice", options: [{ nodes, weight }] }
 */
export function parse(template) {
  let i = 0;
  const src = String(template == null ? "" : template);

  function parseSeq(stopAtChoice) {
    const nodes = [];
    let buf = "";
    const flush = () => { if (buf) { nodes.push({ t: "text", v: buf }); buf = ""; } };

    while (i < src.length) {
      const ch = src[i];

      if (ch === "\\" && i + 1 < src.length && "{}|[]\\".includes(src[i + 1])) {
        buf += src[i + 1]; i += 2; continue;                     // escaped literal
      }
      if (stopAtChoice && (ch === "|" || ch === "}")) break;
      if (ch === "{") { flush(); i++; nodes.push(parseChoice()); continue; }
      if (ch === "[") {
        const m = TOKEN_RE.exec(src.slice(i));
        if (m) {
          flush();
          nodes.push({ t: "token", name: m[1].toLowerCase(), arg: (m[2] || "").trim() });
          i += m[0].length;
          continue;
        }
      }
      buf += ch; i++;
    }
    flush();
    return nodes;
  }

  function parseChoice() {
    const options = [];
    for (;;) {
      const nodes = parseSeq(true);
      // A trailing ^n on the last text node is a weight, not content.
      let weight = 1;
      const last = nodes[nodes.length - 1];
      if (last && last.t === "text") {
        const wm = /\^(\d+(?:\.\d+)?)$/.exec(last.v);
        if (wm) { weight = parseFloat(wm[1]); last.v = last.v.slice(0, -wm[0].length); if (!last.v) nodes.pop(); }
      }
      options.push({ nodes, weight });
      if (src[i] === "|") { i++; continue; }
      if (src[i] === "}") { i++; break; }
      throw new ParseError("Unclosed { — every { needs a matching }.");
    }
    return { t: "choice", options };
  }

  const ast = parseSeq(false);
  if (i < src.length) throw new ParseError("Unexpected } — remove it or escape it as \\}.");
  return ast;
}

/** Human-readable problems with a template. Empty array means it is clean. */
export function validate(template, { knownTags = [] } = {}) {
  const problems = [];
  let ast;
  try {
    ast = parse(template);
  } catch (e) {
    return [{ level: "error", message: e.message }];
  }
  walk(ast, (n) => {
    if (n.t === "choice" && n.options.length < 2) {
      problems.push({ level: "warn", message: "A {…} group with only one option adds no variation." });
    }
    if (n.t === "token") {
      const spec = TOKENS[n.name];
      if (!spec) {
        problems.push({ level: "error", message: `Unknown token [${n.name}]. Known: ${Object.keys(TOKENS).join(", ")}.` });
      } else if (spec.library && n.arg && knownTags.length && !knownTags.includes(n.arg)) {
        problems.push({ level: "warn", message: `No library entries are tagged "${n.arg}" yet — [${n.name}:${n.arg}] will render empty.` });
      }
    }
  });
  return problems;
}

function walk(nodes, fn) {
  for (const n of nodes) {
    fn(n);
    if (n.t === "choice") for (const o of n.options) walk(o.nodes, fn);
  }
}

/* -------------------------------------------------------------- counting */

/**
 * Exact size of the message pool.
 *
 * `poolSizes` maps a library token to how many entries it can draw from, e.g.
 * { "keyword:fintech": 12 }. Missing entries count as 1 so the number never
 * inflates on the strength of a library that is not there.
 */
export function countVariations(template, poolSizes = {}) {
  let ast;
  try { ast = parse(template); } catch (e) { return 0; }
  return countNodes(ast, poolSizes);
}

function countNodes(nodes, poolSizes) {
  let total = 1;
  for (const n of nodes) {
    if (n.t === "choice") {
      total *= n.options.reduce((sum, o) => sum + countNodes(o.nodes, poolSizes), 0) || 1;
    } else if (n.t === "token") {
      const spec = TOKENS[n.name];
      if (spec && spec.library) {
        const key = n.arg ? `${spec.library}:${n.arg}` : spec.library;
        total *= Math.max(1, poolSizes[key] || 0);
      }
    }
    if (total > 1e12) return 1e12;   // "effectively unlimited"; stop multiplying
  }
  return total;
}

/** Every library token a template uses, for the UI to show what it depends on. */
export function tokensUsed(template) {
  let ast;
  try { ast = parse(template); } catch (e) { return []; }
  const found = new Map();
  walk(ast, (n) => {
    if (n.t !== "token") return;
    const key = n.arg ? `${n.name}:${n.arg}` : n.name;
    found.set(key, { name: n.name, arg: n.arg, kind: (TOKENS[n.name] || {}).library || null });
  });
  return Array.from(found.values());
}

/* ------------------------------------------------------------- rendering */

function weightedPick(options, rand) {
  const total = options.reduce((s, o) => s + (o.weight || 1), 0);
  let r = rand() * total;
  for (const o of options) {
    r -= (o.weight || 1);
    if (r <= 0) return o;
  }
  return options[options.length - 1];
}

/**
 * Render one message.
 *
 * `ctx.draw(kind, tag)` supplies library values and is where the caller
 * applies its own policy — least-recently-used rotation, per-profile
 * filtering, weighting. `ctx.values` supplies the contextual tokens.
 */
export function spin(template, ctx = {}) {
  const rand = ctx.random || Math.random;
  const draw = ctx.draw || (() => "");
  const values = ctx.values || {};
  let ast;
  try { ast = parse(template); } catch (e) { return String(template || ""); }

  const render = (nodes) => nodes.map((n) => {
    if (n.t === "text") return n.v;
    if (n.t === "choice") return render(weightedPick(n.options, rand).nodes);
    const spec = TOKENS[n.name];
    if (!spec) return `[${n.name}${n.arg ? ":" + n.arg : ""}]`;
    if (spec.library) return draw(spec.library, n.arg) || "";
    const v = values[spec.ctx];
    return v === undefined || v === null ? "" : String(v);
  }).join("");

  return tidy(render(ast));
}

/** Collapse the whitespace and stray punctuation an empty token leaves behind. */
export function tidy(s) {
  return String(s)
    .replace(/[ \t]+/g, " ")
    .replace(/ +([,.!?;:])/g, "$1")
    .replace(/\(\s*\)/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Generate up to `n` messages.
 *
 * With `unique`, duplicates are discarded and generation stops once the pool
 * is visibly exhausted rather than spinning forever on a thin template — the
 * caller gets fewer messages and an honest `exhausted` flag instead of a hang.
 */
export function generate(template, ctx = {}, n = 10, { unique = true, maxAttempts } = {}) {
  const out = [];
  const seen = new Set();
  const cap = maxAttempts || Math.max(60, n * 25);
  let attempts = 0;

  while (out.length < n && attempts < cap) {
    attempts++;
    const text = spin(template, ctx);
    if (!text) continue;
    if (unique) {
      const key = text.toLowerCase().replace(/\s+/g, " ");
      if (seen.has(key)) continue;
      seen.add(key);
    }
    out.push(text);
  }
  return { messages: out, exhausted: out.length < n, attempts };
}

/* ----------------------------------------------- library draw strategies */

/**
 * Build a `draw` function over library rows that rotates rather than repeats:
 * entries are bucketed by kind+tag, and each bucket is shuffled and consumed
 * before it refills. Two posts in a row therefore rarely reuse a keyword, the
 * way a hand-written campaign would not.
 *
 * `filter` narrows the library to what a given profile/platform may use.
 */
export function makeDraw(libraryRows, { filter, random = Math.random } = {}) {
  const rows = (libraryRows || []).filter((r) => (filter ? filter(r) : true));
  const buckets = new Map();
  const used = new Map();

  const bucketFor = (kind, tag) => {
    const key = tag ? `${kind}:${tag}` : kind;
    if (!buckets.has(key)) {
      const pool = rows.filter((r) => r.kind === kind && (!tag || (r.tags || []).includes(tag)));
      buckets.set(key, pool);
    }
    return { key, pool: buckets.get(key) };
  };

  const draw = (kind, tag) => {
    const { key, pool } = bucketFor(kind, tag);
    if (!pool.length) return "";
    let remaining = used.get(key);
    if (!remaining || !remaining.length) {
      remaining = shuffle(pool.slice(), random);
      // Weighted entries appear more than once in the rotation.
      remaining = remaining.flatMap((r) => Array(Math.max(1, Math.min(5, r.weight || 1))).fill(r));
      used.set(key, remaining);
    }
    const row = remaining.pop();
    draw.picked.push(row);
    return row.text;
  };

  draw.picked = [];          // lets the caller bump useCount/lastUsed afterwards
  draw.sizes = () => {
    const sizes = {};
    for (const r of rows) {
      sizes[r.kind] = (sizes[r.kind] || 0) + 1;
      for (const t of r.tags || []) sizes[`${r.kind}:${t}`] = (sizes[`${r.kind}:${t}`] || 0) + 1;
    }
    return sizes;
  };
  return draw;
}

function shuffle(arr, random) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** Context values for a specific account/profile/time. */
export function contextValues({ account, profile, platformName, at }) {
  const when = at ? new Date(at) : new Date();
  return {
    handle: account ? account.handle : "",
    accountName: account ? (account.displayName || account.handle) : "",
    profileName: profile ? profile.name : "",
    platformName: platformName || "",
    date: when.toLocaleDateString(undefined, { month: "long", day: "numeric" }),
    time: when.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }),
    day: when.toLocaleDateString(undefined, { weekday: "long" }),
    author: "",
    subject: "",
  };
}
