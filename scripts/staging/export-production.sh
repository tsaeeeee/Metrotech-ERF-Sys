#!/usr/bin/env bash
# Read-only production snapshot; does not stop services, switch code, or migrate DB.
set -Eeuo pipefail
umask 077
repo=/srv/metrotech/erf
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bundle=$(mktemp -d "$HOME/ems-staging-snapshot.XXXXXX")
mkdir "$bundle/pdfs" "$bundle/signatures"
app=metrotech-erf-app
db=metrotech-erf-db
test "$(docker inspect -f '{{.State.Running}}' "$app")" = true
test "$(docker inspect -f '{{.State.Running}}' "$db")" = true
git -C "$repo" rev-parse HEAD > "$bundle/source-sha"
docker inspect -f '{{.Image}}' "$app" > "$bundle/source-image"
# Export only the key needed to read encrypted configuration and known document paths.
# No production SMTP/gateway credentials or DB connection settings are copied to app.env.
docker exec "$app" node -e '
 const fs=require("fs");
 for(const [key,value] of Object.entries({APP_CONFIG_MASTER_KEY:process.env.APP_CONFIG_MASTER_KEY||"metrotech-erf-dev-config-key-change-me"})){
   if(/[\r\n]/.test(value))throw Error("Multiline key requires manual handling");
   process.stdout.write(key+"="+value+"\n");
 }
 for(const [key,expected] of [["PDF_DIR","/data/pdfs"],["SIGNATURE_DIR","/data/signatures"]])
   if(process.env[key]&&process.env[key]!==expected)throw Error("Nonstandard document path requires review: "+key);
 if(process.env.PROFILE_SIGNATURE_DIR&&!process.env.PROFILE_SIGNATURE_DIR.startsWith("/data/pdfs/"))throw Error("Nonstandard profile signature path");
' > "$bundle/decryption.env"
for folder in pdfs signatures; do
  docker exec -i "$app" node - "/data/$folder" < "$script_dir/hash-documents.cjs" > "$bundle/$folder-before.json"
done
docker exec "$db" sh -c 'exec pg_dump -Fc --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' > "$bundle/production.dump"
test -s "$bundle/production.dump"
for folder in pdfs signatures; do
  docker cp "$app:/data/$folder/." "$bundle/$folder/"
  docker exec -i "$app" node - "/data/$folder" < "$script_dir/hash-documents.cjs" > "$bundle/$folder-after.json"
  if ! cmp -s "$bundle/$folder-before.json" "$bundle/$folder-after.json"; then
    echo "Documents changed during snapshot. No complete bundle was produced; retry later. Private partial snapshot: $bundle" >&2
    exit 1
  fi
done
cp "$script_dir/hash-documents.cjs" "$bundle/"
# The target import verifies every copied file before restoring or starting the app.
archive="$bundle.tar.gz"
tar -czf "$archive" -C "$bundle" .
sha256sum "$archive" > "$archive.sha256"
printf 'Snapshot ready: %s\nChecksum: %s\nProduction remained running and unchanged. Keep both files private.\n' "$archive" "$archive.sha256"
