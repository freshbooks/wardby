#!/usr/bin/env bash
# Level B load test: N real coding-run pods on a local kind cluster, driven
# through the real coding proxy whose model upstream is a guarded mock
# (deploy/kind-coding/manifests/overlays/kind-load -- see its README section
# "Load testing (contributors)"). This script owns every bit of setup and
# teardown around scripts/load/level-b.ts (which does the actual dispatching
# and sampling -- see its own header for what it measures and why).
#
#   LOAD_REPOSITORY=chfields/knock-knock-jokes scripts/load/run-level-b.sh
#   LOAD_RUNS=25 LOAD_CAP=10 LOAD_CONTROL_PLANES=2 LOAD_PROXY_REPLICAS=2 \
#     LOAD_REPOSITORY=chfields/knock-knock-jokes scripts/load/run-level-b.sh
#
# Prerequisites (not done by this script):
#   - `bash deploy/kind-coding/up.sh` already run: a live `kind-wardby`
#     cluster with the coding proxy Deployment/Secret already up.
#   - `npm run db:up` (local Postgres on :55432).
#   - This shell's env (or .env.local) already has whatever
#     deploy/kind-coding/README.md's "Run a real coding agent locally"
#     section lists for JOB_LAUNCHER=kubernetes (CODING_WORKER_IMAGE, the
#     Claude worker/tool-runner image vars if needed, and -- for `wardby
#     serve`, which needs MCP_TRANSPORT=http -- MCP_HTTP_BIND,
#     MCP_CANONICAL_URI, and the rest of the auth config `wardby serve`
#     already requires for ordinary local use). This script only overrides
#     DATABASE_URL and the CODING_* concurrency knobs below; it does not
#     configure MCP transport/auth.
#
# Env (all optional except LOAD_REPOSITORY):
#   LOAD_REPOSITORY       required. owner/repo for the seeded coding agent
#                         (e.g. chfields/knock-knock-jokes).
#   LOAD_RUNS             default 10.    runs level-b.ts dispatches.
#   LOAD_CAP              default 10.    -> CODING_MAX_CONCURRENT.
#   LOAD_CONTROL_PLANES   default 1.     `wardby mcp` stdio children level-b.ts spawns.
#   LOAD_PROXY_REPLICAS   default 1.     proxy replica count for this run.
#   LOAD_LATENCY_MS       default 5000.  -> WARDBY_LOAD_MOCK_LATENCY_MS on the proxy.
#   LOAD_CPUS             default 0.25.  -> CODING_CPUS (per run pod).
#   LOAD_MEMORY_MB        default 512.   -> CODING_MEMORY_MB (per run pod).
#   KUBERNETES_CONTEXT    default kind-wardby.
#   LOAD_NAMESPACE        default wardby-coding. Must match the namespace
#                         hardcoded into deploy/kind-coding/manifests
#                         (only overridable if you've forked the manifests too).
#   LOAD_TIMEOUT_SEC      optional; passed through to level-b.ts (default 1800 there).
#   LOAD_OUT              default a path inside this run's scratch dir;
#                         level-b.ts's JSON results file.
#   LOAD_PG_CONTAINER     default local-postgres-1 (as run-level-a.sh).
#   LOAD_PG_USER          default wardby.
#   LOAD_PG_PORT          default 55432.
#
# Database: creates/drops "wardby_load_b" in the local Postgres container --
# never a database without "load" in its name (level-b.ts itself refuses to
# run against one; see its header).
#
# Secrets: the proxy's `wardby-coding-proxy-env` Secret is read once (its
# three values kept only in this process's own shell variables, never
# exported, echoed, or passed as an argv to anything -- same printf-into-stdin
# discipline as deploy/kind-coding/up.sh), rewritten to point DATABASE_URL at
# the load database for the run, and restored to its original value on exit.
#
# Cleanup (trap on EXIT/INT/TERM, always attempted, but each action is
# individually guarded so a setup that failed partway is never "undone"
# against state that was never touched): stop the background `wardby serve`,
# restore the original proxy Secret, re-apply overlays/kind (removing the
# mock env and resetting replicas), scale the proxy back to 1 explicitly,
# delete any leftover coding-run pods, drop wardby_load_b.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# --- config ------------------------------------------------------------

