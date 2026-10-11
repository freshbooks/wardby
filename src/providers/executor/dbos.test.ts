import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DBOS } from "@dbos-inc/dbos-sdk";
import pg from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dbosLaunchConfig, DbosExecutor } from "./dbos.js";

const config = {
  systemDatabaseUrl: "postgresql://u:p@localhost:5432/wardby?connect_timeout=4",
  schemaName: "dbos",
  executorId: "exec-1",
};
const RDS_URL = "postgresql://app@db.example:5432/wardby?sslmode=verify-full&sslrootcert=/ca.pem";
const pgAuth = {
  env: { AWS_REGION: "us-east-1" },
  readFile: () => "CA",
  makeSigner: () => ({ getAuthToken: async () => "t" }),
};

const pools: pg.Pool[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const pool of pools.splice(0)) {
    // A test that failed before DBOS got a pool pushes undefined.
    if (pool && !pool.ended) await pool.end();
  }
});

describe("dbosLaunchConfig", () => {
  it("is exactly today's DBOS.setConfig input under password auth", () => {
    expect(dbosLaunchConfig(config, "exec-1", "password")).toEqual({
      name: "wardby",
      systemDatabaseUrl: config.systemDatabaseUrl,
      systemDatabaseSchemaName: "dbos",
      executorID: "exec-1",
      runAdminServer: false,
      logLevel: "warn",
    });
  });

  it("hands DBOS a token-authenticated pool under rds-iam, sized and named as DBOS sizes its own", () => {
    const launch = dbosLaunchConfig({ ...config, systemDatabaseUrl: RDS_URL }, "exec-1", "rds-iam", pgAuth);
    const pool = launch.systemDatabasePool;
    expect(pool).toBeInstanceOf(pg.Pool);
    pools.push(pool!);
    expect(launch).toMatchObject({
      systemDatabaseUrl: RDS_URL,
      executorID: "exec-1",
      systemDatabaseSchemaName: "dbos",
    });
    expect(pool!.options).toMatchObject({
      host: "db.example",
      user: "app",
      database: "wardby",
      max: 10,
      connectionTimeoutMillis: 10_000,
      application_name: "dbos_transact_exec-1",
    });
    expect(typeof pool!.options.password).toBe("function");
    expect(pool!.options.connectionString).toBeUndefined();
    expect(pool!.listenerCount("error")).toBe(1);
  });

  it("honours connect_timeout (seconds) as DBOS does for its own pool", () => {
    const url = `${RDS_URL}&connect_timeout=3`;
    const pool = dbosLaunchConfig(
      { ...config, systemDatabaseUrl: url },
      "exec-1",
      "rds-iam",
      pgAuth,
    ).systemDatabasePool;
    pools.push(pool!);
    expect(pool!.options.connectionTimeoutMillis).toBe(3_000);
  });

  it("keeps the URL's application_name when it sets one", () => {
    const url = `${RDS_URL}&application_name=mine`;
    const pool = dbosLaunchConfig(
      { ...config, systemDatabaseUrl: url },
      "exec-1",
      "rds-iam",
      pgAuth,
    ).systemDatabasePool;
    pools.push(pool!);
    expect(pool!.options.application_name).toBe("mine");
  });

  it.each(["postgresql://app@db.example/w", "not a url"])("refuses the bad rds-iam URL %j", (url) => {
    expect(() => dbosLaunchConfig({ ...config, systemDatabaseUrl: url }, "exec-1", "rds-iam", pgAuth)).toThrow(
      "database_auth_invalid",
    );
  });
});

/** Runs `fn` with DATABASE_AUTH=rds-iam and a real CA file, as launch() reads both from the process. */
async function withRdsIamEnv(fn: (url: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "wardby-dbos-ca-"));
  const ca = join(dir, "ca.pem");
  writeFileSync(ca, "CA");
  const saved = { DATABASE_AUTH: process.env.DATABASE_AUTH, AWS_REGION: process.env.AWS_REGION };
  process.env.DATABASE_AUTH = "rds-iam";
  process.env.AWS_REGION = "us-east-1";
  try {
    await fn(`postgresql://app@db.example/wardby?sslmode=verify-full&sslrootcert=${ca}`);
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Stubs the DBOS singleton and captures the pool launch() hands it. */
function stubDbos(launch: () => Promise<void>) {
  const handed: { pool?: pg.Pool } = {};
  vi.spyOn(DBOS, "isInitialized").mockReturnValue(false);
  vi.spyOn(DBOS, "setConfig").mockImplementation((c) => {
    handed.pool = c.systemDatabasePool;
  });
  vi.spyOn(DBOS, "launch").mockImplementation(launch);
  const shutdown = vi.spyOn(DBOS, "shutdown").mockResolvedValue(undefined);
  return { handed, shutdown };
}

describe("DbosExecutor system database pool", () => {
  it("ends the pool it handed DBOS when it shuts DBOS down (DBOS never ends a caller's pool)", async () => {
    await withRdsIamEnv(async (url) => {
      const { handed, shutdown } = stubDbos(async () => {});
      const executor = new DbosExecutor({} as never, { ...config, systemDatabaseUrl: url }, {} as never);
      await executor.launch();
      expect(handed.pool).toBeInstanceOf(pg.Pool);
      pools.push(handed.pool!);
      expect(handed.pool!.ended).toBe(false);
      await executor.close();
      expect(shutdown).toHaveBeenCalled();
      expect(handed.pool!.ended).toBe(true);
    });
  });

  it("ends the pool when DBOS fails to launch, so a retry does not leak it", async () => {
    await withRdsIamEnv(async (url) => {
      const { handed } = stubDbos(async () => {
        throw new Error("db down");
      });
      const executor = new DbosExecutor({} as never, { ...config, systemDatabaseUrl: url }, {} as never);
      await expect(executor.launch()).rejects.toThrow("db down");
      pools.push(handed.pool!);
      expect(handed.pool!.ended).toBe(true);
    });
  });

  it("hands DBOS no pool under password auth", async () => {
    const saved = process.env.DATABASE_AUTH;
    delete process.env.DATABASE_AUTH;
    try {
      const setConfig = vi.spyOn(DBOS, "setConfig").mockImplementation(() => {});
      vi.spyOn(DBOS, "isInitialized").mockReturnValue(false);
      vi.spyOn(DBOS, "launch").mockResolvedValue(undefined);
      vi.spyOn(DBOS, "shutdown").mockResolvedValue(undefined);
      const executor = new DbosExecutor({} as never, config, {} as never);
      await executor.launch();
      expect(setConfig).toHaveBeenCalledWith(dbosLaunchConfig(config, "exec-1", "password"));
      await executor.close();
    } finally {
      if (saved !== undefined) process.env.DATABASE_AUTH = saved;
    }
  });
});
