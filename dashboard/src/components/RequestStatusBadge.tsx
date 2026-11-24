import { Badge } from "./ui";

/** HTTP status as a badge; errors show their message on hover. */
export function RequestStatusBadge({
  status,
  error,
}: {
  status: number;
  error?: string | null;
}) {
  if (status < 400) return <Badge tone="green">{status}</Badge>;
  return (
    <Badge tone="red" title={error ?? undefined}>
      {status}
    </Badge>
  );
}
