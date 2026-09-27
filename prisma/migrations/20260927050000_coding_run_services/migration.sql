-- Coding-run services (docs/coding-services.md): the admin-managed catalog a
-- repository's .wardby/services.yaml names entries from, the service names each
-- coding agent may use, and the services resolved for each run at dispatch.
-- Additive: one new table, two new columns with defaults, and the built-in rows
-- (src/coding/services/builtins.ts; builtins.database.test.ts keeps them equal).

-- CreateTable
CREATE TABLE "CodingService" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'sidecar',
    "image" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "serviceEnv" JSONB NOT NULL DEFAULT '{}',
    "testEnv" JSONB NOT NULL DEFAULT '{}',
    "readiness" JSONB NOT NULL,
    "resources" JSONB NOT NULL,
    "dataPath" TEXT NOT NULL,
    "writablePaths" JSONB NOT NULL DEFAULT '[]',
    "builtin" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CodingService_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CodingService_name_version_key" ON "CodingService"("name", "version");

-- AlterTable
ALTER TABLE "CodingAgentProfile" ADD COLUMN "services" JSONB NOT NULL DEFAULT '[]';

-- AlterTable
ALTER TABLE "CodingRun" ADD COLUMN "services" JSONB NOT NULL DEFAULT '[]';

-- Built-in catalog entries.
INSERT INTO "CodingService" ("id", "name", "version", "kind", "image", "port", "serviceEnv", "testEnv", "readiness", "resources", "dataPath", "writablePaths", "builtin", "updatedAt") VALUES
('builtin-postgres-15', 'postgres', '15', 'sidecar',
 'docker.io/library/postgres@sha256:724292da1f2e50bdccfc3302ce75bbba7f4a6076701b588cc795fcac65683550', 5432,
 '{"POSTGRES_USER":"test","POSTGRES_PASSWORD":"test","POSTGRES_DB":"test","PGDATA":"/var/lib/postgresql/data/pgdata"}',
 '{"DATABASE_URL":"postgres://test:test@127.0.0.1:5432/test","PGHOST":"127.0.0.1","PGPORT":"5432","PGUSER":"test","PGPASSWORD":"test","PGDATABASE":"test"}',
 '{"command":["pg_isready","-h","127.0.0.1","-p","5432","-U","test","-d","test"],"periodSeconds":2,"timeoutSeconds":2,"failureThreshold":30}',
 '{"cpuMillicores":500,"memoryMib":512,"diskMib":1024}',
 '/var/lib/postgresql/data', '["/var/run/postgresql","/tmp"]', true, CURRENT_TIMESTAMP),
('builtin-postgres-16', 'postgres', '16', 'sidecar',
 'docker.io/library/postgres@sha256:1a6ab3f5345eb6dbe04a1349529caabdb0ab09293a09590fad07b2246bfa4b54', 5432,
 '{"POSTGRES_USER":"test","POSTGRES_PASSWORD":"test","POSTGRES_DB":"test","PGDATA":"/var/lib/postgresql/data/pgdata"}',
 '{"DATABASE_URL":"postgres://test:test@127.0.0.1:5432/test","PGHOST":"127.0.0.1","PGPORT":"5432","PGUSER":"test","PGPASSWORD":"test","PGDATABASE":"test"}',
 '{"command":["pg_isready","-h","127.0.0.1","-p","5432","-U","test","-d","test"],"periodSeconds":2,"timeoutSeconds":2,"failureThreshold":30}',
 '{"cpuMillicores":500,"memoryMib":512,"diskMib":1024}',
 '/var/lib/postgresql/data', '["/var/run/postgresql","/tmp"]', true, CURRENT_TIMESTAMP),
('builtin-postgres-17', 'postgres', '17', 'sidecar',
 'docker.io/library/postgres@sha256:d74eeac9a635390a49bc21bd49fccd973de707e2a53a76ac49b552b8712ec46f', 5432,
 '{"POSTGRES_USER":"test","POSTGRES_PASSWORD":"test","POSTGRES_DB":"test","PGDATA":"/var/lib/postgresql/data/pgdata"}',
 '{"DATABASE_URL":"postgres://test:test@127.0.0.1:5432/test","PGHOST":"127.0.0.1","PGPORT":"5432","PGUSER":"test","PGPASSWORD":"test","PGDATABASE":"test"}',
 '{"command":["pg_isready","-h","127.0.0.1","-p","5432","-U","test","-d","test"],"periodSeconds":2,"timeoutSeconds":2,"failureThreshold":30}',
 '{"cpuMillicores":500,"memoryMib":512,"diskMib":1024}',
 '/var/lib/postgresql/data', '["/var/run/postgresql","/tmp"]', true, CURRENT_TIMESTAMP),
('builtin-redis-7', 'redis', '7', 'sidecar',
 'docker.io/library/redis@sha256:c6eabf748fc7a61dbb5a705c78bcf3d6377b1127a97d0ce965c11c44ba46896f', 6379,
 '{}',
 '{"REDIS_URL":"redis://127.0.0.1:6379/0","REDIS_HOST":"127.0.0.1","REDIS_PORT":"6379"}',
 '{"command":["redis-cli","-h","127.0.0.1","-p","6379","ping"],"periodSeconds":1,"timeoutSeconds":2,"failureThreshold":30}',
 '{"cpuMillicores":250,"memoryMib":256,"diskMib":256}',
 '/data', '[]', true, CURRENT_TIMESTAMP),
('builtin-mysql-8', 'mysql', '8', 'sidecar',
 'docker.io/library/mysql@sha256:0744ee5ef89ce6ccfa13de3e579fe6b9e27f93dd70da9c06d2c908b1b193fb8d', 3306,
 '{"MYSQL_ROOT_PASSWORD":"test","MYSQL_DATABASE":"test","MYSQL_USER":"test","MYSQL_PASSWORD":"test"}',
 '{"DATABASE_URL":"mysql://test:test@127.0.0.1:3306/test","MYSQL_HOST":"127.0.0.1","MYSQL_TCP_PORT":"3306","MYSQL_USER":"test","MYSQL_PASSWORD":"test","MYSQL_DATABASE":"test"}',
 '{"command":["mysqladmin","ping","-h","127.0.0.1","-P","3306","-utest","-ptest","--silent"],"periodSeconds":2,"timeoutSeconds":3,"failureThreshold":45}',
 '{"cpuMillicores":500,"memoryMib":1024,"diskMib":2048}',
 '/var/lib/mysql', '["/var/run/mysqld","/tmp"]', true, CURRENT_TIMESTAMP);
