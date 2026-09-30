#!/usr/bin/env bash
# Full Docker cutover test on a disposable GitHub runner, never a user VM.
set -Eeuo pipefail
test "${CI:-}" = true
test "${GITHUB_ACTIONS:-}" = true
test ! -e /srv/metrotech/erf
source_sha=$(git rev-parse HEAD)
baseline=332903bd57e645ca3683b4ed46a8658e45bf5641
accepted=c3cc59c9c78ef02f25901ec585e0d19ca2859c9a
sudo mkdir -p /srv/metrotech
sudo chown "$(id -u):$(id -g)" /srv/metrotech
git worktree add -b production-erf /srv/metrotech/erf "$baseline"
umask 077
cat > /srv/metrotech/erf/.env <<'ENV'
POSTGRES_HOST=db
POSTGRES_DB=metrotech_erf
POSTGRES_USER=metrotech_erf
POSTGRES_PASSWORD=cutover-ci-only
APP_CONFIG_MASTER_KEY=cutover-ci-only-master
PDF_DIR=/data/pdfs
PDF_MODE=mock
ENV
docker network create metrotech_proxy >/dev/null
docker compose -p erf --project-directory /srv/metrotech/erf -f /srv/metrotech/erf/docker-compose.prod.yml up -d --build
ready=false
for attempt in $(seq 1 60); do
  if docker exec metrotech-erf-app node -e 'fetch("http://127.0.0.1:8080/health").then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec -i metrotech-erf-db psql -v ON_ERROR_STOP=1 -U metrotech_erf -d metrotech_erf <<'SQL'
INSERT INTO employees(email,name,employee_id,department,location,division,role,signature_file,username,password_hash)
VALUES ('ci@example.test','CI User','CI-1','Operations','Jakarta','Service','REQUESTOR','/data/signatures/ci.png','ci-user',crypt('CI-Old-Password1',gen_salt('bf',4)));
INSERT INTO requests(ref_no,request_date,requester_email,employee_name,employee_id,department,location,division,total,status,reviewer_email,approver_email,form_pdf_path)
SELECT 'OLD-'||state,'2026-09-30','ci@example.test','CI User','CI-1','Operations','Jakarta','Service',100,state,'reviewer@example.test','approver@example.test','/data/pdfs/old.pdf'
FROM unnest(ARRAY['APPROVED','RECALLED']) state;
SQL
docker exec metrotech-erf-app node --input-type=module -e 'import fs from "node:fs";fs.writeFileSync("/data/pdfs/old.pdf","legacy-pdf-bytes")'
old_image=$(docker inspect -f '{{.Image}}' metrotech-erf-app)
bash scripts/release/rehearse.sh "$accepted"
rehearsal=$(docker ps --filter ancestor=metrotech-ems-candidate:c3cc59c9c78e --format '{{.Names}}')
docker rename "$rehearsal" ems-rehearsal-20260929T183721Z-app
candidate_image=$(docker inspect -f '{{.Image}}' ems-rehearsal-20260929T183721Z-app)

# Inject a deployment failure after migration/startup but before public access.
# All other commands use the real Docker daemon; no production code test hooks.
mkdir -p /tmp/cutover-fault-bin
real_docker=$(command -v docker)
export CUTOVER_REAL_DOCKER="$real_docker" CUTOVER_FAULT_IMAGE="$candidate_image"
touch /tmp/cutover-inject-failure
cat > /tmp/cutover-fault-bin/docker <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" = image && "${2:-}" = tag && "${3:-}" = "$CUTOVER_FAULT_IMAGE" && "${4:-}" = erf-app && -f /tmp/cutover-inject-failure ]]; then
  unlink /tmp/cutover-inject-failure
  echo 'CI deliberate pre-open deployment failure' >&2
  exit 42
fi
exec "$CUTOVER_REAL_DOCKER" "$@"
SH
chmod +x /tmp/cutover-fault-bin/docker
if PATH="/tmp/cutover-fault-bin:$PATH" bash scripts/release/cutover.sh "$source_sha"; then
  echo 'Expected rollback test failure was not injected'; exit 1
fi
test "$(docker inspect -f '{{.Image}}' metrotech-erf-app)" = "$old_image"
test "$(docker inspect -f '{{.State.Running}}' metrotech-erf-app)" = true
test "$(git -C /srv/metrotech/erf rev-parse HEAD)" = "$baseline"
test "$(docker exec metrotech-erf-db psql -At -U metrotech_erf -d metrotech_erf -c "SELECT to_regclass('public.ecf_details') IS NULL")" = t
test "$(docker exec metrotech-erf-db psql -At -U metrotech_erf -d metrotech_erf -c 'SELECT count(*) FROM requests')" = 2
echo 'CUTOVER_AUTOMATIC_ROLLBACK_OK'

bash scripts/release/cutover.sh "$source_sha"
test "$(docker inspect -f '{{.Image}}' metrotech-erf-app)" = "$candidate_image"
test "$(git -C /srv/metrotech/erf rev-parse HEAD)" = "$source_sha"
test "$(docker inspect -f '{{.NetworkSettings.Networks.metrotech_proxy.IPAddress}}' metrotech-erf-app)" != ''
test "$(docker exec metrotech-erf-db psql -At -U metrotech_erf -d metrotech_erf -c 'SELECT count(*) FROM requests')" = 2
run=$(python3 - <<'PY'
from pathlib import Path
print(sorted((Path.home()/'metrotech-ems-cutover').iterdir())[-1])
PY
)
docker exec metrotech-erf-db psql -v ON_ERROR_STOP=1 -U metrotech_erf -d metrotech_erf \
  -c "UPDATE requests SET total=101 WHERE ref_no='OLD-RECALLED'"
if bash scripts/release/rollback.sh "$run"; then echo 'Rollback must refuse to erase new data'; exit 1; fi
test "$(docker inspect -f '{{.Image}}' metrotech-erf-app)" = "$candidate_image"
test "$(docker inspect -f '{{.State.Running}}' metrotech-erf-app)" = true
test "$(docker exec metrotech-erf-db psql -At -U metrotech_erf -d metrotech_erf -c "SELECT total::int FROM requests WHERE ref_no='OLD-RECALLED'")" = 101
echo 'DOCKER_CUTOVER_SMOKE_OK: restored rollback, successful cutover, new-data protection'
