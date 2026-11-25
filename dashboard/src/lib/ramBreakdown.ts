// [fork] Live page RAM split. MemAvailable counts mapped model weights as
// reclaimable, so Total - Available alone hides most of what the inference
// server holds. Model files = mapped file pages, capped at what is available.
import type { HostSnapshot } from "./api";

export interface RamBreakdown {
  totalBytes: number;
  /** Total - MemAvailable: process memory the kernel cannot reclaim. */
  processesBytes: number;
  /** Mapped file pages (model weights) counted inside MemAvailable. */
  modelFilesBytes: number;
  freeBytes: number;
  inUseBytes: number;
  inUsePercent: number;
}

/** Null when a figure is missing or the total is not positive. */
export function ramBreakdown(
  host: Pick<
    HostSnapshot,
    "memTotalBytes" | "memAvailableBytes" | "memMappedBytes"
  >,
): RamBreakdown | null {
  const { memTotalBytes: total, memAvailableBytes: available } = host;
  const mapped = host.memMappedBytes;
  if (total == null || available == null || mapped == null || total <= 0) {
    return null;
  }
  const modelFilesBytes = Math.min(mapped, available);
  const processesBytes = total - available;
  const inUseBytes = processesBytes + modelFilesBytes;
  return {
    totalBytes: total,
    processesBytes,
    modelFilesBytes,
    freeBytes: available - modelFilesBytes,
    inUseBytes,
    inUsePercent: (inUseBytes / total) * 100,
  };
}
