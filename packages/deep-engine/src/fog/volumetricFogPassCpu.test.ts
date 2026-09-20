import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultTestMedium, henyeyGreensteinPhase, rayMarchVolumetricFog } from "./volumetricFog.js";
import { VOLUMETRIC_FOG_DEPTH_FORMAT, VOLUMETRIC_FOG_SCATTER_FORMAT } from "./volumetricFogPassTypes.js";
import { VOLUMETRIC_FOG_MARCH_WGSL, VOLUMETRIC_FOG_WORKGROUP_SIZE } from "./volumetricFogPassWgsl.js";
import { VOLUMETRIC_FOG_STEPS_MAX, VOLUMETRIC_FOG_STEPS_MIN, marchVolumetricFogPassCpu,
  validateVolumetricFogLight, validateVolumetricFogOptions, validateVolumetricMedium,
  volumetricFogHalfSize, volumetricFogPassCpu } from "./volumetricFogPassCpu.js";

const MEDIUM = Object.freeze({ baseExtinction: 0.02, scaleHeight: 8, anisotropy: 0.3, albedo: 0.8 });
const LIGHT = Object.freeze({ direction: [0.3, -0.8, 0.2] as const, radiance: [1, 0.95, 0.9] as const });
const OPTIONS = Object.freeze({ verticalFovRadians: Math.PI / 3, steps: 48, maxDistance: 120, medium: MEDIUM, light: LIGHT });

function uniformScene(width: number, height: number, depth: number) {
  return { width, height, depth: new Array<number>(width * height).fill(depth) };
}
/** 小场景:左侧两列深度 0(天空),其余深度 10(几何)。 */
function mixedScene() {
  const width = 8, height = 8;
  const depth = new Array<number>(width * height).fill(10);
  for (let y = 0; y < height; y++) { depth[y * width + 0] = 0; depth[y * width + 1] = 0; }
  return { width, height, depth };
}

describe("volumetricFogHalfSize", () => {
  it("ceil-divides by two", () => {
    expect(volumetricFogHalfSize(64, 63)).toEqual([32, 32]);
    expect(volumetricFogHalfSize(1, 1)).toEqual([1, 1]);
  });
  it("rejects non-positive and non-integer sizes", () => {
    expect(() => volumetricFogHalfSize(0, 10)).toThrow(/positive safe integers/);
    expect(() => volumetricFogHalfSize(10.5, 10)).toThrow(/positive safe integers/);
  });
});

describe("validateVolumetricFogOptions", () => {
  it("accepts the reference options and the CPU test medium", () => {
    validateVolumetricFogOptions({ ...OPTIONS });
    validateVolumetricMedium(defaultTestMedium());
  });
  it("rejects fov, steps, and maxDistance out of range", () => {
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, verticalFovRadians: 0 })).toThrow(/verticalFovRadians/);
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, verticalFovRadians: Math.PI })).toThrow(/verticalFovRadians/);
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, steps: VOLUMETRIC_FOG_STEPS_MIN - 1 })).toThrow(/steps/);
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, steps: VOLUMETRIC_FOG_STEPS_MAX + 1 })).toThrow(/steps/);
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, steps: 48.5 })).toThrow(/steps/);
    expect(() => validateVolumetricFogOptions({ ...OPTIONS, maxDistance: 0 })).toThrow(/maxDistance/);
  });
  it("rejects medium and light out of physical range", () => {
    expect(() => validateVolumetricMedium({ ...MEDIUM, baseExtinction: -1 })).toThrow(/baseExtinction/);
    expect(() => validateVolumetricMedium({ ...MEDIUM, scaleHeight: 0 })).toThrow(/scaleHeight/);
    expect(() => validateVolumetricMedium({ ...MEDIUM, anisotropy: 1 })).toThrow(/anisotropy/);
    expect(() => validateVolumetricMedium({ ...MEDIUM, albedo: 1.5 })).toThrow(/albedo/);
    expect(() => validateVolumetricFogLight({ direction: [0, 0, 0], radiance: [1, 1, 1] })).toThrow(/direction/);
    expect(() => validateVolumetricFogLight({ direction: [1, 0, 0], radiance: [1, -0.1, 1] })).toThrow(/radiance/);
  });
});

