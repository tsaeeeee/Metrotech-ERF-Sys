#!/usr/bin/env bash
# Synthetic Docker test only. Never run on either company VM.
set -Eeuo pipefail
test "${CI:-}" = true || { echo 'CI-only fixture'; exit 1; }
repo=$(pwd)
fixture=$(mktemp -d)
mkdir -p "$fixture/pdfs" "$fixture/signatures" "$fixture/snapshots" "$fixture/staging"
cleanup(){
  code=$?
  docker rm -f metrotech-erf-app metrotech-erf-db >/dev/null 2>&1 || true
  for run in "$fixture"/staging/ems-staging.*; do
    test -f "$run/project" || continue
    project=$(cat "$run/project")
    if (( code != 0 )); then docker compose --project-directory "$run" -p "$project" -f "$run/compose.yml" logs --tail=60 || true; fi
    docker compose --project-directory "$run" -p "$project" -f "$run/compose.yml" down -v >/dev/null 2>&1 || true
  done
  exit "$code"
}
trap cleanup EXIT
docker run -d --name metrotech-erf-db --network none -e POSTGRES_PASSWORD=ci-only -e POSTGRES_USER=fixture -e POSTGRES_DB=fixture postgres:17-alpine >/dev/null
ready=false
for attempt in $(seq 1 45); do
  if docker exec metrotech-erf-db psql -h 127.0.0.1 -U fixture -d fixture -Atqc 'SELECT 1' >/dev/null 2>&1; then ready=true;break;fi
  sleep 1
done
test "$ready" = true
# Represent the current EMS database BEFORE migration 018.
sed '/^-- Additive upgrade. NULL/,$d' sql/schema.sql > "$fixture/schema.sql"
docker exec -i metrotech-erf-db psql -v ON_ERROR_STOP=1 -U fixture -d fixture < "$fixture/schema.sql"
docker exec -i metrotech-erf-db psql -v ON_ERROR_STOP=1 -U fixture -d fixture <<'SQL'
INSERT INTO employees(email,name,employee_id,department,location,division,role,signature_file,username,password_hash)
SELECT lower(role)||'@example.test',role,role,'Ops','Jakarta','Service',role,'/data/signatures/test.png',
  CASE WHEN role='ADMIN' THEN 'Administrator' ELSE lower(role) END,crypt('ci-only',gen_salt('bf',4))
FROM unnest(ARRAY['REQUESTOR','REVIEWER','APPROVER','ADMIN']) role;
INSERT INTO requests(ref_no,request_date,requester_email,employee_name,employee_id,department,location,division,total,status,reviewer_email,approver_email,form_pdf_path)
VALUES('STAGING-FIXTURE',current_date,'requestor@example.test','Requestor','TEST','Ops','Jakarta','Service',1234,'APPROVED','reviewer@example.test','approver@example.test','/data/pdfs/test.pdf');
SQL
printf 'fixture pdf' > "$fixture/pdfs/test.pdf"
printf 'fixture signature' > "$fixture/signatures/test.png"
docker run -d --name metrotech-erf-app --network none -e APP_CONFIG_MASTER_KEY=staging-ci-key \
  -v "$fixture/pdfs:/data/pdfs" -v "$fixture/signatures:/data/signatures:ro" node:22-bookworm-slim node -e 'setInterval(()=>{},10000)' >/dev/null
EMS_SOURCE_REPO="$repo" EMS_SNAPSHOT_ROOT="$fixture/snapshots" bash scripts/staging/export-production.sh
archive=$(find "$fixture/snapshots" -maxdepth 1 -type f -name '*.tar.gz')
checksum=$(sha256sum "$archive" | cut -d ' ' -f 1)
# Import must refuse a host that still has the current prod/dev app.
if EMS_STAGING_ROOT="$fixture/staging" bash scripts/staging/import-clone.sh "$archive" "$checksum"; then
  echo 'Import unexpectedly accepted the production host'; exit 1
fi
test "$(docker inspect -f '{{.State.Running}}' metrotech-erf-app)" = true
test "$(docker exec metrotech-erf-db psql -U fixture -d fixture -Atqc "select count(*) from information_schema.columns where table_name='employees' and column_name='workflow_roles'")" = 0
# Remove only synthetic source containers to simulate transfer to another VM.
docker rm -f metrotech-erf-app metrotech-erf-db >/dev/null
EMS_STAGING_ROOT="$fixture/staging" bash scripts/staging/import-clone.sh "$archive" "$checksum"
run=$(find "$fixture/staging" -mindepth 1 -maxdepth 1 -type d)
project=$(cat "$run/project")
compose=(docker compose --project-directory "$run" -p "$project" -f "$run/compose.yml")
test "$(docker network inspect -f '{{.Internal}}' "${project}_isolated")" = true
"${compose[@]}" exec -T app node --input-type=module <<'JS'
import assert from 'node:assert/strict';
import {getRuntimeAppSettings,saveAppSettings} from './src/settings.js';
import {testSmtp} from './src/mailer.js';
import {pool} from './src/db.js';
// Even an Admin config edit cannot redirect staging delivery to a real mail server.
await saveAppSettings({smtpEnabled:true,smtpHost:'external.invalid',smtpPort:465,googleEnabled:true,googleClientId:'test',googleClientSecret:'test',mailOverrideTo:'external@example.test'},'admin@example.test');
const s=await getRuntimeAppSettings();
assert.equal(s.smtpHost,'mailpit');assert.equal(s.smtpPort,1025);
assert.equal(s.googleEnabled,false);assert.equal(s.mailOverrideTo,'');
await testSmtp('should-not-leave@example.test');
const inbox=await (await fetch('http://mailpit:8025/api/v1/messages')).json();
assert.equal(inbox.messages.length,1);
assert(inbox.messages[0].Subject.startsWith('[STAGING]'));
const auth=await (await fetch('http://app:8080/api/auth-mode')).json();
assert.equal(auth.staging,true);
await pool.end();
console.log('STAGING_MAIL_CAPTURE_OK');
JS
printf 'STAGING_CLONE_SMOKE_OK\n'
