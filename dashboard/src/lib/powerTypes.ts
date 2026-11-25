// [fork] W13: shapes of the /api/power responses (mirror of src/power/*).

/** A model_pricing row the box's tokens are priced from (USD per 1M). */
export interface CloudRate {
  provider: string;
  model: string;
  inputPer1m: number;
  outputPer1m: number;
  cacheReadPer1m: number;
  cacheWritePer1m: number;
}

export interface PowerSettings {
  pricePerKwhUsd?: number;
  overheadW?: number;
}

/** A settings update: `null` clears a field. */
export type PowerSettingsPatch = {
  [K in keyof PowerSettings]?: PowerSettings[K] | null;
};

export interface TokenSums {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  requests: number;
}

export interface PowerTotals {
  effectiveS: number;
  measuredS: number;
  coverage: number | null;
  measuredKwh: number;
  estimatedKwh: number;
  overheadKwh: number;
  totalKwh: number;
  avgW: number | null;
  peakW: number | null;
  electricityUsd: number | null;
  tokens: TokenSums;
  cloudUsd: number | null;
  unpricedRequests: number;
  savingsUsd: number | null;
  electricityPer1mOutputUsd: number | null;
  cloudPer1mOutputUsd: number | null;
}

export type PeriodTotals = PowerTotals & { start: number; end: number };

export interface PowerReport {
  from: number;
  to: number;
  tz: string;
  dataStart: number | null;
  settings: PowerSettings;
  cloudRates: CloudRate[];
  totals: PowerTotals;
  days: PeriodTotals[];
  projectionUsd: number | null;
  idleFloor: { watts: number; monthlyUsd: number | null } | null;
}

export interface PowerMonths {
  tz: string;
  dataStart: number | null;
  settings: PowerSettings;
  cloudRates: CloudRate[];
  months: PeriodTotals[];
}
