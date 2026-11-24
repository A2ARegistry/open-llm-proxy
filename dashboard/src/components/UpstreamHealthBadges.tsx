// [fork] W7: health badges for VPC upstreams (the self-hosted box).
import { apiGet } from "../lib/api";
import { Badge } from "./ui";
import { useQuery } from "@tanstack/react-query";

interface UpstreamHealth {
  binding: string;
  status: "ok" | "down" | "unknown";
  version: string | null;
  checkedAt: number | null;
  latencyMs: number | null;
}

/** A check older than this means the cron stopped reporting. */
const STALE_AFTER_SECONDS = 15 * 60;

function describe(u: UpstreamHealth): {
  tone: "green" | "red" | "amber" | "gray";
  label: string;
} {
  if (u.status === "unknown" || u.checkedAt === null) {
    return { tone: "gray", label: "not checked yet" };
  }
  if (Date.now() / 1000 - u.checkedAt > STALE_AFTER_SECONDS) {
    return { tone: "amber", label: "stale" };
  }
  return u.status === "ok"
    ? { tone: "green", label: "up" }
    : { tone: "red", label: "down" };
}

/** One badge per VPC upstream the organization may use; nothing when none. */
export function UpstreamHealthBadges() {
  const health = useQuery({
    queryKey: ["upstream-health"],
    queryFn: () =>
      apiGet<{ upstreams: UpstreamHealth[] }>("/api/health/upstreams"),
    refetchInterval: 60_000,
  });
  const upstreams = health.data?.upstreams ?? [];
  if (upstreams.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {upstreams.map((u) => {
        const { tone, label } = describe(u);
        const title = [
          u.version ? `version ${u.version}` : null,
          u.latencyMs !== null ? `${u.latencyMs} ms` : null,
          u.checkedAt
            ? `checked ${new Date(u.checkedAt * 1000).toLocaleTimeString()}`
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
        return (
          <Badge key={u.binding} tone={tone} title={title || undefined}>
            {u.binding}: {label}
          </Badge>
        );
      })}
    </div>
  );
}
