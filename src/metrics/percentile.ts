/** Nearest-rank percentile of an ascending-sorted list; 0 for an empty list. */
export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.max(idx, 0)];
}
