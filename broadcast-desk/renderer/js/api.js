/**
 * The renderer's view of the outside world.
 *
 * There is no HTTP here any more. Everything goes through the preload bridge
 * to the main process, which holds the tokens and makes the calls. That is the
 * point of shipping this as a desktop app rather than a web page: the console
 * can be trusted with a plan, and never has to be trusted with a credential.
 *
 * `dryRun` is a deliberate setting, not a fallback. When it is on, sends are
 * simulated and every result says so; nothing ever silently pretends to post.
 */

import { settings, saveSettings, log } from "./store.js";

const desk = typeof window !== "undefined" ? window.desk : null;

export function isDesktop() {
  return Boolean(desk && desk.isDesktop);
}

export function isDryRun() {
  return settings().dryRun !== false;
}

/** Publishing works as soon as one account is connected — no backend needed. */
export function canPublish() {
  return isDesktop() && !isDryRun();
}

/** The relay is only needed for unattended sending and hosted media. */
export function relayConfigured() {
  return Boolean(settings().relayUrl);
}

export async function info() {
  if (!isDesktop()) return { version: "web", secureStorage: false };
  return desk.info();
}

export async function health() {
  if (!isDesktop()) return { ok: false, mode: "web" };
  if (!relayConfigured()) return { ok: true, mode: "local" };
  return desk.relay.health();
}

/* ----------------------------------------------------------- connections */

export async function listConnections() {
  return isDesktop() ? desk.connections.list() : [];
}

export async function connect(opts) {
  return desk.connections.connect(opts);
}

export async function finishHosted(connectionId, keepInCloud) {
  return desk.connections.finishHosted({ connectionId, keepInCloud });
}

export async function setUnattended(connectionId, enabled) {
  return desk.connections.setUnattended({ connectionId, enabled });
}

export async function disconnect(connectionId) {
  return desk.connections.remove(connectionId);
}

/* --------------------------------------------------------------- publish */

/**
 * Send a fan-out. Returns one result per item, in order.
 * A simulated send is flagged `simulated` on every result it produces.
 */
export async function publish(items, { dryRun } = {}) {
  const simulate = dryRun === undefined ? isDryRun() : dryRun;
  if (simulate || !isDesktop()) return simulated(items, simulate ? "dry run" : "not running in the desktop app");
  try {
    return await desk.publish(items);
  } catch (e) {
    await log("publish", "Send failed: " + e.message, { count: items.length });
    return items.map((i) => ({ accountId: i.accountId, ok: false, error: e.message }));
  }
}

function simulated(items, why) {
  return items.map((i) => ({
    accountId: i.accountId,
    ok: true,
    simulated: true,
    note: why,
    url: null,
    postedAt: new Date().toISOString(),
  }));
}

/** What a fan-out would cost, before it is sent. */
export async function estimate(items) {
  if (!isDesktop()) return { total: 0, lines: [], spentThisMonth: 0, cap: 0 };
  return desk.estimate(items);
}

export async function act(action) {
  if (isDryRun() || !isDesktop()) return { ok: true, simulated: true };
  return desk.act(action);
}

/* ----------------------------------------------------------------- media */

export async function pickMedia() {
  return isDesktop() ? desk.media.pick() : [];
}

export async function thumbnail(ref) {
  return isDesktop() ? desk.media.thumbnail(ref) : null;
}

/* ------------------------------------------------------- relay and queue */

export async function fetchFeed({ connectionIds, since } = {}) {
  if (!relayConfigured() || !isDesktop()) return { items: [], mode: "local" };
  return desk.relay.feed(connectionIds, since);
}

/** Hand the unattended part of the queue to the relay's cron. */
export async function syncQueue(entries, remove = []) {
  if (!relayConfigured() || !isDesktop()) return { synced: 0, mode: "local" };
  return desk.relay.syncQueue(entries, remove);
}

export async function fetchQueueResults(since) {
  if (!relayConfigured() || !isDesktop()) return { results: [] };
  return desk.relay.queueResults(since);
}

/** Give the in-app scheduler the posts it owns. */
export async function setLocalQueue(posts) {
  if (!isDesktop()) return { queued: 0 };
  return desk.scheduler.setQueue(posts);
}

export async function schedulerState() {
  if (!isDesktop()) return { queued: 0, label: "" };
  return desk.scheduler.state();
}

/* -------------------------------------------------------------- settings */

/** Machine settings live in the main process; workspace settings in the store. */
export async function machineSettings() {
  return isDesktop() ? desk.settings.get() : {};
}

export async function saveMachineSettings(patch) {
  return isDesktop() ? desk.settings.set(patch) : {};
}

/** Store one network's developer-app credentials. Blank fields are left alone. */
export async function saveNetworkApp(id, credentials) {
  return isDesktop() ? desk.settings.setNetwork(id, credentials) : {};
}

/** Turn off dry run the first time a real account connects. */
export async function leaveDryRun() {
  if (isDryRun()) {
    await saveSettings({ dryRun: false });
    await log("system", "Dry run off — sends are now real.");
    return true;
  }
  return false;
}

export function openExternal(url) {
  if (isDesktop()) desk.openExternal(url);
  else window.open(url, "_blank", "noopener");
}

export async function saveFile(name, contents) {
  if (isDesktop()) return desk.saveFile(name, contents);
  return null;
}

export async function openFile() {
  if (isDesktop()) return desk.openFile();
  return null;
}
