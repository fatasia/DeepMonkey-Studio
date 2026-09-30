// GENERATED FILE — DO NOT EDIT BY HAND(全文件生成物,手改会在字节门禁处被打回)。
// 唯一真源: wgsl/materialLayerBlend.wgsl(WGSL 单源,TS 与 Rust 双端共享同一份文件)。
// 重新生成: pnpm --filter @bim-studio/deep-engine wgsl:sync
// 字节门禁: src/shader/materialLayerBlendWgslChecksum.test.ts(?raw 读真源 + SHA-256 夹具对拍;无 Rust 半,纯 TS 消费)。

/**
 * I 级 C23 分层材质混合核家族的生成镜像。唯一真源 wgsl/materialLayerBlend.wgsl,
 * 纯 TS 消费(无 Rust 半)。常量与 materialLayeredParameters.ts 互钉;
 * 混合闭式与 CPU 参考 materialLayeredEvaluate.blendChannel 逐运算镜像。
 */

/** 混合语义 GPU 码(replace=0 / overlay=1),与 MATERIAL_LAYER_BLEND_MODE_CODES 互钉。 */
export const DEEP_LAYER_BLEND_MODE_REPLACE = 0;
export const DEEP_LAYER_BLEND_MODE_OVERLAY = 1;
/** 层栈深度上限,与 MATERIAL_LAYER_MAX_COUNT 互钉。 */
export const DEEP_LAYER_MAX_COUNT = 2;
/** 单层槽 f32 数(6 层参数 + coverage + modeCode),与 MATERIAL_LAYER_FLOAT_COUNT 互钉。 */
export const DEEP_LAYER_SLOT_FLOAT_COUNT = 8;
/** 分层块定长 f32 数(base 6 + 2 层槽 ×8),与 LAYERED_MATERIAL_FLOAT_COUNT 互钉。 */
export const DEEP_LAYERED_BLOCK_FLOAT_COUNT = 22;

/** 分层材质求值响应级混合核(真源 wgsl/materialLayerBlend.wgsl)。 */
export const MATERIAL_LAYER_BLEND_WGSL = /* wgsl */ "/** I 级 C23 分层材质混合核(唯一真源;TS 镜像与 .sha256 夹具由 wgsl:sync 生成)。\n * 与 CPU 参考 materialLayeredEvaluate 逐公式镜像(f32 语义)。两种模式同为凸混合,\n * 权重 w 只由层总响应 layerRgb 派生并共享给 rgb 与全部 lobe(分量分解不被破坏):\n * - replace: w = coverage;                          —— 无条件遮蔽替换;\n * - overlay: w = coverage*clamp01(layerRgb);        —— 自遮蔽叠加:层响应弱则底材\n *   全保留,层响应饱和(L_rgb≥1)收敛于 replace(同式同序,逐位一致)。\n * 纯函数库:不定义着色入口(entry point 由宿主管线提供);层求值复用既有\n * deepEvaluateExtendedMaterial(T08),本核只做求值响应级(rgb/lobe 逐通道)混合。\n * 所有符号带 deepLayer 前缀,与 surfaceLowering 的 deep* 主干及 deepMaterial* 求值核隔离。 */\n\nconst DEEP_LAYER_BLEND_MODE_REPLACE: u32 = 0u;\nconst DEEP_LAYER_BLEND_MODE_OVERLAY: u32 = 1u;\nconst DEEP_LAYER_MAX_COUNT: u32 = 2u;\nconst DEEP_LAYER_SLOT_FLOAT_COUNT: u32 = 8u;\nconst DEEP_LAYERED_BLOCK_FLOAT_COUNT: u32 = 22u;\n\nfn deepLayerBlendReplace(underlying: vec3f, layer: vec3f, coverage: f32) -> vec3f {\n  let weightLayer = coverage;\n  return (1.0 - weightLayer) * underlying + weightLayer * layer;\n}\n\nfn deepLayerBlendOverlay(underlying: vec3f, layer: vec3f, layerRgb: vec3f, coverage: f32) -> vec3f {\n  let weightLayer = coverage * clamp(layerRgb, vec3f(0.0), vec3f(1.0));\n  return (1.0 - weightLayer) * underlying + weightLayer * layer;\n}\n\nfn deepLayerBlend(underlying: vec3f, layer: vec3f, layerRgb: vec3f, coverage: f32, mode: u32) -> vec3f {\n  return select(deepLayerBlendOverlay(underlying, layer, layerRgb, coverage),\n    deepLayerBlendReplace(underlying, layer, coverage),\n    mode == DEEP_LAYER_BLEND_MODE_REPLACE);\n}\n";
