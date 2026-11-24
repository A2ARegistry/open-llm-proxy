// [fork] W11: read-only, allowlisted live metric sources.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LIVE_TIMEOUT_MS,
  fetchLiveText,
  hostBinding,
  hostMetricsBindingNames,
  inferenceBinding,
} from "~/src/live/sources";

const ORG = "org_live";

function fetcher(body = "ok", status = 200) {
  return {
    fetch: vi.fn().mockResolvedValue(new Response(body, { status })),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("hostMetricsBindingNames", () => {
  it("honours the allowlist", () => {
    const env = { HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}, OTHER` };
    expect(hostMetricsBindingNames(env)).toEqual(["BOXSTATS", "OTHER"]);
    expect(hostMetricsBindingNames(env, ORG)).toEqual(["BOXSTATS"]);
    expect(hostMetricsBindingNames(env, "org_x")).toEqual([]);
    expect(hostMetricsBindingNames({})).toEqual([]);
  });
});

describe("hostBinding", () => {
  it("returns the first allowed bound binding", () => {
    const box = fetcher();
    const env = {
      HOST_METRICS_BINDINGS: `MISSING:${ORG},BOXSTATS:${ORG}`,
      BOXSTATS: box,
    };
    expect(hostBinding(env, ORG)).toEqual({ name: "BOXSTATS", fetcher: box });
  });

  it("is null for an org not listed, and never touches the binding", () => {
    const box = fetcher();
    const env = { HOST_METRICS_BINDINGS: "BOXSTATS:org_other", BOXSTATS: box };
    expect(hostBinding(env, ORG)).toBeNull();
    expect(box.fetch).not.toHaveBeenCalled();
  });
});

describe("inferenceBinding", () => {
  it("uses VPC_BINDINGS for the org", () => {
    const halogen = fetcher();
    const env = { VPC_BINDINGS: `HALOGEN:${ORG}`, HALOGEN: halogen };
    expect(inferenceBinding(env, ORG)).toEqual({
      name: "HALOGEN",
      fetcher: halogen,
    });
    expect(inferenceBinding(env, "org_x")).toBeNull();
  });

  it("ignores HOST_METRICS_BINDINGS names", () => {
    const env = {
      VPC_BINDINGS: "",
      HOST_METRICS_BINDINGS: `BOXSTATS:${ORG}`,
      BOXSTATS: fetcher(),
    };
    expect(inferenceBinding(env, ORG)).toBeNull();
  });
});

describe("fetchLiveText", () => {
  it("calls GET on the pinned URL", async () => {
    const f = fetcher("metrics body");
    expect(await fetchLiveText(f, "/metrics")).toBe("metrics body");
    const [url, init] = f.fetch.mock.calls[0];
    expect(url).toBe("http://vpc.internal/metrics");
    expect(init.method).toBe("GET");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("returns null on 500 and on throw", async () => {
    expect(await fetchLiveText(fetcher("x", 500), "/health")).toBeNull();
    const broken = { fetch: vi.fn().mockRejectedValue(new Error("down")) };
    expect(await fetchLiveText(broken, "/health")).toBeNull();
  });

  it("gives up after LIVE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    const hanging = {
      fetch: vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_, reject) => {
            init.signal!.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
      ),
    };
    const pending = fetchLiveText(hanging, "/metrics");
    await vi.advanceTimersByTimeAsync(LIVE_TIMEOUT_MS);
    expect(await pending).toBeNull();
    expect(LIVE_TIMEOUT_MS).toBe(2000);
  });
});
