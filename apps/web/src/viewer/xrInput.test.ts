import { describe, expect, it } from "vitest";
import { readXRThumbstick } from "./xrInput";

describe("XR controller input", () => {
  it("uses the final two axes for XR-standard thumbsticks", () => {
    expect(readXRThumbstick([0.8, -0.8, 0.25, -0.5], [])).toEqual({
      x: 0.25,
      y: -0.5,
      exitPressed: false
    });
  });

  it("maps the secondary face button to exit", () => {
    const buttons = Array.from({ length: 6 }, () => ({ pressed: false }));
    buttons[5] = { pressed: true };
    expect(readXRThumbstick([0.1, 0.2], buttons)).toEqual({ x: 0.1, y: 0.2, exitPressed: true });
  });
});
