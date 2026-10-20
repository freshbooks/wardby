# Local dev loop for wardby: `tilt up`
#
#   postgres  -> docker compose (deploy/local/docker-compose.yml), host port 55432
#   prisma    -> prisma generate, re-run when schema.prisma changes
#   migrate   -> prisma migrate deploy against the local database
#   bootstrap-env -> generates missing SECRET_APP_KEY / AUTH_SIGNING_KEY / AUTH_CREDENTIAL_HASH_KEY into .env.local
#   dev-user  -> creates an admin login (default subject `dev-admin`, override with WARDBY_DEV_SUBJECT);
#                its login key is written to .tilt/dev-login-key (owner-only, git-ignored)
#   wardby    -> `wardby serve` (MCP over HTTP + scheduler + reconciler), restarted on src/ changes
#   viewer    -> the desktop UI (apps/viewer, Tauri) via `tauri dev`; needs Rust (rustup) and the Xcode
#                CLI tools. It opens already pointed at http://127.0.0.1:<port>; sign in with the key in
#                .tilt/dev-login-key. Set WARDBY_VIEWER=0 to skip it.
#   grafana/prometheus -> on by default; WARDBY_OBSERVABILITY=0 skips them (see below)
#   coding-proxy -> the trusted proxy coding runs use; started with observability or coding (see below)
#   coding-images -> builds the Claude Code and Codex worker/tool-runner images; coding only
#   coding-preflight -> `wardby coding preflight` (images, proxy container, isolation); coding only
#
# Coding runs (Claude Code and Codex on a local git repo, Docker job launcher) turn on when
# LOCAL_REPO_ROOTS (":"-separated trusted folders) is set in the shell, .env.local or .env. `local:`
# repos need no GitHub App. The control plane stays a host process; Docker runs the proxy and
# per-run containers.
#
# Auth is self-hosted (wardby is its own authorization server), so no identity provider is
# needed. The only value you must supply is a model provider key (OPENAI_API_KEY, or
# LLM_PROVIDER=anthropic + ANTHROPIC_API_KEY) in .env or .env.local, which the app loads
# itself via dotenv-flow. Only the values Tilt must own (database, transport, bind, auth
# mode, canonical URI) are set here and override those files.

pg_user = os.getenv('WARDBY_POSTGRES_USER', 'wardby')
pg_password = os.getenv('WARDBY_POSTGRES_PASSWORD', 'wardby')
pg_db = os.getenv('WARDBY_POSTGRES_DB', 'wardby')
pg_port = os.getenv('WARDBY_POSTGRES_PORT', '55432')
mcp_port = os.getenv('WARDBY_MCP_PORT', '8080')

database_url = 'postgresql://%s:%s@localhost:%s/%s' % (pg_user, pg_password, pg_port, pg_db)

# Prometheus + Grafana, on by default; `WARDBY_OBSERVABILITY=0 tilt up` skips them. They reuse the
# compose files behind `npm run observability:up`, which also build and run the coding proxy (the only
# process that emits metrics). Compose requires OPENAI_API_KEY and ANTHROPIC_API_KEY to both be
# non-empty; they are read from the shell, .env.local or .env and handed to compose in memory, never
# logged, and a missing ANTHROPIC_API_KEY gets a placeholder. If OPENAI_API_KEY is missing,
# observability is skipped with a warning (an explicit WARDBY_OBSERVABILITY=1 fails instead). Grafana is at http://127.0.0.1:3000 (admin / wardby-local-only),
# Prometheus at http://127.0.0.1:9090. The dashboards cover coding runs only; native agent runs
# appear in the viewer.
observability_flag = os.getenv('WARDBY_OBSERVABILITY', '')
observability = observability_flag != '0'

def env_value(name):
    # Same precedence as the app: shell, then .env.local, then .env.
    value = os.getenv(name, '')
    for path in ['.env', '.env.local']:
        if os.path.exists(path):
            for line in str(read_file(path)).splitlines():
                line = line.strip()
                if line.startswith(name + '='):
                    file_value = line[len(name) + 1:].strip().strip('"').strip("'")
                    if file_value and not os.getenv(name, ''):
                        value = file_value
    return value

local_repo_roots = env_value('LOCAL_REPO_ROOTS')
coding = bool(local_repo_roots)

if observability and not env_value('OPENAI_API_KEY'):
    message = 'Observability needs OPENAI_API_KEY (set in the shell, .env.local or .env).'
    if observability_flag == '1':
        fail(message)
    warn(message + ' Skipping Prometheus/Grafana; set WARDBY_OBSERVABILITY=0 to silence this.')
    observability = False

