// [fork] W13: Settings page "Power cost" form conversion.
import {
  fromPowerForm,
  toPowerForm,
} from "../../../dashboard/src/lib/powerSettingsForm";
import { describe, expect, it } from "vitest";

const full = { pricePerKwhUsd: 0.25, overheadW: 12 };

describe("power settings form", () => {
  it("round trips a full setting", () => {
    expect(fromPowerForm(toPowerForm(full))).toEqual(full);
  });

  it("empty form clears every field", () => {
    expect(fromPowerForm(toPowerForm({}))).toEqual({
      pricePerKwhUsd: null,
      overheadW: null,
    });
  });

  it("non-numeric or negative values are errors", () => {
    expect(fromPowerForm({ ...toPowerForm({}), price: "abc" })).toHaveProperty(
      "error",
    );
    expect(
      fromPowerForm({ ...toPowerForm({}), overhead: "-3" }),
    ).toHaveProperty("error");
  });
});
