/* formsam Service Worker – Scope "/" */
'use strict';

const VERSION = 'formsam-v1';
const IMMUTABLE_CACHE = VERSION + '-immutable';
const DYNAMIC_CACHE = VERSION + '-dynamic';
const KNOWN_CACHES = [IMMUTABLE_CACHE, DYNAMIC_CACHE];

// Unveränderliche Assets: Cache-First
const IMMUTABLE_PREFIXES = ['/vendor/', '/fonts/', '/env/', '/img/gallery/', '/img/icons/', '/img/studio/', '/img/brand/'];
// App-Shell, JS, CSS: Network-First (frische Version, Cache nur als Offline-Fallback —
// sonst mischen sich nach einem Deploy alte und neue Module)
const SWR_PATHS = ['/', '/index.html', '/content.json', '/manifest.webmanifest'];
const SWR_PREFIXES = ['/css/', '/js/'];
// Niemals cachen
const NEVER_PREFIXES = ['/api/', '/orders/', '/admin', '/sw.js'];
// Eigene Seiten des Servers (Rechtstexte, lib/legal.js): Network-First unter ihrer EIGENEN Adresse — nie auf die App-Shell „/“
// umbiegen (sonst zeigte /impressum offline wie online den Shop); offline ohne Kopie im Cache → Offline-Seite
const PAGE_PATHS = ['/impressum', '/datenschutz', '/agb', '/widerruf', '/versand'];

