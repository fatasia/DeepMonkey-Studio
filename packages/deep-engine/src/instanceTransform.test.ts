import { describe, expect, it } from "vitest";
import { packTransform, packTransformRelativeTo } from "./instanceTransform.js";

const identityTranslation = (x: number, y = 0, z = 0): number[] =>
  [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const packed = (matrix: number[], origin?: number[]): Float32Array => {
  const output = new Float32Array(24);
  if (origin === undefined) packTransform(matrix, output);
  else packTransformRelativeTo(matrix, origin, output);
  return output;
};

describe("packTransformRelativeTo（CPU 侧 Float64 相机位置减法）", () => {
  it("减法发生在 Float64 域：1e7 世界坐标减去相机位置后平移列精确到亚毫米", () => {
    const world = 1e7 + 0.6, camera: number[] = [world + 12.6, 3, 12];
    const result = packed(identityTranslation(world), camera);
    expect(result[3]).toBeCloseTo(-12.6, 5); // fround(-12.6) 误差 <1e-6，而非 1e7 处 ulp=1.0
    expect(result[7]).toBeCloseTo(-3, 5);
    expect(result[11]).toBeCloseTo(-12, 5);
  });

  it("Float64 减法保留 pack 层吞掉的亚单位坐标：+0.5 偏移不再丢失", () => {
    const world = 1e7 + 0.5, camera: number[] = [world - 4.5, 0, 0];
    expect(packed(identityTranslation(world), camera)[3]).toBe(4.5); // fround(4.5) 精确，无 ulp 损伤
    const legacy = packed(identityTranslation(world)); // 旧路径：1e7+0.5 在 f32 中折叠到 1e7
    expect(legacy[3]).toBe(1e7);
  });

  it("origin 全零时与 packTransform 逐位一致，含镜像行列与返回值（回归：零行为变化）", () => {
    const matrices: number[][] = [
      identityTranslation(12.5, -3, 8),
      [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 6, 7, 1], // 镜像（负行列式）
      [2, 0, 0.5, 0, 0, 3, 0, 0, 0.25, 0, 0.5, 0, -1000.25, 4e5, 0, 1], // 剪切+非均匀缩放
    ];
    for (const matrix of matrices) {
      const legacy = new Float32Array(24);
      const relative = new Float32Array(24);
      const mirroredLegacy = packTransform(matrix, legacy);
      const mirroredRelative = packTransformRelativeTo(matrix, [0, 0, 0], relative);
      expect(Array.from(relative)).toEqual(Array.from(legacy));
      expect(mirroredRelative).toBe(mirroredLegacy);
    }
  });

  it("旋转/缩放列不受 origin 影响，只有平移列被平移", () => {
    const matrix: number[] = [2, 0, 0, 0, 0, 0.5, 0, 0, 0, 0, 1, 0, 1e6 + 0.03, 7, -8, 1];
    const legacy = packed(matrix), relative = packed(matrix, [1e6, 5, -6]);
    expect(Array.from(relative.slice(0, 3))).toEqual(Array.from(legacy.slice(0, 3)));
    expect(Array.from(relative.slice(4, 7))).toEqual(Array.from(legacy.slice(4, 7)));
    expect(Array.from(relative.slice(8, 11))).toEqual(Array.from(legacy.slice(8, 11)));
    expect(relative[3]).toBeCloseTo(0.03, 4);
    expect(relative[7]).toBeCloseTo(2, 5);
    expect(relative[11]).toBeCloseTo(-2, 5);
  });

  it("offset 透传：相对打包可写入任意槽位", () => {
    const output = new Float32Array(48);
    const matrix = identityTranslation(1e7 + 0.3);
    const mirrored = packTransformRelativeTo(matrix, [1e7, 0, 0], output, 24);
    expect(mirrored).toBe(false);
    expect(output[24 + 3]).toBeCloseTo(0.3, 5);
    expect(Array.from(output.slice(0, 24))).toEqual(Array(24).fill(0));
  });

  it("非法输入按 packTransform 同族语义拒绝", () => {
    expect(() => packTransformRelativeTo(identityTranslation(0), [Number.NaN, 0, 0], new Float32Array(24)))
      .toThrow("Camera world position");
    expect(() => packTransformRelativeTo(identityTranslation(0), [0, 0], new Float32Array(24)))
      .toThrow("Camera world position");
    expect(() => packTransformRelativeTo([1, 0, 0, 0], [0, 0, 0], new Float32Array(24)))
      .toThrow("Transform must contain 16 components.");
    const singular: number[] = [1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1];
    expect(() => packTransformRelativeTo(singular, [0, 0, 0], new Float32Array(24)))
      .toThrow("ill-conditioned");
  });
});
