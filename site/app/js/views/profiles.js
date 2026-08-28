/**
 * Profiles — the identities the desk posts as.
 *
 * Three kinds, and the distinction is not cosmetic: a client profile is
 * someone else's property, so it carries the engagement details, keeps its own
 * timezone, and is the unit you hand back or delete when the work ends.
 */

import * as store from "../store.js";
import { platform } from "../platforms.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  avatar, emptyState, plural, fmtDate,
} from "../ui.js";

export const title = "Profiles";
export const subtitle = (c) => `${plural(c.profiles().length, "profile")} · ${plural(store.all("accounts").length, "connected account")}`;
export const actions = () => `<button class="btn btn-primary" data-new-profile>New profile</button>`;

const KINDS = {
  personal: { label: "Personal", note: "Your own accounts." },
  business: { label: "Business", note: "Your company's accounts." },
  client:   { label: "Client", note: "Managed on a customer's behalf." },
};

export function render(root, ctx) {
  const profiles = store.all("profiles");
  const accounts = store.all("accounts");

  mount(root, html`
    <section class="grid c2">
      ${profiles.length ? profiles.map((p) => card(p, accounts.filter((a) => a.profileId === p.id))) : raw("")}
    </section>
    ${profiles.length ? raw("") : emptyState(
      "No profiles yet",
      "A profile groups the accounts you post as — one for yourself, one per business, one per client.",
      `<button class="btn btn-primary" data-new-profile>Create the first profile</button>`
    )}
  `);

  on(ctx.scope, "click", "[data-new-profile]", () => editor(null, ctx));
  on(ctx.scope, "click", "[data-edit]", (e, t) => editor(store.get("profiles", t.dataset.edit), ctx));
  on(ctx.scope, "click", "[data-del]", async (e, t) => {
    const p = store.get("profiles", t.dataset.del);
    const n = accounts.filter((a) => a.profileId === p.id).length;
    const ok = await confirmDialog(
      `Delete "${p.name}"?`,
      n ? `This also removes its ${plural(n, "connected account")} from the desk. Queued posts for those accounts are left in the queue but will not send.`
        : "This cannot be undone.",
    );
    if (!ok) return;
    await store.removeCascade("profiles", p.id);
    await store.log("system", `Deleted profile ${p.name}`);
    toast("Profile deleted");
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-accounts]", (e, t) => { location.hash = `#/accounts?profile=${t.dataset.accounts}`; });
}

function card(p, accts) {
  const connected = accts.filter((a) => a.status === "connected").length;
  const kind = KINDS[p.kind] || KINDS.personal;
  return html`
    <div class="card">
      <div class="card-head">
        ${avatar(p.name)}
        <div style="min-width:0">
          <h2 class="trunc">${p.name}</h2>
          <div class="small muted">${kind.label}${p.client && p.client.company ? " · " + p.client.company : ""}</div>
        </div>
        <span class="spacer"></span>
        <span class="badge ${p.kind === "client" ? "info" : ""}">${p.kind}</span>
      </div>
      <div class="card-body">
        ${p.notes ? html`<p class="small muted">${p.notes}</p>` : raw("")}
        <div class="row tight" style="margin:.5rem 0 .75rem">
          ${accts.length
            ? accts.map((a) => {
                const pl = platform(a.platform);
                return html`<span class="chip" title="${pl.name} · @${a.handle} · ${a.status}">
                  <span class="dot ${a.status === "connected" ? "ok" : a.status === "expired" ? "bad" : ""}"></span>${pl.abbr} @${a.handle}
                </span>`;
              })
            : html`<span class="small muted">No accounts linked yet.</span>`}
        </div>
        <div class="small muted">
          ${connected} of ${accts.length} connected · ${p.timezone || "UTC"}
          ${p.client && p.client.startedAt ? html` · since ${fmtDate(p.client.startedAt)}` : raw("")}
        </div>
      </div>
      <div class="card-head" style="border-bottom:0;border-top:1px solid var(--line)">
        <button class="btn btn-sm" data-accounts="${p.id}">Manage connections</button>
        <button class="btn btn-sm" data-edit="${p.id}">Edit</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-danger" data-del="${p.id}">Delete</button>
      </div>
    </div>`;
}

async function editor(existing, ctx) {
  const p = existing || { kind: "personal", timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC", client: {} };
  const zones = (typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [])
    .slice(0, 600);

  const body = html`
    <div class="field">
      <label class="label" for="p-name">Name</label>
      <input id="p-name" name="name" type="text" value="${p.name || ""}" placeholder="Rullo Enterprises" required />
    </div>
    <div class="field">
      <label class="label">Kind</label>
      <div class="row">
        ${Object.entries(KINDS).map(([k, v]) => html`
          <label class="check" style="border:1px solid var(--line);border-radius:var(--r-sm);padding:.45rem .6rem;flex:1;min-width:150px">
            <input type="radio" name="kind" value="${k}" ${raw((p.kind || "personal") === k ? "checked" : "")} />
            <span><b>${v.label}</b><br><span class="small muted">${v.note}</span></span>
          </label>`)}
      </div>
    </div>
    <div id="clientFields" style="${raw(p.kind === "client" ? "" : "display:none")}">
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="p-company">Client company</label>
          <input id="p-company" name="company" type="text" value="${(p.client || {}).company || ""}" />
        </div>
        <div class="field">
          <label class="label" for="p-contact">Main contact</label>
          <input id="p-contact" name="contact" type="text" value="${(p.client || {}).contact || ""}" />
        </div>
        <div class="field">
          <label class="label" for="p-email">Contact email</label>
          <input id="p-email" name="email" type="email" value="${(p.client || {}).email || ""}" />
        </div>
        <div class="field">
          <label class="label" for="p-started">Engagement started</label>
          <input id="p-started" name="startedAt" type="date" value="${(p.client || {}).startedAt || ""}" />
        </div>
      </div>
      <div class="notice" style="margin-bottom:.85rem">
        Client accounts are connected by the client authorising this app on each
        network. Do not collect or store a client's password — an authorisation
        survives their password changes and two-factor, and a password does not.
      </div>
    </div>
    <div class="field">
      <label class="label" for="p-tz">Timezone <span class="muted">(used when scheduling for this profile)</span></label>
      <input id="p-tz" name="timezone" list="tzlist" value="${p.timezone || "UTC"}" />
      <datalist id="tzlist">${zones.map((z) => html`<option value="${z}"></option>`)}</datalist>
    </div>
    <div class="field">
      <label class="label" for="p-notes">Voice notes <span class="muted">(reminder of how this profile should sound)</span></label>
      <textarea id="p-notes" name="notes" rows="3" placeholder="Plain and useful. No hype.">${p.notes || ""}</textarea>
    </div>`;

  const v = await modal({
    title: existing ? "Edit profile" : "New profile",
    body,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: existing ? "Save" : "Create", value: "save", primary: true }],
    validate: (val, dlg) => (val === "save" && !dlg.querySelector("#p-name").value.trim() ? "Give the profile a name." : null),
    onOpen: (dlg) => {
      dlg.querySelectorAll('[name="kind"]').forEach((r) => r.addEventListener("change", () => {
        dlg.querySelector("#clientFields").style.display = r.value === "client" && r.checked ? "" : "none";
      }));
    },
  });
  if (v !== "save") return;

  const dlg = document.getElementById("modal");
  const f = formData(dlg);
  await store.put("profiles", {
    ...(existing || {}),
    name: f.name.trim(),
    kind: f.kind,
    timezone: f.timezone.trim() || "UTC",
    notes: f.notes.trim(),
    client: f.kind === "client"
      ? { company: f.company, contact: f.contact, email: f.email, startedAt: f.startedAt }
      : (existing || {}).client || {},
  });
  toast(existing ? "Profile saved" : "Profile created", "ok");
  ctx.refresh();
}
