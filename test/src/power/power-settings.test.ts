// [fork] W13: power settings validation.
import { describe, expect, it } from "vitest";
import {
  applyPowerPatch,
  parsePowerSettings,
} from "~/src/power/power-settings";

describe("parsePowerSettings", () => {
  it("accepts valid values", () => {
    expect(parsePowerSettings({ pricePerKwhUsd: 0.25, overheadW: 12 })).toEqual(
      { pricePerKwhUsd: 0.25, overheadW: 12 },
    );
  });

  it("passes null through to clear a field", () => {
    expect(
      parsePowerSettings({ pricePerKwhUsd: null, overheadW: null }),
    ).toEqual({ pricePerKwhUsd: null, overheadW: null });
  });

  it("ignores missing and unknown fields", () => {
    expect(parsePowerSettings({})).toEqual({});
    // the cloud comparison comes from model_pricing, not from these settings
    expect(parsePowerSettings({ cloudReference: { inputPer1m: 1 } })).toEqual(
      {},
    );
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
    ]) {
      expect(parsePowerSettings(body)).toHaveProperty("error");
    }
  });
});

describe("applyPowerPatch", () => {
  it("sets, keeps and clears fields", () => {
    expect(
      applyPowerPatch(
        { pricePerKwhUsd: 0.2, overheadW: 10 },
        { overheadW: 15 },
      ),
    ).toEqual({ pricePerKwhUsd: 0.2, overheadW: 15 });
    expect(
      applyPowerPatch(
        { pricePerKwhUsd: 0.2, overheadW: 10 },
        { overheadW: null },
      ),
    ).toEqual({ pricePerKwhUsd: 0.2 });
  });
});
