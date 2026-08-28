// OVJU — Testserver: statische Website + Bestell-API + Admin
// Start: node server.js   →   http://<host>:4488
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { mkdir, writeFile, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, 'public');
const ORDERS = path.join(__dirname, 'orders');
const PORT = process.env.PORT || 4488;
const MAX_BODY = 40 * 1024 * 1024; // 40 MB (STL als base64)

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.stl': 'model/stl',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('Datei zu groß')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function newOrderId() {
  const d = new Date();
  const stamp = d.toISOString().slice(2, 10).replace(/-/g, '');
  return `OV-${stamp}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
async function handleOrder(req, res) {
  let data;
  try {
    data = JSON.parse((await readBody(req)).toString('utf8'));
  } catch (e) {
    return send(res, 400, { ok: false, error: e.message || 'Ungültige Anfrage' });
  }
  const { name, email, qty, notes, config, colorName, filename, stlBase64 } = data;
  if (!name || !email || !stlBase64) {
    return send(res, 400, { ok: false, error: 'Name, E-Mail und Modell sind erforderlich' });
  }
  const stl = Buffer.from(stlBase64, 'base64');
  if (stl.length < 84) return send(res, 400, { ok: false, error: 'STL-Datei ungültig' });

  const orderId = newOrderId();
  const dir = path.join(ORDERS, orderId);
  await mkdir(dir, { recursive: true });
  const safeName = (filename || 'eierbecher.stl').replace(/[^a-zA-Z0-9äöüÄÖÜß._-]/g, '_');
  await writeFile(path.join(dir, safeName), stl);
  await writeFile(path.join(dir, 'order.json'), JSON.stringify({
    orderId,
    createdAt: new Date().toISOString(),
    name, email, qty: qty || 1, notes: notes || '',
    colorName, config,
    stlFile: safeName,
    stlBytes: stl.length,
  }, null, 2));
  console.log(`📦 Neue Bestellung ${orderId} von ${name} <${email}> — ${safeName} (${(stl.length / 1e6).toFixed(1)} MB)`);
  send(res, 200, { ok: true, orderId });
}

async function listOrders() {
  if (!existsSync(ORDERS)) return [];
  const dirs = (await readdir(ORDERS, { withFileTypes: true }))
    .filter((d) => d.isDirectory()).map((d) => d.name).sort().reverse();
  const orders = [];
  for (const d of dirs) {
    try {
      orders.push(JSON.parse(await readFile(path.join(ORDERS, d, 'order.json'), 'utf8')));
    } catch { /* unvollständige Bestellung überspringen */ }
  }
  return orders;
}

function adminHTML(orders) {
  const rows = orders.map((o) => {
    const c = o.config || {};
    const cfg = `${c.preset || '?'} · ${c.pattern || '?'}${c.pattern !== 'glatt' ? ` (${c.ribs}×/${c.depth}mm${c.twist ? `, Drall ${Math.round(c.twist * 180)}°` : ''})` : ''} · H ${c.height}mm${c.text ? ` · „${c.text}“` : ''}`;
    return `<tr>
      <td><b>${o.orderId}</b><br><small>${new Date(o.createdAt).toLocaleString('de-DE')}</small></td>
      <td>${o.name}<br><small>${o.email}</small></td>
      <td>${o.qty}× · ${o.colorName || '?'}</td>
      <td><small>${cfg}</small>${o.notes ? `<br><small>📝 ${o.notes}</small>` : ''}</td>
      <td><a class="dl" href="/orders/${o.orderId}/${encodeURIComponent(o.stlFile)}" download>⬇ STL (${(o.stlBytes / 1e6).toFixed(1)} MB)</a></td>
    </tr>`;
  }).join('');
  return `<!DOCTYPE html><html lang="de"><head><meta charset="utf-8"><title>OVJU Admin — Bestellungen</title>
  <style>
    body{font-family:system-ui;background:#f4efe7;color:#211d18;margin:0;padding:40px}
    h1{font-size:1.6rem} .sub{color:#6b6257;margin-bottom:24px}
    table{width:100%;border-collapse:collapse;background:#fbf8f2;border-radius:14px;overflow:hidden;box-shadow:0 8px 30px rgba(60,45,30,.12)}
    th,td{padding:14px 16px;text-align:left;border-bottom:1px solid #eee5d5;vertical-align:top}
    th{background:#211d18;color:#f4efe7;font-size:.82rem;text-transform:uppercase;letter-spacing:.06em}
    small{color:#6b6257} .dl{color:#a8563a;font-weight:600;text-decoration:none} .dl:hover{text-decoration:underline}
    .empty{padding:60px;text-align:center;color:#6b6257}
  </style></head><body>
  <h1>🥚 OVJU — Bestellungen</h1><p class="sub">${orders.length} Bestellung(en) · STL herunterladen → in Bambu Studio öffnen → slicen → drucken</p>
  ${orders.length ? `<table><tr><th>Bestellung</th><th>Kunde</th><th>Menge/Farbe</th><th>Design</th><th>Datei</th></tr>${rows}</table>` : '<div class="empty">Noch keine Bestellungen — designe einen auf der <a href="/">Startseite</a>!</div>'}
  </body></html>`;
}

// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = decodeURIComponent(url.pathname);

  try {
    if (req.method === 'POST' && p === '/api/order') return await handleOrder(req, res);
    if (p === '/api/orders') return send(res, 200, await listOrders());
    if (p === '/admin' || p === '/admin/') return send(res, 200, adminHTML(await listOrders()), 'text/html; charset=utf-8');

    // Bestell-Dateien (STL-Downloads für den Admin)
    if (p.startsWith('/orders/')) {
      const file = path.normalize(path.join(__dirname, p));
      if (!file.startsWith(ORDERS + path.sep) || !existsSync(file) || !statSync(file).isFile()) {
        return send(res, 404, { ok: false, error: 'Nicht gefunden' });
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return createReadStream(file).pipe(res);
    }

    // Statische Dateien
    let file = path.normalize(path.join(PUBLIC, p === '/' ? 'index.html' : p));
    if (!file.startsWith(PUBLIC)) return send(res, 403, { ok: false, error: 'Verboten' });
    if (existsSync(file) && statSync(file).isDirectory()) file = path.join(file, 'index.html');
    if (!existsSync(file)) return send(res, 404, 'Nicht gefunden', 'text/plain; charset=utf-8');
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    send(res, 500, { ok: false, error: 'Serverfehler' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🥚 OVJU läuft → http://0.0.0.0:${PORT}  (Admin: /admin)`);
});
