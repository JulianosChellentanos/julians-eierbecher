// OVJU — E-Mail-Versand: schlanker SMTP-Client (nur Node-Built-ins) + Outbox-Protokoll
//
//   import { createMailer } from './lib/mailer.js';
//   const mailer = createMailer({ dataDir, getSettings: () => settings, log });
//   await mailer.send({ to, subject, text, html, kind: 'bestellung', ref: orderId });
//
// Unterstützt: EHLO, STARTTLS (RFC 3207), direktes TLS (465) oder unverschlüsselt,
// AUTH PLAIN / AUTH LOGIN (RFC 4954), Dot-Stuffing, Mehrzeilenantworten, Timeouts.
// Nachrichten: RFC 5322 + MIME (multipart/alternative, optional multipart/mixed mit Anhängen),
// UTF-8 in Headern als =?UTF-8?B?…?=, Textteile quoted-printable, Anhänge base64.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises';

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
  fromName: 'OVJU',
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
export const DEFAULT_RETRY_DELAYS = Object.freeze([0, 60_000, 600_000]);   // sofort, +60 s, +10 min
const OUTBOX_MAX = 500;
const ENTRY_MSG_MAX = 200 * 1024;   // gespeicherte Nachricht je Eintrag (für erneuten Versand)

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
function assertAddress(a, what) {
  if (!ADDR_RE.test(a.email)) throw new Error(`Ungültige ${what}: „${a.email || '(leer)'}“`);
  return a;
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
function formatAddress(a) {
  return a.name ? `${encodeWord(a.name)} <${a.email}>` : a.email;
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
 * @returns {{ id:string, raw:string, from:string, rcpts:string[] }}
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

  const boundary = () => `=_ovju_${crypto.randomBytes(12).toString('hex')}`;
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
  const domain = fromA.email.split('@')[1] || os.hostname() || 'ovju.local';
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
    'X-Mailer: OVJU Shop',
    ...Object.entries(extraHeaders || {}).map(([k, v]) => `${clean(k)}: ${clean(v)}`),
  ].filter(Boolean);
  return { id, raw: head.join('\r\n') + '\r\n\r\n' + body, from: fromA.email, rcpts: toList.map((a) => a.email) };
}

/** Dot-Stuffing (RFC 5321 4.5.2): Zeilen, die mit "." beginnen, bekommen ein zweites */
export function dotStuff(raw) {
  return raw.replace(/(^|\r\n)\./g, '$1..');
}

