// Fails when a coding-worker image carries a different protocol.js than this source tree builds.
//
// The Codex worker image is a thin layer on a pinned driver image, and protocol.js (the worker's
// input validator) lives in that driver layer. Changing src/coding/protocol.ts without publishing a
// new driver-v* and pinning it leaves every rebuilt worker image validating with the old protocol.
//
// Usage (after `npx tsc -p tsconfig.build.json`, so dist/coding/protocol.js is current):
//   node scripts/check-worker-protocol.mjs <image-ref>
//   node scripts/check-worker-protocol.mjs --from-dockerfile src/coding-worker/Dockerfile
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PROTOCOL_IN_IMAGE = "/opt/wardby/coding/protocol.js";
const args = process.argv.slice(2);

function imageFromDockerfile(path) {
  const from = readFileSync(path, "utf8")
    .split("\n")
    .find((line) => /^FROM\s/i.test(line));
  if (!from) throw new Error(`${path} has no FROM line`);
  return from.trim().split(/\s+/)[1];
}

const image = args[0] === "--from-dockerfile" ? imageFromDockerfile(args[1]) : args[0];
if (!image) {
  process.stderr.write("usage: check-worker-protocol.mjs <image-ref> | --from-dockerfile <path>\n");
  process.exit(2);
}

const expected = readFileSync(new URL("../dist/coding/protocol.js", import.meta.url), "utf8");
// A locally built tag isn't in any registry; only pull what isn't here yet.
try {
  execFileSync("docker", ["image", "inspect", image], { stdio: "ignore" });
} catch {
  execFileSync("docker", ["pull", "--quiet", image], { stdio: "ignore" });
}
const actual = execFileSync("docker", ["run", "--rm", "--entrypoint", "cat", image, PROTOCOL_IN_IMAGE], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "inherit"],
});

if (actual !== expected) {
  process.stderr.write(
    `${image}: ${PROTOCOL_IN_IMAGE} differs from src/coding/protocol.ts as built here.\n` +
      "The coding-worker driver image predates a protocol change. Publish a new driver " +
      "(push a driver-v* tag) and pin its digest in src/coding-worker/Dockerfile and Dockerfile.node-python.\n",
  );
  process.exit(1);
}
process.stdout.write(`${image}: protocol.js matches source\n`);
