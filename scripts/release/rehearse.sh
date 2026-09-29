#!/usr/bin/env bash
# Read production; restore and migrate ONLY isolated rehearsal resources.
set -Eeuo pipefail
umask 077
repo=/srv/metrotech/erf
baseline=332903bd57e645ca3683b4ed46a8658e45bf5641
candidate=${1:?Usage: bash rehearse.sh FULL_CANDIDATE_SHA}
[[ "$candidate" =~ ^[0-9a-f]{40}$ ]] || { echo 'A full commit SHA is required.'; exit 1; }
test "$(git -C "$repo" branch --show-current)" = production-erf
test "$(git -C "$repo" rev-parse HEAD)" = "$baseline"
git -C "$repo" diff --quiet
git -C "$repo" diff --cached --quiet
git -C "$repo" cat-file -e "$candidate^{commit}"
prod_app=$(docker compose --project-directory "$repo" -f "$repo/docker-compose.prod.yml" ps -q app)
prod_db=$(docker compose --project-directory "$repo" -f "$repo/docker-compose.prod.yml" ps -q db)
test -n "$prod_app" && test -n "$prod_db"
test "$(docker inspect -f '{{.State.Running}}' "$prod_app")" = true
stamp=$(date -u +%Y%m%dT%H%M%SZ)
project="ems-rehearsal-$stamp"
run="$HOME/metrotech-ems-rehearsal/$stamp"
mkdir -p "$run/code" "$run/pdfs" "$run/signatures"
network="$project-net"
clone_db="$project-db"
clone_app="$project-app"
candidate_image="metrotech-ems-candidate:${candidate:0:12}"
old_image=$(docker inspect -f '{{.Image}}' "$prod_app")
db_image=$(docker inspect -f '{{.Image}}' "$prod_db")
cleanup_failure(){
  code=$?
  if (( code != 0 )); then
    docker logs --tail=120 "$clone_app" > "$run/app-failure.log" 2>&1 || true
    docker inspect "$clone_app" > "$run/app-state.json" 2>&1 || true
    docker stop "$clone_app" "$clone_db" >/dev/null 2>&1 || true
    echo "REHEARSAL FAILED. Production was not stopped or migrated. Keep $run for diagnosis."
  fi
}
trap cleanup_failure EXIT

printf '%s\n' "$candidate" > "$run/candidate-sha"
printf '%s\n' "$baseline" > "$run/production-sha"
printf '%s\n' "$old_image" > "$run/production-image-id"
printf '%s\n' "$project" > "$run/project"
docker image tag "$old_image" "metrotech-erf:before-ems-$stamp"
git -C "$repo" archive "$candidate" | tar -x -C "$run/code"
# Build from tracked source only: no live .env, backups, or signature files.
docker build -t "$candidate_image" "$run/code"

docker inspect -f '{{json .Config.Env}}' "$prod_app" > "$run/runtime-env.json"
docker run --rm --network none --user "$(id -u):$(id -g)" --entrypoint node -v "$run:/release" "$candidate_image" -e '
  const fs=require("fs");const values=JSON.parse(fs.readFileSync("/release/runtime-env.json","utf8"));
  if(values.some(v=>/[\r\n]/.test(v)))throw new Error("Multiline runtime environment requires manual review");
  const env=Object.fromEntries(values.map(v=>{const i=v.indexOf("=");return [v.slice(0,i),v.slice(i+1)]}));
  if((env.PDF_DIR||"/data/pdfs")!=="/data/pdfs" || (env.SIGNATURE_DIR||"/data/signatures")!=="/data/signatures")
    throw new Error("Nonstandard document paths require manual review");
  if(env.PROFILE_SIGNATURE_DIR && !env.PROFILE_SIGNATURE_DIR.startsWith("/data/pdfs/"))
    throw new Error("Nonstandard profile signature path requires manual review");
  fs.writeFileSync("/release/app.env",values.join("\n")+"\n",{mode:0o600});
  fs.writeFileSync("/release/production-pdf-mode",env.PDF_MODE||"mock",{mode:0o600});
