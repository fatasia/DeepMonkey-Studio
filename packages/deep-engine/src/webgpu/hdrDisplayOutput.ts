/**
 * I-C21 HDR 显示输出 —— 检测 → tone mapping 策略匹配 → canvas 配置,配 fail-closed 门
 * (与 environment/atmosphereSkyGate 同契约:配置边界永不抛错,非法/缺失一律显式回 SDR
 * 并给机器可读原因码)。
 *
 * == 门控语义(三段式,仓内先例对齐) ==
 * - `resolveHdrDisplayPolicy`:唯一产品入口。输入宿主探测结果(`HdrDisplayProbe`)与
 *   作者请求(默认 **关**),输出 `HdrDisplayPolicy`(hdr/sdr + 策略 + 原因码)。
 *   任一环节缺失(WebGPU 缺席/显示器非 HDR/浏览器拒收 rgba16float canvas 格式/
 *   extended tone mapping 不支持/探测输入非法)→ fail-closed 回 SDR,渲染循环继续。
 * - `describeHdrCanvasConfiguration`:把策略翻译成 `GPUCanvasContext.configure` 描述符
 *   (format=rgba16float + toneMapping.mode=extended,WebGPU HDR canvas 同族;Godot 4.7
 *   HDR 输出为参照)。SDR 策略返回 null = 零介入,configure 责任仍归 DeviceSession
 *   (既有 preferred format 通路一字不改)。
 * - 白炉守恒边界:HDR 策略只替换 present 终点的"压缩到 0..1 + sRGB 编码"为
 *   "headroom 保留/PQ/HLG 编码",上游着色能量链零改动;0.5 线性白炉在三种 HDR 策略
 *   下的编码值由 pbrHdrDisplay CPU 镜像逐位背书。
 *
 * == 默认关 ==
 * `DEFAULT_HDR_DISPLAY_REQUEST.enabled === false`:不带显式 opt-in 时本模块任何函数都
 * 不会改变既有 SDR 显示链(opt-out 原因码显式返回,不是静默)。
 *
 * == 无 bare 依赖纪律 ==
 * 本模块零导入,可被 rendererCapabilitySelfCheck(contracts 对拍导入闭包)与
 * lab 真机探针安全引用。
 */

/** HDR 输出策略封闭集。`aces-sdr` 为既有 SDR 终点(不新增),其余三者只作用于 HDR 画布。 */
export const HDR_DISPLAY_STRATEGIES = Object.freeze([
  /** HDR canvas + 合成器映射:线性值 >1 保留(1.0 = SDR 参考白),超峰软压缩。 */
  "extended-linear",
  /** HDR10/BT.2100:PQ EOTF 绝对亮度编码(峰值 nits 钳制),面向 LED 大屏/录档 sink。 */
  "pq-2020",
  /** BT.2100 HLG:相对场景线性 OETF 编码,面向广播/回放 sink。 */
  "hlg-2020",
  /** 既有 SDR 终点:ACES(或 Narkowicz)+ sRGB,0..1。 */
  "aces-sdr",
] as const);

export type HdrDisplayStrategy = (typeof HDR_DISPLAY_STRATEGIES)[number];

/**
 * fail-closed 原因码封闭集。`hdr-active` 是唯一成功码;其余每码对应一条显式回退路径,
 * 验收要求"原因码显式"即指:任何 SDR 回退都必须能报出此处一个码,禁止静默。
 */
export const HDR_DISPLAY_REASON_CODES = Object.freeze([
  /** 检测全通过,HDR 输出激活。 */
  "hdr-active",
  /** 作者未 opt-in(默认关,显式码而非静默)。 */
  "opt-out",
  /** 探测输入非法(非对象/字段越界),fail-closed。 */
  "invalid-probe",
  /** navigator.gpu 缺席。 */
  "webgpu-missing",
  /** 显示器 dynamic-range 非 high(matchMedia)。 */
  "display-not-hdr",
  /** 浏览器 GPUCanvasContext 不支持 toneMapping.mode=extended。 */
  "canvas-extended-tonemapping-unsupported",
  /** 浏览器拒收 rgba16float canvas 格式(configure 抛 TypeError)。 */
  "hdr-canvas-format-unsupported",
  /** HDR 输出管线创建/编译失败,present 已回退 SDR(pbrOutputBindings 运行时回退)。 */
  "hdr-pipeline-failed",
] as const);

export type HdrDisplayReasonCode = (typeof HDR_DISPLAY_REASON_CODES)[number];

