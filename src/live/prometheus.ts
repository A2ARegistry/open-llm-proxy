// [fork] W11: minimal Prometheus text-format parser for the live monitor.
// Reads the exposition format served by llama.cpp-style servers and
// node_exporter. Comments, timestamps and non-finite values are dropped.

export interface PromSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

const LINE_RE = /^([a-zA-Z_:][\w:]*)(\{.*\})?\s+(\S+)(?:\s+\S+)?$/;
const LABEL_RE = /([a-zA-Z_]\w*)="((?:[^"\\]|\\.)*)"/g;

function unescapeLabel(raw: string): string {
  return raw.replace(/\\(.)/g, (_, ch: string) => (ch === "n" ? "\n" : ch));
}

function parseLabels(block: string | undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (!block) return labels;
  for (const match of block.matchAll(LABEL_RE)) {
    labels[match[1]] = unescapeLabel(match[2]);
  }
  return labels;
}

/** Parse Prometheus exposition text into samples. Unparseable lines are skipped. */
export function parsePrometheus(text: string): PromSample[] {
  const samples: PromSample[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = LINE_RE.exec(line);
    if (!match) continue;
    const value = Number(match[3]);
    if (!Number.isFinite(value)) continue;
    samples.push({ name: match[1], labels: parseLabels(match[2]), value });
  }
  return samples;
}

function matches(
  sample: PromSample,
  name: string,
  labels: Record<string, string>,
): boolean {
  return (
    sample.name === name &&
    Object.entries(labels).every(([k, v]) => sample.labels[k] === v)
  );
}

/** Value of the first sample named `name` whose labels include `labels`. */
export function promValue(
  samples: PromSample[],
  name: string,
  labels: Record<string, string> = {},
): number | null {
  return samples.find((s) => matches(s, name, labels))?.value ?? null;
}

/** Sum of every sample named `name` whose labels include `labels`; null when none match. */
export function promSum(
  samples: PromSample[],
  name: string,
  labels: Record<string, string> = {},
): number | null {
  const hits = samples.filter((s) => matches(s, name, labels));
  return hits.length ? hits.reduce((sum, s) => sum + s.value, 0) : null;
}
