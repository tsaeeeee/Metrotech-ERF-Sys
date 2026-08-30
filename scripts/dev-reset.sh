#!/usr/bin/env sh
set -eu

if [ "${CONFIRM_DEV_RESET:-}" != "YES" ]; then
  echo "Refusing to reset without CONFIRM_DEV_RESET=YES"
  echo "Run: CONFIRM_DEV_RESET=YES ./scripts/dev-reset.sh"
  exit 1
fi

echo "[1/3] Resetting PostgreSQL development data..."
docker compose exec -T db \
  psql -U metrotech_erf -d metrotech_erf \
  < sql/dev-reset.sql

echo "[2/3] Clearing generated PDFs, evidence, and uploaded signatures..."
docker compose exec -T app sh -lc '
  mkdir -p /data/pdfs
  find /data/pdfs -mindepth 1 -maxdepth 1 -exec rm -rf {} +
'

echo "[3/3] Verifying remaining users..."
docker compose exec -T db \
  psql -U metrotech_erf -d metrotech_erf \
  -c "SELECT email,name,role,username,active FROM employees ORDER BY role,name;"

echo ""
echo "Development reset complete."
echo "Bootstrap login: admin / dev123"
