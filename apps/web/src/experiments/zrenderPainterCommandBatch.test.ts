import { afterEach, describe, expect, it } from "vitest";
import {
  ZRENDER_PAINTER_EXPERIMENT_CAPABILITIES,
  ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES,
  ZRenderPainterCommandBatchExperiment,
  type DynamicBarFrameInput,
} from "./zrenderPainterCommandBatch";

const experiments: ZRenderPainterCommandBatchExperiment[] = [];
const create = () => {
  const experiment = new ZRenderPainterCommandBatchExperiment();
  experiments.push(experiment);
  return experiment;
};
const frame = (overrides: Partial<DynamicBarFrameInput> = {}): DynamicBarFrameInput => ({
  chartId: "p2-02.dynamic-bar",
  categories: ["A", "B", "C"],
  values: [12, 24, 18],
  logicalWidth: 320,
  logicalHeight: 180,
  domainMax: 30,
  color: "#5070dd",
  ...overrides,
});

afterEach(() => {
  for (const experiment of experiments.splice(0)) experiment.dispose();
});

describe("ZRenderPainterCommandBatchExperiment", () => {
  it("runs the pinned ECharts/ZRender SSR calculation and emits a hashed initial rect batch", () => {
    const result = create().renderFrame(frame());
    expect(ZRENDER_PAINTER_EXPERIMENT_DEPENDENCIES).toEqual({ echarts: "6.1.0", zrender: "6.1.0" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.epoch).toBe(1);
    expect(result.batch.inputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.batch.outputHash).toMatch(/^[0-9a-f]{64}$/);
    expect(result.batch.retainedRectCount).toBe(3);
    expect(result.batch.commands.map(command => [command.op, command.id])).toEqual([
      ["upsert-rect", "bar.0"], ["upsert-rect", "bar.1"], ["upsert-rect", "bar.2"],
    ]);
    expect(result.batch.commands[0]).toMatchObject({ category: "A", x: 16.53333333333334, y: 180, width: 73.6, height: -72 });
  });

  it("emits only the changed bar on a dynamic data frame and is deterministic for repeats", () => {
    const experiment = create();
    const initial = experiment.renderFrame(frame());
    const update = experiment.renderFrame(frame({ values: [12, 15, 18] }));
    const repeat = experiment.renderFrame(frame({ values: [12, 15, 18] }));
    expect(initial.ok && update.ok && repeat.ok).toBe(true);
    if (!initial.ok || !update.ok || !repeat.ok) return;
    expect(update.batch.epoch).toBe(2);
    expect(update.batch.commands.map(command => command.id)).toEqual(["bar.1"]);
    expect(update.batch.outputHash).not.toBe(initial.batch.outputHash);
    expect(repeat.batch.commands).toEqual([]);
    expect(repeat.batch.inputHash).toBe(update.batch.inputHash);
    expect(repeat.batch.outputHash).toBe(update.batch.outputHash);
  });

  it("emits removal commands when the bounded series shrinks", () => {
    const experiment = create();
    experiment.renderFrame(frame());
    const result = experiment.renderFrame(frame({ categories: ["A", "B"], values: [12, 24] }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.batch.commands.some(command => command.op === "remove" && command.id === "bar.2")).toBe(true);
    expect(result.batch.retainedRectCount).toBe(2);
  });

  it.each(["formatter", "image", "tooltip", "animation"] as const)("blocks %s and retains the previous committed epoch", feature => {
    const experiment = create();
    const committed = experiment.renderFrame(frame());
    const blocked = experiment.renderFrame(frame({ values: [1, 2, 3], requestedFeatures: [feature] }));
    expect(committed.ok).toBe(true);
    expect(blocked).toMatchObject({ ok: false, error: { code: "blocked-capability" }, retainedEpoch: 1 });
    expect(ZRENDER_PAINTER_EXPERIMENT_CAPABILITIES).toContainEqual(expect.objectContaining({ feature, status: "blocked" }));
    if (committed.ok && !blocked.ok) expect(blocked.retainedOutputHash).toBe(committed.batch.outputHash);
  });

  it("rejects over-budget or invalid frames without advancing the committed epoch", () => {
    const experiment = create();
    const committed = experiment.renderFrame(frame());
    const tooMany = experiment.renderFrame(frame({
      categories: Array.from({ length: 257 }, (_, index) => `C${index}`),
      values: Array.from({ length: 257 }, () => 1),
    }));
    const invalid = experiment.renderFrame(frame({ values: [12, Number.NaN, 18] }));
    expect(tooMany).toMatchObject({ ok: false, error: { code: "budget-exceeded" }, retainedEpoch: 1 });
    expect(invalid).toMatchObject({ ok: false, error: { code: "invalid-input" }, retainedEpoch: 1 });
    if (committed.ok && !tooMany.ok && !invalid.ok) {
      expect(tooMany.retainedOutputHash).toBe(committed.batch.outputHash);
      expect(invalid.retainedOutputHash).toBe(committed.batch.outputHash);
    }
  });

  it("rejects option objects and executable properties at the plain-data boundary", () => {
    const experiment = create();
    const extraOption = experiment.renderFrame({ ...frame(), option: { series: [] } });
    const executable = experiment.renderFrame(Object.defineProperty({ ...frame() }, "values", {
      enumerable: true,
      get: () => [1, 2, 3],
    }));
    expect(extraOption).toMatchObject({ ok: false, error: { code: "invalid-input" }, retainedEpoch: 0 });
    expect(executable).toMatchObject({ ok: false, error: { code: "invalid-input" }, retainedEpoch: 0 });
  });

  it("does not reuse one chart's delta state for another chart id", () => {
    const experiment = create();
    const committed = experiment.renderFrame(frame());
    const otherChart = experiment.renderFrame(frame({ chartId: "p2-02.other" }));
    expect(otherChart).toMatchObject({ ok: false, error: { code: "invalid-input" }, retainedEpoch: 1 });
    if (committed.ok && !otherChart.ok) expect(otherChart.retainedOutputHash).toBe(committed.batch.outputHash);
  });
});
