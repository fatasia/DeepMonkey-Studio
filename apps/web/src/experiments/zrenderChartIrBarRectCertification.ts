import { runtimeContentSha256, validateChartIR, type ChartIR, type ChartSeries } from "@bim-studio/deep-engine";
import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";
import { initialChartState } from "../delivery/dashboardChartFrame";
import { axisValues, cartesian, chartPlot, domain, zoomDomain, type ChartZoomWindow } from "../delivery/dashboardChartFrameGeometry";

/**
 * P2-02 受限认证 lane（2026-09-18 切片）：证明「冻结的 ZRender 6.1.0 动态 bar rect 子集」
 * 在 ChartIR 输入下可被确定性映射与校验。期望 rect 集合由仓库自有 Native 同构几何
 * （chartPlot/cartesian/zoomDomain，即 chart-web-geometry golden 同一参照）推导；
 * 真实 ECharts/ZRender 6.1.0 SSR 实例只消费由该映射投影出的确定性布局基元。
 * 本 lane 是版本锁定的认证产物，不是兼容层：ECharts/ZRender 升级即失效，须重新认证。
 */

export const CHARTIR_BAR_RECT_DEPENDENCIES = Object.freeze({ echarts: "6.1.0", zrender: "6.1.0" } as const);

export const CHARTIR_BAR_RECT_BUDGETS = Object.freeze({
  maxBars: 256,
  maxInputBytes: 64 * 1024,
  maxComputeMs: 250,
} as const);

/** ChartIR v1 没有系列颜色字段；本 lane 用冻结常量作为唯一 fill 来源。 */
export const CHARTIR_BAR_RECT_FROZEN_FILL = "#5070dd";
/** 实测冻结的 bar rect 层级（z=2, z2=1 → 2_000_001）。 */
export const CHARTIR_BAR_RECT_FROZEN_Z_ORDER = 2_000_001;
/** 与 chart-web-geometry golden 的 equivalent() 同口径：1e-9 * max(1, |expected|)。 */
export const CHARTIR_BAR_RECT_TOLERANCE = 1e-9;

export type ChartIrBarRectBlockedCapability =
  | "formatter" | "image" | "tooltip" | "animation"
  | "non-rect-series" | "legend-and-text" | "category-resize"
  | "echarts-datazoom-window-semantics" | "clipped-out-of-domain-bars";

export const CHARTIR_BAR_RECT_CAPABILITIES: readonly { feature: ChartIrBarRectBlockedCapability; status: "supported" | "blocked"; detail: string }[] = Object.freeze([
  { feature: "formatter", status: "blocked", detail: "ChartSpec v1 编译层拒绝函数；本 lane 输入只收已编译 ChartIR，无可执行通道。" },
  { feature: "image", status: "blocked", detail: "ChartSpec v1 无 image 字段，lane 无资源加载通道；未冻结图片资产身份。" },
  { feature: "tooltip", status: "blocked", detail: "tooltip 在 ChartIR 中是纯数据 {enabled,trigger}；lane 强制 option.tooltip.show=false，测试证明其不影响 rect 几何，交互/DOM 不在认证面。" },
  { feature: "animation", status: "blocked", detail: "option 固定 animation:false；动画调度器与中间帧未被捕获，不在认证面。" },
  { feature: "non-rect-series", status: "blocked", detail: "line/scatter/pie/heatmap/gauge 混入即整体拒绝，不产出部分 rect。" },
  { feature: "legend-and-text", status: "blocked", detail: "legend.visible 必须 false：图例会产生文本/图标非 rect 元素，超出 rect 子集。" },
  { feature: "category-resize", status: "blocked", detail: "动态通道冻结为同形状数据替换（类目数跨帧不变）；类目增删归既有 P2-02 remove 命令实验。" },
  { feature: "echarts-datazoom-window-semantics", status: "blocked", detail: "实测：ECharts 类目 dataZoom 窗口按 (count-1) 取整且端点包含，与 Native 连续行带公式不一致；lane 以「类目对齐窗口 → 类目子集+显式 barWidth」重投影承担窗口语义，非对齐窗口（start*count 非整数）两者都无法认证，整体拒绝。" },
  { feature: "clipped-out-of-domain-bars", status: "blocked", detail: "ECharts bar 默认把超出 grid 的值裁剪在绘图区内，Native 公式则连续映射（静态路径靠 clipPath 裁剪）；动态帧的值必须落在显式值域内，越界值整体拒绝。" },
]);

