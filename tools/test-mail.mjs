#!/usr/bin/env node
// formsam — Prüfung Mailversand und Mail-Vorlagen (Wiederholung, Outbox, Vermerke an der Bestellung, Vorlagen-Texte)
//
//   node tools/test-mail.mjs            alles (Vorlagen + Mailer im Prozess + eigene Shop-Instanz)  → Exit 0/1
//   node tools/test-mail.mjs --schnell  ohne Shop-Instanz
//
// Die Shop-Instanz läuft mit eigenem DATA_DIR/ORDERS_DIR unter tmp-tests/test-mail/ auf einem freien Port, Mails gehen an einen
// Fake-SMTP in diesem Prozess (127.0.0.1) — es verlässt keine Mail den Rechner. Kein PayPal, keine Fremdpakete.
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { createMailer, buildMessage, smtpSend, DEFAULT_RETRY_DELAYS, asciiDomain, keepStoredPass, sameSmtpAccount } from '../lib/mailer.js';
import * as T from '../lib/mail-templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-tests', 'test-mail');
const SCHNELL = process.argv.includes('--schnell');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
function check(ok, label, detail) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); return true; }
  fail++; console.log(`❌ ${label}${detail !== undefined ? ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 600) : ''}`);
  return false;
}
const nb = (s) => String(s).replace(/ /g, ' ');

