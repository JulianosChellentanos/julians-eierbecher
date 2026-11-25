#!/usr/bin/env node
// test-kasse-ui.mjs — Server-Teil der Kassen-/Konto-Oberfläche gegen eine eigene, frische Shop-Instanz
//
//   node tools/test-kasse-ui.mjs        startet server.js mit eigenem DATA_DIR/ORDERS_DIR unter tmp-tests/ (freier Port, Mail und
//                                       PayPal aus — es geht keine Mail hinaus) und räumt danach auf. Exit 0 = alles bestanden.
//
// Geprüft: Farbschrift (Schriftfarbe mit Namen an der Bestellung, auf der Rechnung, in den Mails — ohne interne Kennung und ohne
// „3MF, 2 Filamente“), Kassen-Meldungen je Feld (feld für die Markierung) und PLZ nach dem Liefergebiet (Browser- und Server-Wortlaut
// gleich), Konto-Adresse (vollständig oder leer, PLZ), Bezugspreis der Aktionen (Rechnung/Mail = Kasse: pricing.js aus /api/pricing ⇔
// gespeicherte aktionRef/ersparnisRef/prozentOk, auch nach einer früheren Aktion), ältere Bestellungen unverändert, Danke-Angaben aus
// /complete (Betrag, Bankverbindung, Verwendungszweck; 0 €), Widerrufe im Konto, Texte/Attribute der Kasse in index.html.
// Die Bedienung im Browser (Enter, PayPal-Auswahl, Meldungen statt alert) prüft ein Puppeteer-Lauf, siehe README „Kasse“.
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from '../public/js/pricing.js';
import { lineParts, aktionText, aktionSummary } from '../lib/mail-templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-tests', `test-kasse-ui-${process.pid}`);
const DATA = path.join(TMP, 'data'), ORDERS = path.join(TMP, 'orders');
const ADMIN = 'test-kasse-ui-admin';
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`  ✓ ${label}`); } else { fail++; console.log(`  ✗ ${label}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ''); }
};
const near = (a, b) => typeof a === 'number' && typeof b === 'number' && Math.abs(a - b) < 0.005;
const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer(); s.unref(); s.on('error', reject);
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3,
  text: '', textSize: 7, textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein', textColor: 'tiefschwarz' };
const KUNDE = { name: 'Erika Mustermann', email: 'kunde@example.test', street: 'Teststraße 12', zip: '12345', city: 'Teststadt', note: '' };
const V = (qty = 1, cfg = {}, rest = {}) => ({ product: 'vase', qty, saucer: false, color: 'elfenbein', colorName: 'Elfenbein', code: null, config: { ...VASE, ...cfg }, ...rest });
const stl = () => { const b = Buffer.alloc(134); b.writeUInt32LE(1, 80); return b; };
// Farbschrift = 3MF: kleinste „ZIP“ mit Kopf- und Endsatz-Signatur (wie modellPruefen sie verlangt)
const mini3mf = () => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(100), Buffer.from([0x50, 0x4b, 0x05, 0x06]), Buffer.alloc(18)]);

let base = '', child = null, ipNr = 0;
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
const setze = (patch) => admin('POST', '/api/admin/settings', patch);
const quote = async (items, couponCode = null) => (await req('POST', '/api/quote', { items, couponCode })).json;
const lies = (id) => JSON.parse(readFileSync(path.join(ORDERS, id, 'order.json'), 'utf8'));
const beleg = (id, f = 'rechnung.html') => { const p = path.join(ORDERS, id, f); return existsSync(p) ? readFileSync(p, 'utf8').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ') : ''; };
const kasse = (items, { kunde = {}, couponCode = null, expectedTotal, headers = {} } = {}) =>
  req('POST', '/api/checkout', { customer: { ...KUNDE, ...kunde }, items, payment: 'vorkasse', couponCode, beschaffenheit: true, mitSchluessel: true, kasseStand: 2, expectedTotal }, headers);
/** Vollständige Vorkasse-Bestellung → { orderId, accessKey, complete } */
async function bestelle(items, { couponCode = null, kunde = {}, headers = {} } = {}) {
  const q = await quote(items, couponCode);
  const co = await kasse(items, { kunde, couponCode, expectedTotal: q.total, headers });
  if (!co.json?.ok) return { fehler: co };
  const { orderId, accessKey } = co.json;
  for (let i = 0; i < items.length; i++) {
    const farbe = String(items[i].config.text || '').trim() && items[i].config.textStyle === 'farbe';
    await req('PUT', `/api/order/${orderId}/stl/${i}`, farbe ? mini3mf() : stl(), { 'x-order-key': accessKey });
  }
  const complete = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
  return { orderId, accessKey, complete: complete.json };
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
    await sleep(150);
  }
  throw new Error(`Server startet nicht:\n${log}`);
}

let serverLog = () => '';
try {
  serverLog = await start();
  const d0 = (await admin('GET', '/api/admin/data')).json;
  // Preise bleiben auf dem Stand der Neuinstallation (sonst läge ein anderer Preis im 30-Tage-Fenster der Aktionen unten)
  check((await setze({ company: { owner: 'Julian Test', iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001', bank: 'Testbank' } })).status === 200, 'Bankverbindung speichern → 200');

  console.log('1) Farbschrift: Schriftfarbe mit Namen');
  const farb = V(1, { text: 'Für Oma', textStyle: 'farbe', textColor: 'tiefschwarz', pattern: 'lamellen', depth: 2 }, { color: 'terrakotta', colorName: 'Terrakotta' });
  const bF = await bestelle([farb]);
  check(!!bF.complete?.ok, 'Farbschrift-Bestellung abgeschlossen', bF.fehler?.json || bF.complete);
  const oF = lies(bF.orderId);
  check(oF.lines[0].textColorName === 'Tiefschwarz', 'order.lines[].textColorName = „Tiefschwarz“', oF.lines[0].textColorName);
  const rF = beleg(bF.orderId);
  check(rF.includes('Gravur „Für Oma“ (Farbschrift, Schriftfarbe Tiefschwarz)') && !rF.includes('3MF') && !rF.includes('Filament'), 'Rechnung: „(Farbschrift, Schriftfarbe Tiefschwarz)“ ohne 3MF/Filamente', rF.match(/Gravur[^)]*\)/)?.[0]);
  const lp = lineParts(oF.lines[0]).join(' · ');
  check(lp.includes('Schriftfarbe Tiefschwarz') && !/tiefschwarz/.test(lp), 'Mail-Zeile: „Schriftfarbe Tiefschwarz“ (nicht die Kennung)', lp);
  const alt = { ...oF.lines[0] }; delete alt.textColorName;   // Bestellung von vor dem Feld
  check(lineParts(alt, { colors: [{ id: 'tiefschwarz', name: 'Tiefschwarz' }] }).join().includes('Schriftfarbe Tiefschwarz') && !lineParts(alt).join().includes('tiefschwarz'),
    'Mail-Zeile älterer Bestellung: Name über die Farbliste, nie die Kennung');
  const druck = await admin('GET', `/admin/druckzettel/${bF.orderId}`);
  check(druck.status === 200 && druck.text.includes('3MF') && druck.text.includes('Tiefschwarz'), 'Druckzettel nennt weiter 3MF und die Schriftfarbe');

  console.log('2) Kassen-Meldungen je Feld, PLZ nach dem Liefergebiet');
  const it1 = [V(1)];
  const q1 = await quote(it1);
  const F = async (kunde) => { const r = await kasse(it1, { kunde, expectedTotal: q1.total }); return { status: r.status, feld: r.json?.feld, error: r.json?.error, ok: r.json?.ok }; };
  const auth = await import('../public/js/auth.js');   // Browser-Wortlaut (plzFehler) — muss dem Server gleichen
  P.setPricing((await req('GET', '/api/pricing')).json);
  for (const [name, kunde, feld, muster] of [
    ['E-Mail anna@localhost', { email: 'anna@localhost' }, 'email', /E-Mail-Adresse/],
    ['Name nur Leerzeichen', { name: '   ' }, 'name', /Namen/],
    ['Straße leer', { street: ' ' }, 'street', /Straße/],
    ['Ort leer', { city: '' }, 'city', /Ort/],
    ['PLZ 1234', { zip: '1234' }, 'zip', /5 Ziffern – fehlt vorne eine 0/],
    ['PLZ ABCDE', { zip: 'ABCDE' }, 'zip', /5 Ziffern/],
    ['PLZ 00000', { zip: '00000' }, 'zip', /5 Ziffern/],
  ]) {
    const r = await F(kunde);
    check(r.status === 400 && r.feld === feld && muster.test(r.error || ''), `${name} → 400, feld ${feld}: „${r.error}“`, r);
    if (feld === 'zip') check(auth.plzFehler(kunde.zip) === r.error, `${name}: Browser (auth.js plzFehler) meldet denselben Text`, auth.plzFehler(kunde.zip));
  }
  check(auth.plzFehler('01067') === '' && (await F({ zip: '01067' })).ok === true, 'PLZ 01067 → Browser und Server nehmen sie an');
  await setze({ shop: { liefergebiet: 'Deutschland und Österreich' } });
  P.setPricing((await req('GET', '/api/pricing')).json);
  check((await F({ zip: '1010' })).ok === true && auth.plzFehler('1010') === '', 'Liefergebiet „Deutschland und Österreich“: PLZ 1010 (4 Ziffern) gilt');
  await setze({ shop: { liefergebiet: 'Deutschland' } });
  P.setPricing((await req('GET', '/api/pricing')).json);

  console.log('3) Konto-Adresse');
  const reg = await req('POST', '/api/auth/register', { name: 'Konto Tester', email: 'konto@example.test', password: 'geheim12345' });
  const tok = reg.json?.token;
  const xa = { 'x-auth': tok };
  const adr = async (a) => { const r = await req('POST', '/api/auth/address', a, xa); const me = await req('GET', '/api/auth/me', undefined, xa); return { status: r.status, json: r.json, address: me.json?.user?.address }; };
  let a = await adr({ street: 'Kontoweg 7', zip: 'ABCDE', city: 'Kontostadt' });
  check(a.status === 400 && a.json.feld === 'zip' && !a.address, 'PLZ „ABCDE“ → 400, nichts gespeichert', a);
  a = await adr({ street: '   ', zip: '12345', city: '' });
  check(a.status === 400 && /vollständig/.test(a.json.error) && !a.address, 'unvollständig (Straße nur Leerzeichen, Ort leer) → 400', a);
  a = await adr({ street: 'Kontoweg 7', zip: '12345', city: 'Kontostadt' });
  check(a.status === 200 && a.address?.zip === '12345', 'vollständige Adresse → gespeichert', a);
  a = await adr({ street: '', zip: '', city: '' });
  check(a.status === 200 && a.address?.street === '' && a.address?.zip === '', 'alle Felder leer → Adresse entfernt', a);
  check((await req('POST', '/api/auth/address', { street: 'X 1', zip: '12345', city: 'Y' })).status === 401, 'ohne Anmeldung → 401');

  console.log('4) Aktion: Rechnung und Mail mit dem Bezugspreis der Kasse');
  const pruefeAktion = async (titel, items) => {
    const pr = (await req('GET', '/api/pricing')).json;
    P.setPricing(pr); P.setColors((await req('GET', '/api/colors')).json);
    const kasseZeilen = items.map((it) => P.linePrice(it));
    const b = await bestelle(items);
    check(!!b.complete?.ok, `${titel}: Bestellung abgeschlossen`, b.fehler?.json || b.complete);
    const o = lies(b.orderId);
    const rech = beleg(b.orderId);
    check(!rech.includes('Normalpreis'), `${titel}: Rechnung ohne „Normalpreis“`);
    o.lines.forEach((l, i) => {
      const k = kasseZeilen[i];
      if (!(l.aktionProzent > 0)) { check(!('aktionRef' in l), `${titel} Zeile ${i + 1} ohne Aktion: kein aktionRef`); return; }
      const erwartet = k.lineRef != null ? { preis: k.lineRef, prozent: k.refProzent, ersparnis: k.ersparnisRef } : null;
      check(JSON.stringify(l.aktionRef) === JSON.stringify(erwartet), `${titel} Zeile ${i + 1} (${l.config.pattern}×${l.qty}): aktionRef = Kasse ${JSON.stringify(erwartet)}`, l.aktionRef);
      const text = aktionText(l, d0.settings);
      check(rech.includes(text.replace(/ /g, ' ')) && (erwartet ? text.includes(`−${erwartet.prozent} %`) : !/%/.test(text)), `${titel} Zeile ${i + 1}: Rechnung „${text}“`);
    });
    for (const ak of o.aktionen) {
      const zeilen = items.map((it, i) => [it, kasseZeilen[i]]).filter(([, k]) => k.aktionId === ak.id);
      const sum = Math.round(zeilen.reduce((s, [, k]) => s + k.ersparnisRef, 0) * 100) / 100;
      const pa = P.aktionenActive().find((x) => x.id === ak.id);
      check(near(ak.ersparnisRef, sum) && ak.prozentOk === P.aktionProzentGueltig(pa), `${titel} Aktion „${ak.name}“: Ersparnis ${ak.ersparnisRef} = Kasse ${sum}, Prozent nennen ${ak.prozentOk}`, ak);
      const zeile = aktionSummary({ aktionen: [ak] }, d0.settings)[0];
      if (sum > 0) check(!!zeile && rech.includes(zeile.value.replace(/ /g, ' ')) && zeile.label.includes('niedrigsten Preis der letzten 30 Tage') && (ak.prozentOk ? zeile.label.includes(`−${ak.prozent} %`) : !zeile.label.includes('%')), `${titel}: Ersparniszeile „${zeile?.label} ${zeile?.value}“`);
      else check(!zeile, `${titel} Aktion „${ak.name}“ ohne Bezugspreis: keine Ersparniszeile`);
    }
    return o;
  };
  const jetzt = Date.now();
  const AKT = (start) => [
    { name: 'Herbstaktion', prozent: 20, start: new Date(start).toISOString(), ende: new Date(start + 86400e3).toISOString(), produkte: 'vase', muster: ['wellen'], mengenrabatt: false, hinweis: '', aktiv: true },
    { name: 'Lamellen-Tage', prozent: 10, start: new Date(start).toISOString(), ende: new Date(start + 86400e3).toISOString(), produkte: 'vase', muster: ['lamellen'], mengenrabatt: true, hinweis: '', aktiv: true },
  ];
  const posten = [V(2, { pattern: 'wellen' }), V(2, { pattern: 'lamellen', depth: 4 }), V(1, { pattern: 'rippen' }), V(1, { pattern: 'wellen', height: 180 })];
  check((await setze({ aktionen: AKT(jetzt - 1000) })).status === 200, 'Aktionen ohne Vorgeschichte gesetzt');
  const oA = await pruefeAktion('ohne Vorlauf', posten);
  check(oA.lines.filter((l) => l.aktionProzent > 0).every((l) => l.aktionRef?.prozent >= 1) && oA.aktionen.every((x) => x.prozentOk === true && x.ersparnisRef > 0),
    'ohne Vorlauf: jede Aktionszeile mit Bezugspreis, die Aktionen dürfen ihre Prozentzahl nennen', { lines: oA.lines.map((l) => l.aktionRef), aktionen: oA.aktionen });
  // Vorlauf: eine kurze −15-%-Aktion liegt im 30-Tage-Fenster → kleinere Bezugspreise, keine Prozentzahl der Aktion
  await setze({ aktionen: [] }); await sleep(30);
  await setze({ aktionen: [{ name: 'Vorlauf', prozent: 15, start: new Date(Date.now() - 120e3).toISOString(), ende: new Date(Date.now() + 86400e3).toISOString(), produkte: 'vase', muster: [], mengenrabatt: false, hinweis: '', aktiv: true }] });
  await sleep(30); await setze({ aktionen: [] }); await sleep(30);
  await setze({ aktionen: AKT(Date.now()) });
  const oB = await pruefeAktion('nach −15-%-Vorlauf', posten);
  check(oB.aktionen.every((x) => x.prozentOk === false), 'nach Vorlauf: keine Aktion nennt ihre Prozentzahl', oB.aktionen.map((x) => x.prozentOk));
  await setze({ aktionen: [] });
  // Ältere Bestellung (ohne aktionRef/ersparnisRef): Text wie bisher
  const altL = { qty: 2, aktionProzent: 20, uvp: 24.9, aktionName: 'Herbstaktion' };
  check(aktionText(altL, d0.settings).startsWith('Normalpreis 24,90') && aktionSummary({ aktionen: [{ id: 'x', name: 'Herbstaktion', prozent: 20, ersparnis: 4.98 }] }, d0.settings)[0]?.label === 'Aktion „Herbstaktion“ −20 %: Ersparnis',
    'ältere Bestellung ohne Bezugspreis-Felder: Mail-/Rechnungstext unverändert');

  console.log('5) Danke-Angaben aus /complete');
  const bD = await bestelle([V(1)]);
  const c = bD.complete || {};
  check(c.ok && near(c.zuZahlen, lies(bD.orderId).total) && near(c.gesamtbetrag, c.zuZahlen) && c.zahlungsfristTage === 14, 'Vorkasse: zuZahlen = Rechnungsbetrag, Zahlungsfrist 14 Tage', c);
  check(c.bank?.iban === 'DE02 1203 0000 0000 2020 51' && c.bank?.verwendungszweck === bD.orderId && c.bank?.empfaenger === 'Julian Test' && c.bank?.bic === 'BYLADEM1001', 'Bankverbindung wie auf der Rechnung, Verwendungszweck = Bestellnummer', c.bank);
  const rD = beleg(bD.orderId);
  check(rD.includes('DE02 1203 0000 0000 2020 51') && rD.includes(bD.orderId), 'Rechnung nennt dieselbe IBAN und Bestellnummer');
  const nochmal = await req('POST', `/api/order/${bD.orderId}/complete`, {}, { 'x-order-key': bD.accessKey });
  check(nochmal.json?.ok && nochmal.json?.bank?.verwendungszweck === bD.orderId, 'erneuter Abschluss (Antwort verloren) liefert dieselben Angaben');
  check((await req('POST', `/api/order/${bD.orderId}/complete`, {})).status === 404, 'ohne Schlüssel keine Angaben (404)');
  await setze({ coupons: [{ code: 'GANZ', type: 'percent', value: 100, minOrder: 0, active: true, mitAktion: true }] });
  const b0 = await bestelle([V(2)], { couponCode: 'GANZ' });
  check(b0.complete?.ok && b0.complete.zuZahlen === 0 && !b0.complete.bank, '0 €: zuZahlen 0, keine Bankverbindung', b0.complete);

  console.log('6) Widerruf im Konto');
  const reg2 = await req('POST', '/api/auth/register', { name: 'Wider Ruf', email: 'widerruf@example.test', password: 'geheim12345' });
  const xa2 = { 'x-auth': reg2.json?.token };
  const bW = await bestelle([V(1)], { kunde: { email: 'widerruf@example.test', name: 'Wider Ruf' }, headers: xa2 });
  let me = await req('GET', '/api/auth/me', undefined, xa2);
  check(Array.isArray(me.json?.orders?.[0]?.widerrufe) && me.json.orders[0].widerrufe.length === 0, 'Konto: Bestellung ohne Widerruf → widerrufe []');
  const w = await req('POST', '/api/widerruf', { name: 'Wider Ruf', email: 'widerruf@example.test', orderId: bW.orderId, nachricht: '' });
  check(w.status === 200, 'Widerruf abgeschickt → 200', w.json);
  me = await req('GET', '/api/auth/me', undefined, xa2);
  const wr = me.json?.orders?.find((o) => o.orderId === bW.orderId)?.widerrufe || [];
  check(wr.length === 1 && /^WR-\d{6}-/.test(wr[0].ref) && !!Date.parse(wr[0].at) && Object.keys(wr[0]).sort().join() === 'at,ref', 'Konto zeigt den Widerruf (nur Referenz und Zeitpunkt)', wr);

  console.log('7) Kasse im HTML (Attribute, Meldezeile, Danke-Bereich)');
  const html = readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
  const tag = (id) => html.match(new RegExp(`<[^>]*id="${id}"[^>]*>`))?.[0] || '';
  check(['co-name', 'co-email', 'co-street', 'co-zip', 'co-city', 'co-note'].every((id) => /enterkeyhint="next"/.test(tag(id))) && /enterkeyhint="done"/.test(tag('co-coupon')), 'Kassenfelder mit enterkeyhint (next, Gutschein done)');
  check(/autocomplete="address-line1"/.test(tag('co-street')) && /pattern="\[0-9\]\{5\}"/.test(tag('co-zip')), 'Kasse: Straße address-line1, PLZ 5 Ziffern');
  check(/autocomplete="address-line1"/.test(tag('acc-street')) && /inputmode="numeric"/.test(tag('acc-zip')) && /autocomplete="postal-code"/.test(tag('acc-zip')) && /autocomplete="address-level2"/.test(tag('acc-city')), 'Konto-Adresse mit autocomplete/inputmode');
  check(/role="alert"/.test(tag('co-error')) && /hidden/.test(tag('co-error')) && !!tag('confirm-zahlung') && /role="alert"/.test(tag('acc-addr-err')), 'Meldezeilen #co-error/#acc-addr-err (role=alert) und Danke-Bereich #confirm-zahlung vorhanden');
  const cartJs = readFileSync(path.join(ROOT, 'public', 'js', 'cart.js'), 'utf8').split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  check(!/\balert\(/.test(cartJs.replace(/if \(text\) alert\(text\)/, '')) && /addEventListener\('keydown'/.test(cartJs) && /pay-paypal'\)\?\.checked\) return/.test(cartJs),
    'cart.js: kein alert() (außer Rückfall ohne Meldezeile), Enter abgefangen, kein Absenden bei PayPal');
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
