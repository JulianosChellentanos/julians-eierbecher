#!/usr/bin/env bash
# formsam — Produktivserver auf den aktuellen Stand von GitHub (main) bringen. Läuft AUF dem Produktivserver als root:
#   bash /srv/formsam/deploy/prod-update.sh             sichern, main holen, Syntax prüfen, neu starten, Erreichbarkeit prüfen
#   bash /srv/formsam/deploy/prod-update.sh --zurueck   Code auf den Stand vor dem letzten Update zurück (Daten bleiben)
#   bash /srv/formsam/deploy/prod-update.sh --pruefen   nur Betriebsdateien prüfen (Sicherung, Protokoll-Aufbewahrung)
# Daten (data/, orders/, Galerie-Bilder) sind nicht im Git und bleiben unberührt. Vorher wird gesichert — schlägt die
# Sicherung fehl, bricht das Update ab, ohne etwas zu ändern. Den alten Stand merkt sich das Skript in
# /var/backups/formsam/letztes-update. Startet der neue Stand nicht (Syntaxfehler, Dienst antwortet nicht binnen 60 s),
# geht es automatisch auf den alten Stand zurück.
# Das Skript liest sich vor dem Ausführen ganz ein (Aufruf von main in der letzten Zeile) — git reset darf die Datei ersetzen.
set -euo pipefail
# Pfade (APP, BACKUP, ZUSTAND, PRUEF_URL) lassen sich nur für Tests per Umgebung umbiegen
APP=${APP:-/srv/formsam}
BACKUP=${BACKUP:-/usr/local/sbin/formsam-backup}
ZUSTAND=${ZUSTAND:-/var/backups/formsam/letztes-update}
PRUEF_URL=${PRUEF_URL:-http://127.0.0.1:4488/api/pricing}

als_formsam() { sudo -u formsam "$@"; }

# Shop antwortet? 200 = läuft; 503 mit X-Formsam-Wartung = läuft im Wartungsmodus. Bis zu 60 s (der Start liest vorher alle Bestellungen).
laeuft() {
  local i kopf code
  for i in $(seq 1 60); do
    if systemctl is-active --quiet formsam; then
      kopf=$(curl -s -o /dev/null -D - --max-time 5 "$PRUEF_URL" || true)
      code=$(printf '%s\n' "$kopf" | awk 'NR==1 {print $2}')
      if [ "$code" = 200 ] || { [ "$code" = 503 ] && printf '%s\n' "$kopf" | grep -qi '^x-formsam-wartung:'; }; then return 0; fi
    fi
    sleep 1
  done
  return 1
}
# Syntax aller Server-Module prüfen, bevor der laufende Dienst angehalten wird
syntax_ok() {
  local f
  for f in server.js lib/*.js; do als_formsam node --check "$f" || { echo "   ↳ $f"; return 1; }; done
}
neustart_auf() { als_formsam git reset --quiet --hard "$1"; systemctl restart formsam; }

# Betriebsdateien aus deploy/ mit den eingespielten vergleichen: Sicherungsskripte selbst aktualisieren (laufen per cron),
# Systemeinstellungen nur melden (README „Protokolle und Sicherungen“)
betrieb_pruefen() {
  local d=$APP/deploy s
  for s in formsam-backup stalwart-backup; do
    [ -e "/usr/local/sbin/$s" ] || [ "$s" = formsam-backup ] || continue
    if ! cmp -s "$d/$s" "/usr/local/sbin/$s" && bash -n "$d/$s"; then
      install -m 755 "$d/$s" "/usr/local/sbin/$s" && echo "🔧 /usr/local/sbin/$s aktualisiert"
    fi
  done
  cmp -s "$d/journald-formsam.conf" /etc/systemd/journald.conf.d/formsam.conf \
    || echo "⚠️  Journal-Aufbewahrung (14 Tage, Datenschutzerklärung) nicht eingespielt – README „Protokolle und Sicherungen“"
  cmp -s "$d/nginx-formsam-log.conf" /etc/nginx/conf.d/formsam-log.conf \
    || echo "⚠️  nginx-Protokollformat ohne Query-String nicht eingespielt – README „Protokolle und Sicherungen“"
  cmp -s "$d/logrotate-formsam-nginx" /etc/logrotate.d/formsam-nginx \
    || echo "⚠️  logrotate-Regel für die nginx-Protokolle (14 Tage) nicht eingespielt – README „Protokolle und Sicherungen“"
  return 0
}

zurueck() {
  local alt neu wann
  [ -s "$ZUSTAND" ] || { echo "❌ Kein gemerkter Stand ($ZUSTAND fehlt) – zurück nur von Hand: git log, git reset --hard <commit>"; return 1; }
  read -r alt neu wann < "$ZUSTAND"
  echo "↩️  Zurück auf ${alt:0:7} (Stand vor dem Update auf ${neu:0:7} vom $wann) …"
  neustart_auf "$alt"
  if laeuft; then
    echo "✅ formsam läuft wieder mit ${alt:0:7}. Daten (data/, orders/) bleiben, wie sie sind – zum Zurückholen der Daten README „Wiederherstellung aus der Sicherung“."
  else
    echo "❌ formsam startet auch mit ${alt:0:7} nicht:"; journalctl -u formsam -n 30 --no-pager || true; return 1
  fi
}

main() {
  cd "$APP"
  case "${1:-}" in
    --zurueck) zurueck; return ;;
    --pruefen) betrieb_pruefen; return ;;
    '') ;;
    *) echo "Aufruf: bash $APP/deploy/prod-update.sh [--zurueck | --pruefen]"; return 2 ;;
  esac
  if ! "$BACKUP"; then
    echo "❌ Sicherung fehlgeschlagen – Update abgebrochen, nichts geändert. Details: journalctl -t formsam-backup -n 20"
    return 1
  fi
  als_formsam git fetch --quiet origin main
  local alt neu
  alt=$(als_formsam git rev-parse HEAD)
  neu=$(als_formsam git rev-parse origin/main)
  if [ "$alt" = "$neu" ]; then echo "✅ schon aktuell: ${alt:0:7}"; betrieb_pruefen; return 0; fi
  printf '%s %s %s\n' "$alt" "$neu" "$(date '+%d.%m.%Y %H:%M')" > "$ZUSTAND"
  als_formsam git reset --quiet --hard "$neu"
  if ! syntax_ok; then
    echo "❌ Syntaxfehler im neuen Stand ${neu:0:7} – zurück auf ${alt:0:7} (der Dienst lief die ganze Zeit weiter)"
    als_formsam git reset --quiet --hard "$alt"
    return 1
  fi
  systemctl restart formsam
  if laeuft; then
    echo "✅ formsam läuft: ${alt:0:7} → ${neu:0:7}   (zurück: bash $APP/deploy/prod-update.sh --zurueck)"
    betrieb_pruefen
    return 0
  fi
  echo "❌ formsam antwortet mit ${neu:0:7} nicht:"; journalctl -u formsam -n 30 --no-pager || true
  echo "↩️  Automatisch zurück auf ${alt:0:7} …"
  neustart_auf "$alt"
  if laeuft; then echo "✅ alter Stand ${alt:0:7} läuft wieder – bitte den Fehler in ${neu:0:7} beheben und neu ausrollen."
  else echo "❌ Auch ${alt:0:7} startet nicht – README „Wiederherstellung aus der Sicherung“."; fi
  return 1
}
main "$@"; exit $?