/** mode → 合法原因码配对(封闭,加载期自检;同 REASON_PAIRS_FOR_SUPPORT 先例)。 */
export const HDR_DISPLAY_REASON_PAIRS: Readonly<Record<"hdr" | "sdr", readonly HdrDisplayReasonCode[]>> = Object.freeze({
  hdr: Object.freeze(["hdr-active"] as const),
  sdr: Object.freeze(["opt-out", "invalid-probe", "webgpu-missing", "display-not-hdr",
    "canvas-extended-tonemapping-unsupported", "hdr-canvas-format-unsupported", "hdr-pipeline-failed"] as const),
});

/** 宿主探测结果:全部字段由宿主以真实浏览器 API 填写,本模块不做任何全局读取(可测)。 */
export interface HdrDisplayProbe {
  /** `navigator.gpu !== undefined`。 */
  readonly webgpuAvailable: boolean;
  /** `matchMedia("(dynamic-range: high)").matches`;不支持该查询的浏览器如实填 "unknown"。 */
  readonly displayDynamicRange: "standard" | "high" | "unknown";
  /** 试配置 `toneMapping:{mode:"extended"}` 是否被接受(未抛 TypeError)。 */
  readonly canvasToneMappingExtended: boolean;
  /** 试配置 `format:"rgba16float"` 是否被接受(未抛 TypeError)。 */
  readonly canvasFormatRgba16float: boolean;
}

/** 作者请求:默认关;`strategy` 缺省时按探测结果自动匹配(见 resolveHdrDisplayPolicy)。 */
export interface HdrDisplayRequest {
  /** 显式 opt-in;缺省/false = SDR(原因码 opt-out)。 */
  readonly enabled?: boolean;
  /** 指定策略;越界值 fail-closed 回 SDR(InvalidStrategy 路径记 invalid-probe)。 */
  readonly strategy?: HdrDisplayStrategy;
  /** PQ 策略峰值亮度(nits);缺省 `DEFAULT_PQ_PEAK_NITS`,非法值钳制并记入 failClosed。 */
  readonly pqPeakNits?: number;
}

/** 策略解析产物:present 链与宿主 configure 的唯一事实源。 */
export interface HdrDisplayPolicy {
  readonly mode: "hdr" | "sdr";
  readonly strategy: HdrDisplayStrategy;
  /** true = 请求了 HDR 但被显式回退;reason 说明路径。 */
  readonly failClosed: boolean;
  readonly reason: HdrDisplayReasonCode;
  /** PQ 策略峰值亮度(nits);非 pq 策略为 undefined。 */
  readonly pqPeakNits?: number;
}

/** BT.2408 参考白(PQ 码 0.58 ≈ 203 nits);extended-linear 的 1.0 与 PQ 换算共用锚点。 */
export const HDR_REFERENCE_WHITE_NITS = 203;
/** PQ 策略默认峰值(BT.2100 常见消费档 1000 nits;LED 大屏可显式抬高,上限 10000)。 */
export const DEFAULT_PQ_PEAK_NITS = 1000;
/** PQ 物理上限(BT.2100 规范域)。 */
export const MAX_PQ_PEAK_NITS = 10000;
/** extended-linear 默认 headroom 倍数(203 nits 参考白 × 8 ≈ 1624 nits 软肩顶)。 */
export const DEFAULT_EXTENDED_HEADROOM = 8;

const DEFAULT_POLICY: HdrDisplayPolicy = Object.freeze({
  mode: "sdr", strategy: "aces-sdr", failClosed: false, reason: "opt-out",
});

function isStrategy(value: unknown): value is HdrDisplayStrategy {
  return typeof value === "string" && (HDR_DISPLAY_STRATEGIES as readonly string[]).includes(value);
}

function clampPeak(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PQ_PEAK_NITS;
  return Math.min(MAX_PQ_PEAK_NITS, Math.max(1, value));
}

/**
 * 解析 HDR 显示策略(产品唯一入口,永不抛错)。
 *
 * 匹配序(请求 enabled=true 时):
 * 1. 探测对象/字段非法 → sdr/invalid-probe;
 * 2. WebGPU 缺席 → sdr/webgpu-missing;
 * 3. 显示器 dynamic-range 非 high(unknown 同样不放行,fail-closed 保守)→ sdr/display-not-hdr;
 * 4. 自动策略(未显式指定):display HDR + canvas extended + rgba16float → extended-linear;
 *    extended 不支持但 rgba16float 可用 → pq-2020(直出 PQ 缓冲);
 *    作者显式指定策略时按显式值(策略可用性仍受 canvas 能力闸:extended-linear 必须
 *    canvas extended,否则 fail-closed);
 * 5. rgba16float canvas 格式被拒 → sdr/hdr-canvas-format-unsupported;
 * 6. 显式 extended-linear 但 canvas extended 不支持 → sdr/canvas-extended-tonemapping-unsupported。
 */
