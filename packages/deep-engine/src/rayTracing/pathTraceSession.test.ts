import { describe, expect, it, vi } from "vitest";
import { PathTraceProductSession } from "./pathTraceSession.js";
import type { PathTraceAccumulationLease } from "./pathTraceSessionTypes.js";

const IDENTITY = { sceneRevision: 1, materialHash: "m1", cameraHash: "c1" };
const IDENTITY2 = { sceneRevision: 2, materialHash: "m2", cameraHash: "c1" };
const CONFIG = { width: 8, height: 4, maxSamples: 256, maxAccumulationBytes: 64 * 1024 * 1024,
  minSamples: 8, sampleSeed: 7 };
/** 常量亮度批（零方差）：8 样本/批 → minSamples=8 时一批过样本门，方差门恒过。 */
const CONSTANT_BATCH = { samples: 8, brightnessSum: 8 * 2, brightnessSumSq: 8 * 4 };
const leaseSpy = (bytes: number): PathTraceAccumulationLease =>
  ({ bytes, dispose: vi.fn() });

function started(overrides: Partial<typeof CONFIG> = {}) {
  const leases: PathTraceAccumulationLease[] = [];
  const factory = vi.fn((bytes: number) => { const lease = leaseSpy(bytes); leases.push(lease); return lease; });
  const session = new PathTraceProductSession({ ...CONFIG, ...overrides }, factory);
  return { session, factory, leases };
}

