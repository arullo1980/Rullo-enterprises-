/**
 * Boot, routing and chrome.
 *
 * Views are ES modules loaded on demand. Each exports:
 *   title              string
 *   subtitle(ctx)      optional string for the top bar
 *   actions(ctx)       optional markup for the top-bar buttons
 *   render(root, ctx)  paints into <main id="view">
 */

import * as store from "./store.js";
import { seedIfEmpty } from "./seed.js";
import { $, html, raw, mount } from "./ui.js";
import { health } from "./api.js";

const ROUTES = [
  { path: "dashboard", group: "Desk",      label: "Dashboard", icon: "grid",     mod: () => import("./views/dashboard.js") },
  { path: "compose",   group: "Desk",      label: "Compose",   icon: "pencil",   mod: () => import("./views/composer.js") },
  { path: "queue",     group: "Desk",      label: "Queue",     icon: "clock",    mod: () => import("./views/queue.js") },
  { path: "inbox",     group: "Desk",      label: "Inbox",     icon: "inbox",    mod: () => import("./views/inbox.js") },
  { path: "library",   group: "Content",   label: "Library",   icon: "book",     mod: () => import("./views/library.js") },
  { path: "rules",     group: "Automation",label: "Rules",     icon: "bolt",     mod: () => import("./views/rules.js") },
  { path: "profiles",  group: "Accounts",  label: "Profiles",  icon: "users",    mod: () => import("./views/profiles.js") },
  { path: "accounts",  group: "Accounts",  label: "Connections", icon: "link",   mod: () => import("./views/accounts.js") },
  { path: "settings",  group: "Accounts",  label: "Settings",  icon: "cog",      mod: () => import("./views/settings.js") },
];

const ICONS = {
  grid:   "M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z",
  pencil: "M4 20h4L20 8l-4-4L4 16z",
  clock:  "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 7v5l3 2",
  inbox:  "M3 13h5l1 3h6l1-3h5M3 13l3-8h12l3 8v6H3z",
  book:   "M4 4h9a3 3 0 0 1 3 3v13a3 3 0 0 0-3-3H4zM20 4h-1a3 3 0 0 0-3 3v13a3 3 0 0 1 3-3h1z",
  bolt:   "M13 2 4 14h6l-1 8 9-12h-6z",
  users:  "M8 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2 20c0-3.3 2.7-5 6-5s6 1.7 6 5M17 11a3 3 0 1 0 0-6M18 20c0-2.4-.9-3.9-2.4-4.7",
  link:   "M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1",
  cog:    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 2.6 14H2.4a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 4.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 2.6V2.4a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.6 1h.2a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1z",
};

function icon(name) {
  return raw(`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${ICONS[name] || ICONS.grid}"/></svg>`);
}

/* ------------------------------------------------------------------ state */

let scopeProfileId = localStorage.getItem("bd.scope") || "all";
let current = null;

function ctx(scope) {
  return {
    /** The element a view binds delegated handlers to: top bar plus body. */
    scope,
    scopeProfileId,
    profile: scopeProfileId === "all" ? null : store.get("profiles", scopeProfileId),
    /** Accounts visible under the current working profile. */
    accounts: () => scopeProfileId === "all"
      ? store.all("accounts")
      : store.where("accounts", (a) => a.profileId === scopeProfileId),
    profiles: () => store.all("profiles"),
    go,
    refresh: () => paint(location.hash),
    params: new URLSearchParams((location.hash.split("?")[1] || "")),
  };
}

