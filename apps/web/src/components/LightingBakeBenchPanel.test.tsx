import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { StudioQualityTelemetryStatus } from "../viewer/StudioDeepQualityTelemetry";
import { BAKE_CHECK_WINDOW_MS, INITIAL_BAKE_BENCH_STATE, gpuBakeShare, readSdfGiMetrics,
  reduceBakeBench, type SdfGiBakeMetrics } from "./bakeBenchModel";
import { LightingBakeBenchPanel } from "./LightingBakeBenchPanel";

// 桥模块含 three.js 重依赖;面板测试只消费注册表读取函数,用 hoisted 状态注入。
const state = vi.hoisted(() => ({ status: undefined as StudioQualityTelemetryStatus | undefined }));
vi.mock("../viewer/StudioDeepQualityTelemetry", () => ({
  readStudioQualityTelemetry: () => state.status,
}));

const LOCALE = "zh-CN" as const;

function sdfGiMetrics(overrides: Partial<SdfGiBakeMetrics> = {}): SdfGiBakeMetrics {
  return { sdfGiBakes: 3, sdfGiBakesGpu: 3, sdfGiBakeCells: 60_192, sdfGiProbeCount: 1_024,
    sdfGiProbesUpdated: 64, sdfGiProbeWindowOffset: 0, sdfGiSkyTraceDispatches: 3,
    sdfGiPublishDispatches: 180, ddgiUpdateBudget: 64, ...overrides };
}

function telemetryWithSdfGi(): StudioQualityTelemetryStatus {
  // 面板只读 latestSdfGi 字段;其余字段不属于本面板消费面。
  return { latestSdfGi: sdfGiMetrics() } as StudioQualityTelemetryStatus;
}

function renderPanel(viewportRef: React.RefObject<HTMLElement | null> = { current: null }): string {
  return renderToStaticMarkup(
    <LightingBakeBenchPanel locale={LOCALE} engine={undefined} viewportRef={viewportRef}
      onClose={() => undefined} />,
  );
}