describe("I-C16 accumulation lifecycle", () => {
  it("runs idle → accumulating → exported and disposes the lease exactly once", () => {
    const { session, factory, leases } = started();
    expect(session.phase).toBe("idle");
    const outcome = session.begin(IDENTITY);
    expect(outcome).toMatchObject({ status: "started", phase: "accumulating", generation: 1 });
    expect(factory).toHaveBeenCalledOnce();
    expect(session.residentBytes).toBe(8 * 4 * 3 * 4 * 2);
    const advanced = session.advanceBatch(CONSTANT_BATCH);
    expect(advanced).toMatchObject({ status: "advanced", sampleCount: 8, converged: true });
    expect(session.converged).toBe(true);
    const receipt = session.export();
    expect(receipt).toMatchObject({ width: 8, height: 4, generation: 1, sampleCount: 8,
      variance: 0, format: "radiance-hdr-rgbe", seed: 7 });
    expect(session.phase).toBe("exported");
    expect(session.residentBytes).toBe(0);
    expect(leases[0]!.dispose).toHaveBeenCalledOnce();
    // exported 为半终态：推进/失效/导出拒绝，begin 重开分配新 lease。
    expect(() => session.advanceBatch(CONSTANT_BATCH)).toThrow(/exported/);
    expect(() => session.invalidate("explicit-request")).toThrow(/exported/);
    expect(() => session.export()).toThrow(/exported/);
    const reopened = session.begin(IDENTITY2);
    expect(reopened).toMatchObject({ status: "started", phase: "accumulating", generation: 2 });
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("rejects begin fail-closed when the estimate busts the byte budget with zero state change", () => {
    const { session, factory } = started({ maxAccumulationBytes: 700 });
    const outcome = session.begin(IDENTITY);
    expect(outcome).toMatchObject({ status: "rejected-budget", phase: "idle",
      estimatedBytes: 768 });
    expect(factory).not.toHaveBeenCalled();
    expect(session.phase).toBe("idle");
    expect(() => session.advanceBatch(CONSTANT_BATCH)).toThrow(/idle/);
    expect(() => session.export()).toThrow(/idle/);
    // 恰好等于预算的边界接受（≤ 语义）。
    const atBoundary = new PathTraceProductSession({ width: 8, height: 4, maxSamples: 256,
      maxAccumulationBytes: 768 }, () => leaseSpy(768));
    expect(atBoundary.begin(IDENTITY).status).toBe("started");
  });

  it("rejects a malformed lease and disposes it instead of adopting it", () => {
    const wrongBytes = leaseSpy(1);
    expect(() => new PathTraceProductSession(CONFIG, () => wrongBytes).begin(IDENTITY))
      .toThrow(TypeError);
    expect(wrongBytes.dispose).toHaveBeenCalledOnce();
    const noDispose = { bytes: 768, dispose: undefined } as unknown as PathTraceAccumulationLease;
    expect(() => new PathTraceProductSession(CONFIG, () => noDispose).begin(IDENTITY))
      .toThrow(TypeError);
  });
});

describe("I-C16 material invalidation and reaccumulation", () => {
  it("resets bookkeeping and reuses the lease across invalidate → reaccumulating", () => {
    const { session, factory, leases } = started();
    session.begin(IDENTITY);
    session.advanceBatch(CONSTANT_BATCH);
    const invalidation = session.invalidate("material-revision", IDENTITY2);
    expect(invalidation).toMatchObject({ phase: "invalidated", generation: 2,
      reason: "material-revision" });
    expect(session.sampleCount).toBe(0);
    expect(session.converged).toBe(false);
    expect(session.residentBytes).toBe(768); // lease 复用：不重分配。
    expect(factory).toHaveBeenCalledOnce();
    expect(() => session.advanceBatch(CONSTANT_BATCH)).toThrow(/invalidated/);
    const resumed = session.begin(IDENTITY2);
    expect(resumed).toMatchObject({ status: "started", phase: "reaccumulating", generation: 3 });
    expect(factory).toHaveBeenCalledOnce();
    expect(leases).toHaveLength(1);
    const advanced = session.advanceBatch({ ...CONSTANT_BATCH, generation: 3 });
    expect(advanced).toMatchObject({ status: "advanced", generation: 3 });
    expect(session.export().generation).toBe(3);
  });
  it("rejects stale-generation batches and invalidation outside advanceable phases", () => {
    const { session } = started();
    session.begin(IDENTITY);
    session.advanceBatch(CONSTANT_BATCH);
    expect(() => session.advanceBatch({ ...CONSTANT_BATCH, generation: 9 })).toThrow(/stale/);
    session.invalidate("explicit-request");
    expect(() => session.invalidate("material-revision")).toThrow(/invalidated/);
    const fresh = started().session;
    expect(() => fresh.invalidate("explicit-request")).toThrow(/idle/);
    expect(() => session.advanceBatch({ samples: 1, brightnessSum: 2, brightnessSumSq: 4 }))
      .toThrow(/invalidated/);
  });
});

describe("I-C16 cancellation semantics (AbortSignal throughout)", () => {
  it("cancels mid-stream on an aborted signal, disposes the lease once, and freezes", () => {
    const { session, leases } = started();
    session.begin(IDENTITY);
    session.advanceBatch(CONSTANT_BATCH);
    const controller = new AbortController();
    controller.abort();
    const outcome = session.advanceBatch(CONSTANT_BATCH, { signal: controller.signal });
    expect(outcome).toMatchObject({ status: "cancelled", phase: "cancelled", sampleCount: 8 });
    expect(session.residentBytes).toBe(0);
    expect(leases[0]!.dispose).toHaveBeenCalledOnce();
    expect(() => session.advanceBatch(CONSTANT_BATCH)).toThrow(/cancelled/);
    expect(() => session.invalidate("explicit-request")).toThrow(/cancelled/);
    expect(() => session.export()).toThrow(/cancelled/);
    expect(() => session.begin(IDENTITY)).toThrow(/terminal/);
    expect(session.cancel()).toBe(false);
  });
  it("rejects an already-aborted signal at begin and validates signal shape", () => {
    const { session, leases } = started();
    const controller = new AbortController();
    controller.abort();
    const outcome = session.begin(IDENTITY, { signal: controller.signal });
    expect(outcome).toMatchObject({ status: "cancelled", phase: "cancelled" });
    expect(leases[0]!.dispose).toHaveBeenCalledOnce();
    expect(() => session.begin(IDENTITY, { signal: {} as AbortSignal })).toThrow(TypeError);
  });
  it("supports explicit cancel() from advanceable phases only", () => {
    const { session } = started();
    expect(session.cancel()).toBe(false); // idle 无 lease 可取消。
    session.begin(IDENTITY);
    expect(session.cancel()).toBe(true);
    expect(session.phase).toBe("cancelled");
    expect(session.cancel()).toBe(false);
  });
  it("drops the cancelling batch itself from bookkeeping", () => {
    const { session } = started({ minSamples: 16 });
    session.begin(IDENTITY);
    session.advanceBatch(CONSTANT_BATCH);
    const controller = new AbortController();
    controller.abort();
    const outcome = session.advanceBatch(CONSTANT_BATCH, { signal: controller.signal });
    expect(outcome.sampleCount).toBe(8); // 取消批不入账。
  });
});

describe("I-C16 export gating and disposal", () => {
  it("refuses export before convergence without mutating state", () => {
    const { session } = started({ minSamples: 64 });
    session.begin(IDENTITY);
    session.advanceBatch(CONSTANT_BATCH);
    expect(() => session.export()).toThrow(/convergence/);
    expect(session.phase).toBe("accumulating");
    expect(session.residentBytes).toBe(768);
  });
  it("is disposal-idempotent, releases a pending lease, and aggregates dispose failures", () => {
    const { session, leases } = started();
    session.begin(IDENTITY);
    session.dispose();
    expect(leases[0]!.dispose).toHaveBeenCalledOnce();
    session.dispose();
    expect(leases[0]!.dispose).toHaveBeenCalledOnce();
    expect(() => session.begin(IDENTITY)).toThrow(/disposed/);
    expect(() => session.export()).toThrow(/disposed/);
    const stuck = leaseSpy(768);
    (stuck.dispose as ReturnType<typeof vi.fn>).mockImplementation(() => { throw Error("plane stuck"); });
    const failing = new PathTraceProductSession(CONFIG, () => stuck);
    failing.begin(IDENTITY);
    expect(() => failing.dispose()).toThrow(AggregateError);
    expect(failing.disposed).toBe(true);
  });
  it("validates config and lease factory at construction", () => {
    expect(() => new PathTraceProductSession({ width: 1, height: 1, maxAccumulationBytes: 8 },
      undefined as never)).toThrow(TypeError);
  });
});
