// [fork] W13: Settings page "Power cost" form conversion.
import {
  fromPowerForm,
  toPowerForm,
} from "../../../dashboard/src/lib/powerSettingsForm";
import { describe, expect, it } from "vitest";

const full = {
  pricePerKwhUsd: 0.25,
  overheadW: 12,
  cloudReference: {
    label: "Qwen hosted",
    inputPer1m: 0.4,
    outputPer1m: 1.6,
    cacheReadPer1m: 0.1,
    cacheWritePer1m: 0,
  },
};

describe("power settings form", () => {
  it("round trips a full setting", () => {
    expect(fromPowerForm(toPowerForm(full))).toEqual(full);
  });

  it("empty form clears every field", () => {
    expect(fromPowerForm(toPowerForm({}))).toEqual({
      pricePerKwhUsd: null,
      overheadW: null,
      cloudReference: null,
    });
  });

  it("reference without a label omits it", () => {
    const form = { ...toPowerForm(full), label: "  " };
    const { label: _label, ...ref } = full.cloudReference;
    expect(fromPowerForm(form)).toMatchObject({ cloudReference: ref });
    expect(
      (fromPowerForm(form) as { cloudReference: object }).cloudReference,
    ).not.toHaveProperty("label");
  });

  it("partial reference is an error", () => {
    expect(fromPowerForm({ ...toPowerForm({}), input: "1" })).toHaveProperty(
      "error",
    );
    expect(fromPowerForm({ ...toPowerForm({}), label: "x" })).toHaveProperty(
      "error",
    );
  });

  it("non-numeric or negative values are errors", () => {
    expect(fromPowerForm({ ...toPowerForm({}), price: "abc" })).toHaveProperty(
      "error",
    );
    expect(
      fromPowerForm({ ...toPowerForm({}), overhead: "-3" }),
    ).toHaveProperty("error");
    expect(fromPowerForm({ ...toPowerForm(full), output: "x" })).toHaveProperty(
      "error",
    );
  });
});
