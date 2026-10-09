#!/usr/bin/env bash
# Sourced only by the reviewed cutover/rollback scripts with state.env loaded.
dc(){
  local variant=$1
  shift
  docker compose -p "$compose_project" --project-directory "$repo" \
    -f "$repo/docker-compose.prod.yml" -f "$run/$variant.compose.json" "$@"
}
helper(){
  docker run --rm --network metrotech_erf_internal --env-file "$run/runtime.env" \
    -e POSTGRES_HOST=metrotech-erf-db -e POSTGRES_PORT=5432 \
    -v "$run:/release" -v "$run/tooling:/app/scripts/release-multirole:ro" \
    --entrypoint node "$candidate_image" scripts/release-multirole/cutover-check.js "$@"
}
document_helper(){
  docker run --rm --network none --volumes-from metrotech-erf-app \
    -v "$run:/release" -v "$run/tooling:/app/scripts/release-multirole:ro" \
    --entrypoint node "$candidate_image" scripts/release-multirole/cutover-check.js "$@"
}
health(){
  local ready=false
  for attempt in $(seq 1 30); do
    if docker exec metrotech-erf-app node -e '
      fetch("http://127.0.0.1:8080/health",{signal:AbortSignal.timeout(3000)})
        .then(async r=>{const body=await r.json();if(!r.ok||!body.ok||!body.db)process.exit(1);console.log(JSON.stringify(body))})
        .catch(()=>process.exit(1));
    ' > "$run/health.json" 2>/dev/null; then ready=true; break; fi
    sleep 1
  done
  test "$ready" = true
}
disconnect_proxy(){
  local networks
  networks=$(docker inspect -f '{{range $name, $v := .NetworkSettings.Networks}}{{println $name}}{{end}}' metrotech-erf-app)
  if [[ "$networks" == *metrotech_proxy* ]]; then
    docker network disconnect metrotech_proxy metrotech-erf-app
  fi
}
connect_proxy(){
  local networks previous_ip actual_ip error
  networks=$(docker inspect -f '{{range $name, $v := .NetworkSettings.Networks}}{{println $name}}{{end}}' metrotech-erf-app)
  if [[ "$networks" == *metrotech_proxy* ]]; then
    return
  fi
  previous_ip=$(cat "$run/proxy-ip")
  if ! docker network connect --ip "$previous_ip" \
    --alias metrotech-erf-app --alias app metrotech_proxy metrotech-erf-app 2> "$run/network-connect.log"; then
    error=$(cat "$run/network-connect.log")
    if [[ "$error" == *'user specified IP address is supported only when connecting to networks with user configured subnets'* ]]; then
      # Docker auto-created address pools reject --ip; let its allocator reuse
      # the free endpoint, then verify the address before accepting access.
      docker network connect --alias metrotech-erf-app --alias app metrotech_proxy metrotech-erf-app
    else
      printf '%s\n' "$error" >&2
      return 1
    fi
  fi
  actual_ip=$(docker inspect -f '{{(index .NetworkSettings.Networks "metrotech_proxy").IPAddress}}' metrotech-erf-app)
  if [[ "$actual_ip" != "$previous_ip" ]]; then
    docker network disconnect metrotech_proxy metrotech-erf-app
    echo 'Proxy IP changed; access closed to avoid a stale upstream. Review proxy routing.' >&2
    return 1
  fi
}
restore_database(){
  # No application process is running while its DB is replaced.
  docker exec -i metrotech-erf-db sh -c \
    'exec psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -v "dbname=$POSTGRES_DB"' <<'SQL'
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname=:'dbname' AND pid<>pg_backend_pid();
SQL
  docker exec -i metrotech-erf-db sh -c \
    'exec pg_restore --exit-on-error --clean --if-exists --create -U "$POSTGRES_USER" -d postgres' \
    < "$run/production.dump"
}
restore_release(){
  if docker inspect metrotech-erf-app >/dev/null 2>&1; then
    disconnect_proxy
    docker stop --time 30 metrotech-erf-app >/dev/null
  fi
  if [[ "$migration_attempted" = true ]]; then
    restore_database
    helper check /release/before.json
  fi
  docker image tag "$old_image" "$default_image"
  dc rollback up --no-start --no-deps --no-build --pull never --force-recreate app
  disconnect_proxy
  docker inspect metrotech-erf-app > "$run/app-restored.json"
  helper container /release/app-restored.json "$old_image"
  if [[ "$migration_attempted" = true ]]; then document_helper restore-pdfs; fi
  document_helper check-files /release/files-before.json
  docker start metrotech-erf-app >/dev/null
  health
  docker image tag "$old_image" "$default_image"
  git -C "$repo" reset --keep "$baseline"
  connect_proxy
  printf 'ROLLBACK_OK\n' > "$run/status"
  echo 'ROLLBACK_OK: previous app and matching database restored.'
}
