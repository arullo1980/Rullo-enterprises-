/**
 * Dashboard — what is set up, what is about to happen, what just happened.
 */

import * as store from "../store.js";
import { platform } from "../platforms.js";
import { nextUp, due } from "../scheduler.js";
import * as api from "../api.js";
import {
  html, raw, mount, on, plural, relTime, fmtDateTime, platformMark, emptyState,
} from "../ui.js";

export const title = "Dashboard";
export const subtitle = (c) => c.profile ? `Scoped to ${c.profile.name}` : "All profiles";
export const actions = () => `<a class="btn btn-primary" href="#/compose">Compose</a>`;

export function render(root, ctx) {
  const accounts = ctx.accounts();
  const allAccounts = store.all("accounts");
  const posts = store.all("posts");
  const rules = store.all("rules");
  const library = store.all("library");
  const events = store.all("events").slice(0, 12);

  const connected = accounts.filter((a) => a.status === "connected").length;
  const queued = posts.filter((p) => p.status === "queued");
  const week = Date.now() - 7 * 864e5;
  const sent7 = posts.filter((p) => p.sentAt && new Date(p.sentAt).getTime() > week);
  const sentCount = sent7.reduce((n, p) => n + (p.results || []).filter((r) => r.ok).length, 0);
  const staged = store.where("inbox", (i) => i.status === "staged");
  const next = nextUp(posts);
  const overdue = due(posts);

  const byPlatform = {};
  for (const a of accounts) byPlatform[a.platform] = (byPlatform[a.platform] || 0) + 1;

  mount(root, html`
    ${setupNotices({ accounts, allAccounts, connected, rules })}

    <section class="grid c4">
      <div class="stat"><div class="k">Accounts</div><div class="v">${connected}<span class="muted" style="font-size:16px">/${accounts.length}</span></div><div class="n">connected</div></div>
      <div class="stat"><div class="k">Queued</div><div class="v">${queued.length}</div>
        <div class="n">${next ? "next " + relTime(next.scheduledAt) : "nothing scheduled"}</div></div>
      <div class="stat"><div class="k">Sent, 7 days</div><div class="v">${sentCount}</div>
        <div class="n">across ${plural(sent7.length, "post")}</div></div>
      <div class="stat"><div class="k">Rules</div><div class="v">${rules.filter((r) => r.enabled).length}</div>
        <div class="n">${staged.length ? staged.length + " awaiting approval" : "of " + rules.length + " total"}</div></div>
    </section>

    ${overdue.length ? html`
      <section class="notice bad">
        <b>${plural(overdue.length, "post")} overdue.</b> Open the queue to send them.
        <a href="#/queue">Go to queue</a>
      </section>` : raw("")}

    <section class="split">
      <div class="card">
        <div class="card-head">
          <h2>Next out</h2>
          <span class="spacer"></span>
          <a class="btn btn-sm" href="#/queue">Full queue</a>
        </div>
        ${queued.length ? html`
          <div class="card-body tight">
            <table>
              <thead><tr><th>When</th><th>Message</th><th>To</th></tr></thead>
              <tbody>
                ${queued.slice().sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt)).slice(0, 8).map((p) => {
                  const accts = (p.accountIds || []).map((id) => store.get("accounts", id)).filter(Boolean);
                  return html`
                    <tr>
                      <td class="nowrap small">${fmtDateTime(p.scheduledAt)}<br><span class="muted">${relTime(p.scheduledAt)}</span></td>
                      <td class="small trunc" style="max-width:30ch">${p.renderedText || p.body}</td>
                      <td><div class="row tight">${accts.slice(0, 4).map((a) => platformMark(platform(a.platform), "sm"))}
                        ${accts.length > 4 ? html`<span class="small muted">+${accts.length - 4}</span>` : raw("")}</div></td>
                    </tr>`;
                })}
              </tbody>
            </table>
          </div>`
          : emptyState("Nothing queued", "Compose a post or build a drip campaign.",
              `<a class="btn btn-primary" href="#/compose">Compose</a>`)}
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h2>Reach</h2></div>
          <div class="card-body tight">
            ${Object.keys(byPlatform).length ? html`
              <table>
                <tbody>
                  ${Object.entries(byPlatform).sort((a, b) => b[1] - a[1]).map(([id, n]) => {
                    const p = platform(id);
                    const live = accounts.filter((a) => a.platform === id && a.status === "connected").length;
                    return html`<tr>
                      <td style="width:34px">${platformMark(p, "sm")}</td>
                      <td>${p.name}</td>
                      <td class="num">${live}/${n}</td>
                    </tr>`;
                  })}
                </tbody>
              </table>` : html`<div class="empty small">No accounts on this profile.</div>`}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h2>Library</h2><span class="spacer"></span><a class="btn btn-sm" href="#/library">Open</a></div>
          <div class="card-body">
            <div class="row" style="gap:.4rem">
              ${["keyword", "phrase", "hashtag", "link", "cta", "emoji"].map((k) => {
                const n = library.filter((r) => r.kind === k).length;
                return html`<span class="chip ${n ? "on" : ""}">${k} ${n}</span>`;
              })}
            </div>
            <div class="hint">${plural(library.length, "entry", "entries")} feeding the generator.</div>
          </div>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-head"><h2>Activity</h2></div>
      ${events.length ? html`
        <div class="card-body tight">
          ${events.map((e) => html`
            <div class="list-row">
              <span class="badge">${e.kind}</span>
              <span style="flex:1">${e.message}</span>
              <span class="small muted nowrap">${relTime(e.at)}</span>
            </div>`)}
        </div>` : html`<div class="empty small">Nothing has happened yet.</div>`}
    </section>
  `);

  on(ctx.scope, "click", "[data-dismiss]", (e, t) => t.closest("section").remove());
}

function setupNotices({ accounts, allAccounts, connected, rules }) {
  const notes = [];
  if (!api.isLive()) {
    notes.push(html`<div class="notice">
      <b>Dry run.</b> No posting backend is configured, so composing, scheduling and
      rules all work but nothing is published. <a href="#/settings">Configure the backend</a>.
    </div>`);
  }
  if (allAccounts.length && !connected) {
    notes.push(html`<div class="notice">
      <b>No account is connected yet.</b> <a href="#/accounts">Connect one</a> to post for real.
    </div>`);
  }
  const risky = rules.filter((r) => r.enabled && !(r.safety || {}).requireApproval);
  if (risky.length) {
    notes.push(html`<div class="notice">
      <b>${plural(risky.length, "rule")} acting without approval.</b>
      ${risky.map((r) => r.name).join(", ")} — worth checking the caps are where you want them.
      <a href="#/rules">Review</a>
    </div>`);
  }
  return notes.length ? html`<section class="stack" style="margin-bottom:1.25rem">${notes}</section>` : raw("");
}
