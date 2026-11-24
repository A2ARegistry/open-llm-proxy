// [fork] W11: ring gauge for the Live page.
import type { ReactNode } from "react";

const RADIUS = 34;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function toneFor(percent: number): string {
  if (percent >= 90) return "#ef4444";
  if (percent >= 70) return "#f59e0b";
  return "#6366f1";
}

/** A 0–100 % ring with the value in the middle; `percent: null` shows "—". */
export function LiveGauge({
  label,
  percent,
  center,
  hint,
}: {
  label: string;
  percent: number | null;
  center?: ReactNode;
  hint?: ReactNode;
}) {
  const clamped = percent === null ? 0 : Math.min(100, Math.max(0, percent));
  return (
    <div className="flex flex-col items-center gap-1 text-center">
      <svg
        viewBox="0 0 80 80"
        className="h-20 w-20"
        role="img"
        aria-label={`${label}: ${percent === null ? "unavailable" : `${Math.round(clamped)}%`}`}
      >
        <circle
          cx="40"
          cy="40"
          r={RADIUS}
          fill="none"
          strokeWidth="7"
          className="stroke-gray-200"
        />
        {percent !== null && (
          <circle
            cx="40"
            cy="40"
            r={RADIUS}
            fill="none"
            strokeWidth="7"
            strokeLinecap="round"
            stroke={toneFor(clamped)}
            strokeDasharray={`${(clamped / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
            transform="rotate(-90 40 40)"
          />
        )}
        <text
          x="40"
          y="44"
          textAnchor="middle"
          className="fill-gray-900 text-[13px] font-semibold"
        >
          {center ?? (percent === null ? "—" : `${Math.round(clamped)}%`)}
        </text>
      </svg>
      <p className="text-xs font-medium uppercase tracking-wide text-gray-500">
        {label}
      </p>
      {hint && <p className="text-xs text-gray-500">{hint}</p>}
    </div>
  );
}
