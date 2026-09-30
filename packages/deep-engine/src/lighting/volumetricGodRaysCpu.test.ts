// I 级 C18 god rays CPU 镜像测试(收口 2026-09-30)。三层锁:
// 1) 字符串级同构锁:WGSL 核(mirror 常量)与 CPU 镜像/雾基线的公式文本逐式对拍,
//    任一侧单独改动即失败;2) 数值锁:marchVolumetricGodRaysPassCpu 与解析参考
//    rayMarchVolumetricGodRaysReference 在 texel 精确场景下**逐位一致**(含相机后方
//    遮挡体 —— 2026-09-30 光栅化起点后移修复的回归锁);3) 纯度锁:CPU 侧为纯函数库,
//    携带任何 GPU 绑定声明/three 依赖即失败。字节门禁在 volumetricGodRaysWgslChecksum.test.ts。
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { defaultTestMedium, henyeyGreensteinPhase } from "../fog/volumetricFog.js";
import { analyticGodRaysShadow, buildGodRaysShadowBasis, GOD_RAYS_SHADOW_FAR_SENTINEL,
  GOD_RAYS_STEPS_MIN, rasterizeGodRaysShadowMap, rayMarchVolumetricGodRaysReference,
  type GodRaysOccluder, type VolumetricGodRaysOptions } from "./volumetricGodRays.js";
import { marchVolumetricGodRaysPassCpu, shadowVisibilityGodRaysCpu, volumetricGodRaysPassCpu } from "./volumetricGodRaysCpu.js";
import { VOLUMETRIC_GOD_RAYS_MARCH_WGSL } from "./volumetricGodRaysWgsl.js";

const MEDIUM = Object.freeze(defaultTestMedium());
const AXIS_LIGHT = Object.freeze({ direction: [0, -1, 0] as const, radiance: [1, 0.95, 0.9] as const });
const OPTIONS = Object.freeze({
  verticalFovRadians: Math.PI / 3, steps: 48, maxDistance: 120,
  medium: MEDIUM, light: AXIS_LIGHT, strength: 1,
  shadowMapSize: 64, shadowRange: 50, shadowBias: 0.05,
} satisfies VolumetricGodRaysOptions);

// light = [0,-1,0]:forward = [0,-1,0](光空间 u = -z, v = x, w = -y),向光回投 = +Y。
// 遮挡盒 x/z 全域横跨 → 每个 texel 存同一朝光面深度(1.5 / -2.25 均为 f32 精确二进制),
// 两路阴影判定无 texel 量化分歧,镜像与参考的逐位对拍才能成立。
const BOX_FRONT: GodRaysOccluder = { kind: "box", min: [-100, -2.5, -100], max: [100, -1.5, 100] }; // w_f = 1.5
const BOX_BEHIND: GodRaysOccluder = { kind: "box", min: [-100, 1.25, -100], max: [100, 2.25, 100] }; // w_f = -2.25(相机后方 w<0)
const BASIS = buildGodRaysShadowBasis([0, -1, 0]);
const RASTER_OPTIONS = { shadowMapSize: 64, shadowRange: 50 } as const;

function uniformScene(width: number, height: number, depth: number) {
  return { width, height, depth: new Array<number>(width * height).fill(depth) };
}

/** 与 marchVolumetricGodRaysPassCpu 逐式相同的像素射线构造(表达式顺序一致,供参考闭式对拍)。 */
function pixelRay(width: number, height: number, halfX: number, halfY: number, verticalFovRadians: number) {
  const tanHalfFov = Math.tan(verticalFovRadians * 0.5);
  const aspect = width / height;
  const x = Math.min(halfX * 2 + 1, width - 1);
  const y = Math.min(halfY * 2 + 1, height - 1);
  const ndcX = ((x + 0.5) / width) * 2 - 1;
  const ndcY = 1 - ((y + 0.5) / height) * 2;
  const rayUnitX = ndcX * tanHalfFov * aspect, rayUnitY = ndcY * tanHalfFov, rayUnitZ = -1;
  const rayLength = Math.hypot(rayUnitX, rayUnitY, rayUnitZ);
  return {
    rayUnit: [rayUnitX, rayUnitY, rayUnitZ] as [number, number, number],
    direction: [rayUnitX / rayLength, rayUnitY / rayLength, rayUnitZ / rayLength] as [number, number, number],
    geometricDistance: (depth: number): number =>
      Math.hypot(ndcX * depth * tanHalfFov * aspect, ndcY * depth * tanHalfFov, -depth),
  };
}

