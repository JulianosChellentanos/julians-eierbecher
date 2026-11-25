// formsam — E-Mail-Versand: schlanker SMTP-Client (nur Node-Built-ins) + Outbox-Protokoll
//
//   import { createMailer } from './lib/mailer.js';
//   const mailer = createMailer({ dataDir, getSettings: () => settings, log });
//   await mailer.send({ to, subject, text, html, kind: 'bestellung', ref: orderId });
//
// Unterstützt: EHLO, STARTTLS (RFC 3207), direktes TLS (465) oder unverschlüsselt,
// AUTH PLAIN / AUTH LOGIN (RFC 4954), Dot-Stuffing, Mehrzeilenantworten, Timeouts, SMTPUTF8 (RFC 6531) wenn nötig.
// Nachrichten: RFC 5322 + MIME (multipart/alternative, optional multipart/mixed mit Anhängen),
// UTF-8 in Headern als =?UTF-8?B?…?=, Textteile quoted-printable, Anhänge base64, Domains von Adressen in Punycode.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { domainToASCII } from 'node:url';
import { readFile, writeFile, rename, mkdir, rm, readdir } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Einstellungen (settings.mail) — alles optional, Defaults hier
// ---------------------------------------------------------------------------
export const MAIL_DEFAULTS = Object.freeze({
  enabled: false,
  host: '',
  port: 587,
  secure: 'starttls',        // 'starttls' | 'ssl' | 'none'
  user: '',
  pass: '',
  from: '',                  // Absenderadresse (leer → user, sonst company.email)
  fromName: 'formsam',
  replyTo: '',
  adminTo: '',               // Benachrichtigungen an den Shop-Betreiber
  adminCopy: true,
  autoStatusMails: true,
  publicUrl: '',             // öffentliche Shop-URL für Links in Mails
  allowSelfSigned: false,    // nur für Testserver mit selbstsigniertem Zertifikat
});
// data = Warten auf die Annahme nach dem Nachrichtenende (RFC 5321 §4.5.3.2.6 empfiehlt 10 min; Content-Scan/Greylisting
// antworten langsam — ein zu kurzer Wert würde eine angenommene Mail als Fehler werten und erneut senden)
export const DEFAULT_TIMEOUTS = Object.freeze({ connect: 15_000, command: 30_000, data: 300_000 });
// Wartezeit vor Versuch 1..n der Warteschlange: sofort, +1 min, +10 min, +1 h, +6 h, +24 h — ein Ausfall des Mailservers von gut
// 31 Stunden geht so ohne Verlust vorbei. Der Stand (Versuche, nächster Termin) steht in der Outbox, nach einem Neustart geht es weiter.
export const DEFAULT_RETRY_DELAYS = Object.freeze([0, 60_000, 600_000, 3_600_000, 21_600_000, 86_400_000]);
const OUTBOX_MAX = 500;
// Inhalt nicht zugestellter Mails (für Wiederholung und „Erneut“) liegt je Eintrag in <dataDir>/mail-outbox/<id>.json — einmal
// geschrieben, mail-outbox.json selbst bleibt klein (nur Kopfdaten) und ist schnell gespeichert. Nach der Zustellung wird der
// Inhalt gelöscht (so steht es in der Datenschutzerklärung); „Erneut“ bei zugestellten Mails erzeugt sie neu (rebuild).
const MSG_MAX = 1024 * 1024;              // eine gespeicherte Nachricht (mit Anhängen); größer → ohne Anhänge
const MSG_STORE_MAX = 50 * 1024 * 1024;   // alle gespeicherten Nachrichten zusammen
const MSG_AUFBEWAHREN_MS = 90 * 864e5;    // Inhalt nicht zugestellter Mails höchstens 90 Tage (beim Start, bei jeder neuen Mail, täglich)
const PFLEGE_MS = 864e5;                  // Abstand der täglichen Prüfung auf abgelaufene Inhalte
const PROBLEM_TAGE = 30;                  // gescheiterte Mails so lange als Hinweis in der Admin-Übersicht

/** settings.mail mit Defaults auffüllen und normalisieren */
export function mailSettings(raw) {
  const m = { ...MAIL_DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };
  for (const k of ['host', 'user', 'from', 'fromName', 'replyTo', 'adminTo', 'publicUrl']) m[k] = String(m[k] ?? '').trim();
  m.pass = String(m.pass ?? '');
  m.secure = ['starttls', 'ssl', 'none'].includes(m.secure) ? m.secure : 'starttls';
  m.port = parseInt(m.port, 10) || (m.secure === 'ssl' ? 465 : 587);
  for (const k of ['enabled', 'adminCopy', 'autoStatusMails', 'allowSelfSigned']) m[k] = !!m[k];
  return m;
}

/** Basis-URL für Links in Mails (ohne Slash am Ende) */
export function baseUrlFor(settings) {
  const u = String(settings?.mail?.publicUrl || '').trim().replace(/\/+$/, '');
  return u || 'http://localhost:4488';
}

