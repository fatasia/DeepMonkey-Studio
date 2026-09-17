import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileChartSpec, type ChartIR, type ChartSpec } from "@bim-studio/deep-engine";
import {
  CHARTIR_BAR_RECT_BLOCKED_CAPABILITIES,
  CHARTIR_BAR_RECT_BUDGETS,
  CHARTIR_BAR_RECT_CAPABILITIES,
  CHARTIR_BAR_RECT_DEPENDENCIES,
  CHARTIR_BAR_RECT_FROZEN_FILL,
  CHARTIR_BAR_RECT_FROZEN_Z_ORDER,
  CHARTIR_BAR_RECT_TOLERANCE,
  expectedBarRects,
  ZRenderChartIrBarRectCertification,
} from "./zrenderChartIrBarRectCertification";
import * as echarts from "echarts";

/**
 * P2-02 受限认证 lane 测试（2026-09-18）：证明「冻结的 ZRender 6.1.0 动态 bar rect 子集」
 * 的确定性映射。期望 rect 由 chart-web-geometry golden 同一参照（chartPlot/cartesian/
 * zoomDomain）推导；真实 ECharts SSR 实例被测。证据落 test-output/p02-zrender-20260918/。
 * 认证是版本锁定的：ECharts/ZRender 升级即失效，须按本文件全量重认证。
 */

const here = resolve(__dirname);
const outputDirectory = resolve(here, "../../../../test-output/p02-zrender-20260918");
const PLOT: [number, number, number, number] = [8, 8, 304, 164];

function barSpec(rows: Array<[string, number]>, extra: Partial<ChartSpec> = {}): ChartSpec {
  return {
    schemaVersion: 1,
    id: "cert.bars",
    datasets: [{ id: "data", dimensions: ["x", "y"], rows }],
    axes: [
      { id: "x", channel: "x", scale: "category" },
      { id: "y", channel: "y", scale: "linear", min: 0, max: 10 },
    ],
    // 子集约束：legend 必须 false（默认编译为 visible:true，会引入非 rect 图例元素）。
    legend: { visible: false, position: "bottom" },
    series: [{ id: "bars", label: "Bars", type: "bar", datasetId: "data", x: "x", y: "y", xAxisId: "x", yAxisId: "y" }],
    ...extra,
  };
}

function compile(spec: ChartSpec): ChartIR {
  const compiled = compileChartSpec(spec);
  if (!compiled.ok || !compiled.ir) throw new Error(JSON.stringify(compiled.diagnostics));
  return compiled.ir;
}

const INITIAL_ROWS: Array<[string, number]> = [["A", 3], ["B", 7], ["C", 2], ["D", 9], ["E", 5]];
const frame = (ir: ChartIR, label?: string) => ({ ...(label === undefined ? {} : { label }), ir, width: 320, height: 180 });

const instances: ZRenderChartIrBarRectCertification[] = [];
const create = () => {
  const instance = new ZRenderChartIrBarRectCertification();
  instances.push(instance);
  return instance;
};
const expectFrame = (result: ReturnType<ZRenderChartIrBarRectCertification["certify"]>) => {
  expect(result.ok, result.ok ? undefined : JSON.stringify(result, null, 1)).toBe(true);
  if (!result.ok) throw new Error(result.message);
  return result.frame;
};

afterEach(() => {
  for (const instance of instances.splice(0)) instance.dispose();
});

