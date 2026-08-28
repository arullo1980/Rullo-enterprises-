/**
 * UI helpers — a very small toolkit so the views can stay declarative
 * without pulling in a framework (the repo has no build step by design).
 *
 * `html` is a tagged template that escapes every interpolation. Anything that
 * is deliberately markup must be wrapped in `raw()`, which makes unescaped
 * output a visible, greppable decision rather than an accident.
 */

export function esc(v) {
  if (v === null || v === undefined) return "";
  return String(v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
export function raw(s) { return new Raw(s); }

export function html(strings, ...vals) {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < vals.length) {
      const v = vals[i];
      if (v instanceof Raw) out += v.s;
      else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join("");
      else if (v === false || v === null || v === undefined) out += "";
      else out += esc(v);
    }
  });
  return raw(out);
}

export function el(markup) {
  const t = document.createElement("template");
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}

export function mount(node, markup) {
  node.innerHTML = String(markup);
  return node;
}

/** Event delegation: on(root, "click", ".btn", handler). */
export function on(root, type, selector, handler) {
  root.addEventListener(type, (e) => {
    const target = e.target.closest(selector);
    if (target && root.contains(target)) handler(e, target);
  });
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* ----------------------------------------------------------------- toasts */

export function toast(message, kind = "", ms = 3600) {
  const box = document.getElementById("toasts");
  if (!box) return;
  const node = el(html`<div class="toast ${kind}" role="status">${message}</div>`);
  box.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .2s";
    setTimeout(() => node.remove(), 220);
  }, ms);
}

/* ----------------------------------------------------------------- modals */

/**
 * Open a dialog. `body` is markup; `actions` is a list of
 * { label, value, kind, primary }. Resolves with the chosen value, or null if
 * the dialog was dismissed. `onOpen(dialogEl, close)` runs once mounted so a
 * caller can wire up live behaviour inside the form.
 */
export function modal({ title, body, actions = [], wide = false, onOpen, validate }) {
  // Replace the dialog node rather than reusing it: callers attach their own
  // listeners in onOpen, and a reused node would keep firing them against the
  // next dialog's markup.
  const stale = document.getElementById("modal");
  const dlg = document.createElement("dialog");
  dlg.id = "modal";
  stale.replaceWith(dlg);
  dlg.className = wide ? "wide" : "";
  mount(dlg, html`
    <form method="dialog">
      <div class="dlg-head">
        <h2>${title}</h2>
        <span class="spacer"></span>
        <button class="btn btn-sm btn-ghost" value="__cancel" aria-label="Close">✕</button>
      </div>
      <div class="dlg-body">${raw(String(body))}</div>
      <div class="dlg-foot">
        ${raw(actions.map((a) => `
          <button class="btn ${a.primary ? "btn-primary" : ""} ${a.kind === "danger" ? "btn-danger" : ""}"
                  value="${esc(a.value)}" ${a.type === "button" ? "type=button" : ""}>${esc(a.label)}</button>`).join(""))}
      </div>
    </form>
  `);

  return new Promise((resolve) => {
    const close = (value) => {
      if (dlg.open) dlg.close(value === undefined ? "__cancel" : value);
    };
    const form = dlg.querySelector("form");
    let settled = false;

    form.addEventListener("submit", (e) => {
      const value = e.submitter ? e.submitter.value : "__cancel";
      if (value !== "__cancel" && validate) {
        const problem = validate(value, dlg);
        if (problem) {
          e.preventDefault();
          toast(problem, "bad");
          return;
        }
      }
    });

    dlg.addEventListener("close", function handler() {
      dlg.removeEventListener("close", handler);
      if (settled) return;
      settled = true;
      const v = dlg.returnValue;
      resolve(v === "__cancel" || v === "" ? null : v);
    });

    dlg.showModal();
    const first = dlg.querySelector("input, textarea, select");
    if (first) setTimeout(() => first.focus(), 30);
    if (onOpen) onOpen(dlg, close);
  });
}

export async function confirmDialog(title, message, confirmLabel = "Delete") {
  const v = await modal({
    title,
    body: html`<p>${message}</p>`,
    actions: [
      { label: "Cancel", value: "__cancel" },
      { label: confirmLabel, value: "yes", kind: "danger" },
    ],
  });
  return v === "yes";
}

/** Read a modal's fields as a plain object keyed by `name`. */
export function formData(dlg) {
  const out = {};
  $$("[name]", dlg).forEach((f) => {
    if (f.type === "checkbox") {
      if (f.dataset.multi) {
        out[f.name] = out[f.name] || [];
        if (f.checked) out[f.name].push(f.value);
      } else {
        out[f.name] = f.checked;
      }
    } else if (f.type === "radio") {
      if (f.checked) out[f.name] = f.value;
    } else if (f.multiple && f.tagName === "SELECT") {
      out[f.name] = Array.from(f.selectedOptions).map((o) => o.value);
    } else {
      out[f.name] = f.value;
    }
  });
  return out;
}

/* ------------------------------------------------------------- formatting */

const RTF = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function relTime(iso) {
  if (!iso) return "";
  const diff = new Date(iso).getTime() - Date.now();
  const abs = Math.abs(diff);
  const units = [
    ["year", 31536e6], ["month", 2592e6], ["week", 6048e5],
    ["day", 864e5], ["hour", 36e5], ["minute", 6e4], ["second", 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === "second") return RTF.format(Math.round(diff / ms), unit);
  }
  return "";
}

export function fmtDateTime(iso, tz) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    timeZone: tz || undefined,
  });
}

export function fmtDate(iso, tz) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric", month: "short", day: "numeric", timeZone: tz || undefined,
  });
}

export function fmtTime(iso, tz) {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString(undefined, {
    hour: "numeric", minute: "2-digit", timeZone: tz || undefined,
  });
}

/** Datetime-local input value for a Date, in local time. */
export function toLocalInput(d) {
  const dt = d instanceof Date ? d : new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}T${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
}

export function plural(n, one, many) {
  return `${n.toLocaleString()} ${n === 1 ? one : many || one + "s"}`;
}

/** Stable colour for a name, so avatars stay recognisable between sessions. */
export function tint(seed) {
  let h = 0;
  for (let i = 0; i < String(seed).length; i++) h = (h * 31 + String(seed).charCodeAt(i)) % 360;
  return `hsl(${h} 42% 38%)`;
}

export function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join("").toUpperCase();
}

export function download(filename, text, type = "application/json") {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickFile(accept = "application/json") {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      const reader = new FileReader();
      reader.onload = () => resolve({ name: file.name, text: String(reader.result) });
      reader.readAsText(file);
    };
    input.click();
  });
}

/* ------------------------------------------------------------- fragments */

export function platformMark(p, size = "") {
  return html`<span class="pmark ${size}" style="background:${p.color}" title="${p.name}">${p.abbr}</span>`;
}

export function avatar(name, size = "") {
  return html`<span class="avatar ${size}" style="background:${tint(name)}">${initials(name)}</span>`;
}

export function emptyState(title, note, actionHtml) {
  return html`<div class="empty"><strong>${title}</strong>${note}${actionHtml ? raw("<div style='margin-top:.8rem'>" + actionHtml + "</div>") : ""}</div>`;
}
