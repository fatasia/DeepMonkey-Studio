import { runtimeContentSha256 } from "@bim-studio/deep-engine";
import * as echarts from "echarts";
import type { ECharts, EChartsOption } from "echarts";

export const ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES = Object.freeze({
  echarts: "6.1.0",
  zrender: "6.1.0",
} as const);

export const ZRENDER_PAINTER_EXPERIMENT_BUDGETS = Object.freeze({
  maxBars: 256,
  maxCategoryCodeUnits: 256,
  maxInputBytes: 64 * 1024,
  maxCommandsPerFrame: 512,
  maxComputeMs: 250,
  targetComputeMs: 16,
} as const);

export type ZRenderPainterExperimentFeature = "formatter" | "image" | "tooltip" | "animation";

export const ZRENDER_PAINTER_EXPERIMENT_CAPABILITIES = Object.freeze([
  { feature: "dynamic-bar", status: "supported", detail: "ECharts computes bounded bar geometry in SVG SSR mode; ZRender storage is lowered to rect deltas." },
  { feature: "formatter", status: "blocked", detail: "Formatter functions are executable JavaScript and are outside the bounded input contract." },
  { feature: "image", status: "blocked", detail: "Image loading, decoding and asset identity are not covered by this rect-only experiment." },
  { feature: "tooltip", status: "blocked", detail: "Tooltip interaction and DOM overlays are not available in the headless SSR experiment." },
  { feature: "animation", status: "blocked", detail: "Intermediate animation frames and scheduler timing are not captured; animation is forced off." },
] as const);

export interface DynamicBarFrameInput {
  readonly chartId: string;
  readonly categories: readonly string[];
  readonly values: readonly number[];
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly domainMax: number;
  readonly color: string;
  readonly requestedFeatures?: readonly ZRenderPainterExperimentFeature[];
}

export interface ChartRectCommand {
  readonly op: "upsert-rect";
  readonly id: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: readonly [number, number, number, number];
  readonly zOrder: number;
}

export interface ChartRemoveCommand {
  readonly op: "remove";
  readonly id: string;
}

export type ChartCommand = ChartRectCommand | ChartRemoveCommand;

export interface ChartCommandBatch {
  readonly schemaVersion: 1;
  readonly chartId: string;
  readonly epoch: number;
  readonly inputHash: string;
  /** Hash of the complete committed rect snapshot, not merely this frame's delta. */
  readonly outputHash: string;
  readonly commands: readonly ChartCommand[];
  readonly retainedRectCount: number;
  readonly computeMs: number;
  readonly dependencies: typeof ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES;
  readonly budgets: typeof ZRENDER_PAINTER_EXPERIMENT_BUDGETS;
  readonly blockedCapabilities: readonly ZRenderPainterExperimentFeature[];
}

export type ChartCommandBatchFailureCode =
  | "blocked-capability"
  | "invalid-input"
  | "budget-exceeded"
  | "deadline-exceeded"
  | "renderer-failed";

export type ChartCommandBatchResult =
  | { readonly ok: true; readonly batch: ChartCommandBatch }
  | {
      readonly ok: false;
      readonly error: { readonly code: ChartCommandBatchFailureCode; readonly message: string };
      readonly retainedEpoch: number;
      readonly retainedOutputHash: string | null;
    };

interface RectSnapshot {
  readonly id: string;
  readonly category: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly fill: readonly [number, number, number, number];
  readonly zOrder: number;
}

interface ZRenderDisplayableLike {
  readonly type?: unknown;
  readonly shape?: Readonly<Record<string, unknown>>;
  readonly style?: Readonly<Record<string, unknown>>;
  readonly z?: unknown;
  readonly z2?: unknown;
}

const BLOCKED_CAPABILITIES = ZRENDER_PAINTER_EXPERIMENT_CAPABILITIES
  .filter((item): item is Extract<(typeof ZRENDER_PAINTER_EXPERIMENT_CAPABILITIES)[number], { status: "blocked" }> => item.status === "blocked")
  .map(item => item.feature);
const ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const HEX_COLOR = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i;
const INPUT_KEYS = new Set(["chartId", "categories", "values", "logicalWidth", "logicalHeight", "domainMax", "color", "requestedFeatures"]);

function failure(
  code: ChartCommandBatchFailureCode,
  message: string,
  retainedEpoch: number,
  retainedOutputHash: string | null,
): ChartCommandBatchResult {
  return { ok: false, error: { code, message }, retainedEpoch, retainedOutputHash };
}

function finitePositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= 16_777_216;
}

function dataPropertiesOnly(value: object): boolean {
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor => "value" in descriptor);
}

function denseDataArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || !dataPropertiesOnly(value)) return false;
  for (let index = 0; index < value.length; index += 1) if (!Object.hasOwn(value, index)) return false;
  return true;
}