describe("CPU/WGSL/CPU-reference formula parity (string-locked)", () => {
  // 逐式对拍锁:CPU 参考(volumetricFog.ts)与 WGSL 核的公式文本必须同构存在,
  // 任一侧单独改动都会失败。数值恒等由下一组的镜像 ≡ rayMarchVolumetricFog 断言保证。
  it("wgsl formulas mirror the volumetricFog.ts reference text", async () => {
    const cpuSource = await readFile(new URL("./volumetricFog.ts", import.meta.url), "utf8");
    // Henyey-Greenstein 相位:1-2g·cosθ+g² 被 max(·,ε) 钳制后取 1.5 次幂作分母。
    expect(cpuSource).toContain("4 * Math.PI * Math.sqrt(Math.max(1 - 2 * anisotropy * cosTheta + g2, EPSILON) ** 3)");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("4.0 * FOG_PI * sqrt(pow(max(1.0 - 2.0 * anisotropy * cosTheta + g2, FOG_EPSILON), 3.0))");
    // 指数高度衰减密度:σ₀·exp(-max(h,0)/H)。
    expect(cpuSource).toContain("baseExtinction * Math.exp(-Math.max(height, 0) / medium.scaleHeight)");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("baseExtinction * exp(-max(height, 0.0) / scaleHeight)");
    // Beer-Lambert 消光:exp(-Δτ),σ₀ 单次计入(2026-09-19 量纲修复后的基线)。
    expect(cpuSource).toContain("const extinction = Math.exp(-opticalDepth);");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("let extinction = exp(-opticalDepth);");
    // 散射:albedo·Δτ·phase·shadow(切片一 shadow ≡ 1)。
    expect(cpuSource).toContain("medium.albedo * opticalDepth * phase * shadow");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("let scattering = albedo * opticalDepth * phase * 1.0;");
    // 步进高度:rayHeightAt(0, dirY, t) ↔ 相机在视图空间原点的核内实例。
    expect(cpuSource).toContain("return originY + directionY * t;");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("let height = rayDirection.y * distance;");
    // 中点采样与数值常量逐值一致。
    expect(cpuSource).toContain("(step + 0.5) * stepLength");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("(f32(step) + 0.5) * stepLength");
    expect(cpuSource).toContain("export const EPSILON = 1e-8;");
    expect(cpuSource).toContain("export const TRANSMITTANCE_FLOOR = 1e-4;");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("const FOG_EPSILON: f32 = 0.00000001;");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("const FOG_TRANSMITTANCE_FLOOR: f32 = 0.0001;");
    expect(cpuSource).toContain("transmittance < TRANSMITTANCE_FLOOR");
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("transmittance < FOG_TRANSMITTANCE_FLOOR");
  });
  it("exposes the entry point and workgroup contract the pass binds", () => {
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toMatch(/fn marchVolumetricFog\(/);
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toMatch(/@workgroup_size\(8, 8\)/);
    expect(VOLUMETRIC_FOG_MARCH_WGSL).toContain("texture_storage_2d<rgba16float, write>");
    expect(VOLUMETRIC_FOG_WORKGROUP_SIZE).toBe(8);
  });
  it("declares the expected texture formats", () => {
    expect(VOLUMETRIC_FOG_SCATTER_FORMAT).toBe("rgba16float");
    expect(VOLUMETRIC_FOG_DEPTH_FORMAT).toBe("r32float");
  });
});

describe("mirror march equals the CPU reference numerically", () => {
  it("henyeyGreensteinPhase matches an independently written evaluation", () => {
    const expected = (1 - 0.09) / (4 * Math.PI * Math.pow(0.79, 1.5)); // g=0.3, cosθ=0.5
    expect(henyeyGreensteinPhase(0.5, 0.3)).toBeCloseTo(expected, 12);
  });
  it("mirror pixel equals rayMarchVolumetricFog for the identical ray (formula identity)", () => {
    const width = 8, height = 8;
    const halfX = 3, halfY = 2;
    const x = Math.min(halfX * 2 + 1, width - 1), y = Math.min(halfY * 2 + 1, height - 1);
    const tanHalfFov = Math.tan(OPTIONS.verticalFovRadians * 0.5), aspect = width / height;
    const ndcX = ((x + 0.5) / width) * 2 - 1, ndcY = 1 - ((y + 0.5) / height) * 2;
    const rayUnitX = ndcX * tanHalfFov * aspect, rayUnitY = ndcY * tanHalfFov, rayUnitZ = -1;
    const rayLength = Math.hypot(rayUnitX, rayUnitY, rayUnitZ);
    const far = 10 * rayLength; // |reconstructPosition(coordinate, 10)|
    const reference = rayMarchVolumetricFog(MEDIUM,
      { direction: LIGHT.direction, radiance: LIGHT.radiance },
      { rayOrigin: [0, 0, 0],
        rayDirection: [rayUnitX / rayLength, rayUnitY / rayLength, rayUnitZ / rayLength],
        near: 0, far, stepCount: OPTIONS.steps, shadowAttenuation: () => 1 });
    const [r, g, b, a] = marchVolumetricFogPassCpu(uniformScene(width, height, 10), OPTIONS, halfX, halfY);
    expect(r).toBeCloseTo(reference.inscatter[0], 12);
    expect(g).toBeCloseTo(reference.inscatter[1], 12);
    expect(b).toBeCloseTo(reference.inscatter[2], 12);
    expect(a).toBeCloseTo(reference.transmittance, 12);
  });
  it("uniform medium transmittance matches the closed-form Beer-Lambert law per pixel", () => {
    // scaleHeight → ∞ 的近均匀介质:每个像素的离散步进有解析闭式——
    // 上升光线(dirY>0,高度不被钳制):τ_total = σ₀·Δs·q^½·(1-q^N)/(1-q),q = e^{-dirY·Δs/H};
    // 下降光线(dirY≤0,max(h,0)=0):均匀 σ₀,τ_total = σ₀·L。T = e^{-τ_total} 精确到舍入。
    const medium = { baseExtinction: 0.05, scaleHeight: 1e9, anisotropy: 0.3, albedo: 0.8 };
    const options = { ...OPTIONS, medium, steps: 32 };
    const depth = 10, width = 8, height = 8;
    const result = volumetricFogPassCpu(uniformScene(width, height, depth), options);
    const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5), aspect = width / height;
    for (let halfY = 0; halfY < 4; halfY += 1) {
      for (let halfX = 0; halfX < 4; halfX += 1) {
        const x = Math.min(halfX * 2 + 1, width - 1), y = Math.min(halfY * 2 + 1, height - 1);
        const ndcX = ((x + 0.5) / width) * 2 - 1, ndcY = 1 - ((y + 0.5) / height) * 2;
        const rayLength = Math.hypot(ndcX * tanHalfFov * aspect, ndcY * tanHalfFov, 1);
        const marchDistance = depth * rayLength;
        const dirY = (ndcY * tanHalfFov) / rayLength;
        const deltaS = marchDistance / options.steps;
        let tauTotal: number;
        if (dirY <= 0) {
          tauTotal = medium.baseExtinction * marchDistance;
        } else {
          const ratio = Math.exp(-(dirY * deltaS) / medium.scaleHeight);
          tauTotal = medium.baseExtinction * deltaS * Math.sqrt(ratio) * (1 - Math.pow(ratio, options.steps)) / (1 - ratio);
        }
        // 整帧接口返回 Float32Array(f64 镜像值按 f32 容器量化,GPU 真实目标是 rgba16float,
        // 更粗):f32 半 ulp 在 T≈0.6 处约 3e-8,故闭式对照取 precision 7——
        // 足以甄别任何公式级漂移(此前的 σ₀ 双重计入缺陷会偏差约 50 倍)。
        expect(result.scatter[(halfY * 4 + halfX) * 4 + 3]).toBeCloseTo(Math.exp(-tauTotal), 7);
      }
    }
  });
});

