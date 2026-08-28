/**
 * Connections — the accounts this desk posts through.
 *
 * You operate these accounts; the account holder authorises once and never
 * touches this app. Two things follow from that, and they are visible on this
 * screen rather than buried:
 *
 *  - Tokens live on this machine, encrypted by the OS keyring. A copy only
 *    goes to the relay for accounts you switch to unattended, because that is
 *    the only way a post can go out while the machine is off.
 *  - We never ask for anyone's password. Every connection is either the
 *    network's own authorisation page, or a scoped credential the account
 *    holder generates themselves and can revoke without touching their login.
 */

import * as store from "../store.js";
import { PLATFORMS, PRIMARY, EXTRA, platform } from "../../../shared/platforms.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  avatar, platformMark, emptyState, relTime, plural,
} from "../ui.js";

export const title = "Connections";
export const subtitle = () => {
  const a = store.all("accounts");
  const live = a.filter((x) => x.status === "connected").length;
  return `${live} of ${a.length} accounts connected${api.isDryRun() ? " · dry run" : ""}`;
};
export const actions = () => `<button class="btn btn-primary" data-add>Add account</button>`;

let machine = { networks: {}, relayUrl: "" };
let vaultInfo = { secureStorage: true };

export async function render(root, ctx) {
  [machine, vaultInfo] = await Promise.all([
    api.machineSettings().catch(() => ({ networks: {} })),
    api.info().catch(() => ({ secureStorage: true })),
  ]);

  // Reconcile with the vault: an account whose connection was removed outside
  // the app must not keep claiming it is connected.
  const connections = await api.listConnections().catch(() => []);
  const byId = Object.fromEntries(connections.map((c) => [c.id, c]));
  for (const a of store.all("accounts")) {
    const live = a.connectionId && byId[a.connectionId];
    if (a.status === "connected" && !live) {
      await store.put("accounts", { ...a, status: "disconnected", connectionId: null });
    } else if (live && a.unattended !== Boolean(live.unattended)) {
      await store.put("accounts", { ...a, unattended: Boolean(live.unattended) });
    }
  }

  const profiles = store.all("profiles")
    .filter((p) => ctx.scopeProfileId === "all" || p.id === ctx.scopeProfileId);
  const accounts = store.all("accounts");

  mount(root, html`
    ${vaultInfo.secureStorage ? raw("") : html`
      <div class="notice bad" style="margin-bottom:1rem">
        <b>This system will not provide secure storage.</b> Credentials cannot be saved
        until it does. On Linux, install <code>gnome-keyring</code> or <code>pass</code> and restart.
      </div>`}

    ${api.isDryRun() ? html`
      <div class="notice" style="margin-bottom:1rem">
        <b>Dry run.</b> Everything works, nothing publishes. Connecting your first
        account turns it off.
      </div>` : raw("")}

    <section class="stack">
      ${profiles.length ? profiles.map((p) => group(p, accounts.filter((a) => a.profileId === p.id), byId)) : raw("")}
    </section>

    ${profiles.length ? raw("") : emptyState("No profiles", "Create a profile first — accounts hang off profiles.",
      `<a class="btn btn-primary" href="#/profiles">Go to profiles</a>`)}

    <section class="card" style="margin-top:1.25rem">
      <div class="card-head"><h2>What each network needs</h2>
        <span class="spacer"></span>
        <a class="btn btn-sm" href="#/settings">Set up developer apps</a>
      </div>
      <div class="card-body tight">
        <table>
          <thead><tr><th>Network</th><th>Connect with</th><th>App set up</th><th class="num">Limit</th><th>Before you can post for clients</th></tr></thead>
          <tbody>
            ${PRIMARY.map(networkRow)}
            <tr><td colspan="5" class="small muted" style="padding-top:.9rem">
              Also built in, no approval needed —</td></tr>
            ${EXTRA.map(networkRow)}
          </tbody>
        </table>
      </div>
    </section>
  `);

  on(ctx.scope, "click", "[data-add]", () => addAccount(ctx));
  on(ctx.scope, "click", "[data-connect]", (e, t) => connect(store.get("accounts", t.dataset.connect), ctx));
  on(ctx.scope, "click", "[data-edit]", (e, t) => addAccount(ctx, store.get("accounts", t.dataset.edit)));
  on(ctx.scope, "change", "[data-unattended]", (e, t) => toggleUnattended(t.dataset.unattended, t.checked, ctx));
  on(ctx.scope, "click", "[data-disconnect]", async (e, t) => {
    const a = store.get("accounts", t.dataset.disconnect);
    if (!await confirmDialog("Disconnect?", `@${a.handle} stops posting until it is reconnected. The account stays on the desk.`, "Disconnect")) return;
    if (a.connectionId) {
      try { await api.disconnect(a.connectionId); } catch (err) { toast(err.message, "bad"); }
    }
    await store.put("accounts", { ...a, status: "disconnected", connectionId: null, unattended: false });
    await store.log("auth", `Disconnected @${a.handle}`, { platform: a.platform });
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-remove]", async (e, t) => {
    const a = store.get("accounts", t.dataset.remove);
    if (!await confirmDialog("Remove account?", `@${a.handle} is removed from the desk entirely.`)) return;
    if (a.connectionId) await api.disconnect(a.connectionId).catch(() => {});
    await store.removeCascade("accounts", a.id);
    ctx.refresh();
  });
}

