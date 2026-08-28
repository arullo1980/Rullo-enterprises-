/**
 * Queue — everything scheduled, sent or failed.
 *
 * The queue runs in one of two places. With a backend, the Worker's cron sends
 * on schedule whether or not anyone is looking. Without one, this tab is the
 * runner: it checks every half minute while it is open, and says so plainly
 * rather than letting you believe posts will go out overnight.
 */

import * as store from "../store.js";
import { platform } from "../../../shared/platforms.js";
import { send, resolve, toQueueEntries, toLocalEntries } from "../dispatch.js";
import { byDay, nextUp, due } from "../scheduler.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  platformMark, emptyState, relTime, fmtDateTime, fmtTime, plural, toLocalInput, $,
} from "../ui.js";

export const title = "Queue";
export const subtitle = () => {
  const posts = store.all("posts");
  const q = posts.filter((p) => p.status === "queued");
  const next = nextUp(posts);
  return q.length
    ? `${plural(q.length, "post")} waiting${next ? ` · next ${relTime(next.scheduledAt)}` : ""}`
    : "Nothing scheduled";
};
export const actions = () => `
  <button class="btn" data-run>Send due now</button>
  ${api.relayConfigured() ? '<button class="btn" data-sync>Sync relay</button>' : ""}
  <a class="btn btn-primary" href="#/compose">Compose</a>`;

let tab = "upcoming";
let month = new Date();

