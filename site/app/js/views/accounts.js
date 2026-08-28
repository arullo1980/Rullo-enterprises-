/**
 * Connections — the social accounts each profile posts through.
 *
 * How a connection is made matters more here than anywhere else in the desk:
 *
 *  - OAuth networks send the user to the network, which hands the Worker a
 *    token. The browser never sees it and this database never stores it.
 *  - Token/app-password networks need a secret pasted in. That secret is
 *    forwarded straight to the Worker and is never written to IndexedDB, which
 *    is why connecting one without a backend configured is refused rather than
 *    quietly downgraded.
 *
 * An account row here is a label plus the opaque connection id the Worker
 * returned. Nothing sensitive lives on this side.
 */

import * as store from "../store.js";
import { PLATFORMS, platform } from "../platforms.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  avatar, platformMark, emptyState, relTime, plural,
} from "../ui.js";

export const title = "Connections";
export const subtitle = () => {
  const a = store.all("accounts");
  const live = a.filter((x) => x.status === "connected").length;
  return `${live} of ${a.length} accounts connected${api.isLive() ? "" : " · dry run, no backend configured"}`;
};
export const actions = () => `<button class="btn btn-primary" data-add>Add account</button>`;

export function render(root, ctx) {
  const filterProfile = ctx.params.get("profile");
  const profiles = store.all("profiles")
    .filter((p) => !filterProfile || p.id === filterProfile)
    .filter((p) => ctx.scopeProfileId === "all" || p.id === ctx.scopeProfileId);
  const accounts = store.all("accounts");

  mount(root, html`
    ${api.isLive() ? raw("") : html`
      <div class="notice" style="margin-bottom:1rem">
        <b>No posting backend configured.</b> You can set accounts up and use the
        whole desk in dry run, but nothing will actually publish and secrets
        cannot be stored. Point Settings → Backend at your deployed
        <code>social-hub</code> Worker to go live.
      </div>`}

    <section class="stack">
      ${profiles.length ? profiles.map((p) => group(p, accounts.filter((a) => a.profileId === p.id))) : raw("")}
    </section>

    ${profiles.length ? raw("") : emptyState("No profiles", "Create a profile first — accounts hang off profiles.",
      `<a class="btn btn-primary" href="#/profiles">Go to profiles</a>`)}

    <section class="card" style="margin-top:1.25rem">
      <div class="card-head"><h2>What each network needs</h2></div>
      <div class="card-body tight">
        <table>
          <thead><tr><th>Network</th><th>Connect with</th><th class="num">Limit</th><th>Notes</th></tr></thead>
          <tbody>
            ${PLATFORMS.map((p) => html`
              <tr>
                <td><div class="row tight">${platformMark(p, "sm")}<span>${p.name}</span></div></td>
                <td class="mono-sm">${p.auth}</td>
                <td class="num">${p.limit.toLocaleString()}</td>
                <td class="small muted">${p.note || ""}</td>
              </tr>`)}
          </tbody>
        </table>
      </div>
    </section>
  `);

  on(ctx.scope, "click", "[data-add]", () => addAccount(ctx));
  on(ctx.scope, "click", "[data-connect]", (e, t) => connect(store.get("accounts", t.dataset.connect), ctx));
  on(ctx.scope, "click", "[data-edit]", (e, t) => addAccount(ctx, store.get("accounts", t.dataset.edit)));
  on(ctx.scope, "click", "[data-disconnect]", async (e, t) => {
    const a = store.get("accounts", t.dataset.disconnect);
    if (!await confirmDialog("Disconnect?", `@${a.handle} will stop posting until it is reconnected. The account stays on the desk.`, "Disconnect")) return;
    if (a.connectionId && api.isLive()) {
      try { await api.disconnect(a.connectionId); } catch (err) { toast("Backend said: " + err.message, "bad"); }
    }
    await store.put("accounts", { ...a, status: "disconnected", connectionId: null });
    await store.log("auth", `Disconnected @${a.handle}`, { platform: a.platform });
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-remove]", async (e, t) => {
    const a = store.get("accounts", t.dataset.remove);
    if (!await confirmDialog("Remove account?", `@${a.handle} is removed from the desk entirely.`)) return;
    await store.removeCascade("accounts", a.id);
    ctx.refresh();
  });
}

