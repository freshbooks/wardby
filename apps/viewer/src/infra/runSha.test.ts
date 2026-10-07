import { expect, it } from "vitest";
import { runSha } from "./runSha";

it("is the first 40 hex chars of the SHA-256 of the run id", async () => {
  expect(await runSha("cmus7t6wd0000hesqosaxwae6")).toBe("23425f05854108dc05b6d1c59978b5c27f656089");
  expect(await runSha("cmus7t6wd0000hesqosaxwae6", 8)).toBe("23425f05");
});
