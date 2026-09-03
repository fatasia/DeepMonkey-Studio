import { describe, expect, it } from "vitest";
import {
  clampBehaviorFloatRect,
  defaultBehaviorFloatRect,
  moveBehaviorFloatRect,
  parseBehaviorFloatRect,
  resizeBehaviorFloatRect,
} from "./behaviorFloatLayout";

const viewport = { width: 1_440, height: 900 };

describe("behavior float layout", () => {
  it("creates a centered usable default", () => {
    expect(defaultBehaviorFloatRect(viewport)).toEqual({ x: 200, y: 68, width: 1_040, height: 680 });
  });

  it("keeps dragged and resized windows inside the viewport", () => {
    const initial = { x: 200, y: 80, width: 800, height: 520 };
    expect(moveBehaviorFloatRect(initial, 2_000, 2_000, viewport)).toEqual({ x: 628, y: 368, width: 800, height: 520 });
    expect(resizeBehaviorFloatRect(initial, -1_000, -1_000, viewport)).toEqual({ x: 200, y: 80, width: 640, height: 420 });
  });

  it("recovers invalid and off-screen stored preferences", () => {
    expect(parseBehaviorFloatRect("not-json", viewport)).toEqual(defaultBehaviorFloatRect(viewport));
    expect(parseBehaviorFloatRect(JSON.stringify({ x: 9_000, y: 9_000, width: 900, height: 500 }), viewport))
      .toEqual({ x: 528, y: 388, width: 900, height: 500 });
    expect(clampBehaviorFloatRect({ x: 0, y: 0, width: 900, height: 900 }, { width: 720, height: 600 }))
      .toEqual({ x: 6, y: 68, width: 708, height: 526 });
  });
});