describe("ChartIR bar-rect certification subset", () => {
  it("pins the version-locked dependency profile and the golden tolerance", () => {
    expect(CHARTIR_BAR_RECT_DEPENDENCIES).toEqual({ echarts: "6.1.0", zrender: "6.1.0" });
    expect(echarts.version).toBe("6.1.0");
    expect(CHARTIR_BAR_RECT_TOLERANCE).toBe(1e-9);
    expect(CHARTIR_BAR_RECT_FROZEN_Z_ORDER).toBe(2_000_001);
    expect(CHARTIR_BAR_RECT_FROZEN_FILL).toBe("#5070dd");
  });

  it("matches the expected ChartIR mapping value-by-value on the initial frame", () => {
    const frameResult = expectFrame(create().certify(frame(compile(barSpec(INITIAL_ROWS)), "initial")));
    expect(frameResult.rectCount).toBe(5);
    expect(frameResult.matched).toBe(true);
    // Native 同构公式：band=304/5=60.8，中心 x=8+(i+0.5)*60.8，rect x=中心-0.4*band。
    expect(frameResult.expected[0]).toEqual({
      id: "bar.0", x: 14.079999999999998, y: 172, width: 48.64, height: -49.19999999999999,
      fill: [0x50 / 255, 0x70 / 255, 0xdd / 255, 1], zOrder: 2_000_001,
    });
    expect(frameResult.actual[0]!.x).toBeCloseTo(14.08, 9);
    expect(frameResult.actual[0]!.height).toBeCloseTo(-49.2, 9);
    expect(frameResult.deferredActions).toEqual([]);
  });

  it("recertifies deterministically after a same-shape dynamic data replace", () => {
    const lane = create();
    const initial = expectFrame(lane.certify(frame(compile(barSpec(INITIAL_ROWS)), "initial")));
    const replaced = expectFrame(lane.certify(frame(compile(barSpec([["A", 6], ["B", 1], ["C", 8], ["D", 4], ["E", 0]])), "replace")));
    const repeated = expectFrame(lane.certify(frame(compile(barSpec([["A", 6], ["B", 1], ["C", 8], ["D", 4], ["E", 0]])), "repeat")));
    expect(replaced.epoch).toBe(2);
    expect(replaced.matched).toBe(true);
    expect(replaced.expected.map(rect => rect.id)).toEqual(["bar.0", "bar.1", "bar.2", "bar.3", "bar.4"]);
    expect(replaced.expected[0]!.height).toBeCloseTo(-98.4, 9);
    expect(replaced.expected[1]!.height).toBeCloseTo(-16.4, 9);
    // 零值 bar 保留为零高度 rect（ZRender 子集合同；与静态路径剔除规则不同，两侧各自锁定）。
    expect(replaced.expected[4]!.height).toBe(0);
    expect(replaced.actual[4]!.height).toBe(0);
    expect(replaced.outputHash).not.toBe(initial.outputHash);
    expect(replaced.inputHash).not.toBe(initial.inputHash);
    expect(repeated.epoch).toBe(3);
    expect(repeated.inputHash).toBe(replaced.inputHash);
    expect(repeated.outputHash).toBe(replaced.outputHash);
    expect(repeated.actual).toEqual(replaced.actual);
  });

  it("recertifies the rect set after a category-aligned dataZoom window via the Native banded formula", () => {
    const lane = create();
    const zoomed = compile(barSpec(INITIAL_ROWS, { dataZoom: [{ id: "zoom", axisId: "x", start: 20, end: 80, mode: "inside" }] }));
    const frameResult = expectFrame(lane.certify(frame(zoomed, "x-window")));
    // Native 行带窗口：first=0.2*5=1，span=0.6*5=3，band=304/3；可见类目 i∈[1,3]。
    expect(frameResult.rectCount).toBe(3);
    expect(frameResult.matched).toBe(true);
    expect(frameResult.expected.map(rect => rect.id)).toEqual(["bar.1", "bar.2", "bar.3"]);
    expect(frameResult.expected[0]!.width).toBeCloseTo(304 / 3 * 0.8, 9);
    expect(frameResult.expected[0]!.x).toBeCloseTo(8 + (1.5 - 1) / 3 * 304 - 304 / 3 * 0.4, 9);
    // 非对齐窗口（first=1.25）被整体拒绝：连续行带偏移无法投影为等分基元，
    // ECharts dataZoom 组件语义实测又不一致（见 blocked 登记），不冒充认证。
    const fractional = compile(barSpec(INITIAL_ROWS, { dataZoom: [{ id: "zoom", axisId: "x", start: 25, end: 75, mode: "inside" }] }));
    expect(lane.certify(frame(fractional, "x-window-fractional"))).toMatchObject({ ok: false, code: "blocked-capability", retainedEpoch: 1 });
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "echarts-datazoom-window-semantics", status: "blocked" }));
  });

  it("recertifies bar heights after a numeric y-axis window (zoomDomain interpolation, signed heights)", () => {
    const lane = create();
    const zoomed = compile(barSpec([["A", 3], ["B", 7], ["C", 5]], { dataZoom: [{ id: "zoom", axisId: "y", start: 25, end: 75, mode: "inside" }] }));
    const frameResult = expectFrame(lane.certify(frame(zoomed, "y-window")));
    // 域 [0,10]×(0.25,0.75) → [2.5,7.5]；0 在窗口域下方 → baseline=ym(0) 被 clamp 到 plot 底 172。
    expect(frameResult.matched).toBe(true);
    expect(frameResult.expected.map(rect => rect.height)[0]).toBeCloseTo(-16.4, 9);
    expect(frameResult.expected.map(rect => rect.height)[1]).toBeCloseTo(-147.6, 9);
    expect(frameResult.expected.map(rect => rect.height)[2]).toBeCloseTo(-82, 9);
    expect(frameResult.rectCount).toBe(3);
  });

  it("produces identical hash streams across isolated instances (dual-run determinism)", () => {
    const rows: Array<Array<[string, number]>> = [
      INITIAL_ROWS,
      [["A", 6], ["B", 1], ["C", 8], ["D", 4], ["E", 2]],
      [["A", 2], ["B", 5], ["C", 9], ["D", 1], ["E", 7]],
    ];
    const hashes = [create(), create(), create()].map(lane =>
      rows.map(step => expectFrame(lane.certify(frame(compile(barSpec(step))))).outputHash));
    expect(hashes[0]).toEqual(hashes[1]);
    expect(hashes[0]).toEqual(hashes[2]);
    expect(new Set(hashes[0]).size).toBe(3);
  });

  it("keeps tooltip state and runtime-only actions out of the rect geometry while registering them", () => {
    const plain = compile(barSpec(INITIAL_ROWS));
    const withTooltip = compile(barSpec(INITIAL_ROWS, { tooltip: { enabled: true, trigger: "axis" } }));
    const withActions = { ...plain, actions: [{ type: "highlight", seriesId: "bars", dataIndex: 2 } as const] };
    const lane = create();
    const base = expectFrame(lane.certify(frame(plain, "plain")));
    const tooltip = expectFrame(lane.certify(frame(withTooltip, "tooltip")));
    const actioned = expectFrame(lane.certify(frame(withActions, "actions")));
    expect(tooltip.actual).toEqual(base.actual);
    expect(tooltip.outputHash).toBe(base.outputHash);
    expect(actioned.actual).toEqual(base.actual);
    expect(actioned.outputHash).toBe(base.outputHash);
    expect(actioned.deferredActions).toEqual([{
      path: "$.actions[0]", type: "highlight",
      reason: "runtime-only emphasis/selection outline; static frame pixels match Native render_chart_with_windows",
    }]);
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "tooltip", status: "blocked" }));
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "animation", status: "blocked" }));
  });

  it.each(["line", "scatter"] as const)("rejects the non-rect %s series at the subset layer instead of emitting partial rects", kind => {
    const spec = barSpec(INITIAL_ROWS);
    const ir = { ...compile(spec), series: [{ ...spec.series[0]!, type: kind } as unknown as typeof spec.series[0]] };
    // line/scatter 与 bar 共享笛卡尔字段，ChartIR 合法 → 由子集约束层拒绝。
    const result = create().certify(frame(ir, `non-rect-${kind}`));
    expect(result).toMatchObject({ ok: false, code: "blocked-capability", retainedEpoch: 0, retainedOutputHash: null });
    if (!result.ok) expect(result.message).toContain(`type ${kind}`);
  });

  it.each(["pie", "heatmap", "gauge"] as const)("rejects the non-rect %s series at the closed ChartIR schema layer", kind => {
    const spec = barSpec(INITIAL_ROWS);
    const ir = { ...compile(spec), series: [{ ...spec.series[0]!, type: kind } as unknown as typeof spec.series[0]] };
    // pie/heatmap/gauge 需要各自字段（name/value 等），封闭 schema 在 validate 层就拒绝。
    const result = create().certify(frame(ir, `non-rect-${kind}`));
    expect(result).toMatchObject({ ok: false, code: "invalid-input", retainedEpoch: 0, retainedOutputHash: null });
  });

  it("rejects legend frames and category resize as blocked capabilities without advancing the epoch", () => {
    const lane = create();
    expectFrame(lane.certify(frame(compile(barSpec(INITIAL_ROWS)), "initial")));
    const legend = { ...compile(barSpec(INITIAL_ROWS)), legend: { visible: true, position: "top" as const } };
    expect(lane.certify(frame(legend, "legend"))).toMatchObject({ ok: false, code: "blocked-capability", retainedEpoch: 1 });
    const resized = compile(barSpec([["A", 3], ["B", 7]]));
    expect(lane.certify(frame(resized, "resize"))).toMatchObject({ ok: false, code: "blocked-capability", retainedEpoch: 1 });
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "legend-and-text", status: "blocked" }));
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "category-resize", status: "blocked" }));
  });

  it("rejects values outside the certified y domain (ECharts clips bars; the Native formula maps continuously)", () => {
    const lane = create();
    expectFrame(lane.certify(frame(compile(barSpec(INITIAL_ROWS)), "initial")));
    // 显式域 [0,10] 内合法；值 12 越界 → 拒绝且不推进 epoch（ECharts clip 语义与公式不一致）。
    expect(lane.certify(frame(compile(barSpec([["A", 12], ["B", 7], ["C", 2], ["D", 9], ["E", 5]])), "out-of-domain")))
      .toMatchObject({ ok: false, code: "blocked-capability", retainedEpoch: 1 });
    expect(CHARTIR_BAR_RECT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature: "clipped-out-of-domain-bars", status: "blocked" }));
  });

  it("rejects formatter functions, image fields and malformed frames at the closed ChartIR boundary", () => {
    const formatterSpec = barSpec(INITIAL_ROWS) as unknown as Record<string, unknown>;
    formatterSpec.formatter = (value: unknown) => String(value);
    const formatterDiagnostics = compileChartSpec(formatterSpec as unknown as ChartSpec);
    expect(formatterDiagnostics.ok).toBe(false);
    expect(JSON.stringify(formatterDiagnostics.diagnostics)).toMatch(/plain JSON value without functions|unknown-field/);
    const imageSpec = { ...barSpec(INITIAL_ROWS), image: "asset://banner.png" } as unknown as ChartSpec;
    expect(compileChartSpec(imageSpec).ok).toBe(false);
    const lane = create();
    expect(lane.certify(frame(compile(barSpec(INITIAL_ROWS)), "initial"))).toMatchObject({ ok: true });
    expect(lane.certify({ ir: formatterSpec, width: 320, height: 180 })).toMatchObject({ ok: false, code: "invalid-input", retainedEpoch: 1 });
    expect(lane.certify({ ir: compile(barSpec(INITIAL_ROWS)), width: 320, height: 180, extra: true })).toMatchObject({ ok: false, code: "invalid-input", retainedEpoch: 1 });
    expect(lane.certify(frame(compile(barSpec(Array.from({ length: 257 }, (_, index) => [`C${index}`, index % 10] as [string, number]))), "budget")))
      .toMatchObject({ ok: false, code: "budget-exceeded", retainedEpoch: 1 });
    expect(CHARTIR_BAR_RECT_BUDGETS.maxBars).toBe(256);
    expect(CHARTIR_BAR_RECT_BLOCKED_CAPABILITIES).toContain("formatter");
    expect(CHARTIR_BAR_RECT_BLOCKED_CAPABILITIES).toContain("image");
  });
});