const BLOCKED = CHARTIR_BAR_RECT_CAPABILITIES.filter(item => item.status === "blocked").map(item => item.feature);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HEX_COLOR = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const FRAME_KEYS = new Set(["label", "ir", "width", "height"]);

export interface BarRectExpectation {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: readonly [number, number, number, number];
  readonly zOrder: number;
}

export interface BarRectObservation extends BarRectExpectation {}

export interface ChartIrBarRectFrame {
  readonly label?: string;
  readonly ir: ChartIR;
  readonly width: number;
  readonly height: number;
}

export interface ChartIrBarRectFrameResult {
  readonly label: string;
  readonly epoch: number;
  readonly inputHash: string;
  readonly outputHash: string;
  readonly rectCount: number;
  readonly expected: readonly BarRectExpectation[];
  readonly actual: readonly BarRectObservation[];
  /** 期望与实际逐值对拍（容差 1e-9*max(1,|e|)，golden 同口径）全部一致。 */
  readonly matched: boolean;
  readonly deferredActions: readonly { readonly path: string; readonly type: string; readonly reason: string }[];
  readonly computeMs: number;
}

export interface ChartIrBarRectProjection {
  readonly plot: readonly [number, number, number, number];
  readonly bandWidth: number;
  readonly visibleCategories: readonly string[];
  readonly visibleValues: readonly number[];
  readonly yDomain: readonly [number, number];
  readonly option: EChartsOption;
}

export type ChartIrBarRectCertifyResult =
  | { readonly ok: true; readonly frame: ChartIrBarRectFrameResult; readonly projection: ChartIrBarRectProjection }
  | { readonly ok: false; readonly code: "invalid-input" | "blocked-capability" | "budget-exceeded" | "deadline-exceeded" | "renderer-failed"; readonly message: string; readonly retainedEpoch: number; readonly retainedOutputHash: string | null };

interface ZRenderDisplayableLike {
  readonly type?: unknown;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly z?: unknown;
  readonly z2?: unknown;
}

function failure(code: Extract<ChartIrBarRectCertifyResult, { ok: false }>["code"], message: string, retainedEpoch: number, retainedOutputHash: string | null): ChartIrBarRectCertifyResult {
  return { ok: false, code, message, retainedEpoch, retainedOutputHash };
}

function rgba(value: string): readonly [number, number, number, number] {
  const match = HEX_COLOR.exec(value);
  if (!match) throw new Error(`Unsupported bar fill color: ${value}`);
  const rgb = match[1]!;
  return [Number.parseInt(rgb.slice(0, 2), 16) / 255, Number.parseInt(rgb.slice(2, 4), 16) / 255,
    Number.parseInt(rgb.slice(4, 6), 16) / 255, Number.parseInt(match[2] ?? "ff", 16) / 255];
}

function finiteCoordinate(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 16_777_216) throw new Error(`ZRender emitted an invalid ${name}.`);
  return Object.is(value, -0) ? 0 : value;
}

