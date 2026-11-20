#!/bin/sh
# formsam — certbot-Deploy-Hook (nur Produktivserver): gibt Stalwart das erneuerte Zertifikat für mx.formsam.com.
# Liegt unter /etc/letsencrypt/renewal-hooks/deploy/stalwart.sh (ausführbar). certbot ruft ihn nach jeder Erneuerung auf;
# von Hand: RENEWED_LINEAGE=/etc/letsencrypt/live/mx.formsam.com sh /etc/letsencrypt/renewal-hooks/deploy/stalwart.sh
# Stalwart liest die Dateien aus /etc/stalwart/tls (Certificate-Objekt mit @type File) und lädt sie beim Neustart.
set -e
LINEAGE=/etc/letsencrypt/live/mx.formsam.com
[ "${RENEWED_LINEAGE:-}" = "$LINEAGE" ] || exit 0

ZIEL=/etc/stalwart/tls
install -d -m 0750 -o stalwart -g stalwart "$ZIEL"
install -m 0644 -o stalwart -g stalwart "$LINEAGE/fullchain.pem" "$ZIEL/fullchain.pem.neu"
install -m 0600 -o stalwart -g stalwart "$LINEAGE/privkey.pem" "$ZIEL/privkey.pem.neu"
mv -f "$ZIEL/fullchain.pem.neu" "$ZIEL/fullchain.pem"
mv -f "$ZIEL/privkey.pem.neu" "$ZIEL/privkey.pem"

# nginx (HTTPS für mx/webmail/autodiscover/mta-sts) und Stalwart (SMTP/IMAP) mit dem neuen Zertifikat
systemctl reload nginx
if systemctl is-active --quiet stalwart; then systemctl restart stalwart; fi