// ---------------------------------------------------------------------------
// Adressen & Header-Kodierung
// ---------------------------------------------------------------------------
const ADDR_RE = /^[^\s@<>,;"()]+@[^\s@<>,;"()]+\.[^\s@<>,;"()]+$/;
const clean = (s) => String(s ?? '').replace(/[\r\n\t]+/g, ' ').trim();

/** 'x@y', 'Name <x@y>' oder { name, email } → { name, email } */
export function parseAddress(a) {
  if (a && typeof a === 'object') return { name: clean(a.name), email: clean(a.email).toLowerCase() };
  const s = clean(a);
  const m = s.match(/^(.*?)\s*<([^>]+)>$/);
  if (m) return { name: m[1].replace(/^"(.*)"$/, '$1').trim(), email: m[2].trim().toLowerCase() };
  return { name: '', email: s.toLowerCase() };
}
export function addressList(v) {
  const arr = Array.isArray(v) ? v : (typeof v === 'string' ? v.split(',') : [v]);
  return arr.map(parseAddress).filter((x) => x.email);
}
/**
 * Domain einer Adresse in Punycode (IDN, RFC 5891): „kunde@müller.de“ → „kunde@xn--mller-kva.de“ — so versteht sie jeder
 * Mailserver. Der lokale Teil bleibt; enthält er Nicht-ASCII („jürgen@…“), geht die Mail nur mit SMTPUTF8 (smtpSend prüft das).
 * Ungültige Domain → ''.
 */
export function asciiDomain(email) {
  const s = String(email ?? '');
  const at = s.lastIndexOf('@');
  if (at < 1) return s;
  const dom = s.slice(at + 1);
  if (/^[\x21-\x7e]*$/.test(dom)) return s;
  const a = domainToASCII(dom);
  return a ? `${s.slice(0, at)}@${a}` : '';
}
const nonAscii = (s) => /[^\x00-\x7f]/.test(s);
function assertAddress(a, what) {
  const email = asciiDomain(a.email);
  if (!email || !ADDR_RE.test(email)) throw new Error(`Ungültige ${what}: „${a.email || '(leer)'}“`);
  return { ...a, email };
}

/** Header-Text als UTF-8-B-Encoded-Words (≤ 75 Zeichen je Wort, gefaltet mit CRLF+SP) */
export function encodeWord(str) {
  const s = clean(str);
  if (!s) return '';
  const chunks = [];
  let chunk = '', bytes = 0;
  for (const ch of s) {
    const n = Buffer.byteLength(ch, 'utf8');
    if (bytes + n > 45 && chunk) { chunks.push(chunk); chunk = ''; bytes = 0; }
    chunk += ch; bytes += n;
  }
  if (chunk) chunks.push(chunk);
  return chunks.map((c) => `=?UTF-8?B?${Buffer.from(c, 'utf8').toString('base64')}?=`).join('\r\n ');
}
/**
 * Anzeigename: kurzes reines ASCII als Quoted-String („formsam“ statt =?UTF-8?B?…?= — Spamfilter mögen unnötig kodierte Namen
 * nicht); alles andere als Encoded-Word (lange Namen werden dabei gefaltet, keine Zeile über 998 Zeichen)
 */
function formatAddress(a) {
  if (!a.name) return a.email;
  const n = clean(a.name);
  return /^[\x20-\x7e]{1,60}$/.test(n) ? `"${n.replace(/["\\]/g, '\\$&')}" <${a.email}>` : `${encodeWord(n)} <${a.email}>`;
}

/** RFC-5322-Datum, z. B. "Wed, 10 Sep 2026 12:49:00 +0200" */
export function rfcDate(d = new Date()) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const tz = `${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
  return `${days[d.getDay()]}, ${p(d.getDate())} ${months[d.getMonth()]} ${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${tz}`;
}

/** Quoted-printable (RFC 2045), UTF-8, Zeilen ≤ 76 Zeichen, CRLF */
export function quotedPrintable(str) {
  const bytes = Buffer.from(String(str ?? '').replace(/\r\n?|\n/g, '\r\n'), 'utf8');
  let out = '', line = '';
  const flushLine = (hard) => {
    // Leerzeichen/Tab am Zeilenende müssen kodiert werden
    if (hard && (line.endsWith(' ') || line.endsWith('\t'))) {
      line = line.slice(0, -1) + (line.endsWith(' ') ? '=20' : '=09');
    }
    out += line + (hard ? '\r\n' : '=\r\n');
    line = '';
  };
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    if (b === 13 && bytes[i + 1] === 10) { flushLine(true); i++; continue; }
    const tok = ((b >= 33 && b <= 126 && b !== 61) || b === 32 || b === 9)
      ? String.fromCharCode(b)
      : '=' + b.toString(16).toUpperCase().padStart(2, '0');
    if (line.length + tok.length > 75) flushLine(false);
    line += tok;
  }
  if (line) {
    if (line.endsWith(' ') || line.endsWith('\t')) line = line.slice(0, -1) + (line.endsWith(' ') ? '=20' : '=09');
    out += line;
  }
  return out;
}
function base64Lines(buf) {
  return (buf.toString('base64').match(/.{1,76}/g) || []).join('\r\n');
}
function asciiName(s) {
  return clean(s).replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'anhang';
}
function escHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|tr|h\d|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ---------------------------------------------------------------------------
// Nachricht bauen (RFC 5322 + MIME)
// ---------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {string|{name,email}} o.from
 * @param {string|string[]|{name,email}[]} o.to
 * @param {string} [o.replyTo]
 * @param {string} o.subject
 * @param {string} [o.text]  reine Textversion (wird aus html abgeleitet, wenn leer)
 * @param {string} [o.html]  HTML-Version (wird aus text abgeleitet, wenn leer)
 * @param {{filename:string, content:Buffer|string, contentType?:string}[]} [o.attachments]
 * @returns {{ id:string, raw:string, from:string, rcpts:string[], smtputf8:boolean }}
 *   smtputf8 = eine Adresse hat Nicht-ASCII im lokalen Teil → Versand nur über einen Server mit SMTPUTF8
 */
export function buildMessage({ from, to, replyTo, subject, text, html, attachments, date = new Date(), headers: extraHeaders } = {}) {
  const fromA = assertAddress(parseAddress(from), 'Absenderadresse');
  const toList = addressList(to).map((a) => assertAddress(a, 'Empfängeradresse'));
  if (!toList.length) throw new Error('Keine Empfängeradresse angegeben');
  const replyA = replyTo ? assertAddress(parseAddress(replyTo), 'Antwortadresse') : null;
  const subj = clean(subject) || '(kein Betreff)';
  let plain = String(text ?? '');
  let rich = String(html ?? '');
  if (!plain && rich) plain = htmlToText(rich);
  if (!rich && plain) rich = `<!DOCTYPE html><html><body><pre style="font-family:inherit;white-space:pre-wrap">${escHtml(plain)}</pre></body></html>`;
  if (!plain && !rich) plain = ' ';

  const boundary = () => `=_formsam_${crypto.randomBytes(12).toString('hex')}`;
  const altB = boundary();
  const alt = `--${altB}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(plain)}\r\n` +
    `--${altB}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n${quotedPrintable(rich)}\r\n` +
    `--${altB}--\r\n`;
  let body, ctype;
  const atts = (attachments || []).filter((a) => a && a.content != null);
  if (atts.length) {
    const mixB = boundary();
    body = `--${mixB}\r\nContent-Type: multipart/alternative; boundary="${altB}"\r\n\r\n${alt}`;
    for (const att of atts) {
      const buf = Buffer.isBuffer(att.content) ? att.content : Buffer.from(String(att.content), 'utf8');
      const name = asciiName(att.filename || 'anhang');
      const nameStar = encodeURIComponent(clean(att.filename || name));
      body += `--${mixB}\r\nContent-Type: ${clean(att.contentType) || 'application/octet-stream'}; name="${name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"; filename*=UTF-8''${nameStar}\r\n\r\n` +
        `${base64Lines(buf)}\r\n`;
    }
    body += `--${mixB}--\r\n`;
    ctype = `multipart/mixed; boundary="${mixB}"`;
  } else {
    body = alt;
    ctype = `multipart/alternative; boundary="${altB}"`;
  }
  const domain = fromA.email.split('@')[1] || os.hostname() || 'formsam.local';
  const id = `<${Date.now().toString(36)}.${crypto.randomBytes(9).toString('base64url')}@${domain}>`;
  const head = [
    `Date: ${rfcDate(date)}`,
    `From: ${formatAddress(fromA)}`,
    `To: ${toList.map(formatAddress).join(',\r\n ')}`,
    replyA ? `Reply-To: ${formatAddress(replyA)}` : '',
    `Subject: ${encodeWord(subj)}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    `Content-Type: ${ctype}`,
    'X-Mailer: formsam Shop',
    ...Object.entries(extraHeaders || {}).map(([k, v]) => `${clean(k)}: ${clean(v)}`),
  ].filter(Boolean);
  const smtputf8 = [fromA, ...toList, ...(replyA ? [replyA] : [])].some((a) => nonAscii(a.email));
  return { id, raw: head.join('\r\n') + '\r\n\r\n' + body, from: fromA.email, rcpts: toList.map((a) => a.email), smtputf8 };
}

/** Dot-Stuffing (RFC 5321 4.5.2): Zeilen, die mit "." beginnen, bekommen ein zweites */
export function dotStuff(raw) {
  return raw.replace(/(^|\r\n)\./g, '$1..');
}