if observability or coding:
    # Compose only demands a non-empty value; the proxy reads a provider key when a run references
    # it, so a missing key gets a placeholder (runs on that provider would fail).
    # Check before the placeholder goes in: env_value reads the environment first.
    anthropic_key = env_value('ANTHROPIC_API_KEY')
    os.putenv('OPENAI_API_KEY', env_value('OPENAI_API_KEY') or 'not-set-placeholder')
    os.putenv('ANTHROPIC_API_KEY', anthropic_key or 'not-set-placeholder')
    if coding and not anthropic_key:
        warn('ANTHROPIC_API_KEY is not set: Claude Code coding runs will fail (Codex needs OPENAI_API_KEY).')
    compose_files = ['deploy/local/docker-compose.yml', 'deploy/local/docker-compose.phase5.yml']
    if observability:
        compose_files.append('deploy/observability/docker-compose.grafana.yml')
    docker_compose(compose_files)
    dc_resource('coding-proxy', labels=['coding' if coding else 'observability'])
    if observability:
        for service in ['migration', 'prometheus', 'grafana']:
            dc_resource(service, labels=['observability'])
else:
    docker_compose('deploy/local/docker-compose.yml')
dc_resource('postgres', labels=['infra'])

local_resource(
    'deps',
    cmd='npm ci',
    deps=['package.json', 'package-lock.json'],
    labels=['setup'],
)

local_resource(
    'bootstrap-env',
    cmd='node scripts/dev-bootstrap.mjs env',
    labels=['setup'],
)

local_resource(
    'prisma',
    cmd='npm run prisma:generate',
    deps=['prisma/schema.prisma', 'prisma.config.ts'],
    resource_deps=['deps'],
    labels=['setup'],
)

local_resource(
    'migrate',
    # Tilt marks the compose service ready once the container starts, before Postgres accepts
    # connections, so wait for the compose healthcheck (pg_isready) first.
    cmd='for i in $(seq 1 60); do docker compose -f deploy/local/docker-compose.yml exec -T postgres pg_isready -U %s -d %s >/dev/null 2>&1 && break; sleep 1; done; npm run prisma:migrate' % (pg_user, pg_db),
    env={'DATABASE_URL': database_url},
    deps=['prisma/migrations'],
    resource_deps=['postgres', 'prisma'],
    labels=['setup'],
)

local_resource(
    'dev-user',
    cmd='node scripts/dev-bootstrap.mjs user',
    env={'DATABASE_URL': database_url},
    resource_deps=['migrate', 'bootstrap-env'],
    labels=['setup'],
)

serve_env = {
        'DATABASE_URL': database_url,
        'MCP_TRANSPORT': 'http',
        'AUTH_PROVIDER': 'self-hosted',
        'MCP_HTTP_BIND': '127.0.0.1:' + mcp_port,
        # Loopback HTTP is the one allowed plain-HTTP canonical URI. AUTH_AUDIENCE must match it.
        'MCP_CANONICAL_URI': 'http://127.0.0.1:' + mcp_port,
        'AUTH_AUDIENCE': 'http://127.0.0.1:' + mcp_port,
}
wardby_deps = ['migrate', 'bootstrap-env', 'dev-user']
serve_cmd = 'npm run cli -- serve'

if coding:
    serve_env.update({
        'JOB_LAUNCHER': 'docker',
        'CODING_PROXY_CONTAINER': 'wardby-coding-proxy',
        'LOCAL_REPO_ROOTS': local_repo_roots,
    })
    # Image IDs only exist after the build, but Tilt evaluates env at load time, so they are resolved
    # in the shell. The runtime rejects mutable tags: it needs the immutable local image ID.
    image_id = "$(docker image inspect -f '{{.Id}}' %s)"
    coding_env = '; '.join([
        'export CODING_CLAUDE_WORKER_IMAGE=' + image_id % 'wardby-claude-coding-worker:phase5',
        'export CODING_CLAUDE_TOOL_RUNNER_IMAGE=' + image_id % 'wardby-claude-tool-runner:phase5',
        'export CODING_CLAUDE_TOOL_RUNNER_IMAGE_NODE_PYTHON_3_12=' + image_id % 'wardby-claude-tool-runner:phase5-node-python',
        'export CODING_WORKER_IMAGE=' + image_id % 'wardby-coding-worker:phase5',
    ])
    serve_cmd = coding_env + '; ' + serve_cmd

    local_resource(
        'coding-images',
        # The Codex runtime Dockerfile inherits a published driver by digest, so the driver is built from this
        # checkout and the runtime's FROM is swapped for it; its hardening checks and entrypoint are kept.
        cmd=' && '.join([
            'npm run claude:images:local',
            'docker build -q -f src/coding-worker/Dockerfile.driver -t wardby-coding-worker-driver:phase5-local . >/dev/null',
            "sed -E 's#^FROM [^ ]+ AS runtime#FROM wardby-coding-worker-driver:phase5-local AS runtime#' src/coding-worker/Dockerfile | docker build -q -f - -t wardby-coding-worker:phase5 . >/dev/null",
        ]),
        deps=[
            'src/claude-coding-worker',
            'src/claude-tool-runner',
            'src/coding',
            'src/coding-worker',
        ],
        labels=['coding'],
    )

    local_resource(
        'coding-preflight',
        cmd=coding_env + '; npm run cli -- coding preflight',
        env=serve_env,
        resource_deps=['deps', 'coding-images', 'coding-proxy'],
        labels=['coding'],
    )
    wardby_deps += ['coding-images', 'coding-proxy', 'coding-preflight']

