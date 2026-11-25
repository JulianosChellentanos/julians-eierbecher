#!/usr/bin/env node
// test-kasse.mjs — Prüft Kasse, Preise, Belege und Einstellungs-Prüfung gegen eine eigene, frische Shop-Instanz
//
//   node tools/test-kasse.mjs            startet server.js mit eigenem DATA_DIR/ORDERS_DIR unter tmp-tests/ (freier Port,
//                                        Mail aus — es geht keine Mail hinaus, PayPal aus) und räumt danach auf
//
// Geprüft: Versandfreigrenze vor Gutschein/Guthaben, Aktion nie teurer als ohne (Gutschein-Sperre nur mit Ersparnis), Browser- und
// Server-Preis gleich (pricing.js ⇔ /api/quote), Null-Betrag (bezahlt erst mit dem Abschluss), Rechnung (Steuerstatus,
// Leistungszeitpunkt, Zahlungshinweis), Steuerwechsel bei Gutschrift/Storno (auch Altbestand ohne order.steuer),
// Storno-Aufheben-Sperre, Storno einer 0-€-Rechnung, Reklamationsgrenzen, Einstellungs-Prüfung (400 statt 500, nichts
// gespeichert), CSV-Spalten, Design-Code, Gutschein-Grenzen (Höchstzahl: eigene abgebrochene Kasse sperrt nicht, Nachprüfung
// beim Abschluss). Exit 0 = alles bestanden.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../public/js/pricing.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-tests', `test-kasse-${process.pid}`);
const DATA = path.join(TMP, 'data'), ORDERS = path.join(TMP, 'orders');
// Admin-Passwort vorab in settings.json (Klartext) — gilt mit dem alten Standard wie mit der Hash-Umstellung (neuere Stände
// würfeln bei einer Neuinstallation ein zufälliges Passwort und stellen einen Klartext-adminKey beim Start auf einen Hash um)
const ADMIN = 'test-kasse-admin';
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 400) : ''); }
};
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3,
  text: '', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
const KUNDE = { name: 'Erika Mustermann', email: 'kunde@example.test', street: 'Teststraße 12', zip: '12345', city: 'Teststadt', note: '' };
const V = (qty = 1, cfg = {}, rest = {}) => ({ product: 'vase', qty, saucer: false, color: 'elfenbein', colorName: 'Elfenbein', code: null, config: { ...VASE, ...cfg }, ...rest });
const stl = () => { const b = Buffer.alloc(134); b.writeUInt32LE(1, 80); return b; };

