import { describe, expect, it } from "vitest";
import { AdaptiveRenderScaleController } from "./adaptiveRenderScale";

describe("AdaptiveRenderScaleController", () => {
  it("keeps full quality until sustained pressure is proven", () => {
    const controller = new AdaptiveRenderScaleController(2);
    controller.setEnabled(true);
    expect(controller.sample({ sampleCount: 119, p95FrameMs: 40, visible: true })).toBeUndefined();
    expect(controller.sample(sample(30))).toBeUndefined();
    expect(controller.sample(sample(30))).toBeUndefined();
    expect(controller.sample(sample(30))).toBe(1.9);
    expect(controller.state()).toMatchObject({ mode: "adaptive-fill-rate", renderScale: 0.95 });
  });

  it("never lowers below 90% or below one physical pixel per CSS pixel", () => {
    const highDpi = new AdaptiveRenderScaleController(2);
    highDpi.setEnabled(true);
    pressure(highDpi);
    pressure(highDpi);
    pressure(highDpi);
    expect(highDpi.state().pixelRatio).toBe(1.8);

    const regular = new AdaptiveRenderScaleController(1);
    regular.setEnabled(true);
    pressure(regular);
    expect(regular.state()).toMatchObject({ pixelRatio: 1, mode: "full-quality" });
  });

  it("restores device quality after stable healthy windows", () => {
    const controller = new AdaptiveRenderScaleController(2);
    controller.setEnabled(true);
    pressure(controller);
    for (let index = 0; index < 3; index += 1) expect(controller.sample(sample(16))).toBeUndefined();
    expect(controller.sample(sample(16))).toBe(2);
    expect(controller.state()).toMatchObject({ mode: "full-quality", renderScale: 1 });
  });

  it("disabling adaptive mode immediately restores the baseline", () => {
    const controller = new AdaptiveRenderScaleController(1.5);
    controller.setEnabled(true);
    pressure(controller);
    expect(controller.setEnabled(false)).toBe(1.5);
    expect(controller.state()).toMatchObject({ enabled: false, mode: "full-quality" });
  });
});

function sample(p95FrameMs: number) {
  return { sampleCount: 240, p95FrameMs, visible: true };
}

function pressure(controller: AdaptiveRenderScaleController): void {
  controller.sample(sample(30));
  controller.sample(sample(30));
  controller.sample(sample(30));
}
