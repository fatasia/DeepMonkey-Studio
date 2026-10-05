import { beforeEach, describe, expect, it, vi } from "vitest";
import { PbrRenderer } from "./pbrRenderer.js";
import { resetRendererRebuildLedgerForTests, rendererRebuildFrameMetrics } from "./pbrRendererRebuildAccounting.js";

/** 裸 this 拆除夹具:与 PbrRenderer.dispose 的可选调用面逐字段对齐。 */
function teardownFixture() {
  const calls: string[] = [], owner = (name: string) => ({ dispose: vi.fn(() => { calls.push(name); }) });
  const fixture = {
    calls,
    ground: { author: owner("author") }, outputs: owner("outputs"), environment: owner("environment"),
    lighting: owner("lighting"), localShadows: owner("localShadows"), shadowState: owner("shadowState"),
    previousHiZ: owner("previousHiZ"), transparency: owner("transparency"), postProcess: owner("postProcess"),
    packets: owner("packets"), targets: owner("targets"), cameraHistory: { reset: vi.fn(() => { calls.push("cameraHistory"); }) },
    session: { ...owner("session"), device: {} as GPUDevice,
      resourceMemory: { estimatedBytes: 0, bufferBytes: 0, textureBytes: 0 } },
    transientTextures: { stats: { allocatedBytes: 0, peakResidentBytes: 0 } },
    now: () => 0,
  };
  return fixture;
}

const OWNER_ORDER = ["author", "outputs", "environment", "lighting", "localShadows", "shadowState", "previousHiZ",
  "transparency", "postProcess", "packets", "targets", "cameraHistory", "session"] as const;

describe("PBR renderer teardown", () => {
  beforeEach(() => { resetRendererRebuildLedgerForTests(); });

  it("releases every owner and device even when multiple early owners throw", () => {
    const renderer = teardownFixture();
    const first = Error("overlay teardown"), second = Error("environment teardown");
    (renderer.ground.author.dispose as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      renderer.calls.push("author"); throw first;
    });
    (renderer.environment.dispose as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      renderer.calls.push("environment"); throw second;
    });
    let failure: unknown;
    try { PbrRenderer.prototype.dispose.call(renderer as never); } catch (error) { failure = error; }
    expect(renderer.calls).toEqual([...OWNER_ORDER]);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors).toEqual([first, second]);
  });

  // A2-刀1:dispose 后不再被 JS 强引用的大对象 —— 引用链证据见 dispose 内注释。
  it("detaches pipeline graph references, capture readback and aborts in-flight chains", () => {
    const renderer = teardownFixture() as Record<string, unknown>;
    const releasePipelines = vi.fn();
    renderer.pipelines = { main: Symbol("pipeline-graph") };
    renderer.releasePipelines = releasePipelines;
    renderer.lastFrameReadback = Promise.resolve([]);
    renderer.probeClipmapAbort = { abort: vi.fn() };
    renderer.adaptiveShadowStage = { abort: vi.fn() };

    PbrRenderer.prototype.dispose.call(renderer as never);

    expect((renderer.probeClipmapAbort as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalledTimes(1);
    expect((renderer.adaptiveShadowStage as { abort: ReturnType<typeof vi.fn> }).abort).toHaveBeenCalledTimes(1);
    expect(renderer.pipelines).toBeUndefined();
    expect(renderer.releasePipelines).toBeUndefined();
    expect(renderer.lastFrameReadback).toBeUndefined();
    // 背景排队门在断开前已放行。
    expect(releasePipelines).toHaveBeenCalledTimes(1);
  });

  // A2-刀2:dispose 时点入账一条「释放估算」,序号/总量单调。
  it("records a rebuild accounting entry into the process ledger on dispose", () => {
    const renderer = teardownFixture();
    renderer.session.resourceMemory = { estimatedBytes: 1234, bufferBytes: 1000, textureBytes: 234 };
    renderer.transientTextures.stats = { allocatedBytes: 4096, peakResidentBytes: 2048 };
    renderer.now = () => 42;

    PbrRenderer.prototype.dispose.call(renderer as never);

    const metrics = rendererRebuildFrameMetrics(0);
    expect(metrics.total).toBe(1);
    expect(metrics.last).toMatchObject({ index: 0, atMs: 42, releasedEstimateBytes: 1234,
      bufferBytes: 1000, textureBytes: 234, transientAllocatedBytes: 4096, transientPeakResidentBytes: 2048,
      pipelineCompiles: 0 });
  });
});
