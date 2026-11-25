// [fork] Stacked RAM bar for the Live page: processes, model files, free.
import { fmtGb } from "../lib/liveChart";
import type { RamBreakdown } from "../lib/ramBreakdown";

const SEGMENTS = [
  {
    key: "processesBytes",
    label: "Processes",
    swatch: "bg-indigo-500",
  },
  {
    key: "modelFilesBytes",
    label: "Model files",
    swatch: "bg-indigo-300",
  },
  { key: "freeBytes", label: "Free", swatch: "bg-gray-200" },
] as const;

export function RamBreakdownBar({ ram }: { ram: RamBreakdown }) {
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between text-xs text-gray-500">
        <span className="font-medium uppercase tracking-wide">RAM</span>
        <span>
          {fmtGb(ram.inUseBytes)} of {fmtGb(ram.totalBytes)} in use
        </span>
      </div>
      <div
        className="flex h-3 w-full overflow-hidden rounded-full bg-gray-200"
        role="img"
        aria-label={SEGMENTS.map((s) => `${s.label} ${fmtGb(ram[s.key])}`).join(
          ", ",
        )}
      >
        {SEGMENTS.filter((s) => s.key !== "freeBytes").map((s) => (
          <div
            key={s.key}
            className={s.swatch}
            style={{ width: `${(ram[s.key] / ram.totalBytes) * 100}%` }}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500">
        {SEGMENTS.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${s.swatch}`} />
            {s.label} {fmtGb(ram[s.key])}
          </span>
        ))}
      </div>
    </div>
  );
}
