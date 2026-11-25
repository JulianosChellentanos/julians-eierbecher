#!/usr/bin/env bash
# formsam — Produktivserver auf den aktuellen Stand von GitHub (main) bringen. Läuft AUF dem Produktivserver als root:
#   bash /srv/formsam/deploy/prod-update.sh             sichern, main holen, Syntax prüfen, neu starten, Erreichbarkeit prüfen
#   bash /srv/formsam/deploy/prod-update.sh --zurueck   Code auf den Stand vor dem letzten Update zurück (Daten bleiben)
#   bash /srv/formsam/deploy/prod-update.sh --zurueck <commit>   … auf einen bestimmten Stand (z. B. laut git reflog)
#   bash /srv/formsam/deploy/prod-update.sh --pruefen   nur Betriebsdateien prüfen (Sicherung, Protokoll-Aufbewahrung, nginx-Uploadgrenze/HSTS)
# Daten (data/, orders/, Galerie-Bilder) sind nicht im Git und bleiben unberührt. Vorher prüft das Skript, ob die
# Datendateien lesbares JSON sind, und sichert — schlägt eins fehl, bricht es ab, ohne etwas zu ändern. Den alten Stand merkt
# sich das Skript in /var/backups/formsam/letztes-update (fehlt er, weil das Update noch mit dem alten Skript lief, trägt
# --pruefen ihn aus git reflog nach). Startet der neue Stand nicht (Syntaxfehler, Dienst antwortet nicht binnen 60 s),
# geht es automatisch auf den alten Stand zurück.
# Das Skript liest sich vor dem Ausführen ganz ein (Aufruf von main in der letzten Zeile) — git reset darf die Datei ersetzen.
set -euo pipefail
# Pfade (APP, DATEN, BACKUP, ZUSTAND, PRUEF_URL, NGINX_SITE) lassen sich nur für Tests per Umgebung umbiegen
APP=${APP:-/srv/formsam}
DATEN=${DATEN:-$APP/data}
BACKUP=${BACKUP:-/usr/local/sbin/formsam-backup}
ZUSTAND=${ZUSTAND:-/var/backups/formsam/letztes-update}
PRUEF_URL=${PRUEF_URL:-http://127.0.0.1:4488/api/pricing}
NGINX_SITE=${NGINX_SITE:-/etc/nginx/sites-available/formsam}

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
# Syntax aller Server-Module prüfen, bevor der laufende Dienst angehalten wird (pricing.js lädt der Server mit — gemeinsame Preislogik)
syntax_ok() {
  local f
  for f in server.js lib/*.js public/js/pricing.js; do
    [ -f "$f" ] || continue
    als_formsam node --check "$f" || { echo "   ↳ $f"; return 1; }
  done
}
neustart_auf() { als_formsam git reset --quiet --hard "$1"; systemctl restart formsam; }

# Datendateien, die der Shop beim Start liest, müssen lesbares JSON sein: Die neue Fassung bricht sonst den Start ab, eine ältere
# (Rückweg) startete mit Standardwerten (bekanntes Admin-Passwort, Rechnungsnummer 1) und überschriebe settings.json
daten_pruefen() {
  local f kaputt=""
  for f in settings users designs lists paypal-captures; do
    [ -e "$DATEN/$f.json" ] || continue
    als_formsam node -e 'JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"))' "$DATEN/$f.json" 2>/dev/null || kaputt="$kaputt $f.json"
  done
  [ -z "$kaputt" ] && return 0
  echo "❌ Beschädigte Datendatei(en) in $DATEN:$kaputt – nichts geändert."
  echo "   Erst reparieren oder aus der Sicherung holen (README „Wiederherstellung aus der Sicherung“). Nicht auf eine ältere"
  echo "   Fassung zurückgehen: Die liefe mit Standardwerten los und schriebe settings.json neu."
  return 1
}

# Stand vor dem letzten Update laut git reflog — für Updates mit dem alten Skript (das merkt sich keinen Stand). Nur wenn der
# letzte Eintrag ein „reset: moving to …“ (= Update) ist und der Stand davor ein anderer war.
vorher_laut_reflog() {
  local msg vor jetzt
  msg=$(als_formsam git reflog -1 --format=%gs HEAD 2>/dev/null) || return 1
  case "$msg" in "reset: moving to "*) ;; *) return 1 ;; esac
  vor=$(als_formsam git rev-parse --verify -q 'HEAD@{1}^{commit}') || return 1
  jetzt=$(als_formsam git rev-parse HEAD)
  [ "$vor" != "$jetzt" ] || return 1
  echo "$vor"
}

# Betriebsdateien aus deploy/ mit den eingespielten vergleichen: Sicherungsskripte selbst aktualisieren (laufen per cron),
# Systemeinstellungen nur melden (README „Protokolle und Sicherungen“)
betrieb_pruefen() {
  local d=$APP/deploy s vor
  # Erstes Update mit dem alten Skript: Stand davor aus git reflog merken, damit --zurueck geht
  if [ ! -s "$ZUSTAND" ] && vor=$(vorher_laut_reflog); then
    mkdir -p "$(dirname "$ZUSTAND")"
    printf '%s %s %s\n' "$vor" "$(als_formsam git rev-parse HEAD)" "$(date '+%d.%m.%Y %H:%M') (aus git reflog)" > "$ZUSTAND"
    echo "📝 Stand vor dem letzten Update aus git reflog gemerkt: ${vor:0:7} (für --zurueck)"
  fi
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
  nginx_pruefen
  return 0
}

# nginx-Seite des Shops: certbot hat sie verändert, ein Dateivergleich mit deploy/nginx-formsam.conf geht deshalb nicht. Geprüft wird,
# was der Shop braucht: Uploadgrenze für Druckdateien (server.js MAX_STL 190 MB → client_max_body_size 200m; darunter antwortet nginx
# großen Bestellungen mit einer 413-Seite) und die HSTS-Kopfzeile. Nur melden, nichts ändern.
nginx_pruefen() {
  local f=$NGINX_SITE mb
  if [ ! -r "$f" ]; then
    echo "⚠️  nginx-Seite $f nicht gefunden – client_max_body_size 200m und HSTS von Hand prüfen (deploy/nginx-formsam.conf)"
    return 0
  fi
  # kleinste eingetragene Grenze in MB (Einheit k/m/g oder Bytes; 0 = unbegrenzt); ohne Eintrag gilt der nginx-Standard 1 MB
  mb=$(awk '{ sub(/#.*/, "") }
    { for (i = 1; i < NF; i++) if ($i == "client_max_body_size") {
        v = $(i + 1); sub(/;.*/, "", v); n = v + 0; e = tolower(substr(v, length(v)))
        if (e == "k") n /= 1024; else if (e == "g") n *= 1024; else if (e != "m") n /= 1048576
        if (v + 0 == 0) n = 1e9
        if (min == "" || n < min) min = n } }
    END { print (min == "" ? 1 : min) }' "$f")
  awk -v m="$mb" 'BEGIN { exit !(m >= 200) }' \
    || echo "⚠️  nginx: Uploadgrenze für Druckdateien unter 200 MB (client_max_body_size in $f) – große Bestellungen scheitern mit 413. Wert aus deploy/nginx-formsam.conf übernehmen, dann nginx -t && systemctl reload nginx"
  awk '{ sub(/#.*/, "") } tolower($0) ~ /strict-transport-security/ { f = 1 } END { exit !f }' "$f" \
    || echo "⚠️  nginx: HSTS-Kopfzeile fehlt in $f – Zeile add_header Strict-Transport-Security aus deploy/nginx-formsam.conf übernehmen, dann nginx -t && systemctl reload nginx"
  return 0
}

