import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FramePayload, ServerSummary } from "./api/client";

let servers: ServerSummary[] = [];
let handler: ((p: FramePayload) => void) | null = null;

vi.mock("./api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  listServers: vi.fn(async () => servers),
  addServer: vi.fn(async () => undefined),
  signIn: vi.fn(),
  cancelSignIn: vi.fn(async () => undefined),
  onFrame: vi.fn(async (cb: (p: FramePayload) => void) => {
    handler = cb;
    return () => undefined;
  }),
  connect: vi.fn(async () => undefined),
  disconnect: vi.fn(async () => undefined),
  fetchGraph: vi.fn(async () => ({
    generatedAt: "",
    since: "",
    limit: 500,
    truncated: false,
    runs: [],
    spend: { todayUsd: 4.82, groups: [{ id: "g", name: "g", dailyBudgetUsd: 25, spentTodayUsd: 4.82 }] },
  })),
}));

import * as client from "./api/client";
import { App } from "./App";

beforeEach(() => {
  vi.clearAllMocks();
  servers = [];
  handler = null;
});

describe("App", () => {
  it("shows the server dialog when no servers are saved", async () => {
    render(<App />);
    expect(await screen.findByRole("dialog", { name: /add a wardby server/i })).toBeInTheDocument();
    expect(screen.getByLabelText(/server url/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/client id/i)).toBeInTheDocument();
  });

  it("shows the sign-in gate for a signed-out server and re-reads servers after a cancelled sign-in", async () => {
    servers = [{ name: "Prod", url: "https://w.example", signed_in: false }];
    let reject!: (e: unknown) => void;
    vi.mocked(client.signIn).mockReturnValueOnce(new Promise((_, r) => (reject = r)));
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    // The cancel races a completing sign-in: storage says signed in afterwards.
    servers = [{ name: "Prod", url: "https://w.example", signed_in: true }];
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(client.cancelSignIn).toHaveBeenCalledWith("https://w.example");
    await act(async () => reject({ kind: "cancelled", message: "cancelled" }));
    expect(await screen.findByText(/Today \$4\.82 \/ \$25\.00/)).toBeInTheDocument();
    expect(client.connect).toHaveBeenCalledWith("https://w.example");
  });

  it("shows the live badge and the admin-role message", async () => {
    servers = [{ name: "Prod", url: "https://w.example", signed_in: true }];
    render(<App />);
    await screen.findByText(/Today/);
    act(() => handler!({ server: "https://w.example", frame: { type: "status", connected: true } }));
    expect(screen.getByRole("status")).toHaveTextContent("● live");
    act(() =>
      handler!({ server: "https://w.example", frame: { type: "ended", error: { kind: "forbidden", message: "no" } } }),
    );
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("admin:view"));
  });

  it("selects a newly added server", async () => {
    servers = [{ name: "Prod", url: "https://w.example", signed_in: true }];
    render(<App />);
    await screen.findByText(/Today/);
    fireEvent.change(screen.getByLabelText("Server"), { target: { value: "__add" } });
    fireEvent.change(await screen.findByLabelText(/^name/i), { target: { value: "Dev" } });
    fireEvent.change(screen.getByLabelText(/server url/i), { target: { value: "https://d.example" } });
    servers = [...servers, { name: "Dev", url: "https://d.example", signed_in: true }];
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    await waitFor(() => expect(client.connect).toHaveBeenCalledWith("https://d.example"));
    expect(screen.getByLabelText("Server")).toHaveValue("https://d.example");
  });

  it("closes the server dialog on Escape when other servers exist", async () => {
    servers = [{ name: "Prod", url: "https://w.example", signed_in: true }];
    render(<App />);
    await screen.findByText(/Today/);
    fireEvent.change(screen.getByLabelText("Server"), { target: { value: "__add" } });
    const dialog = await screen.findByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});
