import { percentile } from "./percentile";

/** Streaming speed for one provider + model (GET /api/metrics/speed). */
export interface SpeedStat {
  provider: string;
  model: string;
  /** Successful streamed requests with a measured first output. */
  requests: number;
  ttftP50: number;
  ttftP95: number;
  /** Output tokens/s after the first token. Null when no stream completed with >1 token. */
  decodeTpsP50: number | null;
  decodeTpsP95: number | null;
  /** Uncached input tokens / TTFT. Includes queue and network time. */
  prefillTpsP50: number | null;
}

interface SpeedRow {
  provider: string;
  model: string;
  tokens_input: number | null;
  tokens_output: number | null;
  ttft_ms: number;
  decode_ms: number | null;
}

/** Output tokens/s after the first token, or null when it can't be measured. */
export function decodeTokensPerSecond(
  tokensOutput: number | null,
  decodeMs: number | null,
): number | null {
  if (tokensOutput === null || tokensOutput < 2) return null;
  if (decodeMs === null || decodeMs <= 0) return null;
  return ((tokensOutput - 1) * 1000) / decodeMs;
}

/** Uncached input tokens/s over the time to first output, or null. */
export function prefillTokensPerSecond(
  tokensInput: number | null,
  ttftMs: number,
): number | null {
  if (tokensInput === null || tokensInput <= 0 || ttftMs <= 0) return null;
  return (tokensInput * 1000) / ttftMs;
}

function sortedAsc(values: number[]): number[] {
  return values.sort((a, b) => a - b);
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Streaming speed per provider + model over [start, end): TTFT percentiles and
 * decode/prefill tokens per second. Only successful streams with a measured
 * first output count; one query, percentiles computed here.
 */
export async function speedByModel(
  env: Env,
  organizationId: string,
  start: number,
  end: number,
): Promise<SpeedStat[]> {
  const { results } = await env.DB.prepare(
    `SELECT provider, model, tokens_input, tokens_output, ttft_ms, decode_ms
     FROM request_metrics
     WHERE organization_id = ? AND timestamp >= ? AND timestamp < ?
       AND status_code < 400 AND ttft_ms IS NOT NULL
     ORDER BY provider, model`,
  )
    .bind(organizationId, start, end)
    .all<SpeedRow>();

  const groups = new Map<string, SpeedRow[]>();
  for (const row of results) {
    const key = `${row.provider}\u0000${row.model}`;
    const list = groups.get(key) ?? [];
    list.push(row);
    groups.set(key, list);
  }

  return Array.from(groups.values()).map((rows) => {
    const ttft = sortedAsc(rows.map((r) => r.ttft_ms));
    const decode = sortedAsc(
      rows
        .map((r) => decodeTokensPerSecond(r.tokens_output, r.decode_ms))
        .filter((v): v is number => v !== null),
    );
    const prefill = sortedAsc(
      rows
        .map((r) => prefillTokensPerSecond(r.tokens_input, r.ttft_ms))
        .filter((v): v is number => v !== null),
    );
    return {
      provider: rows[0].provider,
      model: rows[0].model,
      requests: rows.length,
      ttftP50: percentile(ttft, 0.5),
      ttftP95: percentile(ttft, 0.95),
      decodeTpsP50: decode.length ? rounded(percentile(decode, 0.5)) : null,
      decodeTpsP95: decode.length ? rounded(percentile(decode, 0.95)) : null,
      prefillTpsP50: prefill.length ? rounded(percentile(prefill, 0.5)) : null,
    };
  });
}
