/**
 * Library — the vocabulary the generator draws from.
 *
 * Keywords, phrases, hashtags, links, calls to action and emoji, each tagged
 * and optionally restricted to certain profiles or networks. This is the
 * "database of key words and phrases to post about, and from which accounts"
 * — the restriction is what keeps a client's vocabulary out of your personal
 * timeline.
 */

import * as store from "../store.js";
import { PLATFORMS, platform } from "../platforms.js";
import {
  html, raw, mount, on, modal, formData, confirmDialog, toast,
  emptyState, relTime, plural, download, pickFile, $$,
} from "../ui.js";

export const title = "Library";
export const subtitle = () => {
  const rows = store.all("library");
  const tags = new Set(rows.flatMap((r) => r.tags || []));
  return `${plural(rows.length, "entry", "entries")} across ${plural(tags.size, "tag")}`;
};
export const actions = () => `
  <button class="btn" data-bulk>Bulk add</button>
  <button class="btn" data-io>Import / export</button>
  <button class="btn btn-primary" data-new>New entry</button>`;

export const KINDS = [
  { id: "keyword", label: "Keywords", token: "[keyword]", note: "Subjects you post about." },
  { id: "phrase",  label: "Phrases",  token: "[phrase]",  note: "Whole sentences and openers." },
  { id: "hashtag", label: "Hashtags", token: "[hashtag]", note: "Tags, stored with the #." },
  { id: "link",    label: "Links",    token: "[link]",    note: "URLs you rotate through." },
  { id: "cta",     label: "Calls to action", token: "[cta]", note: "\"Have a look:\", \"Details:\"" },
  { id: "emoji",   label: "Emoji",    token: "[emoji]",   note: "Kept separate so posts can go without." },
];

let filter = { kind: "all", q: "", tag: "", profileId: "" };

