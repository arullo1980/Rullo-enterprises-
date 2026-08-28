/**
 * Settings — backend, safety defaults, and the data itself.
 */

import * as store from "../store.js";
import * as api from "../api.js";
import { updateConnState } from "../main.js";
import {
  html, raw, mount, on, toast, confirmDialog, download, pickFile,
  plural, fmtDateTime, $,
} from "../ui.js";

export const title = "Settings";
export const subtitle = () => api.isLive() ? "Backend configured" : "Running locally, dry run";

export function render(root, ctx) {
  const s = store.settings();
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
          <div class="card-head"><h2>Posting backend</h2>
            <span class="spacer"></span>
            <span class="badge ${api.isLive() ? "ok" : "warn"}">${api.isLive() ? "configured" : "dry run"}</span>
          </div>
          <div class="card-body">
            <p class="small muted">
              The desk cannot publish on its own: a browser has nowhere safe to keep an
              access token. Deploy <code>workers/social-hub</code>, point this at it, and
              the Worker holds the credentials and does the posting — including on
              schedule while nothing is open here.
            </p>
            <div class="field">
              <label class="label" for="apiBase">Worker URL</label>
              <input id="apiBase" type="url" value="${s.apiBase || ""}" placeholder="https://social-hub.your-subdomain.workers.dev" />
            </div>
            <div class="field">
              <label class="label" for="apiKey">Desk key <span class="muted">(the DESK_KEY secret you set on the Worker)</span></label>
              <input id="apiKey" type="password" value="${s.apiKey || ""}" autocomplete="off" />
            </div>
            <div class="row">
              <button class="btn btn-primary" data-save-api>Save</button>
              <button class="btn" data-test-api>Test connection</button>
            </div>
            <div id="apiResult" class="hint"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Safety defaults</h2></div>
          <div class="card-body">
            <p class="small muted">Applied to new rules. Existing rules keep their own settings.</p>
            <div class="grid c3">
              <div class="field"><label class="label" for="maxHour">Actions per hour</label>
                <input id="maxHour" type="number" min="1" value="${s.safety.maxActionsPerHour}" /></div>
              <div class="field"><label class="label" for="maxDay">Actions per day</label>
                <input id="maxDay" type="number" min="1" value="${s.safety.maxActionsPerDay}" /></div>
              <div class="field"><label class="label" for="minGap">Minimum gap (seconds)</label>
                <input id="minGap" type="number" min="0" value="${s.safety.minGapSeconds}" /></div>
            </div>
            <label class="check"><input type="checkbox" id="reqApproval" ${raw(s.safety.requireApprovalForRules ? "checked" : "")} />
              <span>New rules stage their actions for approval</span></label>
            <div class="row" style="margin-top:.7rem">
              <label class="check"><input type="checkbox" id="quietOn" ${raw(s.safety.quietHours.enabled ? "checked" : "")} /> Quiet hours</label>
              <input type="time" id="quietFrom" value="${s.safety.quietHours.from}" style="width:auto" />
              <span class="small muted">to</span>
              <input type="time" id="quietTo" value="${s.safety.quietHours.to}" style="width:auto" />
            </div>
            <div class="row" style="margin-top:.8rem"><button class="btn btn-primary" data-save-safety>Save defaults</button></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Data</h2></div>
          <div class="card-body">
            <p class="small muted">
              Everything lives in this browser. Export before switching machines, and
              keep a copy — clearing site data clears the desk.
            </p>
            <div class="row">
              <button class="btn" data-export>Export everything</button>
              <button class="btn" data-import>Import a backup</button>
              <span class="spacer"></span>
              <button class="btn btn-danger" data-wipe>Reset workspace</button>
            </div>
            <table style="margin-top:.9rem">
              <tbody>
                ${Object.entries(counts).map(([k, v]) => html`<tr><td>${k}</td><td class="num">${v}</td></tr>`)}
              </tbody>
            </table>
          </div>
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head"><h2>This workspace</h2></div>
          <div class="card-body">
            <div class="field">
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
          <div class="card-head"><h2>Install</h2></div>
          <div class="card-body">
            <p class="small muted">
              Broadcast Desk is a progressive web app. Install it from your browser's
              address bar (or Share → Add to Home Screen) and it opens in its own
              window and works offline, apart from publishing.
            </p>
            <div id="installBox"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Shortcuts</h2></div>
          <div class="card-body">
            <table>
              <tbody>
                ${[["g d", "Dashboard"], ["g c", "Compose"], ["g q", "Queue"], ["g i", "Inbox"],
                   ["g l", "Library"], ["g r", "Rules"], ["g a", "Connections"], ["g s", "Settings"]]
                  .map(([k, v]) => html`<tr><td class="mono-sm">${k}</td><td>${v}</td></tr>`)}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  `);

  on(ctx.scope, "click", "[data-save-api]", async () => {
    await store.saveSettings({
      apiBase: $("#apiBase", root).value.trim(),
      apiKey: $("#apiKey", root).value.trim(),
    });
    toast("Backend saved", "ok");
    updateConnState();
    ctx.refresh();
  });

  on(ctx.scope, "click", "[data-test-api]", async () => {
    const box = $("#apiResult", root);
    box.textContent = "Testing…";
    await store.saveSettings({
      apiBase: $("#apiBase", root).value.trim(),
      apiKey: $("#apiKey", root).value.trim(),
    });
    const h = await api.health();
    box.innerHTML = h.mode === "live"
      ? `<span style="color:var(--emerald)">Connected${h.version ? " — " + h.version : ""}.</span>`
      : h.mode === "unauthorised"
        ? `<span style="color:var(--stamp)">Reachable, but the desk key is wrong.</span>`
      : h.mode === "error"
        ? `<span style="color:var(--stamp)">Failed: ${h.error}</span>`
        : "No URL set, so nothing to test.";
    updateConnState();
  });

  on(ctx.scope, "click", "[data-save-safety]", async () => {
    await store.saveSettings({
      safety: {
        requireApprovalForRules: $("#reqApproval", root).checked,
        maxActionsPerHour: Number($("#maxHour", root).value) || 20,
        maxActionsPerDay: Number($("#maxDay", root).value) || 150,
        minGapSeconds: Number($("#minGap", root).value) || 0,
        quietHours: {
          enabled: $("#quietOn", root).checked,
          from: $("#quietFrom", root).value,
          to: $("#quietTo", root).value,
        },
      },
    });
    toast("Defaults saved", "ok");
  });

  on(ctx.scope, "click", "[data-save-workspace]", async () => {
    const theme = $("#theme", root).value;
    await store.saveSettings({ timezone: $("#tz", root).value.trim() || "UTC", theme });
    localStorage.setItem("bd.theme", theme);
    document.documentElement.setAttribute("data-theme",
      theme === "system" ? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light") : theme);
    toast("Saved", "ok");
  });

  on(ctx.scope, "click", "[data-export]", () => {
    const payload = store.exportAll();
    download(`broadcast-desk-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
    toast("Exported");
  });

  on(ctx.scope, "click", "[data-import]", async () => {
    const file = await pickFile("application/json");
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
      "Every profile, account, library entry, template, queued post and rule is deleted from this browser. Export first if you want a copy.",
      "Delete everything")) return;
    await store.wipe();
    toast("Workspace reset");
    location.hash = "#/dashboard";
    location.reload();
  });

  paintInstall(root);
}

/** The install prompt is only offered when the browser actually has one. */
let deferredPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  deferredPrompt = e;
});

function paintInstall(root) {
  const box = $("#installBox", root);
  if (!box) return;
  if (window.matchMedia("(display-mode: standalone)").matches) {
    box.innerHTML = `<span class="badge ok">installed</span>`;
    return;
  }
  if (!deferredPrompt) {
    box.innerHTML = `<span class="small muted">Your browser has not offered an install prompt for this page yet.</span>`;
    return;
  }
  box.innerHTML = `<button class="btn btn-primary" id="installBtn">Install Broadcast Desk</button>`;
  box.querySelector("#installBtn").addEventListener("click", async () => {
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    paintInstall(root);
  });
}
