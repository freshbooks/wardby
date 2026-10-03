import { useMemo } from "react";
import type { GraphRun } from "../api/types";
import type { TickerItem } from "../state/reducer";
import { exactUsd, formatUsd } from "../format/money";
import { breakdownText, shownCost } from "../state/cost";
import { countByGroup, type Filters } from "../state/filters";
import { windowSpend } from "./TopBar";

const TICKER_SHOWN = 5;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function BottomBar({
  runs,
  filters,
  ticker,
  window,
}: {
  /** Every run in the snapshot window (not just the visible ones). */
  runs: readonly GraphRun[];
  filters: Filters;
  ticker: TickerItem[];
  window: string;
}) {
  const { matching, shown, byAgent } = useMemo(() => shownCost(runs, filters), [runs, filters]);
  const total = windowSpend(runs);
  const narrowed = Math.abs(total - shown) > 1e-9;
  const counts = countByGroup(matching);
  const breakdown = breakdownText(byAgent);
  const exact = narrowed ? `${exactUsd(shown)} shown of ${exactUsd(total)}` : exactUsd(total);
  const title = breakdown ? `${breakdown}\n${exact}` : exact;
  return (
    <footer className="bottombar">
      <span className="counts">
        ◉ {counts.running} running · ✗ {counts.failed} failed · ✓ {counts.succeeded} done ·{" "}
        <span className="cost" title={title} aria-description={breakdown || undefined} tabIndex={0}>
          {narrowed ? `${formatUsd(shown)} shown of ${formatUsd(total)}` : formatUsd(total)} ({window})
        </span>
      </span>
      <ol className="ticker" aria-label="Recent events">
        {ticker.slice(0, TICKER_SHOWN).map((t, i) => (
          <li key={`${t.at}-${i}`}>
            <time>{clock(t.at)}</time> {t.text}
          </li>
        ))}
      </ol>
    </footer>
  );
}
