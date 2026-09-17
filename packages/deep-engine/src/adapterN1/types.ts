/**
 * P1-23 N1 版本化适配器的 wire 合同(TS 侧)。
 *
 * 与 Native `adapter_n1/schema.rs` + `adapter_n1.rs` 逐字段对齐:信封 `kind`
 * 是 kebab-case 封闭判别字段,只有四类;`schemaVersion` 不在已定义清单即拒绝;
 * 颜色 `[f64;4]`、矩阵 `[f64;6]`、zOrder `i32` 与 Deep2d 合同同形。资源身份
 * 与预算归宿主注入,适配器不发明资源、不读时钟、不做 IO。
 */

import type { DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, Deep2dColor, Deep2dCommand, Deep2dResource } from "../deep2dDisplayList.js";

/** 适配器合同自身版本;适配器行为(而非输入)变化时递增。 */
export const ADAPTER_N1_SCHEMA_VERSION = 1 as const;

/** 已定义输入 schema 的版本清单;不在其中 → unknown(语义未知,绝不猜测)。 */
export const SUPPORTED_INPUT_SCHEMA_VERSIONS: readonly number[] = [1];

/** 四类高价值输入的封闭判别值域,与信封 JSON 的 `kind` 逐字一致。 */
export const N1_INPUT_KINDS = ["svg", "rich-text-inline", "chart-extension", "animation-abi"] as const;
export type N1InputKind = (typeof N1_INPUT_KINDS)[number];

export interface SvgPathSpecV1 {
  readonly id: string;
  /** path data 子集:仅 `M m L l H h V v Z z`,支持矩阵见 `svgPathSubset.ts`。 */
  readonly data: string;
  readonly zOrder: number;
  readonly fill?: Deep2dColor;
  readonly stroke?: Deep2dColor;
  readonly strokeWidth?: number;
}

export interface SvgInputV1 {
  readonly id: string;
  /** `[minX, minY, width, height]`;宽高必须为正且有限。 */
  readonly viewBox: readonly [number, number, number, number];
  readonly paths: readonly SvgPathSpecV1[];
}

export type RichTextAlign = "start" | "center" | "end" | "justify";

/** 样式表内的小整数 id(与 Native `TextStyleId` 同构,u16 值域)。 */
export interface RichTextStyleSpan {
  readonly startCluster: number;
  readonly endCluster: number;
  readonly style: number;
}

export interface RichTextParagraph {
  readonly startCluster: number;
  readonly endCluster: number;
  readonly align: RichTextAlign;
}

/** 插入在哪个簇之前;与 Native `InlineObject::at_cluster` 同义。 */
export interface InlineObject {
  readonly atCluster: number;
  readonly objectId: string;
}

export interface RichTextInlineInput {
  readonly id: string;
  readonly text: string;
  /** serde `#[serde(default)]`:缺失即空数组,null 是类型错误。 */
  readonly styles: readonly RichTextStyleSpan[];
  readonly paragraphs: readonly RichTextParagraph[];
  readonly inlineObjects: readonly InlineObject[];
}

/** 图表扩展的封闭叠加集合;每条叠加适配为一个 path 资源 + 一个 path 命令。 */
export type ChartOverlay =
  | { readonly overlay: "trend-line"; readonly id: string; readonly points: readonly [readonly [number, number], readonly [number, number]]; readonly stroke: Deep2dColor; readonly strokeWidth: number; readonly zOrder: number }
  | { readonly overlay: "threshold-band"; readonly id: string; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly fill: Deep2dColor; readonly zOrder: number }
  | { readonly overlay: "marker"; readonly id: string; readonly center: readonly [number, number]; readonly radius: number; readonly fill: Deep2dColor; readonly zOrder: number };

export interface ChartExtensionInput {
  readonly id: string;
  readonly overlays: readonly ChartOverlay[];
}

export type AnimationProperty = "opacity" | "rotation" | "scale" | "tint";

/** behavior_ir `Scalar` 的镜像:闭合标量,刻意不含字符串。 */
export type BehaviorScalar =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "index"; readonly value: number };

/** wire 形态:`{"number": 1.5}` / `{"bool": true}` / `{"index": 0}`(外部标签)。 */
export type AnimationValue =
  | { readonly kind: "number"; readonly value: number }
  | { readonly kind: "bool"; readonly value: boolean }
  | { readonly kind: "index"; readonly value: number };

