/**
 * Rule adder.
 *
 * Rules are written in one dialog with a sentence underneath that updates as
 * you build. The sentence is the point: a rule you cannot read back in plain
 * English is a rule you should not switch on.
 *
 * Every rule carries rate caps and, by default, stages its actions in the
 * inbox for approval instead of firing them straight at the network.
 */

import * as store from "../store.js";
import { platform } from "../../../shared/platforms.js";
import { sampleFeed } from "../seed.js";
import {
  TRIGGERS, ACTIONS, MATCH_MODES, blankRule, summarize, validateRule, simulate,
} from "../rules.js";
import { DAY_NAMES } from "../scheduler.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  platformMark, emptyState, relTime, plural, $, $$,
} from "../ui.js";

export const title = "Rules";
export const subtitle = () => {
  const rules = store.all("rules");
  const active = rules.filter((r) => r.enabled).length;
  return rules.length ? `${active} of ${plural(rules.length, "rule")} active` : "No rules yet";
};
export const actions = () => `<button class="btn btn-primary" data-new>Add a rule</button>`;

export function render(root, ctx) {
  const accounts = store.all("accounts");
  const profiles = store.all("profiles");
  const templates = store.all("templates");
  const rules = store.all("rules").filter((r) =>
    ctx.scopeProfileId === "all" ||
    (r.profileIds || []).includes(ctx.scopeProfileId) ||
    (r.accountIds || []).some((id) => {
      const a = accounts.find((x) => x.id === id);
      return a && a.profileId === ctx.scopeProfileId;
    }));

  mount(root, html`
    <section class="stack">
      ${rules.length ? rules.map((r) => card(r, { accounts, profiles, templates })) : raw("")}
    </section>

    ${rules.length ? raw("") : emptyState(
      "No rules yet",
      "A rule watches for something on your accounts and does something about it — reply to a mention, repost a keyword hit, thank a new follower.",
      `<button class="btn btn-primary" data-new>Add the first rule</button>`)}

    <section class="card" style="margin-top:1.25rem">
      <div class="card-head"><h2>Before you switch rules on</h2></div>
      <div class="card-body">
        <p class="small muted">
          Every network's automation policy is written in terms of volume and
          repetition. Bulk identical replies, mass reposting and anything that
          looks like a follow campaign are what get accounts limited — and on a
          client's account that is their asset, not yours. The defaults here are
          deliberately timid: low caps, one action per author, approval before
          anything goes out. Loosen them slowly, and keep automated replies to
          the ones a person would actually have sent.
        </p>
      </div>
    </section>
  `);

  on(ctx.scope, "click", "[data-new]", () => editor(null, ctx));
  on(ctx.scope, "click", "[data-edit]", (e, t) => editor(store.get("rules", t.dataset.edit), ctx));
  on(ctx.scope, "click", "[data-sim]", (e, t) => simulateRule(store.get("rules", t.dataset.sim), ctx));
  on(ctx.scope, "change", "[data-toggle]", async (e, t) => {
    const r = store.get("rules", t.dataset.toggle);
    if (t.checked) {
      const problems = validateRule(r);
      if (problems.length) {
        t.checked = false;
        toast(problems[0], "bad", 5000);
        return;
      }
    }
    await store.put("rules", { ...r, enabled: t.checked });
    await store.log("rule", `${t.checked ? "Enabled" : "Paused"} rule "${r.name}"`);
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-dup]", async (e, t) => {
    const r = store.get("rules", t.dataset.dup);
    const { id, createdAt, updatedAt, ...rest } = r;
    await store.put("rules", { ...rest, name: r.name + " (copy)", enabled: false, stats: { matched: 0, acted: 0, skipped: 0 } });
    toast("Duplicated");
    ctx.refresh();
  });
  on(ctx.scope, "click", "[data-del]", async (e, t) => {
    const r = store.get("rules", t.dataset.del);
    if (!await confirmDialog("Delete rule?", `"${r.name}" is removed. Anything it already staged stays in the inbox.`)) return;
    await store.remove("rules", r.id);
    ctx.refresh();
  });
}