/** 子集约束检查；返回违规说明（空数组 = 可认证）。 */
function subsetViolations(ir: ChartIR, zoomWindows: readonly ChartZoomWindow[] = []): string[] {
  const violations: string[] = [];
  if (ir.series.length !== 1) violations.push(`certification subset covers exactly one series; received ${ir.series.length}`);
  const series = ir.series[0];
  if (!series || series.type !== "bar") violations.push(`series ${series?.id ?? "?"} has type ${series?.type ?? "?"}; only "bar" is in the rect subset`);
  if (ir.legend.visible) violations.push("legend.visible must be false: legend text/icons are non-rect displayables outside the subset");
  if (!series || series.type !== "bar") return violations;
  const xAxis = ir.axes.find(axis => axis.id === series.xAxisId);
  const yAxis = ir.axes.find(axis => axis.id === series.yAxisId);
  if (xAxis?.scale !== "category") violations.push(`x axis ${series.xAxisId} must use the category scale in this subset`);
  if (yAxis && yAxis.scale !== "linear") violations.push(`y axis ${series.yAxisId} must be linear in this subset; log/time are not certified`);
  // x 窗口必须类目对齐：ECharts 的「类目等分 + 显式 barWidth」基元只能表达
  // first∈Z 的行带（连续小数偏移无法投影；dataZoom 组件语义实测又不一致 → 整体 blocked）。
  const dataset = ir.datasets.find(item => item.id === series.datasetId);
  if (dataset) {
    const count = Math.max(1, dataset.rows.length);
    for (const [axisId, start, end] of zoomWindows) {
      if (axisId !== series.xAxisId) continue;
      const first = start * count, last = end * count;
      if (!Number.isInteger(first) || !Number.isInteger(last))
        violations.push(`category zoom window [${start},${end}] is not category-aligned (start*count=${first}, end*count=${last}); fractional banded offsets are outside the certified subset`);
    }
  }
  return violations;
}

/**
 * ChartIR → 期望 bar rect 集合：完全复用 chart-web-geometry golden 同一参照
 * （chartPlot/cartesian/zoomDomain，Native render_chart_with_windows 同构）。
 * 窗口语义按 Native 连续行带公式承担（ECharts dataZoom 组件语义实测不一致，见 blocked）。
 */
export function expectedBarRects(ir: ChartIR, width: number, height: number, zoomWindows: readonly ChartZoomWindow[] = []): readonly BarRectExpectation[] {
  const violations = subsetViolations(ir, zoomWindows);
  if (violations.length > 0) throw new Error(`ChartIR is outside the bar-rect certification subset: ${violations.join("; ")}`);
  const series = ir.series[0] as Extract<ChartSeries, { type: "line" | "bar" | "scatter" }>;
  const dataset = ir.datasets.find(item => item.id === series.datasetId);
  if (!dataset) throw new Error(`Missing chart dataset: ${series.datasetId}`);
  const plot = chartPlot(ir, width, height);
  const mapped = cartesian(ir, series, dataset, plot, zoomWindows);
  if (!mapped) throw new Error("ChartIR does not yield a certifiable bar geometry (empty or degenerate domain).");
  const { points, indices, band, baseline } = mapped;
  const count = Math.max(1, dataset.rows.length);
  const window = zoomWindows.find(([axisId]) => axisId === series.xAxisId);
  const first = window ? window[1] * count : 0;
  const span = window ? (window[2] - window[1]) * count : count;
  return points.flatMap((point, position) => {
    const index = indices[position]!;
    if (window && (index + 0.5 < first || index + 0.5 >= first + span)) return [];
    return [{
      id: `bar.${index}`,
      x: point[0] - band * 0.4,
      y: baseline,
      width: band * 0.8,
      height: point[1] - baseline,
      fill: rgba(CHARTIR_BAR_RECT_FROZEN_FILL),
      zOrder: CHARTIR_BAR_RECT_FROZEN_Z_ORDER,
    }];
  });
}

