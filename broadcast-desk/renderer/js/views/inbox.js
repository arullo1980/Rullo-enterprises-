/**
 * Inbox — what the rules found, and what they want to do about it.
 *
 * Rules do not fire straight at the network by default. They match, draft the
 * action, and put it here for a yes or no. That single step is what separates
 * "automation that saves an hour" from "automation that loses an account",
 * and it is the only sane default when the account belongs to a client.
 */

import * as store from "../store.js";
import { platform } from "../../../shared/platforms.js";
import { matches, canRunNow, ACTIONS } from "../rules.js";
import { spin, makeDraw, contextValues } from "../spinner.js";
import { sampleFeed } from "../seed.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, confirmDialog, toast, modal,
  platformMark, emptyState, relTime, plural, $$,
} from "../ui.js";

export const title = "Inbox";
export const subtitle = () => {
  const pending = store.where("inbox", (i) => i.status === "pending").length;
  const staged = store.where("inbox", (i) => i.status === "staged").length;
  return staged ? `${plural(staged, "action")} waiting for approval` : `${plural(pending, "item")} to review`;
};
export const actions = () => `
  <button class="btn" data-load>Refresh feed</button>
  <button class="btn btn-primary" data-runrules>Run rules</button>`;

let tab = "staged";

export function render(root, ctx) {
  const accounts = store.all("accounts");
  const items = store.all("inbox")
    .filter((i) => {
      if (ctx.scopeProfileId === "all") return true;
      const a = accounts.find((x) => x.id === i.accountId);
      return a && a.profileId === ctx.scopeProfileId;
    })
    .sort((a, b) => new Date(b.at) - new Date(a.at));

  const buckets = {
    staged: items.filter((i) => i.status === "staged"),
    pending: items.filter((i) => i.status === "pending"),
    done: items.filter((i) => i.status === "done" || i.status === "rejected"),
  };
  const rows = buckets[tab] || [];

  mount(root, html`
    ${api.relayConfigured() ? raw("") : html`
      <div class="notice" style="margin-bottom:1rem">
        <b>No relay, so no live feed.</b> Mentions and replies are collected by the
        relay. Load sample items to try the rules end to end in the meantime.
      </div>`}

    <section class="card">
      <div class="card-head">
        <div class="tabs" style="border:0">
          <button data-tab="staged" aria-selected="${tab === "staged"}">Awaiting approval (${buckets.staged.length})</button>
          <button data-tab="pending" aria-selected="${tab === "pending"}">Unmatched (${buckets.pending.length})</button>
          <button data-tab="done" aria-selected="${tab === "done"}">Handled (${buckets.done.length})</button>
        </div>
        <span class="spacer"></span>
        ${tab === "staged" && rows.length ? html`
          <button class="btn btn-sm btn-primary" data-approve-all>Approve all ${rows.length}</button>
          <button class="btn btn-sm btn-danger" data-reject-all>Reject all</button>` : raw("")}
        ${tab === "done" && rows.length ? html`<button class="btn btn-sm btn-ghost" data-clear-done>Clear</button>` : raw("")}
      </div>

      ${rows.length ? html`<div class="card-body tight">${rows.map((i) => item(i, accounts))}</div>`
        : emptyState(
            tab === "staged" ? "Nothing waiting" : tab === "pending" ? "Nothing unmatched" : "Nothing handled yet",
            tab === "staged" ? "Run the rules against the feed to stage actions." : "",
            tab === "staged" ? `<button class="btn" data-load>Load sample items</button>` : "")}
    </section>
  `);

  on(ctx.scope, "click", "[data-tab]", (e, t) => { tab = t.dataset.tab; ctx.refresh(); });
  on(ctx.scope, "click", "[data-load]", () => loadFeed(ctx));
  on(ctx.scope, "click", "[data-runrules]", () => runRules(ctx));
  on(ctx.scope, "click", "[data-approve]", (e, t) => approve([store.get("inbox", t.dataset.approve)], ctx));
  on(ctx.scope, "click", "[data-reject]", async (e, t) => {
    const i = store.get("inbox", t.dataset.reject);
    await store.put("inbox", { ...i, status: "rejected", handledAt: new Date().toISOString() });
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-edit-text]", (e, t) => editText(store.get("inbox", t.dataset.editText), ctx));
  on(ctx.scope, "click", "[data-respin]", async (e, t) => {
    const i = store.get("inbox", t.dataset.respin);
    const rule = store.get("rules", (i.proposed || {}).ruleId);
    if (!rule) { toast("The rule behind this is gone", "bad"); return; }
    const text = draftMessage(rule, i);
    await store.put("inbox", { ...i, proposed: { ...i.proposed, text } });
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-approve-all]", async () => {
    const staged = store.where("inbox", (i) => i.status === "staged");
    if (!await confirmDialog(`Approve ${staged.length} actions?`, "They go out one after another, spaced by each rule's minimum gap.", "Approve all")) return;
    await approve(staged, ctx);
  });
  on(ctx.scope, "click", "[data-reject-all]", async () => {
    const staged = store.where("inbox", (i) => i.status === "staged");
    for (const i of staged) await store.put("inbox", { ...i, status: "rejected", handledAt: new Date().toISOString() });
    toast(`Rejected ${staged.length}`);
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-clear-done]", async () => {
    const done = store.where("inbox", (i) => i.status === "done" || i.status === "rejected");
    for (const i of done) await store.remove("inbox", i.id);
    ctx.refresh();
  });
}

