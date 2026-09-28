import { describe, expect, it } from "vitest";
import type { RadianceHdrImage } from "@bim-studio/deep-engine";
import { studioDeepNeutralEnvironment, studioNeutralEnvironmentImage, studioNeutralRadiance } from "./studioDeepNeutralEnvironment";

describe("Studio Deep neutral environment fallback (Z1 P3)", () => {
  it("radiates a non-zero studio field in every direction", () => {
    let redSum = 0, blueSum = 0;
    for (let step = 0; step < 64; step++) {
      const polar = (step / 64) * Math.PI;
      const azimuth = step * 2.399963; // 黄金角散点,覆盖全方向。
      const direction: readonly [number, number, number] = [
        Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth)];
      const [r, g, b] = studioNeutralRadiance(direction);
      expect([r, g, b].every(Number.isFinite)).toBe(true);
      // 非纯黑:任一方向都有可见辐照(红线:黑 IBL 把材质打回死黑)。
      expect(Math.max(r, g, b)).toBeGreaterThan(0.01);
      redSum += r; blueSum += b;
    }
    // 冷灰基调:天空渐变主导,整体蓝色分量不低于红色。
    expect(blueSum).toBeGreaterThanOrEqual(redSum);
  });

  it("keeps directional light structure: zenith brighter than nadir, key light brighter than opposite", () => {
    const zenith = studioNeutralRadiance([0, 1, 0]);
    const nadir = studioNeutralRadiance([0, -1, 0]);
    expect(zenith[1]).toBeGreaterThan(nadir[1]);
    const keyCenter: readonly [number, number, number] = [-1, 1.5, 1];
    const length = Math.hypot(...keyCenter);
    const key = studioNeutralRadiance([keyCenter[0] / length, keyCenter[1] / length, keyCenter[2] / length]);
    const opposite = studioNeutralRadiance([-keyCenter[0] / length, -keyCenter[1] / length, -keyCenter[2] / length]);
    expect(key[0]).toBeGreaterThan(opposite[0]);
  });

  it("generates a deterministic equirect image matching the RadianceHdr contract", () => {
    const first = studioNeutralEnvironmentImage();
    const second = studioNeutralEnvironmentImage();
    expect(second).toBe(first); // 确定性:同一数组复用。
    const image = first as RadianceHdrImage;
    expect(image.width).toBeGreaterThan(1);
    expect(image.height).toBeGreaterThan(1);
    expect(image.data).toHaveLength(image.width * image.height * 3);
    let minimum = Number.POSITIVE_INFINITY, maximum = 0;
    for (const value of image.data) {
      expect(Number.isFinite(value)).toBe(true);
      minimum = Math.min(minimum, value);
      maximum = Math.max(maximum, value);
    }
    // 全图非纯黑、非全白:中性环境有可见暗部与高光层级。
    expect(minimum).toBeGreaterThan(0);
    expect(maximum).toBeGreaterThan(1); // HDR 高光(softbox 强度 > 1)。
    // 第 0 行 = 天顶(引擎 equirectangular 采样方向):天顶行平均亮度高于末行。
    const rowAverage = (row: number) => {
      let sum = 0;
      for (let index = row * image.width * 3; index < (row + 1) * image.width * 3; index++) sum += image.data[index]!;
      return sum / (image.width * 3);
    };
    expect(rowAverage(0)).toBeGreaterThan(rowAverage(image.height - 1));
  });

  it("selects the engine-native studio source without a sky, and HDR fallback with one", () => {
    const plain = studioDeepNeutralEnvironment();
    expect(plain).toEqual({ kind: "studio" });
    const sky: RadianceHdrImage = { width: 2, height: 1, data: new Float32Array([0, 3, 7, 0, 3, 7]) };
    const withSky = studioDeepNeutralEnvironment(sky);
    expect(withSky).toMatchObject({ kind: "radiance-hdr", backgroundImage: sky });
    if (withSky.kind !== "radiance-hdr") throw new Error("Expected HDR fallback");
    expect(withSky.image).toBe(studioNeutralEnvironmentImage());
    // 兜底 IBL 自身非黑:DDGI 探针获得非零辐照。
    expect(withSky.image.data.some(value => value > 0)).toBe(true);
  });
});
