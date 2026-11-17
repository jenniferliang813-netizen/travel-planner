// =====================================================================
// Service worker：讓網站沒網路也打得開（離線瀏覽）
// - 行程資料本身由 Firestore 的本機快取（IndexedDB）負責，這裡只管網頁檔案、程式庫、圖片、地圖圖磚
// - 不需要跟著 index.html 的 ?v=N 改版本號：安裝時會自己讀 index.html 找出目前的 app.js／style.css
// =====================================================================
const SHELL_CACHE = "tp-shell";
const LIB_CACHE = "tp-lib"; // CDN libraries / fonts (URLs are versioned, safe to keep)
const IMG_CACHE = "tp-img"; // img/food etc. (same name used in app.js saveTripImagesOffline)
const TILE_CACHE = "tp-tiles"; // OpenStreetMap tiles the user has already looked at
const TILE_MAX = 800;
const NAV_TIMEOUT = 2500; // ms to wait for the network before showing the saved copy

const SHELL = [
  "firebase-config.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/apple-touch-icon.png",
];
const LIBS = [
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js",
  "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css",
  "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    (async () => {
      const shell = await caches.open(SHELL_CACHE);
      // Read index.html to find the current app.js?v=N / style.css?v=N, so no version lives here
      const res = await fetch("index.html", { cache: "no-store" });
      const html = await res.clone().text();
      await shell.put("index.html", res);
      const versioned = [...html.matchAll(/(?:src|href)="((?:app\.js|style\.css)\?v=\d+)"/g)].map((m) => m[1]);
      await Promise.all([...SHELL, ...versioned].map((u) => shell.add(u).catch(() => {})));
      const lib = await caches.open(LIB_CACHE);
      // one failing CDN file must not block the install
      await Promise.all(LIBS.map((u) => lib.match(u).then((hit) => hit || lib.add(u)).catch(() => {})));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    (async () => {
      const keep = [SHELL_CACHE, LIB_CACHE, IMG_CACHE, TILE_CACHE];
      for (const k of await caches.keys()) if (!keep.includes(k)) await caches.delete(k);
      await self.clients.claim();
    })()
  );
});

const LIB_HOSTS = ["www.gstatic.com", "unpkg.com", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Page itself (any ?trip= / hash): network first, but fall back to the saved copy when
  // offline or when the signal is too weak to answer in time
  if (req.mode === "navigate") {
    e.respondWith(
      (async () => {
        const c = await caches.open(SHELL_CACHE);
        const saved = await c.match("index.html");
        const net = fetch(req).then((res) => {
          if (res.ok) c.put("index.html", res.clone());
          return res;
        });
        if (!saved) return net;
        net.catch(() => {});
        const slow = new Promise((r) => setTimeout(() => r(saved), NAV_TIMEOUT));
        return Promise.race([net.catch(() => saved), slow]);
      })()
    );
    return;
  }

  if (url.origin === location.origin) {
    if (url.pathname.includes("/img/") || url.pathname.includes("/icons/")) {
      e.respondWith(cacheFirst(req, IMG_CACHE));
    } else if (url.search.includes("v=")) {
      e.respondWith(cacheFirst(req, SHELL_CACHE, true));
    } else {
      e.respondWith(staleWhileRevalidate(req, SHELL_CACHE)); // firebase-config.js, manifest…
    }
    return;
  }
  if (LIB_HOSTS.includes(url.hostname) && (url.hostname !== "www.gstatic.com" || url.pathname.startsWith("/firebasejs/"))) {
    e.respondWith(cacheFirst(req, LIB_CACHE));
    return;
  }
  if (url.hostname === "tile.openstreetmap.org") {
    e.respondWith(staleWhileRevalidate(req, TILE_CACHE, TILE_MAX));
    return;
  }
  // Everything else (Firestore, weather, geocoding) goes straight to the network
});

// dropOld: after saving app.js?v=29, remove app.js?v=28 etc. so old versions don't pile up
async function cacheFirst(req, name, dropOld) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok || res.type === "opaque") {
    await c.put(req, res.clone());
    if (dropOld) {
      const me = new URL(req.url);
      for (const k of await c.keys()) {
        const u = new URL(k.url);
        if (u.pathname === me.pathname && u.search !== me.search) await c.delete(k);
      }
    }
  }
  return res;
}

async function staleWhileRevalidate(req, name, max) {
  const c = await caches.open(name);
  const hit = await c.match(req);
  const net = fetch(req)
    .then(async (res) => {
      if (res.ok || res.type === "opaque") {
        await c.put(req, res.clone());
        if (max) trim(c, max);
      }
      return res;
    })
    .catch(() => hit || Response.error());
  return hit || net;
}

async function trim(c, max) {
  const keys = await c.keys();
  for (let i = 0; i < keys.length - max; i++) await c.delete(keys[i]);
}
