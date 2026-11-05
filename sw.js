/**
 * Bump VERSION on each release that should refresh cached files.
 * Bump VERSION on each release. skipWaiting on install avoids a stuck "waiting" worker on iOS PWA.
 */
const VERSION = "16";

const CACHE = `guitarhero-static-${VERSION}`;

const PRECACHE = [
  "/",
  "/index.html",
  "/styles.css",
  "/AudioEngine.js",
  "/UIController.js",
  "/pwa.js",
  "/manifest.webmanifest",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/icons/apple-touch-icon.png",
  "/samples/guitar/e2.wav",
  "/samples/guitar/a2.wav",
  "/samples/guitar/d3.wav",
  "/samples/guitar/g3.wav",
  "/samples/guitar/b3.wav",
  "/samples/guitar/e4.wav",
];

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      cache.addAll(PRECACHE).catch((err) => {
        console.warn("precache partial fail", err);
      }),
    ),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    event.waitUntil(self.skipWaiting());
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return;
  }

  if (url.pathname === "/sw.js") {
    event.respondWith(fetch(event.request));
    return;
  }

  event.respondWith(handleFetch(event.request));
});

/**
 * @param {Request} request
 */
async function handleFetch(request) {
  const cache = await caches.open(CACHE);

  if (request.mode === "navigate") {
    try {
      const fresh = await fetch(request);
      if (fresh.ok) {
        await cache.put("/index.html", fresh.clone());
      }
      return fresh;
    } catch {
      return (await cache.match("/index.html")) || (await cache.match("/")) || offlineResponse();
    }
  }

  const cached = await cache.match(request);
  try {
    const fresh = await fetch(request);
    if (fresh.ok) {
      await cache.put(request, fresh.clone());
    }
    return fresh;
  } catch {
    if (cached) {
      return cached;
    }
    return offlineResponse();
  }
}

function offlineResponse() {
  return new Response("Offline — open the tuner once online to cache it.", {
    status: 503,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}