'
echo 'Taking an online database snapshot; live service stays running.'
docker exec "$prod_db" sh -c 'exec pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$run/production.dump"
test -s "$run/production.dump"
docker cp "$prod_app:/data/pdfs/." "$run/pdfs/"
docker cp "$prod_app:/data/signatures/." "$run/signatures/"
cat > "$run/hash-files.cjs" <<'JS'
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const root=process.argv[2],entries=[];
function walk(dir){for(const name of fs.readdirSync(dir).sort()){
  const full=path.join(dir,name),st=fs.lstatSync(full);
  if(st.isSymbolicLink())throw new Error('Symlink needs manual review: '+full);
  if(st.isDirectory())walk(full);
  else if(st.isFile())entries.push([path.relative(root,full),crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
}}
walk(root);console.log(JSON.stringify(entries.sort((a,b)=>a[0].localeCompare(b[0]))));
JS
for folder in pdfs signatures; do
  docker exec -i "$prod_app" node - "/data/$folder" < "$run/hash-files.cjs" > "$run/$folder-source.json"
  docker run --rm --network none --entrypoint node -v "$run:/release:ro" "$candidate_image" \
    /release/hash-files.cjs "/release/$folder" > "$run/$folder-copy.json"
  cmp "$run/$folder-source.json" "$run/$folder-copy.json"
done

clone_password=$(openssl rand -hex 24)
printf 'POSTGRES_DB=metrotech_rehearsal\nPOSTGRES_USER=metrotech_rehearsal\nPOSTGRES_PASSWORD=%s\n' "$clone_password" > "$run/db.env"
unset clone_password
docker network create --internal "$network" >/dev/null
docker volume create "$project-db-data" >/dev/null
docker run -d --name "$clone_db" --network "$network" --network-alias db \
  --env-file "$run/db.env" -v "$project-db-data:/var/lib/postgresql/data" "$db_image" >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$clone_db" pg_isready -U metrotech_rehearsal -d metrotech_rehearsal >/dev/null 2>&1; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec -i "$clone_db" pg_restore --exit-on-error --no-owner --no-acl \
  -U metrotech_rehearsal -d metrotech_rehearsal < "$run/production.dump"

for mode in --dry-run --apply; do
  docker run --rm --network "$network" --env-file "$run/db.env" \
    -e POSTGRES_HOST=db -e POSTGRES_PORT=5432 --entrypoint node "$candidate_image" \
    scripts/release/upgrade-ems.js "$mode" | tee "$run/migration${mode}.json"
done
# These settings changes are ONLY in the restored clone. Internal networking
# additionally prevents outbound SMTP, OAuth, Google rendering, or mail gateway calls.
docker exec -i "$clone_db" psql -v ON_ERROR_STOP=1 -U metrotech_rehearsal -d metrotech_rehearsal <<'SQL'
INSERT INTO app_settings(key,value,is_secret) VALUES
  ('smtp_enabled','false',false),('google_enabled','false',false),
  ('local_login_enabled','true',false),('cookie_secure','false',false),
  ('app_base_url','http://127.0.0.1:18089',false)
ON CONFLICT(key) DO UPDATE SET value=excluded.value,is_secret=false;
SQL
docker run -d --name "$clone_app" --network "$network" \
  --network-alias app \
  --env-file "$run/app.env" --env-file "$run/db.env" \
  -e POSTGRES_HOST=db -e POSTGRES_PORT=5432 -e PORT=8080 -e PDF_MODE=mock \
  -e MAIL_GATEWAY_URL= -e MAIL_GATEWAY_SECRET= \
  -v "$run/pdfs:/data/pdfs" -v "$run/signatures:/data/signatures:ro" \
  -p 127.0.0.1:18089:8080 "$candidate_image" >/dev/null
ready=false
for attempt in $(seq 1 60); do
  if docker exec "$clone_app" node -e '
    fetch("http://127.0.0.1:8080/health")
      .then(async response=>{process.stdout.write(await response.text());if(!response.ok)process.exit(1)})
      .catch(error=>{console.error(error.message);process.exit(1)});
  ' > "$run/health.json" 2>/dev/null; then
    ready=true
    break
  fi
  sleep 1
done
test "$ready" = true

# A Docker internal network may deliberately block the host from reaching a
# published port even while the app is healthy. Record that separately; it is
# a preview-access issue, not an application-health failure.
host_ready=false
if curl -fsS --max-time 5 http://127.0.0.1:18089/health > "$run/health-host.json" 2>/dev/null; then
  host_ready=true
else
  echo 'Host preview port is not reachable; internal app health is still valid.' | tee "$run/host-preview-warning.txt"
fi
docker exec "$clone_db" psql -v ON_ERROR_STOP=1 -U metrotech_rehearsal -d metrotech_rehearsal \
  -c 'SELECT status,count(*) FROM requests GROUP BY status ORDER BY status;'
printf '\nREHEARSAL_READY\nCandidate: %s\nDirectory: %s\nURL: http://127.0.0.1:18089\n' "$candidate" "$run"
printf 'Internal app health: OK\nHost preview port: %s\n' "$([ "$host_ready" = true ] && echo reachable || echo blocked-by-isolated-network)"
echo 'Only the clone was migrated. Live production remains unchanged.'
echo 'Keep this directory private: it contains production data and runtime secrets.'
echo 'This online snapshot is for rehearsal. Take a fresh maintenance-window backup before live rollout.'
