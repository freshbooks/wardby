import { describe, expect, it } from "vitest";
import type { GraphRun } from "../api/types";
import { trayServices } from "./services";

const run = (overrides: Partial<GraphRun>) =>
  ({ status: "running", declaredServices: [], services: [], ...overrides }) as GraphRun;
const status = (name: string, state: "ready" | "probing" | "pending" | "failed") => ({
  name,
  state,
  attempts: null,
  reason: null,
  readyAt: null,
  failedAt: null,
  createdAt: "x",
});

describe("trayServices", () => {
  it("lists declared services first, then recorded-only ones", () => {
    const t = trayServices(
      run({
        declaredServices: [
          { name: "redis", version: "7" },
          { name: "postgres", version: "16" },
        ],
        services: [status("mysql", "ready"), status("postgres", "ready")],
      }),
    );
    expect(t.map((s) => [s.label, s.state])).toEqual([
      ["redis 7", "pending"],
      ["postgres 16", "ready"],
      ["mysql", "ready"],
    ]);
  });

  it("marks a finished run's unreported services unrecorded", () => {
    const t = trayServices(run({ status: "failed", declaredServices: [{ name: "redis", version: "7" }] }));
    expect(t[0]).toMatchObject({ state: "unrecorded", title: "redis 7: status not recorded" });
  });

  it("copes with a server that predates declaredServices", () => {
    const t = trayServices({ status: "running", services: [status("redis", "ready")] } as unknown as GraphRun);
    expect(t.map((s) => s.label)).toEqual(["redis"]);
  });
});
