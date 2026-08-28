/**
 * Composer — write once, send to many.
 *
 * The message is a template, not a fixed string: spintax and library tokens
 * mean the same "post" can arrive on twelve accounts as twelve different
 * sentences. That is the difference between running several accounts and
 * looking like you are running several accounts.
 */

import * as store from "../store.js";
import { platform, countFor } from "../platforms.js";
import { validate, countVariations, generate, tokensUsed, contextValues, TOKENS } from "../spinner.js";
import { drawFor, renderFor, checkAccount, send, creditLibrary } from "../dispatch.js";
import { drip, describe as describeSchedule, DAY_NAMES } from "../scheduler.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, modal, formData, toast, confirmDialog,
  platformMark, avatar, emptyState, plural, toLocalInput, $, $$,
} from "../ui.js";

export const title = "Compose";
export const subtitle = () => api.isLive()
  ? "Posts go out live."
  : "Dry run — nothing is published until a backend is configured.";
export const actions = () => `
  <button class="btn" data-templates>Templates</button>
  <button class="btn" data-generate>Generate variations</button>`;

const draft = {
  body: "",
  selected: new Set(),
  uniquePerAccount: true,
  media: [],
  templateId: null,
};

export function render(root, ctx) {
  const accounts = ctx.accounts();
  const profiles = store.all("profiles");

  // Drop selections for accounts that no longer exist.
  for (const id of Array.from(draft.selected)) {
    if (!accounts.some((a) => a.id === id)) draft.selected.delete(id);
  }

  mount(root, html`
    <div class="split">
      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h2>Message</h2>
            <span class="spacer"></span>
            <span class="small muted" id="varCount"></span>
          </div>
          <div class="card-body">
            <div class="compose-box">
              <textarea id="body" placeholder="Write the message. Use {this|that} for alternatives and [keyword:tag] to pull from the library.">${draft.body}</textarea>
            </div>
            <div class="compose-tools">
              <button class="btn btn-sm" data-insert-spin>Insert {a|b}</button>
              <select id="tokenPick" style="flex:1 1 190px;min-width:0">
                <option value="">Insert a token…</option>
                ${Object.entries(TOKENS).map(([k, v]) => html`<option value="${k}">[${k}] — ${v.desc}</option>`)}
              </select>
              <button class="btn btn-sm" data-preview-spin>Preview a spin</button>
              <span class="spacer"></span>
              <button class="btn btn-sm" data-save-template>Save as template</button>
            </div>
            <div id="problems"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head">
            <h2>Delivery</h2>
            <span class="spacer"></span>
            <label class="check small">
              <input type="checkbox" id="unique" ${raw(draft.uniquePerAccount ? "checked" : "")} />
              <span>Spin a different version for each account</span>
            </label>
          </div>
          <div class="card-body">
            <div class="field">
              <label class="label" for="media">Media URLs <span class="muted">(one per line — required for Instagram, TikTok, Pinterest, YouTube)</span></label>
              <textarea id="media" rows="2" placeholder="https://…/image.jpg">${draft.media.join("\n")}</textarea>
            </div>
            <div class="row">
              <button class="btn btn-primary" data-post-now>Post now to ${draft.selected.size || 0}</button>
              <button class="btn" data-schedule>Schedule…</button>
              <button class="btn" data-drip>Generate &amp; drip…</button>
              <span class="spacer"></span>
              <button class="btn btn-ghost" data-clear>Clear</button>
            </div>
            <div class="hint" id="sendHint"></div>
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Preview per network</h2></div>
          <div class="card-body" id="previews"></div>
        </section>
      </div>

      <div class="stack">
        <section class="card">
          <div class="card-head">
            <h2>Accounts</h2>
            <span class="spacer"></span>
            <span class="badge" id="selCount">${draft.selected.size} selected</span>
          </div>
          <div class="card-head">
            <button class="btn btn-sm" data-sel-all>All</button>
            <button class="btn btn-sm" data-sel-connected>Connected</button>
            <button class="btn btn-sm" data-sel-none>None</button>
          </div>
          <div class="card-body tight">
            ${accounts.length ? profiles
              .filter((p) => accounts.some((a) => a.profileId === p.id))
              .map((p) => accountGroup(p, accounts.filter((a) => a.profileId === p.id)))
              : emptyState("No accounts", "Add accounts before composing.",
                  `<a class="btn btn-primary" href="#/accounts">Add an account</a>`)}
          </div>
        </section>

        <section class="card">
          <div class="card-head"><h2>Library reach</h2></div>
          <div class="card-body" id="reach"></div>
        </section>
      </div>
    </div>
  `);

  const bodyEl = $("#body", root);
  const refreshDerived = () => {
    draft.body = bodyEl.value;
    paintProblems(root);
    paintPreviews(root, ctx);
    paintReach(root, ctx);
    $("#selCount", root).textContent = `${draft.selected.size} selected`;
    const btn = root.querySelector("[data-post-now]");
    if (btn) btn.textContent = `Post now to ${draft.selected.size}`;
  };

  bodyEl.addEventListener("input", debounce(refreshDerived, 200));
  $("#media", root).addEventListener("input", (e) => {
    draft.media = e.target.value.split("\n").map((s) => s.trim()).filter(Boolean);
    refreshDerived();
  });
  $("#unique", root).addEventListener("change", (e) => { draft.uniquePerAccount = e.target.checked; refreshDerived(); });

  on(ctx.scope, "change", ".acct", (e, t) => {
    if (t.checked) draft.selected.add(t.value); else draft.selected.delete(t.value);
    t.closest("label").classList.toggle("on", t.checked);
    refreshDerived();
  });
  on(ctx.scope, "click", "[data-sel-all]", () => selectAll(root, ctx, () => true, refreshDerived));
  on(ctx.scope, "click", "[data-sel-connected]", () => selectAll(root, ctx, (a) => a.status === "connected", refreshDerived));
  on(ctx.scope, "click", "[data-sel-none]", () => selectAll(root, ctx, () => false, refreshDerived));
  on(ctx.scope, "click", "[data-sel-profile]", (e, t) => {
    const ids = ctx.accounts().filter((a) => a.profileId === t.dataset.selProfile).map((a) => a.id);
    const allOn = ids.every((id) => draft.selected.has(id));
    ids.forEach((id) => (allOn ? draft.selected.delete(id) : draft.selected.add(id)));
    $$(".acct", root).forEach((c) => {
      c.checked = draft.selected.has(c.value);
      c.closest("label").classList.toggle("on", c.checked);
    });
    refreshDerived();
  });

  on(ctx.scope, "click", "[data-insert-spin]", () => insertAtCursor(bodyEl, "{option one|option two}", refreshDerived));
  $("#tokenPick", root).addEventListener("change", (e) => {
    if (!e.target.value) return;
    insertAtCursor(bodyEl, `[${e.target.value}]`, refreshDerived);
    e.target.value = "";
  });
  on(ctx.scope, "click", "[data-preview-spin]", () => previewSpin(ctx));
  on(ctx.scope, "click", "[data-save-template]", () => saveTemplate(ctx));
  on(ctx.scope, "click", "[data-templates]", () => templatePicker(ctx, bodyEl, refreshDerived));
  on(ctx.scope, "click", "[data-generate]", () => generateDialog(ctx));
  on(ctx.scope, "click", "[data-clear]", async () => {
    if (!draft.body.trim() || await confirmDialog("Clear the message?", "The draft is discarded.", "Clear")) {
      draft.body = ""; draft.media = []; draft.templateId = null;
      ctx.refresh();
    }
  });
  on(ctx.scope, "click", "[data-post-now]", () => postNow(ctx));
  on(ctx.scope, "click", "[data-schedule]", () => scheduleDialog(ctx));
  on(ctx.scope, "click", "[data-drip]", () => dripDialog(ctx));

  refreshDerived();
}