/** 与期望映射同源的 ECharts 布局基元投影：窗口后的类目子集 + 显式带宽 + 显式值域。 */
export function projectChartIrBarOption(ir: ChartIR, width: number, height: number, zoomWindows: readonly ChartZoomWindow[] = []): ChartIrBarRectProjection {
  const series = ir.series[0] as Extract<ChartSeries, { type: "line" | "bar" | "scatter" }>;
  const dataset = ir.datasets.find(item => item.id === series.datasetId)!;
  const plot = chartPlot(ir, width, height);
  const mapped = cartesian(ir, series, dataset, plot, zoomWindows);
  if (!mapped) throw new Error("ChartIR does not project onto a certifiable bar layout.");
  const count = Math.max(1, dataset.rows.length);
  const window = zoomWindows.find(([axisId]) => axisId === series.xAxisId);
  const first = window ? window[1] * count : 0;
  const span = window ? (window[2] - window[1]) * count : count;
  const yi = dataset.dimensions.indexOf(series.y);
  const xi = dataset.dimensions.indexOf(series.x);
  const visibleIndices = mapped.indices.filter(index => !window || (index + 0.5 >= first && index + 0.5 < first + span));
  const visibleCategories = visibleIndices.map(index => `${dataset.rows[index]![xi]}`);
  const visibleValues = visibleIndices.map(index => Number(dataset.rows[index]![yi]));
  const xAxis = ir.axes.find(axis => axis.id === series.xAxisId), yAxis = ir.axes.find(axis => axis.id === series.yAxisId);
  const sharedY = axisValues(ir, "y", series.yAxisId);
  const base = domain(yAxis, sharedY.values)!;
  if (sharedY.hasBar && yAxis?.scale !== "log") {
    if (yAxis?.min == null) base[0] = Math.min(base[0], 0);
    if (yAxis?.max == null) base[1] = Math.max(base[1], 0);
  }
  const yz = zoomDomain(yAxis, base, zoomWindows)!;
  const option: EChartsOption = {
    animation: false,
    tooltip: { show: false },
    grid: { left: plot[0], top: plot[1], width: plot[2], height: plot[3] },
    xAxis: { type: "category", show: false, data: visibleCategories },
    yAxis: { type: "value", show: false, min: yz[0], max: yz[1] },
    series: [{ type: "bar", silent: true, barWidth: mapped.band * 0.8, data: visibleValues, itemStyle: { color: CHARTIR_BAR_RECT_FROZEN_FILL } }],
  };
  return { plot, bandWidth: mapped.band, visibleCategories, visibleValues, yDomain: yz as [number, number], option };
}

function observedRects(chart: ECharts, expectedCount: number): readonly Omit<BarRectObservation, "id">[] {
  const displayList = chart.getZr().storage.getDisplayList(true) as readonly ZRenderDisplayableLike[];
  if (displayList.some(item => item.type !== "rect")) throw new Error("ZRender emitted a non-rect displayable; the frame is outside the certified subset.");
  if (displayList.length !== expectedCount) throw new Error(`ZRender emitted ${displayList.length} rects; expected ${expectedCount}.`);
  return displayList.map(item => {
    const shape = item.shape ?? {}, style = item.style ?? {};
    if (typeof style.fill !== "string") throw new Error("ZRender emitted an unsupported rect fill.");
    return {
      x: finiteCoordinate(shape.x, "rect.x"),
      y: finiteCoordinate(shape.y, "rect.y"),
      width: finiteCoordinate(shape.width, "rect.width"),
      height: finiteCoordinate(shape.height, "rect.height"),
      fill: rgba(style.fill),
      zOrder: finiteCoordinate(item.z ?? 0, "rect.z") * 1_000_000 + finiteCoordinate(item.z2 ?? 0, "rect.z2"),
    };
  }).sort((a, b) => a.x - b.x);
}

