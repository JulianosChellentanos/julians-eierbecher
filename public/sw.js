/* OVJU Service Worker – Scope "/" */
'use strict';

const VERSION = 'ovju-v2';
const IMMUTABLE_CACHE = VERSION + '-immutable';
const DYNAMIC_CACHE = VERSION + '-dynamic';
const KNOWN_CACHES = [IMMUTABLE_CACHE, DYNAMIC_CACHE];

// Unveränderliche Assets: Cache-First
const IMMUTABLE_PREFIXES = ['/vendor/', '/fonts/', '/env/', '/img/gallery/', '/img/icons/'];
// App-Shell, JS, CSS: Network-First (frische Version, Cache nur als Offline-Fallback —
// sonst mischen sich nach einem Deploy alte und neue Module)
const SWR_PATHS = ['/', '/index.html', '/content.json', '/manifest.webmanifest'];
const SWR_PREFIXES = ['/css/', '/js/'];
// Niemals cachen
const NEVER_PREFIXES = ['/api/', '/orders/', '/admin', '/sw.js'];

const OFFLINE_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline – OVJU</title>
<meta name="theme-color" content="#f4efe7">
<style>
  :root{color-scheme:light dark}
  html,body{margin:0;min-height:100%}
  body{display:flex;align-items:center;justify-content:center;padding:2rem;box-sizing:border-box;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4efe7;color:#211d18;text-align:center}
  @media (prefers-color-scheme:dark){body{background:#17130f;color:#f0e9dc}}
  .card{max-width:26rem}
  .egg{font-size:4.5rem;line-height:1;margin-bottom:1rem}
  h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:1.6rem;margin:0 0 .6rem}
  p{margin:0 0 1.4rem;opacity:.8;line-height:1.5}
  button{background:#c86f4a;color:#fff;border:0;border-radius:999px;padding:.8rem 1.6rem;font-size:1rem;cursor:pointer}
  small{display:block;margin-top:2rem;opacity:.5;letter-spacing:.15em;text-transform:uppercase;font-size:.7rem}
</style></head><body>
<div class="card">
  <div class="egg">🥚</div>
  <h1>Du bist offline</h1>
  <p>OVJU braucht Internet zum Bestellen. Sobald du wieder verbunden bist, geht's weiter.</p>
  <button onclick="location.reload()">Erneut versuchen</button>
  <small>OVJU</small>
</div>
</body></html>`;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(DYNAMIC_CACHE)
      .then((cache) => cache.addAll(['/', '/manifest.webmanifest']).catch(() => {}))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !KNOWN_CACHES.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

function startsWithAny(pathname, prefixes) {
  return prefixes.some((p) => pathname.startsWith(p));
}

function isCacheable(response) {
  return !!response && response.ok && (response.type === 'basic' || response.type === 'default');
}

function offlineResponse() {
  return new Response(OFFLINE_HTML, {
    status: 503,
    statusText: 'Offline',
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(IMMUTABLE_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  try {
    const res = await fetch(request);
    if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    return Response.error();
  }
}

async function networkFirst(request, isNavigation) {
  const cache = await caches.open(DYNAMIC_CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(request, { signal: ctrl.signal });
    clearTimeout(timer);
    if (isCacheable(res)) cache.put(request, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    if (isNavigation) {
      const shell = await cache.match('/');
      return shell || offlineResponse();
    }
    return Response.error();
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try { url = new URL(request.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  if (startsWithAny(path, NEVER_PREFIXES)) return; // immer Netzwerk, kein Eingriff

  const isNavigation = request.mode === 'navigate';

  if (startsWithAny(path, IMMUTABLE_PREFIXES)) {
    event.respondWith(cacheFirst(request));
    return;
  }

  if (isNavigation || SWR_PATHS.includes(path) || startsWithAny(path, SWR_PREFIXES)) {
    // Navigationen auf die App-Shell "/" normalisieren, Query-Strings ignorieren
    const key = isNavigation ? new Request('/', { headers: request.headers }) : request;
    event.respondWith(networkFirst(key, isNavigation));
    return;
  }
  // Alles andere (z. B. sonstige Bilder): Netzwerk, ohne Caching
});
