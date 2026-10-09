#!/usr/bin/env bash
# Same-VM online rehearsal: private clone, no published ports or external email.
set -Eeuo pipefail
umask 077
repo=/srv/metrotech/erf
baseline=0673cfa86ead5d4451798858c7ff8d949d3645dc
candidate=${1:?Usage: bash rehearse.sh FULL_CANDIDATE_SHA}
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]]
test "$(git -C "$repo" branch --show-current)" = production-erf
test "$(git -C "$repo" rev-parse HEAD)" = "$baseline"
git -C "$repo" diff --quiet
git -C "$repo" diff --cached --quiet
git -C "$repo" merge-base --is-ancestor "$baseline" "$candidate"
# Abort before building/snapshotting if there is insufficient headroom.
test "$(awk '/MemAvailable:/ {print $2}' /proc/meminfo)" -ge 1572864 || { echo 'Need at least 1.5 GiB available RAM for rehearsal'; exit 1; }
test "$(df -Pk "$HOME" | awk 'END {print $4}')" -ge 5242880 || { echo 'Need at least 5 GiB free disk'; exit 1; }
run=$(mktemp -d "$HOME/ems-multirole-rehearsal.XXXXXX")
mkdir "$run/code" "$run/exports"
git -C "$repo" archive "$candidate" | tar -x -C "$run/code"
printf '%s\n' "$candidate" > "$run/candidate-sha"
image="metrotech-ems-multirole:${candidate:0:12}"
# Build only tracked candidate files, outside the live checkout.
docker build -t "$image" "$run/code"
docker image inspect -f '{{.Id}}' "$image" > "$run/candidate-image"
EMS_SNAPSHOT_ROOT="$run/exports" bash "$run/code/scripts/staging/export-production.sh"
archive=$(find "$run/exports" -maxdepth 1 -type f -name '*.tar.gz')
test -n "$archive"
tar --no-same-owner -xzf "$archive" -C "$run"
clone="ems-multi-$(basename "$run" | cut -d . -f 2 | tr '[:upper:]' '[:lower:]')"
network="$clone-net"
db="$clone-db"
app="$clone-app"
mail="$clone-mail"
cleanup(){
  code=$?
  trap - EXIT INT TERM
  if (( code != 0 )); then
    docker logs --tail=60 "$app" > "$run/failure.log" 2>&1 || true
    echo "REHEARSAL_FAILED. Live app was not stopped/migrated. Private diagnosis directory: $run"
  fi
  # Only this run's containers are removed. Snapshots, image, and clone volume stay private.
  docker rm -f "$app" "$mail" "$db" >/dev/null 2>&1 || true
  docker network rm "$network" >/dev/null 2>&1 || true
  exit "$code"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
password=$(openssl rand -hex 24)
printf 'POSTGRES_USER=ems_staging\nPOSTGRES_DB=ems_staging\nPOSTGRES_PASSWORD=%s\nEMS_STAGE_SESSION_SECRET=%s\n' "$password" "$(openssl rand -hex 48)" > "$run/clone.env"
docker network create --internal "$network" >/dev/null
docker volume create "$db-data" >/dev/null
docker run -d --name "$db" --network "$network" --network-alias db --cpus 0.5 --memory 384m \
  --env-file "$run/clone.env" -v "$db-data:/var/lib/postgresql/data" "$(docker inspect -f '{{.Image}}' metrotech-erf-db)" >/dev/null
ready=false
for i in $(seq 1 60); do
  if docker exec "$db" psql -h 127.0.0.1 -U ems_staging -d ems_staging -Atqc 'select 1' >/dev/null 2>&1; then ready=true;break;fi
  sleep 1
done
test "$ready" = true
docker exec -i "$db" pg_restore --exit-on-error --no-owner --no-acl -U ems_staging -d ems_staging < "$run/production.dump"
helper=(docker run --rm --network "$network" --cpus 0.5 --memory 512m --env-file "$run/clone.env" --env-file "$run/decryption.env"
  -e EMS_STAGING=true -e POSTGRES_HOST=db -e POSTGRES_PORT=5432 -v "$run:/release" -v "$run/pdfs:/data/pdfs" -v "$run/signatures:/data/signatures" --entrypoint node "$image")
"${helper[@]}" scripts/release-multirole/cutover-check.js capture /release/before.json
"${helper[@]}" scripts/release-multirole/upgrade.js --dry-run
"${helper[@]}" scripts/release-multirole/upgrade.js --apply
# Exercise the production startup helpers on the clone, never the live DB.
"${helper[@]}" --input-type=module -e '
  process.env.EMS_STAGING="false";
  const db=await import("./src/db.js"); const settings=await import("./src/settings.js");
  await db.ensureBootstrapAdminCredentials();await settings.ensureAppSettings();
  await db.pool.end();await db.workflowLockPool.end();'
"${helper[@]}" scripts/release-multirole/cutover-check.js check /release/before.json
"${helper[@]}" scripts/staging/verify-clone.js
for folder in pdfs signatures; do
  "${helper[@]}" /release/hash-documents.cjs "/data/$folder" > "$run/$folder-restored.json"
  cmp "$run/$folder-before.json" "$run/$folder-restored.json"
done
docker run -d --name "$mail" --network "$network" --network-alias mailpit --cpus 0.25 --memory 128m axllent/mailpit:v1.27.4 >/dev/null
docker run -d --name "$app" --network "$network" --cpus 0.75 --memory 512m --env-file "$run/clone.env" --env-file "$run/decryption.env" \
  -e EMS_STAGING=true -e POSTGRES_HOST=db -e POSTGRES_PORT=5432 -e PDF_DIR=/data/pdfs -e PDF_MODE=mock \
  -v "$run/pdfs:/data/pdfs" -v "$run/signatures:/data/signatures" "$image" >/dev/null
ready=false
for i in $(seq 1 45); do
  if docker exec "$app" node -e 'fetch("http://127.0.0.1:8080/health",{signal:AbortSignal.timeout(3000)}).then(async r=>{const b=await r.json();if(!r.ok||!b.db)process.exit(1)}).catch(()=>process.exit(1))'; then ready=true;break;fi
  sleep 1
done
test "$ready" = true
"${helper[@]}" scripts/release-multirole/cutover-check.js check /release/before.json
test "$(docker inspect -f '{{.State.Running}}' metrotech-erf-app)" = true
test "$(docker inspect -f '{{.Image}}' metrotech-erf-app)" = "$(cat "$run/source-image")"
printf 'REHEARSAL_OK\n' > "$run/status"
printf '\nREHEARSAL_OK\nCandidate: %s\nDirectory: %s\nLive production unchanged. No external mail sent.\n' "$candidate" "$run"