function matchesExpectation(actual: readonly (Omit<BarRectObservation, "id"> | BarRectObservation)[], expected: readonly BarRectExpectation[]): boolean {
  const byX = [...expected].sort((a, b) => a.x - b.x);
  if (actual.length !== byX.length) return false;
  return byX.every((item, position) => {
    const observed = actual[position]!;
    return Math.abs(observed.x - item.x) <= CHARTIR_BAR_RECT_TOLERANCE * Math.max(1, Math.abs(item.x))
      && Math.abs(observed.y - item.y) <= CHARTIR_BAR_RECT_TOLERANCE * Math.max(1, Math.abs(item.y))
      && Math.abs(observed.width - item.width) <= CHARTIR_BAR_RECT_TOLERANCE * Math.max(1, Math.abs(item.width))
      && Math.abs(observed.height - item.height) <= CHARTIR_BAR_RECT_TOLERANCE * Math.max(1, Math.abs(item.height))
      && observed.fill.every((channel, index) => channel === item.fill[index])
      && observed.zOrder === item.zOrder;
  });
}

function validateFrame(frame: unknown): { readonly ok: true; readonly value: ChartIrBarRectFrame; readonly inputHash: string }
  | { readonly ok: false; readonly code: "invalid-input" | "budget-exceeded"; readonly message: string } {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame) || Object.keys(frame).some(key => !FRAME_KEYS.has(key)))
    return { ok: false, code: "invalid-input", message: "Frame must contain only {label?, ir, width, height}." };
  const value = frame as Partial<ChartIrBarRectFrame>;
  if (value.label !== undefined && (typeof value.label !== "string" || value.label.length > 128))
    return { ok: false, code: "invalid-input", message: "Frame label must be a bounded string." };
  for (const key of ["width", "height"] as const) {
    const size = value[key];
    if (typeof size !== "number" || !Number.isFinite(size) || size <= 0 || size > 16_777_216)
      return { ok: false, code: "invalid-input", message: `Frame ${key} must be a positive bounded number.` };
  }
  const checked = validateChartIR(value.ir);
  if (!checked.ok || !checked.ir) return { ok: false, code: "invalid-input", message: `Invalid ChartIR: ${JSON.stringify(checked.diagnostics.slice(0, 3))}` };
  const categories = checked.ir.datasets[0]?.rows.length ?? 0;
  if (categories > CHARTIR_BAR_RECT_BUDGETS.maxBars) return { ok: false, code: "budget-exceeded", message: `Bar count ${categories} exceeds ${CHARTIR_BAR_RECT_BUDGETS.maxBars}.` };
  let bytes: number;
  try { bytes = new TextEncoder().encode(JSON.stringify({ ir: checked.ir, width: value.width, height: value.height })).byteLength; }
  catch { return { ok: false, code: "invalid-input", message: "Frame must be JSON serializable." }; }
  if (bytes > CHARTIR_BAR_RECT_BUDGETS.maxInputBytes) return { ok: false, code: "budget-exceeded", message: `Frame input exceeds ${CHARTIR_BAR_RECT_BUDGETS.maxInputBytes} bytes.` };
  return { ok: true, value: { ...(value.label === undefined ? {} : { label: value.label }), ir: checked.ir, width: value.width as number, height: value.height as number }, inputHash: runtimeContentSha256({ ir: checked.ir, width: value.width, height: value.height }) };
}

/**
 * 版本锁定的认证实例：同一 ECharts SSR 实例上推进帧（数据替换/窗口重投影），
 * 每帧输出期望映射、ZRender 实测 rect、对拍结论与完整快照 hash。
 * 任一帧失败不推进 epoch、不替换 output hash（沿既有 P2-02 纪律）。
 */
export class ZRenderChartIrBarRectCertification {
  readonly #chart: ECharts;
  #epoch = 0;
  #outputHash: string | null = null;
  #categorySignature: string | null = null;

  constructor() {
    if (echarts.version !== CHARTIR_BAR_RECT_DEPENDENCIES.echarts)
      throw new Error(`Certification requires ECharts ${CHARTIR_BAR_RECT_DEPENDENCIES.echarts}; received ${echarts.version}. Upgrade invalidates the frozen profile and requires re-certification.`);
    this.#chart = echarts.init(null, null, { renderer: "svg", ssr: true, width: 1, height: 1 });
  }

