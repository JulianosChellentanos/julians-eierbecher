#!/usr/bin/env bash
# formsam — Produktivserver auf den aktuellen Stand von GitHub (main) bringen. Läuft AUF dem Produktivserver als root:
#   bash /srv/formsam/deploy/prod-update.sh
# Daten (data/, orders/, Galerie-Bilder) sind nicht im Git und bleiben unberührt. Vorher wird gesichert.
set -euo pipefail
APP=/srv/formsam
cd "$APP"
/usr/local/sbin/formsam-backup || true
sudo -u formsam git fetch --quiet origin main
ALT=$(sudo -u formsam git rev-parse --short HEAD)
sudo -u formsam git reset --quiet --hard origin/main
NEU=$(sudo -u formsam git rev-parse --short HEAD)
systemctl restart formsam
sleep 2
systemctl is-active --quiet formsam && echo "✅ formsam läuft: $ALT → $NEU" || { echo "❌ formsam startet nicht:"; journalctl -u formsam -n 30 --no-pager; exit 1; }
