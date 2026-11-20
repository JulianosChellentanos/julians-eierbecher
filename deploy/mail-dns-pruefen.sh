#!/usr/bin/env bash
# formsam — prüft die DNS-Einträge für den Mailserver (läuft überall mit dig). Aufruf: bash deploy/mail-dns-pruefen.sh
# Fragt die 1blu-Nameserver direkt, damit frisch eingetragene Werte sofort sichtbar sind (kein Cache).
IP=178.254.22.240
NS=ns01.1blu.de
ok=0; fehler=0
q() { dig +short "@$NS" "$1" "$2" | tr -d '"' | tr -s ' '; }
pruef() { # Name, Ist, Soll-Muster (grep -E)
  if printf '%s\n' "$2" | grep -Eq -- "$3"; then echo "✅ $1"; ok=$((ok+1)); else echo "❌ $1 — ist: ${2:-(leer)}"; fehler=$((fehler+1)); fi
}
pruef "A mx.formsam.com → $IP"        "$(q mx.formsam.com A)"                    "^$IP$"
pruef "MX formsam.com → mx.formsam.com" "$(q formsam.com MX)"                     "^10 mx\.formsam\.com\.$"
pruef "SPF formsam.com"               "$(q formsam.com TXT | grep spf1)"         "^v=spf1 mx -all$"
pruef "SPF mx.formsam.com"            "$(q mx.formsam.com TXT | grep spf1)"      "^v=spf1 a -all$"
pruef "DKIM RSA"                      "$(q v1-rsa-20261120._domainkey.formsam.com TXT | tr -d ' ')" "p=MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAyMMmrp6.*9YJwIDAQAB$"
pruef "DKIM Ed25519"                  "$(q v1-ed25519-20261120._domainkey.formsam.com TXT)" "p=KeGi6IgzizePCCdPWWfdQ\+upamsWIogZL\+SUPUT5Y9E=$"
pruef "DMARC"                         "$(q _dmarc.formsam.com TXT)"              "^v=DMARC1; p=(quarantine|reject)"
pruef "PTR $IP → mx.formsam.com"      "$(dig +short -x $IP)"                     "^mx\.formsam\.com\.$"
echo "— empfohlen —"
pruef "autoconfig.formsam.com → Mailserver" "$(dig +short "@$NS" autoconfig.formsam.com A | tail -1)" "^$IP$"
pruef "SRV _imaps._tcp"               "$(q _imaps._tcp.formsam.com SRV)"         "993 mx\.formsam\.com\.$"
pruef "SRV _submissions._tcp"         "$(q _submissions._tcp.formsam.com SRV)"   "465 mx\.formsam\.com\.$"
echo "$ok in Ordnung, $fehler fehlen noch"
