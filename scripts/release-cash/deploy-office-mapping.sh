#!/usr/bin/env bash
# App-only rollout. Database and Google Sheets are read-only during preflight.
set -Eeuo pipefail
umask 077
repo=/srv/metrotech/erf
baseline=2e155f0e9b648f22559cc74a2fb46ca029d96f7d
release=${1:?Supply the reviewed release SHA}
office_id=1t3d8Chi78zX2WcvKO-oRsrxwsRCAumD6ZsrHWcw5nf4
compose_project=erf
default_image=erf-app
cd "$repo"
exec 9>"$HOME/.ems-cash-release.lock"
flock -n 9 || { echo 'STOP: another EMS deployment is running.'; exit 1; }
test "$(git branch --show-current)" = production-erf
test "$(git rev-parse HEAD)" = "$baseline"
git diff --quiet
git diff --cached --quiet
git merge-base --is-ancestor "$baseline" "$release"
while IFS= read -r file; do
  case "$file" in
    src/cash-sheet-sync.js|scripts/cash-sheet-sync-smoke.js|scripts/cash-sheet-precheck.js|docs/cash-office-sheet-adoption.md|scripts/release-cash/cutover-check.js|scripts/release-cash/deploy-office-mapping.sh) ;;
    *) echo "STOP: unexpected release file: $file"; exit 1 ;;
  esac
done < <(git diff --name-only "$baseline" "$release")
expected_hash=$(git show "$baseline:src/cash-sheet-sync.js" | sha256sum | awk '{print $1}')
running_hash=$(docker exec metrotech-erf-app sha256sum /app/src/cash-sheet-sync.js | awk '{print $1}')
test "$expected_hash" = "$running_hash" || { echo 'STOP: running sync code differs from baseline.'; exit 1; }

run=$(mktemp -d "$HOME/ems-office-deploy.XXXXXX")
printf 'Deployment files: %s\n' "$run"
docker inspect metrotech-erf-app > "$run/app-before.json"
docker inspect metrotech-erf-db > "$run/db-before.json"
old_image=$(docker inspect -f '{{.Image}}' metrotech-erf-app)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
rollback_image="erf-app:before-office-mapping-$stamp"
candidate_image="erf-app:office-mapping-$stamp"
docker image tag "$old_image" "$rollback_image"
mkdir "$run/context"
git archive "$release" src/cash-sheet-sync.js scripts/cash-sheet-sync-smoke.js \
  scripts/cash-sheet-memory.js scripts/cash-sheet-precheck.js scripts/release-cash |
  tar -x -C "$run/context"
cp -a "$run/context/scripts/release-cash" "$run/tooling"
cat > "$run/context/Dockerfile" <<'DOCKERFILE'
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
WORKDIR /app
COPY src/cash-sheet-sync.js ./src/cash-sheet-sync.js
COPY scripts/ ./scripts/
DOCKERFILE
docker build --network none --build-arg "BASE_IMAGE=$rollback_image" \
  -t "$candidate_image" "$run/context"
new_image=$(docker image inspect -f '{{.Id}}' "$candidate_image")
docker run --rm --network none --entrypoint node "$candidate_image" scripts/cash-sheet-sync-smoke.js
source "$run/tooling/cutover-common.sh"
docker run --rm --network none -v "$run:/release" --entrypoint node \
  "$candidate_image" scripts/release-cash/cutover-check.js prepare "$new_image" "$(id -u):$(id -g)"
for variant in candidate rollback; do
  dc "$variant" config --format json > "$run/$variant.resolved.json"
  helper config "/release/$variant.resolved.json"
done

# Require the office target and the scheduler paused, using only SELECT.
docker run --rm -i --read-only --network container:metrotech-erf-app \
  --volumes-from metrotech-erf-app:ro --env-file "$run/runtime.env" \
  --entrypoint node "$candidate_image" --input-type=module - "$office_id" <<'JS'
import assert from 'node:assert/strict';
import {pool} from './src/db.js';
try {
  const row=(await pool.query('select spreadsheet_id,enabled from cash_backup_settings where id=1')).rows[0];
  assert.equal(row?.spreadsheet_id,process.argv[2],'Save the office spreadsheet ID in Cash Settings first.');
  assert.equal(row.enabled,false,'Uncheck Daily Backup and Save Settings before rollout.');
  console.log('OFFICE_TARGET_AND_PAUSED_SCHEDULE_VERIFIED');
} finally { await pool.end(); }
JS
docker run --rm --read-only --network container:metrotech-erf-app \
  --volumes-from metrotech-erf-app:ro --env-file "$run/runtime.env" \
  --entrypoint node "$candidate_image" scripts/cash-sheet-precheck.js "$office_id" --metadata-only

google_override="$repo/docker-compose.google-backup.json"
if [ -f "$google_override" ]; then cp -p "$google_override" "$run/google-override-before.json"; fi
maintenance=false
on_error(){
  local code=$?
  trap - ERR
  set +e
  if [ "$maintenance" = true ]; then
    echo 'App verification failed; restoring the previous app only.'
    (
      set -e
      if docker inspect metrotech-erf-app >/dev/null 2>&1; then disconnect_proxy; fi
      dc rollback up --no-start --no-deps --no-build --pull never --force-recreate app
      disconnect_proxy
      docker inspect metrotech-erf-app > "$run/app-restored.json"
      helper container /release/app-restored.json "$old_image"
      docker start metrotech-erf-app >/dev/null
      health
      git reset --keep "$baseline"
      if [ -f "$run/google-override-before.json" ]; then cp -p "$run/google-override-before.json" "$google_override"; fi
      docker image tag "$old_image" "$default_image"
      connect_proxy
      echo 'APP_ROLLBACK_OK: database was not restored or migrated.'
    ) || echo "ROLLBACK_NEEDS_REVIEW: retain $run; keep Daily Backup disabled."
  fi
  printf 'Deployment stopped. Diagnostic files: %s\n' "$run"
  exit "$code"
}
trap on_error ERR
maintenance=true
dc candidate up --no-start --no-deps --no-build --pull never --force-recreate app
disconnect_proxy
docker inspect metrotech-erf-app > "$run/app-created.json"
helper container /release/app-created.json "$new_image"
docker start metrotech-erf-app >/dev/null
health
docker inspect metrotech-erf-db > "$run/db-after.json"
helper database-container /release/db-after.json
git merge --ff-only "$release"
# Keep the persistent Google override pointing at the new image too.
if [ -f "$google_override" ]; then
  python3 - "$google_override" "$new_image" <<'PY'
import json,os,sys
from pathlib import Path
p=Path(sys.argv[1]); data=json.loads(p.read_text())
data['services']['app']['image']=sys.argv[2]
tmp=p.with_name(p.name+'.office-next')
with tmp.open('x') as f:
    json.dump(data,f,indent=2); f.write('\n')
os.chmod(tmp,0o600); os.replace(tmp,p)
PY
fi
docker image tag "$new_image" "$default_image"
connect_proxy
maintenance=false
trap - ERR
cat "$run/health.json"
printf '\nOFFICE_MAPPING_APP_READY\nCommit: %s\nImage: %s\nDeployment files: %s\nRollback image: %s\n' "$release" "$new_image" "$run" "$rollback_image"
echo 'No spreadsheet writes were performed by this deployment. Daily Backup remains paused.'
echo 'Next: run Back Up Now in Cash Settings, verify OK, then enable Daily Backup.'
echo 'After first sync, do not use an older mapper for manual or scheduled backups.'
