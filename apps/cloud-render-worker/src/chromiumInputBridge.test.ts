import { describe, expect, it } from "vitest";
import { parseInput } from "./chromiumInputBridge.js";

describe("cloud render input bridge", () => {
  it("normalizes pointer coordinates and rejects malformed events", () => {
    expect(parseInput({ type: "pointer", action: "move", x: -1, y: 1.8, button: "other" })).toEqual({
      type: "pointer", action: "move", x: 0, y: 1, button: "left"
    });
    expect(parseInput({ type: "pointer", action: "move", x: "invalid", y: 0.5 })).toBeUndefined();
  });

  it("limits wheel deltas and keyboard payload size", () => {
    expect(parseInput({ type: "wheel", deltaX: 8_000, deltaY: -8_000 })).toEqual({ type: "wheel", deltaX: 2_000, deltaY: -2_000 });
    expect(parseInput({ type: "key", action: "down", key: "A" })).toEqual({ type: "key", action: "down", key: "A" });
    expect(parseInput({ type: "key", action: "down", key: "x".repeat(33) })).toBeUndefined();
  });
});