export function render(root, ctx) {
  const all = store.all("library");
  const profiles = store.all("profiles");
  const tags = Array.from(new Set(all.flatMap((r) => r.tags || []))).sort();

  const rows = all.filter((r) => {
    if (filter.kind !== "all" && r.kind !== filter.kind) return false;
    if (filter.tag && !(r.tags || []).includes(filter.tag)) return false;
    if (filter.q && !r.text.toLowerCase().includes(filter.q.toLowerCase())) return false;
    if (ctx.scopeProfileId !== "all" && (r.profileIds || []).length &&
        !r.profileIds.includes(ctx.scopeProfileId)) return false;
    return true;
  });

  mount(root, html`
    <section class="card">
      <div class="card-head">
        <div class="tabs" style="border:0">
          <button data-kind="all" aria-selected="${filter.kind === "all"}">All (${all.length})</button>
          ${KINDS.map((k) => {
            const n = all.filter((r) => r.kind === k.id).length;
            return html`<button data-kind="${k.id}" aria-selected="${filter.kind === k.id}">${k.label} (${n})</button>`;
          })}
        </div>
      </div>
      <div class="card-head">
        <input type="search" id="q" placeholder="Search entries…" value="${filter.q}" style="max-width:280px" />
        <select id="tagFilter" style="max-width:190px">
          <option value="">Any tag</option>
          ${tags.map((t) => html`<option value="${t}" ${raw(t === filter.tag ? "selected" : "")}>${t}</option>`)}
        </select>
        <span class="spacer"></span>
        <span class="small muted">${plural(rows.length, "match", "matches")}</span>
        <button class="btn btn-sm btn-danger" data-delsel disabled>Delete selected</button>
      </div>

      ${rows.length ? html`
        <div class="card-body tight scroll-y" style="max-height:none">
          <table>
            <thead>
              <tr>
                <th style="width:26px"><input type="checkbox" id="selAll" aria-label="Select all" /></th>
                <th>Text</th><th>Kind</th><th>Tags</th><th>Scope</th>
                <th class="num">Weight</th><th class="num">Used</th><th class="actions"></th>
              </tr>
            </thead>
            <tbody>
              ${rows.map((r) => html`
                <tr>
                  <td><input type="checkbox" class="sel" value="${r.id}" aria-label="Select entry" /></td>
                  <td>${r.text}</td>
                  <td><span class="badge">${r.kind}</span></td>
                  <td>${(r.tags || []).map((t) => html`<span class="chip" data-tag="${t}" role="button" tabindex="0">${t}</span> `)}</td>
                  <td class="small muted">${scopeLabel(r, profiles)}</td>
                  <td class="num">${r.weight || 1}</td>
                  <td class="num" title="${r.lastUsed ? "last used " + relTime(r.lastUsed) : "never used"}">${r.useCount || 0}</td>
                  <td class="actions">
                    <button class="btn btn-sm btn-ghost" data-edit="${r.id}">Edit</button>
                    <button class="btn btn-sm btn-ghost" data-del="${r.id}">✕</button>
                  </td>
                </tr>`)}
            </tbody>
          </table>
        </div>`
        : emptyState(
            all.length ? "Nothing matches those filters" : "The library is empty",
            all.length ? "Clear the search or pick another tag." : "Add the words and phrases this desk should post about.",
            `<button class="btn btn-primary" data-bulk>Bulk add entries</button>`)}
    </section>

    <section class="card">
      <div class="card-head"><h2>Using the library in a template</h2></div>
      <div class="card-body">
        <div class="grid c3">
          ${KINDS.map((k) => html`
            <div>
              <code class="mono-sm">${k.token}</code>
              <div class="small muted">${k.note}</div>
              <div class="small muted">Narrow it with a tag: <code class="mono-sm">${k.token.replace("]", ":tag]")}</code></div>
            </div>`)}
        </div>
      </div>
    </section>
  `);

  on(ctx.scope, "click", "[data-kind]", (e, t) => { filter.kind = t.dataset.kind; ctx.refresh(); });
  on(ctx.scope, "click", "[data-tag]", (e, t) => { filter.tag = t.dataset.tag; ctx.refresh(); });
  on(ctx.scope, "click", "[data-new]", () => editor(null, ctx));
  on(ctx.scope, "click", "[data-edit]", (e, t) => editor(store.get("library", t.dataset.edit), ctx));
  on(ctx.scope, "click", "[data-bulk]", () => bulkAdd(ctx));
  on(ctx.scope, "click", "[data-io]", () => importExport(ctx));
  on(ctx.scope, "click", "[data-del]", async (e, t) => {
    const r = store.get("library", t.dataset.del);
    if (!await confirmDialog("Delete entry?", `"${r.text}" will be removed from the library.`)) return;
    await store.remove("library", r.id);
    ctx.refresh();
  });

  const q = root.querySelector("#q");
  if (q) {
    let timer;
    q.addEventListener("input", () => {
      clearTimeout(timer);
      timer = setTimeout(() => { filter.q = q.value; ctx.refresh(); requestAnimationFrame(() => {
        const box = document.querySelector("#q");
        if (box) { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }
      }); }, 220);
    });
  }
  const tagSel = root.querySelector("#tagFilter");
  if (tagSel) tagSel.addEventListener("change", () => { filter.tag = tagSel.value; ctx.refresh(); });

  const selAll = root.querySelector("#selAll");
  const syncSel = () => {
    const n = $$(".sel:checked", root).length;
    const btn = root.querySelector("[data-delsel]");
    if (btn) { btn.disabled = !n; btn.textContent = n ? `Delete ${n} selected` : "Delete selected"; }
  };
  if (selAll) selAll.addEventListener("change", () => {
    $$(".sel", root).forEach((c) => { c.checked = selAll.checked; });
    syncSel();
  });
  on(ctx.scope, "change", ".sel", syncSel);
  on(ctx.scope, "click", "[data-delsel]", async () => {
    const ids = $$(".sel:checked", root).map((c) => c.value);
    if (!ids.length) return;
    if (!await confirmDialog(`Delete ${ids.length} entries?`, "This cannot be undone.")) return;
    for (const id of ids) await store.remove("library", id);
    toast(`Deleted ${ids.length} entries`);
    ctx.refresh();
  });
}

function scopeLabel(r, profiles) {
  const parts = [];
  if ((r.profileIds || []).length) {
    parts.push(r.profileIds.map((id) => (profiles.find((p) => p.id === id) || {}).name || "?").join(", "));
  }
  if ((r.platformIds || []).length) {
    parts.push(r.platformIds.map((id) => platform(id).abbr).join("/"));
  }
  return parts.length ? parts.join(" · ") : "any";
}