function item(i, accounts) {
  const acc = accounts.find((a) => a.id === i.accountId);
  const pl = platform(i.platform || (acc && acc.platform));
  const rule = i.proposed ? store.get("rules", i.proposed.ruleId) : null;
  return html`
    <div class="list-row" style="align-items:flex-start">
      <div style="flex:1;min-width:0">
        <div class="row tight">
          ${platformMark(pl, "sm")}
          <b class="small">@${(i.author || {}).handle || "unknown"}</b>
          ${(i.author || {}).verified ? html`<span class="badge info">verified</span>` : raw("")}
          <span class="small muted">${((i.author || {}).followers || 0).toLocaleString()} followers</span>
          <span class="small muted">· ${relTime(i.at)}</span>
          <span class="badge">${i.kind}</span>
          ${acc ? html`<span class="small muted">→ @${acc.handle}</span>` : raw("")}
        </div>
        <div class="small" style="margin:.35rem 0">${i.text || html`<span class="muted">(no text)</span>`}</div>
        ${i.proposed ? html`
          <div class="preview" style="margin-top:.4rem">
            <div class="row tight">
              <span class="badge info">${(ACTIONS[i.proposed.actionType] || {}).label || i.proposed.actionType}</span>
              <span class="small muted">${rule ? rule.name : "rule deleted"}</span>
            </div>
            ${i.proposed.text ? html`<div class="ptext">${i.proposed.text}</div>` : raw("")}
          </div>` : raw("")}
        ${i.result ? html`<div class="small ${i.result.ok ? "muted" : ""}" style="margin-top:.35rem;${i.result.ok ? "" : "color:var(--stamp)"}">
          ${i.result.ok ? (i.result.simulated ? "simulated" : "sent") : "failed: " + (i.result.error || "")}</div>` : raw("")}
      </div>
      <div class="row tight" style="flex:none">
        ${i.status === "staged" ? html`
          ${i.proposed && i.proposed.text ? html`
            <button class="btn btn-sm btn-ghost" data-respin="${i.id}" title="Spin a different version">↻</button>
            <button class="btn btn-sm btn-ghost" data-edit-text="${i.id}">Edit</button>` : raw("")}
          <button class="btn btn-sm btn-primary" data-approve="${i.id}">Approve</button>
          <button class="btn btn-sm btn-ghost" data-reject="${i.id}">✕</button>` : raw("")}
        ${i.status === "rejected" ? html`<span class="badge">rejected</span>` : raw("")}
        ${i.status === "done" ? html`<span class="badge ok">done</span>` : raw("")}
      </div>
    </div>`;
}

