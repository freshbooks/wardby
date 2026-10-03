import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { GraphRun } from "../api/types";
import { useClock } from "../graph/clock";
import { statusGroup, WINDOW_MS, type StatusGroup, type TimeRange, type WindowSize } from "../state/filters";
import { bucketIndex, bucketRuns } from "./buckets";

export const TIMELINE_HEIGHT = 72;
const PAD_L = 10;
const PAD_R = 44;
const BASELINE = 46;
const BAR_TOP = 6;
const TICK_Y = 59;
const MARKER_Y = 66;
const DRAG_THRESHOLD = 3;
const MIN_BUCKETS = 48;
const MAX_BUCKETS = 96;
const DEFAULT_WIDTH = 800;
const NOW_STEP_MS = 10_000;

const TICK_STEP_MS: Record<WindowSize, number> = {
  "15m": 5 * 60_000,
  "1h": 10 * 60_000,
  "6h": 60 * 60_000,
  "24h": 4 * 60 * 60_000,
  "7d": 24 * 60 * 60_000,
};

const GROUP_COLOR: Record<StatusGroup, string> = {
  succeeded: "var(--ok)",
  failed: "var(--bad)",
  running: "var(--accent)",
  pending: "var(--muted)",
};
// Stack order bottom to top.
const STACK: StatusGroup[] = ["succeeded", "failed", "running", "pending"];

const pad = (n: number) => String(n).padStart(2, "0");
export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const withDay = (t: number) => `${WEEKDAYS[new Date(t).getDay()]} ${hhmm(t)}`;

export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Time label for a window: weekday plus time on the 7d view. */
export const formatSpanTime = (win: WindowSize, t: number) => (win === "7d" ? withDay(t) : hhmm(t));

const TICK_CHAR_W = 6.5;

/** Anchor a tick label so it stays inside [0, width]: start at the left edge, end at the right. */
export function tickAnchor(x: number, label: string, width: number): "start" | "middle" | "end" {
  const half = (label.length * TICK_CHAR_W) / 2;
  if (x - half < 0) return "start";
  if (x + half > width) return "end";
  return "middle";
}

export function bucketCountFor(width: number): number {
  return Math.max(MIN_BUCKETS, Math.min(MAX_BUCKETS, Math.floor(width / 10)));
}

/** Tick times aligned to local-time multiples of `step`, inside [start, end]. */
export function ticksFor(start: number, end: number, step: number): number[] {
  const off = -new Date(start).getTimezoneOffset() * 60_000;
  const out: number[] = [];
  for (let t = Math.ceil((start + off) / step) * step - off; t <= end; t += step) out.push(t);
  return out;
}

interface Props {
  runs: readonly GraphRun[];
  window: WindowSize;
  timeRange: TimeRange | null;
  onRangeChange: (range: TimeRange | null) => void;
  onSelect: (runId: string) => void;
  selectedId?: string | null;
  /** Override the clock (tests). */
  now?: number;
}