/* ----------------------------------------------------------------- editor */

async function editor(existing, ctx) {
  const r = existing || { kind: filter.kind === "all" ? "keyword" : filter.kind, weight: 1, tags: [], profileIds: [], platformIds: [] };
  const profiles = store.all("profiles");
  const allTags = Array.from(new Set(store.all("library").flatMap((x) => x.tags || []))).sort();

  const v = await modal({
    title: existing ? "Edit entry" : "New entry",
    body: html`
      <div class="field">
        <label class="label" for="l-text">Text</label>
        <textarea id="l-text" name="text" rows="2" required>${r.text || ""}</textarea>
      </div>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="l-kind">Kind</label>
          <select id="l-kind" name="kind">
            ${KINDS.map((k) => html`<option value="${k.id}" ${raw(k.id === r.kind ? "selected" : "")}>${k.label}</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="l-weight">Weight <span class="muted">(1–5, higher shows up more)</span></label>
          <input id="l-weight" name="weight" type="number" min="1" max="5" value="${r.weight || 1}" />
        </div>
      </div>
      <div class="field">
        <label class="label" for="l-tags">Tags <span class="muted">(comma separated)</span></label>
        <input id="l-tags" name="tags" list="alltags" value="${(r.tags || []).join(", ")}" placeholder="fintech, storefront" />
        <datalist id="alltags">${allTags.map((t) => html`<option value="${t}"></option>`)}</datalist>
      </div>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label">Only these profiles <span class="muted">(none = any)</span></label>
          <div class="picker">
            ${profiles.map((p) => html`
              <label class="${(r.profileIds || []).includes(p.id) ? "on" : ""}">
                <input type="checkbox" name="profileIds" data-multi="1" value="${p.id}" ${raw((r.profileIds || []).includes(p.id) ? "checked" : "")} />
                <span>${p.name}</span></label>`)}
          </div>
        </div>
        <div class="field">
          <label class="label">Only these networks <span class="muted">(none = any)</span></label>
          <div class="picker">
            ${PLATFORMS.map((p) => html`
              <label class="${(r.platformIds || []).includes(p.id) ? "on" : ""}">
                <input type="checkbox" name="platformIds" data-multi="1" value="${p.id}" ${raw((r.platformIds || []).includes(p.id) ? "checked" : "")} />
                <span>${p.name}</span></label>`)}
          </div>
        </div>
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: existing ? "Save" : "Add", value: "save", primary: true }],
    validate: (val, dlg) => (val === "save" && !dlg.querySelector("#l-text").value.trim() ? "Enter some text." : null),
  });
  if (v !== "save") return;

  const f = formData(document.getElementById("modal"));
  await store.put("library", {
    ...(existing || {}),
    kind: f.kind,
    text: f.text.trim(),
    weight: Math.max(1, Math.min(5, Number(f.weight) || 1)),
    tags: splitTags(f.tags),
    profileIds: f.profileIds || [],
    platformIds: f.platformIds || [],
    useCount: (existing && existing.useCount) || 0,
    lastUsed: (existing && existing.lastUsed) || null,
  });
  toast(existing ? "Entry saved" : "Entry added", "ok");
  ctx.refresh();
}

