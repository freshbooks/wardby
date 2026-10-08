#!/usr/bin/env bash
# Level B load test: N real coding-run pods on a local kind cluster, driven
# through the real coding proxy whose model upstream is a guarded mock
# (deploy/kind-coding/manifests/overlays/kind-load -- see its README section
# "Load testing (contributors)"). This script owns every bit of setup and
# teardown around scripts/load/level-b.ts (which does the actual dispatching
# and sampling -- see its own header for what it measures and why).
#
#   LOAD_REPOSITORY=your-org/your-repo scripts/load/run-level-b.sh
#   LOAD_RUNS=25 LOAD_CAP=10 LOAD_CONTROL_PLANES=2 LOAD_PROXY_REPLICAS=2 \
#     LOAD_SERVE_PROCESSES=2 LOAD_REPOSITORY=your-org/your-repo scripts/load/run-level-b.sh
#
# Prerequisites (not done by this script):
#   - Re-run `bash deploy/kind-coding/up.sh` FROM THIS CHECKOUT first. The
#     proxy image this script reuses is whatever up.sh last built; one built
#     from a checkout without the mock upstream ignores the mock settings.
#     As a backstop this script (a) replaces the proxy's model keys with a
#     non-secret placeholder for the run and (b) aborts unless every proxy
#     pod logs that the mock upstream is enabled -- but up.sh is the fix.
#   - A live `kind-wardby` cluster with the coding proxy Deployment/Secret
#     up (also from up.sh).
#   - `npm run db:up` (local Postgres on :55432).
#   - This shell's env (or .env.local) already has whatever
#     deploy/kind-coding/README.md's "Run a real coding agent locally"
#     section lists for JOB_LAUNCHER=kubernetes (CODING_WORKER_IMAGE, the
#     Claude worker/tool-runner image vars if needed), plus the auth config
#     `wardby serve` requires for ordinary local use (MCP_CANONICAL_URI,
#     AUTH_AUDIENCE and the auth provider's settings). This script sets
#     MCP_TRANSPORT=http and a dedicated MCP_HTTP_BIND per serve process
#     (127.0.0.1:18080, :18081, ...), so it never collides with a dev
#     `wardby serve` on the usual bind. CODING_WORKER_IMAGE specifically must
#     be the kind-local registry digest up.sh printed (localhost:5001/...) --
#     a Docker-local tag/digest from .env.local is not pullable by kind nodes
#     and this script refuses to start rather than let every run pod fail an
#     ImagePullBackOff. up.sh also recommends KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS=60000
#     under kind; this script exports that default itself so it never has to
#     be set by hand (an already-set value from the caller's env wins).
#
# Env (all optional except LOAD_REPOSITORY and CODING_WORKER_IMAGE):
#   LOAD_REPOSITORY       required. owner/repo for the seeded coding agent
#                         (e.g. your-org/your-repo).
#   CODING_WORKER_IMAGE   required. must start with "localhost:5001/" -- the
#                         kind-local registry up.sh pushes worker images to.
#                         Copy the CODING_WORKER_IMAGE line up.sh printed when
#                         you last ran it (a Docker-local .env.local value is
#                         not resolvable by kind nodes).
#   LOAD_RUNS             default 10.    runs level-b.ts dispatches.
#   LOAD_CAP              default 10.    -> CODING_MAX_CONCURRENT.
#   LOAD_CONTROL_PLANES   default 1.     `wardby mcp` stdio children level-b.ts spawns.
#   LOAD_SERVE_PROCESSES  default 1.     background `wardby serve` processes (2 exercises
#                                        scheduler leader election).
#   LOAD_PROXY_REPLICAS   default 1.     proxy replica count for this run.
#   LOAD_LATENCY_MS       default 5000.  -> WARDBY_LOAD_MOCK_LATENCY_MS on the proxy.
#   LOAD_CPUS             default 0.25.  -> CODING_CPUS (per run pod).
#   LOAD_MEMORY_MB        default 512.   -> CODING_MEMORY_MB (per run pod).
#   LOAD_TIMEOUT_SEC      default 1800.  level-b.ts's overall polling deadline.
#   KUBERNETES_CONTEXT    default kind-wardby.
#   KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS  default 60000 if unset (up.sh's
#                         recommendation for kind's default node resources;
#                         an already-set value from the caller's env wins).
#   LOAD_NAMESPACE        default wardby-coding. Must match the namespace
#                         hardcoded into deploy/kind-coding/manifests
#                         (only overridable if you've forked the manifests too).
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
# discipline as deploy/kind-coding/up.sh). For the run it is rewritten with
# DATABASE_URL pointing at the load database and OPENAI_API_KEY /
# ANTHROPIC_API_KEY set to the non-secret placeholder "wardby-load-test-no-key"
# (non-empty: the proxy's credential resolver refuses empty keys), so even a
# proxy that somehow forwarded upstream could not spend or act with real
# keys. The original values are restored on exit.
#
# Cleanup (trap on EXIT/INT/TERM, always attempted, but each action is
# individually guarded so a setup that failed partway is never "undone"
# against state that was never touched): stop the background `wardby serve`
# process(es), restore the original proxy Secret, re-apply overlays/kind
# (removing the mock env and resetting replicas), scale the proxy back to 1
# explicitly, delete any leftover coding-run pods, drop wardby_load_b.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.."

