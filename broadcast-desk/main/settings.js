/**
 * Machine-level settings: where the relay is, and the spend ceiling.
 *
 * Kept out of the renderer's database because they govern money and network
 * access, and because the relay key is a credential in its own right.
 */

const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const FILE = () => path.join(app.getPath("userData"), "settings.dat");

const DEFAULTS = {
  relayUrl: "",
  relayKey: "",
  userAgent: "broadcast-desk/1.0",
  // X charges per post. This is the hard stop, enforced before every send.
  spend: { monthlyCapUsd: 25, blockLinksOnX: true, spent: {}, },
  fanoutGapMs: 900,
  launchAtLogin: false,
  // One developer app per network: { x: { clientId, clientSecret }, ... }.
  // These are secrets, so they live here and are never sent to the renderer.
  networks: {},
};

let cache = null;

function get() {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(FILE());
    let text;
    try { text = safeStorage.decryptString(raw); } catch (e) { text = raw.toString("utf8"); }
    cache = { ...DEFAULTS, ...JSON.parse(text) };
  } catch (e) {
    cache = { ...DEFAULTS };
  }
  return cache;
}

function set(patch) {
  const next = { ...get(), ...patch };
  cache = next;
  const text = JSON.stringify(next);
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  let payload;
  try {
    payload = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(text) : Buffer.from(text, "utf8");
  } catch (e) {
    payload = Buffer.from(text, "utf8");
  }
  fs.writeFileSync(FILE(), payload, { mode: 0o600 });
  return next;
}

/** Settings the renderer may see. The relay key never crosses that line. */
function forRenderer() {
  const s = get();
  return {
    relayUrl: s.relayUrl,
    relayKeySet: Boolean(s.relayKey),
    spend: s.spend,
    fanoutGapMs: s.fanoutGapMs,
    launchAtLogin: s.launchAtLogin,
    userAgent: s.userAgent,
    // Whether each network's app is set up — never the values themselves.
    networks: Object.fromEntries(Object.entries(s.networks || {}).map(([id, v]) => [id, {
      clientIdSet: Boolean(v && v.clientId),
      clientSecretSet: Boolean(v && v.clientSecret),
      clientId: v && v.clientId ? mask(v.clientId) : "",
    }])),
  };
}

/** Show enough of an id to recognise it, never enough to use it. */
function mask(v) {
  const s = String(v);
  return s.length <= 8 ? s : `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/** Merge one network's app credentials, keeping any field left blank. */
function setNetwork(id, patch) {
  const s = get();
  const current = (s.networks || {})[id] || {};
  const next = { ...current };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v === "" || v === undefined || v === null) continue;   // blank means "leave it"
    next[k] = v;
  }
  return set({ networks: { ...(s.networks || {}), [id]: next } });
}

function networkCreds(id) {
  return (get().networks || {})[id] || {};
}

/* -------------------------------------------------------------- spending */

function monthKey(d = new Date()) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

function spentThisMonth() {
  return Number((get().spend.spent || {})[monthKey()] || 0);
}

/** Would this charge breach the cap? Checked before the request goes out. */
function wouldExceed(amount) {
  const cap = Number(get().spend.monthlyCapUsd || 0);
  if (!cap) return false;
  return spentThisMonth() + Number(amount || 0) > cap;
}

function recordSpend(amount) {
  if (!amount) return;
  const s = get();
  const spent = { ...(s.spend.spent || {}) };
  const k = monthKey();
  spent[k] = Number((spent[k] || 0)) + Number(amount);
  set({ spend: { ...s.spend, spent } });
}

module.exports = { get, set, forRenderer, setNetwork, networkCreds, spentThisMonth, wouldExceed, recordSpend, monthKey, DEFAULTS };
