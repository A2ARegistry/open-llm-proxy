import { DurableObject } from "cloudflare:workers";

interface BucketRow {
  key: string;
  tokens: number;
  capacity: number;
  refill_per_minute: number;
  last_refill: number;
}

/**
 * Phase 4.1 — per-tenant token-bucket rate limiter. One DO shard per tenant
 * (named by `tenant:<shard>`), keyed on the API key / actor. The bucket state
 * lives in DO SQLite storage so it survives eviction and restarts.
 */
export class RateLimiter extends DurableObject {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS buckets (
        key TEXT PRIMARY KEY,
        tokens REAL NOT NULL,
        capacity REAL NOT NULL,
        refill_per_minute REAL NOT NULL,
        last_refill INTEGER NOT NULL
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/check")) {
      if (request.method !== "POST")
        return new Response("Method Not Allowed", { status: 405 });
      return this.handleCheck(await request.json());
    }
    return new Response("Not Found", { status: 404 });
  }

  private handleCheck(input: {
    key: string;
    capacity: number;
    refillPerMinute: number;
    cost?: number;
    peek?: boolean;
    force?: boolean;
  }): Response {
    const {
      key,
      capacity,
      refillPerMinute,
      peek = false,
      force = false,
    } = input;
    const cost = input.cost ?? 1;
    const now = Date.now();
    this.ensureTable();
    const sql = this.ctx.storage.sql;

    const cursor = sql.exec("SELECT * FROM buckets WHERE key = ?", key);
    const row = cursor.next().value as BucketRow | undefined;

    let tokens: number;
    if (row) {
      const elapsed = (now - row.last_refill) / 60_000;
      tokens = Math.min(
        row.capacity,
        row.tokens + elapsed * row.refill_per_minute,
      );
    } else {
      tokens = capacity;
    }

    if (tokens - cost < 0 && !force) {
      const retryAfterSeconds = Math.max(1, Math.ceil(60 / refillPerMinute));
      return Response.json(
        { allowed: false, remaining: tokens, retryAfterSeconds },
        { status: 429 },
      );
    }

    if (!peek) {
      const nextTokens = tokens - cost;
      sql.exec(
        `INSERT INTO buckets (key, tokens, capacity, refill_per_minute, last_refill)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           tokens = excluded.tokens,
           capacity = excluded.capacity,
           refill_per_minute = excluded.refill_per_minute,
           last_refill = excluded.last_refill`,
        key,
        nextTokens,
        capacity,
        refillPerMinute,
        now,
      );
      return Response.json({ allowed: true, remaining: nextTokens });
    }

    return Response.json({ allowed: true, remaining: tokens - cost });
  }
}
