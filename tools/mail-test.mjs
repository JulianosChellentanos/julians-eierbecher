#!/usr/bin/env node
// mail-test.mjs — Tests & Werkzeuge für den formsam-E-Mail-Versand (lib/mailer.js, lib/mail-templates.js)
//
//   node tools/mail-test.mjs --smoke                 Fake-SMTP-Server (net/tls) → kompletter Protokoll-Test
//   node tools/mail-test.mjs --render                alle Vorlagen → tmp-tests/mail-*.html (zum Anschauen)
//   node tools/mail-test.mjs --to adresse@example.com  echte Testmail mit data/settings.json (mail-Block)
//   node tools/mail-test.mjs --serve [port]          Fake-SMTP dauerhaft (Standard 2525, ohne TLS, jede Anmeldung
//                                                    gilt) → jede Mail als tmp-tests/inbox/<n>-<zeit>.eml
//
// Exit-Code 0, wenn alle Checks bestehen, sonst 1. Große Dateien nur unter tmp-tests/ (gitignored).
import net from 'node:net';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMailer, buildMessage, smtpSend, mailSettings, baseUrlFor, quotedPrintable, encodeWord } from '../lib/mailer.js';
import * as T from '../lib/mail-templates.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TMP = path.join(ROOT, 'tmp-tests');
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const opt = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined; };

// ---------------------------------------------------------------------------
// Beispieldaten
// ---------------------------------------------------------------------------
function sampleSettings() {
  return {
    invoicePrefix: 'RE-2026-',
    pricing: { currency: 'EUR' },
    company: {
      name: 'formsam', owner: 'Julian Sendlhofer', street: 'Musterstraße 1', zip: '00000', city: 'Musterstadt', country: 'Deutschland',
      email: 'shop@example.com', phone: '', kleinunternehmer: true, iban: 'DE00 0000 0000 0000 0000 00', bic: 'GENODEF1XXX', bank: 'Musterbank',
    },
    shop: { lieferzeit: '3–5 Werktage', liefergebiet: 'Deutschland' },
    mail: { enabled: false, publicUrl: 'https://formsam.de/' },
  };
}
// Zugriffsschlüssel der Beispielbestellung (Links auf Rechnung/Gutschrift tragen ihn als ?k=)
const SAMPLE_KEY = 'q3Xv9bT0cLmN4pR7sW2y-_';
function sampleOrder(over = {}) {
  return {
    orderId: 'FS-260910-A1B2C3', accessKey: SAMPLE_KEY, userId: 'u-1', createdAt: '2026-09-10T09:12:00.000Z', status: 'neu',
    payment: 'vorkasse', paymentStatus: 'offen',
    customer: { name: 'Mia <script>alert(1)</script> Müller', email: 'mia@example.com', street: 'Wellenweg 3 & 4', zip: '22222', city: 'Flussdorf', note: 'Bitte als Geschenk verpacken :)' },
    lines: [
      {
        product: 'vase', qty: 1, saucer: false, colorName: 'Kupfer (metallic)', unit: 27.9, off: 0, line: 27.9, stlFile: 'modell-1-vase.3mf', code: 'K7M-2PQ',
        config: { product: 'vase', preset: 'flasche', pattern: 'gehaemmert', height: 150, text: 'Für Oma ❤', textStyle: 'farbe', textColor: 'perlmutt', font: 'greatvibes' },
        textColorName: 'Perlmutt',
      },
      {
        product: 'eierbecher', qty: 4, saucer: true, colorName: 'Salbei', unit: 14.8, off: 50, line: 29.6, stlFile: 'modell-2-eierbecher.stl',
        config: { product: 'eierbecher', preset: 'kelch', pattern: 'rippen', height: 58, text: 'Paul', textStyle: 'gestanzt', font: 'marcellus' },
      },
    ],
    subtotal: 57.5, coupon: { code: 'OSTERN10', off: 5.75 }, shipping: 0, total: 51.75,
    invoiceNo: 'RE-2026-0042', trackingNo: '', carrier: '', adminNote: '', ...over,
  };
}

/** Bestellung während einer Aktion (−16 % auf alles, Mengenrabatt entfällt): Zeilen mit uvp/aktionProzent/aktionBetrag, order.aktion */
function sampleAktion() {
  const o = sampleOrder({ coupon: null, aktion: { id: 'ak-test', name: 'Sommer-Sale', prozent: 16, ersparnis: 10.32 } });
  o.lines[0] = { ...o.lines[0], unit: 20.92, off: 0, line: 20.92, uvp: 24.9, aktionProzent: 16, aktionBetrag: 3.98, config: { ...o.lines[0].config, pattern: 'rippen' }, parts: { grund: 24.9 } };
  o.lines[1] = { ...o.lines[1], unit: 8.32, off: 0, line: 33.28, uvp: 9.9, aktionProzent: 16, aktionBetrag: 1.58, saucer: false, parts: { grund: 9.9 } };
  Object.assign(o, { subtotal: 54.2, shipping: 0, total: 54.2 });
  return o;
}
/**
 * Bestellung mit zwei gleichzeitig laufenden Aktionen: „Gehämmert-Woche“ −30 % nur auf Gehämmert (Vase) und
 * „Herbst“ −10 % auf alles (Eierbecher, Mengenrabatt entfällt) — order.aktionen mit Geltungsbereich, aktionName je Zeile
 */
function sampleAktionen() {
  const o = sampleOrder({
    coupon: null,
    aktionen: [
      { id: 'ak-a', name: 'Gehämmert-Woche', prozent: 30, ersparnis: 7.47, produkte: 'alle', muster: ['gehaemmert'] },
      { id: 'ak-b', name: 'Herbst', prozent: 10, ersparnis: 3.96, produkte: 'alle', muster: [] },
    ],
    aktion: { id: 'ak-a', name: 'Gehämmert-Woche', prozent: 30, ersparnis: 7.47 },
  });
  o.lines[0] = { ...o.lines[0], unit: 17.43, off: 0, line: 17.43, uvp: 24.9, aktionProzent: 30, aktionBetrag: 7.47, aktionName: 'Gehämmert-Woche', aktionId: 'ak-a', parts: { grund: 24.9 } };
  o.lines[1] = { ...o.lines[1], unit: 8.91, off: 0, line: 35.64, uvp: 9.9, aktionProzent: 10, aktionBetrag: 0.99, aktionName: 'Herbst', aktionId: 'ak-b', saucer: false, parts: { grund: 9.9 } };
  Object.assign(o, { subtotal: 53.07, shipping: 0, total: 53.07 });
  return o;
}
/** Widerruf über die Widerrufsfunktion (POST /api/widerruf) — over überschreibt Felder */
function sampleWiderruf(over = {}) {
  return {
    ref: 'WR-260927-4F2A', at: '2026-09-27T14:05:00.000Z', orderId: 'FS-260910-A1B2C3', name: 'Mia Müller', email: 'mia@example.com',
    nachricht: 'Ich möchte den Vertrag widerrufen.\nZweite Zeile & <b>', orderMatched: true, status: 'offen', notiz: '', ...over,
  };
}
/** Bestellung mit Reklamation (Standard: Gutschein, Rücksendung erwartet) — over überschreibt Felder der Reklamation */
function sampleRekla(over = {}, orderOver = {}) {
  return sampleOrder({
    reklamation: {
      status: 'ruecksendung', art: 'gutschein', grund: 'Riss im Boden der Vase', betrag: 51.75, ruecksendung: true,
      createdAt: '2026-09-12T10:00:00.000Z', updatedAt: '2026-09-12T10:00:00.000Z', ...over,
    },
    ...orderOver,
  });
}
/** Alle Reklamations-Mails (4 Phasen, erledigt je Art) — für Smoke-Test und --render */
function reklaMails(settings, baseUrl) {
  const m = (over, phase, orderOver) => T.reklamationMail({ order: sampleRekla(over, orderOver), phase, settings, baseUrl });
  return {
    'reklamation-angelegt-ruecksendung': m({}, 'angelegt'),
    'reklamation-angelegt-ohne-ruecksendung': m({ status: 'offen', art: 'ueberweisung', ruecksendung: false }, 'angelegt'),
    'reklamation-eingegangen': m({ status: 'eingegangen', note: 'Der Riss ist deutlich zu sehen — geht klar.' }, 'eingegangen'),
    'reklamation-erledigt-gutschein': m({ status: 'erledigt', gutscheinCode: 'GS-AB12-CD34', gutschriftNo: 'GS-2026-0007', resolvedAt: '2026-09-14T08:00:00.000Z' }, 'erledigt'),
    'reklamation-erledigt-ueberweisung': m({ status: 'erledigt', art: 'ueberweisung', iban: 'DE89 3704 0044 0532 0130 00', gutschriftNo: 'GS-2026-0008', resolvedAt: '2026-09-14T08:00:00.000Z' }, 'erledigt'),
    'reklamation-erledigt-paypal': m({ status: 'erledigt', art: 'paypal', refundId: '1AB23456CD789012E', gutschriftNo: 'GS-2026-0009', resolvedAt: '2026-09-14T08:00:00.000Z' }, 'erledigt', { payment: 'paypal', paymentStatus: 'bezahlt', paypalOrderId: '5O190127TN364715T' }),
    'reklamation-erledigt-nachdruck': m({ status: 'erledigt', art: 'nachdruck', resolvedAt: '2026-09-14T08:00:00.000Z' }, 'erledigt'),
    'reklamation-abgelehnt': m({ status: 'abgelehnt', note: 'Die Vase wurde laut Foto über 50 °C ausgesetzt (Spülmaschine) — das schließt die Gewährleistung leider aus.', resolvedAt: '2026-09-14T08:00:00.000Z' }, 'abgelehnt'),
  };
}

