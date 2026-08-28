/**
 * Broadcast Desk — Electron main process.
 *
 * Owns the window, the tray, the credential vault and every outbound network
 * call. The renderer is the console and holds no secrets: it asks this process
 * to connect an account, to send, or to pick a file, and gets back results.
 *
 * The UI is served over a custom `app://` protocol rather than file://, because
 * ES modules will not load from a file:// origin.
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, dialog, protocol, nativeImage } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

const vault = require("./vault.js");
const settings = require("./settings.js");
const relay = require("./relay.js");
const oauth = require("./oauth.js");
const net = require("./net.js");
const media = require("./media.js");
const scheduler = require("./scheduler.js");
const { shared } = require("./shared.js");

const ROOT = path.join(__dirname, "..");
const isDev = !app.isPackaged;

let win = null;
let tray = null;

protocol.registerSchemesAsPrivileged([
  { scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

/* ------------------------------------------------------------ app:// files */

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".ico": "image/x-icon",
};

function serveApp() {
  protocol.handle("app", async (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const target = path.join(ROOT, rel);

    // Never serve outside the product directory, whatever the URL claims.
    if (!target.startsWith(ROOT + path.sep) && target !== ROOT) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      const body = await fs.promises.readFile(target);
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream" },
      });
    } catch (e) {
      return new Response("Not found", { status: 404 });
    }
  });
}

/* ------------------------------------------------------------------ window */

function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: "#FAF7EF",
    title: "Broadcast Desk",
    icon: path.join(ROOT, "build", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.once("ready-to-show", () => win.show());
  win.loadURL("app://desk/renderer/index.html");

  // Anything that is not the console opens in the real browser, never in here.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("app://")) {
      e.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on("close", (e) => {
    // Closing the window leaves the desk running in the tray, so the in-app
    // scheduler keeps its promises. Quit properly from the tray or the menu.
    if (!app.__quitting && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on("closed", () => { win = null; });
}

function show() {
  if (!win) createWindow();
  else { win.show(); win.focus(); }
}

/* -------------------------------------------------------------------- tray */

function createTray() {
  const icon = nativeImage.createFromPath(path.join(ROOT, "build", "icon.png")).resize({ width: 18, height: 18 });
  tray = new Tray(icon);
  tray.setToolTip("Broadcast Desk");
  const refresh = () => {
    const due = scheduler.summary();
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: due.label, enabled: false },
      { type: "separator" },
      { label: "Open Broadcast Desk", click: show },
      { label: "Send anything due now", click: () => scheduler.runNow() },
      { type: "separator" },
      { label: "Quit", click: () => { app.__quitting = true; app.quit(); } },
    ]));
  };
  refresh();
  setInterval(refresh, 30000).unref();
  tray.on("click", show);
}

