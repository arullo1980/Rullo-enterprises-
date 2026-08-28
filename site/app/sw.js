/**
 * Broadcast Desk — service worker.
 *
 * App shell is cached on install so the console opens offline; everything a
 * user creates already lives in IndexedDB, so an offline launch is fully
 * usable — only publishing needs the network.
 *
 * Strategy: cache-first for the shell (versioned, so a bumped VERSION ships
 * new code), network-first for anything under /api/ (never cached).
 */
const VERSION = "bd-v1";
const SHELL = [
  "/app/",
  "/app/index.html",
  "/app/manifest.webmanifest",
  "/app/css/app.css",
  "/app/icons/icon.svg",
  "/app/icons/icon-192.png",
  "/app/icons/icon-512.png",
  "/app/js/main.js",
  "/app/js/store.js",
  "/app/js/ui.js",
  "/app/js/api.js",
  "/app/js/platforms.js",
  "/app/js/spinner.js",
  "/app/js/scheduler.js",
  "/app/js/rules.js",
  "/app/js/seed.js",
  "/app/js/views/dashboard.js",
  "/app/js/views/profiles.js",
  "/app/js/views/accounts.js",
  "/app/js/views/library.js",
  "/app/js/views/composer.js",
  "/app/js/views/queue.js",
  "/app/js/views/rules.js",
  "/app/js/views/inbox.js",
  "/app/js/views/settings.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // addAll fails the whole install if one file 404s; add individually so a
      // renamed view never bricks the install.
      .then((c) => Promise.all(SHELL.map((u) => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET") return;
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return;          // never cache API traffic
  if (!url.pathname.startsWith("/app/")) return;         // storefront is not ours

  e.respondWith(
    caches.match(e.request).then((hit) => {
      const live = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit || caches.match("/app/index.html"));
      // Serve from cache immediately, refresh in the background.
      return hit || live;
    })
  );
});