/* ------------------------------------------------------------- fragments */

function accountGroup(p, accts) {
  return html`
    <div style="padding:.4rem .25rem">
      <div class="row tight" style="padding:.2rem .35rem .35rem">
        ${avatar(p.name)}
        <b class="small">${p.name}</b>
        <span class="badge">${p.kind}</span>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" data-sel-profile="${p.id}">toggle all</button>
      </div>
      <div class="picker" style="max-height:none">
        ${accts.map((a) => {
          const pl = platform(a.platform);
          const on = draft.selected.has(a.id);
          return html`
            <label class="${on ? "on" : ""}">
              <input type="checkbox" class="acct" value="${a.id}" ${raw(on ? "checked" : "")} />
              ${platformMark(pl, "sm")}
              <span class="trunc">@${a.handle}</span>
              <span class="spacer"></span>
              <span class="dot ${a.status === "connected" ? "ok" : a.status === "expired" ? "bad" : ""}" title="${a.status}"></span>
            </label>`;
        })}
      </div>
    </div>`;
}

function paintProblems(root) {
  const tags = Array.from(new Set(store.all("library").flatMap((r) => r.tags || [])));
  const problems = draft.body.trim() ? validate(draft.body, { knownTags: tags }) : [];
  const box = $("#problems", root);
  mount(box, problems.length ? html`
    <div style="margin-top:.6rem" class="stack">
      ${problems.map((p) => html`<div class="notice ${p.level === "error" ? "bad" : ""} small">${p.message}</div>`)}
    </div>` : raw(""));

  const draw = makeSizes();
  const n = draft.body.trim() ? countVariations(draft.body, draw) : 0;
  const el = $("#varCount", root);
  if (el) {
    el.textContent = n >= 1e12 ? "over a trillion variations"
      : n > 1 ? `${n.toLocaleString()} possible variations`
      : draft.body.trim() ? "one fixed message — add {a|b} or a [token]" : "";
  }
}

