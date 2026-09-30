/** I 级 C23 分层材质混合核(唯一真源;TS 镜像与 .sha256 夹具由 wgsl:sync 生成)。
 * 与 CPU 参考 materialLayeredEvaluate 逐公式镜像(f32 语义)。两种模式同为凸混合,
 * 权重 w 只由层总响应 layerRgb 派生并共享给 rgb 与全部 lobe(分量分解不被破坏):
 * - replace: w = coverage;                          —— 无条件遮蔽替换;
 * - overlay: w = coverage*clamp01(layerRgb);        —— 自遮蔽叠加:层响应弱则底材
 *   全保留,层响应饱和(L_rgb≥1)收敛于 replace(同式同序,逐位一致)。
 * 纯函数库:不定义着色入口(entry point 由宿主管线提供);层求值复用既有
 * deepEvaluateExtendedMaterial(T08),本核只做求值响应级(rgb/lobe 逐通道)混合。
 * 所有符号带 deepLayer 前缀,与 surfaceLowering 的 deep* 主干及 deepMaterial* 求值核隔离。 */

const DEEP_LAYER_BLEND_MODE_REPLACE: u32 = 0u;
const DEEP_LAYER_BLEND_MODE_OVERLAY: u32 = 1u;
const DEEP_LAYER_MAX_COUNT: u32 = 2u;
const DEEP_LAYER_SLOT_FLOAT_COUNT: u32 = 8u;
const DEEP_LAYERED_BLOCK_FLOAT_COUNT: u32 = 22u;

fn deepLayerBlendReplace(underlying: vec3f, layer: vec3f, coverage: f32) -> vec3f {
  let weightLayer = coverage;
  return (1.0 - weightLayer) * underlying + weightLayer * layer;
}

fn deepLayerBlendOverlay(underlying: vec3f, layer: vec3f, layerRgb: vec3f, coverage: f32) -> vec3f {
  let weightLayer = coverage * clamp(layerRgb, vec3f(0.0), vec3f(1.0));
  return (1.0 - weightLayer) * underlying + weightLayer * layer;
}

fn deepLayerBlend(underlying: vec3f, layer: vec3f, layerRgb: vec3f, coverage: f32, mode: u32) -> vec3f {
  return select(deepLayerBlendOverlay(underlying, layer, layerRgb, coverage),
    deepLayerBlendReplace(underlying, layer, coverage),
    mode == DEEP_LAYER_BLEND_MODE_REPLACE);
}
