/**
 * N1 合同测试共享支撑:认证 fixture 与固化摘要直接取自 Native
 * `adapter_n1_test_support.rs`,字节级一致;golden digest 断言以此为准。
 */

import { createN1Adapter } from "./adapter.js";
import { fixtureDigest } from "./canonicalJson.js";
import { createN1Certifications, DEFAULT_N1_BUDGET, type N1Adapter, type N1Budget, type N1Certification, type N1HostAssets, type N1InlineAsset, type N1InputKind } from "./types.js";

/** 测试统一使用的宿主平台标识(与 Native 测试一致)。 */
export const PLATFORM = "win-dx12";

/** 认证组合 fixture(SVG 子集:M/L/H/V/Z + 相对指令)。 */
export const SVG_FIXTURE = `{"kind":"svg","schemaVersion":1,"input":{"id":"n1.svg.icon","viewBox":[0,0,24,24],"paths":[
{"id":"n1.svg.icon.body","data":"M 2 12 L 12 2 L 22 12 L 12 22 Z","zOrder":1,"fill":[0.1,0.2,0.3,1],"stroke":[1,1,1,1],"strokeWidth":1.5},
{"id":"n1.svg.icon.stem","data":"m 12 22 v -6 h 4","zOrder":2,"stroke":[1,0,0,1],"strokeWidth":1}]}}`;

/** 认证组合 fixture(富文本 inline:两段落 + 一个 inline object)。 */
export const RICH_TEXT_FIXTURE = `{"kind":"rich-text-inline","schemaVersion":1,"input":{"id":"n1.rt.panel","text":"泵运行 abnormal",
"styles":[{"startCluster":0,"endCluster":3,"style":1}],
"paragraphs":[{"startCluster":0,"endCluster":4,"align":"start"},{"startCluster":4,"endCluster":12,"align":"end"}],
"inlineObjects":[{"atCluster":2,"objectId":"n1.rt.pump.icon"}]}}`;

/** 认证组合 fixture(图表扩展:趋势线 + 阈值带 + 标记点)。 */
export const CHART_FIXTURE = `{"kind":"chart-extension","schemaVersion":1,"input":{"id":"n1.chart.ext","overlays":[
{"overlay":"trend-line","id":"n1.chart.trend","points":[[0,10],[100,20]],"stroke":[0,0.5,1,1],"strokeWidth":2,"zOrder":5},
{"overlay":"threshold-band","id":"n1.chart.band","x0":0,"y0":8,"x1":100,"y1":12,"fill":[1,0,0,0.25],"zOrder":1},
{"overlay":"marker","id":"n1.chart.marker","center":[50,15],"radius":4,"fill":[0,1,0,1],"zOrder":9}]}}`;

/** 认证组合 fixture(动画 ABI:两条关键帧轨迹)。 */
export const ANIMATION_FIXTURE = `{"kind":"animation-abi","schemaVersion":1,"input":{"id":"n1.anim.pump","tracks":[
{"nodeId":"pump.rotor","property":"rotation","keyframes":[{"atMs":0,"value":{"number":0}},{"atMs":500,"value":{"number":90}}]},
{"nodeId":"pump.lamp","property":"opacity","keyframes":[{"atMs":0,"value":{"index":0}},{"atMs":200,"value":{"index":1}},{"atMs":600,"value":{"index":2}}]}]}}`;

/** 认证台账的 fixture 摘要(hex SHA-256,与 Native 固化值一致)。 */
export const SVG_DIGEST = "50b1cd8092c7a38fe942bf2327516a582b3c295085ad74a19056af10cd6280cd";
export const RICH_TEXT_DIGEST = "ad56df1cf53c367ab31d8f5eeebd5e14cd729379ea635e8c7bf3239d4035c068";
export const CHART_DIGEST = "5aab58a7b1dff6de6526756e6dcdc95efc96e5c84b155426269926a1793eb957";
export const ANIMATION_DIGEST = "ffb6112352d0aba525196c01e1c5a9d01f42cbf21a5ecb1bb60b3a49299f8fed";

export function hostAssets(inlineAssets?: Record<string, N1InlineAsset>): N1HostAssets {
  return {
    font: {
      id: "n1.font.main", assetId: "asset.font-main", family: "Inter", weight: 400,
      style: "normal", color: [0.05, 0.05, 0.05, 1.0], fontSize: 14.0,
    },
    inlineAssets: new Map(Object.entries(inlineAssets ?? { "n1.rt.pump.icon": { assetId: "asset.pump-icon", width: 16, height: 16 } })),
  };
}

function buildAdapter(certifications: readonly N1Certification[], budget: N1Budget, assets: N1HostAssets): N1Adapter {
  const result = createN1Adapter(createN1Certifications(certifications), budget, assets);
  if (!result.ok) throw new Error(`adapter must build: ${result.reason}`);
  return result.adapter;
}

/** 全部四类组合都按固化摘要认证的适配器(与 Native `certified_adapter` 一致)。 */
export function certifiedAdapter(budget: N1Budget = DEFAULT_N1_BUDGET, assets: N1HostAssets = hostAssets()): N1Adapter {
  return buildAdapter([
    { kind: "svg", schemaVersion: 1, platform: PLATFORM, fixtureDigest: SVG_DIGEST },
    { kind: "rich-text-inline", schemaVersion: 1, platform: PLATFORM, fixtureDigest: RICH_TEXT_DIGEST },
    { kind: "chart-extension", schemaVersion: 1, platform: PLATFORM, fixtureDigest: CHART_DIGEST },
    { kind: "animation-abi", schemaVersion: 1, platform: PLATFORM, fixtureDigest: ANIMATION_DIGEST },
  ], budget, assets);
}

/** 只认证一个按给定 fixture 复算摘要的组合(用于载荷不符/重复 id 等注入场景)。 */
export function adapterCertifiedFor(fixtureText: string, kind: N1InputKind, digest?: string): N1Adapter {
  const effectiveDigest = digest ?? fixtureDigest(encodeUtf8(fixtureText));
  if (effectiveDigest === undefined) throw new Error("fixture must be valid JSON");
  return buildAdapter([{ kind, schemaVersion: 1, platform: PLATFORM, fixtureDigest: effectiveDigest }], DEFAULT_N1_BUDGET, hostAssets());
}

export const encodeUtf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
