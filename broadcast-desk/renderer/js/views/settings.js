/**
 * Settings — the machine, the money, and the data.
 *
 * Three things live here that the workspace database deliberately does not:
 * the relay's key, each network's developer-app secret, and the spend ceiling.
 * All three are held by the main process; this screen can set them and can see
 * whether they are set, but never reads them back.
 */

import * as store from "../store.js";
import * as api from "../api.js";
import { PRIMARY, EXTRA, platform } from "../../../shared/platforms.js";
import { updateConnState } from "../main.js";
import {
  html, raw, mount, on, modal, formData, toast, confirmDialog,
  platformMark, plural, fmtDateTime, $,
} from "../ui.js";

export const title = "Settings";
export const subtitle = () => api.isDryRun() ? "Dry run — nothing publishes" : "Live";

let machine = { networks: {}, spend: {} };
let info = {};

export async function render(root, ctx) {
  [machine, info] = await Promise.all([
    api.machineSettings().catch(() => ({ networks: {}, spend: {} })),
    api.info().catch(() => ({})),
  ]);
  const s = store.settings();
  const spend = machine.spend || {};
  const counts = {
    profiles: store.all("profiles").length,
    accounts: store.all("accounts").length,
    library: store.all("library").length,
    templates: store.all("templates").length,
    posts: store.all("posts").length,
    rules: store.all("rules").length,
  };

  mount(root, html`
    <div class="split">
      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Sending</h2>
            <span class="spacer"></span>
            <span class="badge ${api.isDryRun() ? "warn" : "ok"}">${api.isDryRun() ? "dry run" : "live"}</span>
          </div>
          <div class="card-body">
            <label class="check">
              <input type="checkbox" id="dryRun" ${raw(api.isDryRun() ? "checked" : "")} />
              <span><b>Dry run</b><br><span class="small muted">
                Everything works and nothing publishes. Turns itself off when you connect
                your first account; turn it back on to rehearse a campaign.</span></span>
            </label>
            <div class="divider"></div>
            <div class="field">
              <label class="label" for="gap">Gap between accounts in a fan-out</label>
              <div class="row">
                <input id="gap" type="number" min="0" max="10000" step="100" value="${machine.fanoutGapMs || 900}" style="max-width:130px" />
                <span class="small muted">milliseconds — twelve posts in the same second is the pattern networks score as automation</span>
              </div>
            </div>
            <button class="btn btn-primary" data-save-sending>Save</button>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Spending</h2>
            <span class="spacer"></span>
            <span class="badge ${(spend.spent || {}) && api.isDryRun() ? "" : "info"}">
              $${Number(currentSpend(spend)).toFixed(2)} this month</span>
          </div>
          <div class="card-body">
            <p class="small muted">
              X is the only network here that charges to post: $0.015 a post, or
              <b>$0.20 if the post contains a link</b>. Nothing else costs anything.
            </p>
            <div class="grid c2" style="gap:.6rem">
              <div class="field">
                <label class="label" for="cap">Monthly cap (USD)</label>
                <input id="cap" type="number" min="0" step="1" value="${spend.monthlyCapUsd ?? 25}" />
                <div class="hint">A send that would cross this is refused before it is made.</div>
              </div>
              <div class="field">
                <label class="label">Used this month</label>
                <div class="stat" style="padding:.5rem .7rem">
                  <div class="v" style="font-size:20px">$${Number(currentSpend(spend)).toFixed(2)}</div>
                  <div class="n">of $${spend.monthlyCapUsd ?? 25}</div>
                </div>
              </div>
            </div>
            <label class="check">
              <input type="checkbox" id="blockLinks" ${raw(spend.blockLinksOnX !== false ? "checked" : "")} />
              <span><b>Refuse posts containing links on X</b><br><span class="small muted">
                A link costs 13× a plain post. With this on you can still allow the charge
                on an individual post from the composer.</span></span>
            </label>
            <button class="btn btn-primary" data-save-spend style="margin-top:.7rem">Save</button>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Networks</h2>
            <span class="spacer"></span>
            <span class="small muted">${Object.values(machine.networks || {}).filter((n) => n.clientIdSet).length} set up</span>
          </div>
          <div class="card-body tight">
            <p class="small muted" style="padding:.4rem .6rem">
              One developer app per network, registered by you. It identifies your agency
              to the network — your clients authorise <em>it</em>, and never see it.
            </p>
            <table>
              <thead><tr><th>Network</th><th>Status</th><th>Redirect to register</th><th class="actions"></th></tr></thead>
              <tbody>
                ${PRIMARY.concat(EXTRA).filter((p) => p.auth === "oauth2").map((p) => {
                  const app = (machine.networks || {})[p.id] || {};
                  return html`
                    <tr>
                      <td><div class="row tight">${platformMark(p, "sm")}<span>${p.name}</span></div></td>
                      <td>${app.clientIdSet
                        ? html`<span class="badge ok">ready</span> <span class="mono-sm muted">${app.clientId}</span>`
                        : html`<span class="badge warn">not set</span>`}</td>
                      <td class="mono-sm small">${p.redirect === "https"
                        ? (machine.relayUrl ? machine.relayUrl.replace(/\/+$/, "") + "/oauth/callback" : "needs the relay")
                        : "http://127.0.0.1"}</td>
                      <td class="actions">
                        <button class="btn btn-sm" data-app="${p.id}">${app.clientIdSet ? "Update" : "Set up"}</button>
                        <button class="btn btn-sm btn-ghost" data-docs="${p.id}">Docs</button>
                      </td>
                    </tr>`;
                })}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>Relay</h2>
            <span class="spacer"></span>
            <span class="badge ${machine.relayUrl ? "ok" : ""}" id="relayBadge">${machine.relayUrl ? "configured" : "not set"}</span>
          </div>
          <div class="card-body">
            <p class="small muted">
              Optional, and used for exactly three things: taking the OAuth callback for
              networks that refuse a local address, hosting media for Instagram, and
              sending scheduled posts while this machine is off.
            </p>
            <div class="field">
              <label class="label" for="relayUrl">Worker URL</label>
              <input id="relayUrl" type="url" value="${machine.relayUrl || ""}" placeholder="https://broadcast-desk-relay.your-name.workers.dev" />
            </div>
            <div class="field">
              <label class="label" for="relayKey">Desk key ${machine.relayKeySet ? html`<span class="badge ok">saved</span>` : raw("")}</label>
              <input id="relayKey" type="password" placeholder="${machine.relayKeySet ? "unchanged" : "the DESK_KEY secret"}" autocomplete="off" />
            </div>
            <div class="row">
              <button class="btn btn-primary" data-save-relay>Save</button>
              <button class="btn" data-test-relay>Test</button>
            </div>
            <div id="relayResult" class="hint"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>This machine</h2></div>
          <div class="card-body">
            <table>
              <tbody>
                <tr><td>Version</td><td class="mono-sm">${info.version || "—"}</td></tr>
                <tr><td>Platform</td><td class="mono-sm">${info.platform || "—"}</td></tr>
                <tr><td>Secure storage</td><td>${info.secureStorage
                  ? html`<span class="badge ok">available</span>`
                  : html`<span class="badge bad">unavailable</span>`}</td></tr>
                <tr><td>Data folder</td><td class="mono-sm small trunc" style="max-width:22ch" title="${info.userData || ""}">${info.userData || "—"}</td></tr>
              </tbody>
            </table>
            <div class="field" style="margin-top:.8rem">
              <label class="label" for="tz">Default timezone</label>
              <input id="tz" value="${s.timezone}" />
            </div>
            <div class="field">
              <label class="label" for="theme">Appearance</label>
              <select id="theme">
                ${["system", "light", "dark"].map((t) => html`<option value="${t}" ${raw(s.theme === t ? "selected" : "")}>${t}</option>`)}
              </select>
            </div>
            <button class="btn" data-save-workspace>Save</button>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Data</h2></div>
          <div class="card-body">
            <p class="small muted">
              Everything you build lives on this machine. Export before you move, and keep
              a copy — this is your clients' schedule as much as yours.
            </p>
            <div class="row">
              <button class="btn" data-export>Export</button>
              <button class="btn" data-import>Import</button>
              <span class="spacer"></span>
              <button class="btn btn-danger" data-wipe>Reset workspace</button>
            </div>
            <table style="margin-top:.9rem">
              <tbody>${Object.entries(counts).map(([k, v]) => html`<tr><td>${k}</td><td class="num">${v}</td></tr>`)}</tbody>
            </table>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Shortcuts</h2></div>
          <div class="card-body tight">
            <table>
              <tbody>
                ${[["Ctrl/Cmd 1–7", "Jump between sections"], ["Ctrl/Cmd N", "Compose"],
                   ["g then d/c/q/i/l/r/a/s", "Jump without the modifier"]]
                  .map(([k, v]) => html`<tr><td class="mono-sm">${k}</td><td>${v}</td></tr>`)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `);

  on(ctx.scope, "click", "[data-save-sending]", async () => {
    await store.saveSettings({ dryRun: $("#dryRun", root).checked });
    await api.saveMachineSettings({ fanoutGapMs: Number($("#gap", root).value) || 900 });
    toast("Saved", "ok");
    updateConnState();
    ctx.refresh();
  });

  on(ctx.scope, "click", "[data-save-spend]", async () => {
    await api.saveMachineSettings({
      spend: {
        ...(machine.spend || {}),
        monthlyCapUsd: Number($("#cap", root).value) || 0,
        blockLinksOnX: $("#blockLinks", root).checked,
      },
    });
    toast("Spending rules saved", "ok");
    ctx.refresh();
  });

  on(ctx.scope, "click", "[data-save-relay]", async () => {
    const patch = { relayUrl: $("#relayUrl", root).value.trim() };
    const key = $("#relayKey", root).value;
    if (key) patch.relayKey = key;          // blank means "leave the saved one"
    await api.saveMachineSettings(patch);
    await store.saveSettings({ relayUrl: patch.relayUrl });
    toast("Relay saved", "ok");
    updateConnState();
    ctx.refresh();
  });

  on(ctx.scope, "click", "[data-test-relay]", async () => {
    const box = $("#relayResult", root);
    box.textContent = "Testing…";
    const patch = { relayUrl: $("#relayUrl", root).value.trim() };
    const key = $("#relayKey", root).value;
    if (key) patch.relayKey = key;
    await api.saveMachineSettings(patch);
    await store.saveSettings({ relayUrl: patch.relayUrl });
    const h = await api.health();
    box.innerHTML = h.mode === "live"
      ? `<span style="color:var(--emerald)">Connected${h.version ? " — " + h.version : ""}.</span>`
      : h.mode === "unauthorised"
        ? `<span style="color:var(--stamp)">Reachable, but the desk key is wrong.</span>`
      : h.mode === "local"
        ? "No relay URL set, so nothing to test."
        : `<span style="color:var(--stamp)">Failed: ${h.error}</span>`;
    updateConnState();
  });

  on(ctx.scope, "click", "[data-app]", (e, t) => networkApp(t.dataset.app, ctx));
  on(ctx.scope, "click", "[data-docs]", (e, t) => api.openExternal(platform(t.dataset.docs).docs));

  on(ctx.scope, "click", "[data-save-workspace]", async () => {
    const theme = $("#theme", root).value;
    await store.saveSettings({ timezone: $("#tz", root).value.trim() || "UTC", theme });
    localStorage.setItem("bd.theme", theme);
    document.documentElement.setAttribute("data-theme",
      theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme);
    toast("Saved", "ok");
  });

  on(ctx.scope, "click", "[data-export]", async () => {
    const payload = JSON.stringify(store.exportAll(), null, 2);
    const path = await api.saveFile(`broadcast-desk-${new Date().toISOString().slice(0, 10)}.json`, payload);
    toast(path ? "Exported" : "Export cancelled", path ? "ok" : "");
  });

  on(ctx.scope, "click", "[data-import]", async () => {
    const file = await api.openFile();
    if (!file) return;
    try {
      const payload = JSON.parse(file.text);
      const rows = Object.values(payload.data || {}).reduce((n, a) => n + (Array.isArray(a) ? a.length : 0), 0);
      if (!await confirmDialog("Import this backup?",
        `${plural(rows, "record")} from ${fmtDateTime(payload.exportedAt)} will be merged in. Records with the same id are overwritten.`,
        "Import")) return;
      await store.importAll(payload, "merge");
      toast("Imported", "ok");
      ctx.refresh();
    } catch (e) {
      toast("That file could not be read: " + e.message, "bad", 5000);
    }
  });

  on(ctx.scope, "click", "[data-wipe]", async () => {
    if (!await confirmDialog("Reset the workspace?",
      "Every profile, account, library entry, template, queued post and rule is deleted. Connected credentials stay in the vault — disconnect accounts first if you want those gone too.",
      "Delete everything")) return;
    await store.wipe();
    toast("Workspace reset");
    location.hash = "#/dashboard";
    location.reload();
  });
}