describe("bakeBenchModel 状态机(干净/烘焙中/完成/未开启)", () => {
  const metrics = sdfGiMetrics();

  it("未开启:遥测缺失时保持 gi-disabled;check-started 不生效(fail-closed)", () => {
    const disabled = reduceBakeBench(INITIAL_BAKE_BENCH_STATE, { type: "tick", atMs: 1, metrics: undefined });
    expect(disabled.phase.kind).toBe("gi-disabled");
    const refused = reduceBakeBench(disabled, { type: "check-started", atMs: 2 });
    expect(refused.phase.kind).toBe("gi-disabled");
    // 遥测恢复(开启 sdf-gi)后自动离开未开启态。
    const enabled = reduceBakeBench(disabled, { type: "tick", atMs: 3, metrics });
    expect(enabled.phase.kind).toBe("idle");
    expect(enabled.lastSeenBakes).toBe(3);
  });

  it("干净→烘焙中→完成:计数器推进即产出 fresh 记录(GPU 口径),再一 tick 归位干净", () => {
    const idle = reduceBakeBench(INITIAL_BAKE_BENCH_STATE, { type: "tick", atMs: 1, metrics });
    const checking = reduceBakeBench(idle, { type: "check-started", atMs: 2 });
    expect(checking.phase.kind).toBe("checking");
    // 观察窗内计数未推进:保持烘焙中,不产出伪完成。
    const waiting = reduceBakeBench(checking, { type: "tick", atMs: 3, metrics });
    expect(waiting.phase.kind).toBe("checking");
    // 计数推进(场景 dirty 烘焙发生):fresh + 记录;GPU 计数等于烘焙序号 = GPU 路径。
    const baked = reduceBakeBench(waiting, {
      type: "tick", atMs: 4, metrics: sdfGiMetrics({ sdfGiBakes: 4, sdfGiBakesGpu: 4, sdfGiBakeCells: 61_000 }) });
    expect(baked.phase.kind).toBe("fresh");
    if (baked.phase.kind !== "fresh") return;
    expect(baked.phase.record).toMatchObject({ bakeIndex: 4, gpuBaked: true, cells: 61_000 });
    expect(baked.lastBake?.bakeIndex).toBe(4);
    // 结果提示驻留:例行 tick 不冲掉 fresh(操作者要能读到结论),摘要保留 lastBake。
    const settled = reduceBakeBench(baked, { type: "tick", atMs: 5, metrics: sdfGiMetrics({ sdfGiBakes: 4 }) });
    expect(settled.phase.kind).toBe("fresh");
    expect(settled.lastBake?.bakeIndex).toBe(4);
    // 下一次烘焙再次推进:fresh 更新为新记录。
    const again = reduceBakeBench(settled, {
      type: "tick", atMs: 6, metrics: sdfGiMetrics({ sdfGiBakes: 5, sdfGiBakesGpu: 5 }) });
    expect(again.phase.kind).toBe("fresh");
    if (again.phase.kind !== "fresh") return;
    expect(again.phase.record.bakeIndex).toBe(5);
  });

  it("已是最新:观察窗超时且计数未推进 → up-to-date;CPU 回退口径如实区分", () => {
    const idle = reduceBakeBench(INITIAL_BAKE_BENCH_STATE, { type: "tick", atMs: 1, metrics });
    const checking = reduceBakeBench(idle, { type: "check-started", atMs: 2 });
    const upToDate = reduceBakeBench(checking, { type: "check-timeout", atMs: 2 + BAKE_CHECK_WINDOW_MS });
    expect(upToDate.phase.kind).toBe("up-to-date");
    // 计数回退(后端重建)→ 旧运行时烘焙记录如实清空,回就绪。
    const rebuilt = reduceBakeBench(upToDate, {
      type: "tick", atMs: 7, metrics: sdfGiMetrics({ sdfGiBakes: 1, sdfGiBakesGpu: 1 }) });
    expect(rebuilt.phase.kind).toBe("idle");
    expect(rebuilt.lastBake).toBeUndefined();
    expect(rebuilt.lastSeenBakes).toBe(1);
    // CPU 回退:GPU 计数落后烘焙序号 → gpuBaked=false。
    const cpuBaked = reduceBakeBench(idle, {
      type: "tick", atMs: 3, metrics: sdfGiMetrics({ sdfGiBakes: 4, sdfGiBakesGpu: 3 }) });
    if (cpuBaked.phase.kind !== "fresh") return;
    expect(cpuBaked.phase.record.gpuBaked).toBe(false);
    // 遥测中途消失(后端切走):任何阶段回落「未开启」,但摘要保留最后烘焙。
    const lost = reduceBakeBench(cpuBaked, { type: "tick", atMs: 4, metrics: undefined });
    expect(lost.phase.kind).toBe("gi-disabled");
    expect(lost.lastBake?.bakeIndex).toBe(4);
  });

  it("gpuBakeShare:CPU 回退数 = 烘焙总数 − GPU 数,不为负", () => {
    expect(gpuBakeShare(sdfGiMetrics({ sdfGiBakes: 7, sdfGiBakesGpu: 5 }))).toEqual({ gpu: 5, cpuFallback: 2 });
    expect(gpuBakeShare(sdfGiMetrics({ sdfGiBakes: 2, sdfGiBakesGpu: 9 }))).toEqual({ gpu: 9, cpuFallback: 0 });
  });

  it("readSdfGiMetrics:遥测缺字段返回 undefined,不伪零", () => {
    expect(readSdfGiMetrics(undefined)).toBeUndefined();
    expect(readSdfGiMetrics({} as StudioQualityTelemetryStatus)).toBeUndefined();
    expect(readSdfGiMetrics(telemetryWithSdfGi())?.sdfGiProbeCount).toBe(1_024);
  });
});

describe("LightingBakeBenchPanel", () => {
  it("SDF GI 未开启:fail-closed 提示 sdf-gi=1,烘焙按钮禁用", () => {
    state.status = undefined;
    const html = renderPanel();
    expect(html).toContain("SDF GI 未开启");
    expect(html).toContain("sdf-gi=1");
    expect(html).toContain('disabled="" data-testid="bake-bench-check"');
    expect(html).toContain("data-phase=\"gi-disabled\"");
  });

  it("运行中:摘要呈现探针数/cells/烘焙路径/预算档,烘焙按钮可用", () => {
    state.status = telemetryWithSdfGi();
    const html = renderPanel();
    expect(html).toContain("SDF GI 运行中");
    expect(html).toContain(">1,024</strong>"); // 探针数
    expect(html).toContain(">60,192</strong>"); // SDF cells
    expect(html).toContain("GPU 3 · CPU 0"); // 烘焙路径
    expect(html).toContain("DDGI 预算 64"); // 预算档
    expect(html).not.toContain('data-testid="bake-bench-check" disabled');
  });
});
