import { DurableObject } from "cloudflare:workers";

/**
 * Phase 4.2 — response-value cache (placeholder). Sharded per tenant; the
 * chat handler may opt a key in when full streaming-caching lands. Stored
 * values survive eviction via DO SQLite storage.
 */
export class ResponseCache extends DurableObject {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS cache (
        ckey TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/get")) {
      const ckey = url.searchParams.get("key");
      if (!ckey) return new Response("Bad Request", { status: 400 });
      const value = this.get(ckey);
      if (value === undefined)
        return new Response("Not Found", { status: 404 });
      return Response.json({ value });
    }
    if (url.pathname.startsWith("/put") && request.method === "POST") {
      const body = (await request.json()) as {
        key: string;
        value: string;
        ttlSeconds?: number;
      };
      this.put(body.key, body.value, body.ttlSeconds ?? 300);
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/delete")) {
      const ckey = url.searchParams.get("key");
      if (ckey) this.delete(ckey);
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  }

  get(ckey: string): string | undefined {
    this.ensureTable();
    const now = Date.now();
    const cursor = this.ctx.storage.sql.exec(
      "SELECT value, expires_at FROM cache WHERE ckey = ?",
      ckey,
    );
    const row = cursor.next().value as
      { value: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (row.expires_at <= now) {
      this.ctx.storage.sql.exec("DELETE FROM cache WHERE ckey = ?", ckey);
      return undefined;
    }
    return row.value;
  }

  put(ckey: string, value: string, ttlSeconds: number): void {
    this.ensureTable();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO cache (ckey, value, expires_at, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(ckey) DO UPDATE SET
         value = excluded.value,
         expires_at = excluded.expires_at`,
      ckey,
      value,
      now + ttlSeconds * 1000,
      now,
    );
  }

  delete(ckey: string): void {
    this.ensureTable();
    this.ctx.storage.sql.exec("DELETE FROM cache WHERE ckey = ?", ckey);
  }
}
