/** Below this magnitude an amount is float noise, shown as zero. */
const MIN_USD = 1e-9;

/** Readable money: whole cents from $0.10 up, two significant digits below it. */
export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < MIN_USD) return "$0";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  const cents = (n: number) => n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (abs >= 0.1 || Number(abs.toPrecision(2)) >= 0.1) return `${sign}$${cents(abs)}`;
  const decimals = Math.min(100, 1 - Math.floor(Math.log10(abs)));
  const text = abs.toFixed(decimals).replace(/0+$/, "");
  return `${sign}$${text}`;
}

/** The exact amount (6 decimals) for a hover title. */
export function exactUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) < MIN_USD) return "$0.000000";
  return `${value < 0 ? "-" : ""}$${Math.abs(value).toFixed(6)}`;
}