it("writes the certification evidence bundle", () => {
  const lane = create();
  const steps: Array<{ readonly label: string; readonly ir: ChartIR }> = [
    { label: "initial", ir: compile(barSpec(INITIAL_ROWS)) },
    { label: "data-replace", ir: compile(barSpec([["A", 6], ["B", 1], ["C", 8], ["D", 4], ["E", 2]])) },
    { label: "x-window-aligned", ir: compile(barSpec(INITIAL_ROWS, { dataZoom: [{ id: "zoom", axisId: "x", start: 20, end: 80, mode: "inside" }] })) },
    { label: "y-window-interpolated", ir: compile(barSpec([["A", 3], ["B", 7], ["C", 5], ["D", 4], ["E", 5]], { dataZoom: [{ id: "zoom", axisId: "y", start: 25, end: 75, mode: "inside" }] })) },
  ];
  const frames = steps.map(step => {
    const result = lane.certify(frame(step.ir, step.label));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.message);
    return result.frame;
  });
  const evidence = {
    profile: "chartir-bar-rect-v1",
    date: "2026-09-18",
    versionLockedDependencies: { ...CHARTIR_BAR_RECT_DEPENDENCIES, note: "升级即失效，须按 zrenderChartIrRectCertification 全量重认证" },
    budgets: CHARTIR_BAR_RECT_BUDGETS,
    tolerance: { value: CHARTIR_BAR_RECT_TOLERANCE, rule: "1e-9 * max(1, |expected|), same as chart-web-geometry golden equivalent()" },
    frozenFill: CHARTIR_BAR_RECT_FROZEN_FILL,
    frozenZOrder: CHARTIR_BAR_RECT_FROZEN_Z_ORDER,
    blockedCapabilities: CHARTIR_BAR_RECT_CAPABILITIES,
    frames: frames.map(({ label, epoch, inputHash, outputHash, rectCount, matched, expected, actual, computeMs }) =>
      ({ label, epoch, inputHash, outputHash, rectCount, matched, computeMs, expected, actual })),
    deterministicStreams: [
      [create(), create()].map(lane => steps.map(step => expectFrame(lane.certify(frame(step.ir, step.label))).outputHash)),
    ],
  };
  expect(evidence.frames.every(item => item.matched)).toBe(true);
  expect(evidence.deterministicStreams[0]![0]).toEqual(evidence.deterministicStreams[0]![1]);
  expect(evidence.deterministicStreams[0]![0]).toEqual(frames.map(item => item.outputHash));
  mkdirSync(outputDirectory, { recursive: true });
  writeFileSync(resolve(outputDirectory, "certification-evidence.json"), JSON.stringify(evidence, null, 2));
});