export function go(path) {
  location.hash = "#/" + path.replace(/^#?\/?/, "");
}

/* ------------------------------------------------------------------- nav */

function renderNav() {
  const groups = [];
  for (const r of ROUTES) {
    let g = groups.find((x) => x.name === r.group);
    if (!g) { g = { name: r.group, items: [] }; groups.push(g); }
    g.items.push(r);
  }
  const now = location.hash.replace(/^#\//, "").split("?")[0] || "dashboard";
  mount($("#nav"), html`${groups.map((g) => html`
    <div class="rail-group">${g.name}</div>
    ${g.items.map((r) => html`
      <a href="#/${r.path}" ${raw(r.path === now ? 'aria-current="page"' : "")}>
        ${icon(r.icon)}<span>${r.label}</span>${raw(navBadge(r.path))}
      </a>`)}
  `)}`);
}

function navBadge(path) {
  if (path === "queue") {
    const n = store.where("posts", (p) => p.status === "queued").length;
    return n ? `<span class="badge">${n}</span>` : "";
  }
  if (path === "inbox") {
    const n = store.where("inbox", (i) => i.status === "pending").length;
    return n ? `<span class="badge warn">${n}</span>` : "";
  }
  return "";
}

function renderScope() {
  const sel = $("#scope");
  const profiles = store.all("profiles");
  mount(sel, html`
    <option value="all">All profiles (${profiles.length})</option>
    ${profiles.map((p) => html`<option value="${p.id}" ${raw(p.id === scopeProfileId ? "selected" : "")}>${p.name}</option>`)}
  `);
  if (scopeProfileId !== "all" && !profiles.some((p) => p.id === scopeProfileId)) {
    scopeProfileId = "all";
    sel.value = "all";
  }
}

/* ---------------------------------------------------------------- routing */

async function paint(hash) {
  const path = (hash || "").replace(/^#\//, "").split("?")[0] || "dashboard";
  const route = ROUTES.find((r) => r.path === path) || ROUTES[0];

  renderNav();

  // A fresh scope per navigation. Views attach delegated listeners to it, so
  // they are discarded with it rather than piling up over repeated renders.
  const scope = $("#viewScope");
  mount(scope, html`
    <header class="topbar">
      <button class="btn btn-sm rail-toggle" id="railBtn" aria-label="Open navigation">☰</button>
      <div>
        <h1 id="viewTitle">${route.label}</h1>
        <div class="sub" id="viewSub"></div>
      </div>
      <span class="spacer"></span>
      <div class="row tight" id="viewActions"></div>
    </header>
    <main class="view" id="view" tabindex="-1"><div class="empty">Loading…</div></main>
  `);
  const root = $("#view", scope);

  try {
    const mod = await route.mod();
    current = { route, mod };
    const c = ctx(scope);
    $("#viewTitle", scope).textContent = mod.title || route.label;
    $("#viewSub", scope).innerHTML = mod.subtitle ? String(mod.subtitle(c)) : "";
    $("#viewActions", scope).innerHTML = mod.actions ? String(mod.actions(c)) : "";
    root.innerHTML = "";
    await mod.render(root, c);
    document.title = `${mod.title || route.label} — Broadcast Desk`;
  } catch (e) {
    console.error(e);
    mount(root, html`<div class="notice bad"><strong>That section failed to load.</strong><br>${e.message}</div>`);
  }
  document.body.classList.remove("rail-open");
}

/* ------------------------------------------------------------------ boot */

async function boot() {
  await store.init();
  await seedIfEmpty();

  const s = store.settings();
  if (s.theme && s.theme !== "system") document.documentElement.setAttribute("data-theme", s.theme);

  renderScope();
  renderNav();

  $("#scope").addEventListener("change", (e) => {
    scopeProfileId = e.target.value;
    localStorage.setItem("bd.scope", scopeProfileId);
    paint(location.hash);
  });

  $("#themeBtn").addEventListener("click", async () => {
    const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("bd.theme", next);
    await store.saveSettings({ theme: next });
  });

  document.body.addEventListener("click", (e) => {
    if (e.target.closest("#railBtn")) document.body.classList.toggle("rail-open");
  });
  document.addEventListener("click", (e) => {
    if (document.body.classList.contains("rail-open") &&
        !e.target.closest(".rail") && !e.target.closest("#railBtn")) {
      document.body.classList.remove("rail-open");
    }
  });

  window.addEventListener("hashchange", () => paint(location.hash));

  // Re-render the nav counters whenever the data behind them moves.
  store.subscribe((change) => {
    if (["posts", "inbox", "profiles"].includes(change.collection) || change.collection === "*") {
      renderNav();
      if (change.collection === "profiles" || change.collection === "*") renderScope();
    }
  });

  // Keyboard: g then a letter jumps around, like every console worth using.
  let pending = null;
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "g") { pending = setTimeout(() => { pending = null; }, 900); return; }
    if (pending) {
      const jump = { d: "dashboard", c: "compose", q: "queue", i: "inbox", l: "library", r: "rules", p: "profiles", a: "accounts", s: "settings" }[e.key];
      clearTimeout(pending); pending = null;
      if (jump) { e.preventDefault(); go(jump); }
    }
  });

  await paint(location.hash || "#/dashboard");
  updateConnState();

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    navigator.serviceWorker.register("/app/sw.js").catch(() => {});
  }
}

async function updateConnState() {
  const badge = $("#connState");
  const h = await health();
  if (h.mode === "live") { badge.textContent = "live"; badge.className = "badge ok"; badge.title = "Connected to the posting backend"; }
  else if (h.mode === "unauthorised") { badge.textContent = "bad key"; badge.className = "badge bad"; badge.title = h.error || ""; }
  else if (h.mode === "error") { badge.textContent = "backend down"; badge.className = "badge bad"; badge.title = h.error || ""; }
  else { badge.textContent = "dry run"; badge.className = "badge warn"; badge.title = "No backend configured — posts are simulated, nothing is published"; }
}

window.addEventListener("error", (e) => {
  if (e.message && e.message.includes("ResizeObserver")) return;
  console.error(e.error || e.message);
});

boot().catch((e) => {
  console.error(e);
  document.getElementById("view").innerHTML =
    `<div class="notice bad"><strong>Broadcast Desk could not start.</strong><br>${e.message}</div>`;
});

export { ctx, updateConnState };