// ---------------------------------------------------------------------------
// SMTP-Verbindung
// ---------------------------------------------------------------------------
// Zertifikat des Servers nicht vertrauenswürdig (selbstsigniert, abgelaufen, falscher Name)
const CERT_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
// TLS-Aushandlung mit einem Server, der auf diesem Port gar kein TLS spricht — die häufigste Verwechslung: „SSL/TLS“ an Port 587
const KEIN_TLS_CODES = new Set(['ERR_SSL_WRONG_VERSION_NUMBER', 'ERR_SSL_PACKET_LENGTH_TOO_LONG', 'ERR_SSL_HTTP_REQUEST', 'ERR_SSL_UNKNOWN_PROTOCOL']);
function describeError(e) {
  const code = e?.code || '';
  if (KEIN_TLS_CODES.has(code)) return 'Der Server spricht auf diesem Port kein SSL/TLS — für Port 587 bitte „STARTTLS“ wählen (SSL/TLS gehört zu Port 465)';
  // OpenSSL-Rohtext („C01C…:error:0A00010B:SSL routines:…“) hilft im Admin niemandem — dann nur der Code
  const raw = String(e?.message || '');
  const text = /error:[0-9A-F]{8}:|routines:/i.test(raw) ? '' : raw;
  let msg = code ? `${code}${text && !text.includes(code) ? ' – ' + text : ''}` : (text || raw || String(e));
  if (code === 'CERT_HAS_EXPIRED') msg += ' (das Zertifikat des Mailservers ist abgelaufen)';
  else if (code === 'ERR_TLS_CERT_ALTNAME_INVALID') msg += ' (das Zertifikat passt nicht zum Hostnamen — Host so eintragen, wie er im Zertifikat steht)';
  else if (CERT_CODES.has(code)) msg += ' (Zertifikat des Mailservers nicht vertrauenswürdig, z. B. selbstsigniert — Hostnamen prüfen)';
  if (code === 'ECONNREFUSED') msg += ' (nichts lauscht auf diesem Port — Host/Port prüfen)';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') msg += ' (Hostname nicht auflösbar)';
  return msg;
}
// SNI nur für Hostnamen (RFC 6066 erlaubt keine IP-Adressen)
const sni = (host) => (net.isIP(host) ? {} : { servername: host });
function ehloName() {
  const h = String(os.hostname() || '').trim();
  return /^[a-z0-9.-]+$/i.test(h) && h.includes('.') ? h : '[127.0.0.1]';
}
/** Fehler mit SMTP-Antwortcode; 5xx (außer 552 = Speicher voll, RFC 5321 §4.2.3) gilt als endgültig → kein Retry */
function smtpError(message, code) {
  return Object.assign(new Error(message), { smtpCode: code, permanent: code >= 500 && code !== 552 });
}
const permanentError = (message) => Object.assign(new Error(message), { permanent: true });

class SmtpConnection {
  constructor(cfg, { timeouts, log }) {
    this.cfg = cfg;
    this.t = timeouts;
    this.log = log;
    this.sock = null;
    this.buf = '';
    this.lines = [];
    this.inbox = [];
    this.waiter = null;
    this.err = null;
    this.closed = false;
  }

  async open() {
    const { host, port, secure, allowSelfSigned } = this.cfg;
    const sock = await new Promise((resolve, reject) => {
      let s;
      const timer = setTimeout(() => {
        s?.destroy();
        reject(new Error(`Zeitüberschreitung beim Verbinden mit ${host}:${port} (${Math.round(this.t.connect / 1000)} s)`));
      }, this.t.connect);
      const onErr = (e) => { clearTimeout(timer); reject(new Error(`Verbindung zu ${host}:${port} fehlgeschlagen: ${describeError(e)}`)); };
      const onOk = () => { clearTimeout(timer); s.off('error', onErr); resolve(s); };
      s = secure === 'ssl'
        ? tls.connect({ host, port, ...sni(host), rejectUnauthorized: !allowSelfSigned }, onOk)
        : net.connect({ host, port }, onOk);
      s.once('error', onErr);
    });
    this.log(`-- verbunden mit ${host}:${port}${secure === 'ssl' ? ' (TLS ' + (sock.getProtocol?.() || '') + ')' : ''}`);
    this.attach(sock);
    let g;
    try { g = await this.read(); }
    catch (e) {
      // Keine Begrüßung im Klartext: meist spricht der Server auf diesem Port direkt TLS (465) — STARTTLS/„keine“ gewählt
      if (e.timeout && secure !== 'ssl') e.message += ` — der Server schickt keine Begrüßung. Spricht er auf Port ${port} direkt TLS${port === 465 ? ' (bei Port 465 üblich)' : ''}? Dann Verschlüsselung „SSL/TLS“ wählen.`;
      throw e;
    }
    this.logResponse(g);
    if (g.code !== 220) throw new Error(`Server begrüßt nicht (${g.code} ${g.text})`);
  }

