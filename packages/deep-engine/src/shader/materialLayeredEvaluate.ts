/** I 级 C23 分层材质首刀 · CPU 分层混合闭式参考(GPU 混合核的黄金对照)。
 * 层栈 = base + ≤2 层;每层用既有 evaluateExtendedMaterialDirect 以**同一表面/几何/光照**
 * 独立求值,再在求值响应级(rgb + 四 lobe)按覆盖率与混合语义混合。
 * 闭式(逐通道;底材响应 U,层响应 L,层总响应 L_rgb,覆盖率 c):
 * - replace: w = c;                     out = (1−w)·U + w·L   —— 无条件遮蔽替换;
 * - overlay: w = c·clamp01(L_rgb);      out = (1−w)·U + w·L   —— 自遮蔽叠加。
 * 结构合同(两条都由闭式逐字保证):
 * - 权重 w 只由**层 rgb** 派生,同一 w 施加于 rgb 与全部四 lobe ⇒ 四 lobe 之和恒等 rgb
 *   (混合是同一线性映射,不破坏分量分解);
 * - 两种模式都是凸混合(逐通道权重和恒 1)⇒ 每格输出 ≤ max(双亲),半球反射率不增,
 *   白炉口径 ≤1 由双亲(既有 T08 已证 ≤1+1e-3)直接继承;
 * - overlay 语义:层响应弱(L_rgb→0)有效权重→0,底材全保留;层响应饱和(L_rgb≥1)
 *   w=c,与 replace 同式同序 ⇒ 逐位收敛;响应弱的层按自身份额自遮蔽渗透。
 * 确定性与退化合同:
 * - 运算序固定(先 w,后乘加),同输入双跑逐位一致;层应用序 = 数组序;
 * - layers 为空 → 原样返回 base 结果(与既有单层路径逐位一致);
 * - coverage=0 的层剪枝(不产生任何浮点扰动,后续层逐位不变)。
 * WGSL 镜像:wgsl/materialLayerBlend.wgsl(单源,checksum 门对拍)。 */

import {
  normalizeLayeredMaterialParameters,
  type LayeredMaterialOverrides,
  type MaterialLayerBlendMode,
} from "./materialLayeredParameters.js";
import {
  evaluateExtendedMaterialDirect,
  STOCK_DIRECT_RADIANCE,
  type MaterialEvaluationComponents,
  type MaterialEvaluationGeometry,
  type MaterialEvaluationResult,
  type StandardSurfaceInputs,
  type Vec3,
} from "./materialEvaluate.js";

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** 逐通道混合权重:replace = 覆盖率;overlay = 覆盖率×层总响应饱和(自遮蔽)。
 * 权重只由层 rgb 派生并共享给全部 lobe,保证分量分解在混合后依旧精确。 */
function layerWeights(layerRgb: Vec3, coverage: number, mode: MaterialLayerBlendMode): Vec3 {
  if (mode === "replace") return [coverage, coverage, coverage];
  return [coverage * clamp01(layerRgb[0]!), coverage * clamp01(layerRgb[1]!),
    coverage * clamp01(layerRgb[2]!)];
}

function blendVec3(underlying: Vec3, layer: Vec3, weights: Vec3): Vec3 {
  return [(1 - weights[0]!) * underlying[0]! + weights[0]! * layer[0]!,
    (1 - weights[1]!) * underlying[1]! + weights[1]! * layer[1]!,
    (1 - weights[2]!) * underlying[2]! + weights[2]! * layer[2]!];
}

function blendComponents(
  underlying: MaterialEvaluationComponents, layer: MaterialEvaluationComponents, weights: Vec3,
): MaterialEvaluationComponents {
  return {
    diffuse: blendVec3(underlying.diffuse, layer.diffuse, weights),
    specular: blendVec3(underlying.specular, layer.specular, weights),
    clearcoat: blendVec3(underlying.clearcoat, layer.clearcoat, weights),
    transmission: blendVec3(underlying.transmission, layer.transmission, weights),
  };
}

/** 分层直接光照求值参考。参数 fail-closed(normalizeLayeredMaterialParameters);
 * 向量归一化/夹取语义与单层路径完全一致(层与 base 用同一求值核)。 */
export function evaluateLayeredMaterialDirect(
  surface: StandardSurfaceInputs,
  layered: LayeredMaterialOverrides,
  geometry: MaterialEvaluationGeometry,
  radiance: Vec3 = STOCK_DIRECT_RADIANCE,
): MaterialEvaluationResult {
  const params = normalizeLayeredMaterialParameters(layered);
  let result = evaluateExtendedMaterialDirect(surface, params.base, geometry, radiance);
  for (const layer of params.layers) {
    if (layer.coverage === 0) continue; // 剪枝合同:零覆盖层不产生任何浮点扰动。
    const layerResult = evaluateExtendedMaterialDirect(surface, layer.params, geometry, radiance);
    const weights = layerWeights(layerResult.rgb, layer.coverage, layer.mode);
    result = {
      rgb: blendVec3(result.rgb, layerResult.rgb, weights),
      components: blendComponents(result.components, layerResult.components, weights),
    };
  }
  return { rgb: Object.freeze(result.rgb), components: Object.freeze(result.components) };
}