/* ------------------------------------------------------------------ feed */

async function loadFeed(ctx) {
  const accounts = store.all("accounts");
  if (api.relayConfigured()) {
    try {
      // The Worker knows connections, not the desk's account ids, so map both ways.
      const linked = accounts.filter((a) => a.connectionId);
      const byConnection = Object.fromEntries(linked.map((a) => [a.connectionId, a.id]));
      const since = store.all("inbox").reduce((max, i) => (i.at > max ? i.at : max), "");
      const r = await api.fetchFeed({ connectionIds: linked.map((a) => a.connectionId), since: since || undefined });
      const incoming = (r.items || [])
        .filter((i) => i.kind !== "error")
        .filter((i) => !store.get("inbox", i.id))
        .map((i) => ({ ...i, accountId: byConnection[i.connectionId] || null }));
      for (const err of (r.items || []).filter((i) => i.kind === "error")) toast(err.text, "bad", 6000);
      if (!incoming.length) { toast("Nothing new"); return; }
      await store.putMany("inbox", incoming.map((i) => ({ ...i, status: "pending" })));
      toast(`Pulled ${incoming.length} items`, "ok");
    } catch (e) {
      toast("Feed failed: " + e.message, "bad", 5000);
    }
  } else {
    if (!accounts.length) { toast("Add an account first", "bad"); return; }
    await store.putMany("inbox", sampleFeed(accounts).map((i) => ({ ...i, status: "pending" })));
    toast("Loaded sample items");
  }
  ctx.refresh();
}

/* ------------------------------------------------------------- rule pass */

/**
 * Evaluate every enabled rule against everything unmatched. First rule to
 * claim an item wins, so two overlapping rules cannot both reply to the same
 * mention.
 */
async function runRules(ctx) {
  const rules = store.all("rules").filter((r) => r.enabled);
  if (!rules.length) { toast("No active rules", "bad"); return; }

  const pending = store.where("inbox", (i) => i.status === "pending");
  if (!pending.length) { toast("Nothing to run against — refresh the feed first", "bad"); return; }

  const fired = [];
  let staged = 0, held = 0;

  for (const i of pending) {
    for (const rule of rules) {
      const m = matches(rule, i);
      if (!m.ok) continue;

      if ((rule.safety || {}).skipIfInteractedBefore) {
        const before = store.where("inbox", (x) =>
          x.id !== i.id && x.status === "done" &&
          (x.author || {}).handle === (i.author || {}).handle &&
          (x.proposed || {}).ruleId === rule.id);
        if (before.length) { held++; break; }
      }

      const recent = store.where("events", (e) => e.kind === "rule" && (e.meta || {}).ruleId === rule.id)
        .map((e) => ({ at: e.at, ruleId: rule.id, authorHandle: (e.meta || {}).authorHandle }))
        .concat(fired);
      const limit = canRunNow(rule, recent, new Date(), i);
      if (!limit.ok) {
        await store.put("inbox", { ...i, heldReason: limit.reason });
        held++;
        break;
      }

      const needsMessage = (ACTIONS[rule.action.type] || {}).needsMessage;
      await store.put("inbox", {
        ...i,
        status: (rule.safety || {}).requireApproval ? "staged" : "approved",
        proposed: {
          ruleId: rule.id,
          actionType: rule.action.type,
          text: needsMessage ? draftMessage(rule, i) : "",
        },
      });
      fired.push({ at: new Date().toISOString(), ruleId: rule.id, authorHandle: (i.author || {}).handle });
      await store.put("rules", { ...rule, stats: { ...(rule.stats || {}), matched: ((rule.stats || {}).matched || 0) + 1 } });
      staged++;
      break;
    }
  }

  // Rules set to act without approval go straight out.
  const auto = store.where("inbox", (i) => i.status === "approved");
  if (auto.length) await approve(auto, ctx, { silent: true });

  await store.log("rule", `Rule pass: ${staged} staged, ${held} held by caps`);
  toast(`${staged} staged${held ? `, ${held} held by caps` : ""}`, staged ? "ok" : "");
  tab = "staged";
  ctx.refresh();
}

