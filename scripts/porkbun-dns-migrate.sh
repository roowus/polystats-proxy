#!/usr/bin/env bash
# One-time Porkbun DNS migration for Vercel subdomains.
# Usage: PORKBUN_API_KEY=pk1_... PORKBUN_SECRET=sk1_... bash porkbun-dns-migrate.sh
set -euo pipefail

DOMAIN="roow.us"
K="${PORKBUN_API_KEY:?set PORKBUN_API_KEY (pk1_...)}"
S="${PORKBUN_SECRET:?set PORKBUN_SECRET (sk1_...)}"

api() { # endpoint json-extra
  local ep="$1"; shift
  curl -sS -A "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36" \
    -H "Accept: application/json" \
    -X POST "https://porkbun.com/api/json/v3/$ep" \
    -H "Content-Type: application/json" \
    -d "{\"apikey\":\"$K\",\"secretkey\":\"$S\"$*}"
}

echo "== Current records for $DOMAIN =="
api "dns/retrieve/$DOMAIN" | python3 -m json.tool 2>/dev/null || api "dns/retrieve/$DOMAIN"
echo

echo "== Converting subdomains to CNAME -> cname.vercel-dns.com =="
for host in jetphotos hi www; do
  printf '%s: ' "$host"
  api "dns/editByNameType/$DOMAIN/$host/CNAME" \
    ",\"name\":\"$host\",\"type\":\"CNAME\",\"content\":\"cname.vercel-dns.com\",\"ttl\":600"
  echo
done

echo
echo "== Final records =="
api "dns/retrieve/$DOMAIN" | python3 -m json.tool 2>/dev/null || api "dns/retrieve/$DOMAIN"