function makeSizes() {
  const sizes = {};
  for (const r of store.all("library")) {
    sizes[r.kind] = (sizes[r.kind] || 0) + 1;
    for (const t of r.tags || []) sizes[`${r.kind}:${t}`] = (sizes[`${r.kind}:${t}`] || 0) + 1;
  }
  return sizes;
}

function paintPreviews(root, ctx) {
  const box = $("#previews", root);
  const chosen = ctx.accounts().filter((a) => draft.selected.has(a.id));
  if (!chosen.length || !draft.body.trim()) {
    mount(box, html`<div class="empty small">Select accounts and write a message to see how it lands.</div>`);
    return;
  }
  // One preview per account when spinning individually, otherwise one per network.
  const shown = draft.uniquePerAccount
    ? chosen
    : chosen.filter((a, i, arr) => arr.findIndex((x) => x.platform === a.platform) === i);

  mount(box, html`${shown.map((a) => {
    const pl = platform(a.platform);
    const text = renderFor(draft.body, a, { draw: drawFor(a) });
    const { problems, notes, count, limit } = checkAccount(a, text, { hasMedia: draft.media.length > 0 });
    const cls = count > limit ? "bad" : count > limit * 0.9 ? "warn" : "";
    return html`
      <div class="preview">
        <div class="row tight">
          ${platformMark(pl, "sm")}
          <b class="small">${pl.name}</b>
          <span class="small muted">@${a.handle}</span>
          <span class="spacer"></span>
          <span class="counter ${cls}">${count.toLocaleString()} / ${limit.toLocaleString()}</span>
        </div>
        <div class="ptext">${overflow(text, limit, pl.id)}</div>
        ${problems.length ? html`<div class="small" style="margin-top:.45rem;color:var(--stamp)">${problems.join(" ")}</div>` : raw("")}
        ${(notes || []).length ? html`<div class="small muted" style="margin-top:.35rem">${notes.join(" ")}</div>` : raw("")}
      </div>`;
  })}`);
}

