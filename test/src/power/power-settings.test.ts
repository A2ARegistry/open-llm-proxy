// [fork] W13: power settings validation.
import { describe, expect, it } from "vitest";
import {
  applyPowerPatch,
  parsePowerSettings,
} from "~/src/power/power-settings";

const ref = {
  inputPer1m: 1,
  outputPer1m: 4,
  cacheReadPer1m: 0.1,
  cacheWritePer1m: 0,
};

describe("parsePowerSettings", () => {
  it("accepts valid values", () => {
    expect(parsePowerSettings({ pricePerKwhUsd: 0.25, overheadW: 12 })).toEqual(
      { pricePerKwhUsd: 0.25, overheadW: 12 },
    );
    expect(
      parsePowerSettings({ cloudReference: { ...ref, label: "Qwen hosted" } }),
    ).toEqual({ cloudReference: { ...ref, label: "Qwen hosted" } });
  });

  it("passes null through to clear a field", () => {
    expect(
      parsePowerSettings({
        pricePerKwhUsd: null,
        overheadW: null,
        cloudReference: null,
      }),
    ).toEqual({ pricePerKwhUsd: null, overheadW: null, cloudReference: null });
  });

  it("ignores missing fields", () => {
    expect(parsePowerSettings({})).toEqual({});
  });

  it("rejects bad values", () => {
    for (const body of [
      null,
      "x",
      { overheadW: 501 },
      { overheadW: -1 },
      { pricePerKwhUsd: -1 },
      { pricePerKwhUsd: "0.2" },
      { pricePerKwhUsd: Number.NaN },
      { cloudReference: { inputPer1m: 1 } },
      { cloudReference: "cheap" },
      { cloudReference: { ...ref, label: 5 } },
      { cloudReference: { ...ref, label: "x".repeat(81) } },
    ]) {
      expect(parsePowerSettings(body)).toHaveProperty("error");
    }
  });
});

describe("applyPowerPatch", () => {
  it("sets, keeps and clears fields", () => {
    expect(
      applyPowerPatch(
        { pricePerKwhUsd: 0.2, overheadW: 10, cloudReference: ref },
        { overheadW: 15, cloudReference: null },
      ),
    ).toEqual({ pricePerKwhUsd: 0.2, overheadW: 15 });
  });
});