function group(p, accts) {
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
              <tr><th>Network</th><th>Handle</th><th>Status</th><th>Last posted</th><th class="actions"></th></tr>
            </thead>
            <tbody>
              ${accts.map((a) => {
                const pl = platform(a.platform);
                const state = a.status === "connected" ? "ok" : a.status === "expired" ? "bad" : "";
                return html`
                  <tr>
                    <td><div class="row tight">${platformMark(pl, "sm")}<span>${pl.name}</span></div></td>
                    <td class="mono-sm">@${a.handle}${a.target ? html` <span class="muted">→ ${a.target}</span>` : raw("")}</td>
                    <td><span class="badge ${state}">${a.status}</span></td>
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

  const body = html`
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
          ${PLATFORMS.map((p) => html`<option value="${p.id}" ${raw(p.id === a.platform ? "selected" : "")}>${p.name}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="label" for="a-handle">Handle</label>
        <input id="a-handle" name="handle" type="text" value="${a.handle || ""}" placeholder="rulloenterprises" />
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
    <div class="notice info" id="platformNote" style="margin-top:.85rem"></div>`;

  const v = await modal({
    title: existing ? "Edit account" : "Add account",
    body,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: existing ? "Save" : "Add", value: "save", primary: true }],
    validate: (val, dlg) => (val === "save" && !dlg.querySelector("#a-handle").value.trim() ? "Enter the account handle." : null),
    onOpen: (dlg) => {
      const sel = dlg.querySelector("#a-platform");
      const sync = () => {
        const p = platform(sel.value);
        dlg.querySelector("#platformNote").innerHTML =
          `<b>${p.name}</b> — connect with <code>${p.auth}</code>, ${p.limit.toLocaleString()} characters` +
          (p.requiresMedia ? ", every post needs media" : "") + ". " + (p.note || "");
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

  if (!api.isLive()) {
    await modal({
      title: `Connect ${p.name}`,
      body: html`
        <div class="notice bad">
          <b>No backend configured.</b> Connecting an account means handing a token
          to something that can keep it secret, and a browser database is not that.
        </div>
        <p>To connect for real:</p>
        <ol class="small">
          <li>Deploy <code>workers/social-hub</code> (see its README).</li>
          <li>Register a developer app on ${p.name} and set its client id and secret as Worker secrets.</li>
          <li>Put the Worker URL into Settings → Backend.</li>
        </ol>
        <p class="small muted">Until then the desk runs in dry run: compose, generate,
        schedule and rules all work, and nothing publishes.</p>
        <p class="small"><a href="${p.docs || "#"}" target="_blank" rel="noopener">${p.name} developer documentation</a></p>`,
      actions: [{ label: "Close", value: "__cancel" }, { label: "Open settings", value: "settings", primary: true }],
    }).then((v) => { if (v === "settings") location.hash = "#/settings"; });
    return;
  }

  if (p.auth === "oauth2") {
    try {
      const r = await api.startConnect(p.id, {
        profileId: account.profileId,
        instance: account.instance,
        label: account.handle,
      });
      if (!r || !r.url) throw new Error("The backend did not return an authorisation URL.");
      await store.put("accounts", { ...account, status: "connecting", connectionId: r.connectionId || null });
      await store.log("auth", `Started ${p.name} authorisation for @${account.handle}`);
      window.open(r.url, "_blank", "noopener");
      toast(`Approve the request on ${p.name}, then return here and refresh.`, "", 6000);
    } catch (e) {
      toast("Could not start authorisation: " + e.message, "bad", 6000);
    }
    ctx.refresh();
    return;
  }

  // Paste-a-secret networks.
  const fields = credentialFields(p);
  const v = await modal({
    title: `Connect ${p.name}`,
    body: html`
      <p class="small muted">
        ${profile && profile.kind === "client"
          ? "This is a client account — have the client generate the credential themselves and send it over a channel they trust."
          : "Generate this on the network, not from your account password."}
      </p>
      ${fields.map((f) => html`
        <div class="field">
          <label class="label" for="c-${f.name}">${f.label}</label>
          <input id="c-${f.name}" name="${f.name}" type="${f.secret ? "password" : "text"}"
                 placeholder="${f.placeholder || ""}" autocomplete="off" />
          ${f.hint ? html`<div class="hint">${f.hint}</div>` : raw("")}
        </div>`)}
      <div class="notice">
        This is sent straight to your Worker and stored encrypted there. It is
        never written to this browser's database.
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Connect", value: "go", primary: true }],
  });
  if (v !== "go") return;

  const creds = formData(document.getElementById("modal"));
  try {
    const r = await api.connectToken(p.id, {
      profileId: account.profileId,
      label: account.handle,
      credentials: creds,
    });
    await store.put("accounts", {
      ...account,
      status: "connected",
      connectionId: (r && r.connectionId) || null,
      connectedAt: new Date().toISOString(),
    });
    await store.log("auth", `Connected @${account.handle} on ${p.name}`);
    toast("Connected", "ok");
  } catch (e) {
    toast("Connection failed: " + e.message, "bad", 6000);
  }
  ctx.refresh();
}

function credentialFields(p) {
  switch (p.id) {
    case "bluesky":
      return [
        { name: "identifier", label: "Handle or email", placeholder: "you.bsky.social" },
        { name: "appPassword", label: "App password", secret: true, hint: "Settings → App Passwords on Bluesky. Not your login password." },
      ];
    case "telegram":
      return [
        { name: "botToken", label: "Bot token", secret: true, hint: "From @BotFather." },
        { name: "chatId", label: "Channel or chat id", placeholder: "@yourchannel", hint: "The bot must be an admin of the channel." },
      ];
    case "discord":
      return [
        { name: "webhookUrl", label: "Webhook URL", secret: true, hint: "Channel settings → Integrations → Webhooks." },
      ];
    default:
      return [{ name: "token", label: "Access token", secret: true }];
  }
}
