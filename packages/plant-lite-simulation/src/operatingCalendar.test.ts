import { describe, expect, it } from "vitest";
import { addPlantLiteOperatingMinutes, isPlantLiteAvailableAt, unionPlantLiteAvailabilities } from "./operatingCalendar.js";

describe("Plant Lite operating calendar", () => {
  it("consumes MTBF only inside recurring shift windows", () => {
    const availability = { shifts: [{ startMinute: 60, endMinute: 120 }] };
    expect(addPlantLiteOperatingMinutes(0, 30, availability)).toBe(90);
    expect(addPlantLiteOperatingMinutes(90, 60, availability)).toBe(1_530);
    expect(isPlantLiteAvailableAt(1_530, availability)).toBe(true);
    expect(isPlantLiteAvailableAt(600, availability)).toBe(false);
  });

  it("merges inherited station shifts and treats an always-on consumer as always available", () => {
    expect(unionPlantLiteAvailabilities([
      { shifts: [{ startMinute: 0, endMinute: 60 }] },
      { shifts: [{ startMinute: 45, endMinute: 120 }] },
    ])).toEqual({ shifts: [{ startMinute: 0, endMinute: 120 }] });
    expect(unionPlantLiteAvailabilities([{ shifts: [{ startMinute: 0, endMinute: 60 }] }, undefined])).toBeUndefined();
  });
});