describe("CPU/WGSL/reference formula parity (string-locked)", () => {
  it("wgsl kernel mirrors the CPU pass text formula by formula", async () => {
    const cpuSource = await readFile(new URL("./volumetricGodRaysCpu.ts", import.meta.url), "utf8");
    const fogSource = await readFile(new URL("../fog/volumetricFog.ts", import.meta.url), "utf8");
    // Henyey-Greenstein 相位:1-2g·cosθ+g² 被 max(·,ε) 钳制后取 1.5 次幂作分母(CPU 数学原子在雾基线)。
    expect(fogSource).toContain("4 * Math.PI * Math.sqrt(Math.max(1 - 2 * anisotropy * cosTheta + g2, EPSILON) ** 3)");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("4.0 * GOD_RAYS_PI * sqrt(pow(max(1.0 - 2.0 * anisotropy * cosTheta + g2, GOD_RAYS_EPSILON), 3.0))");
    // 指数高度衰减密度:σ₀·exp(-max(h,0)/H)。
    expect(fogSource).toContain("baseExtinction * Math.exp(-Math.max(height, 0) / medium.scaleHeight)");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("baseExtinction * exp(-max(height, 0.0) / scaleHeight)");
    // Beer-Lambert 消光与散射乘子序(albedo·Δτ·phase·shadow;strength 乘在 radiance 侧)。
    expect(cpuSource).toContain("const extinction = Math.exp(-opticalDepth);");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let extinction = exp(-opticalDepth);");
    expect(cpuSource).toContain("options.medium.albedo * opticalDepth * phase * shadow");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let scattering = albedo * opticalDepth * phase * shadow;");
    expect(cpuSource).toContain("((options.light.radiance[0] ?? 0) * options.strength) * (scattering * transmittance)");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("inscatter += (godRaysParams.lightRadiance.xyz * godRaysParams.lightRadiance.w) * (scattering * transmittance);");
    // 中点采样、高度、数值地板与每步阴影采样点。
    expect(cpuSource).toContain("const t = (step + 0.5) * stepLength;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("(f32(step) + 0.5) * stepLength");
    expect(cpuSource).toContain("const height = rayHeightAt(0, directionY, t);");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let height = rayDirection.y * distance;");
    expect(cpuSource).toContain("if (opticalDepth < EPSILON) continue;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("if (opticalDepth < GOD_RAYS_EPSILON) { continue; }");
    expect(cpuSource).toContain("if (transmittance < TRANSMITTANCE_FLOOR) break;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("if (transmittance < GOD_RAYS_TRANSMITTANCE_FLOOR) { break; }");
    expect(cpuSource).toContain("[directionX * t, directionY * t, directionZ * t]");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let shadow = shadowVisibility(rayDirection * distance);");
  });
  it("wgsl kernel mirrors the CPU shadow-visibility text formula by formula", async () => {
    const cpuSource = await readFile(new URL("./volumetricGodRaysCpu.ts", import.meta.url), "utf8");
    // 域外 fail-open → 最近邻 floor+clamp → 深度比较(严格 >=)三段式,两侧逐式同构。
    expect(cpuSource).toContain("if (uvX < 0 || uvX > 1 || uvY < 0 || uvY > 1) return 1;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) { return 1.0; }");
    expect(cpuSource).toContain("const texelX = Math.min(Math.max(Math.floor(uvX * mapSize), 0), mapSize - 1);");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let texel = clamp(vec2<i32>(floor(uv * vec2f(f32(mapSize)))), vec2<i32>(0i), vec2<i32>(i32(mapSize) - 1i));");
    expect(cpuSource).toContain("return stored >= basisW - shadowBias ? 1 : 0;");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("return select(0.0, 1.0, stored >= basisW - godRaysParams.shadowBasisForward.w);");
    // 半分辨率采样坐标与天空/几何步进分支。
    expect(cpuSource).toContain("const x = Math.min(halfX * 2 + 1, input.width - 1);");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("min(id.xy * 2u + vec2<u32>(1u), godRaysParams.sourceSize - vec2<u32>(1u))");
    expect(cpuSource).toContain("Math.hypot(ndcX * centerDepth * tanHalfFov * aspect, ndcY * centerDepth * tanHalfFov, -centerDepth)");
    expect(VOLUMETRIC_GOD_RAYS_MARCH_WGSL).toContain("let marchDistance = select(godRaysParams.lightDirection.w,");
  });
  it("cpu sources stay a pure-function library: no gpu bindings, no three dependency", async () => {
    for (const file of ["./volumetricGodRaysCpu.ts", "./volumetricGodRays.ts"]) {
      const source = await readFile(new URL(file, import.meta.url), "utf8");
      // 先剥注释再匹配:文档注释允许提及 WGSL 概念,代码不得携带 GPU API / three 依赖。
      const code = source.replace(/\/\/.*$/mg, "").replace(/\/\*[\s\S]*?\*\//g, "");
      expect(code).not.toMatch(/@group|@binding|texture_2d|textureLoad|textureStore|GPUBuffer|navigator|createBindGroup|createComputePipeline|from "three"/);
    }
  });
});

describe("shadowVisibilityGodRaysCpu (阴影图最近邻查询)", () => {
  const frontMap = rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS);
  const emptyMap = rasterizeGodRaysShadowMap(BASIS, [], RASTER_OPTIONS);

  it("rasterizes the toward-light surface depth into every covered texel", () => {
    expect(frontMap.depth.every((d) => d === 1.5)).toBe(true);
    expect(emptyMap.depth.every((d) => d === GOD_RAYS_SHADOW_FAR_SENTINEL)).toBe(true);
  });
  it("fails open outside the shadow uv domain and on far-sentinel texels", () => {
    // 点 (0,-1,±200):u = -z = ∓200 → uv 域外 → fail-open lit。
    expect(shadowVisibilityGodRaysCpu([0, -1, 200], BASIS, frontMap, 50, 0.05)).toBe(1);
    expect(shadowVisibilityGodRaysCpu([0, -1, -200], BASIS, frontMap, 50, 0.05)).toBe(1);
    // 空场景图全 FAR 哨兵 → lit。
    expect(shadowVisibilityGodRaysCpu([0, -5, 0], BASIS, emptyMap, 50, 0.05)).toBe(1);
  });
  it("compares stored texel depth against basisW - shadowBias (strict boundary)", () => {
    // 受遮:w = 5 > w_f(1.5) + bias → 0;受光:w = 1 < w_f - bias → 1。
    expect(shadowVisibilityGodRaysCpu([0, -5, 0], BASIS, frontMap, 50, 0.05)).toBe(0);
    expect(shadowVisibilityGodRaysCpu([0, -1, 0], BASIS, frontMap, 50, 0.05)).toBe(1);
    // 严格边界(二进制精确):w = 1.75 = w_f + 0.25 → stored(1.5) >= 1.75 - 0.25 恰好成立 → lit。
    expect(shadowVisibilityGodRaysCpu([0, -1.75, 0], BASIS, frontMap, 50, 0.25)).toBe(1);
    expect(shadowVisibilityGodRaysCpu([0, -2, 0], BASIS, frontMap, 50, 0.25)).toBe(0);
  });
  it("agrees with the analytic occlusion decision at every swept sample (量化对齐锁)", () => {
    const behindMap = rasterizeGodRaysShadowMap(BASIS, [BOX_BEHIND], RASTER_OPTIONS);
    for (const [occluder, map] of [[BOX_FRONT, frontMap], [BOX_BEHIND, behindMap]] as const) {
      for (const slope of [0.55, -0.55]) { // 上升/下降两条采样线,各自穿越对应遮挡盒
        for (let i = 0; i <= 220; i += 1) {
          const t = 0.05 + i * 0.05;
          const point: [number, number, number] = [0.01 * t, slope * t, -0.1 * t];
          const mapped = shadowVisibilityGodRaysCpu(point, BASIS, map, 50, 0.25);
          const analytic = analyticGodRaysShadow(BASIS, [occluder], point, 0.25);
          expect(mapped).toBe(analytic);
        }
      }
    }
  });
});

describe("mirror march is bit-identical to the analytic reference (texel-exact scenes)", () => {
  it("descending ray through a classic (w > 0) occluder box", () => {
    const scene = uniformScene(8, 8, 10);
    const map = rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS);
    const ray = pixelRay(8, 8, 3, 2, OPTIONS.verticalFovRadians); // dirY < 0,采样降至 y ≈ -2.2,穿越盒 y ∈ [-2.5, -1.5]
    const marchDistance = ray.geometricDistance(10);
    const mirrored = marchVolumetricGodRaysPassCpu(scene, OPTIONS, BASIS, map, 3, 2);
    const reference = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, BASIS, [BOX_FRONT],
      OPTIONS.shadowBias, { rayDirection: ray.rayUnit, marchDistance, stepCount: OPTIONS.steps });
    // 传入未归一化 rayUnit:镜像与参考各自以同一 Math.hypot 归一 → 全程逐位一致。
    expect(mirrored[0]).toBe(reference.inscatter[0]);
    expect(mirrored[1]).toBe(reference.inscatter[1]);
    expect(mirrored[2]).toBe(reference.inscatter[2]);
    expect(mirrored[3]).toBe(reference.transmittance);
    // 该射线确实穿越阴影体(阴影判定既有 0 又有 1,否则对拍退化为平凡)。
    const decisions = new Set<number>();
    for (let step = 0; step < OPTIONS.steps; step += 1) {
      const t = (step + 0.5) * (marchDistance / OPTIONS.steps);
      decisions.add(shadowVisibilityGodRaysCpu(
        [ray.direction[0] * t, ray.direction[1] * t, ray.direction[2] * t], BASIS, map, 50, OPTIONS.shadowBias));
    }
    expect([...decisions].sort()).toEqual([0, 1]);
  });
  it("ascending ray through a behind-camera (w < 0) occluder box — 光栅化起点后移修复回归锁", () => {
    // 修复前:相机后方遮挡体对 w=0 起投的阴影图不可见(全 FAR → 恒 lit),与解析参考无界分歧。
    const scene = uniformScene(8, 8, 10);
    const map = rasterizeGodRaysShadowMap(BASIS, [BOX_BEHIND], RASTER_OPTIONS);
    expect(map.depth.every((d) => d === -2.25)).toBe(true); // 全图存朝光面绝对 w = -2.25
    const ray = pixelRay(8, 8, 3, 0, OPTIONS.verticalFovRadians); // dirY > 0,采样升至 y ≈ 3.6,穿越盒 y ∈ [1.25, 2.25]
    const marchDistance = ray.geometricDistance(10);
    const mirrored = marchVolumetricGodRaysPassCpu(scene, OPTIONS, BASIS, map, 3, 0);
    const reference = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, BASIS, [BOX_BEHIND],
      OPTIONS.shadowBias, { rayDirection: ray.rayUnit, marchDistance, stepCount: OPTIONS.steps });
    expect(mirrored[0]).toBe(reference.inscatter[0]);
    expect(mirrored[1]).toBe(reference.inscatter[1]);
    expect(mirrored[2]).toBe(reference.inscatter[2]);
    expect(mirrored[3]).toBe(reference.transmittance);
    const decisions = new Set<number>();
    for (let step = 0; step < OPTIONS.steps; step += 1) {
      const t = (step + 0.5) * (marchDistance / OPTIONS.steps);
      decisions.add(shadowVisibilityGodRaysCpu(
        [ray.direction[0] * t, ray.direction[1] * t, ray.direction[2] * t], BASIS, map, 50, OPTIONS.shadowBias));
    }
    expect([...decisions].sort()).toEqual([0, 1]);
  });
  it("sky pixel takes the maxDistance branch and stays bit-identical to the reference", () => {
    const skyScene = { width: 8, height: 8, depth: new Array<number>(64).fill(0) };
    const emptyMap = rasterizeGodRaysShadowMap(BASIS, [], RASTER_OPTIONS);
    const ray = pixelRay(8, 8, 0, 0, OPTIONS.verticalFovRadians);
    const mirrored = marchVolumetricGodRaysPassCpu(skyScene, OPTIONS, BASIS, emptyMap, 0, 0);
    const reference = rayMarchVolumetricGodRaysReference(MEDIUM, AXIS_LIGHT, 1, BASIS, [],
      OPTIONS.shadowBias, { rayDirection: ray.rayUnit, marchDistance: OPTIONS.maxDistance, stepCount: OPTIONS.steps });
    expect(mirrored[0]).toBe(reference.inscatter[0]);
    expect(mirrored[3]).toBe(reference.transmittance);
    // 同一像素的几何分支步进 10·rayLength ≈ 11.2,远短于天空分支 maxDistance = 120 → 透过率更高。
    const geometry = marchVolumetricGodRaysPassCpu(uniformScene(8, 8, 10), OPTIONS, BASIS, emptyMap, 0, 0);
    expect(mirrored[3]).toBeLessThan(geometry[3]);
  });
  it("henyeyGreensteinPhase matches an independently written evaluation", () => {
    const expected = (1 - 0.09) / (4 * Math.PI * Math.pow(0.79, 1.5)); // g=0.3, cosθ=0.5
    expect(henyeyGreensteinPhase(0.5, 0.3)).toBeCloseTo(expected, 12);
  });
});

