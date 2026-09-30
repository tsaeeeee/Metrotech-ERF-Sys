#!/usr/bin/env bash
set -Eeuo pipefail
run=${1:?Usage: bash rollback.sh CUTOVER_BACKUP_DIRECTORY}
test -f "$run/state.env"
source "$run/state.env"
source "$run/tooling/cutover-common.sh"
test "$(git -C "$repo" rev-parse HEAD)" = "$source_sha"
git -C "$repo" diff --quiet
git -C "$repo" diff --cached --quiet
test "$(docker inspect -f '{{.Image}}' metrotech-erf-app)" = "$candidate_image"
disconnect_proxy
docker stop --time 45 metrotech-erf-app >/dev/null
# Preserve any new transactions/configuration. Never silently rewind them.
if ! helper check-all /release/after.json || ! document_helper check-files /release/files-before.json; then
  docker start metrotech-erf-app >/dev/null
  health
  connect_proxy
  echo 'ROLLBACK BLOCKED: data/documents changed after release. Current app resumed; reconcile new data before restoring.'
  exit 1
fi
migration_attempted=true
restore_release