LOAD_RUNS="${LOAD_RUNS:-10}"
LOAD_CAP="${LOAD_CAP:-10}"
LOAD_CONTROL_PLANES="${LOAD_CONTROL_PLANES:-1}"
LOAD_PROXY_REPLICAS="${LOAD_PROXY_REPLICAS:-1}"
LOAD_LATENCY_MS="${LOAD_LATENCY_MS:-5000}"
LOAD_CPUS="${LOAD_CPUS:-0.25}"
LOAD_MEMORY_MB="${LOAD_MEMORY_MB:-512}"
export KUBERNETES_CONTEXT="${KUBERNETES_CONTEXT:-kind-wardby}"
export LOAD_NAMESPACE="${LOAD_NAMESPACE:-wardby-coding}"
LOAD_PG_CONTAINER="${LOAD_PG_CONTAINER:-local-postgres-1}"
LOAD_PG_USER="${LOAD_PG_USER:-wardby}"
LOAD_PG_PORT="${LOAD_PG_PORT:-55432}"

if [[ -z "${LOAD_REPOSITORY:-}" ]]; then
  echo "run-level-b.sh: LOAD_REPOSITORY is required, e.g. LOAD_REPOSITORY=chfields/knock-knock-jokes" >&2
  exit 1
fi

for bin in kubectl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "run-level-b.sh: '$bin' is required but not found on PATH." >&2
    exit 1
  fi
done

DB="wardby_load_b"
DB_URL="postgresql://${LOAD_PG_USER}:${LOAD_PG_USER}@localhost:${LOAD_PG_PORT}/${DB}"
PROXY_DEPLOY="wardby-coding-proxy"
SECRET_NAME="wardby-coding-proxy-env"
RUN_POD_LABEL="wardby.io/component=coding-run"

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wardby-load-b.XXXXXX")"
LOAD_OUT="${LOAD_OUT:-${SCRATCH_DIR}/level-b-results.json}"
export LOAD_OUT
SERVE_LOG="${SCRATCH_DIR}/wardby-serve.log"
SEED_FILE="scripts/load/.seed-load-b-$$.ts"

# --- state for cleanup (set as each step actually completes) -----------

SERVE_PID=""
SECRET_SAVED=0
ORIG_DATABASE_URL_B64=""
ORIG_OPENAI_B64=""
ORIG_ANTHROPIC_B64=""
OVERLAY_APPLIED=0
PROXY_IMAGE=""
DB_CREATED=0

# --- helpers -------------------------------------------------------------

psql() { docker exec "$LOAD_PG_CONTAINER" psql -q -U "$LOAD_PG_USER" -d "$LOAD_PG_USER" "$@"; }
# Every kustomize-rendered manifest already carries its own metadata.namespace,
# so kctx never passes -n (which would conflict if LOAD_NAMESPACE diverged).
kctx() { kubectl --context "$KUBERNETES_CONTEXT" "$@"; }
kns() { kubectl --context "$KUBERNETES_CONTEXT" -n "$LOAD_NAMESPACE" "$@"; }
# bash builtin printf into base64's stdin -- the value never appears in any
# process's argv (ps-visible for that process's whole lifetime).
b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
drop_db() { psql -c "DROP DATABASE IF EXISTS ${DB} WITH (FORCE);" >/dev/null; }

apply_secret() {
  # $1=DATABASE_URL (base64) $2=OPENAI_API_KEY (base64) $3=ANTHROPIC_API_KEY (base64)
  # Assembled entirely with the printf builtin and piped straight into
  # `kubectl apply -f -`; no value is ever a command-line argument.
  {
    printf 'apiVersion: v1\n'
    printf 'kind: Secret\n'
    printf 'type: Opaque\n'
    printf 'metadata:\n'
    printf '  name: %s\n' "$SECRET_NAME"
    printf '  namespace: %s\n' "$LOAD_NAMESPACE"
    printf 'data:\n'
    printf '  DATABASE_URL: %s\n' "$1"
    printf '  OPENAI_API_KEY: %s\n' "$2"
    printf '  ANTHROPIC_API_KEY: %s\n' "$3"
  } | kns apply -f -
}

# --- cleanup (EXIT/INT/TERM; only undoes what actually happened) ---------

