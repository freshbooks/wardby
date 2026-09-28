// Worker stand-in for the Docker services acceptance test. In the run's shared
// network namespace it must reach the proxy by its alias and PostgreSQL on
// 127.0.0.1; only then does it write the result the launcher collects.
const { writeFileSync } = require("node:fs");
const { get } = require("node:http");
const { connect } = require("node:net");

function proxyAnswers() {
  return new Promise((resolve) => {
    const request = get("http://wardby-proxy:8787/", (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(5_000, () => {
      request.destroy();
      resolve(false);
    });
  });
}

function postgresAnswers() {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port: 5432 }, () => {
      socket.end();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.setTimeout(5_000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

Promise.all([proxyAnswers(), postgresAnswers()]).then(([proxy, postgres]) => {
  if (!proxy || !postgres) {
    process.stdout.write(`${JSON.stringify({ error: "coding_fixture_unreachable" })}\n`);
    process.exit(1);
  }
  writeFileSync(
    "/run/wardby/output/result.json",
    JSON.stringify({
      schemaVersion: 1,
      runId: "docker-services-smoke",
      outcome: "no_changes",
      summary: "fixture",
      tests: [],
    }),
  );
});
