// [fork] W12: samples the self-hosted box every 10 s and flushes to D1 every
// minute. Samples are buffered in DO SQLite (survives eviction); a failed
// flush keeps them for the next tick, capped at BUFFER_CAP rows per kind.
import { nextAlarmAt, nextBoundary } from "../live/alarm-schedule";
import {
  toHostRow,
  toInferenceRow,
  type HostSampleRow,
  type InferenceSampleRow,
} from "../live/sample-row";
import { writeSamples } from "../live/sample-store";
import {
  toHost,
  toInference,
  type HostSnapshot,
  type InferenceSnapshot,
} from "../live/snapshot";
import {
  fetchLiveText,
  samplerBindings,
  type LiveBinding,
} from "../live/sources";
import { initLogger, log } from "../utils/logger";
import { DurableObject } from "cloudflare:workers";

export const BOX_SAMPLER_NAME = "box";
export const FLUSH_EVERY_TICKS = 6;
export const BUFFER_CAP = 360;

type Kind = "inference" | "host";

export class BoxSampler extends DurableObject<Env> {
  private schemaReady = false;

  private ensureTable(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS pending (kind TEXT NOT NULL, ts INTEGER NOT NULL, row TEXT NOT NULL)",
    );
    this.schemaReady = true;
  }

  /** Start the sampling loop if it is not running. Cheap; called from the cron. */
  async ensureRunning(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) !== null) return;
    await this.schedule(nextBoundary(Date.now()));
  }

  private async schedule(at: number): Promise<void> {
    await this.ctx.storage.put("due", at);
    await this.ctx.storage.setAlarm(at);
  }

  async alarm(): Promise<void> {
    initLogger(this.env);
    const due =
      (await this.ctx.storage.get<number>("due")) ??
      nextBoundary(Date.now()) - 10_000;
    try {
      // A late alarm must not stamp rows with a stale slot.
      const slot = Math.max(due, Math.floor(Date.now() / 10_000) * 10_000);
      await this.tick(Math.floor(slot / 1000));
    } catch (error) {
      log.error("box sampler tick failed", error);
    } finally {
      await this.schedule(nextAlarmAt(due, Date.now()));
    }
  }

  private async tick(ts: number): Promise<void> {
    this.ensureTable();
    const { inference, host } = samplerBindings(this.env);
    const [inferenceRows, hostRows] = await Promise.all([
      Promise.all(inference.map((b) => this.sampleInference(b, ts))),
      Promise.all(host.map((b) => this.sampleHost(b, ts))),
    ]);
    this.buffer("inference", inferenceRows);
    this.buffer("host", hostRows);

    const ticks = ((await this.ctx.storage.get<number>("ticks")) ?? 0) + 1;
    await this.ctx.storage.put("ticks", ticks);
    if (ticks >= FLUSH_EVERY_TICKS) {
      // Reset either way: a failing D1 is retried at the flush cadence, not every tick.
      try {
        await this.flush();
      } finally {
        await this.ctx.storage.put("ticks", 0);
      }
    }
  }

  private async sampleInference(
    binding: LiveBinding,
    ts: number,
  ): Promise<InferenceSampleRow> {
    const [health, metrics] = await Promise.all([
      fetchLiveText(binding.fetcher, "/health"),
      fetchLiveText(binding.fetcher, "/metrics"),
    ]);
    const next = toInference(binding.name, health, metrics, Date.now());
    const key = `prev:inference:${binding.name}`;
    const prev = await this.ctx.storage.get<InferenceSnapshot>(key);
    await this.remember(key, next);
    return toInferenceRow(binding.name, ts, prev ?? null, next);
  }

  private async sampleHost(
    binding: LiveBinding,
    ts: number,
  ): Promise<HostSampleRow> {
    const metrics = await fetchLiveText(binding.fetcher, "/metrics");
    const next = toHost(binding.name, metrics, Date.now());
    const key = `prev:host:${binding.name}`;
    const prev = await this.ctx.storage.get<HostSnapshot>(key);
    await this.remember(key, next);
    return toHostRow(binding.name, ts, prev ?? null, next);
  }

  /** Keep the snapshot for the next rate; forget it when the source was down. */
  private async remember(key: string, snapshot: object | null): Promise<void> {
    if (snapshot) await this.ctx.storage.put(key, snapshot);
    else await this.ctx.storage.delete(key);
  }

  private buffer(kind: Kind, rows: Array<{ ts: number }>): void {
    const sql = this.ctx.storage.sql;
    for (const row of rows) {
      sql.exec(
        "INSERT INTO pending (kind, ts, row) VALUES (?, ?, ?)",
        kind,
        row.ts,
        JSON.stringify(row),
      );
    }
    sql.exec(
      `DELETE FROM pending WHERE kind = ? AND rowid NOT IN (
         SELECT rowid FROM pending WHERE kind = ? ORDER BY rowid DESC LIMIT ?)`,
      kind,
      kind,
      BUFFER_CAP,
    );
  }

  private readBuffer<T>(kind: Kind): T[] {
    return this.ctx.storage.sql
      .exec("SELECT row FROM pending WHERE kind = ? ORDER BY rowid", kind)
      .toArray()
      .map((r) => JSON.parse(r.row as string) as T);
  }

  /** One D1 batch for everything buffered; the buffer is cleared only on success. */
  private async flush(): Promise<void> {
    const inference = this.readBuffer<InferenceSampleRow>("inference");
    const host = this.readBuffer<HostSampleRow>("host");
    await writeSamples(this.env, inference, host);
    this.ctx.storage.sql.exec("DELETE FROM pending");
  }
}
