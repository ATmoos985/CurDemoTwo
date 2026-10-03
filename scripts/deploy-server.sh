#!/usr/bin/env bash
set -Eeuo pipefail
umask 077
deploy_dir=${CUTDEMO_DEPLOY_DIR:-/opt/cutdemo}
cd "$deploy_dir"
image=${1:?Usage: deploy-server.sh ghcr.io/owner/repo@sha256:digest}
if [[ ! "$image" =~ ^ghcr\.io/[a-z0-9._/-]+@sha256:[a-f0-9]{64}$ && ! "$image" =~ ^cutdemo:git-[a-f0-9]{40}$ ]]; then
  printf 'Expected a GHCR digest or a locally verified cutdemo:git-COMMIT image\n' >&2
  exit 2
fi
test -s .env
exec 9>.deploy.lock
flock -n 9 || { printf 'Another deployment is active\n' >&2; exit 3; }
export CUTDEMO_IMAGE=$image
compose=(docker compose --env-file .env -f compose.server.yaml)
"${compose[@]}" config --quiet
if [[ "$image" == ghcr.io/* ]]; then docker pull "$image"; else docker image inspect "$image" >/dev/null; fi

# Keep an independent database backup before any application migration.
mysql_id=$("${compose[@]}" ps -a -q mysql)
if [[ -n "$mysql_id" ]]; then
  mkdir -p backups
  backup="backups/$(date -u +%Y%m%dT%H%M%SZ)-before-deploy.sql.gz"
  docker exec "$mysql_id" sh -c 'MYSQL_PWD="$MYSQL_PASSWORD" exec mysqldump -u"$MYSQL_USER" --single-transaction --no-tablespaces "$MYSQL_DATABASE"' | gzip > "$backup.tmp"
  mv "$backup.tmp" "$backup"
fi
if ! "${compose[@]}" up -d --wait --wait-timeout 180; then
  printf 'Deployment failed. Current/previous image records and database backups are retained. Check migration compatibility before rollback.\n' >&2
  exit 4
fi
if [[ -s .current-image && "$(cat .current-image)" != "$image" ]]; then
  cp .current-image .previous-image
fi
printf '%s\n' "$image" > .current-image.tmp
mv .current-image.tmp .current-image
printf 'Deployment healthy: %s\n' "$image"
