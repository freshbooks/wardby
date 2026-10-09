---
id: errors/native-sandbox-worker-exited
title: Native worker exited without a result
summary: The sandbox worker container ended without producing a result.
audience: operator
tags: [error, native-agents, sandbox, native_sandbox_worker_exited]
appliesTo: ">=0.5.4"
---

# Native worker exited without a result

`native_sandbox_worker_exited` means the worker container stopped without reporting a result; the message includes its exit code. Common causes are a tool that exhausted the worker's memory or process limit, or a crash in tool code.

1. Read the exit code in the run's error (`get_run`). Code 137 usually means the memory limit was hit.
2. If limits are the cause, raise `NATIVE_SANDBOX_MEMORY_MB`, `NATIVE_SANDBOX_PIDS`, or `NATIVE_SANDBOX_CPUS` on the server and restart it.
3. Otherwise test the agent's tools with `dry_run_tool` and fix the failing code.
4. Trigger the run again.

See [Run native agents in a sandbox](../native-sandbox.md) and the
[native sandbox guide](../../docs/native-sandbox.md).
