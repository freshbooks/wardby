// A parse worker whose parser hit a bug (not a refusal).
import { parentPort } from "node:worker_threads";
parentPort.on("message", () =>
  parentPort.postMessage({ ok: false, unexpected: true, message: "TypeError: fixture parser bug" }),
);