function networkRow(p) {
  const app = machine.networks[p.id] || {};
  const needsApp = p.auth === "oauth2";
  return html`
    <tr>
      <td><div class="row tight">${platformMark(p, "sm")}<span>${p.name}</span></div></td>
      <td class="mono-sm">${p.auth}${p.redirect === "https" ? html` <span class="badge">via relay</span>` : raw("")}</td>
      <td>${needsApp
        ? (app.clientIdSet ? html`<span class="badge ok">ready</span>` : html`<span class="badge warn">needed</span>`)
        : html`<span class="badge ok">n/a</span>`}</td>
      <td class="num">${(p.limit || 0).toLocaleString()}</td>
      <td class="small muted">${p.review || ""}</td>
    </tr>`;
}

function group(p, accts, byId) {
  return html`
    <div class="card">
      <div class="card-head">
        ${avatar(p.name)}
        <h2>${p.name}</h2>
        <span class="badge">${p.kind}</span>
        <span class="spacer"></span>
        <span class="small muted">${plural(accts.length, "account")}</span>
      </div>
      ${accts.length ? html`
        <div class="card-body tight">
          <table>
            <thead>
              <tr><th>Network</th><th>Handle</th><th>Status</th><th title="Keeps a copy of the token in your relay so posts go out when this machine is off">Unattended</th><th>Last posted</th><th class="actions"></th></tr>
            </thead>
            <tbody>
              ${accts.map((a) => {
                const pl = platform(a.platform);
                const conn = a.connectionId ? byId[a.connectionId] : null;
                const state = a.status === "connected" ? "ok" : a.status === "expired" ? "bad" : "";
                return html`
                  <tr>
                    <td><div class="row tight">${platformMark(pl, "sm")}<span>${pl.name}</span></div></td>
                    <td class="mono-sm">
                      @${a.handle}
                      ${a.target ? html`<span class="muted"> → ${a.target}</span>` : raw("")}
                      ${conn && conn.meta && conn.meta.handle && conn.meta.handle !== a.handle
                        ? html`<div class="small muted">authorised as ${conn.meta.handle}</div>` : raw("")}
                    </td>
                    <td><span class="badge ${state}">${a.status}</span></td>
                    <td>
                      ${a.status === "connected" ? html`
                        <label class="check" title="${api.relayConfigured() ? "Send this account's scheduled posts from the relay" : "Set up the relay first"}">
                          <input type="checkbox" data-unattended="${a.id}" ${raw(a.unattended ? "checked" : "")}
                                 ${raw(api.relayConfigured() ? "" : "disabled")} />
                        </label>` : html`<span class="small muted">—</span>`}
                    </td>
                    <td class="small muted">${a.lastPostedAt ? relTime(a.lastPostedAt) : "never"}</td>
                    <td class="actions">
                      ${a.status === "connected"
                        ? html`<button class="btn btn-sm" data-disconnect="${a.id}">Disconnect</button>`
                        : html`<button class="btn btn-sm btn-primary" data-connect="${a.id}">Connect</button>`}
                      <button class="btn btn-sm btn-ghost" data-edit="${a.id}">Edit</button>
                      <button class="btn btn-sm btn-ghost" data-remove="${a.id}" title="Remove from desk">✕</button>
                    </td>
                  </tr>`;
              })}
            </tbody>
          </table>
        </div>`
      : html`<div class="empty">No accounts on this profile yet. <button class="btn btn-sm" data-add>Add one</button></div>`}
    </div>`;
}

