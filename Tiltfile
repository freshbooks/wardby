# Local dev loop for wardby: `tilt up`
#
#   postgres  -> docker compose (deploy/local/docker-compose.yml), host port 55432
#   prisma    -> prisma generate, re-run when schema.prisma changes
#   migrate   -> prisma migrate deploy against the local database
#   wardby    -> `wardby serve` (MCP over HTTP + scheduler + reconciler), restarted on src/ changes
#
# Application config (provider keys, SECRET_APP_KEY, AUTH_*) comes from your own
# .env / .env.local, which the app loads itself via dotenv-flow. Only the values
# Tilt must own (database, transport, bind) are set here.

pg_user = os.getenv('WARDBY_POSTGRES_USER', 'wardby')
pg_password = os.getenv('WARDBY_POSTGRES_PASSWORD', 'wardby')
pg_db = os.getenv('WARDBY_POSTGRES_DB', 'wardby')
pg_port = os.getenv('WARDBY_POSTGRES_PORT', '55432')
mcp_port = os.getenv('WARDBY_MCP_PORT', '8080')

database_url = 'postgresql://%s:%s@localhost:%s/%s' % (pg_user, pg_password, pg_port, pg_db)

docker_compose('deploy/local/docker-compose.yml')
dc_resource('postgres', labels=['infra'])

local_resource(
    'deps',
    cmd='npm ci',
    deps=['package.json', 'package-lock.json'],
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
    'wardby',
    cmd='npm run build:vendor',
    serve_cmd='npm run cli -- serve',
    serve_env={
        'DATABASE_URL': database_url,
        'MCP_TRANSPORT': 'http',
        'MCP_HTTP_BIND': '127.0.0.1:' + mcp_port,
    },
    deps=['src', 'scripts', 'help', '.env', '.env.local'],
    # build:vendor writes into src/sandbox/generated, so watching it would retrigger itself forever.
    ignore=['src/generated', 'src/sandbox/generated', '**/*.test.ts', '**/*.test.mjs'],
    resource_deps=['migrate'],
    links=['http://localhost:' + mcp_port],
    labels=['app'],
)