function buildMenu() {
  const template = [
    ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
    {
      label: "File",
      submenu: [
        { label: "Compose", accelerator: "CmdOrCtrl+N", click: () => go("compose") },
        { type: "separator" },
        { label: "Export workspace…", click: () => win && win.webContents.send("desk:menu", "export") },
        { label: "Import workspace…", click: () => win && win.webContents.send("desk:menu", "import") },
        { type: "separator" },
        {
          label: "Reveal data folder",
          click: () => shell.openPath(app.getPath("userData")),
        },
        { type: "separator" },
        process.platform === "darwin" ? { role: "close" } : { label: "Quit", accelerator: "CmdOrCtrl+Q", click: () => { app.__quitting = true; app.quit(); } },
      ],
    },
    { role: "editMenu" },
    {
      label: "Go",
      submenu: [
        { label: "Dashboard", accelerator: "CmdOrCtrl+1", click: () => go("dashboard") },
        { label: "Compose", accelerator: "CmdOrCtrl+2", click: () => go("compose") },
        { label: "Queue", accelerator: "CmdOrCtrl+3", click: () => go("queue") },
        { label: "Inbox", accelerator: "CmdOrCtrl+4", click: () => go("inbox") },
        { label: "Library", accelerator: "CmdOrCtrl+5", click: () => go("library") },
        { label: "Rules", accelerator: "CmdOrCtrl+6", click: () => go("rules") },
        { label: "Connections", accelerator: "CmdOrCtrl+7", click: () => go("accounts") },
        { label: "Settings", accelerator: "CmdOrCtrl+,", click: () => go("settings") },
      ],
    },
    {
      label: "View",
      submenu: [{ role: "reload" }, { role: "toggleDevTools" }, { type: "separator" },
                { role: "resetZoom" }, { role: "zoomIn" }, { role: "zoomOut" }, { type: "separator" },
                { role: "togglefullscreen" }],
    },
    {
      label: "Help",
      submenu: [
        { label: "Setup guide", click: () => shell.openExternal("https://github.com/arullo1980/Rullo-enterprises-/blob/main/broadcast-desk/docs/SETUP.md") },
        { label: "Show log folder", click: () => shell.openPath(app.getPath("logs")) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function go(view) {
  show();
  if (win) win.webContents.send("desk:navigate", view);
}

/* --------------------------------------------------------------------- ipc */

function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      return { ok: true, value: await fn(...args) };
    } catch (e) {
      // Errors cross the bridge as data; the renderer decides how to show them.
      return { ok: false, error: String((e && e.message) || e), code: e && e.code };
    }
  });
}

function registerIpc() {
  handle("app:info", async () => ({
    version: app.getVersion(),
    platform: process.platform,
    electron: process.versions.electron,
    userData: app.getPath("userData"),
    secureStorage: vault.encryptionAvailable(),
    isDev,
  }));

  handle("catalogue", async () => {
    const { platforms } = await shared();
    return { platforms: platforms.PLATFORMS.map(stripFunctions) };
  });

  handle("settings:get", async () => settings.forRenderer());
  handle("settings:set", async (patch) => {
    // Secrets are write-only from the renderer's point of view.
    settings.set(patch);
    return settings.forRenderer();
  });
  handle("settings:setNetwork", async ({ id, credentials }) => {
    settings.setNetwork(id, credentials);
    return settings.forRenderer();
  });

  handle("connections:list", async () => vault.list());
  handle("connections:remove", async (id) => {
    await relay.dropConnection(id).catch(() => {});
    vault.remove(id);
    return true;
  });
  handle("connections:connect", async ({ platform, ...opts }) => {
    const { platforms } = await shared();
    const p = platforms.platform(platform);
    if (p.auth === "oauth2") {
      return p.redirect === "https" ? oauth.hostedConnect(platform, opts) : oauth.loopbackConnect(platform, opts);
    }
    const conn = await oauth.connectWithCredentials(platform, opts);
    return vault.summarise(conn);
  });
  handle("connections:finishHosted", async ({ connectionId, keepInCloud }) =>
    oauth.finishHosted(connectionId, { keepInCloud }));
  handle("connections:setUnattended", async ({ connectionId, enabled }) => {
    const conn = vault.get(connectionId);
    if (!conn) throw new Error("No such connection on this machine.");
    if (enabled) await relay.pushConnection(conn);
    else await relay.dropConnection(connectionId).catch(() => {});
    vault.save({ ...conn, unattended: !!enabled });
    return vault.summarise(vault.get(connectionId));
  });

  handle("media:pick", async () => media.pick(win));
  handle("media:thumbnail", async (ref) => media.thumbnail(ref));
  handle("media:describe", async (p) => media.describe(p));

  handle("publish", async (items) =>
    net.publishMany(items, (event) => win && win.webContents.send("desk:publish-progress", event)));
  handle("act", async (action) => net.actOne(action));
  handle("estimate", async (items) => net.estimate(items));

  handle("relay:health", async () => relay.health());
  handle("relay:syncQueue", async ({ entries, remove }) => relay.syncQueue(entries, remove));
  handle("relay:queueResults", async (since) => relay.queueResults(since));
  handle("relay:feed", async ({ connectionIds, since }) => relay.feed(connectionIds, since));

  handle("scheduler:state", async () => scheduler.summary());
  handle("scheduler:setQueue", async (posts) => scheduler.setQueue(posts));
  handle("scheduler:runNow", async () => scheduler.runNow());

  handle("open-external", async (url) => {
    if (!/^https?:/.test(url)) throw new Error("Only http(s) links can be opened.");
    await shell.openExternal(url);
    return true;
  });
  handle("save-file", async ({ name, contents }) => {
    const res = await dialog.showSaveDialog(win, { defaultPath: name });
    if (res.canceled) return null;
    await fs.promises.writeFile(res.filePath, contents, "utf8");
    return res.filePath;
  });
  handle("open-file", async () => {
    const res = await dialog.showOpenDialog(win, { properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] });
    if (res.canceled) return null;
    return { name: path.basename(res.filePaths[0]), text: await fs.promises.readFile(res.filePaths[0], "utf8") };
  });
}

/** Catalogue entries carry helper functions that cannot cross the bridge. */
function stripFunctions(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/* -------------------------------------------------------------------- boot */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", show);

  app.whenReady().then(async () => {
    serveApp();
    registerIpc();
    createWindow();
    buildMenu();
    try { createTray(); } catch (e) { console.error("tray unavailable:", e.message); }
    scheduler.start({
      send: (items) => net.publishMany(items),
      notify: (payload) => win && win.webContents.send("desk:scheduler", payload),
    });
  });

  app.on("window-all-closed", () => {
    // The tray keeps the desk alive so scheduled posts still go out.
    if (process.platform !== "darwin" && !tray) app.quit();
  });
  app.on("activate", show);
  app.on("before-quit", () => { app.__quitting = true; scheduler.stop(); });
}