# --- config ------------------------------------------------------------

LOAD_RUNS="${LOAD_RUNS:-10}"
LOAD_CAP="${LOAD_CAP:-10}"
LOAD_CONTROL_PLANES="${LOAD_CONTROL_PLANES:-1}"
LOAD_SERVE_PROCESSES="${LOAD_SERVE_PROCESSES:-1}"
LOAD_PROXY_REPLICAS="${LOAD_PROXY_REPLICAS:-1}"
LOAD_LATENCY_MS="${LOAD_LATENCY_MS:-5000}"
LOAD_CPUS="${LOAD_CPUS:-0.25}"
LOAD_MEMORY_MB="${LOAD_MEMORY_MB:-512}"
LOAD_TIMEOUT_SEC="${LOAD_TIMEOUT_SEC:-1800}"
export KUBERNETES_CONTEXT="${KUBERNETES_CONTEXT:-kind-wardby}"
export LOAD_NAMESPACE="${LOAD_NAMESPACE:-wardby-coding}"
LOAD_PG_CONTAINER="${LOAD_PG_CONTAINER:-local-postgres-1}"
LOAD_PG_USER="${LOAD_PG_USER:-wardby}"
LOAD_PG_PORT="${LOAD_PG_PORT:-55432}"

if [[ -z "${LOAD_REPOSITORY:-}" ]]; then
  echo "run-level-b.sh: LOAD_REPOSITORY is required, e.g. LOAD_REPOSITORY=your-org/your-repo" >&2
  exit 1
fi

# Positive integers only (a non-number would otherwise reach kubectl/level-b.ts
# as-is; level-b.ts re-validates its own).
for var in LOAD_RUNS LOAD_CAP LOAD_CONTROL_PLANES LOAD_SERVE_PROCESSES LOAD_PROXY_REPLICAS \
  LOAD_MEMORY_MB LOAD_TIMEOUT_SEC LOAD_PG_PORT; do
  if [[ ! "${!var}" =~ ^[1-9][0-9]*$ ]]; then
    echo "run-level-b.sh: ${var} must be a positive integer, got \"${!var}\"." >&2
    exit 1
  fi
