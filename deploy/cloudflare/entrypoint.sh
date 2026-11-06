#!/bin/sh
# Container start: restore the database from R2 if this disk is fresh, then run the app under Litestream so every change is
# copied to R2 as it happens. Without R2 the data would vanish whenever the container sleeps, so that is refused.
set -eu

DB="${DB_PATH:-/data/opensiteconsole.db}"
CONFIG="${LITESTREAM_CONFIG:-/etc/litestream.yml}"
APP="${OSC_APP_COMMAND:-node build}"
mkdir -p "$(dirname "$DB")"

if [ -n "${R2_BUCKET:-}" ] && [ -n "${R2_ACCOUNT_ID:-}" ] && [ -n "${R2_ACCESS_KEY_ID:-}" ] && [ -n "${R2_SECRET_ACCESS_KEY:-}" ]; then
	echo "entrypoint: restoring $DB from R2 if it is not on this disk"
	litestream restore -config "$CONFIG" -if-db-not-exists -if-replica-exists "$DB"
	echo "entrypoint: starting the app under Litestream"
	exec litestream replicate -config "$CONFIG" -exec "$APP"
fi

if [ "${ALLOW_EPHEMERAL:-}" = "1" ]; then
	echo "entrypoint: WARNING R2 is not configured; the database is lost whenever the container sleeps (ALLOW_EPHEMERAL=1)" >&2
	exec sh -c "$APP"
fi

echo "entrypoint: R2_BUCKET, R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY are all required, so the database survives sleep. See deploy/cloudflare/README.md. (ALLOW_EPHEMERAL=1 to run without, for a trial only.)" >&2
exit 1