// ---------------------------------------------------------------------------
// Fake-SMTP-Server
//   opts: { user, pass, mechs: ['PLAIN','LOGIN'], mode: 'plain'|'starttls'|'ssl', key, cert,
//           silent (keine Begrüßung → Timeout), failMail (erste n MAIL FROM mit 451), splitChunks,
//           port (0 = frei), acceptAny (jede Anmeldung gilt), onMessage(session) nach jeder Nachricht }
// ---------------------------------------------------------------------------
function fakeSmtp(opts = {}) {
  const o = { user: 'werkstatt', pass: 'ganz geheim ✓', mechs: ['PLAIN', 'LOGIN'], mode: 'plain', splitChunks: true, failMail: 0, port: 0, acceptAny: false, ...opts };
  const sessions = [];
  const handler = (sock0) => {
    const s = { ehlo: null, auth: null, from: null, rcpts: [], data: null, wire: [], tls: o.mode === 'ssl', log: [] };
    sessions.push(s);
    let sock = sock0, buf = '', state = 'cmd', loginStep = null, plainPending = false;
    const dataLines = [];
    const write = (str, cb) => {
      if (o.splitChunks && str.length > 8) { sock.write(str.slice(0, 6)); setTimeout(() => sock.write(str.slice(6), cb), 4); }
      else sock.write(str, cb);
    };
    const reply = (lines, cb) => {
      const arr = Array.isArray(lines) ? lines : [lines];
      const txt = arr.map((l, i) => (i < arr.length - 1 ? l.replace(/^(\d{3}) /, '$1-') : l)).join('\r\n') + '\r\n';
      s.log.push('S: ' + txt.trim().replace(/\r\n/g, ' | '));
      write(txt, cb);
    };
    const checkAuth = (u, p) => {
      s.auth = { ...s.auth, user: u, pass: p };
      if (o.acceptAny || (u === o.user && p === o.pass)) reply('235 2.7.0 Authentifizierung erfolgreich');
      else reply('535 5.7.8 Authentifizierung fehlgeschlagen: Benutzername oder Passwort falsch');
    };
    const b64d = (x) => Buffer.from(x, 'base64').toString('utf8');
    const onLine = (line) => {
      if (state === 'data') {
        s.wire.push(line);
        if (line === '.') {
          s.data = s.wire.slice(0, -1).map((l) => (l.startsWith('..') ? l.slice(1) : l)).join('\r\n');
          state = 'cmd';
          reply(`250 2.0.0 Ok: queued as ${Date.now().toString(36)}`);
          try { o.onMessage?.(s); } catch (e) { console.error('onMessage:', e.message); }
        }
        return;
      }
      s.log.push('C: ' + line);
      if (loginStep === 'user') { s.auth = { mech: 'LOGIN', user: b64d(line) }; loginStep = 'pass'; reply('334 UGFzc3dvcmQ6'); return; }
      if (loginStep === 'pass') { loginStep = null; checkAuth(s.auth.user, b64d(line)); return; }
      if (plainPending) { plainPending = false; const [, u, p] = b64d(line).split('\0'); s.auth = { mech: 'PLAIN' }; checkAuth(u, p); return; }
      const m = line.match(/^(\S+)\s*(.*)$/);
      const verb = (m?.[1] || '').toUpperCase(), arg = m?.[2] || '';
      switch (verb) {
        case 'EHLO': {
          s.ehlo = arg;
          const lines = ['250 fake.formsam.test freut sich', '250 SIZE 10485760'];
          if (o.mode === 'starttls' && !s.tls) lines.push('250 STARTTLS');
          if (o.mechs.length) lines.push(`250 AUTH ${o.mechs.join(' ')}`);
          lines.push('250 8BITMIME');
          reply(lines); break;
        }
        case 'HELO': s.ehlo = arg; reply('250 fake.formsam.test'); break;
        case 'STARTTLS': {
          if (o.mode !== 'starttls' || s.tls) { reply('454 4.7.0 TLS nicht verfügbar'); break; }
          reply('220 2.0.0 Los geht die TLS-Aushandlung', () => {
            sock.removeAllListeners('data');
            const secure = new tls.TLSSocket(sock, { isServer: true, secureContext: tls.createSecureContext({ key: o.key, cert: o.cert }) });
            sock = secure; s.tls = true; buf = '';
            attach(secure);
          });
          break;
        }
        case 'AUTH': {
          const [mech, initial] = arg.split(/\s+/);
          if (!o.mechs.includes((mech || '').toUpperCase())) { reply('504 5.5.4 Mechanismus nicht unterstützt'); break; }
          if (mech.toUpperCase() === 'PLAIN') {
            if (!initial) { plainPending = true; reply('334 '); break; }
            const [, u, p] = b64d(initial).split('\0');
            s.auth = { mech: 'PLAIN' }; checkAuth(u, p);
          } else { loginStep = 'user'; reply('334 VXNlcm5hbWU6'); }
          break;
        }
        case 'MAIL':
          if (o.failMail > 0) { o.failMail--; reply('451 4.3.0 Vorübergehend nicht verfügbar, bitte später'); break; }
          s.from = (arg.match(/<([^>]*)>/) || [])[1] ?? arg; reply('250 2.1.0 Ok'); break;
        case 'RCPT': s.rcpts.push((arg.match(/<([^>]*)>/) || [])[1] ?? arg); reply('250 2.1.5 Ok'); break;
        case 'DATA': state = 'data'; reply('354 Ende mit <CRLF>.<CRLF>'); break;
        case 'QUIT': reply('221 2.0.0 Tschüss', () => sock.end()); break;
        case 'RSET': case 'NOOP': reply('250 2.0.0 Ok'); break;
        default: reply('500 5.5.1 Befehl unbekannt');
      }
    };
    const attach = (so) => {
      so.on('data', (d) => {
        buf += d.toString('utf8');
        let i;
        while ((i = buf.indexOf('\r\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 2); onLine(line); }
      });
      so.on('error', () => { /* Client hat abgebrochen */ });
    };
    attach(sock);
    if (!o.silent) reply(['220 fake.formsam.test ESMTP Fake-Server', '220 bereit für den Test']);
  };
  const server = o.mode === 'ssl' ? tls.createServer({ key: o.key, cert: o.cert }, handler) : net.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port, '127.0.0.1', () => resolve({
      port: server.address().port, sessions, opts: o,
      close: () => new Promise((r) => server.close(() => r())),
    }));
  });
}

// ---------------------------------------------------------------------------
// Mini-Testrahmen & Decoder
// ---------------------------------------------------------------------------
let pass = 0, fail = 0;
const check = (cond, label, extra) => {
  if (cond) { pass++; console.log(`✅ ${label}`); }
  else { fail++; console.log(`❌ ${label}${extra !== undefined ? ` — ${typeof extra === 'string' ? extra : JSON.stringify(extra)}` : ''}`); }
};
const decodeWords = (s) => String(s).replace(/\r\n[ \t]/g, '').replace(/\?=\s+=\?/g, '?==?')
  .replace(/=\?UTF-8\?B\?([A-Za-z0-9+/=]*)\?=/gi, (_, b) => Buffer.from(b, 'base64').toString('utf8'));
const nb = (s) => String(s).replace(/\u00a0/g, ' ');   // de-DE setzt U+00A0 vor „€“
const qpDecode = (s) => Buffer.from(s.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8');
function parseMime(raw) {
  const [head, ...rest] = raw.split('\r\n\r\n');
  const body = rest.join('\r\n\r\n');
  const headers = {};
  for (const line of head.replace(/\r\n[ \t]+/g, ' ').split('\r\n')) {
    const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).toLowerCase()] = line.slice(i + 1).trim();
  }
  const parts = [];
  const b = (headers['content-type'] || '').match(/boundary="?([^";]+)"?/)?.[1];
  if (b) {
    for (const seg of body.split(`--${b}`).slice(1)) {
      if (seg.startsWith('--')) break;
      parts.push(parseMime(seg.replace(/^\r\n/, '')));
    }
  }
  return { headers, body, parts };
}
const findPart = (m, type) => {
  if ((m.headers['content-type'] || '').startsWith(type)) return m;
  for (const p of m.parts) { const f = findPart(p, type); if (f) return f; }
  return null;
};