  certify(frame: unknown): ChartIrBarRectCertifyResult {
    const checked = validateFrame(frame);
    if (!checked.ok) return failure(checked.code, checked.message, this.#epoch, this.#outputHash);
    const { ir, width, height } = checked.value;
    const dataset = ir.datasets.find(item => item.id === ir.series[0]?.datasetId);
    if (!dataset) return failure("invalid-input", "Missing chart dataset.", this.#epoch, this.#outputHash);
    const signature = JSON.stringify(dataset.rows.map(row => row[0]));
    if (this.#categorySignature !== null && signature !== this.#categorySignature)
      return failure("blocked-capability", "Category rows must stay shape-stable across frames; category resize is outside this certification.", this.#epoch, this.#outputHash);
    const started = performance.now();
    try {
      // 与正式静态路径同一窗口投影：先 $.dataZoom 后 $.actions，latest-wins；
      // 运行期呈现类 action 登记 deferred（不进入 rect 几何，正式路径已证明像素一致）。
      const state = initialChartState(ir);
      const violations = subsetViolations(ir, state.zoomWindows);
      if (violations.length > 0) return failure("blocked-capability", `ChartIR is outside the certified subset: ${violations.join("; ")}`, this.#epoch, this.#outputHash);
      const expected = expectedBarRects(ir, width, height, state.zoomWindows);
      const projection = projectChartIrBarOption(ir, width, height, state.zoomWindows);
      const epsilon = 1e-9;
      const outside = projection.visibleValues.find(value => value < projection.yDomain[0] - epsilon || value > projection.yDomain[1] + epsilon);
      if (outside !== undefined)
        return failure("blocked-capability", `Bar value ${outside} falls outside the certified y domain [${projection.yDomain[0]}, ${projection.yDomain[1]}]; clipped out-of-domain bars are not certifiable.`, this.#epoch, this.#outputHash);
      this.#chart.resize({ width, height });
      this.#chart.setOption(projection.option, { lazyUpdate: false, silent: true });
      const observed = observedRects(this.#chart, expected.length);
      const matched = matchesExpectation(observed, expected);
      if (!matched) {
        const byX = [...expected].sort((a, b) => a.x - b.x);
        const detail = byX.map((item, position) => {
          const seen = observed[position];
          return seen ? `${item.id}: expected(${item.x},${item.y},${item.width},${item.height}) actual(${seen.x},${seen.y},${seen.width},${seen.height})` : `${item.id}: missing`;
        }).join("; ");
        throw new Error(`ZRender rects deviate from the expected ChartIR mapping beyond the golden tolerance: ${detail}`);
      }
      const computeMs = performance.now() - started;
      if (computeMs > CHARTIR_BAR_RECT_BUDGETS.maxComputeMs) return failure("deadline-exceeded", `Frame exceeded ${CHARTIR_BAR_RECT_BUDGETS.maxComputeMs} ms.`, this.#epoch, this.#outputHash);
      const byX = [...expected].sort((a, b) => a.x - b.x);
      const actual = observed.map((item, position) => ({ ...item, id: byX[position]!.id }));
      const byId = [...expected].sort((a, b) => Number(a.id.slice(4)) - Number(b.id.slice(4)));
      const outputHash = runtimeContentSha256(byId);
      this.#epoch += 1;
      this.#outputHash = outputHash;
      this.#categorySignature = signature;
      return {
        ok: true,
        projection,
        frame: {
          label: checked.value.label ?? `frame.${this.#epoch}`,
          epoch: this.#epoch,
          inputHash: checked.inputHash,
          outputHash,
          rectCount: expected.length,
          expected,
          actual,
          matched,
          deferredActions: state.deferredActions,
          computeMs,
        },
      };
    } catch (error) {
      return failure("renderer-failed", error instanceof Error ? error.message : "ECharts/ZRender frame failed.", this.#epoch, this.#outputHash);
    }
  }

  dispose(): void {
    this.#chart.dispose();
  }
}

export const CHARTIR_BAR_RECT_BLOCKED_CAPABILITIES = BLOCKED;