/** Show the part that would be cut off, rather than just saying it is too long. */
function overflow(text, limit, platformId) {
  if (countFor(platformId, text) <= limit) return raw(esc(text));
  // Walk forward until the counted length exceeds the limit.
  let cut = text.length;
  for (let i = 0; i <= text.length; i++) {
    if (countFor(platformId, text.slice(0, i)) > limit) { cut = i - 1; break; }
  }
  return raw(`${esc(text.slice(0, cut))}<span class="over">${esc(text.slice(cut))}</span>`);
}

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function paintReach(root, ctx) {
  const box = $("#reach", root);
  const used = tokensUsed(draft.body).filter((t) => t.kind);
  if (!used.length) {
    mount(box, html`<div class="small muted">This message does not draw from the library.
      Add a token like <code>[phrase:value]</code> to rotate content in.</div>`);
    return;
  }
  const sizes = makeSizes();
  mount(box, html`
    <table>
      <thead><tr><th>Token</th><th class="num">Entries</th></tr></thead>
      <tbody>
        ${used.map((t) => {
          const key = t.arg ? `${t.kind}:${t.arg}` : t.kind;
          const n = sizes[key] || 0;
          return html`<tr>
            <td><code class="mono-sm">[${t.name}${t.arg ? ":" + t.arg : ""}]</code></td>
            <td class="num">${n ? n : html`<span style="color:var(--stamp)">0</span>`}</td>
          </tr>`;
        })}
      </tbody>
    </table>
    <div class="hint">A token with no entries renders as nothing.</div>`);
}

/* --------------------------------------------------------------- actions */

function selectAll(root, ctx, pred, done) {
  ctx.accounts().forEach((a) => (pred(a) ? draft.selected.add(a.id) : draft.selected.delete(a.id)));
  $$(".acct", root).forEach((c) => {
    c.checked = draft.selected.has(c.value);
    c.closest("label").classList.toggle("on", c.checked);
  });
  done();
}

