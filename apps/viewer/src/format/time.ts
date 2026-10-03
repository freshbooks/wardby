import type { WindowSize } from "../state/filters";

const pad = (n: number) => String(n).padStart(2, "0");

export const hhmm = (t: number) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const withDay = (t: number) => `${WEEKDAYS[new Date(t).getDay()]} ${hhmm(t)}`;

/** Time label for a window: weekday plus time on the 7d view. */
export const formatSpanTime = (win: WindowSize, t: number) => (win === "7d" ? withDay(t) : hhmm(t));

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

/** When something happened, compactly: "10:52" today, "Mon 10:52" this week, else "Sep 28 10:52". */
export function formatEventTime(t: number, now: number = Date.now()): string {
  const d = new Date(t);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return hhmm(t);
  const startOfToday = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  if (t >= startOfToday - 6 * DAY_MS && t < startOfToday) return withDay(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()} ${hhmm(t)}`;
}
