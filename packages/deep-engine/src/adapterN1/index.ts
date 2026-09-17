/**
 * P1-23 N1 版本化适配器(TS 侧合同与消费):高价值 SVG 子集 / 富文本 inline /
 * 图表扩展 / 动画 ABI 的版本化输入 → 批量 display delta + 封闭行为命令。
 * 渲染仍在 Native;TS 侧只做合同级解析、认证摘要复算与适配,认证范围之外的
 * 一切输入保持 unknown/blocked。
 */

export {
  ADAPTER_N1_SCHEMA_VERSION,
  DEFAULT_N1_BUDGET,
  N1_INPUT_KINDS,
  SUPPORTED_INPUT_SCHEMA_VERSIONS,
  createN1Certifications,
} from "./types.js";
export type {
  AnimationAbiInput, AnimationKeyframe, AnimationProperty, AnimationTrack, AnimationValue,
  BehaviorScalar, ChartExtensionInput, ChartOverlay, InlineObject, N1Adapted,
  N1BehaviorAction, N1Budget, N1Certification, N1Certifications,
  N1DisplayDelta, N1FontAsset, N1HostAssets, N1InlineAsset, N1InputKind, N1Outcome,
  RichTextAlign, RichTextInlineInput, RichTextParagraph, RichTextStyleSpan, SvgInputV1,
  SvgPathSpecV1,
} from "./types.js";
export { createN1Adapter } from "./adapter.js";
export type { N1Adapter, N1AdapterResult } from "./adapter.js";
export { fixtureDigest } from "./canonicalJson.js";
export { parseSvgPathSubset } from "./svgPathSubset.js";
