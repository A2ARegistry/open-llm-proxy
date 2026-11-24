import {
  explorerParams,
  pageCount,
  parseExplorerState,
  requestsQuery,
} from "../../../dashboard/src/lib/requestExplorer";
import { describe, expect, it } from "vitest";

describe("parseExplorerState", () => {
  it("uses defaults for an empty URL", () => {
    expect(parseExplorerState(new URLSearchParams())).toEqual({
      range: "24h",
      filters: {},
      page: 1,
      pageSize: 50,
      requestId: null,
    });
  });

  it("reads every field", () => {
    const state = parseExplorerState(
      new URLSearchParams(
        "range=7d&provider=openai&model=gpt&apiKeyId=none&status=error&cache=none&page=3&size=100&request=r1",
      ),
    );
    expect(state).toEqual({
      range: "7d",
      filters: {
        provider: "openai",
        model: "gpt",
        apiKeyId: "none",
        status: "error",
        cache: "none",
      },
      page: 3,
      pageSize: 100,
      requestId: "r1",
    });
  });

  it("falls back on invalid values", () => {
    const state = parseExplorerState(
      new URLSearchParams("range=2y&page=-4&size=13&model="),
    );
    expect(state).toMatchObject({
      range: "24h",
      page: 1,
      pageSize: 50,
      filters: {},
    });
    expect(parseExplorerState(new URLSearchParams("page=abc")).page).toBe(1);
  });
});

describe("explorerParams", () => {
  it("omits defaults and round-trips", () => {
    const empty = parseExplorerState(new URLSearchParams());
    expect(explorerParams(empty).toString()).toBe("");

    const url =
      "range=1h&provider=openai&status=success&page=2&size=25&request=abc";
    const state = parseExplorerState(new URLSearchParams(url));
    expect(parseExplorerState(explorerParams(state))).toEqual(state);
  });
});

describe("requestsQuery", () => {
  it("turns page into offset and keeps filters", () => {
    const state = parseExplorerState(
      new URLSearchParams("page=3&size=25&model=gpt&request=x"),
    );
    const q = new URLSearchParams(
      requestsQuery(state, { start: 100, end: 200 }),
    );
    expect(Object.fromEntries(q)).toEqual({
      start: "100",
      end: "200",
      limit: "25",
      offset: "50",
      model: "gpt",
    });
  });
});

describe("pageCount", () => {
  it("is at least one page", () => {
    expect(pageCount(0, 50)).toBe(1);
    expect(pageCount(101, 50)).toBe(3);
  });
});
