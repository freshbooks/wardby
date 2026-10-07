import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describe as describeCluster } from "./adapter";
import { genericCluster, genericInfo, gkeCluster, gkeInfo, kindCluster, kindInfo, RUN_SHA } from "./fixtures";
import { InfraMap } from "./InfraMap";

const gke = describeCluster(gkeCluster, gkeInfo);

function renderMap(model = gke, props: Partial<Parameters<typeof InfraMap>[0]> = {}) {
  const onSelect = vi.fn();
  const onOpenRun = vi.fn();
  render(<InfraMap model={model} selected={null} onSelect={onSelect} onOpenRun={onOpenRun} {...props} />);
  return { onSelect, onOpenRun };
}

describe("InfraMap", () => {
  it("shows the Internet, Gateway, Cloud SQL and Secret Manager cards", () => {
    renderMap();
    expect(screen.getByText("Internet")).toBeInTheDocument();
    expect(screen.getByText("wardby.example.com")).toBeInTheDocument();
    expect(screen.getByText("Gateway")).toBeInTheDocument();
    expect(screen.getByText(/Cloud Armor/)).toBeInTheDocument();
    expect(screen.getByText("Cloud SQL")).toBeInTheDocument();
    expect(screen.getByText("Secret Manager → 2 Secrets")).toBeInTheDocument();
  });

  it("labels the egress fence with the NetworkPolicy rules", () => {
    renderMap();
    expect(screen.getByText(/NetworkPolicy: pods app\.kubernetes\.io\/name=wardby-coding-proxy/)).toBeInTheDocument();
  });

  it("draws one sandbox per coding run with its containers", () => {
    renderMap();
    const sandbox = screen.getByRole("group", { name: "gVisor sandbox · wardby-run-abc123" });
    expect(within(sandbox).getByText("agent")).toBeInTheDocument();
  });

  it("lists always-on pods with ready counts, containers and identity", () => {
    renderMap();
    const card = screen.getByRole("button", { name: /control-plane/ });
    expect(within(card).getByText("2/2")).toBeInTheDocument();
    expect(within(card).getByText("cloud-sql-proxy")).toBeInTheDocument();
    expect(within(card).getByText(/GSA wardby-app@/)).toBeInTheDocument();
  });

  it("selects a pod on click and marks it pressed", () => {
    const { onSelect } = renderMap(gke, { selected: "wardby-headroom-5b4a-klmno" });
    expect(screen.getByRole("button", { name: /headroom/ })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: /coding-proxy/ }));
    expect(onSelect).toHaveBeenCalledWith("wardby-coding-proxy-7c9d-fghij");
  });

  it("opens the run from the sandbox arrow without selecting", () => {
    const { onOpenRun, onSelect } = renderMap();
    fireEvent.click(screen.getByRole("button", { name: "Open run wardby-run-abc123" }));
    expect(onOpenRun).toHaveBeenCalledWith(RUN_SHA);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says secret names are hidden when unavailable", () => {
    renderMap({ ...gke, secrets: { source: "Secret Manager", names: null } });
    expect(screen.getByText("Secret names hidden (no access)")).toBeInTheDocument();
  });

  it("renders the generic platform with Ingress and external Postgres", () => {
    renderMap(describeCluster(genericCluster, genericInfo));
    expect(screen.getByText("Ingress")).toBeInTheDocument();
    expect(screen.getByText("Postgres (external)")).toBeInTheDocument();
    expect(screen.queryByText(/NetworkPolicy/)).not.toBeInTheDocument();
  });

  it("shows the namespace header and hides jobs finished over an hour ago, like the Table", () => {
    const now = Date.parse("2026-10-01T12:00:00Z");
    const old = new Map([["wardby-migrate", "2026-10-01T09:00:00Z"]]);
    const fresh = new Map([["wardby-migrate", "2026-10-01T11:30:00Z"]]);
    const { rerender } = render(
      <InfraMap
        model={gke}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        namespace="wardby"
        jobFinishedAt={old}
        now={now}
      />,
    );
    expect(screen.getByText("namespace wardby")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /wardby-migrate/ })).not.toBeInTheDocument();
    rerender(
      <InfraMap
        model={gke}
        selected={null}
        onSelect={vi.fn()}
        onOpenRun={vi.fn()}
        namespace="wardby"
        jobFinishedAt={fresh}
        now={now}
      />,
    );
    expect(screen.getByRole("button", { name: /wardby-migrate/ })).toBeInTheDocument();
    expect(screen.getByText("jobs")).toBeInTheDocument();
  });

  it("shows an outside control plane card and a local edge for kind", () => {
    const kind = describeCluster(kindCluster, kindInfo, { serverUrl: "http://127.0.0.1:18080/mcp", context: "kind-x" });
    renderMap(kind);
    expect(screen.getByText("Control plane · outside the cluster · 127.0.0.1:18080")).toBeInTheDocument();
    expect(screen.getByText("Local — no ingress")).toBeInTheDocument();
    expect(screen.queryByText("Internet")).not.toBeInTheDocument();
    expect(screen.getByRole("group", { name: "Pod sandbox · wardby-run-abc123" })).toBeInTheDocument();
  });
});
