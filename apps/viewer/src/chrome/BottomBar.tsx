import { useMemo } from "react";
import type { GraphRun } from "../api/types";
import type { TickerItem } from "../state/reducer";
import { exactUsd, formatUsd } from "../format/money";
import { breakdownText, shownCost } from "../state/cost";
import { countByGroup, type Filters } from "../state/filters";
import { formatWindowTotal, TRUNCATED_TITLE, windowSpend } from "../format/spend";

const TICKER_SHOWN = 5;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function BottomBar({
  runs,
  filters,
  ticker,
  window,
  truncated = false,
}: {
  /** Every run in the snapshot window (not just the visible ones). */
  runs: readonly GraphRun[];
  filters: Filters;
  ticker: TickerItem[];
  window: string;
  /** The snapshot hit its row limit, so the window total is a lower bound. */
  truncated?: boolean;
}) {
  const { matching, shown, byAgent } = useMemo(() => shownCost(runs, filters), [runs, filters]);
  const total = windowSpend(runs);
  const narrowed = matching.length !== runs.length;
  const counts = countByGroup(matching);
  const breakdown = breakdownText(byAgent);
  const totalText = formatWindowTotal(total, truncated);
  const exactTotal = `${truncated ? "≥" : ""}${exactUsd(total)}`;
  const exact = narrowed ? `${exactUsd(shown)} shown of ${exactTotal}` : exactTotal;
  const title = [breakdown, exact, truncated ? TRUNCATED_TITLE : ""].filter(Boolean).join("\n");
  return (
    <footer className="bottombar">
      <span className="counts">
        ◉ {counts.running} running · ✗ {counts.failed} failed · ✓ {counts.succeeded} done ·{" "}
        <span className="cost" title={title} aria-description={breakdown || undefined} tabIndex={0}>
          {narrowed ? `${formatUsd(shown)} shown of ${totalText}` : totalText} ({window})
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
