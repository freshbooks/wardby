import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { describe as describeCluster } from "./adapter";
import { genericCluster, genericInfo, gkeCluster, gkeInfo, RUN_SHA } from "./fixtures";
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
    fireEvent.click(screen.getByRole("button", { name: "Open run" }));
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
});
