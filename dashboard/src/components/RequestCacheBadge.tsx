import { RequestRow } from "../lib/api";
import { fmtTokens, pct } from "../lib/format";
import { Badge, Tooltip } from "./ui";

/** Share of input tokens served from the provider prompt cache. */
export function promptCacheShare(row: RequestRow): number {
  const read = row.tokens_cache_read ?? 0;
  return read / ((row.tokens_input ?? 0) + read);
}

/** How a request used caching: response cache, prompt read, prompt write, or none. */
export function RequestCacheBadge({ row }: { row: RequestRow }) {
  if (row.cache_hit) {
    return (
      <Tooltip content="Served 100% from the proxy response cache without making an upstream LLM API call ($0 cost)">
        <Badge tone="green">
          <span className="font-semibold">⚡ Instant</span>
        </Badge>
      </Tooltip>
    );
  }
  if ((row.tokens_cache_read ?? 0) > 0) {
    return (
      <Tooltip
        content={
          <div className="space-y-1">
            <p className="font-semibold text-sky-300">
              Provider Prompt Cache Hit
            </p>
            <p>
              {fmtTokens(row.tokens_cache_read)} tokens reused from cache (
              {pct(promptCacheShare(row))} of input).
            </p>
            <p className="text-[10px] text-gray-300">
              Billed at a discount vs fresh input tokens.
            </p>
          </div>
        }
      >
        <Badge tone="blue">
          <span>{pct(promptCacheShare(row))} cached</span>
          <span className="font-mono text-[10px] opacity-75">
            ({fmtTokens(row.tokens_cache_read)})
          </span>
        </Badge>
      </Tooltip>
    );
  }
  if ((row.tokens_cache_write ?? 0) > 0) {
    return (
      <Tooltip
        content={
          <div className="space-y-1">
            <p className="font-semibold text-amber-300">
              Prompt Cache Creation
            </p>
            <p>
              {fmtTokens(row.tokens_cache_write)} input tokens written to the
              provider cache for faster future requests.
            </p>
          </div>
        }
      >
        <Badge tone="amber">
          <span>cache write</span>
          <span className="font-mono text-[10px] opacity-75">
            ({fmtTokens(row.tokens_cache_write)})
          </span>
        </Badge>
      </Tooltip>
    );
  }
  return <span className="select-none text-gray-300">—</span>;
}