export interface AnimationKeyframe {
  /** 注入时钟毫秒;轨迹必须按其严格递增且不重复。 */
  readonly atMs: number;
  readonly value: AnimationValue;
}

export interface AnimationTrack {
  /** 必须是稳定节点 id(与 behavior_ir 同一校验,见 `validation.ts`)。 */
  readonly nodeId: string;
  readonly property: AnimationProperty;
  readonly keyframes: readonly AnimationKeyframe[];
}

export interface AnimationAbiInput {
  readonly id: string;
  readonly tracks: readonly AnimationTrack[];
}

/** 适配产物中的批量 display delta:与 `Deep2dDisplayList` 的 resources/commands 同形,可由宿主并回主 display list。 */
export interface N1DisplayDelta {
  readonly schemaVersion: typeof DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION;
  readonly resources: readonly Deep2dResource[];
  readonly commands: readonly Deep2dCommand[];
}

/** behavior_ir `BehaviorPayload::SetProperty` 的 TS 镜像(封闭载荷)。 */
export type N1BehaviorAction = {
  readonly kind: "set-property";
  readonly nodeId: string;
  readonly property: AnimationProperty;
  readonly value: BehaviorScalar;
};

/** 一次成功适配的产物:批量 display delta + 行为命令。 */
export interface N1Adapted {
  readonly kind: N1InputKind;
  readonly delta: N1DisplayDelta;
  readonly actions: readonly N1BehaviorAction[];
}

/** 适配结果:fail-closed 三态。adapted 之外一律不产出 delta/命令。 */
export type N1Outcome =
  | { readonly state: "adapted"; readonly adapted: N1Adapted }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "blocked"; readonly reason: string };

export interface N1FontAsset {
  readonly id: string;
  readonly assetId: string;
  readonly family: string;
  /** 100..=900,步长 100(与 Deep2d 字体资源合同一致)。 */
  readonly weight: number;
  readonly style: "normal" | "italic";
  readonly color: Deep2dColor;
  readonly fontSize: number;
}

/** inline object 的宿主资产身份;按 objectId 精确查找,查不到即 blocked。 */
export interface N1InlineAsset {
  readonly assetId: string;
  /** 像素尺寸,1..=65536(与 Deep2d 图片资源合同一致)。 */
  readonly width: number;
  readonly height: number;
}

export interface N1HostAssets {
  readonly font: N1FontAsset;
  readonly inlineAssets: ReadonlyMap<string, N1InlineAsset>;
}

/** 宿主注入的预算:全部硬上限,触界即 blocked(不截断、不排队、不降级)。 */
export interface N1Budget {
  readonly maxPaths: number;
  readonly maxVerbsPerPath: number;
  readonly maxCommands: number;
  readonly maxTextCodeUnits: number;
  readonly maxAnimationTracks: number;
  readonly maxKeyframesPerTrack: number;
  /** fixture 字节上限,防超大输入拖死适配。 */
  readonly maxFixtureBytes: number;
}

export const DEFAULT_N1_BUDGET: Readonly<N1Budget> = Object.freeze({
  maxPaths: 4_096,
  maxVerbsPerPath: 65_536,
  maxCommands: 65_536,
  maxTextCodeUnits: 1_000_000,
  maxAnimationTracks: 1_024,
  maxKeyframesPerTrack: 4_096,
  maxFixtureBytes: 4 * 1024 * 1024,
} satisfies N1Budget);

/** 一条认证记录:(输入类别, schema 版本, 平台) → 已复核 fixture 摘要。 */
export interface N1Certification {
  readonly kind: N1InputKind;
  readonly schemaVersion: number;
  /** 宿主平台标识(如 `win-dx12` / `web-webgpu`);精确匹配,无通配。 */
  readonly platform: string;
  /** 已复核 fixture 的 canonical-JSON SHA-256(hex)。 */
  readonly fixtureDigest: string;
}

export interface N1Certifications {
  readonly lookup: (kind: N1InputKind, schemaVersion: number, platform: string) => N1Certification | undefined;
}

/** 宿主注入的认证台账。适配器只读,自己不认证任何组合。 */
export function createN1Certifications(entries: readonly N1Certification[]): N1Certifications {
  const byKey = new Map(entries.map((entry) => [`${entry.kind}\u0000${entry.schemaVersion}\u0000${entry.platform}`, entry]));
  return {
    lookup: (kind, schemaVersion, platform) => byKey.get(`${kind}\u0000${schemaVersion}\u0000${platform}`),
  };
}
