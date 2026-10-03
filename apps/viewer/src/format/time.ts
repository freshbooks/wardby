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