// ---------------------------------------------------------------------------
// SMTP-Verbindung
// ---------------------------------------------------------------------------
const CERT_CODES = new Set(['DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_SSL_WRONG_VERSION_NUMBER']);
function describeError(e) {
  const code = e?.code || '';
  let msg = code ? `${code}${e.message && !e.message.includes(code) ? ' – ' + e.message : ''}` : (e?.message || String(e));
  if (CERT_CODES.has(code)) msg += ' (Zertifikat nicht vertrauenswürdig — bei eigenem Testserver „selbstsigniertes Zertifikat erlauben“ aktivieren)';
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
    const g = await this.read();
    this.logResponse(g);
    if (g.code !== 220) throw new Error(`Server begrüßt nicht (${g.code} ${g.text})`);
  }

  attach(sock) {
    this.sock = sock;
    this.buf = ''; this.lines = [];
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
    const ext = { starttls: false, auth: [], size: 0 };
    for (const l of r.lines.slice(1)) {
      const kw = l.slice(4).trim();
      if (/^STARTTLS$/i.test(kw)) ext.starttls = true;
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
    if (!mech) throw permanentError(`Server bietet keine unterstützte Anmeldung an (${avail.join(', ') || 'keine'}) — OVJU kann PLAIN und LOGIN`);
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
export async function smtpSend(cfgRaw, { from, rcpts, raw }, opts = {}) {
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
      await conn.upgradeTls();
      ext = await conn.ehlo();
    }
    if (cfg.user) await conn.auth(ext.auth);
    const size = Buffer.byteLength(raw);
    if (ext.size && size > ext.size) throw permanentError(`Nachricht zu groß für den Server (${Math.round(size / 1024)} kB > ${Math.round(ext.size / 1024)} kB)`);
    await conn.cmd(`MAIL FROM:<${from}>`, [250]);
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
// Mailer mit Outbox-Protokoll (<dataDir>/mail-outbox.json)
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
 */
export function createMailer({
  dataDir, getSettings, log = (m) => console.log('[mail]', m),
  retryDelaysMs = DEFAULT_RETRY_DELAYS, timeouts = DEFAULT_TIMEOUTS, outboxMax = OUTBOX_MAX, unrefTimers = true,
} = {}) {
  if (!dataDir) throw new Error('createMailer: dataDir fehlt');
  const file = path.join(dataDir, 'mail-outbox.json');
  let entries = null;           // chronologisch (ältester zuerst)
  let loadP = null;
  let writeChain = Promise.resolve();
  const inflight = new Set();
  const running = new Set();    // Eintrags-IDs mit laufender Zustellung (Retry-Schleife oder „Erneut“) → keine Doppelzustellung
  const delays = Array.from(retryDelaysMs || DEFAULT_RETRY_DELAYS);
  if (!delays.length) delays.push(0);

  const cfg = () => mailSettings(getSettings?.()?.mail);
  const active = (c) => c.enabled && !!c.host;
  const fromOf = (c) => {
    const email = c.from || (c.user.includes('@') ? c.user : '') || String(getSettings?.()?.company?.email || '').trim();
    return { name: c.fromName || 'OVJU', email };
  };
  const sleep = (ms) => new Promise((r) => { const t = setTimeout(r, ms); if (unrefTimers && t.unref) t.unref(); });
  const track = (p) => {
    inflight.add(p);
    p.catch((e) => log(`Unerwarteter Fehler: ${e?.message || e}`)).finally(() => inflight.delete(p));
    return p;
  };

  async function load() {
    if (!loadP) {
      loadP = (async () => {
        try {
          const j = JSON.parse(await readFile(file, 'utf8'));
          entries = Array.isArray(j?.entries) ? j.entries : [];
        } catch { entries = []; }
        // Nach einem Neustart: wartende Einträge weiterverarbeiten (server.js ruft resume() nach dem Start)
        let changed = false;
        for (const e of entries) {
          if (e.status === 'wartet' && e.msg && e.attempts < delays.length) track(runQueue(e, restoreMsg(e.msg)));
          else if (e.status === 'wartet') { e.status = 'fehler'; e.error = e.error || 'Versand nach Neustart nicht fortgesetzt'; changed = true; }
        }
        if (changed) await persist();
      })();
    }
    return loadP;
  }
  function persist() {
    writeChain = writeChain.then(async () => {
      await mkdir(dataDir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify({ version: 1, entries }, null, 1));
      await rename(tmp, file);
    }).catch((e) => log(`Outbox konnte nicht gespeichert werden: ${e.message}`));
    return writeChain;
  }
  function trim() {
    if (entries.length > outboxMax) entries.splice(0, entries.length - outboxMax);
  }
  function pub(e) {
    return {
      id: e.id, to: e.to, subject: e.subject, kind: e.kind, ref: e.ref, status: e.status, error: e.error || '',
      createdAt: e.createdAt, sentAt: e.sentAt || null, attempts: e.attempts || 0, nextAt: e.nextAt || null,
      messageId: e.messageId || null, resendable: !!e.msg,
    };
  }
  function newEntry(msg) {
    return {
      id: `${Date.now().toString(36)}${crypto.randomBytes(4).toString('hex')}`,
      to: addressList(msg?.to).map((a) => a.email).join(', '),
      subject: clean(msg?.subject), kind: clean(msg?.kind), ref: clean(msg?.ref),
      status: 'wartet', error: '', createdAt: new Date().toISOString(), sentAt: null, attempts: 0, nextAt: null, msg: null,
    };
  }
  /** Nachricht für erneuten Versand mitspeichern (≤ ENTRY_MSG_MAX) */
  function storeMsg(e, msg) {
    const stored = {
      to: msg.to, subject: msg.subject, text: msg.text || '', html: msg.html || '', replyTo: msg.replyTo || '',
      attachments: (msg.attachments || []).map((a) => ({
        filename: a.filename, contentType: a.contentType || '',
        content: (Buffer.isBuffer(a.content) ? a.content : Buffer.from(String(a.content ?? ''), 'utf8')).toString('base64'),
      })),
    };
    if (Buffer.byteLength(JSON.stringify(stored)) <= ENTRY_MSG_MAX) e.msg = stored;
    else { e.msg = null; e.error = `${e.error ? e.error + ' · ' : ''}Nachricht zu groß, kein erneuter Versand möglich`; }
  }
  function restoreMsg(m) {
    return {
      ...m,
      attachments: (m.attachments || []).map((a) => ({ ...a, content: Buffer.from(a.content || '', 'base64') })),
    };
  }

  /** Ein Zustellversuch. → 'ok' | 'retry' (temporär) | 'stop' (endgültig / deaktiviert) */
  async function attempt(e, msg) {
    if (e.status === 'gesendet') return 'ok';   // letzte Sicherung gegen Doppelzustellung
    const c = cfg();
    if (!active(c)) {
      e.status = 'deaktiviert'; e.error = 'E-Mail-Versand ist nicht eingerichtet'; e.nextAt = null;
      storeMsg(e, msg);
      return 'stop';
    }
    e.attempts = (e.attempts || 0) + 1;
    let built;
    try {
      built = buildMessage({
        from: fromOf(c), to: msg.to, replyTo: msg.replyTo || c.replyTo, subject: msg.subject,
        text: msg.text, html: msg.html, attachments: msg.attachments,
      });
    } catch (err) {
      e.status = 'fehler'; e.error = err.message; e.nextAt = null;
      return 'stop';
    }
    const r = await smtpSend(c, built, { timeouts });
    if (r.ok) {
      e.status = 'gesendet'; e.sentAt = new Date().toISOString(); e.error = ''; e.nextAt = null; e.messageId = built.id; e.msg = null;
      log(`gesendet → ${e.to} „${e.subject}“`);
      return 'ok';
    }
    e.error = r.error;
    log(`Versand an ${e.to} fehlgeschlagen (Versuch ${e.attempts}): ${r.error}`);
    if (r.permanent) {   // 5xx / Konfigurationsfehler: Wiederholen bringt nichts (und provoziert z. B. Login-Sperren)
      e.status = 'fehler'; e.nextAt = null; storeMsg(e, msg);
      return 'stop';
    }
    return 'retry';
  }

  async function runQueue(e, msg) {
    running.add(e.id);
    try {
      while (e.attempts < delays.length) {
        const delay = delays[e.attempts];
        if (delay > 0) { e.nextAt = new Date(Date.now() + delay).toISOString(); await persist(); await sleep(delay); }
        e.nextAt = null;
        // inzwischen anderweitig erledigt (z. B. „Erneut“ im Admin)? Dann nicht noch einmal senden
        if (e.status !== 'wartet') { await persist(); return; }
        const res = await attempt(e, msg);
        if (res === 'ok' || res === 'stop') { await persist(); return; }
        if (e.attempts < delays.length) { e.status = 'wartet'; storeMsg(e, msg); }
        else { e.status = 'fehler'; e.nextAt = null; storeMsg(e, msg); }
        await persist();
      }
    } finally { running.delete(e.id); }
  }

  return {
    /** Sofort senden; Ergebnis nach dem Versuch. Protokolliert immer. */
    async send(msg) {
      await load();
      const e = newEntry(msg);
      entries.push(e); trim();
      await persist();
      const res = await track(attempt(e, msg));
      if (res === 'retry') { e.status = 'fehler'; storeMsg(e, msg); }
      await persist();
      return res === 'ok' ? { ok: true, id: e.id } : { ok: false, id: e.id, error: e.error };
    },
    /** Eintrag anlegen und im Hintergrund zustellen (bis zu retryDelaysMs.length Versuche). */
    async queue(msg) {
      await load();
      const e = newEntry(msg);
      storeMsg(e, msg);
      entries.push(e); trim();
      await persist();
      track(runQueue(e, msg));
      return pub(e);
    },
    /** Verbindungs-/Anmeldetest mit Testmail; override = Felder wie settings.mail (pass leer = gespeichertes). */
    async test(settingsOverride, to) {
      const cur = cfg();
      const o = { ...(settingsOverride || {}) };
      if (!o.pass) delete o.pass;
      const c = mailSettings({ ...cur, ...o, enabled: true });
      if (!c.host) return { ok: false, error: 'Kein SMTP-Server (Host) angegeben', log: [] };
      const from = fromOf(c);
      const rcpt = clean(to) || c.adminTo || from.email;
      if (!rcpt) return { ok: false, error: 'Keine Empfängeradresse für die Testmail', log: [] };
      const when = new Date().toLocaleString('de-DE');
      let built;
      try {
        built = buildMessage({
          from, to: rcpt, replyTo: c.replyTo,
          subject: 'OVJU Testmail ✔ — der E-Mail-Versand funktioniert',
          text: `Hallo!\n\nDiese Testmail wurde am ${when} vom OVJU-Shop über ${c.host}:${c.port} (${c.secure}) verschickt.\nWenn du sie liest, ist der Versand korrekt eingerichtet.\n\nViele Grüße\nDein OVJU-Shop`,
          html: `<!DOCTYPE html><html lang="de"><body style="margin:0;background:#f4efe7;padding:28px 12px;font-family:Helvetica,Arial,sans-serif;color:#211d18;">` +
            `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td align="center">` +
            `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;background:#fbf8f2;border-radius:18px;">` +
            `<tr><td style="padding:30px;font-size:15px;line-height:1.55;"><h1 style="margin:0 0 12px;font-family:Georgia,serif;font-weight:normal;font-size:24px;">Testmail ✔</h1>` +
            `<p style="margin:0 0 10px;">Diese Testmail wurde am <b>${escHtml(when)}</b> vom OVJU-Shop über <b>${escHtml(`${c.host}:${c.port}`)}</b> (${escHtml(c.secure)}) verschickt.</p>` +
            `<p style="margin:0;">Wenn du sie liest, ist der Versand korrekt eingerichtet. <span style="color:#c86f4a;">Viele Grüße, dein OVJU-Shop</span></p></td></tr></table></td></tr></table></body></html>`,
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
    /** Eintrag erneut zustellen (nur wenn die Nachricht noch gespeichert ist und gerade keine Zustellung läuft). */
    async resend(id) {
      await load();
      const e = entries.find((x) => x.id === id);
      if (!e) return { ok: false, error: 'Eintrag nicht gefunden' };
      if (!e.msg) return { ok: false, error: 'Nachricht ist nicht mehr gespeichert — bitte neu erzeugen' };
      if (running.has(e.id)) {   // Retry-Timer aktiv oder Doppelklick → sonst käme die Mail zweimal an
        const when = e.nextAt ? `um ${new Date(e.nextAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}` : 'in Kürze';
        return { ok: false, error: `Zustellung läuft noch — nächster automatischer Versuch ${when}` };
      }
      running.add(e.id);
      try {
        const msg = restoreMsg(e.msg);
        const res = await track(attempt(e, msg));
        if (res === 'retry') e.status = 'fehler';
        await persist();
        return res === 'ok' ? { ok: true } : { ok: false, error: e.error };
      } finally { running.delete(e.id); }
    },
    /** Outbox laden und wartende Einträge weiterverarbeiten — nach dem Serverstart aufrufen. */
    resume() { return load(); },
    /** Löst auf, sobald keine Zustellung mehr läuft (Tests, sauberes Herunterfahren). */
    async whenIdle() {
      await load();
      while (inflight.size) await Promise.allSettled([...inflight]);
      await writeChain;
    },
    /** Aktuelle, normalisierte Mail-Einstellungen (ohne Passwort). */
    config() { const c = cfg(); return { ...c, pass: c.pass ? '••••' : '', active: active(c) }; },
    file,
  };
}