export function resolveHdrDisplayPolicy(probe: HdrDisplayProbe | undefined,
  request: HdrDisplayRequest = {}): HdrDisplayPolicy {
  if (!request || typeof request !== "object" || Array.isArray(request)) return DEFAULT_POLICY;
  if (request.enabled !== true) {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: false, reason: "opt-out" });
  }
  if (!probe || typeof probe !== "object" || Array.isArray(probe)) {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "invalid-probe" });
  }
  const validProbe = typeof probe.webgpuAvailable === "boolean"
    && (probe.displayDynamicRange === "standard" || probe.displayDynamicRange === "high"
      || probe.displayDynamicRange === "unknown")
    && typeof probe.canvasToneMappingExtended === "boolean"
    && typeof probe.canvasFormatRgba16float === "boolean";
  if (!validProbe) {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "invalid-probe" });
  }
  if (!probe.webgpuAvailable) {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "webgpu-missing" });
  }
  if (probe.displayDynamicRange !== "high") {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "display-not-hdr" });
  }
  const explicit = request.strategy;
  if (explicit !== undefined && !isStrategy(explicit)) {
    return Object.freeze({ mode: "sdr", strategy: "aces-sdr", failClosed: true, reason: "invalid-probe" });
  }
  const strategy: HdrDisplayStrategy = explicit ?? (probe.canvasToneMappingExtended ? "extended-linear" : "pq-2020");
  if (strategy === "extended-linear" && !probe.canvasToneMappingExtended) {
    return Object.freeze({
      mode: "sdr", strategy: "aces-sdr", failClosed: true,
      reason: "canvas-extended-tonemapping-unsupported",
    });
  }
  if (!probe.canvasFormatRgba16float) {
    return Object.freeze({
      mode: "sdr", strategy: "aces-sdr", failClosed: true,
      reason: "hdr-canvas-format-unsupported",
    });
  }
  const peak = clampPeak(request.pqPeakNits);
  return Object.freeze({
    mode: "hdr", strategy, failClosed: false, reason: "hdr-active",
    ...(strategy === "pq-2020" ? { pqPeakNits: peak } : {}),
  });
}

/** HDR canvas 配置描述符(`GPUCanvasContext.configure` 的 HDR 增量字段);SDR 策略 = null。 */
export interface HdrCanvasConfiguration {
  /** WebGPU HDR canvas 唯一 float 格式;8bit SDR 格式(bgra8unorm/rgba8unorm)不进 HDR。 */
  readonly format: "rgba16float";
  /** WebGPU 扩展 tone mapping 模式:合成器按显示 headroom 映射 >1 线性值。 */
  readonly toneMappingMode: "extended" | "standard";
  /** 建议 surface usage(与 DeviceSession 既有通路一致:渲染 + 截图读回)。 */
  readonly usage: number;
}

/**
 * 策略 → canvas 配置描述符。SDR 策略(含 fail-closed)返回 null:configure 责任完全
 * 归既有 DeviceSession 通路,本切片零介入(默认关回归的静态保证)。
 */
export function describeHdrCanvasConfiguration(policy: HdrDisplayPolicy | undefined): HdrCanvasConfiguration | null {
  if (!policy || policy.mode !== "hdr") return null;
  return Object.freeze({
    format: "rgba16float",
    toneMappingMode: policy.strategy === "extended-linear" ? "extended" : "standard",
    usage: GPU_TEXTURE_USAGE_SURFACE,
  });
}

/** RENDER_ATTACHMENT(0x10) | COPY_SRC(0x01) —— 与 deviceSession 既有 configure usage 同源。
 * 注意 COPY_SRC=1 而非 8(STORAGE_BINDING):bgra8unorm 不支持 storage,配错即黑屏。 */
export const GPU_TEXTURE_USAGE_SURFACE = 16 | 1;

/** 加载期配对自检:mode→原因码配对被破坏立即抛错(结构先例:probeRadianceDirectionGate)。 */
for (const [mode, codes] of Object.entries(HDR_DISPLAY_REASON_PAIRS)) {
  for (const code of codes) {
    if (!(HDR_DISPLAY_REASON_CODES as readonly string[]).includes(code)) {
      throw new Error(`hdrDisplayOutput: reason code "${code}" for mode ${mode} is not in the closed vocabulary.`);
    }
  }
}
if ((HDR_DISPLAY_REASON_PAIRS.hdr as readonly string[]).includes("opt-out")
  || (HDR_DISPLAY_REASON_PAIRS.sdr as readonly string[]).includes("hdr-active")) {
  throw new Error("hdrDisplayOutput: hdr/sdr reason pair sets must stay disjoint on the terminal codes.");
}
