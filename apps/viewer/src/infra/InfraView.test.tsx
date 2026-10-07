import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ kubePodEvents: vi.fn() }));
vi.mock("../api/client", async (orig) => ({ ...(await orig<typeof import("../api/client")>()), ...api }));

import { initialCluster } from "./state";
import { gkeCluster, gkeInfo } from "./fixtures";
import { InfraView } from "./InfraView";
import type { UseCluster } from "./useCluster";

beforeEach(() => {
  api.kubePodEvents.mockResolvedValue([]);
});

const base = (over: Partial<UseCluster> = {}): UseCluster => ({
  info: gkeInfo,
  contexts: { current: "ctx", contexts: ["ctx"] },
  context: "ctx",
  setContext: vi.fn(),
  cluster: gkeCluster,
  loading: false,
  error: null,
  ...over,
});

const renderView = (cluster: UseCluster, extra: Partial<React.ComponentProps<typeof InfraView>> = {}) =>
  render(
    <InfraView
      cluster={cluster}
      mode="table"
      selectedPod={null}
      onSelectPod={vi.fn()}
      onOpenRun={vi.fn()}
      onRetry={vi.fn()}
      {...extra}
    />,
  );

describe("InfraView", () => {
  it("shows loading", () => {
    renderView(base({ loading: true, info: null, cluster: initialCluster }));
    expect(screen.getByText("Loading…")).toBeInTheDocument();
  });

  it("explains a non-Kubernetes launcher", () => {
    renderView(base({ info: { launcher: "docker", kubernetes: null } }));
    expect(
      screen.getByText("This deployment runs coding jobs with Docker / locally, so there is no cluster to show."),
    ).toBeInTheDocument();
  });

  it("renders the table and the panel for the selected pod", async () => {
    renderView(base(), { selectedPod: "wardby-headroom-5b4a-klmno" });
    expect(screen.getByText("ALWAYS ON")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "wardby-headroom-5b4a-klmno" })).toBeInTheDocument();
    await screen.findByText("No recent events");
  });

  it("selects and deselects a pod", () => {
    const onSelectPod = vi.fn();
    renderView(base(), { onSelectPod });
    fireEvent.click(screen.getByRole("button", { name: /headroom/ }));
    expect(onSelectPod).toHaveBeenCalledWith("wardby-headroom-5b4a-klmno");
  });

  it("toggles off the already selected pod", () => {
    const onSelectPod = vi.fn();
    renderView(base(), { onSelectPod, selectedPod: "wardby-headroom-5b4a-klmno" });
    fireEvent.click(screen.getAllByRole("button", { name: /headroom/ })[0]);
    expect(onSelectPod).toHaveBeenCalledWith(null);
  });

  it.each([
    [{ kind: "no_kubeconfig" }, "No kubeconfig found (~/.kube/config or $KUBECONFIG)."],
    [
      { kind: "auth_plugin", message: "token expired" },
      "Your cluster sign-in failed: token expired. Run your cloud's login (e.g. `gcloud auth login`) and retry.",
    ],
    [
      { kind: "forbidden", resource: "pods" },
      "Your Kubernetes account can't list pods in wardby. See the README for a read-only Role.",
    ],
    [{ kind: "namespace_not_found", namespace: "wardby" }, "Namespace wardby was not found in this cluster."],
    [{ kind: "unreachable", message: "timeout" }, "Can't reach the cluster: timeout"],
    [{ kind: "context_not_found", context: "gone" }, "Kube context gone was not found in your kubeconfig."],
  ] as const)("shows a specific message for %j", (error, text) => {
    const onRetry = vi.fn();
    renderView(base({ error }), { onRetry });
    expect(screen.getByText(text)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalled();
  });

  it("notes that the map arrives next when Map is selected", () => {
    renderView(base(), { mode: "map" });
    expect(screen.getByText("Map view arrives in the next step")).toBeInTheDocument();
    expect(screen.getByText("ALWAYS ON")).toBeInTheDocument();
  });
});
