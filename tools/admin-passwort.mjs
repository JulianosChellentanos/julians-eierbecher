// formsam — Admin-Passwort auf dem Server setzen (ohne Admin-Oberfläche), z. B. wenn es vergessen ist oder nach der Neuinstallation.
// Aufruf (im Projektordner, Shop-Server vorher stoppen — er hält die Einstellungen im Speicher und würde sie überschreiben):
//   node tools/admin-passwort.mjs <neues-passwort>   setzt das Passwort (8–200 Zeichen)
//   node tools/admin-passwort.mjs --zufall           erzeugt ein zufälliges Passwort und zeigt es einmal an
// Gespeichert wird nur der scrypt-Hash (settings.adminKeyHash, Format wie server.js: scrypt$salt$hash); ein altes Klartext-adminKey
// wird durch einen zufälligen Platzhalter ersetzt (adminKeyPlatzhalter = SHA-256 davon, wie server.js — eine ältere Fassung sperrt
// damit den Admin, statt das frühere Standard-Passwort zu nehmen). Datenordner wie beim Server: DATA_DIR=… (Standard: ./data).
// Fehlt settings.json, entsteht eine mit nur dem Passwort (der Server ergänzt beim Start die Standardwerte).
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const arg = process.argv[2];
if (!arg) {
  console.error('Aufruf: node tools/admin-passwort.mjs <neues-passwort> | --zufall   (Shop-Server vorher stoppen)');
  process.exit(1);
}
const zufall = arg === '--zufall';
const pw = zufall ? crypto.randomBytes(15).toString('base64url') : arg.trim();
if (pw.length < 8 || pw.length > 200) { console.error('❌ Admin-Passwort: 8 bis 200 Zeichen'); process.exit(1); }

const dir = path.resolve(process.env.DATA_DIR || 'data');
const file = path.join(dir, 'settings.json');
let settings = {};
if (existsSync(file)) {
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('kein JSON-Objekt');
  } catch (err) {
    console.error(`❌ ${file} ist beschädigt (${err.message}) – bitte erst reparieren oder aus der Sicherung (/var/backups/formsam) zurückholen.`);
    process.exit(1);
  }
} else mkdirSync(dir, { recursive: true });

const salt = crypto.randomBytes(16).toString('hex');
settings.adminKeyHash = `scrypt$${salt}$${crypto.scryptSync(pw, salt, 32).toString('hex')}`;
settings.adminKey = crypto.randomBytes(24).toString('base64url');
settings.adminKeyPlatzhalter = crypto.createHash('sha256').update(settings.adminKey).digest('hex');
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(settings, null, 2));
renameSync(tmp, file);
console.log(`✅ Admin-Passwort gesetzt${zufall ? `: ${pw}  (wird nicht gespeichert – bitte notieren)` : ''} — ${file}. Jetzt den Shop-Server (neu) starten.`);
