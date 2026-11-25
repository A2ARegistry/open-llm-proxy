// [fork] W13: energy, electricity cost and cloud comparison from per-period sums.
import type { Period } from "./periods";
import type { PowerSettings } from "./power-settings";

const WS_PER_KWH = 3.6e6;
const HOURS_PER_MONTH = 730;

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

/** One period's raw sums as read from D1. */
export interface PeriodRaw extends Period {
  /** Measured APU energy in watt-seconds. */
  measuredWs: number;
  /** Seconds covered by measurements. */
  measuredS: number;
  peakW: number | null;
  tokens: TokenSums;
  /** The priced requests' tokens at their `model_pricing` rates, in USD. */
  cloudUsd: number;
  /** Requests whose provider/model has no `model_pricing` row. */
  unpricedRequests: number;
}

export interface PowerTotals {
  effectiveS: number;
  measuredS: number;
  /** measuredS / effectiveS; null when there is no power data. */
  coverage: number | null;
  measuredKwh: number;
  estimatedKwh: number;
  overheadKwh: number;
  totalKwh: number;
  /** Measured average APU watts (overhead excluded). */
  avgW: number | null;
  peakW: number | null;
  electricityUsd: number | null;
  tokens: TokenSums;
  /** Null when no request in the range has a `model_pricing` rate. */
  cloudUsd: number | null;
  /** Requests left out of `cloudUsd` because they have no rate. */
  unpricedRequests: number;
  savingsUsd: number | null;
  electricityPer1mOutputUsd: number | null;
  cloudPer1mOutputUsd: number | null;
}

export type PeriodTotals = PowerTotals & Period;

const EMPTY_TOKENS: TokenSums = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  requests: 0,
};

/** Seconds of `p` inside `[dataStart, now)`. */
export function effectiveSeconds(
  p: Period,
  dataStart: number | null,
  now: number,
): number {
  if (dataStart === null) return 0;
  return Math.max(0, Math.min(p.end, now) - Math.max(p.start, dataStart));
}

const per1mOutput = (usd: number | null, output: number) =>
  usd === null || output === 0 ? null : (usd / output) * 1e6;

const addTokens = (a: TokenSums, b: TokenSums): TokenSums => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
  requests: a.requests + b.requests,
});

/** Cloud figure: null when every request is unpriced (no rate to use). */
const cloudOrNull = (cloudUsd: number, tokens: TokenSums, unpriced: number) =>
  unpriced > 0 && unpriced === tokens.requests ? null : cloudUsd;

/** Totals for one set of sums; `fillW` is the watts gaps are estimated at. */
function totalsOf(
  effectiveS: number,
  measuredWs: number,
  measuredS: number,
  peakW: number | null,
  tokens: TokenSums,
  cloud: { usd: number; unpriced: number },
  fillW: number | null,
  s: PowerSettings,
): PowerTotals {
  if (effectiveS === 0) {
    return {
      effectiveS: 0,
      measuredS: 0,
      coverage: null,
      measuredKwh: 0,
      estimatedKwh: 0,
      overheadKwh: 0,
      totalKwh: 0,
      avgW: null,
      peakW: null,
      electricityUsd: null,
      tokens: { ...EMPTY_TOKENS },
      cloudUsd: null,
      unpricedRequests: 0,
      savingsUsd: null,
      electricityPer1mOutputUsd: null,
      cloudPer1mOutputUsd: null,
    };
  }
  const measuredKwh = measuredWs / WS_PER_KWH;
  const gapS = Math.max(effectiveS - measuredS, 0);
  const estimatedKwh = fillW === null ? 0 : (fillW * gapS) / WS_PER_KWH;
  const overheadKwh = ((s.overheadW ?? 0) * effectiveS) / WS_PER_KWH;
  const totalKwh = measuredKwh + estimatedKwh + overheadKwh;
  const electricityUsd =
    s.pricePerKwhUsd === undefined ? null : totalKwh * s.pricePerKwhUsd;
  const cloudUsd = cloudOrNull(cloud.usd, tokens, cloud.unpriced);
  return {
    effectiveS,
    measuredS,
    coverage: measuredS / effectiveS,
    measuredKwh,
    estimatedKwh,
    overheadKwh,
    totalKwh,
    avgW: measuredS > 0 ? measuredWs / measuredS : null,
    peakW,
    electricityUsd,
    tokens,
    cloudUsd,
    unpricedRequests: cloud.unpriced,
    savingsUsd:
      cloudUsd === null || electricityUsd === null
        ? null
        : cloudUsd - electricityUsd,
    electricityPer1mOutputUsd: per1mOutput(electricityUsd, tokens.output),
    cloudPer1mOutputUsd: per1mOutput(cloudUsd, tokens.output),
  };
}

const maxOrNull = (a: number | null, b: number | null) =>
  a === null ? b : b === null ? a : Math.max(a, b);

/**
 * Per-period and overall totals. Gaps in every period are estimated at the
 * measured average over all periods, so the periods add up to the totals.
 */
export function summarize(
  periods: PeriodRaw[],
  dataStart: number | null,
  now: number,
  s: PowerSettings,
): { totals: PowerTotals; periods: PeriodTotals[] } {
  const live = periods.map((p) => ({
    ...p,
    effectiveS: effectiveSeconds(p, dataStart, now),
  }));
  let measuredWs = 0;
  let measuredS = 0;
  let effectiveS = 0;
  let peakW: number | null = null;
  let tokens = { ...EMPTY_TOKENS };
  const cloud = { usd: 0, unpriced: 0 };
  for (const p of live) {
    if (p.effectiveS === 0) continue;
    measuredWs += p.measuredWs;
    measuredS += p.measuredS;
    effectiveS += p.effectiveS;
    peakW = maxOrNull(peakW, p.peakW);
    tokens = addTokens(tokens, p.tokens);
    cloud.usd += p.cloudUsd;
    cloud.unpriced += p.unpricedRequests;
  }
  const fillW = measuredS > 0 ? measuredWs / measuredS : null;
  return {
    totals: totalsOf(
      effectiveS,
      measuredWs,
      measuredS,
      peakW,
      tokens,
      cloud,
      fillW,
      s,
    ),
    periods: live.map((p) => ({
      start: p.start,
      end: p.end,
      ...totalsOf(
        p.effectiveS,
        p.measuredWs,
        p.measuredS,
        p.peakW,
        p.tokens,
        { usd: p.cloudUsd, unpriced: p.unpricedRequests },
        fillW,
        s,
      ),
    })),
  };
}

/** Electricity so far plus the rest of the range at the current average draw. */
export function projectUsd(
  totals: PowerTotals,
  remainingS: number,
  s: PowerSettings,
): number | null {
  const price = s.pricePerKwhUsd;
  if (price === undefined) return null;
  if (totals.electricityUsd === null || totals.avgW === null) return null;
  const watts = totals.avgW + (s.overheadW ?? 0);
  return totals.electricityUsd + ((watts * remainingS) / WS_PER_KWH) * price;
}

/** Typical idle draw (p10 APU watts plus overhead) and its monthly cost. */
export function idleFloor(
  p10W: number | null,
  s: PowerSettings,
): { watts: number; monthlyUsd: number | null } | null {
  if (p10W === null) return null;
  const watts = p10W + (s.overheadW ?? 0);
  return {
    watts,
    monthlyUsd:
      s.pricePerKwhUsd === undefined
        ? null
        : ((watts * HOURS_PER_MONTH) / 1000) * s.pricePerKwhUsd,
  };
}
