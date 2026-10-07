#!/usr/bin/env bash
# Level A load test: creates a throwaway database in the local Postgres
# container, migrates it, runs scripts/load/level-a.ts, then drops it.
#
#   scripts/load/run-level-a.sh            # full run (a few minutes)
#   LOAD_QUICK=1 scripts/load/run-level-a.sh
#   LOAD_REPLICAS=1 LOAD_POOL_MAX=20 scripts/load/run-level-a.sh
#
# Needs `npm run db:up`. Container and role default to the local compose
# setup; override with LOAD_PG_CONTAINER / LOAD_PG_USER / LOAD_PG_PORT.
set -euo pipefail

CONTAINER="${LOAD_PG_CONTAINER:-local-postgres-1}"
PGUSER="${LOAD_PG_USER:-wardby}"
PORT="${LOAD_PG_PORT:-55432}"
DB="wardby_load"
URL="postgresql://${PGUSER}:${PGUSER}@localhost:${PORT}/${DB}"

psql() { docker exec "$CONTAINER" psql -q -U "$PGUSER" -d "$PGUSER" "$@"; }
cleanup() { psql -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);" >/dev/null; }
trap cleanup EXIT

cd "$(dirname "$0")/../.."
cleanup
psql -c "CREATE DATABASE ${DB};"
DATABASE_URL="$URL" npx prisma migrate deploy >/dev/null
DATABASE_URL="$URL" npx tsx --conditions=wardby-source scripts/load/level-a.ts
