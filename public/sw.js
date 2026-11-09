/* Service worker: caches the app shell so staff can open the POS and queue
   sales without a connection. API calls (Supabase) are never cached here;
   product data is cached in IndexedDB by the app itself. */
const CACHE = "sw-shell-v1";
const SHELL = ["/app", "/app/pos", "/app/sales", "/login", "/manifest.webmanifest", "/api/icon/192"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // Immutable build assets: cache first
  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })),
    );
    return;
  }

  // Pages: network first, fall back to the cached page (or the POS shell)
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(url.pathname, copy));
        return res;
      }).catch(async () => {
        const cache = await caches.open(CACHE);
        return (await cache.match(url.pathname)) || (await cache.match("/app/pos")) || (await cache.match("/app")) || Response.error();
      }),
    );
    return;
  }

  // Other same-origin GETs (icons, manifest, RSC payloads): stale-while-revalidate
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const hit = await cache.match(req);
      const net = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || net;
    }),
  );
});
