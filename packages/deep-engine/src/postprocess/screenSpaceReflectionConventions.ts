/**
 * SSR 约定核验（T03 整包化切片）：把 trace/composite WGSL 与 CPU 镜像的约定变成
 * 可机器核验的清单。静态部分对生产 WGSL 字符串做逐条正则断言（公式签名级，不是
 * 存在性检查）；数值部分对 CPU 镜像做投影往返/反射对称/参数块 packing 核验。
 * 任何一侧漂移（含历史回归）都会在测试中显式失败。
 */

import { SSR_COMPOSITE_WGSL, SSR_RADIANCE_DOWNSAMPLE_WGSL, SSR_TRACE_WGSL } from "./screenSpaceReflectionWgsl.js";
import { packParameters, radianceMipLevels } from "./screenSpaceReflection.js";
import { projectToUv, reconstructPosition, reflectViewRay, screenSpaceReflectionEdgeFade,
  sampleScreenSpaceReflectionRoughRadianceCpu } from "./screenSpaceReflectionCpu.js";
import type { ScreenSpaceReflectionOptions } from "./screenSpaceReflectionTypes.js";

export interface SsrConventionCheck {
  readonly id: string;
  readonly description: string;
  readonly passed: boolean;
  /** 静态核验时的期望公式签名；数值核验为空。 */
  readonly expected?: string;
}