export function render(root, ctx) {
  const accounts = store.all("accounts");
  const visible = store.all("posts").filter((p) => {
    if (ctx.scopeProfileId === "all") return true;
    return (p.accountIds || []).some((id) => {
      const a = accounts.find((x) => x.id === id);
      return a && a.profileId === ctx.scopeProfileId;
    });
  });

  const buckets = {
    upcoming: visible.filter((p) => p.status === "queued"),
    sent: visible.filter((p) => p.status === "sent" || p.status === "partial"),
    failed: visible.filter((p) => p.status === "failed"),
    all: visible,
  };
  const rows = (buckets[tab] || []).slice().sort((a, b) => {
    const at = new Date(a.scheduledAt || a.sentAt || a.createdAt);
    const bt = new Date(b.scheduledAt || b.sentAt || b.createdAt);
    return tab === "upcoming" ? at - bt : bt - at;
  });

  mount(root, html`
    <div class="notice ${api.relayConfigured() ? "info" : ""}" style="margin-bottom:1rem" id="ownerNote"></div>

    <section class="card">
      <div class="card-head">
        <div class="tabs" style="border:0">
          <button data-tab="upcoming" aria-selected="${tab === "upcoming"}">Upcoming (${buckets.upcoming.length})</button>
          <button data-tab="sent" aria-selected="${tab === "sent"}">Sent (${buckets.sent.length})</button>
          <button data-tab="failed" aria-selected="${tab === "failed"}">Failed (${buckets.failed.length})</button>
          <button data-tab="all" aria-selected="${tab === "all"}">All (${buckets.all.length})</button>
        </div>
        <span class="spacer"></span>
        ${buckets.upcoming.length ? html`<button class="btn btn-sm btn-danger" data-clear-queue>Cancel all queued</button>` : raw("")}
      </div>

      ${rows.length ? html`
        <div class="card-body tight">
          <table>
            <thead>
              <tr><th>When</th><th>Message</th><th>Accounts</th><th>Status</th><th class="actions"></th></tr>
            </thead>
            <tbody>
              ${rows.map((p) => row(p, accounts))}
            </tbody>
          </table>
        </div>`
        : emptyState(
            tab === "upcoming" ? "Nothing scheduled" : `No ${tab} posts`,
            tab === "upcoming" ? "Compose a post and schedule it, or build a drip campaign." : "",
            tab === "upcoming" ? `<a class="btn btn-primary" href="#/compose">Compose</a>` : "")}
    </section>

    <section class="card">
      <div class="card-head">
        <h2>${month.toLocaleDateString(undefined, { month: "long", year: "numeric" })}</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm" data-month="-1">←</button>
        <button class="btn btn-sm" data-month="0">Today</button>
        <button class="btn btn-sm" data-month="1">→</button>
      </div>
      <div class="card-body">${calendar(visible)}</div>
    </section>
  `);

  on(ctx.scope, "click", "[data-tab]", (e, t) => { tab = t.dataset.tab; ctx.refresh(); });
  on(ctx.scope, "click", "[data-month]", (e, t) => {
    const d = Number(t.dataset.month);
    month = d === 0 ? new Date() : new Date(month.getFullYear(), month.getMonth() + d, 1);
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-detail]", (e, t) => detail(store.get("posts", t.dataset.detail), ctx));
  on(ctx.scope, "click", "[data-sendnow]", async (e, t) => {
    const p = store.get("posts", t.dataset.sendnow);
    t.disabled = true;
    const done = await send(p);
    const ok = (done.results || []).filter((r) => r.ok).length;
    toast(`${ok}/${(done.results || []).length} accounts ${done.simulated ? "simulated" : "posted"}`, ok ? "ok" : "bad");
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-reschedule]", (e, t) => reschedule(store.get("posts", t.dataset.reschedule), ctx));
  on(ctx.scope, "click", "[data-cancel]", async (e, t) => {
    const p = store.get("posts", t.dataset.cancel);
    if (!await confirmDialog("Cancel this post?", "It is removed from the queue.", "Cancel post")) return;
    await store.remove("posts", p.id);
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-retry]", async (e, t) => {
    const p = store.get("posts", t.dataset.retry);
    await store.put("posts", { ...p, status: "queued", scheduledAt: new Date().toISOString(), results: [] });
    toast("Back in the queue");
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-clear-queue]", async () => {
    const q = store.where("posts", (p) => p.status === "queued");
    if (!await confirmDialog(`Cancel ${q.length} queued posts?`, "This cannot be undone.", "Cancel them")) return;
    for (const p of q) await store.remove("posts", p.id);
    toast(`Cancelled ${q.length} posts`);
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-run]", () => runDue(ctx, true));
  on(ctx.scope, "click", "[data-sync]", () => syncRelay(ctx, true));

  handOver(ctx);
}

function row(p, accounts) {
  const when = p.scheduledAt || p.sentAt || p.createdAt;
  const accts = (p.accountIds || []).map((id) => accounts.find((a) => a.id === id)).filter(Boolean);
  const text = p.renderedText || p.body || "";
  const badge = {
    queued: "", sending: "info", sent: "ok", partial: "warn", failed: "bad",
  }[p.status] || "";
  const okCount = (p.results || []).filter((r) => r.ok).length;

  return html`
    <tr>
      <td class="nowrap">
        <div>${fmtDateTime(when)}</div>
        <div class="small muted">${relTime(when)}</div>
      </td>
      <td>
        <div class="trunc" style="max-width:38ch">${text}</div>
        ${p.origin === "drip" ? html`<span class="badge">drip</span>` : raw("")}
        ${p.origin === "rule" ? html`<span class="badge info">rule</span>` : raw("")}
        ${p.simulated ? html`<span class="badge warn">simulated</span>` : raw("")}
      </td>
      <td>
        <div class="row tight">
          ${accts.slice(0, 5).map((a) => platformMark(platform(a.platform), "sm"))}
          ${accts.length > 5 ? html`<span class="small muted">+${accts.length - 5}</span>` : raw("")}
        </div>
      </td>
      <td>
        <span class="badge ${badge}">${p.status}</span>
        ${p.results && p.results.length ? html`<div class="small muted">${okCount}/${p.results.length} ok</div>` : raw("")}
      </td>
      <td class="actions">
        <button class="btn btn-sm btn-ghost" data-detail="${p.id}">Details</button>
        ${p.status === "queued" ? html`
          <button class="btn btn-sm" data-sendnow="${p.id}">Send now</button>
          <button class="btn btn-sm btn-ghost" data-reschedule="${p.id}">Time</button>
          <button class="btn btn-sm btn-ghost" data-cancel="${p.id}">✕</button>` : raw("")}
        ${p.status === "failed" || p.status === "partial" ? html`
          <button class="btn btn-sm" data-retry="${p.id}">Requeue</button>` : raw("")}
      </td>
    </tr>`;
}

function calendar(posts) {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const map = byDay(posts.filter((p) => p.scheduledAt || p.sentAt).map((p) => ({ ...p, scheduledAt: p.scheduledAt || p.sentAt })));
  const todayKey = keyOf(new Date());

  const cells = [];
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getTime() + i * 864e5);
    const key = keyOf(d);
    const items = map.get(key) || [];
    cells.push(html`
      <div class="day ${d.getMonth() !== month.getMonth() ? "off" : ""} ${key === todayKey ? "today" : ""}">
        <span class="dnum">${d.getDate()}</span>
        ${items.slice(0, 4).map((p) => html`
          <div class="ev ${p.status === "sent" || p.status === "partial" ? "sent" : p.status === "failed" ? "failed" : ""}"
               data-detail="${p.id}" title="${(p.renderedText || p.body || "").slice(0, 120)}">
            ${fmtTime(p.scheduledAt)} ${(p.renderedText || p.body || "").slice(0, 24)}
          </div>`)}
        ${items.length > 4 ? html`<div class="small muted" style="padding-left:.2rem">+${items.length - 4} more</div>` : raw("")}
      </div>`);
  }
  return html`
    <div class="cal">
      ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => html`<div class="dow">${d}</div>`)}
      ${cells}
    </div>`;
}