zurueck() {
  local alt neu wann vor ziel=${1:-}
  if [ -n "$ziel" ]; then
    alt=$(als_formsam git rev-parse --verify -q "$ziel^{commit}") || { echo "❌ Unbekannter Stand: $ziel (sudo -u formsam git -C $APP log --oneline -10)"; return 1; }
    neu=$(als_formsam git rev-parse HEAD); wann="(von Hand gewählt)"
  elif [ -s "$ZUSTAND" ]; then
    read -r alt neu wann < "$ZUSTAND"
  else
    echo "❌ Kein gemerkter Stand ($ZUSTAND fehlt – das letzte Update lief noch mit dem alten Skript)."
    if vor=$(vorher_laut_reflog); then
      echo "   Stand vor dem letzten Update laut git reflog: $(als_formsam git log -1 --format='%h %cd %s' --date=format:'%d.%m.%Y' "$vor")"
      echo "   Zurück dorthin: bash $APP/deploy/prod-update.sh --zurueck $vor"
    else
      echo "   Stand suchen: sudo -u formsam git -C $APP reflog -10, dann: bash $APP/deploy/prod-update.sh --zurueck <commit>"
    fi
    return 1
  fi
  daten_pruefen || return 1
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
    --zurueck) zurueck "${2:-}"; return ;;
    --pruefen) betrieb_pruefen; return ;;
    '') ;;
    *) echo "Aufruf: bash $APP/deploy/prod-update.sh [--zurueck [<commit>] | --pruefen]"; return 2 ;;
  esac
  daten_pruefen || return 1
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
