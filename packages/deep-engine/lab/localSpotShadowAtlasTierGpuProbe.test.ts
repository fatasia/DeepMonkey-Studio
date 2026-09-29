import { describe, expect, it } from "vitest";
import { HEIGHT, WIDTH } from "./shadowPagingQualityGpuScene.js";
import { summarizeReadbackLuma } from "./localSpotShadowAtlasTierGpuProbe.js";

describe("atlas tier GPU readback summary", () => {
  it("summarizes a full present-color frame without spreading pixel values as call arguments", () => {
    const luma = new Float32Array(WIDTH * HEIGHT).fill(0.5);
    luma[0] = 0;
    luma[luma.length - 1] = 1;
    expect(summarizeReadbackLuma(luma)).toEqual({ min: 0, max: 1, mean: 0.5 });
  });

  it("handles a single pixel and rejects an empty readback", () => {
    expect(summarizeReadbackLuma(new Float32Array([0.25]))).toEqual({ min: 0.25, max: 0.25, mean: 0.25 });
    expect(() => summarizeReadbackLuma(new Float32Array())).toThrow("empty present-color readback");
  });
});
