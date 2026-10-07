import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSummary } from "./api/client";

vi.mock("./graph/FlowCanvas", () => ({ FlowCanvas: () => null }));

const state = vi.hoisted(() => ({
  servers: [] as ServerSummary[],
  saveFails: false,
}));

vi.mock("./api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  listServers: vi.fn(async () => state.servers.map((s) => ({ ...s }))),
  onFrame: vi.fn(async () => () => undefined),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  fetchGraph: vi.fn(async () => ({
    generatedAt: "",
    since: "",
    limit: 500,
    truncated: false,
    runs: [],
    spend: { todayUsd: 0, groups: [] },
  })),
  fetchInfra: vi.fn(async () => ({
    launcher: "kubernetes",
    kubernetes: {
      namespace: "wardby",
      platform: "generic",
      runtimeClass: null,
      proxyService: "proxy",
      runLabel: "wardby.io/run-sha256",
      runLabelHashChars: 40,
      componentLabel: {},
      managedByLabel: {},
    },
  })),
  kubeContexts: vi.fn(async () => ({ current: "cur", contexts: ["cur", "other"] })),
  setKubeContext: vi.fn(async (url: string, context: string | null) => {
    if (state.saveFails) throw { kind: "storage", message: "disk full" };
    state.servers = state.servers.map((s) => (s.url === url ? { ...s, kube_context: context } : s));
  }),
  kubeConnect: vi.fn(async () => undefined),
  kubeDisconnect: vi.fn(async () => undefined),
  kubePodEvents: vi.fn(async () => []),
  onCluster: vi.fn(async () => () => undefined),
}));

import * as client from "./api/client";
import { App } from "./App";

beforeEach(() => {
  vi.clearAllMocks();
  state.servers = [{ name: "Prod", url: "https://w.example", signed_in: true, kube_context: null }];
  state.saveFails = false;
});

const openInfra = async () => {
  fireEvent.click(await screen.findByRole("button", { name: "Infrastructure" }));
  return screen.findByRole("combobox", { name: "Kube context" });
};

describe("kube context choice", () => {
  it("survives leaving and reopening the Infrastructure tab", async () => {
    render(<App />);
    const picker = await openInfra();
    await waitFor(() => expect(client.kubeConnect).toHaveBeenLastCalledWith("https://w.example", "cur", "wardby"));
    fireEvent.change(picker, { target: { value: "other" } });
    await waitFor(() => expect(client.kubeConnect).toHaveBeenLastCalledWith("https://w.example", "other", "wardby"));
    await waitFor(() => expect(client.listServers).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getByRole("button", { name: "Runs" }));
    vi.mocked(client.kubeConnect).mockClear();
    await openInfra();
    await waitFor(() => expect(client.kubeConnect).toHaveBeenCalled());
    expect(client.kubeConnect).toHaveBeenLastCalledWith("https://w.example", "other", "wardby");
  });

  it("says when the choice could not be saved", async () => {
    state.saveFails = true;
    render(<App />);
    const picker = await openInfra();
    fireEvent.change(picker, { target: { value: "other" } });
    expect(await screen.findByText("Couldn't save the kube context for this server: disk full")).toBeInTheDocument();
    // It still applies for now.
    await waitFor(() => expect(client.kubeConnect).toHaveBeenLastCalledWith("https://w.example", "other", "wardby"));
  });
});