const CHECKS: readonly { id: string; description: string; source: "trace" | "composite" | "radiance";
  pattern: RegExp }[] = [
  { id: "origin-guard", description: "命中起点要求正线性视空间深度（深度 0/负值直接 miss，杜绝标准/反转 Z 歧义）",
    source: "trace", pattern: /if \(!\(centerDepth > 0\.0\)\) \{ textureStore\(traceTarget, vec2<i32>\(id\.xy\), vec4f\(0\.0\)\); return; \}/u },
  { id: "depth-reconstruct", description: "深度重建与 AO 视空间合同同源（ndc×depth×tanHalf×aspect，y 翻转）",
    source: "trace", pattern: /ndc\.x \* depth \* ssrParams\.projection\.x \* ssrParams\.projection\.y,\s*\n\s*ndc\.y \* depth \* ssrParams\.projection\.x, -depth/u },
  { id: "normal-view-decode", description: "法线为视空间 unorm 编码 (v+1)/2，解码 ×2−1 后归一化",
    source: "trace", pattern: /return ssrSafeNormal\(textureLoad\(sourceNormal, vec2<i32>\(coordinate\), 0\)\.xyz \* 2\.0 - 1\.0\);/u },
  { id: "roughness-alpha", description: "粗糙度取视空间法线纹理 alpha 通道并 clamp 到 [0,1]",
    source: "trace", pattern: /return clamp\(textureLoad\(sourceNormal, vec2<i32>\(coordinate\), 0\)\.w, 0\.0, 1\.0\);/u },
  { id: "roughness-cone-mip", description: "粗糙度→mip：lod = roughness² × (activeMipLevels−1)，有界锥预滤波",
    source: "trace", pattern: /let lod = roughness \* roughness \* ssrParams\.misc\.z;/u },
  { id: "thickness-band", description: "厚度带判定：surfaceDepth < rayDepth 且深度差 < thickness 才算候选命中",
    source: "trace", pattern: /if \(surfaceDepth < rayDepth && rayDepth - surfaceDepth < ssrParams\.projection\.w\) \{/u },
  { id: "refine-hole-guard", description: "二分细化遇深度空洞（≤0）不推进上界（2026-09-27 深度空洞修复）",
    source: "trace", pattern: /if \(refinedDepth > 0\.0 && refinedDepth < -middle\.z\) \{ highDistance = middleDistance; \}/u },
  { id: "final-pixel-guard", description: "细化终点像素必须仍有有效深度，否则拒绝该候选",
    source: "trace", pattern: /if \(!\(textureLoad\(sourceDepth, vec2<i32>\(finalPixel\), 0\)\.x > 0\.0\)\) \{ continue; \}/u },
  { id: "backface-early-out", description: "反射朝相机平面之后（reflected.z ≥ 0）直接 miss",
    source: "trace", pattern: /if \(reflected\.z >= 0\.0\) \{ textureStore\(traceTarget, vec2<i32>\(id\.xy\), vec4f\(0\.0\)\); return; \}/u },
  { id: "ray-depth-guard", description: "反射射线穿过相机平面（rayDepth ≤ 0）终止步进",
    source: "trace", pattern: /if \(rayDepth <= 0\.0\) \{ break; \}/u },
  { id: "march-screen-bounds", description: "步进投影出屏立即终止（离屏族边界）",
    source: "trace", pattern: /if \(uv\.x < 0\.0 \|\| uv\.x > 1\.0 \|\| uv\.y < 0\.0 \|\| uv\.y > 1\.0\) \{ break; \}/u },
  { id: "edge-fade-clamp", description: "屏边衰减 t 两端 clamp [0,1]（与 CPU 镜像一致，负 t 不得放大 mask）",
    source: "trace", pattern: /let t = clamp\(min\(min\(\(1\.0 - uv\.x\) \/ fade, uv\.x \/ fade\), min\(\(1\.0 - uv\.y\) \/ fade, uv\.y \/ fade\)\), 0\.0, 1\.0\);/u },
  { id: "fresnel-schlick", description: "Fresnel-Schlick：cosθ = clamp(−dot(N, incident), 0, 1)，5 次幂",
    source: "trace", pattern: /let cosTheta = clamp\(-dot\(normal, incident\), 0\.0, 1\.0\);\s*\n\s*let fresnel = ssrParams\.misc\.y \+ \(1\.0 - ssrParams\.misc\.y\) \* pow\(1\.0 - cosTheta, 5\.0\);/u },
  { id: "composite-replace", description: "composite 替换语义：output = base×(1−mask) + trace.rgb（不叠加两次能量）",
    source: "composite", pattern: /textureStore\(compositeTarget, vec2<i32>\(id\.xy\), vec4f\(color \* \(1\.0 - reflection\.a\) \+ reflection\.rgb, 1\.0\)\);/u },
  { id: "composite-bilinear-upsample", description: "半分辨率 trace 经双线性上采样并入全分辨率输出",
    source: "composite", pattern: /let reflection = textureSampleLevel\(sourceTrace, ssrSampler, uv, 0\.0\);/u },
  { id: "radiance-box-downsample", description: "辐射层级 2×2 均值盒式下采样（0.25 权重，能量守恒）",
    source: "radiance", pattern: /textureStore\(radianceTarget, vec2<i32>\(id\.xy\), radiance \* 0\.25\);/u },
];

const ABSENCE_CHECKS: readonly { id: string; description: string; pattern: RegExp }[] = [
  { id: "no-temporal-history", description: "T07 边界：SSR 内核不得采样时域历史/上一帧缓冲",
    pattern: /history|previousFrame|prevColor|temporal/u },
  { id: "no-fullscreen-blur", description: "禁止全屏模糊掩盖错误（验收红线）：内核不得含 gaussian/blur 令牌",
    pattern: /gaussian|blur|blurRadius/u },
];

/** 对生产 WGSL 做静态约定核验；任何一条失败都表示 WGSL 漂移出既定合同。 */
export function verifySsrWgslConventions(): readonly SsrConventionCheck[] {
  const results: SsrConventionCheck[] = [];
  for (const check of CHECKS) {
    const code = check.source === "trace" ? SSR_TRACE_WGSL
      : check.source === "composite" ? SSR_COMPOSITE_WGSL : SSR_RADIANCE_DOWNSAMPLE_WGSL;
    results.push({ id: check.id, description: check.description, passed: check.pattern.test(code),
      expected: check.pattern.source });
  }
  for (const check of ABSENCE_CHECKS) {
    results.push({ id: check.id, description: check.description,
      passed: !(check.pattern.test(SSR_TRACE_WGSL) || check.pattern.test(SSR_COMPOSITE_WGSL)) });
  }
  return results;
}

const FLOATS_PER_PIXEL_ROUNDTRIP_TOLERANCE = 1e-6;

/**
 * CPU 数值约定核验：投影/重建往返、反射对称性、edgeFade 有界性、粗糙度 lod 与
 * 参数块 misc.z 一致、packParameters 布局。全部通过返回空数组。
 */
export function verifySsrCpuConventions(options: ScreenSpaceReflectionOptions,
  sourceWidth: number, sourceHeight: number): readonly SsrConventionCheck[] {
  const failures: SsrConventionCheck[] = [];
  const tanHalfFov = Math.tan(options.verticalFovRadians * 0.5);
  const aspect = sourceWidth / sourceHeight;
  // 1. 重建→投影往返必须回到像素中心。
  let roundtrip = true;
  for (const [x, y, depth] of [[0, 0, 5], [sourceWidth - 1, sourceHeight - 1, 2.5], [7, 3, 20]] as const) {
    const position = reconstructPosition({ width: sourceWidth, height: sourceHeight, depth: [], normals: [],
      color: [] }, x, y, depth, tanHalfFov, aspect);
    const [uvX, uvY] = projectToUv(position, tanHalfFov, aspect);
    if (Math.abs(uvX * sourceWidth - (x + 0.5)) > FLOATS_PER_PIXEL_ROUNDTRIP_TOLERANCE
      || Math.abs(uvY * sourceHeight - (y + 0.5)) > FLOATS_PER_PIXEL_ROUNDTRIP_TOLERANCE) roundtrip = false;
  }
  failures.push({ id: "cpu-project-roundtrip", description: "CPU 重建→投影往返回到像素中心", passed: roundtrip });
  // 2. 反射方向与入射关于法线镜像对称且模长守恒。
  let mirror = true;
  const origin: readonly [number, number, number] = [3, -2, -9];
  const centerDepth = 9;
  const rawIncident = [origin[0] / centerDepth, origin[1] / centerDepth, origin[2] / centerDepth];
  const incidentLength = Math.hypot(rawIncident[0]!, rawIncident[1]!, rawIncident[2]!);
  const incident = rawIncident.map(value => value / incidentLength);
  const normals: readonly (readonly [number, number, number])[] =
    [[0, 1, 0], [0, -0.4472136, 0.8944272], [0.6, 0, 0.8]];
  for (const [nx0, ny0, nz0] of normals) {
    const [, , , rx, ry, rz] = reflectViewRay(origin, centerDepth, nx0, ny0, nz0);
    const dot = nx0 * incident[0]! + ny0 * incident[1]! + nz0 * incident[2]!;
    const expected = [0, 1, 2].map(axis => incident[axis]! - 2 * dot * [nx0, ny0, nz0][axis]!);
    if (Math.abs(rx - expected[0]!) > 1e-6 || Math.abs(ry - expected[1]!) > 1e-6
      || Math.abs(rz - expected[2]!) > 1e-6) mirror = false;
    if (Math.abs(Math.hypot(rx, ry, rz) - 1) > 1e-6) mirror = false;
  }
  failures.push({ id: "cpu-reflect-mirror", description: "CPU 反射方向关于法线镜像对称且为单位向量", passed: mirror });
  // 3. edgeFade 对任意 uv（含出界）有界 [0,1]。
  let fadeBounded = true;
  for (const [uvX, uvY] of [[-0.5, 0.5], [1.5, 0.5], [0.5, -0.001], [0.999, 1.001], [0.5, 0.5]] as const) {
    const fade = screenSpaceReflectionEdgeFade(uvX, uvY, 0.08);
    if (!(fade >= 0 && fade <= 1 && Number.isFinite(fade))) fadeBounded = false;
  }
  if (screenSpaceReflectionEdgeFade(-0.001, 0.5, 0.08) !== 0) fadeBounded = false;
  failures.push({ id: "cpu-edge-fade-bounded", description: "CPU edgeFade 对出界 uv 收敛到 0（同族修复回归）",
    passed: fadeBounded });
  // 4. 粗糙度 lod 与 packParameters misc.z 逐配置一致（coneMipLevels 漂移回归）。
  let lodParity = true;
  const scene = { width: 64, height: 64, depth: [], normals: [],
    color: Array.from({ length: 64 * 64 * 3 }, (_, index) => {
      const pixel = Math.floor(index / 3);
      return pixel === 32 * 64 + 32 ? 1 : 0.1; // 中心亮点：不同 mip 顶档均值必然不同。
    }) };
  let previousTop = -1;
  for (const coneMipLevels of [undefined, 2, 3, 6] as const) {
    // 与 validateRequest 同式：activeMipLevels = min(coneMipLevels ?? 6, radianceMipLevels(w,h))。
    const activeMipLevels = Math.min(coneMipLevels ?? 6, radianceMipLevels(sourceWidth, sourceHeight));
    const request = { sourceWidth, sourceHeight, traceWidth: Math.ceil(sourceWidth / 2),
      traceHeight: Math.ceil(sourceHeight / 2), activeRadianceMipLevels: activeMipLevels };
    const gpuMaxLod = new Float32Array(packParameters(request, coneMipLevels === undefined
      ? options : { ...options, coneMipLevels }))[14]!;
    const maxMip = Math.min((coneMipLevels ?? 6) - 1, Math.floor(Math.log2(64)));
    // roughness=0 → lod 0（mip0 背景原值）；roughness=1 → lod = gpuMaxLod（顶档均值）。
    const smooth = sampleScreenSpaceReflectionRoughRadianceCpu(scene, 0.2, 0.5, 0, coneMipLevels);
    const top = sampleScreenSpaceReflectionRoughRadianceCpu(scene, 0.5, 0.5, 1, coneMipLevels);
    if (!(Math.abs(smooth[0]! - 0.1) < 1e-6) || gpuMaxLod !== maxMip) lodParity = false;
    // coneMipLevels 收紧必须真的改变顶档采样（顶档均值与前档相同则校验无区分度）。
    if (top[0] === previousTop) lodParity = false;
    previousTop = top[0];
  }
  failures.push({ id: "cpu-gpu-lod-parity", description: "CPU 粗糙度锥 lod 与 packParameters misc.z 逐配置一致",
    passed: lodParity });
  // 5. 参数块布局冻结：misc.z 位于 float 偏移 14（offset 56）。
  const layoutRequest = { sourceWidth, sourceHeight, traceWidth: Math.ceil(sourceWidth / 2),
    traceHeight: Math.ceil(sourceHeight / 2), activeRadianceMipLevels: radianceMipLevels(sourceWidth, sourceHeight) };
  const packed = new Float32Array(packParameters(layoutRequest, options));
  failures.push({ id: "param-block-layout", description: "参数块 misc.z = activeMipLevels−1 位于 float[14]",
    passed: packed[14] === layoutRequest.activeRadianceMipLevels - 1 });
  return failures.filter(check => !check.passed);
}
