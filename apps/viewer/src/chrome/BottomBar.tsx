import type { GraphRun } from "../api/types";
import type { TickerItem } from "../state/reducer";
import { countByGroup } from "../state/filters";

const TICKER_SHOWN = 5;

const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour12: false });

export function BottomBar({
  runs,
  ticker,
  window,
}: {
  runs: Iterable<GraphRun>;
  ticker: TickerItem[];
  window: string;
}) {
  const counts = countByGroup(runs);
  return (
    <footer className="bottombar">
      <span className="counts">
        ◉ {counts.running} running · ✗ {counts.failed} failed · ✓ {counts.succeeded} done ({window})
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