  attach(sock) {
    this.sock = sock;
    this.buf = ''; this.lines = []; this.inbox = [];   // nach STARTTLS nichts aus dem Klartext übernehmen (RFC 3207 §4.2)
    sock.on('data', (d) => this.onData(d.toString('utf8')));
    sock.on('error', (e) => this.fail(new Error(`Verbindungsfehler: ${describeError(e)}`)));
    sock.on('close', () => { this.closed = true; this.fail(new Error('Verbindung vom Server geschlossen')); });
  }
  detach() {
    this.sock.removeAllListeners('data');
    this.sock.removeAllListeners('error');
    this.sock.removeAllListeners('close');
  }
  fail(err) {
    if (!this.err) this.err = err;
    if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.reject(err); }
  }
  onData(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, '');
      this.buf = this.buf.slice(idx + 1);
      this.lines.push(line);
      if (/^\d{3}(?: |$)/.test(line)) {   // "250 …" schließt die Antwort ab, "250-…" ist eine Fortsetzung
        const resp = { code: parseInt(line.slice(0, 3), 10), lines: this.lines, text: this.lines.map((l) => l.slice(4)).join('\n') };
        this.lines = [];
        if (this.waiter) { const w = this.waiter; this.waiter = null; clearTimeout(w.timer); w.resolve(resp); }
        else this.inbox.push(resp);
      }
    }
  }
  read(timeoutMs = this.t.command) {
    if (this.inbox.length) return Promise.resolve(this.inbox.shift());
    if (this.err) return Promise.reject(this.err);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(Object.assign(new Error(`Zeitüberschreitung: keine Antwort vom Server innerhalb von ${Math.round(timeoutMs / 1000)} s`), { timeout: true }));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
  logResponse(r) { for (const l of r.lines) this.log(`S: ${l}`); }
  /** Nach „220“ auf STARTTLS darf im Klartext nichts mehr nachkommen — sonst könnte jemand auf dem Weg Antworten einschleusen */
  assertNichtsGepuffert() {
    if (this.inbox.length || this.lines.length || this.buf.length) {
      throw new Error('Protokollfehler: Der Server hat nach STARTTLS weitere Daten im Klartext geschickt — Verbindung aus Sicherheitsgründen abgebrochen');
    }
  }
  write(str) {
    return new Promise((resolve, reject) => {
      if (this.err) return reject(this.err);
      this.sock.write(str, (e) => (e ? reject(new Error(`Senden fehlgeschlagen: ${describeError(e)}`)) : resolve()));
    });
  }
  /** Befehl senden und Antwort prüfen; display = maskierte Log-Darstellung */
  async cmd(line, expect, display) {
    this.log(`C: ${display ?? line}`);
    await this.write(line + '\r\n');
    const r = await this.read();
    this.logResponse(r);
    if (!expect.includes(r.code)) {
      const name = (display ?? line).split(' ')[0];
      throw smtpError(`${name}: ${r.code} ${r.text.replace(/\n/g, ' | ')}`, r.code);
    }
    return r;
  }
  async ehlo() {
    let r;
    try { r = await this.cmd(`EHLO ${ehloName()}`, [250]); }
    catch (e) {
      if (!/^EHLO: 5(00|02)/.test(e.message)) throw e;
      r = await this.cmd(`HELO ${ehloName()}`, [250]);
    }
    const ext = { starttls: false, auth: [], size: 0, smtputf8: false };
    for (const l of r.lines.slice(1)) {
      const kw = l.slice(4).trim();
      if (/^STARTTLS$/i.test(kw)) ext.starttls = true;
      if (/^SMTPUTF8$/i.test(kw)) ext.smtputf8 = true;
      const am = kw.match(/^AUTH[ =](.+)$/i);
      if (am) ext.auth.push(...am[1].toUpperCase().split(/\s+/));
      const sm = kw.match(/^SIZE\s+(\d+)/i);
      if (sm) ext.size = parseInt(sm[1], 10);
    }
    return ext;
  }
  async upgradeTls() {
    const { host, allowSelfSigned } = this.cfg;
    const plain = this.sock;
    this.detach();
    const sec = await new Promise((resolve, reject) => {
      let s;
      // Nach einer gescheiterten Aushandlung ist die Verbindung unbrauchbar (kein QUIT mehr) → als Verbindungsfehler merken
      const bail = (err) => { this.fail(err); reject(err); };
      const timer = setTimeout(() => { s?.destroy(); bail(Object.assign(new Error('Zeitüberschreitung bei der TLS-Aushandlung'), { timeout: true })); }, this.t.command);
      const onErr = (e) => { clearTimeout(timer); bail(new Error(`TLS-Aushandlung fehlgeschlagen: ${describeError(e)}`)); };
      s = tls.connect({ socket: plain, ...sni(host), rejectUnauthorized: !allowSelfSigned }, () => {
        clearTimeout(timer); s.off('error', onErr); resolve(s);
      });
      s.once('error', onErr);
    });
    this.attach(sec);
    this.log(`-- TLS aktiv (${sec.getProtocol?.() || 'TLS'}${sec.authorized ? '' : ', Zertifikat nicht geprüft'})`);
  }
  async auth(mechs) {
    const { user, pass, secure } = this.cfg;
    if (secure === 'none') this.log('-- Hinweis: Anmeldedaten gehen unverschlüsselt über die Leitung');
    const avail = mechs.map((m) => m.toUpperCase());
    const mech = (avail.includes('PLAIN') || !avail.length) ? 'PLAIN' : (avail.includes('LOGIN') ? 'LOGIN' : null);
    if (!mech) throw permanentError(`Server bietet keine unterstützte Anmeldung an (${avail.join(', ') || 'keine'}) — der Shop kann PLAIN und LOGIN`);
    const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
    try {
      if (mech === 'PLAIN') {
        const cred = b64(`\0${user}\0${pass}`);
        const r = await this.cmd(`AUTH PLAIN ${cred}`, [235, 334], 'AUTH PLAIN ****');
        if (r.code === 334) await this.cmd(cred, [235], '****');
      } else {
        await this.cmd('AUTH LOGIN', [334]);
        await this.cmd(b64(user), [334], '**** (Benutzername)');
        await this.cmd(b64(pass), [235], '**** (Passwort)');
      }
    } catch (e) {
      // Antwortcode/Endgültigkeit (z. B. 535 = falsches Passwort → kein Retry, sonst wiederholte Fehl-Logins beim Provider) mitnehmen
      throw Object.assign(new Error(`Anmeldung am SMTP-Server abgelehnt — Benutzername/Passwort prüfen (${e.message})`), { smtpCode: e.smtpCode, permanent: !!e.permanent, timeout: !!e.timeout });
    }
  }
  async data(raw) {
    const stuffed = dotStuff(raw);
    const payload = stuffed + (stuffed.endsWith('\r\n') ? '' : '\r\n') + '.\r\n';
    this.log(`C: [Nachricht, ${Buffer.byteLength(payload)} Bytes]`);
    await this.write(payload);
    const r = await this.read(this.t.data ?? this.t.command);
    this.logResponse(r);
    if (r.code !== 250) throw smtpError(`Nachricht abgelehnt: ${r.code} ${r.text.replace(/\n/g, ' | ')}`, r.code);
    return r;
  }
  /** Sauberer Abschied nach einem Fehler (RFC 5321): best effort, kurze Wartezeit, Antwort egal */
  async quit() {
    if (!this.sock || this.closed || this.err) return;
    try {
      this.log('C: QUIT');
      await this.write('QUIT\r\n');
      await this.read(Math.min(3000, this.t.command));
    } catch { /* Server antwortet nicht mehr — egal */ }
  }
  close() {
    if (this.sock) { try { this.detach(); this.sock.destroy(); } catch { /* egal */ } }
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter = null; }
  }
}

/**
 * Eine fertige Nachricht (aus buildMessage) per SMTP ausliefern.
 * @returns {Promise<{ ok:boolean, error?:string, permanent?:boolean, log:string[] }>}
 *   log = SMTP-Dialog (Passwörter maskiert); permanent = endgültig (5xx-Antwort, Konfigurationsfehler) → kein Retry sinnvoll
 */
export async function smtpSend(cfgRaw, { from, rcpts, raw, smtputf8 = false }, opts = {}) {
  const cfg = mailSettings(cfgRaw);
  const log = [];
  const push = (l) => { log.push(l); opts.onLog?.(l); };
  const conn = new SmtpConnection(cfg, { timeouts: { ...DEFAULT_TIMEOUTS, ...(opts.timeouts || {}) }, log: push });
  try {
    if (!cfg.host) throw permanentError('Kein SMTP-Server (Host) eingestellt');
    await conn.open();
    let ext = await conn.ehlo();
    if (cfg.secure === 'starttls') {
      if (!ext.starttls) throw permanentError('Server bietet kein STARTTLS an — Verschlüsselung auf „SSL/TLS“ (Port 465) oder „keine“ umstellen');
      await conn.cmd('STARTTLS', [220]);
      conn.assertNichtsGepuffert();
      await conn.upgradeTls();
      ext = await conn.ehlo();
    }
    if (cfg.user) await conn.auth(ext.auth);
    const size = Buffer.byteLength(raw);
    if (ext.size && size > ext.size) throw permanentError(`Nachricht zu groß für den Server (${Math.round(size / 1024)} kB > ${Math.round(ext.size / 1024)} kB)`);
    // Umlaute vor dem @ („jürgen@…“) gehen nur über SMTPUTF8 — bietet der Server das nicht an, endgültig mit klarer Meldung
    if (smtputf8 && !ext.smtputf8) throw permanentError('Umlaute/Sonderzeichen vor dem @ – der Mailserver kann solche Adressen nicht zustellen (kein SMTPUTF8). Bitte nach einer anderen Adresse fragen.');
    await conn.cmd(`MAIL FROM:<${from}>${smtputf8 ? ' SMTPUTF8' : ''}`, [250]);
    for (const r of rcpts) await conn.cmd(`RCPT TO:<${r}>`, [250, 251]);
    await conn.cmd('DATA', [354]);
    await conn.data(raw);
    try { await conn.cmd('QUIT', [221]); } catch { /* Antwort auf QUIT ist egal */ }
    return { ok: true, log };
  } catch (e) {
    push(`-- Fehler: ${e.message}`);
    // Bei Protokollfehlern (z. B. 550 auf RCPT) noch QUIT senden statt die Verbindung einfach zu kappen;
    // nach Zeitüberschreitung antwortet der Server ohnehin nicht mehr
    if (!e.timeout) await conn.quit();
    return { ok: false, error: e.message, permanent: !!e.permanent, log };
  } finally {
    conn.close();
  }
}

