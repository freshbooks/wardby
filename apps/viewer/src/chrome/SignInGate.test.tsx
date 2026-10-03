import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api/client", () => ({
  isAppError: (e: unknown) => typeof e === "object" && e !== null && "kind" in e && "message" in e,
  signIn: vi.fn(() => new Promise<void>(() => undefined)),
  cancelSignIn: vi.fn(async () => undefined),
  listServers: vi.fn(async () => []),
}));

import * as client from "../api/client";
import { SignInGate } from "./SignInGate";

const server = { name: "Prod", url: "https://w.example" };

beforeEach(() => vi.clearAllMocks());

describe("SignInGate", () => {
  it("cancels a pending sign-in when it unmounts, so the next attempt is not blocked", () => {
    const { unmount } = render(<SignInGate server={server} onChecked={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(client.signIn).toHaveBeenCalledWith("https://w.example");
    unmount();
    expect(client.cancelSignIn).toHaveBeenCalledWith("https://w.example");
  });

  it("does not cancel anything when it unmounts idle", () => {
    const { unmount } = render(<SignInGate server={server} onChecked={() => undefined} />);
    unmount();
    expect(client.cancelSignIn).not.toHaveBeenCalled();
  });
});
