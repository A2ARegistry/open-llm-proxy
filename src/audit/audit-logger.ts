import { Env } from "../../worker-configuration.d";
import { newId, nowSeconds, jsonStringify } from "../utils/crypto";

export interface AuditLogEntry {
  organizationId: string | null;
  userId: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  details?: Record<string, unknown>;
}

/** Append an audit log row (tenant-scoped where applicable). */
export async function auditLog(env: Env, entry: AuditLogEntry): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, organization_id, user_id, action, resource_type, resource_id, details, timestamp)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      newId("aud"),
      entry.organizationId,
      entry.userId,
      entry.action,
      entry.resourceType,
      entry.resourceId ?? null,
      entry.details ? jsonStringify(entry.details) : null,
      nowSeconds(),
    )
    .run();
}

export interface AuditLogQuery {
  organizationId: string;
  limit?: number;
  offset?: number;
  action?: string;
  resourceType?: string;
  userId?: string;
}

export async function queryAuditLogs(
  env: Env,
  query: AuditLogQuery,
): Promise<{ logs: unknown[]; total: number }> {
  const where: string[] = ["organization_id = ?"];
  const params: string[] = [query.organizationId];
  if (query.action) {
    where.push("action = ?");
    params.push(query.action);
  }
  if (query.resourceType) {
    where.push("resource_type = ?");
    params.push(query.resourceType);
  }
  if (query.userId) {
    where.push("user_id = ?");
    params.push(query.userId);
  }
  const limit = Math.min(query.limit ?? 50, 200);
  const offset = query.offset ?? 0;

  const { results } = await env.DB.prepare(
    `SELECT id, user_id, action, resource_type, resource_id, details, timestamp
     FROM audit_logs WHERE ${where.join(" AND ")}
     ORDER BY timestamp DESC LIMIT ? OFFSET ?`,
  )
    .bind(...params, String(limit), String(offset))
    .all();
  const { results: countResults } = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM audit_logs WHERE ${where.join(" AND ")}`,
  )
    .bind(...params)
    .all<{ count: number }>();
  return { logs: results, total: Number(countResults[0]?.count ?? 0) };
}
