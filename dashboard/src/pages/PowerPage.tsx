// [fork] W13: what the box costs in electricity, and how that compares with
// paying a cloud API for the same tokens.
import { PowerDailyChart } from "../components/PowerDailyChart";
import { PowerWattsChart } from "../components/PowerWattsChart";
import {
  Button,
  Card,
  EmptyState,
  Input,
  Select,
  Spinner,
  StatCard,
} from "../components/ui";
import { apiGet, liveHistory } from "../lib/api";
import { fmtDay, fmtTokens, fmtUsd, fmtUsdPrecise, pct } from "../lib/format";
import { historyPoints } from "../lib/liveHistory";
import {
  POWER_PRESETS,
  customRange,
  powerRange,
  type PowerPreset,
} from "../lib/powerRange";
import type {
  PeriodTotals,
  PowerMonths,
  PowerReport,
  PowerSettings,
} from "../lib/powerTypes";
import { useQuery } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
const CUSTOM = "custom";

const fmtKwh = (v: number) =>
  `${v.toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 1 })} kWh`;
const fmtW = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)} W`);

function SettingsHint({ what }: { what: string }) {
  return (
    <p className="text-sm text-gray-500">
      Set {what} in{" "}
      <Link to="/settings" className="text-indigo-600 hover:underline">
        Settings
      </Link>
      .
    </p>
  );
}

function CloudCard({
  totals,
  settings,
}: {
  totals: PowerReport["totals"];
  settings: PowerSettings;
}) {
  const ref = settings.cloudReference;
  if (!ref) {
    return (
      <Card title="Box vs cloud">
        <SettingsHint what="a cloud reference price" />
      </Card>
    );
  }
  const saving = totals.savingsUsd;
  return (
    <Card
      title="Box vs cloud"
      subtitle={`Same tokens at ${ref.label || "the cloud reference price"}: $${ref.inputPer1m} in / $${ref.outputPer1m} out / $${ref.cacheReadPer1m} cache read / $${ref.cacheWritePer1m} cache write per 1M.`}
    >
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard
          label="Tokens"
          value={fmtTokens(totals.tokens.input + totals.tokens.output)}
          hint={`${fmtTokens(totals.tokens.input)} in · ${fmtTokens(totals.tokens.output)} out · ${totals.tokens.requests} requests`}
        />
        <StatCard label="Cloud would cost" value={fmtUsd(totals.cloudUsd)} />
        <StatCard
          label="Electricity"
          value={
            totals.electricityUsd === null ? "—" : fmtUsd(totals.electricityUsd)
          }
        />
        <StatCard
          label={saving !== null && saving < 0 ? "Box costs more" : "Saved"}
          value={saving === null ? "—" : fmtUsd(Math.abs(saving))}
          tone={saving === null ? "default" : saving >= 0 ? "green" : "red"}
        />
      </div>
      <p className="mt-4 text-sm text-gray-600">
        Per 1M output tokens: box{" "}
        <strong>{fmtUsdPrecise(totals.electricityPer1mOutputUsd)}</strong> vs
        cloud <strong>{fmtUsdPrecise(totals.cloudPer1mOutputUsd)}</strong>.
        Electricity includes idle time, so a quiet period can cost more per
        token.
      </p>
      {totals.electricityUsd === null && (
        <div className="mt-2">
          <SettingsHint what="a price per kWh" />
        </div>
      )}
    </Card>
  );
}

function MonthsTable({ months }: { months: PeriodTotals[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
            <th className="py-2 pr-4">Month</th>
            <th className="py-2 pr-4 text-right">Energy</th>
            <th className="py-2 pr-4 text-right">Electricity</th>
            <th className="py-2 pr-4 text-right">Cloud equivalent</th>
            <th className="py-2 pr-4 text-right">Saved</th>
            <th className="py-2 text-right">Output tokens</th>
          </tr>
        </thead>
        <tbody>
          {[...months].reverse().map((m) => (
            <tr key={m.start} className="border-t border-gray-100">
              <td className="py-2 pr-4 text-gray-900">
                {new Date(m.start * 1000).toLocaleDateString([], {
                  month: "long",
                  year: "numeric",
                })}
              </td>
              {m.effectiveS === 0 ? (
                <td colSpan={5} className="py-2 text-right text-gray-400">
                  no power data
                </td>
              ) : (
                <>
                  <td className="py-2 pr-4 text-right">{fmtKwh(m.totalKwh)}</td>
                  <td className="py-2 pr-4 text-right">
                    {fmtUsd(m.electricityUsd)}
                  </td>
                  <td className="py-2 pr-4 text-right">{fmtUsd(m.cloudUsd)}</td>
                  <td className="py-2 pr-4 text-right">
                    {fmtUsd(m.savingsUsd)}
                  </td>
                  <td className="py-2 text-right">
                    {fmtTokens(m.tokens.output)}
                  </td>
                </>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PowerPage() {
  const [preset, setPreset] = useState<PowerPreset | typeof CUSTOM>(
    "this-month",
  );
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [nowMs, setNowMs] = useState(() => Date.now());

  const range = useMemo(
    () =>
      preset === CUSTOM
        ? customRange(customFrom, customTo)
        : powerRange(preset, nowMs),
    [preset, customFrom, customTo, nowMs],
  );

  const report = useQuery({
    queryKey: ["power", range?.from, range?.to, TZ],
    queryFn: () =>
      apiGet<PowerReport>(
        `/api/power?from=${range!.from}&to=${range!.to}&tz=${encodeURIComponent(TZ)}`,
      ),
    enabled: range !== null,
  });
  // The watts chart covers only time with power data: from the first sample
  // (once the report says when that is) up to now.
  const dataStart = report.data?.dataStart ?? null;
  const chartFrom =
    range && dataStart !== null ? Math.max(range.from, dataStart) : 0;
  const chartTo = range ? Math.min(range.to, Math.floor(nowMs / 1000)) : 0;
  const watts = useQuery({
    queryKey: ["power-watts", chartFrom, chartTo],
    queryFn: () => liveHistory(chartFrom, chartTo),
    enabled: dataStart !== null && chartTo > chartFrom,
  });
  const months = useQuery({
    queryKey: ["power-months", TZ, nowMs],
    queryFn: () =>
      apiGet<PowerMonths>(
        `/api/power/months?count=12&tz=${encodeURIComponent(TZ)}`,
      ),
  });
  const wattPoints = useMemo(
    () => (watts.data ? historyPoints(watts.data) : []),
    [watts.data],
  );

  const r = report.data;
  const t = r?.totals;
  const clipped = r && r.dataStart !== null && r.dataStart > r.from;
  const hasPrice = r?.settings.pricePerKwhUsd !== undefined;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900">Power</h1>
          <p className="text-sm text-gray-500">
            Electricity the box uses and what it costs, against paying a cloud
            API for the same tokens.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Select
            className="w-40"
            value={preset}
            onChange={(v) => setPreset(v as PowerPreset | typeof CUSTOM)}
            options={[...POWER_PRESETS, { value: CUSTOM, label: "Custom" }]}
          />
          {preset === CUSTOM && (
            <>
              <Input
                type="date"
                value={customFrom}
                onChange={(e) => setCustomFrom(e.target.value)}
                aria-label="From"
              />
              <Input
                type="date"
                value={customTo}
                onChange={(e) => setCustomTo(e.target.value)}
                aria-label="To"
              />
            </>
          )}
          <Button
            variant="secondary"
            onClick={() => setNowMs(Date.now())}
            loading={report.isFetching}
            aria-label="Refresh"
          >
            <RefreshCw size={14} />
          </Button>
        </div>
      </div>

      {range === null ? (
        <EmptyState title="Pick a start and end date" />
      ) : report.isLoading ? (
        <Spinner />
      ) : report.error || !r || !t ? (
        <EmptyState
          title="Could not load power data"
          description={report.error?.message ?? "Unknown error"}
        />
      ) : r.dataStart === null || t.effectiveS === 0 ? (
        <EmptyState
          title="No power data in this range"
          description={
            r.dataStart === null
              ? "The box has no stored power samples yet."
              : `Power data starts ${fmtDay(r.dataStart)}.`
          }
        />
      ) : (
        <>
          {clipped && (
            <p className="text-sm text-gray-500">
              Power data since {fmtDay(r.dataStart!)}; earlier time in this
              range is not counted.
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              label="Electricity"
              value={hasPrice ? fmtUsd(t.electricityUsd) : "—"}
              hint={
                !hasPrice ? (
                  <SettingsHint what="a price per kWh" />
                ) : r.projectionUsd !== null ? (
                  `≈ ${fmtUsd(r.projectionUsd)} by the end of the range`
                ) : undefined
              }
            />
            <StatCard
              label="Energy"
              value={fmtKwh(t.totalKwh)}
              hint={`${fmtKwh(t.measuredKwh)} measured · ${fmtKwh(t.estimatedKwh)} estimated · ${fmtKwh(t.overheadKwh)} overhead`}
            />
            <StatCard
              label="APU power"
              value={fmtW(t.avgW)}
              hint={`average · peak ${fmtW(t.peakW)}`}
            />
            <StatCard
              label="Coverage"
              value={t.coverage === null ? "—" : pct(t.coverage)}
              hint={
                t.coverage !== null && t.coverage < 1
                  ? "Gaps estimated at the range's average draw"
                  : "Every interval measured"
              }
            />
          </div>

          {r.idleFloor && (
            <p className="text-sm text-gray-600">
              Idle floor: <strong>{fmtW(r.idleFloor.watts)}</strong>
              {r.idleFloor.monthlyUsd !== null && (
                <>
                  {" "}
                  ≈ <strong>{fmtUsd(r.idleFloor.monthlyUsd)}</strong> / month
                  just to keep the box on
                </>
              )}{" "}
              (typical idle draw over the last 30 days, overhead included).
            </p>
          )}

          <CloudCard totals={t} settings={r.settings} />

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <Card title="APU power" subtitle="Measured at the APU package.">
              {watts.isLoading ? (
                <Spinner />
              ) : (
                <PowerWattsChart
                  data={wattPoints}
                  domain={[chartFrom * 1000, chartTo * 1000]}
                  avgW={t.avgW}
                />
              )}
            </Card>
            <Card title="Cost per day">
              {hasPrice ? (
                <PowerDailyChart
                  days={r.days}
                  showCloud={r.settings.cloudReference !== undefined}
                />
              ) : (
                <SettingsHint what="a price per kWh" />
              )}
            </Card>
          </div>
        </>
      )}

      <Card title="By month" subtitle="Calendar months in your time zone.">
        {months.isLoading ? (
          <Spinner />
        ) : months.data ? (
          <MonthsTable months={months.data.months} />
        ) : (
          <EmptyState
            title="Could not load months"
            description={months.error?.message ?? "Unknown error"}
          />
        )}
      </Card>
    </div>
  );
}
