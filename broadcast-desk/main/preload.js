/**
 * The bridge.
 *
 * The renderer gets exactly these calls and nothing else — no Node, no file
 * system, no tokens. Every reply is { ok, value } or { ok:false, error }, and
 * `call` turns the failure half back into a thrown Error so the console's own
 * code can stay in ordinary try/catch shape.
 */

const { contextBridge, ipcRenderer } = require("electron");

async function call(channel, payload) {
  const reply = await ipcRenderer.invoke(channel, payload);
  if (!reply || reply.ok) return reply ? reply.value : undefined;
  const err = new Error(reply.error || "The desk could not complete that.");
  err.code = reply.code;
  throw err;
}

const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};

contextBridge.exposeInMainWorld("desk", {
  isDesktop: true,

  info: () => call("app:info"),
  catalogue: () => call("catalogue"),

  settings: {
    get: () => call("settings:get"),
    set: (patch) => call("settings:set", patch),
    setNetwork: (id, credentials) => call("settings:setNetwork", { id, credentials }),
  },

  connections: {
    list: () => call("connections:list"),
    connect: (opts) => call("connections:connect", opts),
    finishHosted: (opts) => call("connections:finishHosted", opts),
    setUnattended: (opts) => call("connections:setUnattended", opts),
    remove: (id) => call("connections:remove", id),
  },

  media: {
    pick: () => call("media:pick"),
    thumbnail: (ref) => call("media:thumbnail", ref),
    describe: (path) => call("media:describe", path),
  },

  publish: (items) => call("publish", items),
  act: (action) => call("act", action),
  estimate: (items) => call("estimate", items),

  relay: {
    health: () => call("relay:health"),
    syncQueue: (entries, remove) => call("relay:syncQueue", { entries, remove }),
    queueResults: (since) => call("relay:queueResults", since),
    feed: (connectionIds, since) => call("relay:feed", { connectionIds, since }),
  },

  scheduler: {
    state: () => call("scheduler:state"),
    setQueue: (posts) => call("scheduler:setQueue", posts),
    runNow: () => call("scheduler:runNow"),
  },

  openExternal: (url) => call("open-external", url),
  saveFile: (name, contents) => call("save-file", { name, contents }),
  openFile: () => call("open-file"),

  onNavigate: on("desk:navigate"),
  onMenu: on("desk:menu"),
  onPublishProgress: on("desk:publish-progress"),
  onScheduler: on("desk:scheduler"),
});
