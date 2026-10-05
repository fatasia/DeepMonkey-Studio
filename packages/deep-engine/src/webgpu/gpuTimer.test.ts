import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GpuTimer } from "./gpuTimer.js";
import type { DeviceSession } from "./deviceSession.js";

const BASE = 1_000_000_000_000_000n; // 1e15 ticks; 1 ms = 1e6 ticks

function fixture(supported = true, onTiming?: (timing: { frame: number; milliseconds: number }) => void,
  timestamps: readonly bigint[] = [1_000_000_000_000_000n, 1_000_000_002_500_000n]) {
  const resources: unknown[] = [];
  const readbacks: Array<{ mapAsync: ReturnType<typeof vi.fn>; getMappedRange: () => ArrayBuffer; mapState: string; unmap: ReturnType<typeof vi.fn> }> = [];
  const device = { features: new Set(supported ? ["timestamp-query"] : []), createQuerySet: vi.fn(() => ({ destroy: vi.fn() })),
    createBuffer: vi.fn(() => {
      const buffer = { mapState: "unmapped", mapAsync: vi.fn(async () => { buffer.mapState = "mapped"; }),
        getMappedRange: () => new BigUint64Array(timestamps).buffer,
        unmap: vi.fn(() => { buffer.mapState = "unmapped"; }), destroy: vi.fn() };
      readbacks.push(buffer); return buffer;
    }) };
  const session = { device, state: "ready", own: <T>(value: T): T => { resources.push(value); return value; } };
  return { timer: new GpuTimer(session as unknown as DeviceSession, onTiming), session, device, resources, readbacks };
}

function encoderSpy() {
  return {
    beginComputePass: vi.fn(() => ({ end: vi.fn() })),
    resolveQuerySet: vi.fn(),
    copyBufferToBuffer: vi.fn(),
  };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { QUERY_RESOLVE: 1, COPY_SRC: 2, COPY_DST: 4, MAP_READ: 8 });
  vi.stubGlobal("GPUMapMode", { READ: 1 });
});
afterEach(() => vi.unstubAllGlobals());

describe("asynchronous GPU timing", () => {
  it("allocates nothing outside sampling or on unsupported devices", () => {
    const f = fixture(); expect(f.timer.begin(1)).toBeUndefined(); expect(f.resources).toHaveLength(0);
    const unsupported = fixture(false); unsupported.timer.enabled = true;
    expect(unsupported.timer.begin(1)).toBeUndefined(); expect(unsupported.resources).toHaveLength(0);
  });

  it("preserves timestamp precision and maps only after explicit submission notification", async () => {
    const observed = vi.fn(), f = fixture(true, observed); f.timer.enabled = true;
    const frame = f.timer.begin(7)!;
    const encoder = { resolveQuerySet: vi.fn(), copyBufferToBuffer: vi.fn() };
    frame.resolve(encoder as unknown as GPUCommandEncoder);
    expect(encoder.resolveQuerySet).toHaveBeenCalledOnce(); expect(encoder.copyBufferToBuffer).toHaveBeenCalledOnce();
    expect(f.readbacks[1]!.mapAsync).not.toHaveBeenCalled();
    frame.read();
    expect(await f.timer.collect(7, 7)).toEqual([{ frame: 7, milliseconds: 2.5 }]);
    expect(observed).toHaveBeenCalledWith({ frame: 7, milliseconds: 2.5 });
    expect(f.readbacks[1]!.unmap).toHaveBeenCalledOnce();
    expect(await f.timer.collect(8, 9)).toEqual([]);
  });

  it("records coarse PBR GPU spans only when all four timestamps are ordered", async () => {
    const observed = vi.fn();
    const base = 1_000_000_000_000_000n;
    const f = fixture(true, observed, [base, base + 8_000_000n, base + 2_000_000n, base + 6_000_000n]);
    f.timer.enabled = true;
    const frame = f.timer.begin(9, true)!;
    const encoder = { resolveQuerySet: vi.fn(), copyBufferToBuffer: vi.fn() };
    frame.resolve(encoder as unknown as GPUCommandEncoder);
    expect(f.device.createQuerySet).toHaveBeenCalledWith(expect.objectContaining({ count: 4 }));
    expect(encoder.resolveQuerySet).toHaveBeenCalledWith(frame.queries, 0, 4, expect.anything(), 0);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledWith(expect.anything(), 0, expect.anything(), 0, 32);
    frame.read();
    expect(await f.timer.collect(9, 9)).toEqual([{ frame: 9, milliseconds: 8,
      stages: { shadowOpaqueMs: 2, intermediateMs: 4, outputMs: 2 } }]);
    expect(observed).toHaveBeenCalledOnce();
  });

  it("skips measurement rather than allocating beyond three busy readbacks", async () => {
    const f = fixture(); f.timer.enabled = true;
    const frames = [1, 2, 3].map((number) => f.timer.begin(number)!);
    expect(f.timer.begin(4)).toBeUndefined(); expect(f.resources).toHaveLength(9);
    for (const frame of frames) frame.read();
    expect(await f.timer.collect(1, 3)).toHaveLength(3);
    expect(f.timer.begin(5)).toBeDefined(); expect(f.resources).toHaveLength(9);
  });

  it("contains readback failures and releases the slot for reuse", async () => {
    const f = fixture(); f.timer.enabled = true;
    const frame = f.timer.begin(1)!;
    f.readbacks[1]!.mapAsync.mockRejectedValueOnce(new Error("map failed")); frame.read();
    expect(await f.timer.collect(1, 1)).toEqual([]); expect(f.timer.diagnostics[0]).toContain("map failed");
    expect(f.timer.begin(2)).toBeDefined(); expect(f.resources).toHaveLength(3);
  });
});

