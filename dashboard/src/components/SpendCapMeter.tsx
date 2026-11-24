import { fmtUsd, fmtUsdPrecise } from "../lib/format";

/** Lifetime spend against a key's spend cap, amber from 80%, red at 100%. */
export function SpendCapMeter({
  spentUsd,
  capUsd,
}: {
  spentUsd: number;
  capUsd: number | undefined;
}) {
  if (!capUsd) {
    return (
      <div>
        <p className="text-2xl font-semibold text-gray-900">
          {fmtUsdPrecise(spentUsd)}
        </p>
        <p className="mt-1 text-xs text-gray-500">
          spent all-time · no spend cap
        </p>
      </div>
    );
  }
  const ratio = spentUsd / capUsd;
  const bar =
    ratio >= 1 ? "bg-red-500" : ratio >= 0.8 ? "bg-amber-500" : "bg-indigo-500";
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <p className="text-2xl font-semibold text-gray-900">
          {fmtUsdPrecise(spentUsd)}
          <span className="text-sm font-normal text-gray-500">
            {" "}
            / {fmtUsd(capUsd)}
          </span>
        </p>
        <span
          className={`text-sm font-medium ${ratio >= 1 ? "text-red-600" : "text-gray-600"}`}
        >
          {(ratio * 100).toFixed(1)}%
        </span>
      </div>
      <div
        className="mt-2 h-2 overflow-hidden rounded-full bg-gray-100"
        role="meter"
        aria-valuemin={0}
        aria-valuemax={capUsd}
        aria-valuenow={spentUsd}
        aria-label="Spend against cap"
      >
        <div
          className={`h-full ${bar}`}
          style={{ width: `${Math.min(ratio, 1) * 100}%` }}
        />
      </div>
      <p className="mt-1 text-xs text-gray-500">
        {ratio >= 1
          ? "Cap reached: this key is blocked until the cap is raised."
          : "All-time spend. The key is blocked once it reaches the cap."}
      </p>
    </div>
  );
}
