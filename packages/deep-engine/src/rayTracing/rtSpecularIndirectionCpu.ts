import { ssrBrdfSpecularFractionCpu } from "../postprocess/ssrBrdfFraction.js";
import { RT_SPECULAR_BOUNCE_ALBEDO } from "./rtSpecularIndirectionKernel.js";

/**
 * RT specular GI CPU 镜像(与 rtSpecularIndirectionKernel/rtSpecularFillKernel 的 WGSL
 * 同式同序;真机门 scripts/rtSpecularGiGpuTest.mjs 的仲裁单源)。SSR 家族惯例:GPU
 * 不得与 CPU 镜像静默漂移。
 *
 * 高光分数单源 = postprocess/ssrBrdfSpecularFractionCpu(与 SSR trace 消费的同一
 * split-sum DFG);WGSL 侧经同一 brdfLut 纹理采样,数值差即 LUT 量化差,真机门以
 * 相对容差吸收(非语义分叉)。
 */

export interface RtSpecularIndirectionCpuParams {
  readonly tanHalfFov: number;
  readonly aspect: number;
  readonly surfaceToLightWorld: readonly [number, number, number];
  readonly lightColor: readonly [number, number, number];
  readonly lightIntensity: number;
  readonly envRadiance: readonly [number, number, number];
  readonly fresnelF0: number;
}

/**
 * 命中点光照遮蔽记录(与 closest-hit 帧通道 illumination 档的 bounceShading 纹理
 * 同语义):albedo = 命中实例材质反照率(执行器无表供给时预填中性
 * RT_SPECULAR_BOUNCE_ALBEDO),visibility = 命中点→光源 trace 可见性(0=遮挡/溢出
 * fail-closed,1=可见)。
 */
export interface RtSpecularBounceShading {
  readonly albedo: readonly [number, number, number];
  readonly visibility: number;
}

/** 基线遮蔽记录(未供遮蔽腿时的旧语义:visibility=1 + 中性反照率)。 */
export const RT_SPECULAR_NEUTRAL_SHADING: RtSpecularBounceShading = {
  albedo: [RT_SPECULAR_BOUNCE_ALBEDO, RT_SPECULAR_BOUNCE_ALBEDO, RT_SPECULAR_BOUNCE_ALBEDO],
  visibility: 1,
};

/** 与 SSR trace reconstructPosition 同式的线性视深度重建(单源合同,禁本地漂移)。 */
export function rtSpecularReconstructViewPosition(x: number, y: number, width: number, height: number,
  linearDepth: number, tanHalfFov: number, aspect: number): readonly [number, number, number] {
  const uvX = (x + 0.5) / width;
  const uvY = (y + 0.5) / height;
  const ndcX = uvX * 2 - 1;
  const ndcY = 1 - uvY * 2;
  return [ndcX * linearDepth * tanHalfFov * aspect, ndcY * linearDepth * tanHalfFov, -linearDepth];
}

/**
 * 一次反弹 indirection 记录(单像素):命中记录 [t, normal.xyz](miss t<=0 → 全零)、
 * 遮蔽记录 [albedo.rgb, visibility](缺省 = 旧基线 visibility=1 + 中性反照率)、
 * GBuffer 视法线 [x,y,z]∈[-1,1] 与 roughness∈[0,1]、线性视深度 →
 * [radiance×fraction(r,g,b), fraction]。与 WGSL 同式:直接光项乘可见性后加环境项,
 * 逐通道乘 clamp 后反照率,再统一乘高光分数(预乘,合成端直接换手)。
 */
export function rtSpecularIndirectionRecordCpu(record: readonly [number, number, number, number],
  viewNormal: readonly [number, number, number], roughness: number, linearDepth: number,
  pixelX: number, pixelY: number, width: number, height: number,
  params: RtSpecularIndirectionCpuParams,
  shading: RtSpecularBounceShading = RT_SPECULAR_NEUTRAL_SHADING): readonly [number, number, number, number] {
  if (!(record[0]! > 0) || !(linearDepth > 0)) return [0, 0, 0, 0];
  // 与 WGSL rtSpecSafeNormal 同式:解码后归一化(长度退化回退 +z,fail-closed 同侧)。
  const normalLength = Math.hypot(viewNormal[0], viewNormal[1], viewNormal[2]);
  const safeNormal: readonly [number, number, number] = normalLength > 0.00000001
    ? [viewNormal[0]! / normalLength, viewNormal[1]! / normalLength, viewNormal[2]! / normalLength]
    : [0, 0, 1];
  const viewPos = rtSpecularReconstructViewPosition(pixelX, pixelY, width, height, linearDepth,
    params.tanHalfFov, params.aspect);
  const incidentScale = 1 / Math.max(linearDepth, 1e-20);
  const incidentX = viewPos[0]! * incidentScale, incidentY = viewPos[1]! * incidentScale;
  const incidentZ = viewPos[2]! * incidentScale;
  const incidentLength = Math.hypot(incidentX, incidentY, incidentZ);
  if (!(incidentLength > 0)) return [0, 0, 0, 0];
  const cosTheta = Math.min(1, Math.max(0,
    -(safeNormal[0]! * incidentX + safeNormal[1]! * incidentY + safeNormal[2]! * incidentZ) / incidentLength));
  const clampedRoughness = Math.min(1, Math.max(0, roughness));
  const ndotl = Math.min(1, Math.max(0,
    record[1]! * params.surfaceToLightWorld[0]! + record[2]! * params.surfaceToLightWorld[1]!
      + record[3]! * params.surfaceToLightWorld[2]!));
  // 与 WGSL 同序:直接光乘可见性 → +环境 → 逐通道乘 clamp 反照率,再乘高光分数。
  const albedo = [
    Math.min(1, Math.max(0, shading.albedo[0]!)),
    Math.min(1, Math.max(0, shading.albedo[1]!)),
    Math.min(1, Math.max(0, shading.albedo[2]!)),
  ];
  const visibility = Math.min(1, Math.max(0, shading.visibility));
  const directR = ndotl * params.lightColor[0]! * params.lightIntensity * visibility;
  const directG = ndotl * params.lightColor[1]! * params.lightIntensity * visibility;
  const directB = ndotl * params.lightColor[2]! * params.lightIntensity * visibility;
  const oneBounceR = (directR + params.envRadiance[0]!) * albedo[0]!;
  const oneBounceG = (directG + params.envRadiance[1]!) * albedo[1]!;
  const oneBounceB = (directB + params.envRadiance[2]!) * albedo[2]!;
  const fraction = ssrBrdfSpecularFractionCpu(cosTheta, clampedRoughness, params.fresnelF0);
  return [oneBounceR * fraction, oneBounceG * fraction, oneBounceB * fraction, fraction];
}

/**
 * 屏外填充合成(单像素):SSR trace 屏内 mask(双线性采样值)> 0 = SSR 优先透传;
 * 否则 RT indirection a>0 时按 SSR composite 同式 `out×(1-α)+rgb` 替换。双方皆 miss
 * 时返回值与 out 全等(a=0 → ×1+0)。
 */
export function rtSpecularFillCompositeCpu(outRgb: readonly [number, number, number], traceAlpha: number,
  rtRecord: readonly [number, number, number, number]): readonly [number, number, number] {
  const useRt = traceAlpha <= 0 && rtRecord[3]! > 0;
  if (!useRt) return outRgb;
  const alpha = rtRecord[3]!;
  return [outRgb[0]! * (1 - alpha) + rtRecord[0]!, outRgb[1]! * (1 - alpha) + rtRecord[1]!,
    outRgb[2]! * (1 - alpha) + rtRecord[2]!];
}