describe("volumetricGodRaysPassCpu (整帧镜像)", () => {
  it("produces ceil-half dimensions with a stride-4 rgba plane and finite values", () => {
    const result = volumetricGodRaysPassCpu(uniformScene(8, 8, 10), OPTIONS, BASIS,
      rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS));
    expect(result.width).toBe(4);
    expect(result.height).toBe(4);
    expect(result.scatter).toHaveLength(64);
    for (const value of result.scatter) expect(Number.isFinite(value)).toBe(true);
    const odd = volumetricGodRaysPassCpu(uniformScene(9, 5, 10), OPTIONS, BASIS,
      rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS));
    expect(odd.width).toBe(5);
    expect(odd.height).toBe(3);
    expect(odd.scatter).toHaveLength(60);
  });
  it("validates options fail-closed before marching (密度负/步数越界端到端)", () => {
    const map = rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS);
    expect(() => volumetricGodRaysPassCpu(uniformScene(8, 8, 10),
      { ...OPTIONS, steps: GOD_RAYS_STEPS_MIN - 1 }, BASIS, map)).toThrow(/steps/);
    expect(() => volumetricGodRaysPassCpu(uniformScene(8, 8, 10),
      { ...OPTIONS, medium: { ...MEDIUM, baseExtinction: -0.01 } }, BASIS, map)).toThrow(/baseExtinction/);
  });
  it("sky columns march farther than geometry: lower transmittance, stronger inscatter", () => {
    const width = 8, height = 8;
    const depth = new Array<number>(width * height).fill(10);
    for (let y = 0; y < height; y += 1) { depth[y * width + 0] = 0; depth[y * width + 1] = 0; }
    const result = volumetricGodRaysPassCpu({ width, height, depth }, OPTIONS, BASIS,
      rasterizeGodRaysShadowMap(BASIS, [], RASTER_OPTIONS));
    const at = (halfX: number, halfY: number): readonly number[] => {
      const base = (halfY * result.width + halfX) * 4;
      return [...result.scatter.slice(base, base + 4)];
    };
    const sky = at(0, 1), solid = at(3, 1);
    expect(sky[3]).toBeLessThan(solid[3]);
    expect(sky[0]).toBeGreaterThan(solid[0]);
  });
  it("strength doubles inscatter and leaves transmittance untouched", () => {
    const map = rasterizeGodRaysShadowMap(BASIS, [BOX_FRONT], RASTER_OPTIONS);
    const one = volumetricGodRaysPassCpu(uniformScene(8, 8, 10), OPTIONS, BASIS, map);
    const two = volumetricGodRaysPassCpu(uniformScene(8, 8, 10), { ...OPTIONS, strength: 2 }, BASIS, map);
    expect(two.scatter[0]).toBeCloseTo(one.scatter[0] * 2, 7);
    expect(two.scatter[3]).toBe(one.scatter[3]);
  });
});