// ---------------------------------------------------------------------------
// Hilfen: MIME lesen, Fake-SMTP
// ---------------------------------------------------------------------------
function parseMime(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim(); }
  const parts = [];
  const b = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/)?.[1];
  if (b) for (const seg of body.split(`--${b}`).slice(1)) { if (seg.startsWith('--')) break; parts.push(parseMime(seg.replace(/^\r\n/, ''))); }
  return { headers, body, parts };
}
const allParts = (m) => (m.parts.length ? m.parts.flatMap(allParts) : [m]);
const qp = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
const decodeWords = (v) => String(v || '').replace(/=\?UTF-8\?B\?([^?]*)\?=(\s+(?==\?))?/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
/** { subject, from, to, replyTo, auto, text, html, attachments: [names] } aus einer rohen Mail */
function mail(raw) {
  const m = parseMime(raw);
  const ps = allParts(m);
  const t = ps.find((p) => /^text\/plain/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  const h = ps.find((p) => /^text\/html/.test(p.headers['content-type'] || '') && !p.headers['content-disposition']);
  return {
    subject: decodeWords(m.headers.subject), from: m.headers.from || '', to: m.headers.to || '', replyTo: m.headers['reply-to'] || '',
    auto: m.headers['auto-submitted'] || '', text: t ? qp(t.body) : '', html: h ? qp(h.body) : '',
    attachments: ps.filter((p) => p.headers['content-disposition']).map((p) => (p.headers['content-disposition'].match(/filename="([^"]+)"/) || [])[1]),
  };
}
function listen(srv, port = 0) { return new Promise((r, j) => { srv.once('error', j); srv.listen(port, '127.0.0.1', () => r(srv.address().port)); }); }
async function freePort() { const s = net.createServer(); const p = await listen(s); await new Promise((r) => s.close(r)); return p; }
/**
 * Fake-SMTP: nimmt jede Anmeldung an. st.greet421 = Ausfall (vorübergehend), st.failMail = n × 451 auf MAIL,
 * st.rcptReject = RegExp → 550 (endgültig), utf8 = SMTPUTF8 anbieten, injectAfterStartTls = Klartext nach „220“ (Angriff)
 */
async function fakeSmtp({ utf8 = false, tlsOpts = null, starttls = false } = {}) {
  const st = { sessions: [], greet421: false, failMail: 0, rcptReject: null, utf8, injectAfterStartTls: false };
  const socks = new Set();
  const onConn = (sock0) => {
    socks.add(sock0); sock0.on('close', () => socks.delete(sock0));
    const sess = { rcpts: [], data: null, auth: null, mailFrom: '', cmds: [] };
    st.sessions.push(sess);
    if (st.greet421) { sock0.end('421 4.3.2 Wartung\r\n'); return; }
    let sock = sock0, buf = '', inData = false, lines = [];
    const onData = (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') { inData = false; sess.data = Buffer.from(lines.join('\r\n'), 'latin1').toString('utf8'); lines = []; sock.write('250 2.0.0 ok\r\n'); } else lines.push(line.startsWith('..') ? line.slice(1) : line);
          continue;
        }
        const u = Buffer.from(line, 'latin1').toString('utf8');
        sess.cmds.push(u);
        if (/^EHLO/i.test(u)) sock.write(`250-fake\r\n${st.utf8 ? '250-SMTPUTF8\r\n' : ''}${starttls && !sock.encrypted ? '250-STARTTLS\r\n' : ''}250 AUTH PLAIN LOGIN\r\n`);
        else if (/^STARTTLS/i.test(u) && tlsOpts) {
          sock.removeListener('data', onData);
          sock.write(st.injectAfterStartTls ? '220 go\r\n250-EINGESCHLEUST\r\n250 AUTH XOAUTH-NURFAKE\r\n' : '220 go\r\n');
          const sec = new tls.TLSSocket(sock, { isServer: true, ...tlsOpts });
          sec.on('error', () => {});
          sock = sec; buf = '';
          sec.on('data', onData);
          return;
        } else if (/^AUTH PLAIN /i.test(u)) { sess.auth = Buffer.from(u.slice(11), 'base64').toString('utf8').split('\0'); sock.write('235 ok\r\n'); }
        else if (/^MAIL FROM:/i.test(u)) { sess.mailFrom = u; if (st.failMail > 0) { st.failMail--; sock.write('451 4.3.0 bitte später\r\n'); } else sock.write('250 ok\r\n'); }
        else if (/^RCPT TO:/i.test(u)) { if (st.rcptReject?.test(u)) sock.write('550 5.1.1 Postfach unbekannt\r\n'); else { sess.rcpts.push(u.slice(9).replace(/^<|>$/g, '')); sock.write('250 ok\r\n'); } }
        else if (/^DATA/i.test(u)) { inData = true; sock.write('354 los\r\n'); }
        else if (/^QUIT/i.test(u)) sock.end('221 tschüss\r\n');
        else sock.write('250 ok\r\n');
      }
    };
    sock.on('data', onData);
    sock.on('error', () => {});
    sock.write('220 fake ESMTP\r\n');
  };
  const srv = net.createServer(onConn);
  st.port = await listen(srv);
  st.close = () => new Promise((r) => { srv.close(() => r()); for (const s of socks) s.destroy(); });
  st.delivered = () => st.sessions.filter((s) => s.data).map((s) => ({ ...mail(s.data), rcpts: s.rcpts, mailFrom: s.mailFrom, raw: s.data }));
  return st;
}

// ---------------------------------------------------------------------------
// 1. Vorlagen
// ---------------------------------------------------------------------------
const SET = {
  pricing: { currency: 'EUR' },
  company: { name: 'formsam', owner: 'Julian Sendlhofer', street: 'Musterstraße 1', zip: '00000', city: 'Musterstadt', email: 'shop@example.com', kleinunternehmer: true, iban: 'DE00 1111 2222 3333 4444 55', bic: 'GENODEF1XXX', bank: 'Musterbank' },
  shop: { lieferzeit: '5–8 Werktage' }, mail: { publicUrl: 'https://formsam.example' },
};
const BASE = 'https://formsam.example';
const ORDER = (o = {}) => ({
  orderId: 'FS-261125-ABC123', accessKey: 'schluessel_123', userId: 'u-1', createdAt: '2026-11-25T09:00:00Z', status: 'neu', payment: 'vorkasse', paymentStatus: 'offen',
  customer: { name: 'Dr. Anna Schmidt', email: 'anna@example.com', street: 'Weg 1', zip: '12345', city: 'Ort' },
  lines: [{ product: 'vase', qty: 2, unit: 24.9, off: 10, line: 44.82, colorName: 'Salbei', config: { preset: 'flasche', pattern: 'rippen', height: 150 } }],
  subtotal: 44.82, coupon: null, shipping: 0, total: 44.82, invoiceNo: 'RE-2026-0001', ...o,
});
function vorlagen() {
  console.log('\n— Vorlagen');
  // Anrede ohne Titel-Unsinn
  const hallo = (name) => T.welcome({ user: { name, email: 'a@example.com' }, settings: SET, baseUrl: BASE }).text.split('\n')[0];
  check(hallo('Dr. Anna Schmidt') === 'Hallo Anna,' && hallo('Frau Erika Müller') === 'Hallo Erika,' && hallo('Familie Meier') === 'Hallo Familie Meier,' && hallo('Herr Müller') === 'Hallo Herr Müller,' &&
    hallo('Mia Müller') === 'Hallo Mia,' && hallo('') === 'Hallo!' && hallo('Gewinn-Info:http://boese.example/x') === 'Hallo!',
  'Anrede: Titel/Anreden übersprungen („Dr. Anna Schmidt“ → „Hallo Anna,“), nur Nachname → wie eingegeben, Link → „Hallo!“',
  ['Dr. Anna Schmidt', 'Frau Erika Müller', 'Familie Meier', 'Herr Müller', 'Gewinn-Info:http://x'].map(hallo));
  const grade = { 'Phil Collins': 'Phil', 'Nat King': 'Nat', 'Med Ali': 'Med', 'Herr Phil Collins': 'Phil', 'Dr. Phil Meier': 'Phil', 'Dr. med. Eva Ott': 'Eva', 'Dr. med Eva Ott': 'Eva',
    'Dr. rer. nat. Hans Meier': 'Hans', 'Prof. Dr. phil. Anna Berg': 'Anna', 'Fr. Dr.med. Eva Ott': 'Eva',
    'Dr. jur. Max Recht': 'Max', 'Dr. rer. pol. Max Geld': 'Max', 'Dr. med. dent. Anna Berg': 'Anna', 'Dr. med. vet. Lisa Hund': 'Lisa',
    'Dr. rer.nat. Hans Meier': 'Hans', 'Dr.rer.nat. Hans Meier': 'Hans', 'Dr.-Ing. Karl Kaiser': 'Karl', "Jean-Luc O'Brien": 'Jean-Luc' };
  check(Object.entries(grade).every(([n, v]) => hallo(n) === `Hallo ${v},`), 'Anrede: „Phil“, „Nat“, „Med“ als Vornamen bleiben; „Dr. phil./med./rer. nat.“ zählen als Titel',
    Object.keys(grade).map((n) => `${n} → ${hallo(n)}`).filter((x, i) => !x.endsWith(`Hallo ${Object.values(grade)[i]},`)));
  check(!/Dr\.|Anna/.test(T.welcome({ user: { name: 'Dr. Anna Schmidt' }, settings: SET, baseUrl: BASE }).subject), 'Willkommen: kein Name im Betreff');
  check(hallo('Gewinn\u2800abholen:\u2800phish.example/preis') === 'Hallo!' && hallo('Preis abholen: phish.example') === 'Hallo Preis,' && hallo('Anna2') === 'Hallo!',
    'Anrede: nur namensartige Wörter (Domain mit U+2800 statt Leerzeichen → „Hallo!“)', ['Gewinn\u2800abholen:\u2800phish.example/preis', 'Anna2'].map(hallo));
  // Bestätigung: Annahme (AGB § 3), Frist (AGB § 8), Steuerhinweis, Konto-Link, nbsp
  const b = T.orderConfirmation({ order: ORDER(), settings: SET, baseUrl: BASE });
  check(/Mit dieser Bestätigung nehme ich dein Angebot an/.test(b.text) && /nehme ich dein Angebot an/.test(b.html), 'Bestätigung: Annahmesatz wie AGB § 3');
  check(b.text.includes(`innerhalb von ${T.ZAHLUNGSFRIST_TAGE} Tagen`) && T.ZAHLUNGSFRIST_TAGE === 14 && b.html.includes('innerhalb von 14 Tagen'), 'Bestätigung (Vorkasse): Zahlungsfrist 14 Tage (lib/lieferfrist.js)');
  check(/§ 19 UStG/.test(nb(b.text)) && /§\u00a019 UStG/.test(b.html), 'Bestätigung: § 19-Hinweis bei Kleinunternehmer (geschütztes Leerzeichen)');
  const bu = T.orderConfirmation({ order: ORDER(), settings: { ...SET, company: { ...SET.company, kleinunternehmer: false } }, baseUrl: BASE });
  check(/inkl\. 19 % MwSt\./.test(nb(bu.text)) && !/§ 19/.test(nb(bu.text)), 'Bestätigung: „inkl. 19 % MwSt.“ ohne Kleinunternehmerregelung');
  check(/inkl\. 19 % MwSt/.test(nb(T.orderConfirmation({ order: ORDER({ kleinunternehmer: false }), settings: SET, baseUrl: BASE }).text)), 'Bestätigung: Steuerstand an der Bestellung (order.kleinunternehmer) geht vor die Einstellung');
  check(b.text.includes(`${BASE}/?konto`) && b.html.includes(`href="${BASE}/?konto"`), 'Bestätigung (Konto-Bestellung): Link „Mein Konto“ öffnet das Konto (?konto)');
  check(b.html.includes('Mengenrabatt −10&nbsp;%'), 'HTML: „−10&nbsp;%“ bricht nicht um');
  // Null-Betrag: keine Zahlungsaufforderung
  const z = T.orderConfirmation({ order: ORDER({ coupon: { code: 'GS-AAAA-BBBB', off: 44.82, guthaben: true }, total: 0 }), settings: SET, baseUrl: BASE });
  check(/Nichts zu zahlen – Dein Guthaben deckt den Gesamtbetrag\. Ich starte jetzt den Druck\./.test(z.text) && /<b>Nichts zu zahlen<\/b>/.test(z.html) && !/IBAN/.test(z.text) && !/sobald deine Zahlung da ist/.test(z.text) && !/innerhalb von 14 Tagen/.test(z.text), 'Bestätigung über 0 €: „Nichts zu zahlen“, keine Zahlungsaufforderung, keine IBAN, Druck ohne Warten auf Zahlung', z.text.slice(0, 900));
  // Guthaben: Summen wie auf der Rechnung (Gesamtbetrag ohne Abzug, „abzüglich Guthaben“, „Zu zahlen“); Rabatt-Gutschein vor dem Versand
  const gh = T.orderConfirmation({ order: ORDER({ coupon: { code: 'GH-AAAA-BBBB', off: 10, guthaben: true }, total: 34.82 }), settings: SET, baseUrl: BASE });
  check(/Gesamtbetrag: 44,82 €\nabzüglich Guthaben GH-AAAA-BBBB: −10,00 €\nZu zahlen: 34,82 €/.test(nb(gh.text)) && /Betrag: 34,82 €/.test(nb(gh.text)) && /den zu zahlenden Betrag/.test(gh.text) && gh.html.includes('Zu zahlen'),
    'Bestätigung mit Guthaben: Gesamtbetrag 44,82 € · abzüglich Guthaben −10,00 € · Zu zahlen 34,82 € (wie die Rechnung)', nb(gh.text).split('\n').filter((x) => /Gesamt|Guthaben|zahlen/.test(x)));
  const gr = T.orderConfirmation({ order: ORDER({ coupon: { code: 'HERBST', off: 4.48 }, total: 40.34 }), settings: SET, baseUrl: BASE });
  check(/Gutschein HERBST: −4,48 €\nVersand: kostenlos\nGesamtbetrag: 40,34 €/.test(nb(gr.text)) && !/Zu zahlen/.test(gr.text), 'Bestätigung mit Rabatt-Gutschein: Gesamtbetrag nach Gutschein, keine „Zu zahlen“-Zeile');
  // Produkthinweise (Kurzfassung wie Rechnung) und vereinbarter Wortlaut des Kassen-Häkchens (Fassung an der Bestellung)
  const ph = T.orderConfirmation({ order: ORDER({ beschaffenheitBestaetigt: '2026-11-25T09:00:00Z', beschaffenheitFassung: '2026-09-27', lines: [{ product: 'vase', qty: 1, unit: 24.9, off: 0, line: 24.9, colorName: 'Salbei', config: { preset: 'eigene', pattern: 'skelett', height: 150 } }] }), settings: SET, baseUrl: BASE });
  check(/Gut zu wissen: Jede Vase besteht aus PLA/.test(nb(ph.text)) && /Voronoi, Pos\. 1/.test(ph.text) && /Du hast in der Kasse zugestimmt: „Ich bin ausdrücklich einverstanden/.test(ph.text) && /Gut zu wissen:/.test(ph.html),
    'Bestätigung: Kurzfassung der Produkthinweise + vereinbarter Wortlaut (lib/produkthinweise.js)');
  check(!/Du hast in der Kasse zugestimmt/.test(T.orderConfirmation({ order: ORDER(), settings: SET, baseUrl: BASE }).text), 'Bestätigung ohne gespeicherte Zustimmung (Altbestand): kein Zustimmungssatz');
  // Status-Mail: Konto → Konto-Knopf, Gast → Rechnung; Text-Teil ohne Entities
  const sk = T.orderStatus({ order: ORDER({ status: 'bezahlt' }), status: 'bezahlt', settings: SET, baseUrl: BASE });
  const sg = T.orderStatus({ order: ORDER({ status: 'bezahlt', userId: null }), status: 'bezahlt', settings: SET, baseUrl: BASE });
  check(sk.text.includes(`Bestellung im Konto ansehen: ${BASE}/?konto`) && !sg.text.includes('Konto') && sg.text.includes(`Rechnung ansehen: ${BASE}/orders/FS-261125-ABC123/rechnung.html?k=schluessel_123`),
    'Status-Mail: Konto-Bestellung → „Bestellung im Konto ansehen“ (?konto), Gast → „Rechnung ansehen“ (mit Schlüssel)', sg.text.slice(0, 400));
  const sx = T.orderStatus({ order: ORDER({ status: 'bezahlt', userId: null, invoiceNo: null }), status: 'bezahlt', settings: SET, baseUrl: BASE });
  check(!/Konto|Rechnung ansehen/.test(sx.text), 'Status-Mail an Gast ohne Rechnung: kein Knopf');
  // Reklamation: Entities im Text-Teil aufgelöst, Gast ohne Konto-Knopf
  const rk = T.reklamationMail({ order: ORDER({ userId: null, reklamation: { status: 'offen', art: 'nachdruck', grund: 'Riss & "Naht" <2 mm – Tom\'s Vase', betrag: 0 } }), phase: 'angelegt', settings: SET, baseUrl: BASE });
  check(rk.text.includes('„Riss & "Naht" <2 mm – Tom\'s Vase“') && !/&amp;|&quot;|&lt;|&#39;/.test(rk.text) && rk.html.includes('Riss &amp; &quot;Naht&quot; &lt;2 mm'), 'Reklamation: Text-Teil ohne HTML-Entities, HTML weiter escaped', rk.text.match(/Notiert.*$/m)?.[0]);
  check(!/Konto/.test(rk.text) && rk.text.includes('Rechnung ansehen:'), 'Reklamation an Gast: Rechnung statt Konto');
  const fr = T.customMessage({ order: ORDER({ userId: null }), subject: 'X', text: 'Hallo', settings: SET, baseUrl: BASE });
  check(!/Konto/.test(fr.text) && /Rechnung: https/.test(fr.text), 'Freitext an Gast: Rechnungslink statt „Mein Konto“');
  // Storno: Betrag wie Stornorechnung (frühere Gutschrift abgezogen und genannt), „Stornorechnung“, kein „Design wartet“
  const so = ORDER({ status: 'storniert', paymentStatus: 'bezahlt', storno: { nr: 'GS-2026-0009', at: '2026-11-25T10:00:00Z' } });
  const s1 = T.orderStatus({ order: so, status: 'storniert', settings: SET, baseUrl: BASE, storno: { gutschrift: 10, gutschriftNo: 'GS-2026-0008' } });
  check(/erstatte ich dir zurück: 34,82 €/.test(nb(s1.text)) && /abzüglich der Gutschrift GS-2026-0008 über 10,00 €/.test(nb(s1.text)) && !/44,82 € erstatte/.test(nb(s1.text)),
    'Storno nach Teil-Gutschrift: Erstattung 34,82 € (44,82 € − 10 €), Gutschrift genannt', s1.text.match(/storniert\..*$/m)?.[0]);
  check(/Stornorechnung GS-2026-0009/.test(s1.text) && !/Stornobeleg/.test(s1.text) && !/wartet jederzeit/.test(s1.text), 'Storno: „Stornorechnung“, kein Versprechen „dein Design wartet“');
  const s2 = T.orderStatus({ order: so, status: 'storniert', settings: SET, baseUrl: BASE, storno: { gutschrift: 44.82, gutschriftNo: 'GS-2026-0008' } });
  check(/bereits vollständig zurückbekommen/.test(s2.text) && !/erstatte ich dir zurück/.test(s2.text), 'Storno nach voller Gutschrift: nichts weiter zu erstatten');
  const s3 = T.orderStatus({ order: { ...so, payment: 'paypal' }, status: 'storniert', settings: SET, baseUrl: BASE, storno: { gutschrift: 0, guthaben: { code: 'GS-AAAA-BBBB', off: 5 } } });
  check(/über PayPal zurück: 44,82 €/.test(nb(s3.text)) && /Guthaben „GS-AAAA-BBBB“ über 5,00 € steht dir wieder zur Verfügung/.test(nb(s3.text)), 'Storno PayPal ohne Gutschrift: voller Betrag, freigegebenes Guthaben genannt');
  // Status-Mails und Meldung an den Shop: Gesamtbetrag wie Rechnung/Stornorechnung — bei Guthaben vor dessen Abzug, samt beglichenem Teil
  const sgh = T.orderStatus({ order: ORDER({ status: 'storniert', coupon: { code: 'GH-AAAA-BBBB', off: 10, guthaben: true }, total: 34.82 }), status: 'storniert', settings: SET, baseUrl: BASE, storno: { gutschrift: 0, guthaben: { code: 'GH-AAAA-BBBB', off: 10 } } });
  check(/Gesamtbetrag: 44,82 € \(davon 10,00 € mit Guthaben GH-AAAA-BBBB beglichen\)/.test(nb(sgh.text)) && !/\nGesamt: /.test(sgh.text) && /Gesamtbetrag:/.test(sgh.html) && /mit Guthaben GH-AAAA-BBBB beglichen/.test(nb(sgh.html)),
    'Status-Mail mit Guthaben: „Gesamtbetrag: 44,82 € (davon 10,00 € mit Guthaben … beglichen)“ wie Rechnung/Stornorechnung', nb(sgh.text).split('\n').filter((x) => /Gesamt/.test(x)));
  const sohne = T.orderStatus({ order: ORDER({ status: 'bezahlt' }), status: 'bezahlt', settings: SET, baseUrl: BASE });
  check(/\nGesamtbetrag: 44,82 €\n/.test(nb(sohne.text)) && !/beglichen/.test(sohne.text), 'Status-Mail ohne Guthaben: „Gesamtbetrag: 44,82 €“');
  const anGh = T.adminNewOrder({ order: ORDER({ coupon: { code: 'GH-AAAA-BBBB', off: 10, guthaben: true }, total: 34.82 }), settings: SET, baseUrl: BASE });
  check(/^Gesamtbetrag 44,82 € · abzüglich Guthaben −10,00 € · zu zahlen 34,82 € · Zahlung:/m.test(nb(anGh.text)) && /Gesamtbetrag 44,82 €/.test(nb(anGh.html)) && !/^Gesamt: /m.test(anGh.text),
    'Meldung an den Shop mit Guthaben: erste Zeile Gesamtbetrag · abzüglich Guthaben · zu zahlen', nb(anGh.text).split('\n')[1]);
  // Zahlungserinnerung: 7 Tage Nachfrist ab heute, aber nie vor dem Ende der Zahlungsfrist (AGB § 8: 14 Tage nach Vertragsschluss)
  const ze = T.zahlungserinnerung({ order: ORDER({ userId: null }), settings: SET, baseUrl: BASE, heute: new Date('2026-12-20T10:00:00Z') });
  check(/Erinnerung/.test(ze.subject) && /DE00 1111 2222 3333 4444 55/.test(ze.text) && /Verwendungszweck: FS-261125-ABC123/.test(ze.text) && /bis spätestens Sonntag, 27\. Dezember 2026/.test(ze.text) &&
    /storniere ich die Bestellung \(AGB § 8\)/.test(nb(ze.text)) && /44,82 €/.test(nb(ze.text)) && /Viele Grüße/.test(ze.text), 'Zahlungserinnerung nach Ablauf der Zahlungsfrist: Betrag, Bankverbindung, Verwendungszweck, Nachfrist 7 Tage, Folge nach AGB § 8', ze.text.slice(0, 500));
  const zf = T.zahlungserinnerung({ order: ORDER({ userId: null }), settings: SET, baseUrl: BASE, heute: new Date('2026-11-25T10:00:00Z') });
  const zc = T.zahlungserinnerung({ order: ORDER({ userId: null, completedAt: '2026-11-26T08:00:00Z' }), settings: SET, baseUrl: BASE, heute: new Date('2026-12-05T10:00:00Z') });
  check(/bis spätestens Mittwoch, 9\. Dezember 2026/.test(zf.text) && !/2\. Dezember/.test(zf.text + zf.html) && /bis spätestens Samstag, 12\. Dezember 2026/.test(zc.text),
    'Zahlungserinnerung vor Ablauf der 14 Tage: nennt das Ende der Zahlungsfrist (9.12.), sonst 7 Tage ab heute (12.12.)', [zf.text.match(/bis spätestens[^:]*/)?.[0], zc.text.match(/bis spätestens[^:]*/)?.[0]]);
  check(T.zahlungsfristBis({ createdAt: '2026-11-25T09:00:00Z', completedAt: '2026-11-26T08:00:00Z' }).toISOString().slice(0, 10) === '2026-12-10' && T.zahlungsfristBis({ createdAt: '2026-11-25T09:00:00Z' }).toISOString().slice(0, 10) === '2026-12-09', 'Zahlungsfrist ab Vertragsschluss (Bestätigung = completedAt), sonst ab Bestelldatum');
  // Kalendertage nach deutschem Datum: 21.10. 00:30 MESZ (= 20.10. 22:30 UTC) + 14 Tage → 4.11. (nicht 3.11. wegen der Zeitumstellung)
  const dst = (iso) => T.zahlungserinnerung({ order: ORDER({ userId: null, completedAt: iso }), settings: SET, baseUrl: BASE, heute: new Date(iso) }).text.match(/bis spätestens ([^:]*)/)?.[1];
  check(dst('2026-10-20T22:30:00Z') === 'Mittwoch, 4. November 2026' && dst('2026-10-20T23:30:00Z') === 'Mittwoch, 4. November 2026', 'Zahlungsfrist in Kalendertagen: Bestellung kurz nach Mitternacht vor dem Ende der Sommerzeit → 4.11.', [dst('2026-10-20T22:30:00Z'), dst('2026-10-20T23:30:00Z')]);
  check(!/storniere/.test(zf.text) && /Zahlungsfrist läuft noch/.test(zf.text) && !/storniere/.test(zc.text), 'Frühe Zahlungserinnerung (Zahlungsfrist läuft noch): keine Stornoankündigung (AGB § 8: erst nach Erinnerung mit Nachfrist)');
  check(!/OVJU/i.test(Object.values({ b, sk, sg, rk, s1, ze }).map((m) => m.text + m.html + m.subject).join('')), 'Marke: kein „OVJU“');
}

// ---------------------------------------------------------------------------
// 2. Mailer im Prozess
// ---------------------------------------------------------------------------
async function mailerTests() {
  console.log('\n— Mailer: Adressen, Kopfzeilen, Fehlertexte');
  const sum = DEFAULT_RETRY_DELAYS.reduce((a, b) => a + b, 0);
  check(DEFAULT_RETRY_DELAYS.length === 6 && DEFAULT_RETRY_DELAYS.join() === [0, 60e3, 600e3, 3600e3, 21600e3, 86400e3].join() && Math.round(sum / 60e3) === 1871,
    'Wiederholung: sofort, 1 min, 10 min, 1 h, 6 h, 24 h (gut 31 Stunden)', DEFAULT_RETRY_DELAYS);
  check(asciiDomain('kunde@müller.example') === 'kunde@xn--mller-kva.example' && asciiDomain('a@b.de') === 'a@b.de' && asciiDomain('jürgen@b.de') === 'jürgen@b.de', 'IDN: Domain in Punycode, lokaler Teil unverändert');
  const m1 = buildMessage({ from: { name: 'formsam', email: 'shop@formsam.example' }, to: 'Kunde <kunde@müller.example>', subject: 'x', text: 'x' });
  check(m1.rcpts[0] === 'kunde@xn--mller-kva.example' && !m1.smtputf8 && /^To: .*xn--mller-kva\.example/m.test(m1.raw) && !/[^\x00-\x7f]/.test(m1.raw.split('\r\n\r\n')[0]), 'IDN-Domain: RCPT und To-Zeile in Punycode, Kopf rein ASCII');
  check(/^From: "formsam" <shop@formsam\.example>$/m.test(m1.raw), 'Absendername ASCII als Quoted-String (nicht base64)');
  check(buildMessage({ from: 'shop@formsam.example', to: 'jürgen@example.com', subject: 'x', text: 'x' }).smtputf8 === true, 'Umlaut vor dem @ → Nachricht braucht SMTPUTF8');
  const lang = buildMessage({ from: { name: 'x'.repeat(2000), email: 'shop@formsam.example' }, to: 'a@example.com', subject: 'x', text: 'x' });
  check(lang.raw.split('\r\n').every((l) => l.length <= 998), 'Langer Name: keine Kopfzeile über 998 Zeichen');
  // Passwort nur für denselben Zugang
  const alt = { host: 'mx.formsam.example', port: 465, secure: 'ssl', user: 'shop@formsam.example', pass: 'geheim' };
  check(keepStoredPass(alt, { ...alt, pass: '' }, '').pass === 'geheim' && keepStoredPass(alt, { ...alt, fromName: 'x' }, undefined).pass === 'geheim', 'Speichern: gleicher Zugang + leeres Feld → Passwort bleibt');
  check(!!keepStoredPass(alt, { ...alt, host: 'smtp.gmail.com' }, '').error && !!keepStoredPass(alt, { ...alt, port: 587 }, '').error && !!keepStoredPass(alt, { ...alt, user: 'x@y.de' }, '').error && !!keepStoredPass(alt, { ...alt, secure: 'none' }, '').error,
    'Speichern: anderer Host/Port/Benutzer oder unverschlüsselt + leeres Feld → Fehler „Passwort neu eingeben“');
  check(keepStoredPass(alt, { ...alt, host: 'neu.example', user: '' }, '').pass === '' && keepStoredPass(alt, { ...alt, host: 'neu.example' }, 'neu').pass === 'neu' && keepStoredPass(alt, alt, null).pass === '',
    'Speichern: ohne Benutzer kein Passwort; neues Passwort gilt; null löscht');
  check(sameSmtpAccount(alt, { ...alt, host: 'MX.formsam.example' }) && sameSmtpAccount(alt, { ...alt, secure: 'starttls' }), 'Gleicher Zugang: Groß/klein im Host egal, STARTTLS statt SSL bleibt verschlüsselt');

  const T0 = { connect: 2000, command: 1500, data: 2000 };
  const plain = await fakeSmtp();
  const cfg = (o = {}) => ({ enabled: true, host: '127.0.0.1', port: plain.port, secure: 'none', user: 'u', pass: 'p', from: 'shop@formsam.example', ...o });
  // SSL gegen Klartext-Port
  let r = await smtpSend(cfg({ secure: 'ssl' }), m1, { timeouts: T0 });
  check(!r.ok && /kein SSL\/TLS.*STARTTLS/.test(r.error) && !/routines|ssl3_|selbstsigniert/.test(r.error), 'SSL/TLS gegen Klartext-Port: verständliche Meldung (STARTTLS/587), ohne OpenSSL-Rohtext', r.error);
  // SMTPUTF8
  const mU = buildMessage({ from: 'shop@formsam.example', to: 'jürgen@example.com', subject: 'x', text: 'x' });
  r = await smtpSend(cfg(), mU, { timeouts: T0 });
  check(!r.ok && r.permanent && /Umlaute.*SMTPUTF8/.test(r.error) && !plain.sessions.at(-1).cmds.some((c) => /^RCPT/.test(c)), 'Umlaut vor dem @, Server ohne SMTPUTF8 → endgültig, klare Meldung, kein RCPT', r.error);
  plain.utf8 = true;
  r = await smtpSend(cfg(), mU, { timeouts: T0 });
  check(r.ok && / SMTPUTF8$/.test(plain.sessions.at(-1).mailFrom) && plain.sessions.at(-1).rcpts[0] === 'jürgen@example.com', 'Server mit SMTPUTF8: MAIL FROM … SMTPUTF8, Zustellung', plain.sessions.at(-1).mailFrom);
  plain.utf8 = false;

  // TLS-Fälle (Zertifikat per openssl)
  let haveOpenssl = false;
  try { execFileSync('which', ['openssl'], { stdio: 'ignore' }); haveOpenssl = true; } catch { /* kein openssl */ }
  if (haveOpenssl) {
    const cd = path.join(TMP, 'cert'); mkdirSync(cd, { recursive: true });
    const kf = path.join(cd, 'key.pem'), cf = path.join(cd, 'cert.pem');
    if (!existsSync(cf)) execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', kf, '-out', cf, '-days', '2', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const tlsOpts = { key: readFileSync(kf), cert: readFileSync(cf) };
    const st = await fakeSmtp({ tlsOpts, starttls: true });
    st.injectAfterStartTls = true;
    r = await smtpSend(cfg({ port: st.port, secure: 'starttls', allowSelfSigned: true }), m1, { timeouts: T0 });
    check(!r.ok && /Protokollfehler.*Klartext/.test(r.error) && !r.log.some((l) => /^-- TLS aktiv|^C: AUTH/.test(l)), 'STARTTLS: vor dem Handshake gepufferter Klartext → Abbruch, keine Anmeldung', r.error);
    st.injectAfterStartTls = false;
    r = await smtpSend(cfg({ port: st.port, secure: 'starttls', allowSelfSigned: true }), m1, { timeouts: T0 });
    check(r.ok && r.log.some((l) => /^-- TLS aktiv/.test(l)), 'STARTTLS ohne Einschleusung: Zustellung wie bisher');
    await st.close();
    // STARTTLS gewählt, Server spricht direkt TLS (wie Port 465) → Hinweis „SSL/TLS wählen“
    const direct = tls.createServer(tlsOpts, (s) => { s.on('error', () => {}); s.write('220 tls\r\n'); });
    const dp = await listen(direct);
    r = await smtpSend(cfg({ port: dp, secure: 'starttls' }), m1, { timeouts: { connect: 1500, command: 800, data: 800 } });
    check(!r.ok && /keine Begrüßung.*„SSL\/TLS“ wählen/.test(r.error), 'STARTTLS gegen direkten TLS-Port: Zeitüberschreitung mit Hinweis „SSL/TLS wählen“', r.error);
    direct.close();
  } else console.log('⚠️  openssl fehlt — TLS-Prüfungen übersprungen');

  console.log('\n— Mailer: Warteschlange, Outbox, Erneut');
  const dir = path.join(TMP, 'outbox');
  rmSync(dir, { recursive: true, force: true });
  const live = { mail: cfg(), company: { email: 'shop@formsam.example' } };
  const finals = [];
  const rebuilt = [];
  const att = [{ filename: 'formsam-AGB.html', content: 'A'.repeat(38000), contentType: 'text/html' }, { filename: 'formsam-Widerrufsbelehrung.html', content: 'W'.repeat(30000), contentType: 'text/html' }];
  const mk = (o = {}) => createMailer({
    dataDir: dir, getSettings: () => live, log: () => {}, timeouts: T0, unrefTimers: false, retryDelaysMs: [0, 60, 60, 60], outboxMax: 50,
    onFinal: async (e) => { finals.push(e); }, rebuildable: (e) => e.kind === 'bestaetigung',
    rebuild: async (e) => { rebuilt.push(e.id); return { to: e.to, subject: `${e.subject}`, text: 'neu erzeugt', html: '<p>neu erzeugt</p>', attachments: att }; }, ...o,
  });
  let mailer = mk();
  const msg = (o = {}) => ({ to: 'kunde@example.com', subject: 'Bestätigung', text: 'Hallo', html: '<p>Hallo</p>', kind: 'bestaetigung', ref: 'FS-1', orderId: 'FS-1', key: 'bestaetigung', ...o });
  // Ausfall über mehrere Versuche, dann wieder da → zugestellt (kein endgültiges Liegenbleiben nach 3 Versuchen)
  plain.greet421 = true;
  const q1 = await mailer.queue(msg({ subject: 'Ausfall' }));
  await sleep(150);
  check(q1.status === 'wartet' && (await mailer.list()).find((e) => e.id === q1.id).status === 'wartet', 'Ausfall: Eintrag wartet, nächster Versuch geplant');
  plain.greet421 = false;
  await mailer.whenIdle();
  let e1 = (await mailer.list()).find((e) => e.id === q1.id);
  check(e1.status === 'gesendet' && e1.attempts >= 3 && !existsSync(path.join(dir, 'mail-outbox', `${q1.id}.json`)), 'Ausfall vorbei: zugestellt, Inhalt danach gelöscht', e1);
  check(finals.some((f) => f.id === q1.id && f.status === 'gesendet' && f.orderId === 'FS-1' && f.key === 'bestaetigung'), 'onFinal meldet „gesendet“ mit Bestellbezug (orderId, key)');
  const d1 = plain.delivered().find((m) => m.subject === 'Ausfall');
  check(d1?.auto === 'auto-generated', 'Automatische Mail (queue) trägt „Auto-Submitted: auto-generated“');
  await mailer.send(msg({ subject: 'Handversand', kind: 'freitext', key: null }));
  check(plain.delivered().find((m) => m.subject === 'Handversand')?.auto === '', 'Admin-Versand (send) ohne Auto-Submitted');
  // Dauerhafter Ausfall → nach dem letzten Versuch endgültig „fehler“, onFinal + problems()
  plain.greet421 = true;
  const q2 = await mailer.queue(msg({ subject: 'Bleibt liegen' }));
  await mailer.whenIdle();
  const e2 = (await mailer.list()).find((e) => e.id === q2.id);
  check(e2.status === 'fehler' && e2.endgueltig && e2.attempts === 4 && /aufgegeben/.test(e2.error) && e2.resendable, 'Alle Versuche gescheitert → „fehler“, endgültig, Inhalt für „Erneut“ gespeichert', e2);
  check(finals.some((f) => f.id === q2.id && f.status === 'fehler'), 'onFinal meldet „fehler“');
  let pr = await mailer.problems();
  check(pr.fehler.some((e) => e.id === q2.id), 'problems(): gescheiterte Mail für die Admin-Übersicht');
  await mailer.quittieren(q2.id);
  pr = await mailer.problems();
  check(!pr.fehler.some((e) => e.id === q2.id) && (await mailer.list()).some((e) => e.id === q2.id), 'quittieren(): aus der Übersicht weg, im Protokoll bleibt sie');
  plain.greet421 = false;
  let rr = await mailer.resend(q2.id);
  check(rr.ok && plain.delivered().filter((m) => m.subject === 'Bleibt liegen').length === 1, '„Erneut“ auf gescheiterte Mail → zugestellt', rr);
  // „Jetzt senden“ während des Wartens: sofort, und der geplante Versuch entfällt (genau eine Zustellung)
  mailer.stop();
  mailer = mk({ retryDelaysMs: [0, 400, 400] });
  plain.failMail = 1;
  const q3 = await mailer.queue(msg({ subject: 'Jetzt senden' }));
  await sleep(120);
  let e3 = (await mailer.list()).find((e) => e.id === q3.id);
  rr = await mailer.resend(q3.id);
  await sleep(600);
  e3 = (await mailer.list()).find((e) => e.id === q3.id);
  check(rr.ok && e3.status === 'gesendet' && plain.delivered().filter((m) => m.subject === 'Jetzt senden').length === 1, '„Erneut“ während „wartet“: sofort zugestellt, kein zweiter Versand durch den Plan', { rr, e3 });
  // Erneut auf zugestellte Mail: neu erzeugt (Inhalt war gelöscht), als neuer Eintrag
  const vorher = (await mailer.list({ limit: 500 })).length;
  rr = await mailer.resend(q3.id);
  const nachher = await mailer.list({ limit: 500 });
  check(rr.ok && nachher.length === vorher + 1 && rebuilt.includes(q3.id) && plain.delivered().filter((m) => m.subject === 'Jetzt senden').at(-1).text.includes('neu erzeugt'), '„Erneut“ auf zugestellte Mail: neu erzeugt, neuer Protokolleintrag, zugestellt', rr);
  const fr2 = await mailer.send(msg({ subject: 'Freitext zugestellt', kind: 'freitext', key: null }));
  check((await mailer.list()).find((e) => e.id === fr2.id).resendable === false && !(await mailer.resend(fr2.id)).ok, 'Zugestellter Freitext (nicht neu erzeugbar): kein „Erneut“ (resendable false)');
  // Versand aus: Kopf/Text ohne Anhänge gespeichert, Outbox klein; nach dem Einschalten ergänzt rebuild() die Anhänge
  live.mail = cfg({ enabled: false });
  for (let i = 0; i < 40; i++) await mailer.queue(msg({ subject: `Aus ${i}`, attachments: att, html: `<p>${'x'.repeat(14000)}</p>` }));
  const idx = statSync(path.join(dir, 'mail-outbox.json')).size;
  const files = readdirSync(path.join(dir, 'mail-outbox'));
  const one = JSON.parse(readFileSync(path.join(dir, 'mail-outbox', files.at(-1)), 'utf8'));
  check(idx < 40_000 && one.attachments.length === 0 && one.anhaengeFehlen?.length === 2 && one.html.length > 14000, 'Versand aus: Outbox-Index klein, Inhalt ohne Anhänge (Namen gemerkt)', { idx, fehlen: one.anhaengeFehlen });
  const t0 = process.hrtime.bigint();
  await mailer.queue(msg({ subject: 'Zeitmessung', attachments: att }));
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  check(ms < 150, `Einreihen + Speichern bei 40 wartenden Einträgen: ${ms.toFixed(0)} ms (vorher bis 476 ms bei 500 Einträgen)`);
  live.mail = cfg();
  const aus = (await mailer.list()).find((e) => e.subject === 'Aus 0');
  rr = await mailer.resend(aus.id);
  const dAus = plain.delivered().find((m) => m.subject === 'Aus 0');
  check(rr.ok && dAus?.attachments.length === 2, '„Erneut“ nach dem Einschalten: Anhänge über rebuild() wieder dabei', dAus?.attachments);
  // Neustart: geplanter Termin bleibt, Fortsetzung ohne neues Ereignis; Altbestand (Nachricht inline) wird übernommen
  mailer.stop();
  await mailer.whenIdle();
  const file = path.join(dir, 'mail-outbox.json');
  const j = JSON.parse(readFileSync(file, 'utf8'));
  const due = Date.now() + 500;
  j.entries.push({ id: 'neustart1', to: 'kunde@example.com', subject: 'Nach Neustart', kind: 'bestaetigung', ref: 'FS-2', status: 'wartet', error: '451', createdAt: new Date().toISOString(), attempts: 2, nextAt: new Date(due).toISOString(),
    msg: { to: 'kunde@example.com', subject: 'Nach Neustart', text: 'weiter', html: '', replyTo: '', attachments: [{ filename: 'formsam-AGB.html', contentType: 'text/html', content: Buffer.from('AGB-Text').toString('base64') }] } });
  writeFileSync(file, JSON.stringify(j));
  const m2 = mk();
  await m2.resume();
  check(!('msg' in JSON.parse(readFileSync(file, 'utf8')).entries.find((e) => e.id === 'neustart1')) && existsSync(path.join(dir, 'mail-outbox', 'neustart1.json')), 'Altbestand: Nachricht aus mail-outbox.json in eine eigene Datei übernommen');
  await sleep(250);
  check(!plain.delivered().some((m) => m.subject === 'Nach Neustart'), 'Neustart: geplanter Termin wird abgewartet (nicht sofort, nicht neu ab 0)');
  await m2.whenIdle();
  const dN = plain.delivered().find((m) => m.subject === 'Nach Neustart');
  check(dN && dN.attachments[0] === 'formsam-AGB.html' && Date.now() >= due, 'Neustart: zum Termin zugestellt, mit dem gespeicherten Anhang');
  m2.stop();
  // 90-Tage-Grenze im laufenden Betrieb (hier 400 ms, Prüfung alle 100 ms): Inhalt einer gescheiterten Mail verschwindet ohne Neustart
  const dir90 = path.join(TMP, 'outbox-90');
  rmSync(dir90, { recursive: true, force: true });
  const m90 = createMailer({ dataDir: dir90, getSettings: () => ({ mail: cfg({ port: 1 }), company: {} }), log: () => {}, timeouts: T0, aufbewahrenMs: 400, pflegeMs: 100 });
  const f90 = await m90.send(msg({ subject: 'Bleibt 90 Tage', kind: 'freitext', key: null }));
  const datei90 = path.join(dir90, 'mail-outbox', `${f90.id}.json`);
  const da = existsSync(datei90);
  await sleep(800);
  const e90 = (await m90.list()).find((e) => e.id === f90.id);
  check(!f90.ok && da && !existsSync(datei90) && e90?.status === 'fehler' && e90.resendable === false, 'Aufbewahrung: Inhalt gescheiterter Mails wird auch ohne Neustart nach Ablauf gelöscht, der Protokolleintrag bleibt', { da, e90 });
  m90.stop();
  // Altbestand (Version 1): wartender Eintrag — der alte Code schrieb „→“ schon beim Einreihen → onFinal mit vermerkt (einmalig)
  const dirAlt = path.join(TMP, 'outbox-alt');
  rmSync(dirAlt, { recursive: true, force: true }); mkdirSync(dirAlt, { recursive: true });
  const altMsg = (s, to = 'kunde@example.com') => ({ to, subject: s, text: 'alt', html: '', replyTo: '', attachments: [] });
  writeFileSync(path.join(dirAlt, 'mail-outbox.json'), JSON.stringify({ version: 1, entries: [
    { id: 'altv1a', to: 'kunde@example.com', subject: 'Alt wartet', kind: 'status:bezahlt', ref: 'FS-7', status: 'wartet', error: '421', createdAt: new Date().toISOString(), attempts: 1, nextAt: new Date().toISOString(), msg: altMsg('Alt wartet') },
    { id: 'altv1b', to: 'kunde@example.com', subject: 'Alt gesendet', kind: 'status:bezahlt', ref: 'FS-8', status: 'gesendet', createdAt: new Date().toISOString(), attempts: 1 },
    { id: 'altv1c', to: 'weg@example.com', subject: 'Alt scheitert', kind: 'status:bezahlt', ref: 'FS-9', status: 'wartet', error: '421', createdAt: new Date().toISOString(), attempts: 1, nextAt: new Date().toISOString(), msg: altMsg('Alt scheitert', 'weg@example.com') },
  ] }));
  plain.rcptReject = /weg@/;
  const finAlt = [];
  const mAlt = createMailer({ dataDir: dirAlt, getSettings: () => live, log: () => {}, timeouts: T0, onFinal: async (e) => { finAlt.push(e); }, rebuildable: () => true,
    rebuild: async (e) => ({ to: e.to, subject: e.subject, text: 'neu', html: '' }) });
  await mAlt.resume();
  await mAlt.whenIdle();
  const fa = finAlt.find((f) => f.id === 'altv1a');
  check(fa?.status === 'gesendet' && fa.vermerkt === true && !JSON.parse(readFileSync(path.join(dirAlt, 'mail-outbox.json'), 'utf8')).entries.some((e) => e.vermerkt),
    'Altbestand: übernommene wartende Mail meldet „vermerkt“ (keine zweite „→“-Zeile), danach ist die Markierung weg', fa);
  const fc = finAlt.find((f) => f.id === 'altv1c');
  plain.rcptReject = null;
  await mAlt.resend('altv1c');
  const fc2 = finAlt.filter((f) => f.id === 'altv1c').at(-1);
  check(fc?.status === 'fehler' && fc.vermerkt === true && fc2 !== fc && fc2.status === 'gesendet' && fc2.vermerkt === false,
    'Altbestand gescheitert, später per „Erneut“ zugestellt: diese Zustellung wird normal vermerkt (Markierung gilt nur für den ersten Endstand)', finAlt.map((f) => [f.id, f.status, f.vermerkt]));
  mAlt.stop();
  // Beschädigtes Protokoll beim Start: beiseitegelegt, Inhalte nicht gelöscht, wartende Mails als „nicht zugestellt“ zurückgeholt
  const dirKaputt = path.join(TMP, 'outbox-kaputt');
  rmSync(dirKaputt, { recursive: true, force: true }); mkdirSync(path.join(dirKaputt, 'mail-outbox'), { recursive: true });
  const kaputtId = `${(Date.now() - 60e3).toString(36)}0a1b2c3d`;
  writeFileSync(path.join(dirKaputt, 'mail-outbox.json'), '{"version":2,"entries":[{"id":"abc","to":"kunde@exa');
  writeFileSync(path.join(dirKaputt, 'mail-outbox', `${kaputtId}.json`), JSON.stringify({ to: 'kunde@example.com', subject: 'Deine Bestellung FS-261125-ABCDEF ist eingegangen', text: 'Hallo', html: '', attachments: [] }));
  writeFileSync(path.join(dirKaputt, 'mail-outbox', 'kaputt.json'), '{"to":');
  const kaputtLog = [];
  const mK = createMailer({ dataDir: dirKaputt, getSettings: () => ({ mail: cfg({ port: 1 }), company: {} }), log: (x) => kaputtLog.push(x), timeouts: T0 });
  await mK.resume();
  const kList = await mK.list(), kDef = mK.defekt(), kDateien = readdirSync(dirKaputt);
  const kE = kList.find((e) => e.id === kaputtId);
  check(kDef?.gerettet === 1 && kDateien.some((f) => /^mail-outbox\.json\.defekt-/.test(f)) && kE?.status === 'fehler' && kE.resendable && kE.orderId === 'FS-261125-ABCDEF' && /beschädigt/.test(kE.error)
    && existsSync(path.join(dirKaputt, 'mail-outbox', `${kaputtId}.json`)) && existsSync(path.join(dirKaputt, 'mail-outbox', 'kaputt.json')) && kaputtLog.some((x) => /mail-outbox\.json beschädigt/.test(x)),
    'Protokoll beschädigt: als .defekt-… gesichert, laut gemeldet, gespeicherte Mail als „nicht zugestellt“ mit „Erneut“, kein Inhalt gelöscht', { kDef, kE, kDateien });
  check((await mK.problems()).fehler.some((e) => e.id === kaputtId), 'Protokoll beschädigt: wiederhergestellte Mail erscheint unter „nicht zugestellt“ (Admin-Übersicht)');
  mK.stop();
  const mK2 = createMailer({ dataDir: dirKaputt, getSettings: () => ({ mail: cfg({ port: 1 }), company: {} }), log: () => {}, timeouts: T0 });
  await mK2.resume();
  check(mK2.defekt() === null && (await mK2.list()).some((e) => e.id === kaputtId), 'nach dem Neustart: Protokoll wieder lesbar, wiederhergestellter Eintrag bleibt');
  mK2.stop();
  const dirLeer = path.join(TMP, 'outbox-leer');
  rmSync(dirLeer, { recursive: true, force: true }); mkdirSync(path.join(dirLeer, 'mail-outbox'), { recursive: true });
  writeFileSync(path.join(dirLeer, 'mail-outbox', 'waise.json'), '{}');
  const mL = createMailer({ dataDir: dirLeer, getSettings: () => ({ mail: cfg({ port: 1 }), company: {} }), log: () => {}, timeouts: T0 });
  await mL.resume();
  check(mL.defekt() === null && !existsSync(path.join(dirLeer, 'mail-outbox', 'waise.json')), 'fehlendes Protokoll (Neuinstallation) gilt als leer, Inhalte ohne Eintrag werden wie bisher aufgeräumt');
  mL.stop();
  // Testmail: anderer Zugang + leeres Passwortfeld → keine Anmeldung mit dem gespeicherten Passwort
  const cap = await fakeSmtp();
  live.mail = cfg({ pass: 'gespeichert' });
  let tr = await m2.test({ ...cfg(), port: cap.port, pass: '' }, 'test@example.com');
  check(!tr.ok && /Passwort eingeben/.test(tr.error) && cap.sessions.length === 0, 'Testmail an anderen Port/Host mit leerem Passwortfeld → Abbruch vor jeder Verbindung', tr.error);
  tr = await m2.test({ ...cfg(), host: 'localhost', pass: '' }, 'test@example.com');
  check(!tr.ok && /Passwort eingeben/.test(tr.error), 'Testmail an anderen Hostnamen → ebenso');
  tr = await m2.test({ ...cfg(), port: cap.port, pass: 'eingegeben' }, 'test@example.com');
  check(tr.ok && cap.sessions[0]?.auth?.[2] === 'eingegeben', 'Testmail mit eingegebenem Passwort → nutzt das eingegebene');
  tr = await m2.test({ ...cfg(), pass: '' }, 'test@example.com');
  check(tr.ok && plain.sessions.at(-1).auth?.[2] === 'gespeichert', 'Testmail mit gespeichertem Zugang + leerem Feld → gespeichertes Passwort');
  await cap.close();
  await plain.close();
}

// ---------------------------------------------------------------------------
// 3. Eigene Shop-Instanz (server.js) mit Fake-SMTP
// ---------------------------------------------------------------------------
const VASE = { product: 'vase', preset: 'flasche', height: 150, width: 1, pattern: 'rippen', ribs: 48, depth: 0.9, twist: 0, flow: 'spirale', flowWaves: 3, text: '', textSize: 7,
  textPos: 0.55, textStyle: 'gepraegt', font: 'helvetiker', customPoints: null, saucer: false, colorFinish: 'matt', color: 'elfenbein' };
function miniStl() {
  const b = Buffer.alloc(134); b.write('test-stl', 0, 'ascii'); b.writeUInt32LE(1, 80);
  [0, 0, 1, 0, 0, 0, 10, 0, 0, 0, 10, 0].forEach((v, i) => b.writeFloatLE(v, 84 + i * 4));
  return b;
}
async function shopTests() {
  console.log('\n— Shop-Instanz');
  const dir = path.join(TMP, 'shop');
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(path.join(dir, 'data'), { recursive: true }); mkdirSync(path.join(dir, 'orders'), { recursive: true });
  const smtp = await fakeSmtp();
  const port = await freePort();
  const ADMIN = 'test-mail-admin-key';
  const MAIL = { enabled: true, host: '127.0.0.1', port: smtp.port, secure: 'none', user: 'shop', pass: 'pw', from: 'shop@formsam.example', fromName: 'formsam', replyTo: 'hallo@formsam.example',
    adminTo: 'admin@formsam.example, zweit@formsam.example', adminCopy: true, autoStatusMails: true, publicUrl: `http://127.0.0.1:${port}` };
  writeFileSync(path.join(dir, 'data', 'settings.json'), JSON.stringify({
    adminKey: ADMIN, wartung: { aktiv: false }, paypal: { enabled: false, sandbox: true, clientId: '', secret: '' }, mail: MAIL,
    company: { name: 'formsam', owner: 'Test Inhaber', street: 'Teststraße 1', zip: '12345', city: 'Teststadt', country: 'Deutschland', email: 'firma@formsam.example', phone: '0123', kleinunternehmer: true,
      iban: 'DE02 1203 0000 0000 2020 51', bic: 'BYLADEM1001', bank: 'Testbank' },
  }));
  let child = null;
  const start = async () => {
    child = spawn(process.execPath, [path.join(ROOT, 'server.js')], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: path.join(dir, 'data'), ORDERS_DIR: path.join(dir, 'orders') }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', () => {}); child.stderr.on('data', (d) => { if (/Error|TypeError/.test(d)) console.log('   [server]', String(d).trim().slice(0, 300)); });
    for (let i = 0; i < 100; i++) { try { const r = await fetch(`http://127.0.0.1:${port}/api/pricing`); if (r.ok) return; } catch { /* startet noch */ } await sleep(150); }
    throw new Error('Shop startet nicht');
  };
  const stop = async () => { if (child) { child.kill('SIGTERM'); await new Promise((r) => child.once('exit', r)); child = null; } };
  const req = async (method, p, body, headers = {}) => {
    const h = { ...headers }; let data;
    if (Buffer.isBuffer(body)) { data = body; h['content-type'] = 'application/octet-stream'; } else if (body !== undefined) { data = JSON.stringify(body); h['content-type'] = 'application/json'; }
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: h, body: data });
    const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: r.status, json, text };
  };
  const admin = (method, p, body) => req(method, p, body, { 'x-admin-key': ADMIN });
  const order = (id) => JSON.parse(readFileSync(path.join(dir, 'orders', id, 'order.json'), 'utf8'));
  const mailHist = (id) => (order(id).history || []).filter((h) => h.by === 'mail').map((h) => h.note);
  const log = async () => (await admin('GET', '/api/admin/mail-log')).json?.entries || [];
  const warte = async (fn, ms = 4000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(100); } return false; };
  const delivered = () => smtp.delivered();
  async function bestellung({ name = 'Erika Muster', email = 'kunde@formsam.example', qty = 1, auth = '', abschliessen = true } = {}) {
    const items = [{ product: 'vase', qty, saucer: false, config: { ...VASE }, color: 'elfenbein', colorName: 'Elfenbein', code: null }];
    const quote = await req('POST', '/api/quote', { items, couponCode: null });
    const co = await req('POST', '/api/checkout', { customer: { name, email, street: 'Weg 1', zip: '12345', city: 'Ort', note: '' }, items, payment: 'vorkasse', paypalOrderId: null, couponCode: null,
      beschaffenheit: true, mitSchluessel: true, expectedTotal: quote.json?.total }, auth ? { 'x-auth': auth } : {});
    if (!co.json?.ok) throw new Error(`Kasse: ${co.status} ${co.text.slice(0, 200)}`);
    const { orderId, accessKey, itemCount } = co.json;
    if (!abschliessen) return { orderId, accessKey, total: co.json.total };
    for (let i = 0; i < itemCount; i++) await req('PUT', `/api/order/${orderId}/stl/${i}`, miniStl(), { 'x-order-key': accessKey });
    const c = await req('POST', `/api/order/${orderId}/complete`, {}, { 'x-order-key': accessKey });
    if (c.status !== 200) throw new Error(`Abschluss: ${c.status} ${c.text.slice(0, 200)}`);
    return { orderId, accessKey, total: co.json.total };
  }
  try {
    await start();
    // Bestellung: Bestätigung + Admin-Kopie an beide Adressen (Liste), Reply-To = Kundin, Vermerk erst nach Zustellung
    const a = await bestellung({ name: 'Frau Dr. Erika Muster', email: 'erika@formsam.example', qty: 2 });
    await warte(() => delivered().filter((m) => m.subject.includes(a.orderId)).length >= 2);
    const conf = delivered().find((m) => m.subject.includes(a.orderId) && m.rcpts[0] === 'erika@formsam.example');
    const adm = delivered().find((m) => m.subject.includes(a.orderId) && m.rcpts.includes('admin@formsam.example'));
    check(conf && /^Hallo Erika,/.test(conf.text) && /nehme ich dein Angebot an/.test(conf.text) && /innerhalb von 14 Tagen/.test(conf.text) && /§ 19 UStG/.test(nb(conf.text)) && conf.attachments.length === 2 && conf.auto === 'auto-generated',
      'Bestellung: Bestätigung mit Anrede, Annahmesatz, Frist, § 19-Hinweis, Rechtstexten, Auto-Submitted', conf?.text.slice(0, 300));
    check(adm && adm.rcpts.join() === 'admin@formsam.example,zweit@formsam.example' && /erika@formsam\.example/.test(adm.replyTo), 'Admin-Kopie an beide Adressen der Liste, Reply-To = Kundin', adm && { rcpts: adm.rcpts, replyTo: adm.replyTo });
    await warte(() => mailHist(a.orderId).length >= 1);
    check(mailHist(a.orderId).some((n) => /→ erika@formsam\.example/.test(n)) && order(a.orderId).mailsSent?.bestaetigung, 'Historie: Zustellung vermerkt, mailsSent.bestaetigung gesetzt', mailHist(a.orderId));
    // Gast: Status-Mail mit Rechnungslink statt Konto
    await admin('POST', '/api/admin/order-update', { orderId: a.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    await warte(() => delivered().some((m) => m.subject.includes(a.orderId) && /Zahlung eingegangen/.test(m.subject)));
    const bez = delivered().find((m) => m.subject.includes(a.orderId) && /Zahlung eingegangen/.test(m.subject));
    check(bez && !/Konto/.test(bez.text) && bez.text.includes(`/orders/${a.orderId}/rechnung.html?k=${a.accessKey}`), 'Gast: Status-Mail mit „Rechnung ansehen“ (Schlüssel) statt Konto-Knopf');
    // Konto: Willkommensmail, Bestellung angemeldet → „Mein Konto“ (?konto) in Bestätigung und Status-Mail
    const reg = await req('POST', '/api/auth/register', { name: 'Prof. Dr. Karl Konto', email: 'konto@formsam.example', password: 'geheim12345' });
    await warte(() => delivered().some((m) => m.rcpts[0] === 'konto@formsam.example'));
    const wm0 = delivered().find((m) => m.rcpts[0] === 'konto@formsam.example');
    check(reg.json?.ok && wm0 && /^Hallo Karl,/.test(wm0.text) && !/Karl|Prof/.test(wm0.subject), 'Registrierung: Willkommensmail „Hallo Karl,“, kein Name im Betreff', wm0?.subject);
    const k = await bestellung({ name: 'Prof. Dr. Karl Konto', email: 'konto@formsam.example', auth: reg.json?.token });
    await warte(() => delivered().some((m) => m.subject.includes(k.orderId)));
    const kc = delivered().find((m) => m.subject.includes(k.orderId) && m.rcpts[0] === 'konto@formsam.example');
    check(order(k.orderId).userId && kc && kc.text.includes(`http://127.0.0.1:${port}/?konto`), 'Konto-Bestellung: Bestätigung verlinkt „Mein Konto“ (/?konto)');
    await admin('POST', '/api/admin/order-update', { orderId: k.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    await warte(() => delivered().some((m) => m.subject.includes(k.orderId) && /Zahlung eingegangen/.test(m.subject)));
    const kb = delivered().find((m) => m.subject.includes(k.orderId) && /Zahlung eingegangen/.test(m.subject));
    check(kb && kb.text.includes(`Bestellung im Konto ansehen: http://127.0.0.1:${port}/?konto`) && !kb.text.includes('rechnung.html'), 'Konto-Bestellung: Status-Mail mit „Bestellung im Konto ansehen“');
    // adminTo ungültig: Speichern lehnt ab (400); ein Altwert aus der Zeit vor der Prüfung (direkt in settings.json) → Firmen-Adresse
    let r = await admin('POST', '/api/admin/settings', { mail: { ...MAIL, pass: '', adminTo: 'admin' } });
    check(r.status === 400 && /Admin-Adresse/.test(r.json?.error || ''), 'Speichern mit ungültiger Admin-Adresse („admin“) → 400', r.text.slice(0, 200));
    r = await admin('POST', '/api/admin/settings', { mail: { ...MAIL, pass: '' } });
    check(r.status === 200, 'Speichern mit gleichem Zugang und leerem Passwortfeld → 200', r.text.slice(0, 200));
    await stop();
    const sPfad = path.join(dir, 'data', 'settings.json'), sAlt = JSON.parse(readFileSync(sPfad, 'utf8'));
    sAlt.mail.adminTo = 'admin';
    writeFileSync(sPfad, JSON.stringify(sAlt, null, 2));
    await start();
    const b = await bestellung({ email: 'tipp@formsam.example' });
    await warte(() => delivered().some((m) => m.subject.includes(b.orderId) && m.rcpts.includes('firma@formsam.example')));
    check(delivered().some((m) => m.subject.includes(b.orderId) && m.rcpts.includes('firma@formsam.example')), 'adminTo ungültig („admin“) → Meldung an die Firmen-Adresse');
    await admin('POST', '/api/admin/settings', { mail: { ...MAIL } });
    // Speichern: anderer Host + leeres Passwortfeld → 400, nichts übernommen
    r = await admin('POST', '/api/admin/settings', { mail: { ...MAIL, host: 'localhost', pass: '' }, company: { name: 'SOLL NICHT' } });
    const sNach = (await admin('GET', '/api/admin/data')).json?.settings;
    check(r.status === 400 && /Passwort neu eingeben/.test(r.json?.error) && sNach.mail.host === '127.0.0.1' && sNach.mail.passSet && sNach.company.name !== 'SOLL NICHT', 'Speichern: Host geändert + Passwortfeld leer → 400, nichts übernommen', r.json);
    // Testmail an fremden Port mit leerem Passwortfeld → kein AUTH
    const cap = await fakeSmtp();
    r = await admin('POST', '/api/admin/mail-test', { to: 'ich@formsam.example', settings: { ...MAIL, port: cap.port, pass: '' } });
    check(!r.json?.ok && /Passwort eingeben/.test(r.json?.error) && cap.sessions.length === 0, 'Testmail an geänderten Port mit leerem Passwortfeld → keine Verbindung, kein Passwort', r.json?.error);
    await cap.close();
    // Versand aus → Status → „nicht gesendet“; einschalten → Erneut → Vermerk + mailsSent; Statuswechsel zurück → keine zweite Mail
    const c = await bestellung({ name: 'Paul Aus', email: 'aus@formsam.example' });
    await warte(() => order(c.orderId).mailsSent?.bestaetigung);
    await admin('POST', '/api/admin/settings', { mail: { ...MAIL, pass: '', enabled: false } });
    await admin('POST', '/api/admin/order-update', { orderId: c.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    await warte(() => mailHist(c.orderId).some((n) => /nicht gesendet/.test(n)));
    check(mailHist(c.orderId).some((n) => /nicht gesendet/.test(n)) && !order(c.orderId).mailsSent?.bezahlt, 'Versand aus: Historie „nicht gesendet“, mailsSent ohne „bezahlt“');
    await admin('POST', '/api/admin/settings', { mail: { ...MAIL, pass: '' } });
    const eAus = (await log()).find((e) => e.orderId === c.orderId && e.status === 'deaktiviert');
    r = await admin('POST', '/api/admin/mail-resend', { id: eAus.id });
    await warte(() => order(c.orderId).mailsSent?.bezahlt);
    check(r.json?.ok && order(c.orderId).mailsSent?.bezahlt && mailHist(c.orderId).at(-1).includes('→ aus@formsam.example'), 'Erneut nach dem Einschalten: zugestellt, Historie und mailsSent nachgezogen', mailHist(c.orderId));
    await admin('POST', '/api/admin/order-update', { orderId: c.orderId, status: 'im-druck' });
    await admin('POST', '/api/admin/order-update', { orderId: c.orderId, status: 'bezahlt' });
    await sleep(800);
    check(delivered().filter((m) => m.subject.includes(c.orderId) && /Zahlung eingegangen/.test(m.subject)).length === 1, 'Status zurück auf „bezahlt“: keine zweite „Zahlung eingegangen“-Mail');
    // Freitext wird vermerkt
    const n0 = mailHist(c.orderId).length;
    await admin('POST', '/api/admin/mail-send', { orderId: c.orderId, kind: 'freitext', subject: 'Rückfrage', text: 'Hallo' });
    check(mailHist(c.orderId).length === n0 + 1 && /Rückfrage/.test(mailHist(c.orderId).at(-1)), 'Freitext-Mail: Vermerk in der Historie');
    // Endgültig gescheitert (550): Historie, Reservierung frei, Übersicht, Ausblenden
    smtp.rcptReject = /gibtsnicht@/;
    const d = await bestellung({ email: 'gibtsnicht@formsam.example' });
    await warte(() => mailHist(d.orderId).some((n) => /nicht zugestellt/.test(n)));
    let probl = (await admin('GET', '/api/admin/mail-probleme')).json;
    const fe = probl?.fehler?.find((e) => e.orderId === d.orderId);
    check(fe && fe.endgueltig && /550/.test(fe.error) && mailHist(d.orderId).some((n) => /nicht zugestellt: .*550/.test(n)) && !order(d.orderId).mailsSent?.bestaetigung,
      'Endgültig gescheitert: in /api/admin/mail-probleme, Historie „nicht zugestellt“, mailsSent frei', { fe, h: mailHist(d.orderId) });
    await admin('POST', '/api/admin/mail-quittieren', { id: fe.id });
    probl = (await admin('GET', '/api/admin/mail-probleme')).json;
    check(!probl.fehler.some((e) => e.id === fe.id), 'Ausblenden: nicht mehr in der Übersicht');
    smtp.rcptReject = null;
    // Erneut auf zugestellte Bestätigung → neu erzeugt mit Anhängen
    const eConf = (await log()).find((e) => e.orderId === a.orderId && e.kind === 'bestaetigung');
    check(eConf?.resendable === true, 'Protokoll: zugestellte Bestätigung ist „erneut sendbar“ (wird neu erzeugt)');
    const before = delivered().length;
    r = await admin('POST', '/api/admin/mail-resend', { id: eConf.id });
    await warte(() => delivered().length > before);
    const again = delivered().at(-1);
    check(r.json?.ok && again.subject.includes(a.orderId) && again.attachments.length === 2, '„Erneut“ auf zugestellte Bestätigung: neu erzeugt, mit Rechtstexten', r.json);
    const eWill = (await log()).find((e) => e.kind === 'freitext' && e.status === 'gesendet');
    check(eWill && eWill.resendable === false, 'Zugestellter Freitext: kein „Erneut“ (Inhalt nicht aufbewahrt)');
    // Storno nach Teil-Gutschrift: Betrag wie Stornorechnung
    const s = await bestellung({ name: 'Sina Storno', email: 'storno@formsam.example', qty: 2 });
    await admin('POST', '/api/admin/order-update', { orderId: s.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    await admin('POST', '/api/admin/reklamation', { orderId: s.orderId, action: 'anlegen', art: 'ueberweisung', grund: 'Kratzer', betrag: 10, iban: 'DE89370400440532013000' });
    await admin('POST', '/api/admin/reklamation', { orderId: s.orderId, action: 'erledigen' });
    await admin('POST', '/api/admin/order-update', { orderId: s.orderId, status: 'storniert' });
    await warte(() => delivered().some((m) => m.subject.includes(s.orderId) && /storniert/.test(m.subject)));
    const sm = delivered().find((m) => m.subject.includes(s.orderId) && /storniert/.test(m.subject));
    const beleg = readFileSync(path.join(dir, 'orders', s.orderId, 'storno.html'), 'utf8');
    const belegBetrag = (beleg.match(/Stornobetrag<\/td><td class="r">−([^<]+)/) || [])[1];
    const want = (Math.round((s.total - 10) * 100) / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
    check(sm && nb(sm.text).includes(`erstatte ich dir zurück: ${nb(want)}`) && nb(belegBetrag || '') === nb(want) && /Gutschrift GS-/.test(sm.text) && /IBAN …3000/.test(sm.text),
      `Storno nach Teil-Gutschrift: Mail nennt ${nb(want)} wie die Stornorechnung, die Gutschrift und die bekannte IBAN`, sm?.text.match(/storniert\..*$/m)?.[0]);
    // Zahlungserinnerung: einmal am Tag (auch bei Doppelklick), nur offen und nur nach abgeschlossener Kasse
    const z = await bestellung({ name: 'Zora Zahlt', email: 'zora@formsam.example' });
    const zr = await Promise.all([1, 2].map(() => admin('POST', '/api/admin/mail-send', { orderId: z.orderId, kind: 'zahlungserinnerung' })));
    const zms = () => delivered().filter((m) => m.subject.includes(z.orderId) && /Erinnerung/.test(m.subject));
    check(zr.filter((x) => x.json?.ok).length === 1 && zr.filter((x) => x.status === 409 && /eine je Tag/.test(x.json?.error)).length === 1 && zms().length === 1,
      'Zahlungserinnerung: zwei gleichzeitige Anfragen (Doppelklick) → genau eine Mail, die andere 409', zr.map((x) => [x.status, x.json?.error]));
    const zm = zms()[0];
    const zo = order(z.orderId);
    const fristBis = new Date(Date.parse(zo.completedAt) + 14 * 864e5).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    check(zm && /DE02 1203 0000 0000 2020 51/.test(zm.text) && zm.text.includes(`bis spätestens ${fristBis}`) && zo.mailsSent?.zahlungserinnerung && mailHist(z.orderId).filter((n) => /Erinnerung/.test(n)).length === 1,
      `Zahlungserinnerung direkt nach der Bestellung: Frist = Ende der Zahlungsfrist (${fristBis}), vermerkt`, zm?.text.match(/bis spätestens[^:]*/)?.[0]);
    r = await admin('POST', '/api/admin/mail-send', { orderId: z.orderId, kind: 'zahlungserinnerung' });
    check(r.status === 409 && /eine je Tag/.test(r.json?.error), 'Zahlungserinnerung: weitere am selben Tag → 409', r.json);
    const ez = (await log()).find((e) => e.orderId === z.orderId && e.kind === 'zahlungserinnerung' && e.status === 'gesendet');
    r = await admin('POST', '/api/admin/mail-resend', { id: ez.id });
    check(!r.json?.ok && /eine je Tag/.test(r.json?.error) && zms().length === 1, '„Erneut“ auf die zugestellte Erinnerung am selben Tag → abgelehnt (eine je Tag)', r.json);
    const za = await bestellung({ name: 'Anton Abbruch', email: 'abbruch@formsam.example', abschliessen: false });
    const zaSend = await admin('POST', '/api/admin/mail-send', { orderId: za.orderId, kind: 'zahlungserinnerung' });
    const zaPrev = await admin('POST', '/api/admin/mail-preview', { orderId: za.orderId, kind: 'zahlungserinnerung' });
    check(zaSend.status === 400 && zaPrev.status === 400 && /nie abgeschlossen/.test(zaSend.json?.error) && !delivered().some((m) => m.subject.includes(za.orderId)),
      'Zahlungserinnerung für nie abgeschlossene Kasse → 400, keine Mail', zaSend.json);
    await admin('POST', '/api/admin/order-update', { orderId: z.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    r = await admin('POST', '/api/admin/mail-preview', { orderId: z.orderId, kind: 'zahlungserinnerung' });
    check(r.status === 400, 'Zahlungserinnerung nach Zahlung → 400');
    // „Erneut“ auf eine NICHT zugestellte Erinnerung: immer frisch erzeugt (nie der gespeicherte Inhalt) — nach Zahlung abgelehnt,
    // nach einer inzwischen zugestellten Erinnerung am selben Tag ebenfalls
    const erinnerungMails = (id) => delivered().filter((m) => m.subject.includes(id) && /Erinnerung/.test(m.subject)).length;
    const zx = await bestellung({ name: 'Xaver Später', email: 'xaver@formsam.example' });
    const zy = await bestellung({ name: 'Yvonne Zweimal', email: 'yvonne@formsam.example' });
    await warte(() => delivered().filter((m) => m.subject.includes(zx.orderId) || m.subject.includes(zy.orderId)).length >= 4);
    smtp.greet421 = true;
    const rx = await admin('POST', '/api/admin/mail-send', { orderId: zx.orderId, kind: 'zahlungserinnerung' });
    const ry = await admin('POST', '/api/admin/mail-send', { orderId: zy.orderId, kind: 'zahlungserinnerung' });
    smtp.greet421 = false;
    const fx = (await log()).find((e) => e.orderId === zx.orderId && e.kind === 'zahlungserinnerung' && e.status !== 'gesendet');
    const fy = (await log()).find((e) => e.orderId === zy.orderId && e.kind === 'zahlungserinnerung' && e.status !== 'gesendet');
    check(!rx.json?.ok && !ry.json?.ok && fx?.resendable && fy?.resendable, 'Zahlungserinnerung bei Ausfall: nicht zugestellt, „Erneut“ möglich', [rx.json, ry.json]);
    await admin('POST', '/api/admin/order-update', { orderId: zx.orderId, paymentStatus: 'bezahlt', status: 'bezahlt' });
    r = await admin('POST', '/api/admin/mail-resend', { id: fx.id });
    check(!r.json?.ok && /nur für offene Vorkasse/.test(r.json?.error || '') && erinnerungMails(zx.orderId) === 0, '„Erneut“ auf nicht zugestellte Erinnerung nach Zahlung → abgelehnt, keine Mail', r.json);
    r = await admin('POST', '/api/admin/mail-send', { orderId: zy.orderId, kind: 'zahlungserinnerung' });
    const ry2 = await admin('POST', '/api/admin/mail-resend', { id: fy.id });
    check(r.json?.ok && !ry2.json?.ok && /eine je Tag/.test(ry2.json?.error || '') && erinnerungMails(zy.orderId) === 1, '„Erneut“ auf nicht zugestellte Erinnerung, nachdem heute eine zugestellt wurde → abgelehnt (eine je Tag)', [r.json, ry2.json]);
    // IDN: Punycode-Domain; Umlaut vor dem @ ohne SMTPUTF8 → klare, endgültige Meldung
    const i1 = await bestellung({ email: 'kunde@müller.example' });
    await warte(() => delivered().some((m) => m.subject.includes(i1.orderId) && m.rcpts[0] === 'kunde@xn--mller-kva.example'));
    check(delivered().some((m) => m.subject.includes(i1.orderId) && m.rcpts[0] === 'kunde@xn--mller-kva.example'), 'IDN-Domain: RCPT in Punycode');
    // Umlaut vor dem @: die Kasse lehnt solche Adressen inzwischen ab (test-eingaben) — ältere Bestellungen können sie noch haben
    const i2 = await bestellung({ email: 'juergen@formsam.example', abschliessen: false });
    const i2Datei = path.join(dir, 'orders', i2.orderId, 'order.json');
    writeFileSync(i2Datei, JSON.stringify({ ...order(i2.orderId), customer: { ...order(i2.orderId).customer, email: 'jürgen@formsam.example' } }, null, 2));
    await req('PUT', `/api/order/${i2.orderId}/stl/0`, miniStl(), { 'x-order-key': i2.accessKey });
    await req('POST', `/api/order/${i2.orderId}/complete`, {}, { 'x-order-key': i2.accessKey });
    await warte(() => mailHist(i2.orderId).some((n) => /SMTPUTF8/.test(n)));
    check(mailHist(i2.orderId).some((n) => /nicht zugestellt: .*Umlaute.*SMTPUTF8/.test(n)), 'Umlaut vor dem @, Server ohne SMTPUTF8: „nicht zugestellt“ mit klarer Meldung', mailHist(i2.orderId));
    // Ausfall + Neustart: Stand bleibt, Inhalt (mit Anhängen) übersteht den Neustart, „Jetzt senden“ stellt zu
    smtp.greet421 = true;
    const w = await bestellung({ email: 'wartet@formsam.example' });
    await warte(async () => (await log()).some((e) => e.orderId === w.orderId && e.status === 'wartet' && e.attempts >= 1));
    const ew = (await log()).find((e) => e.orderId === w.orderId && e.kind === 'bestaetigung');
    check(ew?.status === 'wartet' && ew.nextAt && !mailHist(w.orderId).length && order(w.orderId).mailsSent?.bestaetigung, 'Ausfall: Eintrag wartet (nächster Versuch geplant), keine falsche „→“-Historie, mailsSent reserviert', { ew, h: mailHist(w.orderId) });
    probl = (await admin('GET', '/api/admin/mail-probleme')).json;
    check(probl.wartet >= 1, 'Übersicht: wartende Mails gezählt');
    await stop();
    await start();
    const ew2 = (await log()).find((e) => e.id === ew.id);
    check(ew2?.status === 'wartet' && ew2.nextAt === ew.nextAt, 'Nach Neustart: weiter „wartet“, Termin unverändert', ew2);
    smtp.greet421 = false;
    r = await admin('POST', '/api/admin/mail-resend', { id: ew.id });
    await warte(() => mailHist(w.orderId).length >= 1);
    const wm = delivered().find((m) => m.subject.includes(w.orderId) && m.rcpts[0] === 'wartet@formsam.example');
    check(r.json?.ok && wm?.attachments.length === 2 && mailHist(w.orderId).some((n) => /→ wartet@/.test(n)), '„Jetzt senden“ nach Neustart: zugestellt mit Rechtstexten, Historie nachgezogen', r.json);
    // Update von einer alten Outbox (Version 1): Der alte Code schrieb „E-Mail … →“ schon beim Einreihen; die wartende Mail wird
    // nach dem Update zugestellt → genau eine solche Zeile in der Historie
    await stop();
    const obFile = path.join(dir, 'data', 'mail-outbox.json');
    const ob = JSON.parse(readFileSync(obFile, 'utf8'));
    const jetzt = new Date().toISOString(), altSubj = `Alt: Druck startet ${b.orderId}`;
    ob.version = 1;
    ob.entries.push({ id: 'altwartet1', to: 'tipp@formsam.example', subject: altSubj, kind: 'status:im-druck', ref: b.orderId, status: 'wartet', error: '421 Wartung', createdAt: jetzt, attempts: 1, nextAt: jetzt,
      msg: { to: 'tipp@formsam.example', subject: altSubj, text: 'alt', html: '', replyTo: '', attachments: [] } });
    writeFileSync(obFile, JSON.stringify(ob));
    const ob2 = order(b.orderId);
    ob2.history.push({ at: jetzt, status: ob2.status, by: 'mail', note: `E-Mail „${altSubj}“ → tipp@formsam.example` });
    writeFileSync(path.join(dir, 'orders', b.orderId, 'order.json'), JSON.stringify(ob2, null, 2));
    await start();
    await warte(() => delivered().some((m) => m.subject === altSubj));
    await sleep(300);
    const altZeilen = mailHist(b.orderId).filter((n) => n.includes(altSubj));
    check(delivered().some((m) => m.subject === altSubj) && altZeilen.length === 1, 'Update: übernommene wartende Mail zugestellt, „E-Mail … →“ steht nur einmal in der Historie', altZeilen);
  } finally {
    await stop();
    await smtp.close();
  }
}

// ---------------------------------------------------------------------------
const t0 = Date.now();
mkdirSync(TMP, { recursive: true });
try {
  vorlagen();
  await mailerTests();
  if (!SCHNELL) await shopTests();
} catch (e) {
  fail++; console.log('❌ Abbruch:', e?.stack || e);
}
console.log(`\n${fail ? '❌' : '✅'} ${pass} bestanden, ${fail} fehlgeschlagen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
process.exit(fail ? 1 : 0);
