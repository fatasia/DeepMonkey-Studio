import { describe, expect, it } from "vitest";
import { assessProductVisualQuality, FIXED_VIEWER_VISUAL_REGIONS } from "./productVisualQualityPolicy.mjs";

describe("product visual quality policy", () => {
  it.each([
    { severePixelRatio: 0.0099, failures: 0, warnings: 0 },
    { severePixelRatio: 0.01, failures: 0, warnings: 1 },
    { severePixelRatio: 0.02, failures: 0, warnings: 1 },
    { severePixelRatio: 0.020_001, failures: 1, warnings: 0 },
  ])("enforces the exact global severe-pixel boundary at $severePixelRatio", ({ severePixelRatio, failures, warnings }) => {
    const result = assessProductVisualQuality(comparison({ severePixelRatio }));
    expect(result.failures).toHaveLength(failures);
    expect(result.warnings).toHaveLength(warnings);
  });

  it("retains the existing SSIM hard failure and manual-review warning", () => {
    expect(assessProductVisualQuality(comparison({ ssim: 0.69 })).failures[0]).toContain("结构相似度");
    expect(assessProductVisualQuality(comparison({ ssim: 0.89 })).warnings[0]).toContain("人工检查");
  });

  it("fails when a required semantic region is missing", () => {
    const input = comparison();
    input.regions = input.regions.filter((region) => region.id !== "hud");
    expect(assessProductVisualQuality(input).failures).toContain("HUD区域画质指标缺失或非法");
  });

  it("prevents a local object or distant-grid regression from being averaged into the background", () => {
    const objectRegression = comparison();
    objectRegression.regions.find((region) => region.id === "objects-selection").severePixelRatio = 0.03;
    expect(assessProductVisualQuality(objectRegression).failures.join("\n")).toContain("对象与选择区域明显差异");

    const gridRegression = comparison();
    gridRegression.regions.find((region) => region.id === "distant-grid").ssim = 0.8;
    expect(assessProductVisualQuality(gridRegression).failures.join("\n")).toContain("远景网格区域 SSIM");
  });

  it("rejects malformed metrics instead of silently passing", () => {
    expect(assessProductVisualQuality({ ssim: Number.NaN, severePixelRatio: 0 }).failures).toEqual([
      "完整产品 WebGL/WebGPU 画质指标缺失或非法",
    ]);
  });
});

function comparison(patch = {}) {
  return {
    ssim: 0.97,
    severePixelRatio: 0,
    ...patch,
    regions: FIXED_VIEWER_VISUAL_REGIONS.map(({ id, label }) => ({ id, label, ssim: 0.99, severePixelRatio: 0 })),
  };
}