const OFFLINE_HTML = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Offline – formsam</title>
<meta name="theme-color" content="#f4efe7">
<style>
  :root{color-scheme:light dark}
  html,body{margin:0;min-height:100%}
  body{display:flex;align-items:center;justify-content:center;padding:2rem;box-sizing:border-box;
    font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#f4efe7;color:#211d18;text-align:center}
  @media (prefers-color-scheme:dark){body{background:#17130f;color:#f0e9dc}}
  .card{max-width:26rem}
  .mark{width:3.2rem;height:4rem;margin:0 auto 1.2rem;display:block;fill:#c86f4a}
  h1{font-family:Georgia,"Times New Roman",serif;font-weight:500;font-size:1.6rem;margin:0 0 .6rem}
  p{margin:0 0 1.4rem;opacity:.8;line-height:1.5}
  button{background:#9e4f2c;color:#fff;border:0;border-radius:999px;padding:.8rem 1.6rem;font-size:1rem;cursor:pointer}
  small{display:block;margin-top:2rem;opacity:.55;letter-spacing:.04em;font-family:Georgia,"Times New Roman",serif;font-size:.95rem}
</style></head><body>
<div class="card">
  <svg class="mark" viewBox="0 0 78.99 100" aria-hidden="true"><path fill-rule="evenodd" d="M15.02 0L63.98 0C63.84 0.11 63.43 0.45 63.15 0.68C62.88 0.9 62.62 1.13 62.36 1.35C62.09 1.58 61.83 1.8 61.58 2.03C61.33 2.26 61.08 2.48 60.83 2.71C60.59 2.93 60.34 3.16 60.11 3.38C59.87 3.61 59.64 3.84 59.41 4.06C59.19 4.29 58.97 4.51 58.75 4.74C58.53 4.96 58.32 5.19 58.11 5.41C57.91 5.64 57.71 5.87 57.51 6.09C57.31 6.32 57.12 6.54 56.94 6.77C56.75 6.99 56.58 7.22 56.4 7.45C56.23 7.67 56.06 7.9 55.9 8.12C55.74 8.35 55.58 8.57 55.44 8.8C55.29 9.02 55.14 9.25 55.01 9.48C54.87 9.7 54.74 9.93 54.62 10.15C54.5 10.38 54.38 10.6 54.27 10.83C54.16 11.06 54.06 11.28 53.97 11.51C53.87 11.73 53.78 11.96 53.7 12.18C53.62 12.41 53.55 12.63 53.48 12.86C53.42 13.09 53.36 13.31 53.31 13.54C53.26 13.76 53.21 13.99 53.18 14.21C53.14 14.44 53.12 14.67 53.1 14.89C53.08 15.12 53.07 15.34 53.06 15.57C53.06 15.79 53.08 16.13 53.08 16.24L25.91 16.24C25.92 16.13 25.93 15.79 25.93 15.57C25.93 15.34 25.92 15.12 25.9 14.89C25.88 14.67 25.85 14.44 25.82 14.21C25.78 13.99 25.74 13.76 25.69 13.54C25.64 13.31 25.58 13.09 25.51 12.86C25.45 12.63 25.37 12.41 25.29 12.18C25.21 11.96 25.12 11.73 25.03 11.51C24.93 11.28 24.83 11.06 24.72 10.83C24.61 10.6 24.5 10.38 24.37 10.15C24.25 9.93 24.12 9.7 23.98 9.48C23.85 9.25 23.71 9.02 23.56 8.8C23.41 8.57 23.25 8.35 23.09 8.12C22.93 7.9 22.76 7.67 22.59 7.45C22.42 7.22 22.24 6.99 22.05 6.77C21.87 6.54 21.68 6.32 21.48 6.09C21.29 5.87 21.09 5.64 20.88 5.41C20.67 5.19 20.46 4.96 20.25 4.74C20.03 4.51 19.81 4.29 19.58 4.06C19.35 3.84 19.12 3.61 18.89 3.38C18.65 3.16 18.41 2.93 18.16 2.71C17.92 2.48 17.67 2.26 17.41 2.03C17.16 1.8 16.9 1.58 16.64 1.35C16.38 1.13 16.11 0.9 15.84 0.68C15.57 0.45 15.15 0.11 15.02 0ZM26.15 19.55L52.85 19.55C52.86 19.67 52.89 20.01 52.92 20.24C52.95 20.47 52.98 20.7 53.01 20.93C53.05 21.16 53.08 21.39 53.12 21.62C53.16 21.84 53.21 22.07 53.26 22.3C53.31 22.53 53.36 22.76 53.42 22.99C53.48 23.22 53.54 23.45 53.61 23.68C53.68 23.91 53.75 24.14 53.83 24.37C53.91 24.6 53.99 24.82 54.09 25.05C54.18 25.28 54.27 25.51 54.38 25.74C54.48 25.97 54.59 26.2 54.71 26.43C54.83 26.66 54.96 26.89 55.09 27.12C55.22 27.35 55.36 27.58 55.51 27.81C55.66 28.03 55.82 28.26 55.98 28.49C56.15 28.72 56.32 28.95 56.51 29.18C56.69 29.41 56.88 29.64 57.08 29.87C57.29 30.1 57.5 30.33 57.72 30.56C57.94 30.79 58.17 31.02 58.41 31.24C58.66 31.47 58.91 31.7 59.17 31.93C59.44 32.16 59.71 32.39 60 32.62C60.28 32.85 60.74 33.19 60.89 33.31L18.1 33.31C18.25 33.19 18.71 32.85 19 32.62C19.28 32.39 19.56 32.16 19.82 31.93C20.09 31.7 20.34 31.47 20.58 31.24C20.82 31.02 21.05 30.79 21.28 30.56C21.5 30.33 21.71 30.1 21.91 29.87C22.11 29.64 22.3 29.41 22.49 29.18C22.67 28.95 22.85 28.72 23.01 28.49C23.18 28.26 23.33 28.03 23.48 27.81C23.63 27.58 23.77 27.35 23.91 27.12C24.04 26.89 24.16 26.66 24.28 26.43C24.4 26.2 24.51 25.97 24.62 25.74C24.72 25.51 24.82 25.28 24.91 25.05C25 24.82 25.08 24.6 25.16 24.37C25.24 24.14 25.32 23.91 25.39 23.68C25.45 23.45 25.52 23.22 25.58 22.99C25.63 22.76 25.69 22.53 25.74 22.3C25.79 22.07 25.83 21.84 25.87 21.62C25.91 21.39 25.95 21.16 25.98 20.93C26.02 20.7 26.05 20.47 26.07 20.24C26.1 20.01 26.13 19.67 26.15 19.55ZM15.45 36.22L63.54 36.22C63.71 36.33 64.22 36.67 64.54 36.9C64.86 37.12 65.18 37.35 65.48 37.57C65.78 37.8 66.08 38.03 66.36 38.25C66.65 38.48 66.93 38.7 67.2 38.93C67.47 39.15 67.73 39.38 67.98 39.61C68.23 39.83 68.48 40.06 68.71 40.28C68.95 40.51 69.18 40.73 69.4 40.96C69.62 41.19 69.83 41.41 70.04 41.64C70.25 41.86 70.44 42.09 70.64 42.32C70.83 42.54 71.01 42.77 71.19 42.99C71.37 43.22 71.54 43.44 71.71 43.67C71.87 43.9 72.03 44.12 72.18 44.35C72.34 44.57 72.48 44.8 72.63 45.02C72.77 45.25 72.9 45.48 73.03 45.7C73.16 45.93 73.29 46.15 73.41 46.38C73.53 46.6 73.64 46.83 73.75 47.06C73.86 47.28 73.96 47.51 74.06 47.73C74.16 47.96 74.26 48.18 74.35 48.41C74.44 48.64 74.53 48.86 74.61 49.09C74.69 49.31 74.77 49.54 74.85 49.76C74.92 49.99 74.99 50.22 75.06 50.44C75.13 50.67 75.19 50.89 75.26 51.12C75.32 51.34 75.38 51.57 75.43 51.8C75.49 52.02 75.54 52.25 75.59 52.47C75.64 52.7 75.71 53.04 75.74 53.15L3.26 53.15C3.28 53.04 3.35 52.7 3.4 52.47C3.45 52.25 3.51 52.02 3.56 51.8C3.62 51.57 3.68 51.34 3.74 51.12C3.8 50.89 3.86 50.67 3.93 50.44C4 50.22 4.07 49.99 4.15 49.76C4.22 49.54 4.3 49.31 4.38 49.09C4.47 48.86 4.55 48.64 4.64 48.41C4.74 48.18 4.83 47.96 4.93 47.73C5.03 47.51 5.13 47.28 5.24 47.06C5.35 46.83 5.47 46.6 5.59 46.38C5.71 46.15 5.83 45.93 5.96 45.7C6.09 45.48 6.23 45.25 6.37 45.02C6.51 44.8 6.66 44.57 6.81 44.35C6.96 44.12 7.12 43.9 7.29 43.67C7.45 43.44 7.62 43.22 7.8 42.99C7.98 42.77 8.17 42.54 8.36 42.32C8.55 42.09 8.75 41.86 8.95 41.64C9.16 41.41 9.37 41.19 9.6 40.96C9.82 40.73 10.05 40.51 10.28 40.28C10.52 40.06 10.76 39.83 11.01 39.61C11.27 39.38 11.53 39.15 11.8 38.93C12.07 38.7 12.34 38.48 12.63 38.25C12.92 38.03 13.21 37.8 13.51 37.57C13.82 37.35 14.13 37.12 14.45 36.9C14.78 36.67 15.28 36.33 15.45 36.22ZM1.45 56.55L77.54 56.55C77.59 56.66 77.72 57 77.81 57.23C77.89 57.45 77.97 57.68 78.04 57.91C78.12 58.13 78.19 58.36 78.26 58.59C78.32 58.81 78.38 59.04 78.44 59.27C78.5 59.49 78.55 59.72 78.6 59.94C78.64 60.17 78.69 60.4 78.73 60.62C78.77 60.85 78.8 61.08 78.83 61.3C78.86 61.53 78.89 61.76 78.91 61.98C78.93 62.21 78.95 62.43 78.96 62.66C78.98 62.89 78.99 63.11 78.99 63.34C79 63.57 79 63.79 78.99 64.02C78.99 64.25 78.98 64.47 78.97 64.7C78.96 64.92 78.94 65.15 78.92 65.38C78.9 65.6 78.88 65.83 78.85 66.06C78.82 66.28 78.79 66.51 78.76 66.74C78.72 66.96 78.68 67.19 78.64 67.41C78.59 67.64 78.54 67.87 78.49 68.09C78.44 68.32 78.38 68.55 78.32 68.77C78.26 69 78.2 69.23 78.13 69.45C78.06 69.68 77.99 69.9 77.92 70.13C77.84 70.36 77.76 70.58 77.68 70.81C77.6 71.04 77.51 71.26 77.42 71.49C77.33 71.72 77.23 71.94 77.14 72.17C77.04 72.39 76.94 72.62 76.83 72.85C76.72 73.07 76.62 73.3 76.5 73.53C76.39 73.75 76.27 73.98 76.15 74.21C76.03 74.43 75.91 74.66 75.78 74.88C75.65 75.11 75.52 75.34 75.39 75.56C75.25 75.79 75.12 76.02 74.97 76.24C74.83 76.47 74.69 76.7 74.54 76.92C74.39 77.15 74.24 77.37 74.08 77.6C73.93 77.83 73.77 78.05 73.61 78.28C73.45 78.51 73.28 78.73 73.11 78.96C72.94 79.19 72.77 79.41 72.59 79.64C72.42 79.86 72.24 80.09 72.06 80.32C71.87 80.54 71.69 80.77 71.5 81C71.31 81.22 71.02 81.56 70.92 81.68L8.07 81.68C7.97 81.56 7.68 81.22 7.49 81C7.31 80.77 7.12 80.54 6.94 80.32C6.76 80.09 6.58 79.86 6.4 79.64C6.22 79.41 6.05 79.19 5.88 78.96C5.71 78.73 5.55 78.51 5.39 78.28C5.22 78.05 5.07 77.83 4.91 77.6C4.75 77.37 4.6 77.15 4.45 76.92C4.31 76.7 4.16 76.47 4.02 76.24C3.88 76.02 3.74 75.79 3.6 75.56C3.47 75.34 3.34 75.11 3.21 74.88C3.08 74.66 2.96 74.43 2.84 74.21C2.72 73.98 2.6 73.75 2.49 73.53C2.38 73.3 2.27 73.07 2.16 72.85C2.06 72.62 1.96 72.39 1.86 72.17C1.76 71.94 1.67 71.72 1.57 71.49C1.48 71.26 1.4 71.04 1.31 70.81C1.23 70.58 1.15 70.36 1.08 70.13C1 69.9 0.93 69.68 0.86 69.45C0.79 69.23 0.73 69 0.67 68.77C0.61 68.55 0.55 68.32 0.5 68.09C0.45 67.87 0.4 67.64 0.36 67.41C0.31 67.19 0.27 66.96 0.24 66.74C0.2 66.51 0.17 66.28 0.14 66.06C0.11 65.83 0.09 65.6 0.07 65.38C0.05 65.15 0.03 64.92 0.02 64.7C0.01 64.47 0 64.25 0 64.02C0 63.79 0 63.57 0 63.34C0.01 63.11 0.02 62.89 0.03 62.66C0.04 62.43 0.06 62.21 0.08 61.98C0.11 61.76 0.13 61.53 0.16 61.3C0.19 61.08 0.23 60.85 0.27 60.62C0.31 60.4 0.35 60.17 0.4 59.94C0.45 59.72 0.5 59.49 0.55 59.27C0.61 59.04 0.67 58.81 0.74 58.59C0.8 58.36 0.87 58.13 0.95 57.91C1.02 57.68 1.1 57.45 1.19 57.23C1.27 57 1.41 56.66 1.45 56.55ZM9.86 84.54L69.14 84.54C69.08 84.65 68.89 84.99 68.76 85.21C68.64 85.43 68.52 85.66 68.39 85.88C68.27 86.11 68.15 86.33 68.03 86.55C67.91 86.78 67.79 87 67.67 87.23C67.55 87.45 67.43 87.67 67.31 87.9C67.19 88.12 67.07 88.35 66.95 88.57C66.84 88.79 66.72 89.02 66.6 89.24C66.49 89.47 66.37 89.69 66.26 89.92C66.14 90.14 66.03 90.36 65.91 90.59C65.8 90.81 65.69 91.04 65.58 91.26C65.46 91.48 65.35 91.71 65.24 91.93C65.13 92.16 65.02 92.38 64.91 92.6C64.8 92.83 64.69 93.05 64.58 93.28C64.47 93.5 64.37 93.73 64.26 93.95C64.15 94.17 64.04 94.4 63.94 94.62C63.83 94.85 63.73 95.07 63.62 95.29C63.52 95.52 63.41 95.74 63.31 95.97C63.21 96.19 63.1 96.41 63 96.64C62.9 96.86 62.8 97.09 62.7 97.31C62.6 97.53 62.5 97.76 62.4 97.98C62.3 98.21 62.2 98.43 62.1 98.66C62 98.88 61.9 99.1 61.81 99.33C61.71 99.55 61.56 99.89 61.52 100L17.48 100C17.43 99.89 17.29 99.55 17.19 99.33C17.09 99.1 16.99 98.88 16.89 98.66C16.8 98.43 16.7 98.21 16.6 97.98C16.5 97.76 16.4 97.53 16.3 97.31C16.2 97.09 16.09 96.86 15.99 96.64C15.89 96.41 15.79 96.19 15.68 95.97C15.58 95.74 15.48 95.52 15.37 95.29C15.27 95.07 15.16 94.85 15.06 94.62C14.95 94.4 14.84 94.17 14.74 93.95C14.63 93.73 14.52 93.5 14.41 93.28C14.3 93.05 14.19 92.83 14.08 92.6C13.97 92.38 13.86 92.16 13.75 91.93C13.64 91.71 13.53 91.48 13.42 91.26C13.31 91.04 13.19 90.81 13.08 90.59C12.97 90.36 12.85 90.14 12.74 89.92C12.62 89.69 12.51 89.47 12.39 89.24C12.27 89.02 12.16 88.79 12.04 88.57C11.92 88.35 11.8 88.12 11.68 87.9C11.57 87.67 11.45 87.45 11.33 87.23C11.21 87 11.09 86.78 10.97 86.55C10.84 86.33 10.72 86.11 10.6 85.88C10.48 85.66 10.35 85.43 10.23 85.21C10.11 84.99 9.92 84.65 9.86 84.54Z"/></svg>
  <h1>Du bist offline</h1>
  <p>Zum Gestalten und Bestellen braucht formsam eine Internetverbindung. Sobald du wieder verbunden bist, geht's weiter.</p>
  <button onclick="location.reload()">Erneut versuchen</button>
  <small>formsam</small>
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

// cacheKey: Ablage im Cache (Standard: die Anfrage selbst); fallback: 'shell' = offline die App-Shell „/“, 'offline' = Offline-Seite
async function networkFirst(request, { cacheKey = request, fallback = null } = {}) {
  const cache = await caches.open(DYNAMIC_CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(request, { signal: ctrl.signal });
    clearTimeout(timer);
    if (isCacheable(res)) cache.put(cacheKey, res.clone()).catch(() => {});
    return res;
  } catch (err) {
    const cached = await cache.match(cacheKey);
    if (cached) return cached;
    if (fallback === 'shell') {
      const shell = await cache.match('/');
      return shell || offlineResponse();
    }
    if (fallback === 'offline') return offlineResponse();
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

  // Rechtstexte (auch mit Slash am Ende oder ?order=…): echte Anfrage ans Netz, Cache-Eintrag je Seite ohne Query
  const page = path.replace(/\/+$/, '') || '/';
  if (PAGE_PATHS.includes(page)) {
    // Navigations-Anfragen (mode 'navigate') lassen sich nicht mit eigenen Optionen (AbortSignal) weiterreichen → als neue Anfrage
    const req = isNavigation ? new Request(url.href, { headers: request.headers }) : request;
    event.respondWith(networkFirst(req, { cacheKey: new Request(page), fallback: isNavigation ? 'offline' : null }));
    return;
  }

  if (isNavigation || SWR_PATHS.includes(path) || startsWithAny(path, SWR_PREFIXES)) {
    // Navigationen auf die App-Shell "/" normalisieren, Query-Strings ignorieren
    const key = isNavigation ? new Request('/', { headers: request.headers }) : request;
    event.respondWith(networkFirst(key, { fallback: isNavigation ? 'shell' : null }));
    return;
  }
  // Alles andere (z. B. sonstige Bilder): Netzwerk, ohne Caching
});