/** Build the message a rule wants to send for this item. */
function draftMessage(rule, item) {
  const account = store.get("accounts", item.accountId);
  const profile = account ? store.get("profiles", account.profileId) : null;
  const a = rule.action || {};

  let template = a.text || "";
  if (a.source === "template" && (a.templateIds || []).length) {
    const id = a.templateIds[Math.floor(Math.random() * a.templateIds.length)];
    const t = store.get("templates", id);
    template = t ? t.body : "";
  } else if (a.source === "library" && (a.libraryTags || []).length) {
    const tag = a.libraryTags[Math.floor(Math.random() * a.libraryTags.length)];
    template = `[phrase:${tag}] [cta:${tag}] [link:${tag}]`;
  }
  if (!template) return "";

  const draw = makeDraw(store.all("library"), {
    filter: (r) =>
      (!(r.profileIds || []).length || !account || r.profileIds.includes(account.profileId)) &&
      (!(r.platformIds || []).length || !account || r.platformIds.includes(account.platform)),
  });
  const values = contextValues({
    account: account || { handle: "" },
    profile,
    platformName: platform(item.platform).name,
  });
  values.author = (item.author || {}).handle || "";
  values.subject = item.text || "";
  return spin(template, { draw, values });
}

/* -------------------------------------------------------------- approval */

async function approve(items, ctx, { silent = false } = {}) {
  let ok = 0, failed = 0;
  for (const i of items) {
    const rule = store.get("rules", (i.proposed || {}).ruleId);
    const account = store.get("accounts", i.accountId);
    let result;
    try {
      result = await api.act({
        accountId: i.accountId,
        connectionId: account ? account.connectionId : null,
        platform: i.platform,
        action: (i.proposed || {}).actionType,
        targetId: i.externalId || i.id,
        targetUrl: i.url || null,
        text: (i.proposed || {}).text || "",
      });
    } catch (e) {
      result = { ok: false, error: e.message };
    }
    if (result.ok) ok++; else failed++;

    await store.put("inbox", {
      ...i,
      status: "done",
      handledAt: new Date().toISOString(),
      result,
    });
    if (rule) {
      await store.put("rules", {
        ...rule,
        lastFiredAt: new Date().toISOString(),
        stats: { ...(rule.stats || {}), acted: ((rule.stats || {}).acted || 0) + (result.ok ? 1 : 0) },
      });
      await store.log("rule", `${rule.name}: ${(i.proposed || {}).actionType} on @${(i.author || {}).handle}${result.simulated ? " (simulated)" : ""}`, {
        ruleId: rule.id,
        authorHandle: (i.author || {}).handle,
      });
    }
  }
  if (!silent) toast(`${ok} sent${failed ? `, ${failed} failed` : ""}`, failed ? "bad" : "ok");
  ctx.refresh();
}

async function editText(i, ctx) {
  const v = await modal({
    title: "Edit the reply",
    body: html`
      <div class="small muted" style="margin-bottom:.5rem">Replying to @${(i.author || {}).handle}: “${i.text}”</div>
      <textarea id="t" name="text" rows="4">${(i.proposed || {}).text || ""}</textarea>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Save", value: "go", primary: true }],
  });
  if (v !== "go") return;
  const text = document.getElementById("modal").querySelector("#t").value;
  await store.put("inbox", { ...i, proposed: { ...i.proposed, text } });
  ctx.refresh();
}
