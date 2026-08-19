import { DurableObject } from "cloudflare:workers";

/** Phase 4.3 — placeholder session factory for the Codex-WebSocket hot path. */
export class SessionManager extends DurableObject {
  private ensureTable(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS sessions (
        skey TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/get")) {
      const skey = url.searchParams.get("key");
      if (!skey) return new Response("Bad Request", { status: 400 });
      const cursor = this.ensureCursor(
        "SELECT value, expires_at FROM sessions WHERE skey = ?",
        skey,
      );
      const row = cursor.next().value as
        { value: string; expires_at: number } | undefined;
      if (!row || row.expires_at <= Date.now()) {
        if (row)
          this.ctx.storage.sql.exec(
            "DELETE FROM sessions WHERE skey = ?",
            skey,
          );
        return new Response("Not Found", { status: 404 });
      }
      return Response.json({ value: row.value });
    }
    if (url.pathname.startsWith("/put") && request.method === "POST") {
      const body = (await request.json()) as {
        key: string;
        value: string;
        ttlSeconds?: number;
      };
      this.ensureTable();
      const now = Date.now();
      this.ctx.storage.sql.exec(
        `INSERT INTO sessions (skey, value, expires_at, created_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(skey) DO UPDATE SET
           value = excluded.value,
           expires_at = excluded.expires_at`,
        body.key,
        body.value,
        now + (body.ttlSeconds ?? 3600) * 1000,
        now,
      );
      return Response.json({ ok: true });
    }
    if (url.pathname.startsWith("/reap")) {
      this.ensureTable();
      this.ctx.storage.sql.exec(
        "DELETE FROM sessions WHERE expires_at <= ?",
        Date.now(),
      );
      return Response.json({ ok: true });
    }
    return new Response("Not Found", { status: 404 });
  }

  private ensureCursor(sql: string, ...params: unknown[]) {
    this.ensureTable();
    return this.ctx.storage.sql.exec(sql, ...params);
  }
}
