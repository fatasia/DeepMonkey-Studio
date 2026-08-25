import type { NavigationSettingsState } from "@bim-studio/contracts";

export const DEFAULT_NAVIGATION_SETTINGS: NavigationSettingsState = {
  walkSpeed: 4,
  flySpeed: 5,
  sprintMultiplier: 2,
  eyeHeight: 1.68,
  gravity: 12,
  jumpSpeed: 5.4,
  stepHeight: 0.3,
  maxSlopeAngle: 50
};

export function normalizeNavigationSettings(value?: Partial<NavigationSettingsState>): NavigationSettingsState {
  return {
    walkSpeed: bounded(value?.walkSpeed, DEFAULT_NAVIGATION_SETTINGS.walkSpeed, 0.1, 50),
    flySpeed: bounded(value?.flySpeed, DEFAULT_NAVIGATION_SETTINGS.flySpeed, 0.1, 100),
    sprintMultiplier: bounded(value?.sprintMultiplier, DEFAULT_NAVIGATION_SETTINGS.sprintMultiplier, 1, 6),
    eyeHeight: bounded(value?.eyeHeight, DEFAULT_NAVIGATION_SETTINGS.eyeHeight, 0.3, 4),
    gravity: bounded(value?.gravity, DEFAULT_NAVIGATION_SETTINGS.gravity, 0, 80),
    jumpSpeed: bounded(value?.jumpSpeed, DEFAULT_NAVIGATION_SETTINGS.jumpSpeed, 0, 30),
    stepHeight: bounded(value?.stepHeight, DEFAULT_NAVIGATION_SETTINGS.stepHeight, 0, 1.2),
    maxSlopeAngle: bounded(value?.maxSlopeAngle, DEFAULT_NAVIGATION_SETTINGS.maxSlopeAngle, 0, 89)
  };
}

function bounded(value: number | undefined, fallback: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, Number.isFinite(value) ? value! : fallback));
}