/* ----------------------------------------------------------- add / edit */

async function addAccount(ctx, existing) {
  const profiles = store.all("profiles");
  const a = existing || { profileId: ctx.scopeProfileId !== "all" ? ctx.scopeProfileId : (profiles[0] || {}).id, platform: "x" };

  const v = await modal({
    title: existing ? "Edit account" : "Add account",
    body: html`
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="a-profile">Profile</label>
          <select id="a-profile" name="profileId">
            ${profiles.map((p) => html`<option value="${p.id}" ${raw(p.id === a.profileId ? "selected" : "")}>${p.name} (${p.kind})</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="a-platform">Network</label>
          <select id="a-platform" name="platform">
            <optgroup label="Your networks">
              ${PRIMARY.map((p) => html`<option value="${p.id}" ${raw(p.id === a.platform ? "selected" : "")}>${p.name}</option>`)}
            </optgroup>
            <optgroup label="Also available">
              ${EXTRA.map((p) => html`<option value="${p.id}" ${raw(p.id === a.platform ? "selected" : "")}>${p.name}</option>`)}
            </optgroup>
          </select>
        </div>
        <div class="field">
          <label class="label" for="a-handle">Handle <span class="muted">(how you refer to it here)</span></label>
          <input id="a-handle" name="handle" type="text" value="${a.handle || ""}" placeholder="clientname" />
        </div>
        <div class="field">
          <label class="label" for="a-display">Display name</label>
          <input id="a-display" name="displayName" type="text" value="${a.displayName || ""}" />
        </div>
      </div>
      <div class="field" id="targetField" style="display:none">
        <label class="label" for="a-target">Target <span class="muted" id="targetHint"></span></label>
        <input id="a-target" name="target" type="text" value="${a.target || ""}" />
      </div>
      <div class="field" id="instanceField" style="display:none">
        <label class="label" for="a-instance">Instance</label>
        <input id="a-instance" name="instance" type="text" value="${a.instance || ""}" placeholder="mastodon.social" />
      </div>
      <label class="check"><input type="checkbox" name="premium" ${raw(a.premium ? "checked" : "")} />
        <span>Paid tier with a longer character limit (X Premium and similar)</span></label>
      <div class="notice info" id="platformNote" style="margin-top:.85rem"></div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: existing ? "Save" : "Add", value: "save", primary: true }],
    validate: (val, dlg) => (val === "save" && !dlg.querySelector("#a-handle").value.trim() ? "Enter a handle." : null),
    onOpen: (dlg) => {
      const sel = dlg.querySelector("#a-platform");
      const sync = () => {
        const p = platform(sel.value);
        const app = machine.networks[p.id] || {};
        const bits = [`<b>${p.name}</b> — ${p.limit.toLocaleString()} characters, connect with <code>${p.auth}</code>.`];
        if ((p.media || {}).required) bits.push(`Every post needs ${(p.media.kinds || []).join(" or ")}.`);
        if (p.cost) bits.push(`<b>Charges per post:</b> ${p.cost.note}`);
        if (p.review) bits.push(p.review);
        if (p.auth === "oauth2" && !app.clientIdSet) {
          bits.push(`<b>No developer app set up for ${p.name} yet</b> — add its client id in Settings → Networks before connecting.`);
        }
        dlg.querySelector("#platformNote").innerHTML = bits.join(" ");
        const tf = dlg.querySelector("#targetField");
        tf.style.display = p.needsTarget ? "" : "none";
        dlg.querySelector("#targetHint").textContent = p.needsTarget ? `(${p.needsTarget})` : "";
        dlg.querySelector("#instanceField").style.display = p.needsInstance ? "" : "none";
      };
      sel.addEventListener("change", sync);
      sync();
    },
  });
  if (v !== "save") return;

  const f = formData(document.getElementById("modal"));
  const saved = await store.put("accounts", {
    ...(existing || {}),
    profileId: f.profileId,
    platform: f.platform,
    handle: f.handle.trim().replace(/^@/, ""),
    displayName: f.displayName.trim() || f.handle.trim(),
    target: (f.target || "").trim(),
    instance: (f.instance || "").trim(),
    premium: !!f.premium,
    status: (existing && existing.status) || "disconnected",
  });
  toast(existing ? "Account saved" : "Account added", "ok");
  ctx.refresh();
  if (!existing) connect(saved, ctx);
}

