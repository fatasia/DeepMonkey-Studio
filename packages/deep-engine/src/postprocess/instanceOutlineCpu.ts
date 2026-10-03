/** 实例/选择描边(对象级 outline)的选项、线性色与 CPU 参考核;与作者(three r185 OutlinePass)口径对齐。 */
export type InstanceOutlineRgb = readonly [number, number, number];

/**
 * Three 作者对象上的 userData 键:值为 true 时,该对象及其全部网格后代经 ThreeProjectionBridge 投影为
 * outline 实例(选中高亮/模型描边同源)。键名是宿主与桥之间的唯一约定。
 */
export const INSTANCE_OUTLINE_USER_DATA_KEY = "deepOutline";

/**
 * Deep(WebGPU)对象级描边能力声明。宿主(Studio)据此决定是否仍需把含描边的场景保留在 WebGL:
 * 缺失该导出(旧引擎包)或 objectOutline 非 true 即 fail-closed 回落。
 * 基线 WebGPU 即可运行(rg8unorm 渲染附件、rgba8unorm/rgba16float 存储写均为核心格式),不依赖可选 feature;
 * 变形(pose)与 meshlet 簇批次暂不进入掩码,运行时经 FrameMetrics.outline.skippedBatches 如实上报。
 */
export const DEEP_INSTANCE_OUTLINE_CAPABILITY = Object.freeze({
  objectOutline: true,
  unsupportedBatches: Object.freeze(["deformation", "meshlet"] as const),
});

export interface InstanceOutlineOptions {
  /** OutlinePass.edgeStrength;默认 2.5(= ScenePostProcessingState.outlineStrength 默认)。 */
  readonly strength?: number;
  /** 边缘检测偏移,半分辨率纹素;OutlinePass.edgeThickness,默认 1。 */
  readonly thickness?: number;
  /** OutlinePass.edgeGlow;默认 0(关闭,不执行辉光采样)。 */
  readonly glow?: number;
  /** 可见部分描边线性 RGB;默认 sRGB #4d9fff(作者 OutlinePass.visibleEdgeColor)。 */
  readonly visibleColor?: InstanceOutlineRgb;
  /** 被遮挡部分描边线性 RGB;默认 sRGB #234a71(作者 OutlinePass.hiddenEdgeColor)。 */
  readonly hiddenColor?: InstanceOutlineRgb;
}

export interface ResolvedInstanceOutlineOptions {
  readonly strength: number;
  readonly thickness: number;
  readonly glow: number;
  readonly visibleColor: InstanceOutlineRgb;
  readonly hiddenColor: InstanceOutlineRgb;
}

export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}
function hexToLinear(hex: number): InstanceOutlineRgb {
  return Object.freeze([srgbToLinear(((hex >> 16) & 255) / 255), srgbToLinear(((hex >> 8) & 255) / 255),
    srgbToLinear((hex & 255) / 255)] as const) as InstanceOutlineRgb;
}

export const DEFAULT_INSTANCE_OUTLINE: ResolvedInstanceOutlineOptions = Object.freeze({
  strength: 2.5, thickness: 1, glow: 0,
  visibleColor: hexToLinear(0x4d9fff), hiddenColor: hexToLinear(0x234a71),
});

const KEYS = ["strength", "thickness", "glow", "visibleColor", "hiddenColor"] as const;

export function validateInstanceOutlineOptions(options: InstanceOutlineOptions | undefined): void {
  if (options === undefined) return;
  if (!options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Instance outline requires an options object.");
  if (Object.keys(options).some(key => !(KEYS as readonly string[]).includes(key))) throw new TypeError("Unknown instance outline option.");
  for (const [key, minimum, maximum] of [["strength", 0, 16], ["thickness", 0.5, 4], ["glow", 0, 4]] as const) {
    const value = options[key];
    if (value !== undefined && (!Number.isFinite(value) || value < minimum || value > maximum)) {
      throw new RangeError(`Instance outline ${key} must be finite within ${minimum}..${maximum}.`);
    }
  }
  for (const key of ["visibleColor", "hiddenColor"] as const) {
    const color = options[key];
    if (color !== undefined && (!Array.isArray(color) || color.length !== 3
      || !color.every(channel => Number.isFinite(channel) && channel >= 0 && channel <= 8))) {
      throw new RangeError(`Instance outline ${key} must be three finite linear channels within 0..8.`);
    }
  }
}

export function resolveInstanceOutlineOptions(options?: InstanceOutlineOptions): ResolvedInstanceOutlineOptions {
  validateInstanceOutlineOptions(options);
  if (!options) return DEFAULT_INSTANCE_OUTLINE;
  return Object.freeze({
    strength: options.strength ?? DEFAULT_INSTANCE_OUTLINE.strength,
    thickness: options.thickness ?? DEFAULT_INSTANCE_OUTLINE.thickness,
    glow: options.glow ?? DEFAULT_INSTANCE_OUTLINE.glow,
    visibleColor: options.visibleColor ? Object.freeze([...options.visibleColor] as const) as InstanceOutlineRgb : DEFAULT_INSTANCE_OUTLINE.visibleColor,
    hiddenColor: options.hiddenColor ? Object.freeze([...options.hiddenColor] as const) as InstanceOutlineRgb : DEFAULT_INSTANCE_OUTLINE.hiddenColor,
  });
}

/** uniform 布局:strength/thickness/glow/pad | visible.xyz,pad | hidden.xyz,pad(48B)。 */
export const INSTANCE_OUTLINE_PARAM_FLOATS = 12;
export function packInstanceOutlineParams(options: ResolvedInstanceOutlineOptions): Float32Array<ArrayBuffer> {
  return new Float32Array([options.strength, options.thickness, options.glow, 0,
    ...options.visibleColor, 0, ...options.hiddenColor, 0]);
}

/**
 * 掩码约定(同 three OutlinePass 的 mask):R=0 为被描边对象剪影内、1 为外;G=1 为可见、0 为被遮挡。
 * 半分辨率边缘核:四邻(±k 纹素)R 差分的模,visibility = 四邻 G 的最小值;
 * 返回 [可见边能量, 被遮挡边能量](预乘,保证双线性上采样时颜色权重正确)。
 */
export function instanceOutlineEdge(neighbors: readonly [readonly [number, number], readonly [number, number],
  readonly [number, number], readonly [number, number]]): readonly [number, number] {
  const [c1, c2, c3, c4] = neighbors;
  const d = Math.hypot((c1[0] - c2[0]) * 0.5, (c3[0] - c4[0]) * 0.5);
  const visible = Math.min(Math.min(c1[1], c2[1]), Math.min(c3[1], c4[1]));
  const hidden = 1 - visible > 0.001;
  return [hidden ? 0 : d, hidden ? d : 0];
}

/** 合成:仅剪影外侧(mask.r)叠加,线性 HDR 加法混合(同 OutlinePass 的 AdditiveBlending)。 */
export function instanceOutlineCompose(color: readonly [number, number, number], maskOutside: number,
  edge: readonly [number, number], glowEdge: readonly [number, number], options: ResolvedInstanceOutlineOptions): readonly [number, number, number] {
  const visible = edge[0] + glowEdge[0] * options.glow, hidden = edge[1] + glowEdge[1] * options.glow;
  const gain = options.strength * maskOutside;
  return [0, 1, 2].map(channel => color[channel]!
    + gain * (visible * options.visibleColor[channel]! + hidden * options.hiddenColor[channel]!)) as unknown as readonly [number, number, number];
}