cleanup() {
  local status=$?
  set +e
  echo "==> run-level-b.sh cleanup (exit so far: ${status})"

  if [[ -n "$SERVE_PID" ]] && kill -0 "$SERVE_PID" 2>/dev/null; then
    echo "    stopping background wardby serve (pid ${SERVE_PID})"
    kill "$SERVE_PID" 2>/dev/null
    wait "$SERVE_PID" 2>/dev/null
  fi

  if [[ "$SECRET_SAVED" == "1" ]]; then
    echo "    restoring the original proxy Secret"
    apply_secret "$ORIG_DATABASE_URL_B64" "$ORIG_OPENAI_B64" "$ORIG_ANTHROPIC_B64" >/dev/null 2>&1 \
      || echo "    warning: failed to restore the original proxy Secret" >&2
  fi

  if [[ "$OVERLAY_APPLIED" == "1" ]]; then
    echo "    re-applying overlays/kind (removes the mock env, resets replicas)"
    kctx kustomize deploy/kind-coding/manifests/overlays/kind 2>/dev/null \
      | sed "s|image: wardby-runtime|image: ${PROXY_IMAGE}|" \
      | kctx apply -f - >/dev/null 2>&1 \
      || echo "    warning: failed to re-apply overlays/kind" >&2
    echo "    scaling the proxy back to 1 replica"
    kns scale "deploy/${PROXY_DEPLOY}" --replicas=1 >/dev/null 2>&1 \
      || echo "    warning: failed to scale the proxy back to 1" >&2
    echo "    deleting leftover coding-run pods"
    kns delete pods -l "$RUN_POD_LABEL" --ignore-not-found >/dev/null 2>&1 \
      || echo "    warning: failed to delete leftover coding-run pods" >&2
  fi

  rm -f "$SEED_FILE"

  if [[ "$DB_CREATED" == "1" ]]; then
    echo "    dropping ${DB}"
    drop_db || echo "    warning: failed to drop ${DB}" >&2
  fi

  echo "==> cleanup done (LOAD_OUT: ${LOAD_OUT}, serve log: ${SERVE_LOG})"
  exit "$status"
}
trap cleanup EXIT INT TERM

# --- 1. throwaway database ------------------------------------------------

echo "==> ${DB}: drop (if present) + create + migrate"
drop_db
psql -c "CREATE DATABASE ${DB};" >/dev/null
DB_CREATED=1
DATABASE_URL="$DB_URL" npx prisma migrate deploy >/dev/null

# --- 2. resolve the live proxy image (base/proxy.yaml's "wardby-runtime" is
# only a placeholder -- up.sh substitutes the real digest on the live
# Deployment; re-applying any overlay without the same substitution would
# reset the image to that unresolvable placeholder) --------------------

echo "==> resolving the live proxy image reference"
PROXY_IMAGE="$(kns get "deploy/${PROXY_DEPLOY}" -o jsonpath='{.spec.template.spec.containers[0].image}')"
if [[ -z "$PROXY_IMAGE" || "$PROXY_IMAGE" == "wardby-runtime" ]]; then
  echo "run-level-b.sh: could not resolve a real proxy image (got \"${PROXY_IMAGE}\")." >&2
  echo "run-level-b.sh: run deploy/kind-coding/up.sh first." >&2
  exit 1
fi

# --- 3. point the proxy Secret at the load database for this run ---------

echo "==> saving the current proxy Secret, then pointing DATABASE_URL at ${DB}"
ORIG_DATABASE_URL_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.DATABASE_URL}')"
ORIG_OPENAI_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.OPENAI_API_KEY}')"
ORIG_ANTHROPIC_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.ANTHROPIC_API_KEY}')"
SECRET_SAVED=1

# Swap only the database name in the existing URL (host/port/user/pass stay
# host.docker.internal, same as up.sh writes) -- assumes no query string
# after the database name, matching .env.example's DATABASE_URL shape.
ORIG_DB_URL="$(printf '%s' "$ORIG_DATABASE_URL_B64" | base64 --decode)"
LOAD_PROXY_DB_URL="${ORIG_DB_URL%/*}/${DB}"
apply_secret "$(b64 "$LOAD_PROXY_DB_URL")" "$ORIG_OPENAI_B64" "$ORIG_ANTHROPIC_B64" >/dev/null
unset ORIG_DB_URL LOAD_PROXY_DB_URL

# --- 4. apply the mock-upstream overlay, set latency, scale, wait --------

echo "==> applying overlays/kind-load (mock model upstream)"
kctx kustomize deploy/kind-coding/manifests/overlays/kind-load \
  | sed "s|image: wardby-runtime|image: ${PROXY_IMAGE}|" \
  | kctx apply -f -
OVERLAY_APPLIED=1

echo "==> setting WARDBY_LOAD_MOCK_LATENCY_MS=${LOAD_LATENCY_MS}, scaling to ${LOAD_PROXY_REPLICAS}"
kns set env "deploy/${PROXY_DEPLOY}" "WARDBY_LOAD_MOCK_LATENCY_MS=${LOAD_LATENCY_MS}"
kns scale "deploy/${PROXY_DEPLOY}" --replicas="$LOAD_PROXY_REPLICAS"
kns rollout status "deploy/${PROXY_DEPLOY}" --timeout=3m