done
# 0 is a valid mock latency (the proxy accepts any non-negative integer).
if [[ ! "$LOAD_LATENCY_MS" =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "run-level-b.sh: LOAD_LATENCY_MS must be a non-negative integer, got \"${LOAD_LATENCY_MS}\"." >&2
  exit 1
fi

for bin in kubectl docker; do
  if ! command -v "$bin" >/dev/null 2>&1; then
    echo "run-level-b.sh: '$bin' is required but not found on PATH." >&2
    exit 1
  fi
done

# CODING_WORKER_IMAGE must be the kind-local registry digest up.sh printed,
# never whatever .env.local holds for a Docker-local launcher: kind's nodes
# cannot pull a plain Docker-local tag/digest, so every run pod would sit in
# ImagePullBackOff instead of failing fast here.
if [[ -z "${CODING_WORKER_IMAGE:-}" || "${CODING_WORKER_IMAGE}" != localhost:5001/* ]]; then
  echo "run-level-b.sh: CODING_WORKER_IMAGE must be set to a kind-local registry image (localhost:5001/...)." >&2
  echo "run-level-b.sh: copy the CODING_WORKER_IMAGE line deploy/kind-coding/up.sh printed when you last ran it" >&2
  echo "run-level-b.sh: (e.g. CODING_WORKER_IMAGE=localhost:5001/wardby-coding-worker@sha256:...) into this shell's env or .env.local." >&2
  exit 1
fi
# up.sh recommends this under kind's default node resources (250m CPU /
# 128Mi); default it here so it never has to be set by hand for this script.
export KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS="${KUBERNETES_ENFORCEMENT_EXEC_TIMEOUT_MS:-60000}"

DB="wardby_load_b"
DB_URL="postgresql://${LOAD_PG_USER}:${LOAD_PG_USER}@localhost:${LOAD_PG_PORT}/${DB}"
PROXY_DEPLOY="wardby-coding-proxy"
PROXY_POD_LABEL="app.kubernetes.io/name=wardby-coding-proxy"
SECRET_NAME="wardby-coding-proxy-env"
RUN_POD_LABEL="wardby.io/component=coding-run"
# Non-secret stand-in for the proxy's model keys during the run (see header).
PLACEHOLDER_KEY="wardby-load-test-no-key"
# The proxy's startup warning when the mock upstream is on
# (src/providers/coding-proxy/runtime.ts, pino JSON on stderr).
MOCK_ENABLED_LOG='"event":"proxy.mock_upstream_enabled"'
SERVE_BASE_PORT=18080

SCRATCH_DIR="$(mktemp -d "${TMPDIR:-/tmp}/wardby-load-b.XXXXXX")"
LOAD_OUT="${LOAD_OUT:-${SCRATCH_DIR}/level-b-results.json}"
export LOAD_OUT
SEED_FILE="scripts/load/.seed-load-b-$$.ts"

# --- state for cleanup (set as each step actually completes) -----------

SERVE_PIDS=""
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
serve_log() { printf '%s/wardby-serve-%s.log' "$SCRATCH_DIR" "$1"; }

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

  local pid
  for pid in $SERVE_PIDS; do
    if kill -0 "$pid" 2>/dev/null; then
      echo "    stopping background wardby serve (pid ${pid})"
      kill "$pid" 2>/dev/null
      wait "$pid" 2>/dev/null
    fi
  done

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

  echo "==> cleanup done (LOAD_OUT: ${LOAD_OUT}, serve logs: ${SCRATCH_DIR}/wardby-serve-*.log)"
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

# --- 3. load database + placeholder model keys in the proxy Secret --------

echo "==> saving the current proxy Secret, then pointing DATABASE_URL at ${DB} and replacing the model keys with a placeholder"
ORIG_DATABASE_URL_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.DATABASE_URL}')"
ORIG_OPENAI_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.OPENAI_API_KEY}')"
ORIG_ANTHROPIC_B64="$(kns get secret "$SECRET_NAME" -o jsonpath='{.data.ANTHROPIC_API_KEY}')"
if [[ -z "$ORIG_DATABASE_URL_B64" ]]; then
  echo "run-level-b.sh: ${SECRET_NAME} has no DATABASE_URL; run deploy/kind-coding/up.sh first." >&2
  exit 1
fi
SECRET_SAVED=1

# Swap only the database name in the existing URL (host/port/user/pass stay
# host.docker.internal, same as up.sh writes) -- assumes no query string
# after the database name, matching .env.example's DATABASE_URL shape.
# Each b64 result is computed into its own variable first (as up.sh does):
# `set -e` does not stop on a failed command substitution inlined as an
# argument, so an inlined failure would silently write an empty value.
ORIG_DB_URL="$(printf '%s' "$ORIG_DATABASE_URL_B64" | base64 --decode)"
LOAD_PROXY_DB_URL_B64="$(b64 "${ORIG_DB_URL%/*}/${DB}")"
PLACEHOLDER_KEY_B64="$(b64 "$PLACEHOLDER_KEY")"
unset ORIG_DB_URL
if [[ -z "$LOAD_PROXY_DB_URL_B64" || -z "$PLACEHOLDER_KEY_B64" ]]; then
  echo "run-level-b.sh: base64-encoding the load Secret values failed." >&2
  exit 1
fi
apply_secret "$LOAD_PROXY_DB_URL_B64" "$PLACEHOLDER_KEY_B64" "$PLACEHOLDER_KEY_B64" >/dev/null
unset LOAD_PROXY_DB_URL_B64

# --- 4. apply the mock-upstream overlay (latency substituted into the
# rendered manifest, so there is exactly one proxy rollout), scale, wait,
# then prove every proxy pod is really running the mock -------------------

echo "==> applying overlays/kind-load (mock model upstream, WARDBY_LOAD_MOCK_LATENCY_MS=${LOAD_LATENCY_MS})"
RENDERED="${SCRATCH_DIR}/kind-load.yaml"
# kustomize renders each env entry as "- name: X" then "  value: ...";
# rewrite the value line that directly follows the latency entry's name.
kctx kustomize deploy/kind-coding/manifests/overlays/kind-load \
  | sed "s|image: wardby-runtime|image: ${PROXY_IMAGE}|" \
  | awk -v ms="$LOAD_LATENCY_MS" '
      prev ~ /name: WARDBY_LOAD_MOCK_LATENCY_MS$/ && $1 == "value:" { sub(/value:.*/, "value: \"" ms "\"") }
      { print; prev = $0 }' >"$RENDERED"
if ! grep -A1 'name: WARDBY_LOAD_MOCK_LATENCY_MS$' "$RENDERED" | grep "value: \"${LOAD_LATENCY_MS}\"$" >/dev/null; then
  echo "run-level-b.sh: could not set WARDBY_LOAD_MOCK_LATENCY_MS in the rendered kind-load overlay." >&2
  exit 1
fi
# Set before the apply: a partially applied overlay must still be undone,
# and re-applying overlays/kind in cleanup is idempotent.
OVERLAY_APPLIED=1
kctx apply -f "$RENDERED"

echo "==> scaling the proxy to ${LOAD_PROXY_REPLICAS} and waiting for the rollout"
# Replica count is not part of the pod template, so this adds no rollout.
kns scale "deploy/${PROXY_DEPLOY}" --replicas="$LOAD_PROXY_REPLICAS"
kns rollout status "deploy/${PROXY_DEPLOY}" --timeout=3m

echo "==> checking every proxy pod logged that the mock upstream is enabled"
# Pods still terminating from the previous ReplicaSet are skipped.
PROXY_PODS="$(kns get pods -l "$PROXY_POD_LABEL" \
  -o go-template='{{range .items}}{{if not .metadata.deletionTimestamp}}{{.metadata.name}}{{"\n"}}{{end}}{{end}}')"
if [[ -z "$PROXY_PODS" ]]; then
  echo "run-level-b.sh: no running proxy pods found after the rollout." >&2
  exit 1
fi
for pod in $PROXY_PODS; do
  found=0
  for _ in $(seq 1 15); do
    # grep without -q reads all input, so kubectl never sees SIGPIPE (pipefail).
    if kns logs "$pod" -c proxy 2>/dev/null | grep -F "$MOCK_ENABLED_LOG" >/dev/null; then
      found=1
      break
    fi
    sleep 1
  done
  if [[ "$found" != "1" ]]; then
    echo "run-level-b.sh: proxy pod ${pod} never logged ${MOCK_ENABLED_LOG}: its image predates the mock upstream" >&2
    echo "run-level-b.sh: (or the overlay did not apply). Re-run deploy/kind-coding/up.sh from this checkout. Aborting." >&2
    exit 1
  fi
  echo "    ${pod}: mock upstream enabled"
done

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
          protectedPaths: ["CODEOWNERS"],
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

# --- 6. LOAD_SERVE_PROCESSES `wardby serve` processes in the background:
# the scheduler lease (2+ exercises leader election), the coding-queue
# drain, and the reconciler as a safety net for a run whose owning
# `wardby mcp` stdio child dies early. They are not on the common per-run
# path: a run triggered over stdio is executed inside that stdio child (see
# level-b.ts's header). Each gets MCP_TRANSPORT=http (serve refuses stdio)
# and its own MCP_HTTP_BIND on 127.0.0.1, away from a dev serve's usual
# port; the auth config comes from this shell's env or .env.local, same as
# any other local `wardby serve` use. ----------------------------------

export DATABASE_URL="$DB_URL"
export JOB_LAUNCHER=kubernetes
export CODING_MAX_CONCURRENT="$LOAD_CAP"
export CODING_CPUS="$LOAD_CPUS"
export CODING_MEMORY_MB="$LOAD_MEMORY_MB"

# On an early exit, print only the env var NAMES serve's log mentions (its
# config errors name the missing setting, e.g. "MCP_CANONICAL_URI is
# required"), never the log's text: a startup error can quote a configured
# value (a database URL, an issuer), so the log itself stays on disk only.
serve_failed() {
  local idx="$1" log names
  log="$(serve_log "$idx")"
  names="$(grep -o -E '\b(MCP|AUTH|DATABASE|CODING|JOB|KUBERNETES|GITHUB)_[A-Z0-9_]+\b' "$log" 2>/dev/null | sort -u | tr '\n' ' ')"
  echo "run-level-b.sh: wardby serve #${idx} exited during startup." >&2
  if [[ -n "$names" ]]; then
    echo "run-level-b.sh: settings named in its error output: ${names}" >&2
  fi
  echo "run-level-b.sh: wardby serve needs the same auth config as any local serve (MCP_CANONICAL_URI," >&2
  echo "run-level-b.sh: AUTH_AUDIENCE and the auth provider's settings) in this shell or .env.local." >&2
  echo "run-level-b.sh: full log (not printed; may quote configured values): ${log}" >&2
  exit 1
}

for ((idx = 0; idx < LOAD_SERVE_PROCESSES; idx++)); do
  bind="127.0.0.1:$((SERVE_BASE_PORT + idx))"
  echo "==> starting background wardby serve #${idx} on ${bind} (log: $(serve_log "$idx"))"
  MCP_TRANSPORT=http MCP_HTTP_BIND="$bind" \
    npx tsx --conditions=wardby-source src/cli.ts serve >"$(serve_log "$idx")" 2>&1 &
  SERVE_PIDS="${SERVE_PIDS} $!"
done

# Wait for each to print its "wardby serve started" line (src/cli.ts), or fail fast if it exits.
idx=0
for pid in $SERVE_PIDS; do
  started=0
  for _ in $(seq 1 120); do
    if grep -F "wardby serve started" "$(serve_log "$idx")" >/dev/null 2>&1; then
      started=1
      break
    fi
    kill -0 "$pid" 2>/dev/null || serve_failed "$idx"
    sleep 0.5
  done
  if [[ "$started" != "1" ]]; then
    echo "run-level-b.sh: wardby serve #${idx} did not finish starting within 60s; log: $(serve_log "$idx")" >&2
    exit 1
  fi
  idx=$((idx + 1))
done

# --- 7. the load test itself ---------------------------------------------

export LOAD_RUNS LOAD_CONTROL_PLANES LOAD_TIMEOUT_SEC

echo "==> running level-b.ts: ${LOAD_RUNS} runs over ${LOAD_CONTROL_PLANES} control plane(s) + ${LOAD_SERVE_PROCESSES} serve, cap ${LOAD_CAP}"
npx tsx --conditions=wardby-source scripts/load/level-b.ts
echo "==> level-b.ts done; results at ${LOAD_OUT}"
