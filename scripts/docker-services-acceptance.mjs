import { execFileSync, spawnSync } from "node:child_process";

const requestedImage = process.env.WARDBY_WORKER_IMAGE ?? "wardby-coding-worker:phase5-smoke";
let platform;
try {
  // The fixture is built for the worker image's own platform: a single-platform image on a host of
  // another architecture (an amd64 worker on Apple silicon) cannot be resolved as a local base otherwise.
  platform = execFileSync("docker", ["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", requestedImage], {
    encoding: "utf8",
  }).trim();
} catch {
  process.stderr.write(`Worker image not found: ${requestedImage}\n`);
  process.exit(1);
}

const fixtureTag = `wardby-docker-services-fixture-${process.pid}`;
const fixtureSource = [
  `FROM ${requestedImage}`,
  "USER root",
  "COPY scripts/docker-job-keeper-fixture.js /opt/wardby/coding-worker/keeper.js",
  "COPY scripts/docker-services-worker-fixture.js /opt/wardby/fixture/worker.js",
  "USER 10001:10001",
  'ENTRYPOINT ["node", "/opt/wardby/fixture/worker.js"]',
].join("\n");
const built = spawnSync(
  "docker",
  ["build", "--quiet", "--platform", platform, "--tag", fixtureTag, "--file", "-", "."],
  {
    cwd: new URL("..", import.meta.url),
    input: fixtureSource,
    encoding: "utf8",
  },
);
if (built.status !== 0) {
  process.stderr.write(built.stderr || "Unable to build the Docker services fixture image.\n");
  process.exit(built.status ?? 1);
}

const fixtureImage = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", fixtureTag], {
  encoding: "utf8",
}).trim();
const vitest = new URL("../node_modules/vitest/vitest.mjs", import.meta.url);
const result = spawnSync(
  process.execPath,
  [vitest.pathname, "run", "src/providers/jobs/docker-services.integration.test.ts"],
  {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, WARDBY_DOCKER_SERVICES_TEST: "1", WARDBY_DOCKER_SERVICES_FIXTURE_IMAGE: fixtureImage },
    stdio: "inherit",
  },
);
spawnSync("docker", ["image", "rm", "--force", fixtureTag], { stdio: "ignore" });
process.exit(result.status ?? 1);