let base = '', child = null, ipNr = 0;
// Jede Anfrage aus einem eigenen Netz (TRUST_PROXY=1): die Missbrauchsbremsen (z. B. 20 Kassen je IP und Stunde) prüft test-daten
async function req(method, pfad, body, headers = {}) {
  ipNr++;
  const h = { 'x-forwarded-for': `10.${(ipNr >> 8) & 255}.${ipNr & 255}.1`, ...headers };
  let data;
  if (Buffer.isBuffer(body)) { data = body; h['content-type'] = 'application/octet-stream'; } else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
  const r = await fetch(base + pfad, { method, headers: h, body: data });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: r.status, json, text };
}
const admin = (method, pfad, body) => req(method, pfad, body, { 'x-admin-key': ADMIN });
const daten = async () => (await admin('GET', '/api/admin/data')).json;
const setze = (patch) => admin('POST', '/api/admin/settings', patch);
const quote = async (items, couponCode = null) => (await req('POST', '/api/quote', { items, couponCode })).json;
const lies = (id) => JSON.parse(readFileSync(path.join(ORDERS, id, 'order.json'), 'utf8'));
const beleg = (id, f) => { const p = path.join(ORDERS, id, f); return existsSync(p) ? readFileSync(p, 'utf8').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ') : ''; };
const status = (orderId, st, extra = {}) => admin('POST', '/api/admin/order-update', { orderId, status: st, notify: false, ...extra });
const rekla = (body) => admin('POST', '/api/admin/reklamation', { notify: false, ...body });
/** Vollständige Vorkasse-Bestellung: Angebot → Kasse (expectedTotal, kasseStand 2) → Modelle → Abschluss */
async function bestelle(items, couponCode = null, { abschliessen = true, extra = {}, kunde = {} } = {}) {
  const q = await quote(items, couponCode);
  const co = await req('POST', '/api/checkout', { customer: { ...KUNDE, ...kunde }, items, payment: 'vorkasse', couponCode, beschaffenheit: true, mitSchluessel: true, kasseStand: 2, expectedTotal: q.total, ...extra });
  if (!co.json?.ok) return { fehler: co, quote: q };
  const { orderId, accessKey } = co.json;
  if (!abschliessen) return { orderId, accessKey, total: co.json.total };
  return { orderId, accessKey, total: co.json.total, ...(await abschluss(orderId, accessKey, items.length)) };
}
/** Modelle hochladen und die Kasse abschließen (auch für eine vorher nur angelegte Kasse) */
async function abschluss(orderId, accessKey, n = 1) {
  for (let i = 0; i < n; i++) await req('PUT', `/api/order/${orderId}/stl/${i}`, stl(), { 'x-order-key': accessKey });
  const c = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  return { invoiceNo: c.json?.invoiceNo, complete: c };
}
/** Guthaben über eine erledigte Reklamation („Gutschein“) erzeugen → Code */
async function guthaben(betrag, menge = 3) {
  const b = await bestelle([V(menge)]);
  await status(b.orderId, 'bezahlt');
  await rekla({ orderId: b.orderId, action: 'anlegen', art: 'gutschein', betrag, grund: 'Test' });
  const r = await rekla({ orderId: b.orderId, action: 'erledigen' });
  return r.json?.order?.reklamation?.gutscheinCode;
}

async function start() {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(DATA, { recursive: true }); mkdirSync(ORDERS, { recursive: true });
  writeFileSync(path.join(DATA, 'settings.json'), JSON.stringify({ adminKey: ADMIN }));
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: DATA, ORDERS_DIR: ORDERS, TRUST_PROXY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/pricing`)).ok) return () => log; } catch { /* startet noch */ }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`Server startet nicht:\n${log}`);
}

let serverLog = () => '';
try {
  serverLog = await start();
  const d0 = await daten();
  // feste Preise für nachvollziehbare Beträge: Vase 24,90 (−10 % ab 2, −15 % ab 3), Größenaufschlag 100 %, Versand 4,90 ab 39 €
  const pricing0 = { ...structuredClone(d0.settings.pricing), volumen: { prozent: 100, euro: 0 }, muster: { lamellen: 3 }, gravur: 3, shipping: { flat: 4.9, freeFrom: 39 } };
  check((await setze({ pricing: pricing0 })).status === 200, 'Preise wie im Shop speichern → 200');
  check(d0.settings.mail.enabled === false && d0.settings.paypal.enabled === false, 'frische Instanz: Mail und PayPal aus');
  // Gutscheine für die Tests (gleich die Gutschein-Prüfung beim Speichern mit)
  const coupons0 = [
    { code: 'P10', type: 'percent', value: 10, minOrder: 0, active: true, mitAktion: false },
    { code: 'F5', type: 'fixed', value: 5, minOrder: 0, active: true, mitAktion: false },
    { code: 'G100', type: 'percent', value: 100, minOrder: 0, active: true, mitAktion: true },
    { code: 'ALT', type: 'percent', value: 5, minOrder: 0, active: true, mitAktion: false, gueltigBis: '2020-01-31' },
    { code: 'EINMAL', type: 'fixed', value: 2, minOrder: 0, active: true, mitAktion: false, maxEinloesungen: 1 },
    { code: 'EINS', type: 'fixed', value: 3, minOrder: 0, active: true, mitAktion: false, maxEinloesungen: 1 },
    ...['RACEA', 'RACEB', 'RACEC'].map((code) => ({ code, type: 'fixed', value: 2, minOrder: 0, active: true, mitAktion: false, maxEinloesungen: 1 })),
    { code: 'GEWINN', type: 'percent', value: 100, minOrder: 0, active: true, mitAktion: true, maxEinloesungen: 1 },
  ];
  check((await setze({ coupons: coupons0 })).status === 200, 'Gutscheine (inkl. „gültig bis“ und Höchstzahl) speichern → 200');

  console.log('1) Versandfreigrenze vor Gutschein und Guthaben');
  const v39 = V(1, { height: 200, text: 'Hallo', pattern: 'lamellen' });   // 39,20 € Warenwert
  const q0 = await quote([v39]), qP = await quote([v39], 'P10'), qF = await quote([v39], 'F5');
  check(near(q0.total, 39.2) && q0.shipping === 0, 'ohne Gutschein: 39,20 versandfrei', q0.total);
  check(qP.shipping === 0 && near(qP.total, 35.28), 'mit 10 %: Versand bleibt frei → 35,28 (vorher 40,18)', [qP.shipping, qP.total]);
  check(qF.shipping === 0 && near(qF.total, 34.2), 'mit 5 €: Versand bleibt frei → 34,20 (vorher 39,10)', [qF.shipping, qF.total]);
  const gh = await guthaben(10);
  check(/^GH-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(gh || ''), 'Guthaben-Code mit eigenem Präfix GH- (nicht wie Belegnummer GS-…)', gh);
  const qG = await quote([V(2)], gh);
  check(qG.shipping === 0 && near(qG.coupon?.off, 10) && near(qG.total, 34.82), 'Guthaben 10 € auf 44,82: versandfrei, zu zahlen 34,82 (vorher 39,72)', [qG.shipping, qG.total]);
  const bG = await bestelle([V(2)], gh);
  const reG = beleg(bG.orderId, 'rechnung.html');
  check(/Gesamtbetrag 44,82/.test(reG) && /Zu zahlen 34,82/.test(reG) && /weder den Gesamtbetrag noch die Versandkostenfreiheit/.test(reG), 'Rechnung: Gesamtbetrag 44,82, Zu zahlen 34,82, Satz zum Guthaben', reG.match(/Zwischensumme.{0,200}/)?.[0]);

  console.log('2) Aktion nie teurer als ohne, Gutschein-Sperre nur mit Ersparnis');
  const jetzt = Date.now();
  const aktion = (prozent, mengenrabatt, muster = []) => setze({ aktionen: [{ name: 'Testaktion', prozent, start: new Date(jetzt - 3600e3).toISOString(), ende: new Date(jetzt + 3600e3).toISOString(), produkte: 'alle', muster, mengenrabatt, aktiv: true }] });
  check((await aktion(10, false)).status === 200, 'Aktion −10 % ohne Mengenrabatt anlegen');
  const a1 = await quote([V(1)]), a3 = await quote([V(3)]), a3p = await quote([V(3)], 'P10');
  check(near(a1.total, 27.31) && a1.lines[0].aktionProzent === 10, '1 Vase: Aktionspreis (27,31)', a1.total);
  check(near(a3.total, 63.49) && a3.lines[0].aktionProzent === 0 && a3.aktion === null, '3 Vasen: Normalpreis mit −15 % (63,49 statt 67,23), keine Aktion', [a3.total, a3.lines[0]]);
  check(a3p.coupon && !a3p.couponError && near(a3p.total, 57.14), '3 Vasen + P10 (nicht mit Aktion kombinierbar): Aktion spart nichts → Gutschein gilt', [a3p.couponError, a3p.total]);
  check((await quote([V(1)], 'P10')).couponError?.includes('nicht mit der Aktion'), '1 Vase + P10: Aktion spart → Gutschein gesperrt (wie bisher)');
  await aktion(10, false, ['wellen']);
  const mix = await quote([V(1), V(3, { pattern: 'wellen' })], 'P10');
  check(mix.coupon && !mix.couponError, 'Aktion nur auf Wellen, Wellen ×3 ohne Ersparnis → Gutschein gilt für den Korb', mix.couponError);
  // Browser (pricing.js) und Server rechnen gleich — auch mit Aktion, Mengenrabatt, Gutschein und Guthaben
  for (const [proz, mr] of [[10, false], [15, true], [5, false]]) {
    await aktion(proz, mr);
    P.setPricing((await req('GET', '/api/pricing')).json); P.setColors((await req('GET', '/api/colors')).json);
    let abw = 0, n = 0, bsp = null;
    for (const qty of [1, 2, 3, 4]) for (const pattern of ['rippen', 'lamellen']) for (const text of ['', 'A']) for (const code of [null, 'P10', 'F5', gh]) {
      const it = V(qty, { pattern, text }); const q = await quote([it], code);
      const lp = P.linePrice(it); const sub = Math.round(lp.line * 100) / 100;
      const t = P.summen(sub, q.coupon?.off || 0, 1); n++;
      if (!near(sub, q.subtotal) || !near(t.shipping, q.shipping) || !near(t.total, q.total) || lp.aktionProzent !== q.lines[0].aktionProzent) { abw++; bsp ||= { qty, pattern, text, code, browser: [sub, t.shipping, t.total], server: [q.subtotal, q.shipping, q.total] }; }
    }
    check(abw === 0, `Aktion −${proz} % (Mengenrabatt ${mr ? 'zusätzlich' : 'nein'}): ${n} Warenkörbe, Browser = Server`, bsp);
  }
  await setze({ aktionen: [] });

  console.log('3) Null-Betrag, Rechnung, Design-Code');
  const zOffen = await bestelle([V(2, {}, { code: 'abc-def' })], 'G100', { abschliessen: false });
  const ozo = lies(zOffen.orderId);
  check(zOffen.total === 0 && ozo.paymentStatus === 'offen' && !ozo.paidAt, '0-€-Kasse vor dem Abschluss: noch offen (nicht in der Druckwarteschlange, wird wie jede abgebrochene Kasse aufgeräumt)', [ozo.paymentStatus, ozo.paidAt]);
  const z = { orderId: zOffen.orderId, total: zOffen.total, ...(await abschluss(zOffen.orderId, zOffen.accessKey)) };
  const oz = lies(z.orderId), rz = beleg(z.orderId, 'rechnung.html');
  check(z.total === 0 && oz.paymentStatus === 'bezahlt' && oz.paidAt === oz.invoiceAt && oz.history.some((h) => /Nichts zu zahlen/.test(h.note || '')), '100-%-Gutschein bei 44,82 (versandfrei): mit dem Abschluss bezahlt („Nichts zu zahlen“)', [z.total, oz.paymentStatus, oz.paidAt, oz.invoiceAt]);
  check(/Nichts zu zahlen/.test(rz) && !/überweise/.test(rz), 'Rechnung: „Nichts zu zahlen“ statt Überweisungsaufforderung', rz.match(/Gesamtbetrag.{0,160}/)?.[0]);
  check(oz.lines[0].code === 'ABCDEF', 'Design-Code der Zeile gespeichert (Normalform)', oz.lines[0].code);
  check(oz.steuer?.kleinunternehmer === true && oz.invoiceAt && oz.completedAt === oz.invoiceAt, 'Steuerstatus und Rechnungsdatum an der Bestellung', [oz.steuer, oz.invoiceAt, oz.completedAt]);
  const n0 = await bestelle([V(1)]);
  const r0 = beleg(n0.orderId, 'rechnung.html');
  check(n0.invoiceNo && r0.includes(n0.invoiceNo) && /Bitte überweise/.test(r0) && /§ 19 Abs\. 1 UStG/.test(r0), 'normale Vorkasse-Bestellung: Rechnung mit Nummer, Überweisung, § 19-Hinweis', n0.invoiceNo);
  // alter Kassen-Tab (ohne kasseStand) mit abweichendem Betrag → Bitte ums Neuladen statt Schleife
  const alt = await req('POST', '/api/checkout', { customer: KUNDE, items: [V(1, { height: 200, text: 'Hallo', pattern: 'lamellen' })], payment: 'vorkasse', couponCode: 'P10', beschaffenheit: true, mitSchluessel: true, expectedTotal: 40.18 });
  check(alt.status === 409 && /lade die Seite neu/.test(alt.json?.error || ''), 'alter Kassen-Tab (alte Versandregel) → 409 „bitte lade die Seite neu“', alt.json);
  const plz = await req('POST', '/api/checkout', { customer: { ...KUNDE, zip: 'abc' }, items: [V(1)], payment: 'bar', beschaffenheit: true, kasseStand: 2, expectedTotal: 29.8 });
  check(plz.status === 400, 'PLZ „abc“ → 400', plz.json?.error);
  const bar = await req('POST', '/api/checkout', { customer: KUNDE, items: [V(1)], payment: 'bar', beschaffenheit: true, kasseStand: 2, expectedTotal: 29.8 });
  check(bar.status === 400 && /Zahlungsart/.test(bar.json?.error || ''), 'Zahlart „bar“ → 400', bar.json?.error);

  console.log('4) Gutschein-Grenzen (gültig bis, Höchstzahl)');
  check(/abgelaufen/.test((await quote([V(1)], 'ALT')).couponError || ''), 'abgelaufener Code → Meldung „abgelaufen“');
  const e1 = await bestelle([V(1)], 'EINMAL');
  check(!e1.fehler && lies(e1.orderId).coupon?.code === 'EINMAL', 'Code mit Höchstzahl 1: erste Einlösung klappt');
  check(/bereits vergeben/.test((await quote([V(1)], 'EINMAL')).couponError || ''), 'zweite Einlösung → „bereits vergeben“');
  // eigene abgebrochene Kasse sperrt nicht, fremde Reservierung schon; doppelt bekommt ihn niemand (Nachprüfung beim Abschluss)
  const h1 = await bestelle([V(1)], 'EINS', { abschliessen: false });
  const h2 = await bestelle([V(1)], 'EINS', { abschliessen: false, kunde: { email: 'KUNDE@example.test', street: 'Andere Straße 3' } });
  check(!h1.fehler && !h2.fehler, 'Höchstzahl 1: zweite Kasse derselben Kundin (erste abgebrochen) → angelegt', h2.fehler?.json);
  const h3 = await bestelle([V(1)], 'EINS', { abschliessen: false, kunde: { email: 'andere@example.test' } });
  check(h3.fehler?.status === 400 && /bereits vergeben/.test(h3.fehler.json?.error || ''), 'andere Kundin während der Reservierung → 400 „bereits vergeben“', h3.fehler?.json);
  check(h3.fehler?.json?.code === 'gutschein', 'Kasse: Gutschein-Ablehnung mit code „gutschein“ (die Kasse prüft das Gutscheinfeld neu)', h3.fehler?.json);
  const qOhne = (await req('POST', '/api/quote', { items: [V(1)], couponCode: 'EINS' })).json;
  const qAndere = (await req('POST', '/api/quote', { items: [V(1)], couponCode: 'EINS', email: 'andere@example.test' })).json;
  const qSelbst = (await req('POST', '/api/quote', { items: [V(1)], couponCode: 'EINS', email: 'kunde@example.test' })).json;
  check(qOhne.coupon && !qAndere.coupon && /bereits vergeben/.test(qAndere.couponError || '') && qSelbst.coupon, 'Vorschau mit E-Mail: reservierter Einmal-Code gilt für die andere Kundin schon als vergeben, für die eigene nicht', { qOhne: !!qOhne.coupon, qAndere: qAndere.couponError, qSelbst: !!qSelbst.coupon });
  const c2 = await abschluss(h2.orderId, h2.accessKey);
  check(c2.complete.status === 200 && c2.invoiceNo, 'zweite Kasse abschließen → Rechnung', c2.complete.json);
  const c1 = await abschluss(h1.orderId, h1.accessKey);
  check(c1.complete.status === 409 && c1.complete.json?.code === 'gutschein' && lies(h1.orderId).status === 'storniert' && !lies(h1.orderId).invoiceNo, 'erste Kasse danach abschließen → 409, storniert, keine Rechnung', c1.complete.json);

  // Gleichzeitiger Abschluss zweier Kassen derselben Kundin mit einem Einmal-Code: nur eine bekommt eine Rechnung
  for (const code of ['RACEA', 'RACEB', 'RACEC']) {
    const ka = await bestelle([V(1)], code, { abschliessen: false }), kb = await bestelle([V(1)], code, { abschliessen: false });
    for (const k of [ka, kb]) await req('PUT', `/api/order/${k.orderId}/stl/0`, stl(), { 'x-order-key': k.accessKey });
    const [ca, cb] = await Promise.all([ka, kb].map((k) => req('POST', `/api/order/${k.orderId}/complete`, {}, { 'x-order-key': k.accessKey })));
    const st = [ca.status, cb.status].sort().join('/');
    const rechnungen = [ka, kb].filter((k) => lies(k.orderId).invoiceNo).length;
    check(st === '200/409' && rechnungen === 1 && [ca, cb].some((c) => c.json?.code === 'gutschein'), `${code}: zwei gleichzeitige Abschlüsse (max. 1) → 200 + 409 „gutschein“, genau eine Rechnung`, { st, rechnungen });
  }

  console.log('5) Storno aufheben, Reklamationsgrenzen');
  const g60 = await guthaben(60);
  const k1 = await bestelle([V(1)], g60), k2 = await bestelle([V(1)], g60);   // 29,80 + 29,80 = 59,60 (Guthaben deckt Ware + Versand)
  check(lies(k1.orderId).total === 0 && near(lies(k1.orderId).coupon.off, 29.8), 'Guthaben deckt auch den Versand (29,80 → 0 € zu zahlen)', lies(k1.orderId).coupon);
  check((await status(k1.orderId, 'storniert')).status === 200 && lies(k1.orderId).storno?.nr, 'K1 storniert → Stornorechnung');
  const sb = beleg(k1.orderId, 'storno.html');
  check(/Es war nichts zu zahlen|steht dir wieder zur Verfügung/.test(sb) && !/erstatte ich dir per Überweisung/.test(sb), 'Storno einer 0-€-Bestellung: keine Erstattung von Geld, Guthaben wieder frei', sb.match(/Stornobetrag.{0,240}/)?.[0]);
  const auf = await status(k1.orderId, 'neu');
  check(auf.status === 409 && /Stornorechnung/.test(auf.json?.error || '') && lies(k1.orderId).status === 'storniert', '„Storno aufheben“ nach Stornorechnung → 409', auf.json?.error);
  const auf2 = await admin('POST', '/api/admin/order-status', { orderId: k1.orderId, status: 'neu' });
  check(auf2.status === 409, 'auch über den alten Kurz-Endpoint → 409');
  // Rechnung über 0,00 € (100-%-Gutschein, keine Gutschrift): keine Stornorechnung, Vermerk ohne „gutgeschrieben“, Aufheben möglich
  const g0 = await bestelle([V(2)], 'G100');
  check((await status(g0.orderId, 'storniert')).status === 200 && !lies(g0.orderId).storno, 'Rechnung über 0,00 € storniert → keine Stornorechnung');
  const g0n = lies(g0.orderId).history.at(-1)?.note || '';
  check(/lautet über 0,00/.test(g0n) && !/gutgeschrieben/.test(g0n), 'Vermerk „Rechnung … lautet über 0,00 €“ (nicht „vollständig gutgeschrieben“)', g0n);
  const g0a = await status(g0.orderId, 'neu');
  check(g0a.status === 200 && lies(g0.orderId).status === 'neu' && lies(g0.orderId).paymentStatus === 'bezahlt', '„Storno aufheben“ bei 0-€-Rechnung → 200 (wieder neu, bezahlt)', g0a.json);
  // Einmal-Code über 0,00 €: Storno gibt ihn frei; ist er danach anderweitig vergeben, lässt sich das Storno nicht mehr aufheben
  const gwA = await bestelle([V(2)], 'GEWINN');   // 44,82 € Warenwert: versandfrei, 100 % → 0 €
  check(gwA.invoiceNo && lies(gwA.orderId).total === 0 && (await status(gwA.orderId, 'storniert')).status === 200, 'GEWINN (100 %, max. 1): Rechnung über 0 €, storniert');
  const gwB = await bestelle([V(2)], 'GEWINN', { kunde: { email: 'zweite@example.test' } });
  check(!!gwB.invoiceNo, 'nach dem Storno löst eine andere Kundin GEWINN ein');
  const gwAuf = await status(gwA.orderId, 'neu');
  check(gwAuf.status === 409 && /inzwischen anderweitig eingelöst/.test(gwAuf.json?.error || '') && lies(gwA.orderId).status === 'storniert', '„Storno aufheben“ der ersten → 409 (Höchstzahl erreicht), bleibt storniert', gwAuf.json);
  const ohne = await bestelle([V(1)], null, { abschliessen: false });
  await status(ohne.orderId, 'storniert');
  check((await status(ohne.orderId, 'neu')).status === 200, 'ohne Rechnung (nie abgeschlossene Kasse) bleibt Aufheben als Korrekturweg');
  check((await rekla({ orderId: ohne.orderId, action: 'anlegen', art: 'gutschein', betrag: 5, grund: 'x' })).status === 400, 'Gutschrift ohne Rechnung → 400');
  check((await rekla({ orderId: k1.orderId, action: 'anlegen', art: 'ueberweisung', betrag: 5, grund: 'x', iban: 'DE89370400440532013000' })).status === 400, 'Reklamation nach Storno → 400');
  const unbez = await bestelle([V(1)]);
  check((await rekla({ orderId: unbez.orderId, action: 'anlegen', art: 'ueberweisung', betrag: 5, grund: 'x' })).status === 400, 'Erstattung ohne Zahlung → 400');
  const rk2 = await rekla({ orderId: k2.orderId, action: 'anlegen', art: 'gutschein', betrag: 29.8, grund: 'defekt' });
  check(rk2.status === 200, 'Guthaben-Bestellung (0 € zu zahlen): Gutschrift bis zum Rechnungsbetrag 29,80 möglich', rk2.json?.error);
  await rekla({ orderId: k2.orderId, action: 'zuruecknehmen' });
  check((await rekla({ orderId: k2.orderId, action: 'anlegen', art: 'gutschein', betrag: 29.81, grund: 'x' })).status === 400, 'über dem bezahlten Betrag (29,81) → 400');
  const bezRe = await bestelle([V(1)]); await status(bezRe.orderId, 'bezahlt');
  check((await admin('POST', '/api/admin/order-update', { orderId: bezRe.orderId, paymentStatus: 'offen' })).status === 400, 'Status „Bezahlt“ mit Zahlung „offen“ → 400');

  console.log('6) Steuerstatus: Gutschrift und Storno folgen der Rechnung');
  await setze({ company: { kleinunternehmer: false } });
  const ra = await bestelle([V(2)]), rb = await bestelle([V(1)]);
  await status(rb.orderId, 'bezahlt');
  await rekla({ orderId: rb.orderId, action: 'anlegen', art: 'gutschein', betrag: 10, grund: 'x' });
  const reA = beleg(ra.orderId, 'rechnung.html');
  check(/darin Umsatzsteuer 19 % 7,16/.test(reA) && /Leistungszeitpunkt voraussichtlich/.test(reA) && !/Lieferdatum/.test(reA), 'Regel-Rechnung: USt 7,16, „Leistungszeitpunkt voraussichtlich …“', reA.match(/Rechnungsnummer.{0,160}/)?.[0]);
  await setze({ company: { kleinunternehmer: true } });
  await status(ra.orderId, 'storniert');
  await rekla({ orderId: rb.orderId, action: 'erledigen' });
  check(/Umsatzsteuer 19 % −7,16/.test(beleg(ra.orderId, 'storno.html')) && !/§ 19/.test(beleg(ra.orderId, 'storno.html')), 'nach Wechsel zu Kleinunternehmer: Storno berichtigt die ausgewiesene USt (−7,16)');
  check(/enthaltene USt \(19 %\): 1,60/.test(beleg(rb.orderId, 'gutschrift.html')) && /Rechnungskorrektur/.test(beleg(rb.orderId, 'gutschrift.html')), 'Gutschrift zur Regel-Rechnung mit USt 1,60, Titel „Gutschrift (Rechnungskorrektur)“');
  const rc = await bestelle([V(2)]);
  // Altbestand: Bestellung ohne order.steuer (wie vor dem Update) — der Status kommt aus der gespeicherten rechnung.html
  // Der Abschluss vermerkt die (bei Mail aus nicht gesendeten) Mails kurz danach selbst an der Bestellung — solange wiederholen, bis
  // das Entfernen nicht mehr überschrieben wird (sonst gelegentlich ein Wettlauf zwischen Test und Server)
  for (let i = 0; i < 20; i++) {
    const oc = lies(rc.orderId); delete oc.steuer; writeFileSync(path.join(ORDERS, rc.orderId, 'order.json'), JSON.stringify(oc, null, 2));
    await new Promise((r) => setTimeout(r, 150));
    if (!lies(rc.orderId).steuer) break;
  }
  await setze({ company: { kleinunternehmer: false } });
  await status(rc.orderId, 'storniert');
  const sc = beleg(rc.orderId, 'storno.html');
  check(/§ 19 Abs\. 1 UStG/.test(sc) && !/Umsatzsteuer 19 %/.test(sc) && lies(rc.orderId).steuer?.quelle === 'rechnung.html', 'Altbestand ohne order.steuer: Storno folgt der KU-Rechnung (aus rechnung.html)', lies(rc.orderId).steuer);
  // USt-Abgleich: Rechnung − Gutschrift − Storno = 0 (auch bei Rundung)
  const rd = await bestelle([V(1, { pattern: 'lamellen' })]); await status(rd.orderId, 'bezahlt');
  await rekla({ orderId: rd.orderId, action: 'anlegen', art: 'ueberweisung', betrag: 16.81, grund: 'x', iban: 'DE89370400440532013000' });
  await rekla({ orderId: rd.orderId, action: 'erledigen' });
  await status(rd.orderId, 'storniert');
  const usd = (t, re) => Number((re.exec(t)?.[1] || 'NaN').replace(',', '.'));
  const uR = usd(beleg(rd.orderId, 'rechnung.html'), /Umsatzsteuer 19 % (\d+,\d{2})/), uG = usd(beleg(rd.orderId, 'gutschrift.html'), /USt \(19 %\): (\d+,\d{2})/), uS = usd(beleg(rd.orderId, 'storno.html'), /Umsatzsteuer 19 % −(\d+,\d{2})/);
  check(near(uR, uG + uS), `USt: Rechnung ${uR} = Gutschrift ${uG} + Storno ${uS}`);
  await setze({ company: { kleinunternehmer: true } });

  console.log('7) Einstellungen: Fehleingaben → 400, nichts gespeichert');
  const vorher = readFileSync(path.join(DATA, 'settings.json'), 'utf8');
  const MAIL_OK = { enabled: false, host: 'smtp.example.de', port: 465, secure: 'ssl', user: 'u', pass: '', from: 'shop@example.de', fromName: 'formsam', replyTo: '', adminTo: '', adminCopy: true, autoStatusMails: true, publicUrl: 'https://www.formsam.example' };
  const falsch = [
    ['Gutschein 150 %', { coupons: [{ code: 'X150', type: 'percent', value: 150, minOrder: 0, active: true }] }],
    ['Gutschein −5 €', { coupons: [{ code: 'NEG', type: 'fixed', value: -5, minOrder: 0, active: true }] }],
    ['Gutschein Wert Text', { coupons: [{ code: 'TXT', type: 'fixed', value: 'abc', minOrder: 0, active: true }] }],
    ['Gutschein ohne Code', { coupons: [{ code: '', type: 'fixed', value: 5 }] }],
    ['Gutschein doppelt', { coupons: [{ code: 'DOP', type: 'fixed', value: 5 }, { code: 'dop', type: 'fixed', value: 5 }] }],
    ['Grundpreis leer (0)', { pricing: { ...pricing0, vase: { ...pricing0.vase, single: 0 } } }],
    ['Grundpreis 3 Nachkommastellen', { pricing: { ...pricing0, vase: { ...pricing0.vase, single: 24.999 } } }],
    ['Versand negativ', { pricing: { ...pricing0, shipping: { flat: -1, freeFrom: 39 } } }],
    ['Staffel 150 %', { pricing: { ...pricing0, vase: { ...pricing0.vase, discounts: [{ qty: 2, off: 150 }] } } }],
    ['Währung XYZ', { pricing: { ...pricing0, currency: 'XYZ1' } }],
    ['Grundpreis als leerer Text', { pricing: { ...pricing0, vase: { ...pricing0.vase, single: '' } } }],
    ['Farbe ohne Hex', { colors: [{ id: 'x', name: 'X', hex: 'rot', active: true }] }],
    ['Mail: Absender ohne @', { mail: { ...MAIL_OK, from: 'kein-at-zeichen' } }],
    ['Mail: Port 99999', { mail: { ...MAIL_OK, port: 99999 } }],
    ['Mail: Host mit Schema', { mail: { ...MAIL_OK, host: 'smtp://127.0.0.1' } }],
    ['Mail: publicUrl ohne Schema', { mail: { ...MAIL_OK, publicUrl: 'www.formsam.example' } }],
    ['Mail: publicUrl mit Pfad', { mail: { ...MAIL_OK, publicUrl: 'https://www.formsam.example/shop' } }],
    ['Mail: aktiv ohne publicUrl', { mail: { ...MAIL_OK, enabled: true, publicUrl: '' } }],
    ['Mail: secure falsch', { mail: { ...MAIL_OK, secure: 'tls' } }],
    ['Mail: adminTo kaputt', { mail: { ...MAIL_OK, adminTo: 'a@b.de; kaputt' } }],
    ['PayPal an ohne Client-ID', { paypal: { enabled: true, sandbox: true, clientId: '', secret: '' } }],
    ['gleiches Präfix', { creditPrefix: 'RE-2026-' }],
    ['W-IdNr. falsch', { company: { wIdNr: 'DE123-1' } }],
  ];
  for (const [name, patch] of falsch) {
    const r = await setze(patch);
    check(r.status === 400 && typeof r.json?.error === 'string', `${name} → 400 (${r.json?.error || r.status})`);
  }
  check(readFileSync(path.join(DATA, 'settings.json'), 'utf8') === vorher, 'settings.json nach allen Fehleingaben unverändert');
  // Gültige Eingaben, wie sie der Admin schickt
  const ok = await setze({ pricing: pricing0, mail: { ...MAIL_OK, adminTo: 'a@example.de ; b@example.de', publicUrl: 'https://www.formsam.example/' }, company: { ustId: 'DE123456789-00001' } });
  const s1 = (await daten()).settings;
  check(ok.status === 200 && s1.mail.publicUrl === 'https://www.formsam.example' && s1.mail.adminTo === 'a@example.de, b@example.de', 'gültige Mail-Angaben: publicUrl ohne „/“, Admin-Adressen sauber getrennt', s1.mail);
  check(s1.company.wIdNr === 'DE123456789-00001' && s1.company.ustId === '', 'W-IdNr. im USt-IdNr.-Feld → ins eigene Feld verschoben', s1.company);
  check((await setze({ company: { ustId: 'DE123456789', wIdNr: 'DE123456789-00002' } })).status === 200, 'USt-IdNr. und W-IdNr. zusammen speicherbar');
  const imp = await req('GET', '/impressum');
  check(/Wirtschafts-Identifikationsnummer[^<]*DE123456789-00002/.test(imp.text), 'Impressum nennt die W-IdNr.');
  await setze({ company: { ustId: '', wIdNr: '' } });
  const hinw = (await daten()).hinweise.join(' | ');
  check(/Steuernummer fehlt: Auch als Kleinunternehmer/.test(hinw) && /Platzhalter „DE00/.test(hinw), 'Hinweise: Steuernummer auch als Kleinunternehmer, Platzhalter-IBAN', hinw);
  const pr = (await req('GET', '/api/pricing')).json;
  check(pr.shipping && pr.products.vase.single === 24.9, '/api/pricing danach weiter vollständig');

  console.log('8) CSV und Kennzahlen-Grundlage');
  const csv = await admin('GET', '/api/admin/orders.csv');
  const kopf = csv.text.replace(/^﻿/, '').split('\n')[0].split(';');
  const zeileG = csv.text.split('\n').find((l) => l.startsWith(`"${bG.orderId}"`))?.split(';') || [];
  check(kopf.slice(-3).join('|') === 'Rechnungsbetrag|davon Guthaben|Gutschriftbetrag' && kopf[13] === 'Summe', 'CSV: neue Spalten hinten, „Summe“ an alter Stelle', kopf.slice(-4));
  check(zeileG[13] === '"34,82"' && zeileG.at(-3) === '"44,82"' && zeileG.at(-2) === '"10,00"', 'CSV Guthaben-Bestellung: Summe 34,82, Rechnungsbetrag 44,82, davon Guthaben 10,00', [zeileG[13], zeileG.at(-3), zeileG.at(-2)]);
} catch (err) {
  fail++;
  console.log('  ✗ Abbruch:', err?.stack || err);
} finally {
  if (child) child.kill();
  if (fail) console.log('\n--- Server-Protokoll (Ende) ---\n' + serverLog().split('\n').slice(-25).join('\n'));
  rmSync(TMP, { recursive: true, force: true });
}
console.log(`\n${pass} bestanden, ${fail} fehlgeschlagen`);
process.exit(fail ? 1 : 0);