function keyOf(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* --------------------------------------------------------------- details */

async function detail(post, ctx) {
  if (!post) return;
  const preview = post.status === "queued" ? resolve(post) : null;
  await modal({
    title: "Post detail",
    wide: true,
    body: html`
      <div class="small muted" style="margin-bottom:.6rem">
        ${post.status === "queued" ? "Scheduled for " : "Sent "}${fmtDateTime(post.scheduledAt || post.sentAt)}
        · ${post.origin || "composer"}
      </div>
      <div class="field">
        <label class="label">Template</label>
        <div class="preview"><div class="ptext">${post.body}</div></div>
      </div>
      ${preview ? html`
        <div class="field">
          <label class="label">How it will render</label>
          ${preview.map((r) => html`
            <div class="preview">
              <div class="row tight">
                ${r.account ? platformMark(platform(r.account.platform), "sm") : raw("")}
                <b class="small">${r.account ? "@" + r.account.handle : "missing account"}</b>
                <span class="spacer"></span>
                ${r.problems.length ? html`<span class="badge bad">blocked</span>` : html`<span class="badge ok">ready</span>`}
              </div>
              <div class="ptext">${r.text}</div>
              ${r.problems.length ? html`<div class="small" style="color:var(--stamp)">${r.problems.join(" ")}</div>` : raw("")}
            </div>`)}
        </div>` : raw("")}
      ${(post.results || []).length ? html`
        <div class="field">
          <label class="label">Results</label>
          <table>
            <thead><tr><th>Account</th><th>Result</th><th>Text</th></tr></thead>
            <tbody>
              ${post.results.map((r) => {
                const a = store.get("accounts", r.accountId);
                return html`<tr>
                  <td class="mono-sm">${a ? "@" + a.handle : r.accountId}</td>
                  <td>${r.ok
                    ? html`<span class="badge ${r.simulated ? "warn" : "ok"}">${r.simulated ? "simulated" : "posted"}</span>
                           ${r.url ? html` <a href="${r.url}" target="_blank" rel="noopener">view</a>` : raw("")}`
                    : html`<span class="badge bad">failed</span> <span class="small">${r.error || ""}</span>`}</td>
                  <td class="small trunc" style="max-width:30ch">${r.text || ""}</td>
                </tr>`;
              })}
            </tbody>
          </table>
        </div>` : raw("")}`,
    actions: [{ label: "Close", value: "__cancel" }],
  });
  ctx.refresh();
}

async function reschedule(post, ctx) {
  const v = await modal({
    title: "Reschedule",
    body: html`
      <div class="field">
        <label class="label" for="r-when">Send at</label>
        <input id="r-when" name="when" type="datetime-local" value="${toLocalInput(post.scheduledAt || new Date())}" />
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Save", value: "go", primary: true }],
  });
  if (v !== "go") return;
  const f = formData(document.getElementById("modal"));
  await store.put("posts", { ...post, scheduledAt: new Date(f.when).toISOString() });
  toast("Rescheduled");
  ctx.refresh();
}

/* ------------------------------------------------------------- schedulers */

/**
 * Two senders, and never the same post twice.
 *
 * Accounts marked *unattended* have a copy of their token in the relay, so the
 * relay's cron owns their posts and they go out with this machine off.
 * Everything else belongs to the scheduler inside this app, which keeps
 * running in the tray after the window is closed.
 */
async function handOver(ctx) {
  const queued = store.where("posts", (p) => p.status === "queued" && p.scheduledAt);
  const local = toLocalEntries(queued);
  await api.setLocalQueue(local);

  const note = ctx.scope.querySelector("#ownerNote");
  const state = await api.schedulerState();
  const relayCount = api.relayConfigured() ? toQueueEntries(queued).length : 0;
  if (note) {
    note.innerHTML = api.relayConfigured()
      ? `<b>${relayCount}</b> post${relayCount === 1 ? "" : "s"} handed to the relay — those go out with this machine off. ` +
        `<b>${local.length}</b> stay${local.length === 1 ? "s" : ""} here, sent while Broadcast Desk is running (the tray keeps it running after you close the window).`
      : `<b>No relay configured.</b> All ${local.length} scheduled post${local.length === 1 ? "" : "s"} are sent by this app, ` +
        `which has to be running — it stays in the tray after you close the window. Set up the relay to send with the machine off.`;
  }
  if (api.relayConfigured()) await syncRelay(ctx, false);
  return state;
}

/** Hand the unattended half over, and collect what the cron already sent. */
async function syncRelay(ctx, loud) {
  const queued = store.where("posts", (p) => p.status === "queued" && p.scheduledAt);
  try {
    const entries = toQueueEntries(queued);
    const r = await api.syncQueue(entries);

    const back = await api.fetchQueueResults(store.settings().lastResultSync || undefined);
    let applied = 0;
    for (const res of (back.results || [])) {
      const post = store.get("posts", res.postId);
      if (!post || post.status !== "queued") continue;
      const ok = (res.results || []).filter((x) => x.ok).length;
      await store.put("posts", {
        ...post,
        status: ok === res.results.length ? "sent" : ok ? "partial" : "failed",
        sentAt: res.sentAt,
        results: res.results,
      });
      applied++;
    }
    if (back.results && back.results.length) {
      await store.saveSettings({ lastResultSync: new Date().toISOString() });
    }
    if (loud) toast(`Handed ${r.synced} to the relay${applied ? ` · ${applied} already sent` : ""}`, "ok", 5000);
    if (applied) ctx.refresh();
  } catch (e) {
    if (loud) toast("Relay sync failed: " + e.message, "bad", 5000);
  }
}

/**
 * Send what is due right now, from this app. Serial, and spaced by the main
 * process — a burst from one desk is the pattern networks act on.
 */
async function runDue(ctx, manual) {
  const ready = due(store.all("posts"));
  if (!ready.length) {
    if (manual) toast("Nothing is due");
    return;
  }
  for (const p of ready) {
    await store.put("posts", { ...p, status: "sending" });
    await send(store.get("posts", p.id));
  }
  toast(`Sent ${plural(ready.length, "due post")}`, "ok");
  ctx.refresh();
}
