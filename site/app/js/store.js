/**
 * Store — IndexedDB-backed collections with an in-memory mirror.
 *
 * Everything the desk knows lives here. The whole dataset is read into memory
 * at boot (it is small — thousands of rows at most) so views can render
 * synchronously; writes go to memory, then to IndexedDB, then out to
 * subscribers. That keeps the console usable with no backend at all, and the
 * backend, when configured, syncs against exactly these records.
 *
 * Nothing in here holds a network credential. Tokens live server-side in the
 * Worker; an account row only carries the opaque id the Worker gave us.
 */

const DB_NAME = "broadcast-desk";
const DB_VERSION = 1;

export const COLLECTIONS = [
  "profiles",   // personal / business / client identities
  "accounts",   // a social account bound to a profile
  "library",    // keywords, phrases, hashtags, links — the message vocabulary
  "templates",  // spintax message templates
  "posts",      // composed / queued / sent posts
  "rules",      // ad-hoc automation rules
  "inbox",      // mentions, replies and matches awaiting action
  "events",     // activity log
  "settings",   // single row, id "app"
];

let db = null;
const state = Object.fromEntries(COLLECTIONS.map((c) => [c, []]));
const subs = new Set();

/* ------------------------------------------------------------------ ids */

export function uid(prefix) {
  const rand = (crypto.getRandomValues(new Uint32Array(2))[0].toString(36) +
                crypto.getRandomValues(new Uint32Array(1))[0].toString(36)).slice(0, 9);
  return (prefix ? prefix + "_" : "") + Date.now().toString(36) + rand;
}