function validateInput(input: unknown): { readonly ok: true; readonly value: DynamicBarFrameInput; readonly inputHash: string }
  | { readonly ok: false; readonly code: ChartCommandBatchFailureCode; readonly message: string } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, code: "invalid-input", message: "Expected a dynamic bar frame object." };
  }
  const prototype = Object.getPrototypeOf(input);
  if ((prototype !== Object.prototype && prototype !== null) || !dataPropertiesOnly(input)
    || Object.keys(input).some(key => !INPUT_KEYS.has(key))) {
    return { ok: false, code: "invalid-input", message: "Input must contain only the documented plain-data fields." };
  }
  const value = input as Partial<DynamicBarFrameInput>;
  if (typeof value.chartId !== "string" || !ID.test(value.chartId)) return { ok: false, code: "invalid-input", message: "chartId must be a stable ASCII identifier." };
  if (!denseDataArray(value.categories) || !denseDataArray(value.values) || value.categories.length !== value.values.length || value.categories.length === 0) {
    return { ok: false, code: "invalid-input", message: "categories and values must be non-empty arrays of equal length." };
  }
  if (value.categories.length > ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxBars) {
    return { ok: false, code: "budget-exceeded", message: `Bar count exceeds ${ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxBars}.` };
  }
  if (value.categories.some(category => typeof category !== "string" || category.length === 0 || category.length > ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxCategoryCodeUnits)) {
    return { ok: false, code: "invalid-input", message: "Category labels must be bounded non-empty strings." };
  }
  if (!finitePositive(value.domainMax) || value.values.some(item => typeof item !== "number" || !Number.isFinite(item) || item < 0 || item > value.domainMax!)) {
    return { ok: false, code: "invalid-input", message: "Values must be finite, non-negative and at most domainMax." };
  }
  if (!finitePositive(value.logicalWidth) || !finitePositive(value.logicalHeight)) return { ok: false, code: "invalid-input", message: "Logical dimensions must be positive and bounded." };
  if (typeof value.color !== "string" || !HEX_COLOR.test(value.color)) return { ok: false, code: "invalid-input", message: "color must use #RRGGBB or #RRGGBBAA." };
  if (value.requestedFeatures !== undefined && (!denseDataArray(value.requestedFeatures)
    || value.requestedFeatures.some(item => !BLOCKED_CAPABILITIES.includes(item as ZRenderPainterExperimentFeature)))) {
    return { ok: false, code: "invalid-input", message: "requestedFeatures contains an unknown capability." };
  }
  if (value.requestedFeatures && value.requestedFeatures.length > 0) {
    return { ok: false, code: "blocked-capability", message: `Unsupported experiment capability: ${value.requestedFeatures.join(", ")}.` };
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return { ok: false, code: "invalid-input", message: "Input must be JSON serializable." }; }
  if (new TextEncoder().encode(serialized).byteLength > ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxInputBytes) {
    return { ok: false, code: "budget-exceeded", message: `Input exceeds ${ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxInputBytes} bytes.` };
  }
  const normalized: DynamicBarFrameInput = {
    chartId: value.chartId,
    categories: [...value.categories],
    values: [...value.values],
    logicalWidth: value.logicalWidth,
    logicalHeight: value.logicalHeight,
    domainMax: value.domainMax,
    color: value.color.toLowerCase(),
    ...(value.requestedFeatures === undefined ? {} : { requestedFeatures: [...value.requestedFeatures] }),
  };
  return { ok: true, value: normalized, inputHash: runtimeContentSha256(normalized) };
}

function rgba(value: string): readonly [number, number, number, number] {
  const match = HEX_COLOR.exec(value);
  if (!match) throw new Error("ZRender emitted an unsupported fill color.");
  const rgb = match[1]!;
  const alpha = match[2] ?? "ff";
  return [Number.parseInt(rgb.slice(0, 2), 16) / 255, Number.parseInt(rgb.slice(2, 4), 16) / 255,
    Number.parseInt(rgb.slice(4, 6), 16) / 255, Number.parseInt(alpha, 16) / 255];
}

function number(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || Math.abs(value) > 16_777_216) throw new Error(`ZRender emitted invalid ${name}.`);
  return Object.is(value, -0) ? 0 : value;
}

function option(input: DynamicBarFrameInput): EChartsOption {
  return {
    animation: false,
    tooltip: { show: false },
    grid: { left: 0, right: 0, top: 0, bottom: 0 },
    xAxis: { type: "category", show: false, data: [...input.categories] },
    yAxis: { type: "value", show: false, min: 0, max: input.domainMax },
    series: [{ id: "dynamic-bar", type: "bar", silent: true, data: [...input.values], itemStyle: { color: input.color } }],
  };
}

