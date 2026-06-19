/*
 * Sovereign Audio Studio — Service Worker
 * =======================================
 * Makes the app installable and fully usable OFFLINE. Bump APP_SHELL_VERSION on
 * any app-code change to roll the cache.
 *
 * Strategy:
 *   - App shell (HTML/JS/CSS/wasm/lib) → precached on install (stale-while-
 *     revalidate on fetch) so the UI always boots offline.
 *   - Everything else same-origin (the multi-hundred-MB AI models, df3 assets,
 *     sample clip) → cache-on-first-use runtime caching, so after the first run
 *     the whole pipeline works with no network at all.
 * Nothing is ever sent anywhere — this only READS from the local origin.
 */

const APP_SHELL_VERSION = "v1.2.4";
const SHELL_CACHE = `sovereign-shell-${APP_SHELL_VERSION}`;
const RUNTIME_CACHE = `sovereign-runtime-${APP_SHELL_VERSION}`;

const APP_SHELL = [
  "/",
  "/static/audio_core.js?v=1.2.4",
  "/static/transcribe.worker.js?v=1.2.4",
  "/static/vendor/transformers/transformers.min.js",
  "/static/vendor/transformers/ort-wasm-simd-threaded.jsep.wasm",
  "/static/vendor/deepfilternet3.esm.js",
  "/static/manifest.webmanifest",
  "/static/icon-192.png",
  "/static/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Don't fail the whole install if one optional asset 404s.
      .then((cache) => Promise.allSettled(APP_SHELL.map((u) => cache.add(u))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Only handle our own origin; never touch (there shouldn't be any) cross-origin.
  if (url.origin !== self.location.origin) return;

  // Navigations: serve the cached shell first, fall back to network.
  if (req.mode === "navigate") {
    event.respondWith(
      caches.match("/").then((c) => c || fetch(req).catch(() => caches.match("/")))
    );
    return;
  }

  // Cache-first with background refresh for everything same-origin.
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.ok && res.type === "basic") {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