// ---------------------------------------------------------------------------
// Gespeichertes SMTP-Passwort nur für den gespeicherten Zugang
// ---------------------------------------------------------------------------
/**
 * Gleicher SMTP-Zugang wie gespeichert (Host, Port, Benutzer — und nicht auf „unverschlüsselt“ heruntergestellt)? Nur dann darf
 * das gespeicherte Passwort mitgehen (a = gespeichert, b = neu).
 */
export function sameSmtpAccount(a, b) {
  const x = mailSettings(a), y = mailSettings(b);
  return x.host.toLowerCase() === y.host.toLowerCase() && x.port === y.port && x.user === y.user && !(y.secure === 'none' && x.secure !== 'none');
}
/**
 * Passwortfeld beim Speichern (Admin schickt pass leer = „gespeichertes behalten“, null = löschen): Das gespeicherte Passwort
 * bleibt nur, wenn der Zugang gleich bleibt — sonst ginge es an einen anderen Server. → { pass } oder { error } (für eine 400)
 */
export function keepStoredPass(prev, next, patchPass) {
  if (patchPass === null) return { pass: '' };
  if (String(patchPass ?? '')) return { pass: String(patchPass) };
  const alt = String(prev?.pass || '');
  if (!alt || sameSmtpAccount(prev, next)) return { pass: alt };
  if (!String(next?.user || '').trim()) return { pass: '' };   // ohne Benutzer keine Anmeldung — Passwort ist überflüssig
  return { error: 'E-Mail: Server, Port oder Benutzer weichen vom gespeicherten Zugang ab (oder die Verschlüsselung wurde abgeschaltet) — bitte das SMTP-Passwort neu eingeben (das gespeicherte geht nur an den bisherigen Server). Wer nur andere Einstellungen speichern wollte: Seite neu laden.' };
}

// ---------------------------------------------------------------------------
// Mailer mit Outbox-Protokoll (<dataDir>/mail-outbox.json + Inhalte in <dataDir>/mail-outbox/)
// ---------------------------------------------------------------------------
/**
 * @param {object} o
 * @param {string} o.dataDir           Ordner für mail-outbox.json
 * @param {() => object} o.getSettings  liefert das komplette Settings-Objekt (mail + company)
 * @param {(msg:string) => void} [o.log]
 * @param {number[]} [o.retryDelaysMs]  Wartezeiten vor Versuch 1..n (queue); Länge = max. Versuche
 * @param {{connect:number, command:number}} [o.timeouts]
 * @param {number} [o.outboxMax]        max. Einträge im Protokoll
 * @param {boolean} [o.unrefTimers]     Retry-Timer halten den Prozess nicht am Leben
 * @param {(e:object) => Promise<void>} [o.onFinal]  Endstand eines Eintrags (gesendet | fehler | deaktiviert) — z. B. Vermerk an der Bestellung
 *   (dazu reserviert und vermerkt = Altbestand, an der Bestellung schon beim Einreihen als „→“ vermerkt)
 * @param {(e:object) => boolean} [o.rebuildable]   lässt sich die Mail zu diesem Eintrag neu erzeugen? (kind/ref/orderId)
 * @param {(e:object) => Promise<object|null>} [o.rebuild]  Mail neu erzeugen → { to, subject, text, html, replyTo?, attachments? }
 *   (für „Erneut“ bei zugestellten Mails, deren Inhalt gelöscht ist, und für gespeicherte Mails ohne ihre Anhänge)
 * @param {number} [o.aufbewahrenMs]  Inhalt nicht zugestellter Mails so lange aufbewahren (Standard 90 Tage; Tests kürzer)
 * @param {number} [o.pflegeMs]       Abstand der Prüfung auf abgelaufene Inhalte im laufenden Betrieb (Standard täglich)
 */