function card(r, refs) {
  const problems = validateRule(r);
  return html`
    <div class="card">
      <div class="card-head">
        <label class="check" style="gap:.45rem">
          <input type="checkbox" data-toggle="${r.id}" ${raw(r.enabled ? "checked" : "")} aria-label="Enable rule" />
        </label>
        <h2>${r.name || "Untitled rule"}</h2>
        <span class="badge ${r.enabled ? "ok" : ""}">${r.enabled ? "active" : "paused"}</span>
        ${(r.safety || {}).requireApproval ? html`<span class="badge info">needs approval</span>` : html`<span class="badge warn">automatic</span>`}
        <span class="spacer"></span>
        <span class="small muted">
          ${(r.stats || {}).acted || 0} acted · ${(r.stats || {}).matched || 0} matched
          ${r.lastFiredAt ? html` · last ${relTime(r.lastFiredAt)}` : raw("")}
        </span>
      </div>
      <div class="card-body">
        <div class="rule-sentence">${raw(summarize(r, refs))}</div>
        ${problems.length ? html`
          <div class="notice bad small" style="margin-top:.7rem">
            ${problems.map((p) => html`<div>${p}</div>`)}
          </div>` : raw("")}
      </div>
      <div class="card-head" style="border-bottom:0;border-top:1px solid var(--line)">
        <button class="btn btn-sm" data-edit="${r.id}">Edit</button>
        <button class="btn btn-sm" data-sim="${r.id}">Test it</button>
        <button class="btn btn-sm btn-ghost" data-dup="${r.id}">Duplicate</button>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-danger" data-del="${r.id}">Delete</button>
      </div>
    </div>`;
}

/* ---------------------------------------------------------------- editor */

