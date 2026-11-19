// formsam — Wartungsmodus auf dem Server schalten (ohne Admin-Oberfläche), z. B. beim Einrichten eines neuen Servers.
// Aufruf (im Projektordner, Shop-Server vorher stoppen — er hält die Einstellungen im Speicher und würde sie überschreiben):
//   node tools/wartung.mjs an <kennwort>    Wartungsseite davor, Zugang nur mit Kennwort (neues Kennwort = alte Freigaben ungültig)
//   node tools/wartung.mjs an               wieder einschalten mit dem zuletzt gesetzten Kennwort
//   node tools/wartung.mjs aus              Shop für alle sichtbar
//   node tools/wartung.mjs status
// Datenordner wie beim Server: DATA_DIR=… (Standard: ./data). Format des Hashes wie server.js (scrypt$salt$hash).
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const [, , cmd = 'status', kennwort] = process.argv;
const file = path.join(path.resolve(process.env.DATA_DIR || 'data'), 'settings.json');
if (!existsSync(file)) { console.error(`❌ ${file} fehlt — einmal den Server starten, dann gibt es die Einstellungen.`); process.exit(1); }
const settings = JSON.parse(readFileSync(file, 'utf8'));
const w = { aktiv: false, hash: '', secret: '', ...(settings.wartung || {}) };

if (cmd === 'status') {
  console.log(`Wartungsmodus: ${w.aktiv && w.hash ? 'AN' : 'aus'}${w.hash ? ' (Kennwort gesetzt)' : ' (kein Kennwort gesetzt)'} — ${file}`);
  process.exit(0);
}
if (cmd === 'an') {
  if (kennwort !== undefined) {
    if (kennwort.trim().length < 6) { console.error('❌ Kennwort: mindestens 6 Zeichen'); process.exit(1); }
    const salt = crypto.randomBytes(16).toString('hex');
    w.hash = `scrypt$${salt}$${crypto.scryptSync(kennwort.trim(), salt, 32).toString('hex')}`;
    w.secret = crypto.randomBytes(32).toString('base64url');
  }
  if (!w.hash) { console.error('❌ Noch kein Kennwort gesetzt: node tools/wartung.mjs an <kennwort>'); process.exit(1); }
  w.aktiv = true;
} else if (cmd === 'aus') {
  w.aktiv = false;
} else {
  console.error('Aufruf: node tools/wartung.mjs an [kennwort] | aus | status');
  process.exit(1);
}
settings.wartung = w;
const tmp = `${file}.tmp-${process.pid}`;
writeFileSync(tmp, JSON.stringify(settings, null, 2));
renameSync(tmp, file);
console.log(`✅ Wartungsmodus ${w.aktiv ? 'AN' : 'aus'} — jetzt den Shop-Server (neu) starten.`);
