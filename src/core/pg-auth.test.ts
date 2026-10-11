import { describe, expect, it, vi } from "vitest";
import { DATABASE_AUTH_ERROR, cachedToken, databaseAuthFromEnv, pgConnectionConfig } from "./pg-auth.js";

const RDS_URL =
  "postgresql://wardby_app@db.abc123.us-east-1.rds.amazonaws.com:5432/wardby?sslmode=verify-full&sslrootcert=/etc/wardby/rds-ca/global-bundle.pem";
const env = { AWS_REGION: "us-east-1" };
const readFile = (path: string) => `CA(${path})`;

describe("databaseAuthFromEnv", () => {
  it("defaults to password and accepts rds-iam", () => {
    expect(databaseAuthFromEnv({})).toBe("password");
    expect(databaseAuthFromEnv({ DATABASE_AUTH: " " })).toBe("password");
    expect(databaseAuthFromEnv({ DATABASE_AUTH: "rds-iam" })).toBe("rds-iam");
  });
  it("refuses anything else", () => {
    expect(() => databaseAuthFromEnv({ DATABASE_AUTH: "iam" })).toThrow(DATABASE_AUTH_ERROR);
  });
});

describe("pgConnectionConfig", () => {
  it("is exactly { connectionString } under password auth", () => {
    expect(pgConnectionConfig("postgresql://u:p@h/db", "password")).toEqual({
      connectionString: "postgresql://u:p@h/db",
    });
  });

  it("builds explicit fields, a token password, and verified TLS under rds-iam", async () => {
    const makeSigner = vi.fn(() => ({ getAuthToken: async () => "tok-1" }));
    const config = pgConnectionConfig(RDS_URL, "rds-iam", { env, makeSigner, readFile });
    expect(config.connectionString).toBeUndefined();
    expect(config).toMatchObject({
      host: "db.abc123.us-east-1.rds.amazonaws.com",
      port: 5432,
      user: "wardby_app",
      database: "wardby",
      ssl: {
        ca: "CA(/etc/wardby/rds-ca/global-bundle.pem)",
        rejectUnauthorized: true,
        servername: "db.abc123.us-east-1.rds.amazonaws.com",
      },
    });
    expect(makeSigner).toHaveBeenCalledWith({
      hostname: "db.abc123.us-east-1.rds.amazonaws.com",
      port: 5432,
      username: "wardby_app",
      region: "us-east-1",
    });
    expect(typeof config.password).toBe("function");
    await expect((config.password as () => Promise<string>)()).resolves.toBe("tok-1");
  });

  it("prefers DATABASE_AWS_REGION and defaults the port", () => {
    const makeSigner = vi.fn(() => ({ getAuthToken: async () => "t" }));
    const url = RDS_URL.replace(":5432", "");
    const config = pgConnectionConfig(url, "rds-iam", {
      env: { AWS_REGION: "us-east-1", DATABASE_AWS_REGION: "eu-west-1" },
      makeSigner,
      readFile,
    });
    expect(config.port).toBe(5432);
    expect(makeSigner).toHaveBeenCalledWith(expect.objectContaining({ region: "eu-west-1" }));
  });

  it.each([
    ["a password in the URL", RDS_URL.replace("wardby_app@", "wardby_app:secret@"), env, "takes no password"],
    ["no user", RDS_URL.replace("wardby_app@", ""), env, "needs a user name"],
    ["no region", RDS_URL, {}, "needs AWS_REGION"],
    ["sslmode=require", RDS_URL.replace("verify-full", "require"), env, "needs sslmode=verify-full"],
    ["no sslrootcert", RDS_URL.replace(/&sslrootcert=[^&]+/, ""), env, "needs sslmode=verify-full"],
  ])("refuses %s", (_name, url, e, message) => {
    expect(() =>
      pgConnectionConfig(url, "rds-iam", { env: e, readFile, makeSigner: () => ({ getAuthToken: async () => "" }) }),
    ).toThrow(message);
  });

  it.each(["mysql://wardby_app@db.example:3306/wardby", "http://wardby_app@db.example/wardby"])(
    "refuses a non-postgres scheme: %s",
    (base) => {
      const url = `${base}?sslmode=verify-full&sslrootcert=/ca.pem`;
      expect(() => pgConnectionConfig(url, "rds-iam", { env, readFile })).toThrow(
        `${DATABASE_AUTH_ERROR}: DATABASE_AUTH=rds-iam needs a postgresql:// (or postgres://) DATABASE_URL`,
      );
    },
  );

  it("accepts the postgres:// scheme too", () => {
    const url = RDS_URL.replace("postgresql://", "postgres://");
    expect(pgConnectionConfig(url, "rds-iam", { env, readFile }).host).toBe("db.abc123.us-east-1.rds.amazonaws.com");
  });

  it("carries pg's session parameters over from the URL, as pg would read them from a connection string", () => {
    const params =
      "&application_name=wardby-mcp&fallback_application_name=wardby&options=-c%20search_path%3Dapp" +
      "&client_encoding=UTF8&statement_timeout=5000&lock_timeout=1000" +
      "&idle_in_transaction_session_timeout=60000&query_timeout=7000";
    const config = pgConnectionConfig(RDS_URL + params, "rds-iam", { env, readFile });
    expect(config).toMatchObject({
      application_name: "wardby-mcp",
      fallback_application_name: "wardby",
      options: "-c search_path=app",
      client_encoding: "UTF8",
      statement_timeout: "5000",
      lock_timeout: "1000",
      idle_in_transaction_session_timeout: "60000",
      query_timeout: "7000",
    });
  });

  it("omits session parameters the URL does not set", () => {
    const config = pgConnectionConfig(RDS_URL, "rds-iam", { env, readFile });
    expect(Object.keys(config).sort()).toEqual(["database", "host", "password", "port", "ssl", "user"]);
  });

  it("accepts the pool, Prisma and timeout parameters other code reads from the URL", () => {
    const url = `${RDS_URL}&connection_limit=5&pool_timeout=20&connect_timeout=3&schema=public`;
    expect(() => pgConnectionConfig(url, "rds-iam", { env, readFile })).not.toThrow();
  });

  it.each([
    "sslcert",
    "sslkey",
    "sslpassword",
    "ssl",
    "sslnegotiation",
    "uselibpqcompat",
    "host",
    "replication",
    "pgbouncer",
    "made_up",
  ])("refuses the URL parameter %s, naming it", (param) => {
    expect(() => pgConnectionConfig(`${RDS_URL}&${param}=x`, "rds-iam", { env, readFile })).toThrow(
      `${DATABASE_AUTH_ERROR}: DATABASE_AUTH=rds-iam does not support the DATABASE_URL parameter "${param}"`,
    );
  });

  it("never echoes a refused parameter's value", () => {
    expect(() => pgConnectionConfig(`${RDS_URL}&sslkey=%2Fsecret%2Fkey.pem`, "rds-iam", { env, readFile })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("secret") }),
    );
  });

  it("never echoes the URL's password in a refusal", () => {
    const url = RDS_URL.replace("wardby_app@", "wardby_app:s3cr3t-value@");
    expect(() => pgConnectionConfig(url, "rds-iam", { env, readFile })).toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("s3cr3t-value") }),
    );
  });
});

describe("cachedToken", () => {
  it("reuses a token inside the window, re-signs after it, and shares one in-flight request", async () => {
    let clock = 0;
    let n = 0;
    const signer = { getAuthToken: vi.fn(async () => `t${++n}`) };
    const token = cachedToken(signer, () => clock, 1000);
    const [a, b] = await Promise.all([token(), token()]);
    expect([a, b]).toEqual(["t1", "t1"]);
    clock = 999;
    expect(await token()).toBe("t1");
    clock = 1000;
    expect(await token()).toBe("t2");
    expect(signer.getAuthToken).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failure", async () => {
    const signer = { getAuthToken: vi.fn().mockRejectedValueOnce(new Error("no creds")).mockResolvedValue("ok") };
    const token = cachedToken(signer, () => 0, 1000);
    await expect(token()).rejects.toThrow("no creds");
    await expect(token()).resolves.toBe("ok");
  });
});