/* -------------------------------------------------------------- connect */

async function connect(account, ctx) {
  const p = platform(account.platform);
  const profile = store.get("profiles", account.profileId);

  if (p.auth === "oauth2" && !(machine.networks[p.id] || {}).clientIdSet) {
    const go = await modal({
      title: `Set up ${p.name} first`,
      body: html`
        <p>Connecting an account on ${p.name} needs your own developer app — its client
        id and secret. That is what identifies <em>your agency</em> to the network.</p>
        <p class="small muted">${p.review || ""}</p>
        <p class="small"><a href="#" data-doc>${p.docs}</a></p>`,
      actions: [{ label: "Later", value: "__cancel" }, { label: "Open settings", value: "go", primary: true }],
      onOpen: (dlg) => {
        const link = dlg.querySelector("[data-doc]");
        if (link) link.addEventListener("click", (e) => { e.preventDefault(); api.openExternal(p.docs); });
      },
    });
    if (go === "go") location.hash = "#/settings";
    return;
  }

  if (p.auth === "oauth2") {
    try {
      const started = await api.connect({
        platform: p.id,
        profileId: account.profileId,
        label: account.handle,
        instance: account.instance || undefined,
      });

      if (started && started.hosted) {
        // The relay took the callback; the operator approves in the browser.
        const done = await modal({
          title: `Approve ${p.name} in your browser`,
          body: html`
            <p>${p.name} will not redirect to a local address, so your relay is taking
            the callback. Approve the request in the browser window that just opened,
            then come back here.</p>
            <label class="check" style="margin-top:.6rem">
              <input type="checkbox" name="keepInCloud" checked />
              <span>Let this account post while this machine is off
                <br><span class="small muted">Keeps a copy of the token in your relay. Turn it off to keep the token on this machine only.</span></span>
            </label>`,
          actions: [{ label: "Cancel", value: "__cancel" }, { label: "I approved it", value: "done", primary: true }],
        });
        if (done !== "done") return;
        const f = formData(document.getElementById("modal"));
        const conn = await api.finishHosted(started.pendingId, !!f.keepInCloud);
        await attach(account, conn, ctx);
        return;
      }

      await attach(account, started, ctx);
    } catch (e) {
      toast(e.message, "bad", 7000);
    }
    return;
  }

  // Paste-a-credential networks.
  const fields = credentialFields(p, account);
  const v = await modal({
    title: `Connect ${p.name}`,
    body: html`
      <p class="small muted">
        ${profile && profile.kind === "client"
          ? "This is a client account — have them generate this themselves and send it over a channel they trust. Never ask for their password."
          : "Generate this on the network. It is not an account password, and it can be revoked on its own."}
      </p>
      ${fields.map((f) => html`
        <div class="field">
          <label class="label" for="c-${f.name}">${f.label}</label>
          <input id="c-${f.name}" name="${f.name}" type="${f.secret ? "password" : "text"}"
                 value="${f.value || ""}" placeholder="${f.placeholder || ""}" autocomplete="off" />
          ${f.hint ? html`<div class="hint">${f.hint}</div>` : raw("")}
        </div>`)}
      <div class="notice">
        Stored on this machine, encrypted by ${vaultInfo.platform === "darwin" ? "the macOS Keychain"
          : vaultInfo.platform === "win32" ? "Windows DPAPI" : "your system keyring"}.
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Connect", value: "go", primary: true }],
  });
  if (v !== "go") return;

  const creds = formData(document.getElementById("modal"));
  try {
    const conn = await api.connect({
      platform: p.id,
      profileId: account.profileId,
      label: account.handle,
      instance: account.instance || undefined,
      credentials: creds,
    });
    await attach(account, conn, ctx);
  } catch (e) {
    toast("Connection failed: " + e.message, "bad", 7000);
  }
}

/** Bind a vault connection to the account row and leave dry run behind. */
async function attach(account, conn, ctx) {
  await store.put("accounts", {
    ...account,
    status: "connected",
    connectionId: conn.id,
    connectedAt: conn.connectedAt || new Date().toISOString(),
    remoteHandle: (conn.meta && conn.meta.handle) || null,
    unattended: Boolean(conn.unattended),
  });
  await store.log("auth", `Connected @${account.handle} on ${platform(account.platform).name}`);
  if (await api.leaveDryRun()) {
    toast("Connected — dry run is off, sends are real now.", "ok", 6000);
  } else {
    toast("Connected", "ok");
  }
  ctx.refresh();
}

async function toggleUnattended(accountId, enabled, ctx) {
  const a = store.get("accounts", accountId);
  if (!a || !a.connectionId) return;
  try {
    await api.setUnattended(a.connectionId, enabled);
    await store.put("accounts", { ...a, unattended: enabled });
    toast(enabled
      ? "This account can now post while the app is closed."
      : "Token removed from the relay — this account only posts while the app is open.", "ok", 5000);
  } catch (e) {
    toast(e.message, "bad", 6000);
  }
  ctx.refresh();
}

function credentialFields(p, account) {
  switch (p.id) {
    case "bluesky":
      return [
        { name: "identifier", label: "Handle or email", placeholder: "client.bsky.social" },
        { name: "appPassword", label: "App password", secret: true, hint: "Bluesky → Settings → App Passwords. Not the account password." },
      ];
    case "telegram":
      return [
        { name: "botToken", label: "Bot token", secret: true, hint: "From @BotFather." },
        { name: "chatId", label: "Channel or chat id", value: account.target, placeholder: "@theirchannel",
          hint: "The bot has to be an admin of the channel." },
      ];
    case "discord":
      return [{ name: "webhookUrl", label: "Webhook URL", secret: true, hint: "Channel settings → Integrations → Webhooks." }];
    case "wordpress":
      return [
        { name: "siteUrl", label: "Site URL", value: account.target, placeholder: "https://theirsite.com" },
        { name: "username", label: "WordPress username" },
        { name: "appPassword", label: "Application password", secret: true,
          hint: "Users → Profile → Application Passwords on their site. Spaces are fine." },
      ];
    default:
      return [{ name: "token", label: "Access token", secret: true }];
  }
}