export function Timeline({ runs, window: win, timeRange, onRangeChange, onSelect, selectedId = null, now }: Props) {
  const clock = useClock(true);
  const end = Math.ceil((now ?? clock) / NOW_STEP_MS) * NOW_STEP_MS;
  const start = end - WINDOW_MS[win];

  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(DEFAULT_WIDTH);
  useLayoutEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const measure = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(w);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const x0 = PAD_L;
  const x1 = Math.max(x0 + 1, width - PAD_R);
  const xOf = (t: number) => x0 + ((t - start) / (end - start)) * (x1 - x0);
  const tOf = (x: number) => start + ((Math.min(x1, Math.max(x0, x)) - x0) / (x1 - x0)) * (end - start);

  const count = bucketCountFor(width);
  const spec = useMemo(() => ({ start, end, count }), [start, end, count]);
  const buckets = useMemo(() => bucketRuns(runs, spec), [runs, spec]);
  const max = buckets.reduce((m, b) => Math.max(m, b.total), 0);
  const anyRunning = runs.some((r) => r.status === "running");

  const markers = useMemo(
    () =>
      runs
        .map((r) => ({ run: r, t: Date.parse(r.startedAt) }))
        .filter((m) => bucketIndex(m.t, spec) >= 0)
        .sort((a, b) => a.t - b.t || (a.run.id < b.run.id ? -1 : 1)),
    [runs, spec],
  );
  const [active, setActive] = useState(0);
  const activeIdx = Math.min(active, Math.max(0, markers.length - 1));
  const markerRefs = useRef<(SVGGElement | null)[]>([]);

  const ticks = useMemo(() => ticksFor(start, end, TICK_STEP_MS[win]), [start, end, win]);
  const fmtTick = win === "7d" ? (t: number) => WEEKDAYS[new Date(t).getDay()]! : hhmm;
  const fmtSpan = (t: number) => formatSpanTime(win, t);

  // Pointer position in SVG user units.
  const localX = (e: PointerEvent) => {
    const rect = svgRef.current!.getBoundingClientRect();
    const scale = rect.width > 0 ? width / rect.width : 1;
    return (e.clientX - rect.left) * scale;
  };

  const drag = useRef<{ startX: number; moved: boolean } | null>(null);
  const [band, setBand] = useState<{ a: number; b: number } | null>(null);
  const [hover, setHover] = useState<{ x: number; text: string } | null>(null);

  const onMarker = (target: EventTarget) => (target as Element).closest?.("[data-run-id]") != null;

  const onPointerDown = (e: PointerEvent<SVGSVGElement>) => {
    if (e.button > 0 || onMarker(e.target)) return;
    drag.current = { startX: localX(e), moved: false };
    setHover(null);
    try {
      e.currentTarget.setPointerCapture?.(e.pointerId);
    } catch {
      // Capture is best effort (synthetic pointers).
    }
  };

  const onPointerMove = (e: PointerEvent<SVGSVGElement>) => {
    const x = localX(e);
    const d = drag.current;
    if (d) {
      if (!d.moved && Math.abs(x - d.startX) < DRAG_THRESHOLD) return;
      d.moved = true;
      setBand({ a: d.startX, b: x });
      return;
    }
    const i = bucketIndex(tOf(x), spec);
    const b = i >= 0 && x >= x0 && x <= x1 ? buckets[i] : undefined;
    if (!b || b.total === 0) return setHover(null);
    const failed = b.counts.failed;
    setHover({
      x,
      text: `${fmtSpan(b.from)}–${fmtSpan(b.to)} · ${plural(b.total, "run")}${failed ? ` (${failed} failed)` : ""} · $${b.costUsd.toFixed(2)}`,
    });
  };

  const onPointerUp = (e: PointerEvent<SVGSVGElement>) => {
    const d = drag.current;
    drag.current = null;
    setBand(null);
    if (!d) return;
    if (d.moved) {
      const a = tOf(d.startX);
      const b = tOf(localX(e));
      onRangeChange({ from: Math.min(a, b), to: Math.max(a, b) });
    } else if (!onMarker(e.target)) {
      onRangeChange(null);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" && timeRange) {
      e.preventDefault();
      onRangeChange(null);
    }
  };

  const focusMarker = (i: number) => {
    setActive(i);
    markerRefs.current[i]?.focus();
  };

  const barW = Math.max(1, (x1 - x0) / count - 1);
  const shownBand = band
    ? { a: Math.min(band.a, band.b), b: Math.max(band.a, band.b) }
    : timeRange
      ? { a: xOf(Math.max(start, timeRange.from)), b: xOf(Math.min(end, timeRange.to)) }
      : null;

  return (
    <div className="timeline" role="group" aria-label="Timeline" tabIndex={0} onKeyDown={onKeyDown}>
      <svg
        ref={svgRef}
        className="timeline-svg"
        width="100%"
        height={TIMELINE_HEIGHT}
        viewBox={`0 0 ${width} ${TIMELINE_HEIGHT}`}
        data-testid="timeline-svg"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          drag.current = null;
          setBand(null);
        }}
        onPointerLeave={() => setHover(null)}
      >
        <line className="timeline-baseline" x1={x0} x2={x1} y1={BASELINE} y2={BASELINE} />
        {ticks.map((t) => {
          const label = fmtTick(t);
          const x = xOf(t);
          return (
            <g key={t} className="timeline-tick">
              <line x1={x} x2={x} y1={BASELINE} y2={BASELINE + 3} />
              <text x={x} y={TICK_Y} textAnchor={tickAnchor(x, label, width)}>
                {label}
              </text>
            </g>
          );
        })}
        {shownBand && (
          <rect
            className="timeline-band"
            x={shownBand.a}
            y={BAR_TOP - 2}
            width={Math.max(1, shownBand.b - shownBand.a)}
            height={BASELINE - BAR_TOP + 2}
          />
        )}
        {buckets.map((b, i) => {
          if (b.total === 0) return null;
          const full = Math.max(2, (b.total / max) * (BASELINE - BAR_TOP));
          let y = BASELINE;
          return (
            <g key={i} className="timeline-bucket" data-testid="timeline-bucket">
              {STACK.map((g) => {
                const n = b.counts[g];
                if (n === 0) return null;
                const h = (n / b.total) * full;
                y -= h;
                return (
                  <rect
                    key={g}
                    className={`bar ${g}`}
                    x={x0 + i * ((x1 - x0) / count)}
                    y={y}
                    width={barW}
                    height={h}
                    fill={GROUP_COLOR[g]}
                  />
                );
              })}
            </g>
          );
        })}
        <g className={`timeline-now${anyRunning ? " pulse" : ""}`}>
          <line x1={x1} x2={x1} y1={BAR_TOP - 2} y2={BASELINE + 3} />
          <circle cx={x1} cy={BAR_TOP - 2} r={3} />
          <text x={x1 + 6} y={BAR_TOP + 4}>
            now
          </text>
        </g>
        {markers.map(({ run, t }, i) => {
          const group = statusGroup(run.status);
          const cx = xOf(t);
          const label = `${run.agentName}, ${run.status}, started ${hhmm(t)}`;
          return (
            <g
              key={run.id}
              ref={(el) => {
                markerRefs.current[i] = el;
              }}
              className={`timeline-marker ${group}${run.id === selectedId ? " selected" : ""}`}
              data-run-id={run.id}
              role="button"
              tabIndex={i === activeIdx ? 0 : -1}
              aria-label={label}
              aria-pressed={run.id === selectedId}
              onFocus={() => setActive(i)}
              onClick={() => onSelect(run.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  onSelect(run.id);
                } else if (e.key === "ArrowRight" && i < markers.length - 1) {
                  e.preventDefault();
                  focusMarker(i + 1);
                } else if (e.key === "ArrowLeft" && i > 0) {
                  e.preventDefault();
                  focusMarker(i - 1);
                }
              }}
            >
              <title>{label}</title>
              <circle className="hit" cx={cx} cy={MARKER_Y} r={5} />
              {group === "failed" ? (
                <text className="x" x={cx} y={MARKER_Y + 3.5} textAnchor="middle">
                  ✕
                </text>
              ) : (
                <circle className="dot" cx={cx} cy={MARKER_Y} r={2.5} fill={GROUP_COLOR[group]} />
              )}
            </g>
          );
        })}
      </svg>
      {hover && (
        <div role="tooltip" className="timeline-tooltip" style={{ left: `${(hover.x / width) * 100}%` }}>
          {hover.text}
        </div>
      )}
    </div>
  );
}