local_resource(
    'wardby',
    cmd='npm run build:vendor',
    serve_cmd=serve_cmd,
    serve_env=serve_env,
    deps=['src', 'scripts', 'help', '.env', '.env.local'],
    # build:vendor writes into src/sandbox/generated, so watching it would retrigger itself forever.
    ignore=['src/generated', 'src/sandbox/generated', '**/*.test.ts', '**/*.test.mjs', 'scripts/dev-*.mjs'],
    resource_deps=wardby_deps,
    # 127.0.0.1, not localhost: the server rejects any Host other than MCP_CANONICAL_URI's.
    links=['http://127.0.0.1:' + mcp_port],
    labels=['app'],
)

load('ext://uibutton', 'cmd_button', 'text_input', 'choice_input')

# The first choice is the button's default, so it follows the configured provider key.
openai_models = ['gpt-4o-mini', 'gpt-4.1-mini', 'gpt-4o', 'gpt-4.1']
anthropic_models = ['claude-haiku-4-5', 'claude-sonnet-5']
if env_value('LLM_PROVIDER') == 'anthropic':
    task_models = anthropic_models + openai_models
else:
    task_models = openai_models + anthropic_models

# "Run a task" button on the wardby resource: fill in the fields, click, and a fresh native agent is
# created and run once; output streams to this resource's log and the run shows up in the viewer.
# This makes a real, billed model request, capped by the budget field (scripts/dev-run-task.mjs).
cmd_button(
    'run-task',
    resource='wardby',
    argv=['env', 'DATABASE_URL=' + database_url, 'node', 'scripts/dev-run-task.mjs'],
    text='Run a task',
    icon_name='play_arrow',
    inputs=[
        text_input('TASK_PROMPT', label='Task', placeholder='What should the agent do?'),
        choice_input('TASK_MODEL', label='Model', choices=task_models),
        text_input('TASK_BUDGET', label='Budget (USD)', default='0.10'),
        text_input('TASK_NAME', label='Agent name prefix', default='task'),
    ],
)

# The viewer is a desktop client of the server above, not part of its build.
viewer_enabled = os.getenv('WARDBY_VIEWER', '1') != '0'

local_resource(
    'viewer-deps',
    cmd='npm ci',
    dir='apps/viewer',
    deps=['apps/viewer/package.json', 'apps/viewer/package-lock.json'],
    auto_init=viewer_enabled,
    labels=['viewer'],
)

local_resource(
    'viewer',
    # `tauri dev` runs Vite and recompiles the Rust shell on change, so no deps= watch is needed.
    # rustup's toolchain goes first: a Homebrew rustc earlier on PATH is usually older than the
    # 1.90 the Tauri crates need, and `source ~/.cargo/env` won't reorder a PATH that already lists it.
    serve_cmd='export PATH="$HOME/.cargo/bin:$PATH"; npm run tauri dev',
    serve_dir='apps/viewer',
    # The viewer opens already pointed at this server (name + URL). The login key is never passed
    # this way: it is typed on the server's own sign-in page (see .tilt/dev-login-key).
    serve_env={
        'WARDBY_VIEWER_SERVER_URL': 'http://127.0.0.1:' + mcp_port,
        'WARDBY_VIEWER_SERVER_NAME': 'Local (Tilt)',
    },
    resource_deps=['viewer-deps', 'wardby'],
    auto_init=viewer_enabled,
    labels=['viewer'],
)
