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