async function editor(existing, ctx) {
  const r = existing ? JSON.parse(JSON.stringify(existing)) : blankRule();
  const accounts = store.all("accounts");
  const profiles = store.all("profiles");
  const templates = store.all("templates");
  const tags = Array.from(new Set(store.all("library").flatMap((x) => x.tags || []))).sort();

  const body = html`
    <div class="step" data-step="1">
      <h3>Which accounts does this rule act on?</h3>
      <div class="picker">
        ${accounts.length ? accounts.map((a) => {
          const p = profiles.find((x) => x.id === a.profileId);
          return html`
            <label class="${(r.accountIds || []).includes(a.id) ? "on" : ""}">
              <input type="checkbox" name="accountIds" data-multi="1" value="${a.id}" ${raw((r.accountIds || []).includes(a.id) ? "checked" : "")} />
              ${platformMark(platform(a.platform), "sm")}
              <span>@${a.handle}</span>
              <span class="spacer"></span>
              <span class="small muted">${p ? p.name : ""}</span>
            </label>`;
        }) : html`<div class="small muted">No accounts yet — add one first.</div>`}
      </div>
    </div>

    <div class="step" data-step="2">
      <h3>What should it watch for?</h3>
      <div class="field">
        <select name="triggerType" id="triggerType">
          ${Object.entries(TRIGGERS).map(([k, v]) => html`
            <option value="${k}" ${raw(r.trigger.type === k ? "selected" : "")}>${v.label}</option>`)}
        </select>
      </div>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="terms">Terms <span class="muted">(comma separated)</span></label>
          <input id="terms" name="terms" value="${(r.trigger.terms || []).join(", ")}" placeholder="top-up, airtime, gift card" />
        </div>
        <div class="field">
          <label class="label" for="matchMode">Match</label>
          <select id="matchMode" name="matchMode">
            ${Object.entries(MATCH_MODES).map(([k, v]) => html`
              <option value="${k}" ${raw(r.trigger.matchMode === k ? "selected" : "")}>${v}</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="exclude">Never act if it contains</label>
          <input id="exclude" name="exclude" value="${(r.trigger.exclude || []).join(", ")}" placeholder="crypto, dm me, free followers" />
        </div>
        <div class="field">
          <label class="label" for="minFollowers">Author must have at least</label>
          <input id="minFollowers" name="minFollowers" type="number" min="0" value="${r.trigger.minFollowers || 0}" />
        </div>
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" name="verifiedOnly" ${raw(r.trigger.verifiedOnly ? "checked" : "")} /> Verified authors only</label>
        <label class="check"><input type="checkbox" name="skipReposts" ${raw(r.trigger.skipReposts ? "checked" : "")} /> Ignore reposts</label>
        <label class="check"><input type="checkbox" name="skipReplies" ${raw(r.trigger.skipReplies ? "checked" : "")} /> Ignore replies</label>
      </div>
    </div>

    <div class="step" data-step="3">
      <h3>What should it do?</h3>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="actionType">Action</label>
          <select id="actionType" name="actionType">
            ${Object.entries(ACTIONS).map(([k, v]) => html`
              <option value="${k}" ${raw(r.action.type === k ? "selected" : "")}>${v.label}</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="source">Message comes from</label>
          <select id="source" name="source">
            <option value="template" ${raw(r.action.source === "template" ? "selected" : "")}>A saved template</option>
            <option value="library" ${raw(r.action.source === "library" ? "selected" : "")}>Library entries by tag</option>
            <option value="text" ${raw(r.action.source === "text" ? "selected" : "")}>Text written here</option>
          </select>
        </div>
      </div>
      <div class="field" data-src="template">
        <label class="label">Templates <span class="muted">(one is picked at random each time)</span></label>
        <div class="picker">
          ${templates.length ? templates.map((t) => html`
            <label class="${(r.action.templateIds || []).includes(t.id) ? "on" : ""}">
              <input type="checkbox" name="templateIds" data-multi="1" value="${t.id}" ${raw((r.action.templateIds || []).includes(t.id) ? "checked" : "")} />
              <span>${t.name}</span></label>`)
            : html`<div class="small muted">No templates saved. Write one in Compose → Save as template.</div>`}
        </div>
      </div>
      <div class="field" data-src="library">
        <label class="label">Library tags</label>
        <div class="picker">
          ${tags.length ? tags.map((t) => html`
            <label class="${(r.action.libraryTags || []).includes(t) ? "on" : ""}">
              <input type="checkbox" name="libraryTags" data-multi="1" value="${t}" ${raw((r.action.libraryTags || []).includes(t) ? "checked" : "")} />
              <span>${t}</span></label>`)
            : html`<div class="small muted">No tags in the library yet.</div>`}
        </div>
      </div>
      <div class="field" data-src="text">
        <label class="label" for="actionText">Message <span class="muted">(spintax and tokens work here too)</span></label>
        <textarea id="actionText" name="actionText" rows="3" placeholder="{Thanks|Appreciate it}, [author] — [cta] [link]">${r.action.text || ""}</textarea>
      </div>
    </div>

    <div class="step" data-step="4">
      <h3>How often, and how careful?</h3>
      <div class="grid c4" style="gap:.6rem">
        <div class="field"><label class="label" for="perHour">Max per hour</label>
          <input id="perHour" name="perHour" type="number" min="0" value="${r.limits.perHour}" /></div>
        <div class="field"><label class="label" for="perDay">Max per day</label>
          <input id="perDay" name="perDay" type="number" min="0" value="${r.limits.perDay}" /></div>
        <div class="field"><label class="label" for="cooldownMin">Min gap (min)</label>
          <input id="cooldownMin" name="cooldownMin" type="number" min="0" value="${r.limits.cooldownMin}" /></div>
        <div class="field"><label class="label" for="maxPerAuthor">Max per author</label>
          <input id="maxPerAuthor" name="maxPerAuthor" type="number" min="0" value="${r.limits.maxPerAuthor}" /></div>
      </div>
      <div class="row">
        <label class="check"><input type="checkbox" name="hoursEnabled" ${raw(r.limits.activeHours.enabled ? "checked" : "")} /> Only between</label>
        <input type="time" name="hoursFrom" value="${r.limits.activeHours.from}" style="width:auto" />
        <span class="small muted">and</span>
        <input type="time" name="hoursTo" value="${r.limits.activeHours.to}" style="width:auto" />
      </div>
      <div class="field" style="margin-top:.7rem">
        <label class="label">Days</label>
        <div class="row tight">
          ${DAY_NAMES.map((d, i) => html`
            <label class="check"><input type="checkbox" name="days" data-multi="1" value="${i}" ${raw((r.limits.days || []).includes(i) ? "checked" : "")} /> ${d}</label>`)}
        </div>
      </div>
      <label class="check"><input type="checkbox" name="requireApproval" ${raw(r.safety.requireApproval ? "checked" : "")} />
        <span><b>Stage actions in the inbox for approval</b><br>
        <span class="small muted">Off means the rule acts on its own. Start with this on.</span></span></label>
      <label class="check" style="margin-top:.5rem"><input type="checkbox" name="skipIfInteractedBefore" ${raw(r.safety.skipIfInteractedBefore ? "checked" : "")} />
        <span>Skip anyone this rule has already acted on</span></label>
    </div>

    <div class="field">
      <label class="label" for="ruleName">Name this rule</label>
      <input id="ruleName" name="name" value="${r.name || ""}" placeholder="Reply to top-up questions" />
    </div>

    <div class="rule-sentence" id="sentence"></div>`;

  const v = await modal({
    title: existing ? "Edit rule" : "Add a rule",
    wide: true,
    body,
    actions: [
      { label: "Cancel", value: "__cancel" },
      { label: "Save paused", value: "save" },
      { label: "Save and activate", value: "activate", primary: true },
    ],
    validate: (val, dlg) => {
      if (val === "__cancel") return null;
      const draft = collect(dlg, r);
      const problems = validateRule(draft);
      if (val === "activate" && problems.length) return problems[0];
      if (!draft.name.trim()) return "Give the rule a name.";
      return null;
    },
    onOpen: (dlg) => {
      const sync = () => {
        const draft = collect(dlg, r);
        $("#sentence", dlg).innerHTML = summarize(draft, { accounts, profiles, templates });
        const src = $("#source", dlg).value;
        $$("[data-src]", dlg).forEach((n) => { n.style.display = n.dataset.src === src ? "" : "none"; });
        const t = TRIGGERS[$("#triggerType", dlg).value] || {};
        $("#terms", dlg).closest(".field").style.opacity = t.needsTerms === false ? ".65" : "1";
        dlg.querySelectorAll(".picker label").forEach((l) => {
          const cb = l.querySelector("input");
          if (cb) l.classList.toggle("on", cb.checked);
        });
      };
      dlg.addEventListener("input", sync);
      dlg.addEventListener("change", sync);
      sync();
    },
  });
  if (v !== "save" && v !== "activate") return;

  const draft = collect(document.getElementById("modal"), r);
  draft.enabled = v === "activate";
  await store.put("rules", { ...(existing || {}), ...draft });
  await store.log("rule", `${existing ? "Updated" : "Created"} rule "${draft.name}"${draft.enabled ? " (active)" : ""}`);
  toast(draft.enabled ? "Rule active" : "Rule saved, paused", "ok");
  ctx.refresh();
}

/** Read the whole dialog back into a rule object. */
function collect(dlg, base) {
  const f = formData(dlg);
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  return {
    ...base,
    name: (f.name || "").trim(),
    accountIds: f.accountIds || [],
    profileIds: base.profileIds || [],
    trigger: {
      type: f.triggerType,
      terms: list(f.terms),
      matchMode: f.matchMode,
      exclude: list(f.exclude),
      minFollowers: Number(f.minFollowers) || 0,
      verifiedOnly: !!f.verifiedOnly,
      skipReposts: !!f.skipReposts,
      skipReplies: !!f.skipReplies,
      language: base.trigger.language || "",
    },
    action: {
      type: f.actionType,
      source: f.source,
      templateIds: f.templateIds || [],
      libraryTags: f.libraryTags || [],
      text: f.actionText || "",
    },
    limits: {
      perHour: Number(f.perHour) || 0,
      perDay: Number(f.perDay) || 0,
      cooldownMin: Number(f.cooldownMin) || 0,
      maxPerAuthor: Number(f.maxPerAuthor) || 0,
      days: (f.days || []).map(Number),
      activeHours: { enabled: !!f.hoursEnabled, from: f.hoursFrom, to: f.hoursTo },
    },
    safety: {
      requireApproval: !!f.requireApproval,
      skipIfInteractedBefore: !!f.skipIfInteractedBefore,
    },
  };
}

/* -------------------------------------------------------------- simulator */

async function simulateRule(rule, ctx) {
  const real = store.all("inbox");
  const items = real.length ? real : sampleFeed(store.all("accounts"));
  const recent = store.where("events", (e) => e.kind === "rule" && e.meta && e.meta.ruleId === rule.id)
    .map((e) => ({ at: e.at, ruleId: rule.id, authorHandle: (e.meta || {}).authorHandle }));
  const out = simulate(rule, items, { recent });

  await modal({
    title: `Test: ${rule.name || "rule"}`,
    wide: true,
    body: html`
      <div class="notice info small">
        Run against ${real.length ? "the current inbox" : "sample items"}
        (${plural(items.length, "item")}). Nothing is sent.
      </div>
      <p class="small"><b>${out.wouldAct}</b> would be acted on,
        <b>${out.matchedButHeld}</b> matched but were held by the caps,
        <b>${items.length - out.wouldAct - out.matchedButHeld}</b> did not match.</p>
      <table>
        <thead><tr><th>Item</th><th>Author</th><th>Outcome</th></tr></thead>
        <tbody>
          ${out.results.map((res) => html`
            <tr>
              <td class="small" style="max-width:36ch">${res.item.text || `(${res.item.kind})`}</td>
              <td class="mono-sm">@${(res.item.author || {}).handle || "?"}</td>
              <td>${res.ok
                ? html`<span class="badge ok">${res.reason}</span>`
                : html`<span class="badge">${res.reason}</span>`}</td>
            </tr>`)}
        </tbody>
      </table>`,
    actions: [{ label: "Close", value: "__cancel" }],
  });
}
