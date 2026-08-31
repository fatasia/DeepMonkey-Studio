import { validateCapabilityValue } from "@bim-studio/plugin-runtime";
import { describe, expect, it } from "vitest";
import { BATTERY_CAPABILITY_SCHEMAS } from "./batteryCapabilitySchemas.js";

describe("battery capability schemas", () => {
  it("uses the same percentage contract as the formal RUL service", () => {
    const schema = BATTERY_CAPABILITY_SCHEMAS["battery.model.predict"].input;
    const base = { model: "batterymformer", fileName: "cell.csv", records: [{ cycle: 1 }] };
    expect(validateCapabilityValue(schema, { ...base, targetCapacityRetention: 80 })).toEqual([]);
    expect(validateCapabilityValue(schema, { ...base, targetCapacityRetention: 0.8 }).join(" ")).toContain("不能小于 50");
  });

  it("matches the source service simulation limits", () => {
    const schema = BATTERY_CAPABILITY_SCHEMAS["battery.twin.simulate"].input;
    const valid = {
      twinId: "twin-12345678",
      resolutionMinutes: 0.25,
      segments: [{ durationMinutes: 120, currentCRate: -3, ambientTemperatureC: 80 }]
    };
    expect(validateCapabilityValue(schema, valid)).toEqual([]);
    expect(validateCapabilityValue(schema, { ...valid, resolutionMinutes: 0.1 }).join(" ")).toContain("不能小于 0.25");
  });
});
