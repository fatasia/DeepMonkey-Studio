import { describe, expect, it } from "vitest";
import { DEFAULT_NAVIGATION_SETTINGS, normalizeNavigationSettings } from "./navigationSettings";

describe("navigation settings", () => {
  it("fills missing values with product defaults", () => {
    expect(normalizeNavigationSettings()).toEqual(DEFAULT_NAVIGATION_SETTINGS);
  });

  it("keeps motion settings inside safe editor ranges", () => {
    expect(normalizeNavigationSettings({
      walkSpeed: -1,
      flySpeed: 999,
      sprintMultiplier: 0,
      eyeHeight: 9,
      gravity: -10,
      jumpSpeed: 999,
      stepHeight: 9,
      maxSlopeAngle: 100
    })).toEqual({
      walkSpeed: 0.1,
      flySpeed: 100,
      sprintMultiplier: 1,
      eyeHeight: 4,
      gravity: 0,
      jumpSpeed: 30,
      stepHeight: 1.2,
      maxSlopeAngle: 89
    });
  });
});
