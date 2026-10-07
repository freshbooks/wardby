import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./graph/FlowCanvas", () => ({
  FlowCanvas: ({ runs, onSelect }: { runs: { id: string }[]; onSelect: (id: string) => void }) => (
    <button type="button" onClick={() => onSelect(runs[0].id)}>
      pick-run
    </button>
  ),
}));
vi.mock("./infra/InfraScreen", () => ({
  InfraScreen: (p: { pendingRunSha: string | null; widenWindow: () => boolean; onOpenRun: (id: string) => void }) => (
    <div>
      <button type="button" onClick={() => p.onOpenRun("cmus7t6wd0000hesqosaxwae6")}>
        back
      </button>
      <span data-testid="pending">{p.pendingRunSha ?? "none"}</span>
      <button type="button" onClick={() => document.body.setAttribute("data-widen", String(p.widenWindow()))}>
        widen
      </button>
    </div>
  ),
}));

const run = {
  id: "cmus7t6wd0000hesqosaxwae6",
  parentRunId: null,
  agentId: "a1",
  agentName: "builder",
  agentKind: "coding",
  status: "running",
  trigger: { kind: "manual" },
  turns: 1,
  tokensIn: 0,
  tokensOut: 0,
  costUsd: 0,
  budgetUsd: 1,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  heartbeatAt: null,
  outcomes: [],
  services: [],
};

vi.mock("./api/client", () => ({
  isAppError: () => false,
  listServers: vi.fn(async () => [{ name: "Prod", url: "https://w.example", signed_in: true, kube_context: null }]),
  onFrame: vi.fn(async () => () => undefined),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  fetchGraph: vi.fn(async () => ({
    generatedAt: "",
    since: "",
    limit: 500,
    truncated: false,
    runs: [run],
    spend: { todayUsd: 0, groups: [] },
  })),
  fetchRun: vi.fn(async () => ({ ...run, childRunIds: [], outcomes: [], error: null, finalText: null, coding: null })),
}));

import { App } from "./App";

beforeEach(() => document.body.removeAttribute("data-widen"));

describe("run -> pod cross-link", () => {
  it("Pod button switches to Infrastructure with the run's 40-char sha", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "pick-run" }));
    fireEvent.click(await screen.findByRole("button", { name: /Pod/ }));
    await waitFor(() =>
      expect(screen.getByTestId("pending").textContent).toBe("23425f05854108dc05b6d1c59978b5c27f656089"),
    );
  });

  it("widenWindow widens once and returns false at 7d", async () => {
    render(<App />);
    await screen.findByRole("button", { name: "pick-run" });
    fireEvent.click(screen.getByRole("button", { name: "Infrastructure" }));
    fireEvent.click(await screen.findByRole("button", { name: "widen" }));
    expect(document.body.getAttribute("data-widen")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "widen" }));
    await waitFor(() => {
      fireEvent.click(screen.getByRole("button", { name: "widen" }));
      expect(document.body.getAttribute("data-widen")).toBe("false");
    });
  });

  it("clears the pending sha when leaving the Infrastructure tab", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "pick-run" }));
    fireEvent.click(await screen.findByRole("button", { name: /Pod/ }));
    await screen.findByTestId("pending");
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button", { name: "back" }));
    fireEvent.click(screen.getByRole("button", { name: "Infrastructure" }));
    expect(screen.getByTestId("pending").textContent).toBe("none");
  });
});
