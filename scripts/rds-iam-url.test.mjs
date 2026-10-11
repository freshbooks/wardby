import { describe, expect, it } from "vitest";
import { main, tokenUrl } from "./rds-iam-url.mjs";

const URL_IN =
  "postgresql://wardby_migrator@db.x.us-east-1.rds.amazonaws.com:5432/wardby?sslmode=verify-full&sslrootcert=/etc/wardby/rds-ca/global-bundle.pem";

describe("tokenUrl", () => {
  it("sets the URL-encoded token as the password and keeps the parameters", () => {
    const out = new URL(tokenUrl(URL_IN, "a/b+c=d&e"));
    expect(decodeURIComponent(out.password)).toBe("a/b+c=d&e");
    expect(out.username).toBe("wardby_migrator");
    expect(out.searchParams.get("sslmode")).toBe("verify-full");
  });
});

describe("main", () => {
  it("signs for the URL's host, port and user in AWS_REGION", async () => {
    const calls = [];
    const out = await main({ DATABASE_URL: URL_IN, AWS_REGION: "us-east-1" }, (p) => {
      calls.push(p);
      return { getAuthToken: async () => "tok" };
    });
    expect(calls).toEqual([
      { hostname: "db.x.us-east-1.rds.amazonaws.com", port: 5432, username: "wardby_migrator", region: "us-east-1" },
    ]);
    expect(new URL(out).password).toBe("tok");
  });

  it("prefers DATABASE_AWS_REGION over AWS_REGION", async () => {
    const calls = [];
    await main({ DATABASE_URL: URL_IN, AWS_REGION: "us-east-1", DATABASE_AWS_REGION: "eu-west-1" }, (p) => {
      calls.push(p);
      return { getAuthToken: async () => "tok" };
    });
    expect(calls[0].region).toBe("eu-west-1");
  });

  it("refuses a URL that already has a password, or no region", async () => {
    await expect(
      main({ DATABASE_URL: URL_IN.replace("migrator@", "migrator:x@"), AWS_REGION: "us-east-1" }, () => ({})),
    ).rejects.toThrow("takes no password");
    await expect(main({ DATABASE_URL: URL_IN }, () => ({}))).rejects.toThrow("needs AWS_REGION");
  });

  it("refuses a non-postgres URL without echoing it", async () => {
    const err = await main({ DATABASE_URL: "mysql://u:secret@h/db", AWS_REGION: "us-east-1" }, () => ({})).catch(
      (e) => e,
    );
    expect(err.message).toContain("database_auth_invalid: DATABASE_AUTH=rds-iam needs a postgresql://");
    expect(err.message).not.toContain("secret");
  });

  describe("parity with pg-auth", () => {
    const refusal = async (databaseUrl) => {
      let signed = false;
      const err = await main({ DATABASE_URL: databaseUrl, AWS_REGION: "us-east-1" }, () => {
        signed = true;
        return { getAuthToken: async () => "tok" };
      }).catch((e) => e);
      expect(signed).toBe(false);
      expect(err).toBeInstanceOf(Error);
      return err.message;
    };

    it("refuses an empty user name", async () => {
      const msg = await refusal(URL_IN.replace("wardby_migrator@", ""));
      expect(msg).toContain("database_auth_invalid: DATABASE_AUTH=rds-iam needs a user name in DATABASE_URL");
    });

    it("refuses a URL without sslmode=verify-full and sslrootcert", async () => {
      const want = "needs sslmode=verify-full and sslrootcert=<path to the RDS CA bundle> in DATABASE_URL";
      expect(await refusal(URL_IN.split("?")[0])).toContain(want);
      expect(await refusal(URL_IN.replace("verify-full", "require"))).toContain(want);
      expect(await refusal(URL_IN.replace(/&sslrootcert=.*/, ""))).toContain(want);
    });

    it("refuses a malformed percent-encoded user name without echoing the URL", async () => {
      const msg = await refusal(URL_IN.replace("wardby_migrator", "bad%zzuser"));
      expect(msg).toContain(
        "database_auth_invalid: DATABASE_AUTH=rds-iam needs a correctly percent-encoded user name in DATABASE_URL",
      );
      expect(msg).not.toContain("bad%zz");
    });
  });
});