describe("small mixed scene golden values (deterministic f64)", () => {
  it("matches pinned golden rgba values per pixel class", () => {
    const result = volumetricFogPassCpu(mixedScene(), OPTIONS);
    expect(result.width).toBe(4); expect(result.height).toBe(4); expect(result.scatter).toHaveLength(64);
    const at = (halfX: number, halfY: number): readonly number[] => {
      const base = (halfY * result.width + halfX) * 4;
      return [...result.scatter.slice(base, base + 4)];
    };
    // 黄金值于 2026-09-19 由修复后的基线固存;公式、表达式顺序或常量的任何漂移都会失败。
    // 跨平台 Math.exp 可有末位 ulp 差异,因此用 1e-9 绝对容差而非逐位相等。
    const sky = at(0, 1), near = at(1, 1), solid = at(3, 1), center = at(2, 2);
    expect(sky[0]).toBeCloseTo(0.030136805027723312, 9);
    expect(sky[1]).toBeCloseTo(0.028629964217543602, 9);
    expect(sky[2]).toBeCloseTo(0.02712312527000904, 9);
    expect(sky[3]).toBeCloseTo(0.22157180309295654, 9);
    expect(near[0]).toBeCloseTo(0.007009986322373152, 9);
    expect(near[3]).toBeCloseTo(0.8251107931137085, 9);
    expect(solid[0]).toBeCloseTo(0.009042005054652691, 9);
    expect(solid[3]).toBeCloseTo(0.8067781925201416, 9);
    expect(center[0]).toBeCloseTo(0.009969457052648067, 9);
    expect(center[3]).toBeCloseTo(0.8112613558769226, 9);
    // 物理趋势:天空列步进最长 → 透过率最低、散射最强。
    expect(sky[3]).toBeLessThan(near[3]);
    expect(sky[0]).toBeGreaterThan(solid[0]);
    for (const value of result.scatter) expect(Number.isFinite(value)).toBe(true);
  });
  it("transmittance is independent of phase, albedo, and light; scatter is not", () => {
    const baseline = volumetricFogPassCpu(mixedScene(), OPTIONS);
    const forward = volumetricFogPassCpu(mixedScene(), { ...OPTIONS, medium: { ...MEDIUM, anisotropy: 0.9 } });
    const backward = volumetricFogPassCpu(mixedScene(), { ...OPTIONS, medium: { ...MEDIUM, anisotropy: -0.9 } });
    const dark = volumetricFogPassCpu(mixedScene(), { ...OPTIONS, medium: { ...MEDIUM, albedo: 0 } });
    for (let i = 0; i < baseline.scatter.length; i += 4) {
      expect(forward.scatter[i + 3]).toBe(baseline.scatter[i + 3]);
      expect(backward.scatter[i + 3]).toBe(baseline.scatter[i + 3]);
      expect(dark.scatter[i + 3]).toBe(baseline.scatter[i + 3]);
      expect(dark.scatter[i]).toBe(0);
      expect(forward.scatter[i]).not.toBe(baseline.scatter[i]);
    }
  });
  it("zero-extinction medium yields zero inscatter and unit transmittance", () => {
    const result = volumetricFogPassCpu(mixedScene(),
      { ...OPTIONS, medium: { baseExtinction: 0, scaleHeight: 8, anisotropy: 0, albedo: 0.8 } });
    for (let i = 0; i < result.scatter.length; i += 4) {
      expect(result.scatter[i]).toBe(0); expect(result.scatter[i + 3]).toBe(1);
    }
  });
});