export function createMailer({
  dataDir, getSettings, log = (m) => console.log('[mail]', m),
  retryDelaysMs = DEFAULT_RETRY_DELAYS, timeouts = DEFAULT_TIMEOUTS, outboxMax = OUTBOX_MAX, unrefTimers = true,
  onFinal = null, rebuildable = () => false, rebuild = null, aufbewahrenMs = MSG_AUFBEWAHREN_MS, pflegeMs = PFLEGE_MS,
} = {}) {
  if (!dataDir) throw new Error('createMailer: dataDir fehlt');
  const file = path.join(dataDir, 'mail-outbox.json');
  const msgDir = path.join(dataDir, 'mail-outbox');
  let entries = null;           // chronologisch (ältester zuerst)
  let loadP = null;
  let writeChain = Promise.resolve();
  const inflight = new Set();
  const busy = new Set();       // Eintrags-IDs mit gerade laufendem Zustellversuch → keine Doppelzustellung
  const timers = new Map();     // Eintrags-ID → geplanter automatischer Versuch
  const live = new Map();       // Eintrags-ID → Nachricht im Speicher (genau wie eingereiht, mit Anhängen) solange sie wartet
  let pflege = null;            // tägliche Prüfung auf abgelaufene Inhalte (hält den Prozess nicht am Leben)
  const delays = Array.from(retryDelaysMs || DEFAULT_RETRY_DELAYS);
  if (!delays.length) delays.push(0);

  const cfg = () => mailSettings(getSettings?.()?.mail);
  const active = (c) => c.enabled && !!c.host;
  const fromOf = (c) => {
    const email = c.from || (c.user.includes('@') ? c.user : '') || String(getSettings?.()?.company?.email || '').trim();
    return { name: c.fromName || 'formsam', email };
  };
  const track = (p) => {
    inflight.add(p);
    p.catch((e) => log(`Unerwarteter Fehler: ${e?.message || e}`)).finally(() => inflight.delete(p));
    return p;
  };
  const nowIso = () => new Date().toISOString();
  const msgFile = (id) => path.join(msgDir, `${String(id).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  /** Bezug eines Eintrags für rebuildable/rebuild/onFinal (ohne Inhalt) */
  const info = (e) => ({ id: e.id, to: e.to, subject: e.subject, kind: e.kind, ref: e.ref, orderId: e.orderId || '', key: e.key ?? null });
  const canRebuild = (e) => { try { return !!rebuild && !!rebuildable(info(e)); } catch { return false; } };

  async function load() {
    if (!loadP) {
      loadP = (async () => {
        let changed = false;
        try {
          const j = JSON.parse(await readFile(file, 'utf8'));
          entries = Array.isArray(j?.entries) ? j.entries.filter((e) => e && typeof e === 'object' && e.id) : [];
          // Altbestand (Version 1): Der alte Code hat „E-Mail … →“ schon beim Einreihen an die Bestellung geschrieben — wartende
          // Einträge merken sich das (vermerkt), damit die Zustellung keine zweite gleiche Zeile schreibt (onFinal, einmalig)
          if (j?.version !== 2) for (const e of entries) if (e.status === 'wartet' && !e.vermerkt) { e.vermerkt = true; changed = true; }
        } catch { entries = []; }
        // Altbestand (bis 11/2026): Nachricht samt Anhängen (base64) stand in mail-outbox.json → eigene Datei; bei „deaktiviert“
        // ohne Anhänge (die erzeugt „Erneut“ neu). Klappt das Schreiben nicht, bleibt sie lesbar, wo sie war.
        for (const e of entries) {
          if (e.msg && typeof e.msg === 'object') {
            if (await storeMsg(e, restoreMsg(e.msg), e.status !== 'deaktiviert')) { delete e.msg; changed = true; }
          } else if ('msg' in e) { delete e.msg; changed = true; }
        }
        if (await verfallen()) changed = true;
        await aufraeumen();
        // Nach einem Neustart: wartende Einträge zum geplanten Termin weiterversuchen (server.js ruft resume() nach dem Start)
        const finals = [];
        for (const e of entries) {
          if (e.status !== 'wartet') continue;
          const plan = e.plan ?? e.attempts ?? 0;
          if (plan < delays.length && (e.stored || e.msg || canRebuild(e))) { schedule(e); continue; }
          e.status = 'fehler'; e.endgueltig = true; e.nextAt = null;
          e.error = plan >= delays.length ? (e.error || 'Zustellung aufgegeben') : 'Versand nach Neustart nicht fortgesetzt (Nachricht nicht gespeichert)';
          changed = true; finals.push(e);
        }
        if (changed) await persist();
        for (const e of finals) track(final(e));
        if (pflegeMs > 0 && !pflege) {
          pflege = setInterval(() => track((async () => { if (await verfallen()) await persist(); })()), Math.min(pflegeMs, 2 ** 31 - 1));
          pflege.unref?.();
        }
      })();
    }
    return loadP;
  }
  function persist() {
    writeChain = writeChain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 2, entries }));   // kompakt: nur Kopfdaten, Inhalte liegen in mail-outbox/
      await rename(tmp, file);
    }).catch((e) => log(`Outbox konnte nicht gespeichert werden: ${e.message}`));
    return writeChain;
  }
  /**
   * Inhalt nicht zugestellter Mails höchstens aufbewahrenMs (90 Tage, ab Erstellung) — beim Start, bei jeder neuen Mail und
   * täglich (pflege), damit die Grenze auch ohne Neustart gilt. Wartende und gerade laufende bleiben. → true, wenn gelöscht
   */
  async function verfallen() {
    let n = 0;
    for (const e of entries || []) {
      if ((e.stored || e.msg) && e.status !== 'wartet' && !busy.has(e.id) && Date.now() - Date.parse(e.createdAt || 0) > aufbewahrenMs) { await dropMsg(e); n++; }
    }
    return n > 0;
  }
  /** Inhalts-Dateien ohne Eintrag (z. B. nach einem Absturz) und liegen gebliebene .tmp-Dateien löschen */
  async function aufraeumen() {
    let names = [];
    try { names = await readdir(msgDir); } catch { return; }
    const keep = new Set(entries.filter((e) => e.stored).map((e) => path.basename(msgFile(e.id))));
    for (const n of names) if (!keep.has(n)) await rm(path.join(msgDir, n), { force: true }).catch(() => {});
  }
  function trim() {
    if (entries.length <= outboxMax) return;
    for (const e of entries.splice(0, entries.length - outboxMax)) { clearTimer(e.id); dropMsg(e).catch(() => {}); }
  }
  function pub(e) {
    return {
      id: e.id, to: e.to, subject: e.subject, kind: e.kind, ref: e.ref, orderId: e.orderId || '', key: e.key ?? null, status: e.status, error: e.error || '',
      endgueltig: e.status === 'fehler' && !!e.endgueltig, createdAt: e.createdAt, sentAt: e.sentAt || null, attempts: e.attempts || 0,
      nextAt: e.nextAt || null, messageId: e.messageId || null, quittiert: e.quittiert || null,
      // „Erneut“: nicht zugestellte Mails aus dem Speicher (bzw. neu erzeugt), zugestellte nur, wenn sie sich neu erzeugen lassen
      resendable: e.status === 'gesendet' ? canRebuild(e) : !!(e.stored || e.msg || live.has(e.id) || canRebuild(e)),
    };
  }
  function newEntry(msg) {
    return {
      id: `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
      to: addressList(msg?.to).map((a) => a.email).join(', '),
      subject: clean(msg?.subject), kind: clean(msg?.kind), ref: clean(msg?.ref),
      orderId: clean(msg?.orderId), key: msg?.key ? clean(msg.key) : null, reserviert: msg?.reserviert || null,
      automatisch: !!msg?.automatisch,
      status: 'wartet', error: '', createdAt: nowIso(), sentAt: null, attempts: 0, plan: 0, nextAt: null, stored: 0,
    };
  }
  /**
   * Inhalt für Wiederholung/„Erneut“ in eine eigene Datei schreiben (einmal, atomar). mitAnhang=false (Versand aus) oder zu groß:
   * ohne Anhänge, deren Namen in anhaengeFehlen — beim Senden ergänzt sie rebuild(). → true, wenn gespeichert
   */
  async function storeMsg(e, msg, mitAnhang = true) {
    try {
      const atts = (msg.attachments || []).filter((a) => a && a.content != null);
      const base = { to: msg.to, subject: msg.subject, text: msg.text || '', html: msg.html || '', replyTo: msg.replyTo || '', headers: msg.headers || null };
      const belegt = entries.reduce((s, x) => s + (x !== e && x.stored ? x.stored : 0), 0);
      const passt = (j) => Buffer.byteLength(j) <= MSG_MAX && belegt + Buffer.byteLength(j) <= MSG_STORE_MAX;
      let json = null, fehlen = [];
      if (atts.length && mitAnhang) {
        const j = JSON.stringify({ ...base, attachments: atts.map((a) => ({
          filename: a.filename, contentType: a.contentType || '',
          content: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content ?? ''), 'utf8')).toString('base64'),
        })) });
        if (passt(j)) json = j;
      }
      if (!json) {
        fehlen = atts.map((a) => clean(a.filename) || 'anhang');
        const j = JSON.stringify({ ...base, attachments: [], ...(fehlen.length ? { anhaengeFehlen: fehlen } : {}) });
        if (passt(j)) json = j;
      }
      if (!json) { await dropMsg(e, { auchLive: false }); return false; }
      await mkdir(msgDir, { recursive: true });
      const f = msgFile(e.id), tmp = `${f}.${process.pid}.tmp`;
      await writeFile(tmp, json);
      await rename(tmp, f);
      e.stored = Buffer.byteLength(json);
      if (fehlen.length) e.anhaengeFehlen = fehlen; else delete e.anhaengeFehlen;
      return true;
    } catch (err) {
      log(`Nachricht für erneuten Versand nicht gespeichert: ${err.message}`);
      return false;
    }
  }
  async function dropMsg(e, { auchLive = true } = {}) {
    if (auchLive) live.delete(e.id);
    delete e.msg; delete e.anhaengeFehlen;
    if (e.stored) { e.stored = 0; await rm(msgFile(e.id), { force: true }).catch(() => {}); }
  }
  function restoreMsg(m) {
    return { ...m, attachments: (m.attachments || []).map((a) => ({ ...a, content: Buffer.from(a.content || '', 'base64') })) };
  }
  async function loadMsg(e) {
    if (e.msg && typeof e.msg === 'object') return restoreMsg(e.msg);
    if (!e.stored) return null;
    try { return restoreMsg(JSON.parse(await readFile(msgFile(e.id), 'utf8'))); } catch { return null; }
  }
  /** Nachricht zum Senden: im Speicher → gespeichert (vollständig) → neu erzeugt → gespeichert ohne Anhänge. null = nichts da */
  async function msgFor(e) {
    if (live.has(e.id)) return live.get(e.id);
    const m = await loadMsg(e);
    if (m && !m.anhaengeFehlen?.length) return m;
    if (canRebuild(e)) {
      try { const r = await rebuild(info(e)); if (r) return r; }
      catch (err) { if (!m) throw err; }
    }
    return m;
  }
  async function final(e) {
    // vermerkt (Altbestand, siehe load): gilt nur für den ersten Endstand — eine spätere Zustellung per „Erneut“ wird wieder vermerkt
    const vermerkt = !!e.vermerkt;
    if (vermerkt) { delete e.vermerkt; await persist(); }
    if (!onFinal) return;
    try { await onFinal({ ...pub(e), reserviert: e.reserviert || null, vermerkt }); } catch (err) { log(`Vermerk zur Mail an ${e.to} fehlgeschlagen: ${err?.message || err}`); }
  }
  function clearTimer(id) { const t = timers.get(id); if (t) { clearTimeout(t); timers.delete(id); } }
  /** Nächsten automatischen Versuch zum Termin nextAt planen (leer/vergangen = sofort) */
  function schedule(e) {
    clearTimer(e.id);
    if (e.status !== 'wartet') return;
    const wait = Math.min(Math.max(0, (Date.parse(e.nextAt || '') || 0) - Date.now()), 2 ** 31 - 1);
    const t = setTimeout(() => { timers.delete(e.id); track(autoAttempt(e)); }, wait);
    if (unrefTimers && t.unref) t.unref();
    timers.set(e.id, t);
  }

  /** Ein Zustellversuch. → 'ok' | 'retry' (vorübergehend) | 'stop' (endgültig / deaktiviert) */
  async function attempt(e, msg) {
    if (e.status === 'gesendet') return 'ok';   // letzte Sicherung gegen Doppelzustellung
    const c = cfg();
    if (!active(c)) {
      e.status = 'deaktiviert'; e.error = 'E-Mail-Versand ist nicht eingerichtet'; e.nextAt = null;
      return 'stop';
    }
    e.attempts = (e.attempts || 0) + 1;
    let built;
    try {
      // Automatische Mails (RFC 3834): Abwesenheitsnotizen u. ä. antworten darauf nicht
      const headers = { ...(msg.headers || {}), ...(e.automatisch ? { 'Auto-Submitted': 'auto-generated' } : {}) };
      built = buildMessage({
        from: fromOf(c), to: msg.to, replyTo: msg.replyTo || c.replyTo, subject: msg.subject,
        text: msg.text, html: msg.html, attachments: msg.attachments, headers,
      });
    } catch (err) {
      e.status = 'fehler'; e.endgueltig = true; e.error = err.message; e.nextAt = null;
      return 'stop';
    }
    const r = await smtpSend(c, built, { timeouts });
    if (r.ok) {
      e.status = 'gesendet'; e.sentAt = nowIso(); e.error = ''; e.nextAt = null; e.messageId = built.id; delete e.endgueltig;
      log(`gesendet → ${e.to} „${e.subject}“`);
      return 'ok';
    }
    e.error = r.error;
    log(`Versand an ${e.to} fehlgeschlagen (Versuch ${e.attempts}): ${r.error}`);
    if (r.permanent) {   // 5xx / Konfigurationsfehler: Wiederholen bringt nichts (und provoziert z. B. Login-Sperren)
      e.status = 'fehler'; e.endgueltig = true; e.nextAt = null;
      return 'stop';
    }
    return 'retry';
  }

  /** Automatischer Versuch der Warteschlange; danach nächster Termin, Endstand oder Aufgabe nach dem letzten Versuch */
  async function autoAttempt(e, given = null) {
    if (e.status !== 'wartet' || busy.has(e.id)) return;
    busy.add(e.id);
    try {
      let msg = given || live.get(e.id) || null;
      if (!msg) { try { msg = await msgFor(e); } catch (err) { e.error = err.message; } }
      if (!msg) {
        e.status = 'fehler'; e.endgueltig = true; e.nextAt = null; e.error = e.error || 'Nachricht nicht mehr gespeichert — bitte neu erzeugen';
      } else {
        e.plan = (e.plan ?? e.attempts ?? 0) + 1;
        const res = await attempt(e, msg);
        if (res === 'retry') {
          if (e.plan < delays.length) { e.status = 'wartet'; e.nextAt = new Date(Date.now() + delays[e.plan]).toISOString(); }
          else { e.status = 'fehler'; e.endgueltig = true; e.nextAt = null; e.error = `${e.error} — nach ${e.attempts} Versuchen aufgegeben`; }
        }
      }
      if (e.status === 'gesendet') await dropMsg(e);
      else if (e.status !== 'wartet') live.delete(e.id);
      await persist();
    } finally { busy.delete(e.id); }
    if (e.status === 'wartet') schedule(e); else await final(e);
  }

  const api = {
    /** Sofort senden (Admin); Ergebnis nach dem Versuch. Protokolliert immer — nicht Zugestelltes bleibt für „Erneut“ gespeichert. */
    async send(msg) {
      await load();
      await verfallen();   // gespeichert mit dem nächsten persist()
      const e = newEntry(msg);
      entries.push(e); trim();
      await persist();
      busy.add(e.id);
      let res;
      try {
        res = await track(attempt(e, msg));
        if (res === 'retry') e.status = 'fehler';
        if (e.status !== 'gesendet') await storeMsg(e, msg, active(cfg()));
        await persist();
      } finally { busy.delete(e.id); }
      await final(e);
      return res === 'ok' ? { ok: true, id: e.id } : { ok: false, id: e.id, error: e.error };
    },
    /** Eintrag anlegen und im Hintergrund zustellen (bis zu retryDelaysMs.length Versuche, Stand übersteht Neustarts). */
    async queue(msg) {
      await load();
      await verfallen();
      const e = newEntry({ automatisch: true, ...msg });
      await storeMsg(e, msg, active(cfg()));   // Versand aus: nur Kopf/Text, ohne Anhänge
      entries.push(e); trim();
      await persist();
      live.set(e.id, msg);
      if (delays[0] > 0) { e.nextAt = new Date(Date.now() + delays[0]).toISOString(); await persist(); schedule(e); }
      else track(autoAttempt(e, msg));   // läuft bis zum ersten await synchron → „deaktiviert“ steht sofort im Rückgabewert
      return pub(e);
    },
    /**
     * Verbindungs-/Anmeldetest mit Testmail; override = Felder wie settings.mail. pass leer = gespeichertes — aber nur für den
     * gespeicherten Zugang (Host, Port, Benutzer, nicht unverschlüsselt — sameSmtpAccount); sonst muss es eingegeben werden.
     */
    async test(settingsOverride, to) {
      const cur = cfg();
      const o = { ...(settingsOverride || {}) };
      const c0 = mailSettings({ ...cur, ...o, enabled: true });
      if (!o.pass) {
        if (sameSmtpAccount(cur, c0)) delete o.pass;
        else if (c0.user && c0.host) return { ok: false, error: 'Bitte das Passwort eingeben: Server, Port oder Benutzer weichen vom gespeicherten Zugang ab (oder die Verschlüsselung ist aus) — das gespeicherte Passwort geht nur an den gespeicherten Server.', log: [] };
        else o.pass = '';
      }
      const c = mailSettings({ ...cur, ...o, enabled: true });
      if (!c.host) return { ok: false, error: 'Kein SMTP-Server (Host) angegeben', log: [] };
      const from = fromOf(c);
      const rcpt = clean(to) || c.adminTo || from.email;
      if (!rcpt) return { ok: false, error: 'Keine Empfängeradresse für die Testmail', log: [] };
      const when = new Date().toLocaleString('de-DE', { timeZone: 'Europe/Berlin' });
      let built;
      try {
        built = buildMessage({
          from, to: rcpt, replyTo: c.replyTo,
          subject: 'formsam Testmail ✔ — der E-Mail-Versand funktioniert',
          text: `Hallo!\n\nDiese Testmail wurde am ${when} vom formsam-Shop über ${c.host}:${c.port} (${c.secure}) verschickt.\nWenn du sie liest, ist der Versand korrekt eingerichtet.\n\nViele Grüße\ndein formsam-Shop`,
          html: `<!DOCTYPE html><html lang="de"><body style="margin:0;background:#f4efe7;padding:28px 12px;font-family:Helvetica,Arial,sans-serif;color:#211d18;">` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
            `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fbf8f2;border-radius:18px;">` +
            `<tr><td style="padding:30px;font-size:15px;line-height:1.55;"><h1 style="margin:0 0 12px;font-family:Georgia,serif;font-weight:normal;font-size:24px;">Testmail ✔</h1>` +
            `<p style="margin:0 0 10px;">Diese Testmail wurde am <b>${escHtml(when)}</b> vom formsam-Shop über <b>${escHtml(`${c.host}:${c.port}`)}</b> (${escHtml(c.secure)}) verschickt.</p>` +
            `<p style="margin:0;">Wenn du sie liest, ist der Versand korrekt eingerichtet. <span style="color:#9e4f2c;">Viele Grüße, dein formsam-Shop</span></p></td></tr></table></td></tr></table></body></html>`,
        });
      } catch (e) { return { ok: false, error: e.message, log: [] }; }
      const r = await smtpSend(c, built, { timeouts });
      return r.ok ? { ok: true, log: r.log } : { ok: false, error: r.error, log: r.log };
    },
    /** Protokoll, neueste zuerst (ohne Nachrichtentexte). */
    async list({ limit = 200 } = {}) {
      await load();
      const n = Math.max(1, Math.min(outboxMax, parseInt(limit, 10) || 200));
      return entries.slice(-n).reverse().map(pub);
    },
    /**
     * Für die Admin-Übersicht: endgültig gescheiterte Mails der letzten 30 Tage (nicht ausgeblendet) und die Zahl der Mails,
     * die gerade auf einen weiteren Versuch warten.
     */
    async problems({ tage = PROBLEM_TAGE } = {}) {
      await load();
      const seit = Date.now() - tage * 864e5;
      const fehler = entries.filter((e) => e.status === 'fehler' && !e.quittiert && Date.parse(e.createdAt || 0) >= seit).reverse().map(pub);
      const wartend = entries.filter((e) => e.status === 'wartet');
      return { fehler, wartet: wartend.length, wartetSeit: wartend[0]?.createdAt || null };
    },
    /** Gescheiterte Mail(s) in der Übersicht ausblenden (id oder 'alle'); im Protokoll bleiben sie. */
    async quittieren(id) {
      await load();
      let n = 0;
      for (const e of entries) if (e.status === 'fehler' && !e.quittiert && (id === 'alle' || e.id === id)) { e.quittiert = nowIso(); n++; }
      if (n) await persist();
      return { ok: true, n };
    },
    /**
     * „Erneut“: nicht zugestellte Mail (fehler/deaktiviert, auch eine wartende — dann ohne die Wartezeit) jetzt zustellen;
     * eine zugestellte Mail neu erzeugen und als neuen Eintrag senden (ihr Inhalt ist nach der Zustellung gelöscht).
     */
    async resend(id) {
      await load();
      const e = entries.find((x) => x.id === id);
      if (!e) return { ok: false, error: 'Eintrag nicht gefunden' };
      if (busy.has(e.id)) return { ok: false, error: 'Zustellung läuft gerade — bitte einen Moment warten und die Liste aktualisieren' };
      if (e.status === 'gesendet') {
        if (!canRebuild(e)) return { ok: false, error: 'Diese Mail ist zugestellt, ihr Inhalt wird danach nicht aufbewahrt — bitte in der Bestellung neu senden' };
        let m;
        try { m = await rebuild(info(e)); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
        if (!m) return { ok: false, error: 'Die Mail lässt sich nicht mehr neu erzeugen — bitte in der Bestellung neu senden' };
        return api.send({ ...m, kind: e.kind, ref: e.ref, orderId: e.orderId, key: e.key });
      }
      let msg;
      try { msg = await msgFor(e); } catch (err) { return { ok: false, error: err?.message || String(err) }; }
      if (!msg) return { ok: false, error: 'Nachricht ist nicht mehr gespeichert — bitte in der Bestellung neu senden' };
      busy.add(e.id);
      clearTimer(e.id);
      const vorher = e.status;
      try {
        const res = await track(attempt(e, msg));
        // Wartende Mail: ein gescheiterter Handversuch ändert den Plan nicht (nächster automatischer Versuch wie vorgesehen)
        if (res === 'retry') e.status = vorher === 'wartet' ? 'wartet' : 'fehler';
        if (e.status === 'gesendet') await dropMsg(e);
        else if (!e.stored) await storeMsg(e, msg, active(cfg()));   // z. B. neu erzeugte Fassung → für den nächsten Versuch
        await persist();
      } finally { busy.delete(e.id); }
      if (e.status === 'wartet') schedule(e); else await final(e);
      return e.status === 'gesendet' ? { ok: true } : { ok: false, error: e.error };
    },
    /** Outbox laden und wartende Einträge weiterverarbeiten — nach dem Serverstart aufrufen. */
    resume() { return load(); },
    /** Löst auf, sobald keine Zustellung mehr läuft und keine geplant ist (Tests mit kurzen Abständen, sauberes Herunterfahren). */
    async whenIdle() {
      await load();
      for (;;) {
        if (inflight.size) { await Promise.allSettled([...inflight]); continue; }
        if (timers.size) { await new Promise((r) => setTimeout(r, 5)); continue; }
        break;
      }
      await writeChain;
    },
    /** Geplante Versuche anhalten (Tests; der Stand bleibt in der Outbox und geht beim nächsten Start weiter). */
    stop() { for (const id of [...timers.keys()]) clearTimer(id); if (pflege) { clearInterval(pflege); pflege = null; } },
    /** Aktuelle, normalisierte Mail-Einstellungen (ohne Passwort). */
    config() { const c = cfg(); return { ...c, pass: c.pass ? '••••' : '', active: active(c) }; },
    file,
  };
  return api;
}
