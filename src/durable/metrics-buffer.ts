import { DurableObject } from "cloudflare:workers";

export interface BufferedMetric {
  organization_id: string;
  api_key_id: string | null;
  timestamp: number;
  provider: string;
  model: string;
  method: string;
  status_code: number;
  latency_ms: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  cost_usd: number | null;
  error_message: string | null;
  cache_hit: number;
}

interface MetricRow {
  id: string;
  organization_id: string;
  api_key_id: string | null;
  timestamp: number;
  provider: string;
  model: string;
  method: string;
  status_code: number;
  latency_ms: number;
  tokens_input: number | null;
  tokens_output: number | null;
  tokens_cached: number | null;
  cost_usd: number | null;
  error_message: string | null;
  cache_hit: number;
}

const FLUSH_THRESHOLD = 200;
const FLUSH_ALARM_MS = 60_000;

/**
 * Phase 3.1 — per-tenant metrics buffer. Rows are written to DO SQLite storage
 * first (survives DO eviction) and flushed to D1 in batches to keep the hot
 * path cheap. One DO instance per tenant (named by organization id).
 */
export class MetricsBuffer extends DurableObject {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS metrics_buffer (
        id TEXT PRIMARY KEY,
        organization_id TEXT NOT NULL,
        api_key_id TEXT,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        method TEXT NOT NULL,
        status_code INTEGER NOT NULL,
        latency_ms INTEGER NOT NULL,
        tokens_input INTEGER,
        tokens_output INTEGER,
        tokens_cached INTEGER,
        cost_usd REAL,
        error_message TEXT,
        cache_hit INTEGER NOT NULL DEFAULT 0
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/push")) {
      if (request.method !== "POST")
        return new Response("Method Not Allowed", { status: 405 });
      const body = (await request.json()) as { entries: BufferedMetric[] };
      const accepted = await this.push(body.entries ?? []);
      if (this.size() >= FLUSH_THRESHOLD) {
        await this.flush();
      }
      return Response.json({ accepted });
    }
    if (url.pathname.startsWith("/flush")) {
      const flushed = await this.flush();
      return Response.json({ flushed });
    }
    if (url.pathname.startsWith("/size")) {
      return Response.json({ size: this.size() });
    }
    return new Response("Not Found", { status: 404 });
  }

  async push(entries: BufferedMetric[]): Promise<number> {
    if (entries.length === 0) return 0;
    this.ensureTable();
    const sql = this.ctx.storage.sql;
    let accepted = 0;
    for (const e of entries) {
      sql.exec(
        `INSERT OR IGNORE INTO metrics_buffer
          (id, organization_id, api_key_id, timestamp, provider, model, method,
           status_code, latency_ms, tokens_input, tokens_output, tokens_cached,
           cost_usd, error_message, cache_hit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        e.organization_id.concat("_", String(Math.random())),
        e.organization_id,
        e.api_key_id,
        e.timestamp,
        e.provider,
        e.model,
        e.method,
        e.status_code,
        e.latency_ms,
        e.tokens_input,
        e.tokens_output,
        e.tokens_cached,
        e.cost_usd,
        e.error_message,
        e.cache_hit,
      );
      accepted++;
    }
    if (accepted > 0 && (await this.ctx.storage.getAlarm()) === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
    }
    return accepted;
  }

  async flush(): Promise<number> {
    this.ensureTable();
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT id, organization_id, api_key_id, timestamp, provider, model, method,
                status_code, latency_ms, tokens_input, tokens_output, tokens_cached,
                cost_usd, error_message, cache_hit
         FROM metrics_buffer ORDER BY timestamp LIMIT 1000`,
      )
      .toArray() as unknown as Record<string, unknown>[];

    if (rows.length === 0) return 0;

    const batch: D1PreparedStatement[] = [];
    for (const r of rows) {
      batch.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO request_metrics
            (id, organization_id, user_id, api_key_id, timestamp, provider, model, method,
             status_code, latency_ms, tokens_input, tokens_output, tokens_cached,
             cost_usd, error_message, cache_hit)
           VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          (r as unknown as MetricRow).id,
          (r as unknown as MetricRow).organization_id,
          (r as unknown as MetricRow).api_key_id,
          (r as unknown as MetricRow).timestamp,
          (r as unknown as MetricRow).provider,
          (r as unknown as MetricRow).model,
          (r as unknown as MetricRow).method,
          (r as unknown as MetricRow).status_code,
          (r as unknown as MetricRow).latency_ms,
          (r as unknown as MetricRow).tokens_input,
          (r as unknown as MetricRow).tokens_output,
          (r as unknown as MetricRow).tokens_cached,
          (r as unknown as MetricRow).cost_usd,
          (r as unknown as MetricRow).error_message,
          (r as unknown as MetricRow).cache_hit,
        ),
      );
    }
    await this.env.DB.batch(batch);

    const ids = rows.map((r) => (r as unknown as MetricRow).id);
    const sql = this.ctx.storage.sql;
    sql.exec(
      `DELETE FROM metrics_buffer WHERE id IN (${ids.map(() => "?").join(",")})`,
      ...ids,
    );
    return rows.length;
  }

  size(): number {
    try {
      this.ensureTable();
      const cursor = this.ctx.storage.sql.exec(
        "SELECT COUNT(*) AS n FROM metrics_buffer",
      );
      const row = cursor.next().value as { n: number } | undefined;
      return row?.n ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * Periodic flush so rows reach D1 even under sustained low traffic. Re-arms
   * itself as long as data remains.
   */
  async alarm(): Promise<void> {
    const flushed = await this.flush();
    if (flushed > 0 || this.size() > 0) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_ALARM_MS);
    }
  }
}