describe("per-pass GPU timing (F1)", () => {
  it("is opt-in and fails closed on unsupported devices, oversized or duplicate pass lists", () => {
    const f = fixture(); f.timer.enabled = true;
    const ids = ["opaque", "present"];
    expect(f.timer.beginPasses(1, ids)).toBeUndefined(); // passTimingEnabled 缺省关闭
    expect(f.resources).toHaveLength(0);
    const unsupported = fixture(false); unsupported.timer.enabled = true; unsupported.timer.passTimingEnabled = true;
    expect(unsupported.timer.beginPasses(1, ids)).toBeUndefined();
    expect(unsupported.resources).toHaveLength(0);
    const overflow = fixture(); overflow.timer.enabled = true; overflow.timer.passTimingEnabled = true;
    expect(overflow.timer.beginPasses(1, Array.from({ length: 25 }, (_, index) => `p${index}`))).toBeUndefined(); // GI-FIN:上限 16→24,溢出样本同步 25。
    expect(overflow.timer.beginPasses(1, ["opaque", "opaque"])).toBeUndefined();
    expect(overflow.timer.beginPasses(1, [])).toBeUndefined();
    expect(overflow.resources).toHaveLength(0);
  });

  it("brackets plan passes with empty compute markers and resolves exactly one query pair per pass", () => {
    const f = fixture(); f.timer.enabled = true; f.timer.passTimingEnabled = true;
    const scope = f.timer.beginPasses(9, ["opaque", "present"])!;
    expect(f.device.createQuerySet).toHaveBeenCalledWith(expect.objectContaining({ count: 48 })); // GI-FIN:上限 24×2 查询。
    const encoder = encoderSpy();
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "opaque");
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "opaque");
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "present");
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "present");
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(4);
    expect(encoder.beginComputePass.mock.calls[0]).toEqual([expect.objectContaining({
      timestampWrites: { querySet: scope.queries, beginningOfPassWriteIndex: 0 } })]);
    expect(encoder.beginComputePass.mock.calls[1]).toEqual([expect.objectContaining({
      timestampWrites: { querySet: scope.queries, endOfPassWriteIndex: 1 } })]);
    expect(encoder.beginComputePass.mock.calls[3]).toEqual([expect.objectContaining({
      timestampWrites: { querySet: scope.queries, endOfPassWriteIndex: 3 } })]);
    scope.resolve(encoder as unknown as GPUCommandEncoder);
    expect(encoder.resolveQuerySet).toHaveBeenCalledWith(scope.queries, 0, 4, expect.anything(), 0);
    expect(encoder.copyBufferToBuffer).toHaveBeenCalledWith(expect.anything(), 0, expect.anything(), 0, 32);
  });

  it("publishes measured passes in request order with the whole-frame span and skips unordered pairs", async () => {
    const observed = vi.fn();
    const f = fixture(true, observed, [BASE, BASE + 3_000_000n, BASE + 3_000_000n, BASE + 1_000_000n]);
    f.timer.enabled = true; f.timer.passTimingEnabled = true;
    const scope = f.timer.beginPasses(11, ["opaque", "present"])!;
    const encoder = encoderSpy();
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "opaque");
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "opaque");
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "present");
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "present");
    scope.read();
    const timings = await f.timer.collect(11, 11);
    expect(timings).toEqual([{ frame: 11, milliseconds: 3,
      passes: [{ passId: "opaque", durationMs: 3 }], requestedPassCount: 2 }]);
    expect(observed).toHaveBeenCalledOnce();
    expect(f.timer.diagnostics.join(" ")).toContain("present");
  });

  it("skips markers for unknown or duplicate pass ids and records diagnostics", () => {
    const f = fixture(); f.timer.enabled = true; f.timer.passTimingEnabled = true;
    const scope = f.timer.beginPasses(3, ["opaque"])!;
    const encoder = encoderSpy();
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "nope");
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "opaque"); // 合法:发射 end marker
    scope.endMarker(encoder as unknown as GPUCommandEncoder, "opaque"); // 重复:跳过
    expect(encoder.beginComputePass).toHaveBeenCalledTimes(1);
    expect(f.timer.diagnostics).toHaveLength(2);
    scope.read();
  });

  it("caps the per-pass pool at two concurrent scopes and reuses slots after read", async () => {
    const f = fixture(); f.timer.enabled = true; f.timer.passTimingEnabled = true;
    const first = f.timer.beginPasses(1, ["opaque"])!;
    const second = f.timer.beginPasses(2, ["opaque"])!;
    expect(f.timer.beginPasses(3, ["opaque"])).toBeUndefined();
    expect(f.resources).toHaveLength(6);
    for (const scope of [first, second]) {
      scope.read();
    }
    await f.timer.collect(1, 2);
    expect(f.timer.beginPasses(4, ["opaque"])).toBeDefined();
    expect(f.resources).toHaveLength(6);
  });

  it("publishes nothing when no pass was fully bracketed", async () => {
    const observed = vi.fn();
    const f = fixture(true, observed); f.timer.enabled = true; f.timer.passTimingEnabled = true;
    const scope = f.timer.beginPasses(5, ["opaque", "present"])!;
    const encoder = encoderSpy();
    scope.beginMarker(encoder as unknown as GPUCommandEncoder, "opaque");
    scope.read();
    expect(await f.timer.collect(5, 5)).toEqual([]);
    expect(observed).not.toHaveBeenCalled();
  });
});