/* ------------------------------------------------------------- indexeddb */

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      for (const c of COLLECTIONS) {
        if (!d.objectStoreNames.contains(c)) d.createObjectStore(c, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(collection, mode) {
  return db.transaction(collection, mode).objectStore(collection);
}

function readAll(collection) {
  return new Promise((resolve, reject) => {
    const req = tx(collection, "readonly").getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

function writeRow(collection, row) {
  return new Promise((resolve, reject) => {
    const req = tx(collection, "readwrite").put(row);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function deleteRow(collection, id) {
  return new Promise((resolve, reject) => {
    const req = tx(collection, "readwrite").delete(id);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

function clearStore(collection) {
  return new Promise((resolve, reject) => {
    const req = tx(collection, "readwrite").clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ------------------------------------------------------------------ boot */

export async function init() {
  db = await open();
  await Promise.all(COLLECTIONS.map(async (c) => { state[c] = await readAll(c); }));
  if (!state.settings.length) {
    state.settings = [defaultSettings()];
    await writeRow("settings", state.settings[0]);
  }
  return state;
}

function defaultSettings() {
  return {
    id: "app",
    apiBase: "",
    apiKey: "",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
    theme: "system",
    safety: {
      requireApprovalForRules: true,   // rules stage actions for review by default
      maxActionsPerHour: 20,
      maxActionsPerDay: 150,
      minGapSeconds: 90,
      quietHours: { from: "23:00", to: "06:00", enabled: false },
    },
    onboarded: false,
  };
}

/* --------------------------------------------------------------- reading */

export function all(collection) {
  return state[collection] || [];
}

export function get(collection, id) {
  return (state[collection] || []).find((r) => r.id === id) || null;
}

export function where(collection, fn) {
  return (state[collection] || []).filter(fn);
}

export function settings() {
  return state.settings[0] || defaultSettings();
}

/* --------------------------------------------------------------- writing */

/** Insert or update. Returns the stored row (with id//timestamps filled in). */
export async function put(collection, row) {
  const now = new Date().toISOString();
  const record = { ...row };
  if (!record.id) record.id = uid(collection.slice(0, 3));
  if (!record.createdAt) record.createdAt = now;
  record.updatedAt = now;

  const list = state[collection];
  const i = list.findIndex((r) => r.id === record.id);
  if (i >= 0) list[i] = record; else list.push(record);

  await writeRow(collection, record);
  emit({ collection, type: i >= 0 ? "update" : "insert", row: record });
  return record;
}

/** Write many rows in one transaction — used by import and bulk generation. */
export async function putMany(collection, rows) {
  const now = new Date().toISOString();
  const out = [];
  const store = tx(collection, "readwrite");
  for (const row of rows) {
    const record = { ...row };
    if (!record.id) record.id = uid(collection.slice(0, 3));
    if (!record.createdAt) record.createdAt = now;
    record.updatedAt = now;
    store.put(record);
    const list = state[collection];
    const i = list.findIndex((r) => r.id === record.id);
    if (i >= 0) list[i] = record; else list.push(record);
    out.push(record);
  }
  await new Promise((res, rej) => {
    store.transaction.oncomplete = res;
    store.transaction.onerror = () => rej(store.transaction.error);
  });
  emit({ collection, type: "bulk", rows: out });
  return out;
}

export async function remove(collection, id) {
  state[collection] = state[collection].filter((r) => r.id !== id);
  await deleteRow(collection, id);
  emit({ collection, type: "delete", id });
}

/** Remove a row and everything that hangs off it. */
export async function removeCascade(collection, id) {
  if (collection === "profiles") {
    for (const a of where("accounts", (a) => a.profileId === id)) await remove("accounts", a.id);
    for (const r of where("rules", (r) => (r.profileIds || []).includes(id))) {
      await put("rules", { ...r, profileIds: r.profileIds.filter((p) => p !== id), enabled: false });
    }
  }
  if (collection === "accounts") {
    for (const p of where("posts", (p) => p.status === "queued" && (p.accountIds || []).includes(id))) {
      await put("posts", { ...p, accountIds: p.accountIds.filter((x) => x !== id) });
    }
  }
  await remove(collection, id);
}

export async function saveSettings(patch) {
  const next = { ...settings(), ...patch, id: "app" };
  state.settings = [next];
  await writeRow("settings", next);
  emit({ collection: "settings", type: "update", row: next });
  return next;
}

/* ------------------------------------------------------------------- log */

export async function log(kind, message, meta) {
  const row = {
    id: uid("evt"),
    kind,                       // publish | schedule | rule | auth | system
    message,
    meta: meta || {},
    at: new Date().toISOString(),
  };
  state.events.unshift(row);
  await writeRow("events", row);
  // Keep the log from growing without bound.
  if (state.events.length > 800) {
    const drop = state.events.slice(800);
    state.events = state.events.slice(0, 800);
    for (const d of drop) deleteRow("events", d.id);
  }
  emit({ collection: "events", type: "insert", row });
  return row;
}

/* ------------------------------------------------------------ pub / sub */

export function subscribe(fn) {
  subs.add(fn);
  return () => subs.delete(fn);
}

function emit(change) {
  for (const fn of subs) {
    try { fn(change); } catch (e) { console.error("store subscriber failed", e); }
  }
}

/* --------------------------------------------------- backup / restore */

export function exportAll() {
  return {
    format: "broadcast-desk/1",
    exportedAt: new Date().toISOString(),
    data: Object.fromEntries(COLLECTIONS.map((c) => [c, state[c]])),
  };
}

/**
 * Import a backup. `mode` is "merge" (default — incoming rows win on id
 * collision) or "replace" (wipe first). Settings are never replaced wholesale
 * so an import cannot silently repoint the console at another backend.
 */
export async function importAll(payload, mode = "merge") {
  if (!payload || !payload.data) throw new Error("Not a Broadcast Desk export.");
  for (const c of COLLECTIONS) {
    if (c === "settings") continue;
    const rows = payload.data[c];
    if (!Array.isArray(rows)) continue;
    if (mode === "replace") {
      await clearStore(c);
      state[c] = [];
    }
    await putMany(c, rows);
  }
  emit({ collection: "*", type: "import" });
}

export async function wipe() {
  for (const c of COLLECTIONS) {
    await clearStore(c);
    state[c] = [];
  }
  state.settings = [defaultSettings()];
  await writeRow("settings", state.settings[0]);
  emit({ collection: "*", type: "wipe" });
}

export { state };
