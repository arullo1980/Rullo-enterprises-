/**
 * The vault — connections and their tokens, on this machine only.
 *
 * A desktop app is allowed to hold credentials in a way a browser is not, so
 * this is where they live. Electron's safeStorage encrypts with the OS keyring
 * (DPAPI on Windows, Keychain on macOS, libsecret on Linux), which means the
 * file on disk is useless to anyone who is not this user on this machine.
 *
 * If the OS refuses to provide encryption we refuse to store the token at all
 * rather than quietly writing it in the clear.
 */

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = () => path.join(app.getPath("userData"), "connections.dat");

let cache = null;

function encryptionAvailable() {
  try { return safeStorage.isEncryptionAvailable(); } catch (e) { return false; }
}

function load() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE());
    const text = encryptionAvailable()
      ? safeStorage.decryptString(raw)
      : raw.toString("utf8");
    cache = JSON.parse(text);
  } catch (e) {
    cache = {};
  }
  return cache;
}

function persist() {
  const text = JSON.stringify(cache || {});
  if (!encryptionAvailable()) {
    const e = new Error(
      "This system will not provide secure storage, so credentials cannot be saved. " +
      "On Linux install gnome-keyring or pass, then restart Broadcast Desk."
    );
    e.code = "NO_SAFE_STORAGE";
    throw e;
  }
  const dir = path.dirname(FILE());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(FILE(), safeStorage.encryptString(text), { mode: 0o600 });
}

function newId() {
  return "conn_" + crypto.randomBytes(9).toString("base64url");
}

function save(conn) {
  load();
  const record = { ...conn, id: conn.id || newId(), updatedAt: new Date().toISOString() };
  cache[record.id] = record;
  persist();
  return summarise(record);
}

function get(id) {
  return load()[id] || null;
}

function remove(id) {
  load();
  delete cache[id];
  persist();
}

/** Never hand the renderer a token — it only ever needs the label and state. */
function summarise(conn) {
  if (!conn) return null;
  return {
    id: conn.id,
    platform: conn.platform,
    label: conn.label,
    profileId: conn.profileId,
    instance: conn.instance || null,
    connectedAt: conn.connectedAt,
    expiresAt: conn.expiresAt || null,
    meta: publicMeta(conn.meta),
  };
}

/** Meta can carry a Page token; strip anything that looks like a secret. */
function publicMeta(meta) {
  const out = {};
  for (const [k, v] of Object.entries(meta || {})) {
    if (/token|secret|password|key/i.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function list() {
  return Object.values(load()).map(summarise);
}

module.exports = { save, get, remove, list, summarise, encryptionAvailable, file: FILE };