function currentSpend(spend) {
  const now = new Date();
  const key = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  return (spend.spent || {})[key] || 0;
}

/** Register one network's developer app. */
async function networkApp(id, ctx) {
  const p = platform(id);
  const app = (machine.networks || {})[id] || {};
  const redirect = p.redirect === "https"
    ? (machine.relayUrl ? machine.relayUrl.replace(/\/+$/, "") + "/oauth/callback" : "(set the relay URL first)")
    : "http://127.0.0.1";

  const v = await modal({
    title: `${p.name} developer app`,
    body: html`
      <p class="small muted">${p.review || ""}</p>
      <div class="field">
        <label class="label">Redirect URI to register on ${p.name}</label>
        <input value="${redirect}" readonly onclick="this.select()" />
        <div class="hint">${p.redirect === "https"
          ? "This network refuses a local address, so the relay takes the callback."
          : "A loopback address — the app listens on a free port and the exact port does not need registering."}</div>
      </div>
      <div class="field">
        <label class="label" for="n-id">Client id${app.clientIdSet ? " (saved)" : ""}</label>
        <input id="n-id" name="clientId" placeholder="${app.clientIdSet ? app.clientId + " — leave blank to keep" : ""}" autocomplete="off" />
      </div>
      <div class="field">
        <label class="label" for="n-secret">Client secret${app.clientSecretSet ? " (saved)" : ""}</label>
        <input id="n-secret" name="clientSecret" type="password"
               placeholder="${app.clientSecretSet ? "leave blank to keep" : ""}" autocomplete="off" />
      </div>
      <div class="field">
        <label class="label">Scopes this app requests</label>
        <div class="row tight">${(p.scopes || []).map((sc) => html`<span class="chip">${sc}</span>`)}</div>
      </div>
      <p class="small"><a href="#" data-doc>${p.docs}</a></p>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Save", value: "save", primary: true }],
    onOpen: (dlg) => {
      const link = dlg.querySelector("[data-doc]");
      if (link) link.addEventListener("click", (e) => { e.preventDefault(); api.openExternal(p.docs); });
    },
  });
  if (v !== "save") return;

  const f = formData(document.getElementById("modal"));
  await api.saveNetworkApp(id, { clientId: f.clientId, clientSecret: f.clientSecret });
  toast(`${p.name} app saved`, "ok");
  ctx.refresh();
}