function rectSnapshots(chart: ECharts, input: DynamicBarFrameInput): readonly RectSnapshot[] {
  const displayList = chart.getZr().storage.getDisplayList(true) as readonly ZRenderDisplayableLike[];
  if (displayList.some(item => item.type !== "rect")) throw new Error("ZRender emitted a non-rect displayable for the bounded bar sample.");
  if (displayList.length !== input.categories.length) throw new Error("ZRender rect count does not match the bounded bar input.");
  return displayList.map((item, index) => {
    const shape = item.shape ?? {};
    const style = item.style ?? {};
    if (typeof style.fill !== "string") throw new Error("ZRender emitted an unsupported rect fill.");
    return {
      id: `bar.${index}`,
      category: input.categories[index]!,
      x: number(shape.x, "rect.x"),
      y: number(shape.y, "rect.y"),
      width: number(shape.width, "rect.width"),
      height: number(shape.height, "rect.height"),
      fill: rgba(style.fill),
      zOrder: number(item.z ?? 0, "rect.z") * 1_000_000 + number(item.z2 ?? 0, "rect.z2"),
    };
  });
}

function diff(previous: ReadonlyMap<string, RectSnapshot>, current: readonly RectSnapshot[]): readonly ChartCommand[] {
  const next = new Map(current.map(item => [item.id, item]));
  const commands: ChartCommand[] = [];
  for (const item of current) {
    if (runtimeContentSha256(previous.get(item.id) ?? null) !== runtimeContentSha256(item)) commands.push({ op: "upsert-rect", ...item });
  }
  for (const id of previous.keys()) if (!next.has(id)) commands.push({ op: "remove", id });
  return commands;
}

/**
 * Isolated P2-02 probe. It keeps ECharts/ZRender outside N0 and accepts data only,
 * never an option object, callback, DOM node or script.
 */
export class ZRenderPainterCommandBatchExperiment {
  #chart: ECharts;
  #epoch = 0;
  #snapshot = new Map<string, RectSnapshot>();
  #outputHash: string | null = null;
  #lastInput: DynamicBarFrameInput | null = null;
  #chartId: string | null = null;

  constructor() {
    if (echarts.version !== ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES.echarts) {
      throw new Error(`Experiment requires ECharts ${ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES.echarts}; received ${echarts.version}.`);
    }
    this.#chart = this.#createChart();
  }

  #createChart(): ECharts {
    return echarts.init(null, null, { renderer: "svg", ssr: true, width: 1, height: 1 });
  }

  #restoreRenderer(): void {
    this.#chart.dispose();
    this.#chart = this.#createChart();
    if (this.#lastInput) {
      this.#chart.resize({ width: this.#lastInput.logicalWidth, height: this.#lastInput.logicalHeight });
      this.#chart.setOption(option(this.#lastInput), { lazyUpdate: false, silent: true });
    }
  }

  renderFrame(input: unknown): ChartCommandBatchResult {
    const checked = validateInput(input);
    if (!checked.ok) return failure(checked.code, checked.message, this.#epoch, this.#outputHash);
    if (this.#chartId !== null && checked.value.chartId !== this.#chartId) {
      return failure("invalid-input", "An experiment instance is bound to one chartId.", this.#epoch, this.#outputHash);
    }
    const started = performance.now();
    try {
      this.#chart.resize({ width: checked.value.logicalWidth, height: checked.value.logicalHeight });
      this.#chart.setOption(option(checked.value), { lazyUpdate: false, silent: true });
      const snapshot = rectSnapshots(this.#chart, checked.value);
      const commands = diff(this.#snapshot, snapshot);
      if (commands.length > ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxCommandsPerFrame) throw new RangeError("Command batch budget exceeded.");
      const computeMs = performance.now() - started;
      if (computeMs > ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxComputeMs) {
        this.#restoreRenderer();
        return failure("deadline-exceeded", `Frame exceeded ${ZRENDER_PAINTER_EXPERIMENT_BUDGETS.maxComputeMs} ms.`, this.#epoch, this.#outputHash);
      }
      const outputHash = runtimeContentSha256(snapshot);
      this.#snapshot = new Map(snapshot.map(item => [item.id, item]));
      this.#outputHash = outputHash;
      this.#lastInput = checked.value;
      this.#chartId = checked.value.chartId;
      this.#epoch += 1;
      return { ok: true, batch: {
        schemaVersion: 1,
        chartId: checked.value.chartId,
        epoch: this.#epoch,
        inputHash: checked.inputHash,
        outputHash,
        commands,
        retainedRectCount: snapshot.length,
        computeMs,
        dependencies: ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES,
        budgets: ZRENDER_PAINTER_EXPERIMENT_BUDGETS,
        blockedCapabilities: BLOCKED_CAPABILITIES,
      } };
    } catch (error) {
      try { this.#restoreRenderer(); } catch { /* The committed batch remains authoritative even when renderer recovery fails. */ }
      const code = error instanceof RangeError ? "budget-exceeded" : "renderer-failed";
      return failure(code, error instanceof Error ? error.message : "ECharts/ZRender frame failed.", this.#epoch, this.#outputHash);
    }
  }

  dispose(): void {
    this.#chart.dispose();
  }
}