export function splitTags(s) {
  return String(s || "").split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

/* --------------------------------------------------------------- bulk add */

async function bulkAdd(ctx) {
  const profiles = store.all("profiles");
  const v = await modal({
    title: "Bulk add entries",
    body: html`
      <p class="small muted">One per line. Blank lines and duplicates of what is already
      in the library are skipped.</p>
      <div class="grid c2" style="gap:.6rem">
        <div class="field">
          <label class="label" for="b-kind">Kind</label>
          <select id="b-kind" name="kind">
            ${KINDS.map((k) => html`<option value="${k.id}">${k.label}</option>`)}
          </select>
        </div>
        <div class="field">
          <label class="label" for="b-tags">Tags for all of them</label>
          <input id="b-tags" name="tags" placeholder="fintech, launch" />
        </div>
      </div>
      <div class="field">
        <label class="label">Restrict to profiles <span class="muted">(none = any)</span></label>
        <div class="picker">
          ${profiles.map((p) => html`
            <label><input type="checkbox" name="profileIds" data-multi="1" value="${p.id}" /><span>${p.name}</span></label>`)}
        </div>
      </div>
      <div class="field">
        <label class="label" for="b-lines">Entries</label>
        <textarea id="b-lines" name="lines" rows="10" placeholder="cross-border payments&#10;instant top-ups&#10;gift cards"></textarea>
      </div>`,
    actions: [{ label: "Cancel", value: "__cancel" }, { label: "Add all", value: "go", primary: true }],
  });
  if (v !== "go") return;

  const f = formData(document.getElementById("modal"));
  const existing = new Set(store.all("library").map((r) => (r.kind + "|" + r.text).toLowerCase()));
  const tags = splitTags(f.tags);
  const rows = String(f.lines || "").split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .filter((text) => {
      const key = (f.kind + "|" + text).toLowerCase();
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    })
    .map((text) => ({
      kind: f.kind, text, tags, weight: 1, useCount: 0, lastUsed: null,
      profileIds: f.profileIds || [], platformIds: [],
    }));

  if (!rows.length) { toast("Nothing new to add", "bad"); return; }
  await store.putMany("library", rows);
  toast(`Added ${rows.length} entries`, "ok");
  ctx.refresh();
}

/* ---------------------------------------------------------- import/export */

async function importExport(ctx) {
  const v = await modal({
    title: "Import / export the library",
    body: html`
      <p class="small muted">CSV columns: <code>kind,text,tags,weight</code>. Tags are
      separated by <code>;</code> inside the cell.</p>
      <div class="row">
        <button class="btn" value="csv" type="button" data-act="csv">Export CSV</button>
        <button class="btn" value="json" type="button" data-act="json">Export JSON</button>
        <button class="btn" value="import" type="button" data-act="import">Import file…</button>
      </div>`,
    actions: [{ label: "Close", value: "__cancel" }],
    onOpen: (dlg, close) => {
      dlg.querySelectorAll("[data-act]").forEach((b) => b.addEventListener("click", async () => {
        const rows = store.all("library");
        if (b.dataset.act === "csv") {
          const csv = ["kind,text,tags,weight"].concat(rows.map((r) =>
            [r.kind, r.text, (r.tags || []).join(";"), r.weight || 1].map(csvCell).join(",")
          )).join("\n");
          download("library.csv", csv, "text/csv");
          close();
        } else if (b.dataset.act === "json") {
          download("library.json", JSON.stringify(rows, null, 2));
          close();
        } else {
          const file = await pickFile(".csv,.json,.txt");
          if (!file) return;
          const added = await importRows(file);
          toast(added ? `Imported ${added} entries` : "Nothing imported", added ? "ok" : "bad");
          close();
          ctx.refresh();
        }
      }));
    },
  });
  return v;
}

function csvCell(v) {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

async function importRows(file) {
  let rows = [];
  if (file.name.endsWith(".json")) {
    const data = JSON.parse(file.text);
    rows = (Array.isArray(data) ? data : data.library || []).map((r) => ({
      kind: r.kind || "keyword", text: String(r.text || "").trim(),
      tags: r.tags || [], weight: r.weight || 1,
      profileIds: r.profileIds || [], platformIds: r.platformIds || [],
      useCount: 0, lastUsed: null,
    }));
  } else {
    const lines = file.text.split(/\r?\n/).filter((l) => l.trim());
    const header = lines[0].toLowerCase();
    const hasHeader = header.includes("kind") && header.includes("text");
    for (const line of lines.slice(hasHeader ? 1 : 0)) {
      const cells = parseCsvLine(line);
      if (!cells.length) continue;
      rows.push(hasHeader || cells.length > 1
        ? { kind: cells[0] || "keyword", text: (cells[1] || "").trim(), tags: (cells[2] || "").split(";").map((t) => t.trim()).filter(Boolean), weight: Number(cells[3]) || 1, useCount: 0, lastUsed: null, profileIds: [], platformIds: [] }
        : { kind: "keyword", text: cells[0].trim(), tags: [], weight: 1, useCount: 0, lastUsed: null, profileIds: [], platformIds: [] });
    }
  }
  rows = rows.filter((r) => r.text);
  if (!rows.length) return 0;
  await store.putMany("library", rows);
  return rows.length;
}

function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
