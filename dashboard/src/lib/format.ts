export function fmtUsd(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  return `$${value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  })}`;
}

export function fmtTokens(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "—";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

/** Formats counts/numbers: raw if < 1000, else rounded to K, M, B (e.g. 1.2K, 3.4M) */
export function fmtCount(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "0";
  if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(Math.round(value));
}

export function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Formats a timestamp into date + time in the user's local timezone. */
export function fmtDateTime(value: number | string | null | undefined): {
  date: string;
  time: string;
  full: string;
} {
  if (value === null || value === undefined || value === "") {
    return { date: "—", time: "", full: "—" };
  }
  const d =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) {
    return { date: "—", time: "", full: "—" };
  }
  const date = d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  const time = d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return { date, time, full: `${date} ${time}` };
}

export function fmtDay(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "—";
  // Accept unix seconds or an ISO date string ("2026-08-21") defensively.
  const d =
    typeof value === "number" ? new Date(value * 1000) : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || Number.isNaN(ms)) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

export function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}