# --- 5. seed one coding agent (pattern from level-a.ts's codingAgents, but
# with the ownership/authorization fields a run needs to actually execute
# rather than just dispatch -- see core/repo-access.ts) ------------------

echo "==> seeding one coding agent (repository: ${LOAD_REPOSITORY}) in ${DB}"
cat > "$SEED_FILE" <<'EOF'
/**
 * One-off seed for Level B: a single Codex-provider coding agent whose run
 * can actually execute against LOAD_REPOSITORY, not just dispatch.
 * ownerId must be a real, non-null Principal (core/repo-access.ts refuses
 * owner-less agents with owner_required) and repositoryAuthorizedVia is set
 * to "admin" to skip the live GitHub permission check -- this is a local
 * throwaway load test, not a real repository grant. allowWebhookTaskOverride
 * is set so level-b.ts's per-run custom task text is accepted regardless of
 * which principal the MCP stdio connection resolves to.
 * Written by scripts/load/run-level-b.sh, deleted right after it runs.
 * Prints only the created agent's id to stdout.
 */
import { createPrismaClient } from "../../src/core/db.js";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is required`);
  return v;
}

const url = requireEnv("DATABASE_URL");
const repository = requireEnv("LOAD_REPOSITORY");
const db = createPrismaClient(url);
const OWNER_ID = "wardby-load-b-owner";

async function main(): Promise<void> {
  await db.principal.upsert({ where: { id: OWNER_ID }, create: { id: OWNER_ID, subject: OWNER_ID }, update: {} });
  const agent = await db.agent.create({
    data: {
      name: `wardby-load-b-${Date.now()}`,
      systemPrompt: "Fix things.",
      model: "gpt-5.6-luna",
      budgetUsd: 1,
      kind: "coding",
      ownerId: OWNER_ID,
      codingProfile: {
        create: {
          provider: "codex",
          repository,
          defaultTask: "Load test task.",
          allowWebhookTaskOverride: true,
          protectedPaths: [],
          repositoryAuthorizedVia: "admin",
          repositoryAuthorizedById: OWNER_ID,
          repositoryAuthorizedAt: new Date(),
        },
      },
    },
  });
  process.stdout.write(agent.id);
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.$disconnect();
  });
EOF
LOAD_AGENT_ID="$(DATABASE_URL="$DB_URL" LOAD_REPOSITORY="$LOAD_REPOSITORY" npx tsx --conditions=wardby-source "$SEED_FILE")"
export LOAD_AGENT_ID
rm -f "$SEED_FILE"
echo "    seeded agent ${LOAD_AGENT_ID}"

# --- 6. one `wardby serve` in the background: the reconciler/scheduler
# safety net for a run whose owning `wardby mcp` stdio child dies early --
# not part of the common per-run execution path (see level-b.ts's header
# and docs/private's ruling R2). Only DATABASE_URL and the CODING_*
# concurrency knobs are overridden here; MCP_TRANSPORT/auth config is
# expected to already be in this shell's env or .env.local, same as any
# other local `wardby serve` use. --------------------------------------

export DATABASE_URL="$DB_URL"
export JOB_LAUNCHER=kubernetes
export CODING_MAX_CONCURRENT="$LOAD_CAP"
export CODING_CPUS="$LOAD_CPUS"
export CODING_MEMORY_MB="$LOAD_MEMORY_MB"

echo "==> starting background wardby serve (log: ${SERVE_LOG})"
npx tsx --conditions=wardby-source src/cli.ts serve > "$SERVE_LOG" 2>&1 &
SERVE_PID=$!
sleep 2
if ! kill -0 "$SERVE_PID" 2>/dev/null; then
  echo "run-level-b.sh: wardby serve exited immediately; see ${SERVE_LOG}:" >&2
  tail -n 40 "$SERVE_LOG" >&2 || true
  exit 1
fi

# --- 7. the load test itself ---------------------------------------------

export LOAD_RUNS LOAD_CONTROL_PLANES

echo "==> running level-b.ts: ${LOAD_RUNS} runs over ${LOAD_CONTROL_PLANES} control plane(s), cap ${LOAD_CAP}"
npx tsx --conditions=wardby-source scripts/load/level-b.ts
echo "==> level-b.ts done; results at ${LOAD_OUT}"