// ---------------------------------------------------------------------------
// --smoke
// ---------------------------------------------------------------------------
async function smoke() {
  mkdirSync(TMP, { recursive: true });
  const settings = sampleSettings();
  const cfgFor = (srv, over = {}) => ({ enabled: true, host: '127.0.0.1', port: srv.port, secure: 'none', user: srv.opts.user, pass: srv.opts.pass, from: 'shop@example.com', fromName: 'formsam Werkstatt ✓', ...over });
  const fastT = { connect: 2000, command: 2500 };
  const t0 = Date.now();

  // ---- 1. Vollständige Nachricht: Header, Kodierung, Dot-Stuffing, AUTH PLAIN, Mehrzeilenantworten
  console.log('\n— Nachricht & Protokoll');
  {
    const srv = await fakeSmtp();
    const text = 'Grüße aus der Werkstatt!\n.Punkt am Zeilenanfang\n..zwei Punkte\nLange Zeile: ' + 'ä'.repeat(900) + '\nEnde mit Leerzeichen \n\tTab-Zeile\n= Gleichheitszeichen =\n';
    const html = '<p>Grüße &amp; Umlaute äöü — <b>fett</b></p>\n<p>.Punkt</p>';
    const built = buildMessage({
      from: { name: 'formsam Werkstatt ✓', email: 'shop@example.com' }, to: 'Mia Müller <mia@example.com>', replyTo: 'julian@example.com',
      subject: 'Grüße & Umlaute äöü — Bestellung FS-260910-A1B2C3 ist eingegangen, vielen Dank für dein Vertrauen', text, html,
    });
    const r = await smtpSend(cfgFor(srv), built, { timeouts: fastT });
    check(r.ok, 'Versand über Fake-Server ok', r.error);
    const s = srv.sessions[0];
    check(s.ehlo && s.ehlo.length > 0, `EHLO gesendet (${s.ehlo})`);
    check(s.auth?.mech === 'PLAIN' && s.auth.user === srv.opts.user && s.auth.pass === srv.opts.pass, 'AUTH PLAIN: Benutzer/Passwort (mit Umlaut) korrekt angekommen', s.auth);
    check(s.from === 'shop@example.com' && s.rcpts.join() === 'mia@example.com', 'MAIL FROM / RCPT TO korrekt', { from: s.from, rcpts: s.rcpts });
    check(r.log.some((l) => l === 'S: 220-fake.formsam.test ESMTP Fake-Server') && r.log.some((l) => l === 'S: 220 bereit für den Test'), 'Mehrzeilige Begrüßung (220-/220 ) geparst (in Chunks gesendet)');
    check(r.log.filter((l) => l.startsWith('S: 250-')).length >= 3, 'Mehrzeilige EHLO-Antwort geparst');
    check(r.log.some((l) => l === 'C: AUTH PLAIN ****') && !r.log.some((l) => l.includes('geheim') || l.includes(Buffer.from(`\0${srv.opts.user}\0${srv.opts.pass}`).toString('base64'))), 'SMTP-Log maskiert das Passwort');
    check(s.wire.some((l) => l === '..Punkt am Zeilenanfang') && s.wire.some((l) => l === '...zwei Punkte'), 'Dot-Stuffing auf der Leitung (..Punkt / ...zwei)');
    check(!s.data.split('\r\n').some((l) => l.includes('\n')), 'Nur CRLF-Zeilenenden');
    check(s.data.split('\r\n').every((l) => l.length <= 998), 'Alle Zeilen ≤ 998 Zeichen');
    const m = parseMime(s.data);
    check(/^=\?UTF-8\?B\?/.test(m.headers.subject), 'Subject als =?UTF-8?B?…?= kodiert');
    check(decodeWords(m.headers.subject) === 'Grüße & Umlaute äöü — Bestellung FS-260910-A1B2C3 ist eingegangen, vielen Dank für dein Vertrauen', 'Subject dekodiert (mehrere Encoded-Words, gefaltet)', decodeWords(m.headers.subject));
    check(/^=\?UTF-8\?B\?[A-Za-z0-9+/=]+\?= <shop@example\.com>$/.test(m.headers.from) && decodeWords(m.headers.from) === 'formsam Werkstatt ✓ <shop@example.com>', 'From mit kodiertem Anzeigenamen', m.headers.from);
    check(decodeWords(m.headers.to) === 'Mia Müller <mia@example.com>', 'To mit Anzeigename', m.headers.to);
    check(m.headers['reply-to'] === 'julian@example.com', 'Reply-To gesetzt');
    check(/^<[^@\s<>]+@[^\s<>]+>$/.test(m.headers['message-id']) && m.headers['message-id'] === built.id, 'Message-ID vorhanden und gültig', m.headers['message-id']);
    check(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} [+-]\d{4}$/.test(m.headers.date), 'Date im RFC-5322-Format', m.headers.date);
    check(m.headers['mime-version'] === '1.0', 'MIME-Version 1.0');
    check(/^multipart\/alternative; boundary="[^"]+"$/.test(m.headers['content-type']) && m.parts.length === 2, 'multipart/alternative mit Boundary und 2 Teilen', m.headers['content-type']);
    const tp = findPart(m, 'text/plain'), hp = findPart(m, 'text/html');
    check(tp && tp.headers['content-transfer-encoding'] === 'quoted-printable' && /charset=utf-8/i.test(tp.headers['content-type']), 'Textteil: quoted-printable, UTF-8');
    const decodedText = tp ? qpDecode(tp.body.replace(/\r\n$/, '')) : '';
    check(decodedText === text.replace(/\n/g, '\r\n'), 'Textteil dekodiert exakt (Grüße, Punkte, lange Zeile, Leerzeichen/Tab am Ende, =)', decodedText.slice(0, 80));
    check(hp && qpDecode(hp.body).includes('Grüße &amp; Umlaute äöü — <b>fett</b>'), 'HTML-Teil dekodiert (Grüße)');
    check(tp.body.split('\r\n').every((l) => l.length <= 76), 'QP-Zeilen ≤ 76 Zeichen');
    await srv.close();
  }

  // ---- 2. AUTH LOGIN (Server bietet nur LOGIN)
  console.log('\n— Anmeldung');
  {
    const srv = await fakeSmtp({ mechs: ['LOGIN'] });
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'Login', text: 'x' });
    const r = await smtpSend(cfgFor(srv), built, { timeouts: fastT });
    const s = srv.sessions[0];
    check(r.ok && s.auth?.mech === 'LOGIN' && s.auth.user === srv.opts.user && s.auth.pass === srv.opts.pass, 'AUTH LOGIN: Benutzer/Passwort korrekt angekommen', r.error || s.auth);
    check(r.log.some((l) => l === 'C: **** (Passwort)') && !r.log.some((l) => l.includes(Buffer.from(srv.opts.pass).toString('base64'))), 'AUTH LOGIN im Log maskiert');
    await srv.close();
  }
  // ---- 3. Falsches Passwort → 535
  {
    const srv = await fakeSmtp();
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'x', text: 'x' });
    const r = await smtpSend(cfgFor(srv, { pass: 'falsch' }), built, { timeouts: fastT });
    check(!r.ok && /535/.test(r.error) && /Anmeldung/.test(r.error), 'Fehlerfall 535 → ok:false mit lesbarem Text', r.error);
    check(r.log.some((l) => l.startsWith('S: 535')), 'SMTP-Dialog enthält die 535-Antwort');
    await srv.close();
  }
  // ---- 4. Ohne Auth (kein user) — Server ohne AUTH
  {
    const srv = await fakeSmtp({ mechs: [] });
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'x', text: 'x' });
    const r = await smtpSend(cfgFor(srv, { user: '', pass: '' }), built, { timeouts: fastT });
    check(r.ok && srv.sessions[0].auth === null, 'Ohne Benutzername keine AUTH, Versand ok', r.error);
    await srv.close();
  }

  // ---- 5. Timeout & Verbindungsfehler
  console.log('\n— Fehlerfälle');
  {
    const srv = await fakeSmtp({ silent: true });
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'x', text: 'x' });
    const t = Date.now();
    const r = await smtpSend(cfgFor(srv), built, { timeouts: { connect: 2000, command: 400 } });
    const dt = Date.now() - t;
    check(!r.ok && /Zeitüberschreitung/.test(r.error) && dt < 2000, `Timeout-Fall: ok:false nach ${dt} ms`, r.error);
    await srv.close();
  }
  {
    const srv = await fakeSmtp(); const port = srv.port; await srv.close();
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'x', text: 'x' });
    const r = await smtpSend({ enabled: true, host: '127.0.0.1', port, secure: 'none', from: 'shop@example.com' }, built, { timeouts: fastT });
    check(!r.ok && /fehlgeschlagen/.test(r.error) && /ECONNREFUSED/.test(r.error), 'Verbindung verweigert → lesbarer Fehler', r.error);
  }
  {
    const srv = await fakeSmtp();   // bietet kein STARTTLS
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'x', text: 'x' });
    const r = await smtpSend(cfgFor(srv, { secure: 'starttls' }), built, { timeouts: fastT });
    check(!r.ok && /kein STARTTLS/.test(r.error), 'STARTTLS verlangt, Server bietet keins → klare Meldung', r.error);
    await srv.close();
  }
  {
    let err = '';
    try { buildMessage({ from: 'shop@example.com', to: 'kaputt', subject: 'x', text: 'x' }); } catch (e) { err = e.message; }
    check(/Ungültige Empfängeradresse/.test(err), 'Ungültige Empfängeradresse wird abgewiesen', err);
    try { err = ''; buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'Injektion\r\nBcc: x@y.de', text: 'x' }); } catch (e) { err = e.message; }
    check(!err, 'Zeilenumbrüche im Betreff werden neutralisiert (kein Header-Injection)');
  }

  // ---- 6. Anhang (multipart/mixed)
  console.log('\n— Anhang');
  {
    const srv = await fakeSmtp();
    const content = Buffer.from('Rechnung ÄÖÜ – Inhalt\n'.repeat(40), 'utf8');
    const built = buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'Mit Anhang', text: 'siehe Anhang', html: '<p>siehe Anhang</p>',
      attachments: [{ filename: 'Rechnung RE-2026-0042 ü.txt', content, contentType: 'text/plain; charset=utf-8' }] });
    const r = await smtpSend(cfgFor(srv), built, { timeouts: fastT });
    const m = parseMime(srv.sessions[0].data);
    const att = m.parts[1];
    check(r.ok && /^multipart\/mixed/.test(m.headers['content-type']) && m.parts.length === 2 && findPart(m.parts[0], 'text/html'), 'multipart/mixed mit alternative + Anhang');
    check(att && /attachment; filename="Rechnung RE-2026-0042 _.txt"; filename\*=UTF-8''Rechnung%20RE-2026-0042%20%C3%BC\.txt/.test(att.headers['content-disposition']), 'Anhang: Dateiname (ASCII + RFC 2231)', att?.headers['content-disposition']);
    check(att && Buffer.from(att.body.replace(/\r\n/g, ''), 'base64').equals(content) && att.body.split('\r\n').every((l) => l.length <= 76), 'Anhang base64 dekodiert identisch, Zeilen ≤ 76');
    await srv.close();
  }

  // ---- 7. TLS (STARTTLS + direktes TLS) mit selbstsigniertem Zertifikat
  console.log('\n— TLS');
  let haveOpenssl = false;
  try { execFileSync('which', ['openssl'], { stdio: 'ignore' }); haveOpenssl = true; } catch { /* kein openssl */ }
  if (haveOpenssl) {
    const certDir = path.join(TMP, 'mail-cert');
    mkdirSync(certDir, { recursive: true });
    const keyF = path.join(certDir, 'key.pem'), certF = path.join(certDir, 'cert.pem');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyF, '-out', certF, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' });
    const key = readFileSync(keyF), cert = readFileSync(certF);
    const built = () => buildMessage({ from: 'shop@example.com', to: 'a@example.com', subject: 'TLS Grüße', text: 'verschlüsselt ✓' });
    {
      const srv = await fakeSmtp({ mode: 'starttls', key, cert });
      const r = await smtpSend(cfgFor(srv, { secure: 'starttls', allowSelfSigned: true }), built(), { timeouts: fastT });
      const s = srv.sessions[0];
      check(r.ok && s.tls && s.auth?.pass === srv.opts.pass && /verschl/.test(qpDecode(findPart(parseMime(s.data), 'text/plain').body)), 'STARTTLS: Upgrade, erneutes EHLO, Auth und Nachricht über TLS', r.error);
      check(r.log.some((l) => /^-- TLS aktiv/.test(l)) && r.log.filter((l) => /^C: EHLO/.test(l)).length === 2, 'STARTTLS-Dialog: TLS-Zeile im Log, EHLO zweimal');
      const r2 = await smtpSend(cfgFor(srv, { secure: 'starttls', allowSelfSigned: false }), built(), { timeouts: fastT });
      check(!r2.ok && /Zertifikat/.test(r2.error), 'STARTTLS ohne allowSelfSigned: selbstsigniertes Zertifikat wird abgelehnt (Produktion)', r2.error);
      await srv.close();
    }
    {
      const srv = await fakeSmtp({ mode: 'ssl', key, cert });
      const r = await smtpSend(cfgFor(srv, { secure: 'ssl', allowSelfSigned: true }), built(), { timeouts: fastT });
      check(r.ok && srv.sessions[0].auth?.pass === srv.opts.pass && srv.sessions[0].data.includes('Subject:'), 'Direktes TLS (465-Modus): Versand ok', r.error);
      const r2 = await smtpSend(cfgFor(srv, { secure: 'ssl', allowSelfSigned: false }), built(), { timeouts: fastT });
      check(!r2.ok && /Zertifikat/.test(r2.error), 'Direktes TLS ohne allowSelfSigned: abgelehnt', r2.error);
      await srv.close();
    }
    rmSync(certDir, { recursive: true, force: true });
  } else {
    console.log('⚠️  openssl nicht gefunden — TLS-Tests übersprungen');
  }

  // ---- 8. Outbox-Protokoll: send / queue / retry / resend / list / Limit / Neustart
  console.log('\n— Outbox');
  {
    const dir = path.join(TMP, 'mail-outbox-test');
    rmSync(dir, { recursive: true, force: true });
    const srv = await fakeSmtp();
    const live = { ...settings, mail: { enabled: false } };
    const mailer = createMailer({ dataDir: dir, getSettings: () => live, log: () => {}, retryDelaysMs: [0, 40, 40], timeouts: fastT, outboxMax: 20, unrefTimers: false });
    const msg = (over = {}) => ({ to: 'mia@example.com', subject: 'Outbox-Test äöü', text: 'Grüße', html: '<p>Grüße</p>', kind: 'test', ref: 'FS-1', ...over });

    const d = await mailer.send(msg());
    check(!d.ok && d.error === 'E-Mail-Versand ist nicht eingerichtet' && d.id, 'Deaktiviert: ok:false + Meldung', d);
    let list = await mailer.list();
    check(list[0]?.status === 'deaktiviert' && list[0].resendable && list[0].attempts === 0, 'Eintrag „deaktiviert“ im Protokoll (mit Nachricht für späteren Versand)', list[0]);
    check(existsSync(path.join(dir, 'mail-outbox.json')) && JSON.parse(readFileSync(path.join(dir, 'mail-outbox.json'), 'utf8')).entries.length === 1, 'mail-outbox.json geschrieben');

    live.mail = cfgFor(srv);
    const ok = await mailer.send(msg({ subject: 'Sofortversand' }));
    list = await mailer.list();
    check(ok.ok && list[0].status === 'gesendet' && list[0].sentAt && list[0].attempts === 1 && !list[0].resendable && list[0].messageId, 'send(): gesendet, sentAt, Nachricht nicht mehr gespeichert', list[0]);
    const fileJson = JSON.parse(readFileSync(path.join(dir, 'mail-outbox.json'), 'utf8'));
    check(fileJson.entries.find((e) => e.id === ok.id).msg === null && fileJson.entries.find((e) => e.id === d.id).msg?.html === '<p>Grüße</p>', 'Datei: Text/HTML nur bei nicht gesendeten Einträgen');

    const r1 = await mailer.resend(d.id);
    list = await mailer.list();
    check(r1.ok && list.find((e) => e.id === d.id).status === 'gesendet', 'resend() eines deaktivierten Eintrags nach Einrichtung → gesendet', r1);
    const r2 = await mailer.resend(ok.id);
    check(!r2.ok && /nicht mehr gespeichert/.test(r2.error), 'resend() ohne gespeicherte Nachricht → klare Meldung', r2);
    check(!(await mailer.resend('gibtsnicht')).ok, 'resend() unbekannte ID → ok:false');

    srv.opts.failMail = 5;
    const f = await mailer.send(msg({ subject: 'Scheitert' }));
    list = await mailer.list();
    check(!f.ok && /451/.test(f.error) && list[0].status === 'fehler' && list[0].resendable, 'send() bei 451 → status „fehler“ mit Fehlertext, Nachricht gespeichert', list[0]);
    srv.opts.failMail = 0;
    const r3 = await mailer.resend(f.id);
    list = await mailer.list();
    check(r3.ok && list[0].status === 'gesendet' && list[0].attempts === 2, 'resend() nach Fehler → gesendet, attempts 2', list[0]);

    srv.opts.failMail = 2;
    const q = await mailer.queue(msg({ subject: 'Warteschlange mit Retry' }));
    check(q.status === 'wartet' && q.resendable, 'queue() liefert Eintrag „wartet“', q);
    await mailer.whenIdle();
    list = await mailer.list();
    const qe = list.find((e) => e.id === q.id);
    check(qe.status === 'gesendet' && qe.attempts === 3 && srv.opts.failMail === 0, 'queue(): 2 × 451, 3. Versuch gesendet (Retry-Zeiten injiziert)', qe);

    srv.opts.failMail = 99;
    const q2 = await mailer.queue(msg({ subject: 'Bleibt liegen' }));
    await mailer.whenIdle();
    list = await mailer.list();
    const q2e = list.find((e) => e.id === q2.id);
    check(q2e.status === 'fehler' && q2e.attempts === 3 && /451/.test(q2e.error) && q2e.nextAt === null && q2e.resendable, 'queue(): nach 3 Fehlversuchen „fehler“', q2e);
    srv.opts.failMail = 0;

    // „Erneut“ während der Retry-Timer läuft → abgelehnt; am Ende genau eine Zustellung
    srv.opts.failMail = 1;
    const q3 = await mailer.queue(msg({ subject: 'Erneut waehrend wartet' }));
    const rr = await mailer.resend(q3.id);
    check(q3.status === 'wartet' && !rr.ok && /läuft noch/.test(rr.error), 'resend() während „wartet“ (Zustellung läuft) → abgelehnt', rr);
    await mailer.whenIdle();
    const q3e = (await mailer.list()).find((e) => e.id === q3.id);
    const delivered = srv.sessions.filter((s) => s.data && decodeWords(parseMime(s.data).headers.subject || '') === 'Erneut waehrend wartet').length;
    check(q3e.status === 'gesendet' && q3e.attempts === 2 && delivered === 1, 'Nach dem Retry: genau eine Zustellung, attempts 2', { status: q3e.status, attempts: q3e.attempts, delivered });
    srv.opts.failMail = 0;

    // Endgültige Fehler (5xx, z. B. falsches Passwort) werden nicht wiederholt
    const oldPass = live.mail.pass;
    live.mail.pass = 'falsch';
    const q4 = await mailer.queue(msg({ subject: 'Falsches Passwort' }));
    await mailer.whenIdle();
    const q4e = (await mailer.list()).find((e) => e.id === q4.id);
    check(q4e.status === 'fehler' && q4e.attempts === 1 && /535/.test(q4e.error) && q4e.resendable, 'queue() bei 535 → sofort „fehler“ (kein Retry), Nachricht gespeichert', q4e);
    check(srv.sessions.at(-1).log.some((l) => /^C: QUIT/.test(l)), 'Nach dem Fehler wurde QUIT gesendet (kein abruptes Kappen)', srv.sessions.at(-1).log.slice(-3));
    live.mail.pass = oldPass;

    const bad = await mailer.send(msg({ to: 'keine-adresse' }));
    check(!bad.ok && /Ungültige Empfängeradresse/.test(bad.error), 'send() mit ungültiger Adresse → fehler ohne Versuch', bad);

    check(list.every((e, i) => i === 0 || e.createdAt <= list[i - 1].createdAt), 'list(): neueste zuerst');
    check(list.every((e) => !('msg' in e) && !('text' in e) && !('html' in e)), 'list(): keine Nachrichtentexte');

    for (let i = 0; i < 25; i++) await mailer.send(msg({ subject: `Massen ${i}` }));
    list = await mailer.list({ limit: 500 });
    check(list.length === 20 && list[0].subject === 'Massen 24', 'Protokoll-Limit: älteste fallen raus (outboxMax 20 im Test, 500 im Betrieb)', list.length);
    check(!existsSync(path.join(dir, `mail-outbox.json.${process.pid}.tmp`)), 'Atomares Schreiben: keine tmp-Datei zurückgeblieben');

    // Neustart: wartender Eintrag wird weiterverarbeitet
    const file = path.join(dir, 'mail-outbox.json');
    const j = JSON.parse(readFileSync(file, 'utf8'));
    j.entries.push({ id: 'resume1', to: 'mia@example.com', subject: 'Nach Neustart', kind: 'test', ref: '', status: 'wartet', error: '', createdAt: new Date().toISOString(), sentAt: null, attempts: 1, nextAt: null,
      msg: { to: 'mia@example.com', subject: 'Nach Neustart', text: 'weiter geht es', html: '', replyTo: '', attachments: [] } });
    writeFileSync(file, JSON.stringify(j));
    // dazu ein wartender Eintrag mit erschöpften Versuchen → muss beim Laden als „fehler“ auf die Platte
    j.entries.push({ id: 'resume2', to: 'mia@example.com', subject: 'Erschöpft', kind: 'test', ref: '', status: 'wartet', error: '', createdAt: new Date().toISOString(), sentAt: null, attempts: 3, nextAt: null,
      msg: { to: 'mia@example.com', subject: 'Erschöpft', text: 'x', html: '', replyTo: '', attachments: [] } });
    writeFileSync(file, JSON.stringify(j));
    const mailer2 = createMailer({ dataDir: dir, getSettings: () => live, log: () => {}, retryDelaysMs: [0, 20, 20], timeouts: fastT, outboxMax: 20, unrefTimers: false });
    const sessionsBefore = srv.sessions.length;
    await mailer2.resume();   // wie server.js nach listen() — ohne weiteres Mail-Ereignis
    await new Promise((r) => setTimeout(r, 150));
    check(srv.sessions.length > sessionsBefore, 'resume(): wartender Eintrag wird ohne weiteres Mail-Ereignis zugestellt (SMTP-Verbindung kam)');
    await mailer2.whenIdle();
    const re = (await mailer2.list()).find((e) => e.id === 'resume1');
    check(re?.status === 'gesendet' && re.attempts === 2, 'Neustart: „wartet“-Eintrag wird weiter zugestellt', re);
    const re2 = JSON.parse(readFileSync(file, 'utf8')).entries.find((e) => e.id === 'resume2');
    check(re2?.status === 'fehler' && /Neustart/.test(re2.error), 'Neustart: erschöpfter „wartet“-Eintrag steht als „fehler“ in der Datei', re2);

    // test(): Dialog + Testmail
    const tr = await mailer2.test({ host: '127.0.0.1', port: srv.port, secure: 'none', user: srv.opts.user, pass: '' }, 'julian@example.com');
    check(tr.ok && Array.isArray(tr.log) && tr.log.some((l) => /^S: 250/.test(l)) && srv.sessions.at(-1).rcpts[0] === 'julian@example.com' && srv.sessions.at(-1).auth?.pass === srv.opts.pass, 'test(): Testmail + SMTP-Dialog, leeres Passwort = gespeichertes', tr.error || tr.log.slice(-3));
    const tr2 = await mailer2.test({ host: '' }, 'x@example.com');
    check(!tr2.ok && /Host/.test(tr2.error), 'test() ohne Host → Meldung', tr2);
    check((await mailer2.list()).every((e) => e.subject !== 'formsam Testmail ✔ — der E-Mail-Versand funktioniert'), 'test() schreibt keinen Protokolleintrag');
    check(decodeWords(parseMime(srv.sessions.at(-1).data).headers.subject) === 'formsam Testmail ✔ — der E-Mail-Versand funktioniert' && /formsam-Shop/.test(qpDecode(findPart(parseMime(srv.sessions.at(-1).data), 'text/plain').body)) && !/OVJU/i.test(srv.sessions.at(-1).data), 'test(): Testmail mit formsam-Betreff und -Text, ohne alte Marke');
    check(/^X-Mailer: formsam Shop$/m.test(srv.sessions.at(-1).data) && /boundary="=_formsam_/.test(srv.sessions.at(-1).data), 'Header: X-Mailer „formsam Shop“, Boundary =_formsam_…');

    await srv.close();
    rmSync(dir, { recursive: true, force: true });
  }

  // ---- 9. Vorlagen
  console.log('\n— Vorlagen');
  {
    const baseUrl = baseUrlFor(settings);
    check(baseUrl === 'https://formsam.de', 'baseUrlFor(): publicUrl ohne Slash am Ende', baseUrl);
    check(baseUrlFor({}) === 'http://localhost:4488', 'baseUrlFor(): Fallback localhost:4488');
    const order = sampleOrder();
    const all = {
      bestaetigung: T.orderConfirmation({ order, settings, baseUrl }),
      bestaetigungPaypal: T.orderConfirmation({ order: sampleOrder({ payment: 'paypal', paymentStatus: 'bezahlt' }), settings, baseUrl }),
      willkommen: T.welcome({ user: { name: 'Mia Müller', email: 'mia@example.com' }, settings, baseUrl }),
      passwort: T.passwordReset({ user: { name: 'Mia Müller', email: 'mia@example.com' }, link: `${baseUrl}/?reset=abc123`, settings }),
      admin: T.adminNewOrder({ order, settings, baseUrl }),
      nachricht: T.customMessage({ order, subject: 'Kurze Rückfrage <zur Farbe>', text: 'Hallo Mia,\n\nwelche Farbe soll der Untersetzer haben?\nSalbei oder Kupfer?\n\nDanke & Grüße', settings, baseUrl }),
      widerruf: T.widerrufEingang({ widerruf: sampleWiderruf(), settings, baseUrl }),
      widerrufOhne: T.widerrufEingang({ widerruf: sampleWiderruf({ orderId: '', nachricht: '', orderMatched: false }), settings, baseUrl }),
      adminWiderruf: T.adminWiderruf({ widerruf: sampleWiderruf(), settings, baseUrl }),
      bestaetigungGast: T.orderConfirmation({ order: sampleOrder({ userId: null }), settings, baseUrl }),
      willkommenBestaetigen: T.welcome({ user: { name: 'Mia Müller', email: 'mia@example.com' }, settings, baseUrl, verifyLink: `${baseUrl}/?verify=vtok123` }),
      emailBestaetigung: T.emailBestaetigung({ user: { name: 'Mia Müller', email: 'mia@example.com' }, link: `${baseUrl}/?verify=vtok456`, settings, baseUrl }),
      adminPaypal: T.adminPaypalKasse({ p: { id: '5O190127TN364715T', amount: '29.80', currency: 'EUR', capturedAt: '2026-09-27T10:00:00Z', grund: 'Betrag weicht ab', erstattet: true, customer: { name: 'Mia', email: 'mia@example.com' } }, settings, baseUrl }),
    };
    for (const st of Object.keys(T.STATUS_MAIL)) {
      all[`status-${st}`] = T.orderStatus({ order: sampleOrder({ status: st, trackingNo: st === 'versendet' ? '00340434161094000000' : '', carrier: 'dhl', paymentStatus: st === 'storniert' ? 'bezahlt' : 'offen', payment: st === 'storniert' ? 'paypal' : 'vorkasse' }), status: st, settings, baseUrl });
    }
    Object.assign(all, reklaMails(settings, baseUrl));
    let allOk = true;
    for (const [k, v] of Object.entries(all)) {
      const good = v && typeof v.subject === 'string' && v.subject && typeof v.text === 'string' && (/^admin/i.test(k) ? v.text.includes('Admin:') : v.text.includes('Grüße')) && typeof v.html === 'string' && v.html.startsWith('<!DOCTYPE html>') && v.html.length < 60_000;
      if (!good) { allOk = false; console.log('   ✗', k, v?.subject); }
    }
    check(allOk, `${Object.keys(all).length} Vorlagen liefern { subject, text, html }`);
    const htmls = Object.values(all).map((v) => v.html).join('');
    check(!htmls.includes('<script>') && htmls.includes('&lt;script&gt;'), 'Kundenstrings sind HTML-escaped (<script> im Namen)');
    const imgs = htmls.match(/<img\b[^>]*>/gi) || [];
    check(imgs.length === Object.keys(all).length && imgs.every((i) => i.includes(`src="${baseUrl}/img/brand/formsam-mail.png"`) && /width="220"/.test(i) && /alt="formsam"/.test(i)) && !/<(link|script)\b/i.test(htmls) && !/url\(/i.test(htmls) && !/@import/i.test(htmls),
      'Einziges Bild je Mail: Logo von der eigenen Domain (formsam-mail.png, width=220, alt) — keine Fonts/Skripte', imgs.slice(0, 2));
    check(htmls.split('<!DOCTYPE').every((h) => /max-width:560px/.test(h) || !h) && /#f4efe7/.test(htmls) && /#fbf8f2/.test(htmls) && /#c86f4a/.test(htmls) && /Georgia/.test(htmls), 'formsam-Look: 560 px, Farben (Creme/Terrakotta), Serif-Überschriften mit Georgia-Rückfall');
    // Marke, Tonalität, Signatur, Fußzeile mit Rechtslinks
    const texts = Object.values(all).map((v) => `${v.subject}\n${v.text}`).join('\n');
    check(!/OVJU|Julians Eierbecher|Dein Design\. Dein Unikat/i.test(htmls + texts), 'Keine alte Marke (OVJU, „Julians Eierbecher“, alter Claim) in Betreff, Text oder HTML');
    check(htmls.includes(T.CLAIM) && T.CLAIM === 'Sorgsam geformt. Auf dich zugeschnitten.', 'Claim im Kopf jeder Mail');
    const kunde = Object.entries(all).filter(([k]) => !/^admin/i.test(k));
    const wirUns = kunde.map(([k, v]) => [k, `${v.text}`.replace(/wir finden gemeinsam/g, '').match(/\b(wir|uns|unser\w*)\b/gi)]).filter(([, m]) => m);
    check(!wirUns.length, 'Tonalität: Julian spricht als „ich“ (kein wir/uns/unser in Kundenmails)', wirUns);
    check(kunde.every(([, v]) => v.text.includes('Viele Grüße\nJulian von formsam') && v.html.includes('Viele Grüße<br><span style="color:#9e4f2c;">Julian von formsam</span>')), 'Signatur „Viele Grüße / Julian von formsam“ in allen Kundenmails (Text + HTML)', kunde.filter(([, v]) => !v.text.includes('Julian von formsam')).map(([k]) => k));
    const legal = ['impressum', 'datenschutz', 'agb', 'widerruf'].map((x) => `${baseUrl}/${x}`);
    check(Object.values(all).every((v) => legal.every((u) => v.html.includes(`href="${u}"`))) && kunde.every(([, v]) => legal.every((u) => v.text.includes(u))), 'Fußzeile: Impressum · Datenschutz · AGB · Widerruf (HTML aller Mails, Text der Kundenmails)');
    check(Object.values(all).every((v) => v.html.includes('formsam &nbsp;·&nbsp; Julian Sendlhofer &nbsp;·&nbsp; Musterstraße 1, 00000 Musterstadt')) && kunde.every(([, v]) => v.text.includes('— formsam · Julian Sendlhofer · Musterstraße 1, 00000 Musterstadt')), 'Fußzeile: Firmenname, Inhaber, Anschrift');
    // Signatur ohne Inhaber, Kopf ohne öffentliche Adresse, Land außerhalb Deutschlands
    const ohneInhaber = { ...settings, company: { ...settings.company, owner: '' } };
    const wo = T.welcome({ user: { name: 'Mia' }, settings: ohneInhaber, baseUrl });
    check(wo.text.includes('Viele Grüße\nformsam') && !wo.text.includes(' von formsam'), 'Signatur ohne Inhaber: nur „formsam“');
    const lokal = T.welcome({ user: { name: 'Mia' }, settings, baseUrl: 'http://localhost:4488' });
    check(!/<img\b/i.test(lokal.html) && lokal.html.includes('font-size:30px;line-height:1.1;color:#211d18;">formsam</span>') && lokal.html.includes('href="http://localhost:4488/impressum"'), 'Ohne öffentliche Adresse (localhost): Wortmarke als Text statt Bild, Links bleiben');
    const ohneUrl = T.renderLayout({ title: 'X', bodyHtml: '<p>x</p>', settings, baseUrl: '' });
    check(!/<img\b/i.test(ohneUrl) && !/href="\/impressum"/.test(ohneUrl) && ohneUrl.includes('>formsam</span>'), 'Ohne baseUrl: Text-Wortmarke, keine Rechtslinks');
    const at = T.orderConfirmation({ order: sampleOrder(), settings: { ...settings, company: { ...settings.company, country: 'Österreich' } }, baseUrl });
    check(at.text.includes('Musterstraße 1, 00000 Musterstadt, Österreich'), 'Land außerhalb Deutschlands steht in der Fußzeile');
    const b = all.bestaetigung;
    check(/Hallo Mia,/.test(b.text) && /DE00 0000 0000 0000 0000 00/.test(b.text) && /Verwendungszweck: FS-260910-A1B2C3/.test(b.text) && /Zahlungseingang|Zahlung eingegangen/.test(b.text), 'Bestätigung (Vorkasse): Anrede, IBAN, Verwendungszweck, Hinweis');
    check(/Gravur „Für Oma ❤“ \(Farbschrift, Schrift Kalligrafie, Schriftfarbe Perlmutt\)/.test(b.text) && /mit Untersetzer/.test(b.text) && /Mengenrabatt −50 %/.test(b.text) && /Gutschein OSTERN10: −5,75 €/.test(nb(b.text)) && /Versand: kostenlos/.test(b.text) && /Gesamt: 51,75 €/.test(nb(b.text)), 'Bestätigung: Positionen (Gravur/Farbschrift, Untersetzer, Rabatt), Gutschein, Versand, Gesamt');
    check(b.html.includes(`href="https://formsam.de/orders/FS-260910-A1B2C3/rechnung.html?k=${SAMPLE_KEY}"`) && b.text.includes(`Rechnung: https://formsam.de/orders/FS-260910-A1B2C3/rechnung.html?k=${SAMPLE_KEY}\n`) && b.html.includes('Mein Konto'), 'Bestätigung: Rechnungslink mit Zugriffsschlüssel (?k=) + Konto-Hinweis');
    const altB = T.orderConfirmation({ order: sampleOrder({ accessKey: undefined }), settings, baseUrl });
    check(altB.text.includes('Rechnung: https://formsam.de/orders/FS-260910-A1B2C3/rechnung.html\n') && !altB.html.includes('?k='), 'Bestätigung einer Bestellung ohne Schlüssel (Altbestand): Rechnungslink wie bisher ohne ?k=');
    const mitKey = Object.entries(all).filter(([, v]) => `${v.text}${v.html}`.includes(SAMPLE_KEY)).map(([k]) => k).sort();
    check(mitKey.join() === ['bestaetigung', 'bestaetigungGast', 'bestaetigungPaypal', 'reklamation-erledigt-gutschein', 'reklamation-erledigt-paypal', 'reklamation-erledigt-ueberweisung'].join(), 'Schlüssel nur in Mails mit Beleg-Link (Bestätigung, Gutschrift) — nicht in Status-, Admin-, Freitext-Mails', mitKey);
    check(b.subject === 'Deine Bestellung FS-260910-A1B2C3 bei formsam – danke!' && all.willkommen.subject === 'Willkommen bei formsam, Mia!' && all.passwort.subject === 'Dein neues Passwort für formsam' && all.nachricht.subject === 'Kurze Rückfrage <zur Farbe>', 'Betreffzeilen mit formsam (Bestellung, Willkommen, Passwort)', [b.subject, all.willkommen.subject, all.passwort.subject]);
    check(b.text.includes('Gedruckt wird erst, wenn du bestellst – deine Stücke entstehen für dich, sobald deine Zahlung da ist.') && b.text.includes('Lieferzeit: 3–5 Werktage. Die Frist beginnt am Tag nach deinem Überweisungsauftrag an deine Bank.') && b.html.includes('Lieferzeit: 3–5 Werktage. Die Frist beginnt am Tag nach deinem Überweisungsauftrag an deine Bank.') && !/ca\. 3|ab Zahlungseingang/.test(b.text + b.html), 'Bestätigung (Vorkasse): „Gedruckt wird erst, wenn du bestellst“ + Lieferzeit aus settings.shop, Fristbeginn wie AGB § 7 (ohne „ca.“)');
    const nurVase = T.orderConfirmation({ order: sampleOrder({ payment: 'paypal', paymentStatus: 'bezahlt', lines: [sampleOrder().lines[0]] }), settings, baseUrl });
    check(nurVase.text.includes('Gedruckt wird erst, wenn du bestellst – deine Vase entsteht jetzt für dich.') && nurVase.text.includes('Lieferzeit: 3–5 Werktage. Die Frist beginnt am Tag nach Vertragsschluss, also am Tag nach deiner Bestellung.'), 'Bestätigung (PayPal, eine Vase): „deine Vase entsteht jetzt für dich“, Fristbeginn wie AGB § 7');
    const mitAnh = T.orderConfirmation({ order: sampleOrder(), settings, baseUrl, anhaenge: ['formsam-AGB.html', 'formsam-Widerrufsbelehrung.html'] });
    check(mitAnh.text.includes('Die AGB und die Widerrufsbelehrung (mit Muster-Widerrufsformular) hängen an dieser E-Mail – zum Aufbewahren: formsam-AGB.html, formsam-Widerrufsbelehrung.html.') && mitAnh.html.includes('formsam-Widerrufsbelehrung.html') && !b.text.includes('hängen an dieser E-Mail'), 'Bestätigung mit Rechtstexten im Anhang: Hinweis nur, wenn Anhänge dabei sind');
    check(T.lieferzeitText({}) === '5–8 Werktage' && T.lieferzeitText({ shop: { lieferzeit: 'eine Woche' } }) === 'eine Woche', 'lieferzeitText(): Standard und freier Text, ohne „ca.“');
    // Rechnung im Konto nur mit Konto: Gastbestellung verweist auf den Knopf in der Mail, Konto-Bestellung aufs Konto
    const g = all.bestaetigungGast;
    check(b.html.includes('dort liegt auch die Rechnung') && !g.html.includes('dort liegt auch die Rechnung') && g.html.includes('Bewahre diese E-Mail gut auf') && g.text.includes('(Link bitte aufbewahren') && /bestätigst die Adresse/.test(g.text), 'Bestätigung: „dort liegt auch die Rechnung“ nur mit Konto — Gast: Mail aufbewahren, Konto erst nach Bestätigung der Adresse');
    const w = all.willkommen, wvb = all.willkommenBestaetigen;
    check(!/deine Rechnungen/.test(w.text + w.html) && /Rechnungen zu Bestellungen, die du angemeldet aufgibst/.test(w.text) && !/Rechnungen/.test(w.html.match(/display:none[^>]*>([^<]*)/)?.[1] || ''), 'Willkommen: Rechnungen nur für angemeldete Bestellungen, Preheader ohne „Rechnungen“');
    check(wvb.html.includes('href="https://formsam.de/?verify=vtok123"') && wvb.text.includes('https://formsam.de/?verify=vtok123') && /nicht angelegt/.test(wvb.text) && !w.text.includes('verify='), 'Willkommen mit Bestätigungslink (+ Hinweis für Fremd-Registrierungen), ohne Link keiner');
    const eb = all.emailBestaetigung;
    check(eb.html.includes('href="https://formsam.de/?verify=vtok456"') && /7 Tage/.test(eb.text) && /bestätige/.test(eb.subject), 'E-Mail bestätigen: Link, Gültigkeit, Betreff');
    const sto = all['status-storniert'];
    check(sto.html.includes('Zurück zum Konfigurator') && sto.text.includes('Zurück zum Konfigurator: https://formsam.de/') && !sto.text.includes('Bestellung im Konto ansehen'), 'Status storniert: Text wie HTML-Knopf („Zurück zum Konfigurator“)');
    const stoB = T.orderStatus({ order: sampleOrder({ status: 'storniert', storno: { nr: 'GS-2026-0007', at: '2026-09-27T10:00:00Z' } }), status: 'storniert', settings, baseUrl });
    check(stoB.html.includes(`storno.html?k=${SAMPLE_KEY}`) && stoB.text.includes('Stornobeleg GS-2026-0007') && /RE-2026-0042 ist damit aufgehoben/.test(stoB.text), 'Status storniert mit Stornorechnung: Link mit Schlüssel');
    const gut = T.orderConfirmation({ order: sampleOrder({ coupon: { code: 'GS-AB12-CD34', off: 5.75, guthaben: true } }), settings, baseUrl });
    check(/Guthaben GS-AB12-CD34: −5,75 €/.test(nb(gut.text)) && !/Gutschein GS-AB12-CD34/.test(gut.text), 'Bestätigung mit Guthaben: „Guthaben“ statt „Gutschein“');
    check(/automatisch erstattet|erstattet/.test(all.adminPaypal.text) && all.adminPaypal.text.includes('5O190127TN364715T') && T.adminPaypalKasse({ p: { id: 'X', erstattet: false, fehler: 'Auth' }, settings, baseUrl }).subject.startsWith('⚠️'), 'Admin-Meldung PayPal ohne Bestellung (erstattet / bitte handeln)');
    check(/bezahlt via PayPal/.test(all.bestaetigungPaypal.text) && !/IBAN/.test(all.bestaetigungPaypal.text), 'Bestätigung (PayPal): kein Bankblock');
    const v = all['status-versendet'];
    check(v.html.includes('https://www.dhl.de/de/privatkunden/pakete-empfangen/verfolgen.html?piececode=00340434161094000000') && /Sendungsnummer \(DHL\): 00340434161094000000/.test(v.text), 'Status versendet: Sendungsnummer + DHL-Link');
    check(T.trackingUrl('hermes', 'H1') === 'https://www.myhermes.de/empfangen/sendungsverfolgung/sendungsinformation#H1' && T.trackingUrl('dpd', 'D 1').includes('/parcel/D%201') && T.trackingUrl('gls', 'G1').includes('match=G1') && T.trackingUrl('post', 'P1').includes('piececode=P1') && T.trackingUrl('sonstige', 'X') === '' && T.trackingUrl('', 'X') === '', 'trackingUrl() je Versender');
    check(/PayPal/.test(all['status-storniert'].text) && /51,75 €/.test(nb(all['status-storniert'].text)), 'Status storniert: Rückerstattungshinweis PayPal');
    check(/Foto/.test(all['status-abgeschlossen'].text), 'Status abgeschlossen: Bitte um Foto/Feedback');
    check(!T.statusMailAllowed('neu') && T.statusMailAllowed('im-druck') && T.statusMailAllowed('gedruckt') && !T.statusMailAllowed('quatsch'), 'statusMailAllowed()');
    check(all.passwort.text.includes(`${baseUrl}/?reset=abc123`) && /60 Minuten/.test(all.passwort.text), 'Passwort-Reset: Link + 60 Minuten');
    check(all.admin.html.includes(`${baseUrl}/admin`) && /Neue Bestellung FS-260910-A1B2C3 · 51,75 €/.test(nb(all.admin.subject)), 'Admin-Mail: Link zum Admin, kompakter Betreff');
    check(all.nachricht.subject === 'Kurze Rückfrage <zur Farbe>' && all.nachricht.html.includes('Kurze Rückfrage &lt;zur Farbe&gt;') && all.nachricht.html.includes('Untersetzer haben?<br>Salbei oder Kupfer?') && (all.nachricht.html.match(/<p style="margin:0 0 12px;">/g) || []).length >= 3, 'Freitext: Absätze/Umbrüche, escaped');
    const uw = T.welcome({ user: { name: '', email: 'x@example.com' }, settings, baseUrl });
    check(/^Hallo!/.test(uw.text), 'Ohne Namen: neutrale Anrede');
    // Reklamation: 4 Phasen × Arten
    const ra = all['reklamation-angelegt-ruecksendung'];
    check(/Reklamation eingegangen/.test(ra.subject) && /Musterstraße 1\n00000 Musterstadt/.test(ra.text) && /Sendungsnummer/.test(ra.text) && /Riss im Boden/.test(ra.text) && /Gutschrift über 51,75 €/.test(nb(ra.text)), 'Reklamation angelegt: Rücksendeadresse, Sendungsnummer, Grund, Art');
    const ro = all['reklamation-angelegt-ohne-ruecksendung'];
    check(/nichts zurückschicken/.test(ro.text) && /IBAN/.test(ro.text) && !/Musterstraße 1\n/.test(ro.text), 'Reklamation angelegt ohne Rücksendung: kein Adressblock, IBAN-Bitte bei Überweisung');
    check(/Rücksendung eingegangen/.test(all['reklamation-eingegangen'].subject) && /Gutschein-Code/.test(all['reklamation-eingegangen'].text) && /deutlich zu sehen/.test(all['reklamation-eingegangen'].text), 'Reklamation eingegangen: nächster Schritt + Notiz');
    const rg = all['reklamation-erledigt-gutschein'];
    check(/Gutschein-Code/.test(rg.subject) && rg.html.includes('font-size:26px') && rg.html.includes('GS-AB12-CD34') && /GUTSCHEIN-CODE \(51,75 €\): GS-AB12-CD34/.test(nb(rg.text)) && /in der Kasse im Feld „Gutscheincode“/.test(rg.text) && !/Checkout/.test(rg.text) && rg.text.includes(`${baseUrl}/orders/FS-260910-A1B2C3/gutschrift.html?k=${SAMPLE_KEY}`) && rg.html.includes(`gutschrift.html?k=${SAMPLE_KEY}`), 'Reklamation erledigt (Gutschein): Code groß, Hinweis „in der Kasse im Feld Gutscheincode“, Gutschrift-Link mit Schlüssel');
    const ru = all['reklamation-erledigt-ueberweisung'];
    check(/5 Werktagen/.test(ru.text) && /…3000/.test(ru.text) && !/DE89 3704/.test(ru.text) && !/DE89 3704/.test(ru.html) && ru.text.includes('gutschrift.html'), 'Reklamation erledigt (Überweisung): 5 Werktage, IBAN nur maskiert');
    check(/1–3 Tagen/.test(all['reklamation-erledigt-paypal'].text) && /1AB23456CD789012E/.test(all['reklamation-erledigt-paypal'].text), 'Reklamation erledigt (PayPal): 1–3 Tage, Referenz');
    const rn = all['reklamation-erledigt-nachdruck'];
    check(/Ich drucke dein Design neu/.test(rn.text) && !/gutschrift\.html/.test(rn.text) && /Nachdruck/.test(rn.subject), 'Reklamation erledigt (Nachdruck): kein Gutschrift-Link');
    const rx = all['reklamation-abgelehnt'];
    check(/Spülmaschine/.test(rx.text) && /tut mir wirklich leid/.test(rx.text) && /Meine Begründung/.test(rx.text) && rx.html.includes('50 °C'), 'Reklamation abgelehnt: Begründung, freundlich');
    let thrown = 0;
    try { T.reklamationMail({ order: sampleOrder(), phase: 'angelegt', settings, baseUrl }); } catch { thrown++; }
    try { T.reklamationMail({ order: sampleRekla(), phase: 'storniert', settings, baseUrl }); } catch { thrown++; }
    check(thrown === 2 && T.REKLA_PHASES.length === 4 && Object.keys(T.REKLA_STATUS).join() === 'offen,ruecksendung,eingegangen,erledigt,abgelehnt' && Object.keys(T.REKLA_ART).join() === 'nachdruck,gutschein,ueberweisung,paypal', 'reklamationMail(): Fehler ohne Reklamation/bei falscher Phase; Labels vollständig');
    check(T.lineParts({ product: 'vase', config: { preset: 'flasche', pattern: 'rippen', height: 150, rim: 'wulst' } }).includes('Wulstrand') && !T.lineParts({ product: 'vase', config: { preset: 'flasche', rim: 'glatt' } }).join().includes('Rand') && T.lineParts({ product: 'vase', config: { rim: 'muster' } }).includes('Musterkante'), 'lineParts(): Rand nur bei Wulst/Musterkante');
    // Aktion: UVP-Zeile je Position + Ersparnis unter den Summen; Bestellungen ohne die Felder bleiben unverändert
    const ba = T.orderConfirmation({ order: sampleAktion(), settings, baseUrl });
    check(/Normalpreis 24,90 € · Aktion −16 %/.test(nb(ba.text)) && /Normalpreis 9,90 € · Aktion −16 %/.test(nb(ba.text)) && /1 × 20,92 €/.test(nb(ba.text)) && /Aktion „Sommer-Sale“ −16 %: Ersparnis −10,32 €/.test(nb(ba.text)) && ba.html.includes('Normalpreis 24,90') && ba.html.includes('Ersparnis') && !/Mengenrabatt/.test(ba.text), 'Bestätigung mit Aktion: Normalpreis-Zeile, reduzierter Einzelpreis, Ersparnis-Zeile, kein Mengenrabatt');
    check(!/Aktion|UVP|Normalpreis|Ersparnis/.test(b.text) && !/Ersparnis/.test(b.html) && T.aktionText({ unit: 9.9 }, settings) === '' && T.aktionSummary({ aktion: null }, settings).length === 0, 'Ohne Aktion: keine UVP-/Ersparnis-Zeilen (alte Bestellungen unverändert)');
    // Zwei Aktionen gleichzeitig (Oberflächen-Aktion + Aktion auf alles): Name je Zeile, je Aktion eine Ersparnis-Zeile mit Geltungsbereich
    const bb = T.orderConfirmation({ order: sampleAktionen(), settings, baseUrl });
    check(/Normalpreis 24,90 € · Aktion −30 % \(Gehämmert-Woche\)/.test(nb(bb.text)) && /Normalpreis 9,90 € · Aktion −10 % \(Herbst\)/.test(nb(bb.text)) && /1 × 17,43 €/.test(nb(bb.text)) && /4 × 8,91 €/.test(nb(bb.text)) &&
      /Aktion „Gehämmert-Woche“ −30 % auf Gehämmert: Ersparnis −7,47 €/.test(nb(bb.text)) && /Aktion „Herbst“ −10 % auf alles: Ersparnis −3,96 €/.test(nb(bb.text)) &&
      (bb.html.match(/: Ersparnis/g) || []).length === 2 && bb.html.includes('(Gehämmert-Woche)') && !/Mengenrabatt/.test(bb.text), 'Bestätigung mit zwei Aktionen: Aktionsname je Zeile, zwei Ersparnis-Zeilen mit Geltungsbereich');
    check(T.aktionScopeLabel(null) === 'auf alles' && T.aktionScopeLabel({ produkte: 'alle', muster: [] }) === 'auf alles' && T.aktionScopeLabel({ produkte: 'vase' }) === 'auf Vasen' &&
      T.aktionScopeLabel({ produkte: 'alle', muster: ['gehaemmert'] }) === 'auf Gehämmert' && T.aktionScopeLabel({ produkte: 'vase', muster: ['gehaemmert'] }) === 'auf Vasen mit Gehämmert' &&
      T.aktionScopeLabel({ produkte: 'alle', muster: ['rippen', 'wellen', 'lamellen'] }) === 'auf Rippen, Wellen und Lamellen' && T.aktionScopeLabel({ produkte: 'eierbecher', muster: ['rippen', 'wellen'] }) === 'auf Eierbecher mit Rippen oder Wellen' &&
      T.aktionScopeLabel({ produkte: 'alle', muster: ['glatt', 'rippen', 'wellen', 'lamellen'] }) === 'auf 4 Oberflächen' && T.aktionScopeLabel({ produkte: 'alle', muster: ['glatt', 'rippen', 'wellen', 'lamellen', 'zickzack', 'querwellen', 'gehaemmert', 'skelett', 'koralle'] }) === 'auf alles' &&
      T.orderAktionen({ aktion: { id: 'x', name: 'Alt', prozent: 16, ersparnis: 1 } }).length === 1 && T.orderAktionen({}).length === 0, 'aktionScopeLabel()/orderAktionen(): Geltungsbereich-Texte, Rückfall auf order.aktion');
    // Widerruf: Eingangsbestätigung (Inhalt, Datum + Uhrzeit, Referenz) und Admin-Meldung
    const wv = all.widerruf;
    check(wv.subject === 'Dein Widerruf ist eingegangen (WR-260927-4F2A)' && /^Hallo Mia,/.test(wv.text), 'Widerruf: Betreff mit Referenz, Anrede', wv.subject);
    check(wv.text.includes('Eingegangen am: 27. September 2026 um 16:05 Uhr') && wv.text.includes('Dein Widerruf ist am 27. September 2026 um 16:05 Uhr bei mir eingegangen') && wv.html.includes('27. September 2026 um 16:05 Uhr'), 'Widerruf: Datum + Uhrzeit des Eingangs in deutscher Zeit (14:05 UTC → 16:05 Uhr)', wv.text.slice(0, 300));
    check(wv.text.includes('Referenz: WR-260927-4F2A') && wv.text.includes('Erklärung: Widerruf des Vertrags zu Bestellung FS-260910-A1B2C3') && wv.text.includes('Bestellnummer: FS-260910-A1B2C3') && wv.text.includes('E-Mail: mia@example.com') && wv.text.includes('Deine Nachricht: Ich möchte den Vertrag widerrufen.\n  Zweite Zeile & <b>'), 'Widerruf: Inhalt der Erklärung (Referenz, Bestellung, Name, E-Mail, Nachricht mit Umbruch)');
    check(wv.html.includes('Zweite Zeile &amp; &lt;b&gt;') && !wv.html.includes('<b>Zweite') && wv.html.includes(`href="${baseUrl}/widerruf"`), 'Widerruf: Nachricht escaped, Link zur Widerrufsbelehrung');
    check(all.widerrufOhne.text.includes('Bestellnummer: keine angegeben') && all.widerrufOhne.text.includes('Erklärung: Widerruf des Vertrags\n') && !all.widerrufOhne.text.includes('Deine Nachricht'), 'Widerruf ohne Bestellnummer/Nachricht: „keine angegeben“, keine leere Nachrichtenzeile');
    const aw = all.adminWiderruf;
    check(/^Widerruf WR-260927-4F2A · FS-260910-A1B2C3 · zugeordnet$/.test(aw.subject) && aw.text.includes('Admin:') && aw.text.includes('zugeordnet (E-Mail passt)') && aw.text.includes('Nachricht: Ich möchte'), 'Admin-Meldung Widerruf: Betreff, Zuordnung, Inhalt', aw.subject);
    check(/bitte prüfen$/.test(T.adminWiderruf({ widerruf: sampleWiderruf({ orderMatched: false }), settings, baseUrl }).subject), 'Admin-Meldung: nicht zugeordnet → „bitte prüfen“');
    // Vorlage durch den Encoder: Zeilenlänge bleibt unter 998, Dekodierung identisch
    const built = buildMessage({ from: 'shop@example.com', to: 'mia@example.com', subject: b.subject, text: b.text, html: b.html });
    check(built.raw.split('\r\n').every((l) => l.length <= 998), 'Bestätigungs-HTML kodiert: alle Zeilen ≤ 998');
    const pm = parseMime(built.raw);
    check(qpDecode(findPart(pm, 'text/html').body.replace(/\r\n$/, '')) === b.html.replace(/\r?\n/g, '\r\n'), 'Bestätigungs-HTML: QP-Roundtrip identisch');
    check(quotedPrintable('a=b') === 'a=3Db' && encodeWord('Grüße') === '=?UTF-8?B?R3LDvMOfZQ==?=', 'Encoder-Basics (=, Encoded-Word)');
  }

  console.log(`\n${fail ? '❌' : '✅'} ${pass} bestanden, ${fail} fehlgeschlagen (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  process.exit(fail ? 1 : 0);
}

// ---------------------------------------------------------------------------
// --render
// ---------------------------------------------------------------------------
function render() {
  mkdirSync(TMP, { recursive: true });
  const settings = sampleSettings();
  const baseUrl = baseUrlFor(settings);
  const order = sampleOrder();
  const out = {
    'bestaetigung-vorkasse': T.orderConfirmation({ order, settings, baseUrl }),
    'bestaetigung-paypal': T.orderConfirmation({ order: sampleOrder({ payment: 'paypal', paymentStatus: 'bezahlt' }), settings, baseUrl }),
    'bestaetigung-aktion': T.orderConfirmation({ order: sampleAktion(), settings, baseUrl }),
    'bestaetigung-aktionen': T.orderConfirmation({ order: sampleAktionen(), settings, baseUrl }),
    willkommen: T.welcome({ user: { name: 'Mia Müller', email: 'mia@example.com' }, settings, baseUrl }),
    'passwort-vergessen': T.passwordReset({ user: { name: 'Mia Müller', email: 'mia@example.com' }, link: `${baseUrl}/?reset=abc123def456`, settings }),
    'admin-neue-bestellung': T.adminNewOrder({ order, settings, baseUrl }),
    nachricht: T.customMessage({ order, subject: 'Kurze Rückfrage zur Farbe', text: 'welche Farbe soll der Untersetzer haben?\nSalbei oder Kupfer?\n\nDanke & liebe Grüße\nJulian', settings, baseUrl }),
    'widerruf-eingang': T.widerrufEingang({ widerruf: sampleWiderruf(), settings, baseUrl }),
    'admin-widerruf': T.adminWiderruf({ widerruf: sampleWiderruf(), settings, baseUrl }),
    'bestaetigung-gast': T.orderConfirmation({ order: sampleOrder({ userId: null }), settings, baseUrl }),
    'bestaetigung-guthaben': T.orderConfirmation({ order: sampleOrder({ coupon: { code: 'GS-AB12-CD34', off: 5.75, guthaben: true } }), settings, baseUrl }),
    'willkommen-bestaetigen': T.welcome({ user: { name: 'Mia Müller', email: 'mia@example.com' }, settings, baseUrl, verifyLink: `${baseUrl}/?verify=abc123def456` }),
    'email-bestaetigen': T.emailBestaetigung({ user: { name: 'Mia Müller', email: 'mia@example.com' }, link: `${baseUrl}/?verify=abc123def456`, settings, baseUrl }),
    'admin-paypal-ohne-bestellung': T.adminPaypalKasse({ p: { id: '5O190127TN364715T', amount: '29.80', currency: 'EUR', capturedAt: '2026-09-27T10:00:00Z', grund: 'Zahlung nicht bestätigt (Betrag weicht von der Bestellung ab)', erstattet: false, fehler: 'PayPal-Zugangsdaten fehlen', customer: { name: 'Mia Müller', email: 'mia@example.com' } }, settings, baseUrl }),
    'status-storniert-stornobeleg': T.orderStatus({ order: sampleOrder({ status: 'storniert', storno: { nr: 'GS-2026-0007', at: '2026-09-27T10:00:00Z' } }), status: 'storniert', settings, baseUrl }),
  };
  for (const st of Object.keys(T.STATUS_MAIL)) {
    out[`status-${st}`] = T.orderStatus({
      order: sampleOrder({ status: st, trackingNo: st === 'versendet' ? '00340434161094000000' : '', carrier: 'dhl', payment: st === 'storniert' ? 'paypal' : 'vorkasse', paymentStatus: st === 'storniert' || st === 'abgeschlossen' ? 'bezahlt' : 'offen' }),
      status: st, settings, baseUrl,
    });
  }
  Object.assign(out, reklaMails(settings, baseUrl));
  for (const [k, v] of Object.entries(out)) {
    const f = path.join(TMP, `mail-${k}.html`);
    writeFileSync(f, v.html);
    writeFileSync(path.join(TMP, `mail-${k}.txt`), `Betreff: ${v.subject}\n\n${v.text}\n`);
    console.log(`📝 ${path.relative(ROOT, f)}  —  ${v.subject}`);
  }
  console.log(`\n${Object.keys(out).length} Vorlagen unter tmp-tests/ (HTML + .txt-Textversion)`);
}

// ---------------------------------------------------------------------------
// --to adresse  (echte Testmail mit data/settings.json)
// ---------------------------------------------------------------------------
async function sendReal(to) {
  let settings;
  try { settings = JSON.parse(readFileSync(path.join(ROOT, 'data', 'settings.json'), 'utf8')); }
  catch (e) { console.error(`❌ data/settings.json nicht lesbar: ${e.message}`); process.exit(1); }
  const m = mailSettings(settings.mail);
  if (!m.host) { console.error('❌ settings.mail.host ist leer — SMTP zuerst im Admin (oder in data/settings.json → "mail") eintragen.'); process.exit(1); }
  console.log(`📮 Testmail an ${to} über ${m.host}:${m.port} (${m.secure}${m.user ? `, Benutzer ${m.user}` : ', ohne Anmeldung'}) …`);
  const mailer = createMailer({ dataDir: TMP, getSettings: () => settings, log: (l) => console.log('  ', l) });
  const r = await mailer.test(settings.mail, to);
  for (const l of r.log) console.log('  ' + l);
  if (r.ok) console.log('✅ Testmail übergeben — bitte Posteingang (und Spam-Ordner) prüfen.');
  else console.log(`❌ ${r.error}`);
  process.exit(r.ok ? 0 : 1);
}

// ---------------------------------------------------------------------------
// --serve [port]  (Fake-SMTP dauerhaft für End-to-End-Tests: nimmt alles an, keine TLS,
//                  jede Anmeldung gilt; jede Nachricht → tmp-tests/inbox/<n>-<zeit>.eml + Zeile auf stdout)
// ---------------------------------------------------------------------------
async function serve(port) {
  const inbox = path.join(TMP, 'inbox');
  mkdirSync(inbox, { recursive: true });
  let n = 0;
  const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
  let srv;
  try {
    srv = await fakeSmtp({
      port, acceptAny: true, splitChunks: false,
      onMessage: (s) => {
        const file = path.join(inbox, `${String(++n).padStart(3, '0')}-${stamp()}.eml`);
        writeFileSync(file, s.data + '\r\n');
        const m = parseMime(s.data);
        console.log(`📨 ${n}. an ${s.rcpts.join(', ')} — „${decodeWords(m.headers.subject || '')}“ → ${path.relative(ROOT, file)}`);
      },
    });
  } catch (e) { console.error(`❌ Fake-SMTP konnte Port ${port} nicht öffnen: ${e.message}`); process.exit(1); }
  console.log(`📮 Fake-SMTP lauscht auf 127.0.0.1:${srv.port} (unverschlüsselt, AUTH PLAIN/LOGIN, jede Anmeldung gilt)\n   Posteingang: ${path.relative(ROOT, inbox)}/ — beenden mit Strg+C`);
  const stop = () => { srv.close().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 1000).unref(); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

if (flag('--smoke')) smoke().catch((e) => { console.error('❌ Smoke-Test abgebrochen:', e); process.exit(1); });
else if (flag('--render')) render();
else if (opt('--to')) sendReal(opt('--to'));
else if (flag('--serve')) serve(parseInt(opt('--serve'), 10) || 2525);
else {
  console.log('Aufruf:\n  node tools/mail-test.mjs --smoke\n  node tools/mail-test.mjs --render\n  node tools/mail-test.mjs --to adresse@example.com\n  node tools/mail-test.mjs --serve [port]');
  process.exit(1);
}
