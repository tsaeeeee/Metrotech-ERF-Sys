#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
repo=/srv/metrotech/erf
baseline=332903bd57e645ca3683b4ed46a8658e45bf5641
accepted=c3cc59c9c78ef02f25901ec585e0d19ca2859c9a
source_sha=${1:?Usage: bash cutover.sh FULL_PRODUCTION_RELEASE_SHA}
[[ "$source_sha" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" branch --show-current)" = production-erf
test "$(git -C "$repo" rev-parse HEAD)" = "$baseline"
git -C "$repo" diff --quiet
git -C "$repo" diff --cached --quiet
git -C "$repo" merge-base --is-ancestor "$baseline" "$source_sha"
# Deployment tooling may change; tested application, SQL and Docker build must match.
git -C "$repo" diff --quiet "$accepted" "$source_sha" -- src public sql Dockerfile package.json package-lock.json docker-compose.prod.yml
rehearsal=ems-rehearsal-20260929T183721Z-app
test "$(docker inspect -f '{{.State.Running}}' "$rehearsal")" = true
candidate_image=$(docker inspect -f '{{.Image}}' "$rehearsal")
test "$candidate_image" = "$(docker image inspect -f '{{.Id}}' metrotech-ems-candidate:c3cc59c9c78e)"
docker exec "$rehearsal" node -e 'fetch("http://127.0.0.1:8080/health",{signal:AbortSignal.timeout(5000)}).then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))'
test "$(docker inspect -f '{{.State.Running}}' metrotech-erf-app)" = true
stamp=$(date -u +%Y%m%dT%H%M%SZ)
run="$HOME/metrotech-ems-cutover/$stamp"
mkdir -p "$run/tooling" "$run/pdfs" "$run/signatures"
cp "$(dirname "$0")/"*.js "$(dirname "$0")/"*.sh "$run/tooling/"
old_image=$(docker inspect -f '{{.Image}}' metrotech-erf-app)
db_image=$(docker inspect -f '{{.Image}}' metrotech-erf-db)
default_image=$(docker inspect -f '{{.Config.Image}}' metrotech-erf-app)
[[ "$default_image" != sha256:* && "$default_image" != *@* ]] || { echo 'A mutable local image tag is required for Compose continuity.'; exit 1; }
compose_project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' metrotech-erf-app)
docker inspect metrotech-erf-app > "$run/app-before.json"
docker inspect metrotech-erf-db > "$run/db-before.json"
cp -p "$repo/.env" "$run/config.env"
docker image tag "$old_image" "metrotech-erf:rollback-$stamp"
docker run --rm --network none --user "$(id -u):$(id -g)" \
  -v "$run:/release" -v "$run/tooling:/app/scripts/release:ro" --entrypoint node "$candidate_image" \
  scripts/release/cutover-check.js prepare "$candidate_image"
restore_db="ems-cutover-restore-$stamp"
restore_network="$restore_db-net"
for key in repo baseline accepted source_sha candidate_image old_image db_image default_image compose_project run restore_db restore_network; do
  printf '%s=%q\n' "$key" "${!key}" >> "$run/state.env"
done
source "$run/tooling/cutover-common.sh"
dc candidate config --format json > "$run/compose-resolved.json"
helper config /release/compose-resolved.json
frozen=false
migration_attempted=false
published=false
on_exit(){
  code=$?
  trap - EXIT INT TERM
  set +e
  docker stop "ems-cutover-migration-$stamp" >/dev/null 2>&1
  docker stop "$restore_db" >/dev/null 2>&1
  if (( code != 0 )); then
    docker logs --tail=100 metrotech-erf-app > "$run/failure.log" 2>&1
    if [[ "$published" = true ]]; then
      echo "Live access was already opened; use the guarded rollback script after review: $run"
    elif [[ "$frozen" = true && "$migration_attempted" = true ]]; then
      ( set -e; restore_release )
      rollback_code=$?
      if (( rollback_code != 0 )); then
        echo "ROLLBACK NEEDS ATTENTION. Access stays closed. Preserve $run and share the error summary."
      fi
    elif [[ "$frozen" = true ]]; then
      docker start metrotech-erf-app >/dev/null
      if health; then connect_proxy; echo 'Previous application resumed; migration was not attempted.'; fi
    fi
    echo "CUTOVER FAILED: details retained in $run"
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
echo 'Maintenance starting: app access pauses while fresh backup and restore checks run.'
frozen=true
disconnect_proxy
docker stop --time 45 metrotech-erf-app >/dev/null
helper capture /release/before.json
document_helper files /release/files-before.json
docker exec metrotech-erf-db sh -c 'exec pg_dump -Fc --create -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$run/production.dump"
docker exec metrotech-erf-db sh -c 'exec pg_dumpall --globals-only -U "$POSTGRES_USER"' > "$run/globals.sql"
test -s "$run/production.dump"
docker cp metrotech-erf-app:/data/pdfs/. "$run/pdfs/"
docker cp metrotech-erf-app:/data/signatures/. "$run/signatures/"
document_helper check-backup-files /release/files-before.json

echo 'Restoring the fresh backup in an isolated database before migration.'
docker network create --internal "$restore_network" >/dev/null
docker volume create "$restore_db-data" >/dev/null
docker run -d --name "$restore_db" --network "$restore_network" --network-alias db \
  --env-file "$run/db.env" -v "$restore_db-data:/var/lib/postgresql/data" "$db_image" >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$restore_db" sh -c 'pg_isready -U "$POSTGRES_USER" -d postgres' >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec -i "$restore_db" sh -c 'exec pg_restore --exit-on-error --clean --if-exists --create -U "$POSTGRES_USER" -d postgres' < "$run/production.dump"
docker run --rm --network "$restore_network" --env-file "$run/runtime.env" \
  -e POSTGRES_HOST=db -e POSTGRES_PORT=5432 -v "$run:/release" -v "$run/tooling:/app/scripts/release:ro" \
  --entrypoint node "$candidate_image" scripts/release/cutover-check.js check /release/before.json
docker stop "$restore_db" >/dev/null
echo 'FRESH_BACKUP_RESTORE_VERIFIED'

migration_attempted=true
docker run --rm --name "ems-cutover-migration-$stamp" --network metrotech_erf_internal \
  --env-file "$run/runtime.env" -e POSTGRES_HOST=metrotech-erf-db -e POSTGRES_PORT=5432 \
  --entrypoint node "$candidate_image" scripts/release/upgrade-ems.js --apply | tee "$run/migration.json"
helper check /release/before.json
dc candidate up --no-start --no-deps --no-build --pull never --force-recreate app
disconnect_proxy
docker inspect metrotech-erf-app > "$run/app-candidate.json"
helper container /release/app-candidate.json "$candidate_image"
docker start metrotech-erf-app >/dev/null
health
helper check /release/before.json
document_helper check-files /release/files-before.json
helper capture-all /release/after.json
git -C "$repo" merge --ff-only "$source_sha"
docker image tag "$candidate_image" "$default_image"
connect_proxy
published=true
printf 'LIVE_RELEASED\n' > "$run/status"
cat "$run/health.json"
printf '\nLIVE_RELEASED\nSource: %s\nImage: %s\nBackup: %s\n' "$source_sha" "$candidate_image" "$run"
echo 'Check old-user login, existing requests and PDF, then send one Test SMTP from Admin to your own internal inbox.'
echo "Guarded rollback: bash '$run/tooling/rollback.sh' '$run'"
