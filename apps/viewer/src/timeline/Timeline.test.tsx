import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GraphRun } from "../api/types";
import { Timeline, hhmm, tickAnchor } from "./Timeline";

const NOW = Date.UTC(2026, 0, 1, 13, 0, 0);
const MIN = 60_000;
const run = (id: string, minAgo: number, over: Partial<GraphRun> = {}): GraphRun =>
  ({
    id,
    agentName: `agent-${id}`,
    status: "succeeded",
    costUsd: 0.02,
    startedAt: new Date(NOW - minAgo * MIN).toISOString(),
    ...over,
  }) as GraphRun;

const runs = [
  run("a", 50),
  run("b", 20, { status: "failed" }),
  run("c", 20, { costUsd: 0.02 }),
  run("d", 5, { status: "running" }),
];

// Svg is 800 wide; the plot spans x = 10 .. 756 over the last hour.
beforeEach(() => {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    right: 800,
    bottom: 72,
    width: 800,
    height: 72,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  });
  // jsdom has no PointerEvent: mouse events carry clientX and the handlers read it.
  if (!("PointerEvent" in globalThis)) {
    (globalThis as { PointerEvent?: unknown }).PointerEvent = class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerId = init.pointerId ?? 1;
      }
    };
  }
});

const setup = (props: Partial<Parameters<typeof Timeline>[0]> = {}) => {
  const onRangeChange = vi.fn();
  const onSelect = vi.fn();
  const utils = render(
    <Timeline
      runs={runs}
      window="1h"
      timeRange={null}
      onRangeChange={onRangeChange}
      onSelect={onSelect}
      now={NOW}
      {...props}
    />,
  );
  return { onRangeChange, onSelect, svg: screen.getByTestId("timeline-svg"), ...utils };
};

const drag = (svg: Element, from: number, to: number) => {
  fireEvent.pointerDown(svg, { clientX: from, clientY: 20, pointerId: 1 });
  fireEvent.pointerMove(svg, { clientX: to, clientY: 20, pointerId: 1 });
  fireEvent.pointerUp(svg, { clientX: to, clientY: 20, pointerId: 1 });
};

describe("Timeline", () => {
  it("draws a stacked bar per non-empty bucket", () => {
    setup();
    // a, b+c (same bucket), d
    expect(screen.getAllByTestId("timeline-bucket")).toHaveLength(3);
    const shared = screen.getAllByTestId("timeline-bucket")[1]!;
    expect(shared.querySelector(".bar.succeeded")).not.toBeNull();
    expect(shared.querySelector(".bar.failed")).not.toBeNull();
  });

  it("shows a tooltip for a hovered bucket", () => {
    const { svg } = setup();
    // 20 minutes ago -> x = 10 + (40/60) * 746
    fireEvent.pointerMove(svg, { clientX: 10 + (40 / 60) * 746 + 1, clientY: 20 });
    const tip = screen.getByRole("tooltip");
    expect(tip).toHaveTextContent(/2 runs \(1 failed\) · \$0\.04/);
    expect(tip.textContent).toMatch(/\d\d:\d\d–\d\d:\d\d/);
  });

  it("brushes a range on drag and reports it", () => {
    const { svg, onRangeChange } = setup();
    drag(svg, 10, 10 + 373);
    expect(onRangeChange).toHaveBeenCalledTimes(1);
    const { from, to } = onRangeChange.mock.calls[0]![0] as { from: number; to: number };
    expect(from).toBeCloseTo(NOW - 60 * MIN, -3);
    expect(to).toBeCloseTo(NOW - 30 * MIN, -3);
  });

  it("clears on a click on empty space", () => {
    const { svg, onRangeChange } = setup({ timeRange: { from: NOW - 30 * MIN, to: NOW } });
    drag(svg, 300, 300);
    expect(onRangeChange).toHaveBeenCalledWith(null);
  });

  it("Escape clears the range", () => {
    const { onRangeChange } = setup({ timeRange: { from: NOW - 30 * MIN, to: NOW } });
    fireEvent.keyDown(screen.getByRole("group", { name: "Timeline" }), { key: "Escape" });
    expect(onRangeChange).toHaveBeenCalledWith(null);
    expect(screen.queryByRole("button", { name: /clear time range/i })).toBeNull();
  });

  it("keeps every tick label inside the bar", () => {
    for (const win of ["1h", "6h", "24h", "7d"] as const) {
      const { container, unmount } = setup({ window: win });
      const texts = [...container.querySelectorAll<SVGTextElement>(".timeline-tick text")];
      expect(texts.length).toBeGreaterThan(1);
      for (const t of texts) {
        const x = Number(t.getAttribute("x"));
        const half = ((t.textContent ?? "").length * 6.5) / 2;
        const a = t.getAttribute("text-anchor");
        const left = a === "start" ? x : a === "end" ? x - 2 * half : x - half;
        expect(left).toBeGreaterThanOrEqual(0);
        expect(left + 2 * half).toBeLessThanOrEqual(800);
      }
      unmount();
    }
  });

  it("anchors edge labels inward", () => {
    expect(tickAnchor(10, "04:00", 800)).toBe("start");
    expect(tickAnchor(400, "04:00", 800)).toBe("middle");
    expect(tickAnchor(795, "04:00", 800)).toBe("end");
  });

  it("selects a run from its marker by click and Enter, with an accessible name", () => {
    const { onSelect } = setup();
    const marker = screen.getByRole("button", { name: `agent-b, failed, started ${hhmm(NOW - 20 * MIN)}` });
    fireEvent.click(marker);
    expect(onSelect).toHaveBeenCalledWith("b");
    onSelect.mockClear();
    fireEvent.keyDown(screen.getByRole("button", { name: /agent-d, running/ }), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("d");
  });

  it("does not clear or brush when a marker is pressed", () => {
    const { onRangeChange } = setup({ timeRange: { from: NOW - 30 * MIN, to: NOW } });
    const marker = screen.getByRole("button", { name: /agent-d/ });
    fireEvent.pointerDown(marker, { clientX: 700, clientY: 66 });
    fireEvent.pointerUp(marker, { clientX: 700, clientY: 66 });
    expect(onRangeChange).not.toHaveBeenCalled();
  });

  it("ignores runs outside the window", () => {
    setup({ runs: [run("old", 90)] });
    expect(screen.queryAllByRole("button", { name: /agent-old/ })).toHaveLength(0);
  });
});
