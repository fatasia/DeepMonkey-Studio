import { describe, expect, it } from "vitest";
import type { DashboardDataWidgetConfig } from "@bim-studio/contracts";
import { defaultDashboardAnimationLoop, resolveDashboardAnimationLoop } from "./dashboardAnimationPlayback";

const widget = (animation: NonNullable<DashboardDataWidgetConfig["animation"]>, animationLoop?: boolean): DashboardDataWidgetConfig => ({
  title: "状态",
  key: "status",
  type: "value",
  unit: "",
  animation,
  ...(animationLoop === undefined ? {} : { animationLoop }),
});

describe("dashboard animation playback", () => {
  it("uses product defaults that match the animation meaning", () => {
    expect(defaultDashboardAnimationLoop("fade")).toBe(false);
    expect(defaultDashboardAnimationLoop("slide-up")).toBe(false);
    expect(defaultDashboardAnimationLoop("scale")).toBe(false);
    expect(defaultDashboardAnimationLoop("pulse")).toBe(true);
  });

  it("lets an explicit playback choice override the default", () => {
    expect(resolveDashboardAnimationLoop(widget("pulse", false))).toBe(false);
    expect(resolveDashboardAnimationLoop(widget("fade", true))).toBe(true);
    expect(resolveDashboardAnimationLoop(widget("pulse"))).toBe(true);
  });
});
