import { describe, expect, it } from "vitest";
import { Color } from "three";
import { sceneHexToLinearRgb } from "./sceneNeutralAppearance";

describe("scene saved color conversion", () => {
  it("matches Three linear material colors for every 8-bit channel", () => {
    for (let value = 0; value < 256; value++) {
      const channel = value.toString(16).padStart(2, "0");
      for (const hex of [`#${channel}0000`, `#00${channel}00`, `#0000${channel}`]) {
        expect(sceneHexToLinearRgb(hex)).toEqual(new Color(hex).toArray());
      }
    }
    expect(sceneHexToLinearRgb("#F4c76B")).toEqual(new Color("#F4c76B").toArray());
  });

  it("rejects colors outside the saved scene contract", () => {
    expect(() => sceneHexToLinearRgb("#fff")).toThrow(/#RRGGBB/);
    expect(() => sceneHexToLinearRgb("transparent")).toThrow(/#RRGGBB/);
  });
});
