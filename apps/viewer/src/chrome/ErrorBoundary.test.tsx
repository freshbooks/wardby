import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom({ message }: { message: string }): never {
  throw new Error(message);
}

afterEach(() => vi.restoreAllMocks());

describe("ErrorBoundary", () => {
  it("renders its children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText("fine")).toBeInTheDocument();
  });

  it("shows the error and reloads on demand", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onReload = vi.fn();
    render(
      <ErrorBoundary onReload={onReload}>
        <Boom message="bad graph" />
      </ErrorBoundary>,
    );
    expect(screen.getByRole("alert")).toHaveTextContent("bad graph");
    fireEvent.click(screen.getByRole("button", { name: "Reload" }));
    expect(onReload).toHaveBeenCalledTimes(1);
  });
});