function insertAtCursor(el, text, done) {
  const start = el.selectionStart || 0;
  const end = el.selectionEnd || 0;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  el.focus();
  el.setSelectionRange(start + text.length, start + text.length);
  done();
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

async function previewSpin(ctx) {
  const accounts = ctx.accounts().filter((a) => draft.selected.has(a.id));
  const account = accounts[0] || ctx.accounts()[0];
  if (!account) { toast("Add an account first", "bad"); return; }
  const out = [];
  for (let i = 0; i < 5; i++) out.push(renderFor(draft.body, account, { draw: drawFor(account) }));
  await modal({
    title: "Five spins of this message",
    body: html`${out.map((t) => html`<div class="variant"><div class="vtext">${t}</div></div>`)}`,
    actions: [{ label: "Close", value: "__cancel" }],
  });
}

async function saveTemplate(ctx) {
  if (!draft.body.trim()) { toast("Nothing to save", "bad"); return; }
  const profiles = store.all("profiles");
  const v = await modal({
    title: "Save as template",
    body: html`
      <div class="field">
        <label class="label" for="t-name">Name</label>
        <input id="t-name" name="name" placeholder="Storefront — value message" />
      </div>
      <div class="field">
        <label class="label" for="t-tags">Tags</label>
        <input id="t-tags" name="tags" placeholder="storefront, evergreen" />
      </div>
      <div class="field">
        <label class="label">Belongs to</label>
        <div class="picker">
          ${profiles.map((p) => html`<label><input type="checkbox" name="profileIds" data-multi="1" value="${p.id}" />
            <span>${p.name}</span></label>`)}
        </div>
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Save", value: "save", primary: true }],
    validate: (val, dlg) => (val === "save" && !dlg.querySelector("#t-name").value.trim() ? "Name the template." : null),
  });
  if (v !== "save") return;
  const f = formData(document.getElementById("modal"));
  await store.put("templates", {
    name: f.name.trim(),
    body: draft.body,
    tags: String(f.tags || "").split(",").map((s) => s.trim()).filter(Boolean),
    profileIds: f.profileIds || [],
    platformIds: [],
  });
  toast("Template saved", "ok");
}

async function templatePicker(ctx, bodyEl, done) {
  const templates = store.all("templates")
    .filter((t) => ctx.scopeProfileId === "all" || !(t.profileIds || []).length || t.profileIds.includes(ctx.scopeProfileId));
  if (!templates.length) { toast("No templates saved yet", "bad"); return; }
  const v = await modal({
    title: "Templates",
    wide: true,
    body: html`${templates.map((t) => html`
      <div class="variant">
        <div class="vtext">
          <b>${t.name}</b>
          ${(t.tags || []).map((x) => html` <span class="chip">${x}</span>`)}
          <div class="small muted" style="white-space:pre-wrap;margin-top:.3rem">${t.body}</div>
        </div>
        <button class="btn btn-sm" type="button" data-use="${t.id}">Use</button>
        <button class="btn btn-sm btn-ghost" type="button" data-del="${t.id}">✕</button>
      </div>`)}`,
    actions: [{ label: "Close", value: "__cancel" }],
    onOpen: (dlg, close) => {
      dlg.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => {
        const t = store.get("templates", b.dataset.use);
        draft.body = t.body;
        draft.templateId = t.id;
        bodyEl.value = t.body;
        done();
        close();
        toast(`Loaded "${t.name}"`);
      }));
      dlg.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
        await store.remove("templates", b.dataset.del);
        b.closest(".variant").remove();
      }));
    },
  });
  return v;
}

async function generateDialog(ctx) {
  if (!draft.body.trim()) { toast("Write a message first", "bad"); return; }
  const account = ctx.accounts().find((a) => draft.selected.has(a.id)) || ctx.accounts()[0];
  if (!account) { toast("Add an account first", "bad"); return; }

  const draw = drawFor(account);
  const { messages, exhausted } = generate(draft.body, {
    draw,
    values: contextValues({
      account,
      profile: store.get("profiles", account.profileId),
      platformName: platform(account.platform).name,
    }),
  }, 30);

  await modal({
    title: `Generated ${messages.length} variations`,
    wide: true,
    body: html`
      ${exhausted ? html`<div class="notice">This template cannot produce 30 distinct
        messages — add more alternatives or more library entries.</div>` : raw("")}
      <div class="stack" style="margin-top:.6rem">
        ${messages.map((m, i) => html`
          <div class="variant">
            <span class="mono-sm muted">${i + 1}</span>
            <div class="vtext">${m}</div>
            <button class="btn btn-sm" type="button" data-use="${i}">Use</button>
          </div>`)}
      </div>`,
    actions: [
      { label: "Close", value: "__cancel" },
      { label: "Drip all of these", value: "drip", primary: true },
    ],
    onOpen: (dlg, close) => {
      dlg.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => {
        const text = messages[Number(b.dataset.use)];
        draft.body = text;
        close();
        ctx.refresh();
      }));
    },
  }).then((v) => { if (v === "drip") dripDialog(ctx, messages); });
}

async function postNow(ctx) {
  const accounts = ctx.accounts().filter((a) => draft.selected.has(a.id));
  if (!accounts.length) { toast("Select at least one account", "bad"); return; }
  if (!draft.body.trim()) { toast("The message is empty", "bad"); return; }

  const resolved = accounts.map((a) => {
    // Hold on to the draw: it records which library entries this spin consumed,
    // which is what gets credited once the post actually goes out.
    const draw = drawFor(a);
    const text = renderFor(draft.body, a, { draw });
    return { a, text, draw, check: checkAccount(a, text, { hasMedia: draft.media.length > 0 }) };
  });
  const blocked = resolved.filter((r) => r.check.problems.length);

  const v = await modal({
    title: `Post to ${plural(accounts.length, "account")}?`,
    wide: true,
    body: html`
      ${api.isLive() ? raw("") : html`<div class="notice"><b>Dry run.</b>
        No backend is configured, so this records the post without publishing it.</div>`}
      ${blocked.length ? html`<div class="notice bad">
        ${plural(blocked.length, "account")} will be skipped:
        <ul style="margin:.4rem 0 0;padding-left:1.1rem">
          ${blocked.map((b) => html`<li>@${b.a.handle} — ${b.check.problems.join(" ")}</li>`)}
        </ul></div>` : raw("")}
      <div class="stack" style="margin-top:.7rem">
        ${resolved.filter((r) => !r.check.problems.length).map((r) => html`
          <div class="preview">
            <div class="row tight">${platformMark(platform(r.a.platform), "sm")}
              <b class="small">@${r.a.handle}</b>
              <span class="spacer"></span>
              <span class="counter">${r.check.count}/${r.check.limit}</span></div>
            <div class="ptext">${r.text}</div>
          </div>`)}
      </div>`,
    actions: [
      { label: "Cancel", value: "__cancel" },
      { label: api.isLive() ? "Post now" : "Record dry run", value: "go", primary: true },
    ],
  });
  if (v !== "go") return;

  const post = await store.put("posts", {
    body: draft.body,
    accountIds: accounts.map((a) => a.id),
    perAccountText: Object.fromEntries(resolved.map((r) => [r.a.id, r.text])),
    uniquePerAccount: draft.uniquePerAccount,
    media: draft.media,
    status: "sending",
    origin: "composer",
    templateId: draft.templateId,
  });

  const done = await send(post);
  await creditLibrary(
    resolved.filter((r) => (done.results || []).some((x) => x.accountId === r.a.id && x.ok))
            .flatMap((r) => r.draw.picked)
  );

  const ok = (done.results || []).filter((r) => r.ok).length;
  toast(`${ok}/${(done.results || []).length} accounts ${done.simulated ? "simulated" : "posted"}`,
        ok ? "ok" : "bad", 5000);
  location.hash = "#/queue";
}

async function scheduleDialog(ctx) {
  const accounts = ctx.accounts().filter((a) => draft.selected.has(a.id));
  if (!accounts.length) { toast("Select at least one account", "bad"); return; }
  if (!draft.body.trim()) { toast("The message is empty", "bad"); return; }

  const when = new Date(Date.now() + 36e5);
  const v = await modal({
    title: "Schedule this post",
    body: html`
      <div class="field">
        <label class="label" for="s-when">Send at</label>
        <input id="s-when" name="when" type="datetime-local" value="${toLocalInput(when)}" />
      </div>
      <p class="small muted">Going to ${plural(accounts.length, "account")}.
      ${draft.uniquePerAccount ? "Each account gets its own spin, generated when it sends." : "Every account gets the same text."}</p>
      ${api.isLive() ? raw("") : html`<div class="notice">Without a backend the queue only
        sends while this tab is open. Configure the Worker to have it send unattended.</div>`}`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Schedule", value: "go", primary: true }],
  });
  if (v !== "go") return;

  const f = formData(document.getElementById("modal"));
  await store.put("posts", {
    body: draft.body,
    accountIds: accounts.map((a) => a.id),
    uniquePerAccount: draft.uniquePerAccount,
    media: draft.media,
    status: "queued",
    scheduledAt: new Date(f.when).toISOString(),
    origin: "composer",
    templateId: draft.templateId,
  });
  toast("Scheduled", "ok");
  location.hash = "#/queue";
}

/** Generate a pool of variations and lay them across a repeating schedule. */
async function dripDialog(ctx, pregenerated) {
  const accounts = ctx.accounts().filter((a) => draft.selected.has(a.id));
  if (!accounts.length) { toast("Select at least one account", "bad"); return; }
  if (!draft.body.trim() && !pregenerated) { toast("The message is empty", "bad"); return; }

  const v = await modal({
    title: "Generate and drip",
    body: html`
      <p class="small muted">Spins a pool of messages and lays them across a repeating
      schedule, one post per slot.</p>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="d-count">How many posts</label>
          <input id="d-count" name="count" type="number" min="1" max="200" value="${pregenerated ? pregenerated.length : 20}" />
        </div>
        <div class="field">
          <label class="label" for="d-mode">Spacing</label>
          <select id="d-mode" name="mode">
            <option value="slots">Fixed times each day</option>
            <option value="interval">Every so often</option>
          </select>
        </div>
      </div>
      <div id="slotsFields">
        <div class="field">
          <label class="label" for="d-times">Times <span class="muted">(comma separated, 24h)</span></label>
          <input id="d-times" name="times" value="09:15, 13:40, 17:20" />
        </div>
        <div class="field">
          <label class="label" for="d-jitter">Scatter <span class="muted">(± minutes, so it is not metronomic)</span></label>
          <input id="d-jitter" name="jitterMin" type="number" min="0" max="120" value="12" />
        </div>
      </div>
      <div id="intervalFields" style="display:none">
        <div class="grid c2" style="gap:.6rem">
          <div class="field"><label class="label" for="d-from">Between</label><input id="d-from" name="from" type="time" value="09:00" /></div>
          <div class="field"><label class="label" for="d-to">and</label><input id="d-to" name="to" type="time" value="21:00" /></div>
          <div class="field"><label class="label" for="d-min">Every, at least (min)</label><input id="d-min" name="everyMin" type="number" min="1" value="45" /></div>
          <div class="field"><label class="label" for="d-max">and at most (min)</label><input id="d-max" name="everyMaxMin" type="number" min="1" value="120" /></div>
        </div>
      </div>
      <div class="field">
        <label class="label">Days</label>
        <div class="row tight">
          ${DAY_NAMES.map((d, i) => html`
            <label class="check"><input type="checkbox" name="days" data-multi="1" value="${i}" ${raw(i > 0 && i < 6 ? "checked" : "")} /> ${d}</label>`)}
        </div>
      </div>
      <div class="field">
        <label class="label">Send to</label>
        <select name="fanout">
          <option value="each">Every selected account gets every post (${accounts.length}× posts)</option>
          <option value="spread">Spread the pool across the selected accounts</option>
        </select>
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Build the queue", value: "go", primary: true }],
    onOpen: (dlg) => {
      const mode = dlg.querySelector("#d-mode");
      mode.addEventListener("change", () => {
        dlg.querySelector("#slotsFields").style.display = mode.value === "slots" ? "" : "none";
        dlg.querySelector("#intervalFields").style.display = mode.value === "interval" ? "" : "none";
      });
    },
  });
  if (v !== "go") return;

  const f = formData(document.getElementById("modal"));
  const count = Math.max(1, Math.min(200, Number(f.count) || 20));
  const schedule = {
    mode: f.mode,
    days: (f.days || []).map(Number),
    times: String(f.times || "").split(",").map((s) => s.trim()).filter(Boolean),
    jitterMin: Number(f.jitterMin) || 0,
    from: f.from, to: f.to,
    everyMin: Number(f.everyMin) || 45,
    everyMaxMin: Number(f.everyMaxMin) || 120,
  };

  const seedAccount = accounts[0];
  const draw = drawFor(seedAccount);
  const pool = pregenerated || generate(draft.body, { draw }, count).messages;
  if (!pool.length) { toast("Nothing generated", "bad"); return; }

  const assignments = pool.slice(0, count).map((text, i) => ({
    text,
    accountIds: f.fanout === "each" ? accounts.map((a) => a.id) : [accounts[i % accounts.length].id],
  }));
  const dripped = drip(assignments, schedule);

  await store.putMany("posts", dripped.map((d) => ({
    body: d.text,
    renderedText: d.text,
    accountIds: d.accountIds,
    uniquePerAccount: false,
    media: draft.media,
    status: "queued",
    scheduledAt: d.scheduledAt,
    origin: "drip",
  })));

  await store.log("schedule", `Queued ${dripped.length} posts — ${describeSchedule(schedule)}`);
  toast(`Queued ${dripped.length} posts`, "ok");
  location.hash = "#/queue";
}
