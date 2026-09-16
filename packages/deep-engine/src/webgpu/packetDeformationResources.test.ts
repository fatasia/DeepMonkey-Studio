import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import type { DeformationSnapshot, DeformationPose } from "../deformation/types.js";
import { PacketDeformationResources } from "./packetDeformationResources.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, VERTEX: 8, UNIFORM: 16 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function snapshot(kind: "skin" | "morph" | "morph-skin", revision = 0): DeformationSnapshot {
  const positions = new Float32Array([0, 0, 0]), normals = new Float32Array([0, 0, 1]);
  const morph = { revision, positions, normals, primitive: { id: "m", sourceMeshIndex: 0, sourcePrimitiveIndex: 0,
    vertexCount: 1, targets: [{ index: 0, name: "t", positionDeltas: new Float32Array([1, 0, 0]) }] } };
  const skinning = { revision, positions, normals, joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) };
  const source = { id: "s", geometry: "g", revision, kind, semantics: "three-r185" as const,
    ...(kind !== "skin" ? { morph } : {}), ...(kind !== "morph" ? { skinning } : {}) };
  const poses = ["a", "b"].map(id => ({ id, source: "s", revision,
    ...(kind !== "skin" ? { morphWeights: { revision, values: new Float32Array([revision * 0.1]) } } : {}),
    ...(kind !== "morph" ? { palette: { revision, matrices: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, revision, 0, 0, 1]) } } : {}),
  }));
  return { sources: [source], poses };
}

function fixture() {
  const owned = new Set<object>(), buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
  const events: string[] = [];
  const device = {
    limits: { maxBufferSize: 1 << 30, maxStorageBufferBindingSize: 1 << 30, maxComputeWorkgroupsPerDimension: 65_535 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(() => ({})),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { ...descriptor, mapState: "unmapped", destroy: vi.fn() }; buffers.push(buffer); return buffer;
    }),
  };
  const raw = { state: "ready", device, own<T extends object>(buffer: T) { owned.add(buffer); return buffer; },
    release(buffer: { destroy(): void }) { if (owned.delete(buffer)) buffer.destroy(); } };
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: vi.fn((descriptor: GPUComputePassDescriptor) => {
    events.push(descriptor.label ?? "compute"); return pass;
  }), copyBufferToBuffer: vi.fn(() => { events.push("copy"); }) } as unknown as GPUCommandEncoder;
  const owner = new PacketDeformationResources(raw as unknown as DeviceSession);
  return { owner, device, raw, buffers, owned, pass, encoder, events };
}

describe.each(["skin", "morph", "morph-skin"] as const)("packet %s resources", kind => {
  const producerCount = (events: readonly string[]) => events.filter(event => event !== "copy"
    && event !== "Deep deformation history stride conversion").length;

  it("skips settled producers while staging previous=current, then computes only changed poses", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind)); f.owner.encode(f.encoder); f.owner.commitFrame();
    const first = f.owner.drawStreams("a")!.current;
    f.events.length = 0;
    f.owner.updatePoses(snapshot(kind).poses); f.owner.encode(f.encoder);
    expect(f.events).toEqual([]);
    const settled = f.owner.drawStreams("a")!;
    expect(settled.current).toBe(first); expect(settled.previous).toBe(first);
    expect(settled.updated).toBe(false); expect(settled.historyValid).toBe(true);
    f.owner.commitFrame();
    f.owner.updatePoses([snapshot(kind, 1).poses[0]!, snapshot(kind).poses[1]!]);
    f.owner.encode(f.encoder); expect(producerCount(f.events)).toBe(1);
    expect(f.owner.drawStreams("a")!.previous).toBe(first);
    expect(f.owner.drawStreams("b")!.updated).toBe(false);
    f.owner.commitFrame(); f.events.length = 0; f.owner.encode(f.encoder);
    expect(f.events).toEqual([]);
    expect(f.owner.drawStreams("a")!.previous).toBe(f.owner.drawStreams("a")!.current);
    f.owner.commitFrame(); f.owner.dispose();
  });

  it("recomputes unsubmitted and cancelled updated poses on retry", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind));
    f.owner.encode(f.encoder); f.owner.cancelFrame(); f.events.length = 0;
    f.owner.encode(f.encoder); expect(producerCount(f.events)).toBe(2); f.owner.commitFrame();
    f.owner.updatePoses(snapshot(kind, 1).poses); f.owner.encode(f.encoder); f.owner.cancelFrame();
    f.events.length = 0; f.owner.encode(f.encoder); expect(producerCount(f.events)).toBe(2);
    f.owner.commitFrame(); f.events.length = 0; f.owner.encode(f.encoder);
    expect(f.events).toEqual([]); f.owner.cancelFrame(); f.owner.dispose();
  });

  it("does not cache partially encoded producers after a later producer fails", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind)); f.owner.encode(f.encoder); f.owner.commitFrame();
    f.owner.updatePoses(snapshot(kind, 1).poses);
    f.pass.dispatchWorkgroups.mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("second producer"); });
    expect(() => f.owner.encode(f.encoder)).toThrow("second producer");
    f.events.length = 0; f.owner.encode(f.encoder); expect(producerCount(f.events)).toBe(2);
    f.owner.commitFrame(); f.owner.dispose();
  });

  it("recomputes replacement sources even with unchanged pose revision or identical snapshot", () => {
    const f = fixture(); const initial = snapshot(kind);
    f.owner.prepare(initial); f.owner.encode(f.encoder); f.owner.commitFrame();
    for (const replacement of [initial, { sources: snapshot(kind, 1).sources, poses: initial.poses }]) {
      f.owner.prepare(replacement); f.events.length = 0; f.owner.encode(f.encoder);
      expect(producerCount(f.events)).toBe(2);
      expect(f.owner.drawStreams("a")!.historyValid).toBe(false);
      f.owner.commitFrame(); f.events.length = 0; f.owner.encode(f.encoder);
      expect(f.events).toEqual([]); f.owner.commitFrame();
    }
    f.owner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("isolates same-source poses and commits history only explicitly", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind));
    expect(f.owner.drawStreams("a")).toBeUndefined();
    f.owner.encode(f.encoder);
    const first = f.owner.drawStreams("a")!;
    expect(first.current).not.toBe(f.owner.drawStreams("b")!.current);
    expect(first.historyValid).toBe(false);
    expect(() => f.owner.updatePoses(snapshot(kind, 1).poses)).toThrow("pending");
    f.owner.commitFrame();
    f.owner.updatePoses(snapshot(kind, 1).poses); f.owner.encode(f.encoder);
    expect(f.owner.drawStreams("a")!.previous).toBe(first.current);
    expect(f.owner.drawStreams("a")!.historyValid).toBe(true);
    f.owner.cancelFrame();
    expect(f.owner.drawStreams("a")!.current).toBe(first.current);
    expect(f.owner.drawStreams("a")!.stale).toBe(true);
    f.owner.encode(f.encoder); f.owner.commitFrame(); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("prevalidates the full batch and rejects unchanged-revision mutations without writes", () => {
    const f = fixture(); const initial = snapshot(kind); f.owner.prepare(initial);
    const count = f.device.queue.writeBuffer.mock.calls.length;
    const invalid = structuredClone(snapshot(kind, 1).poses) as DeformationPose[];
    if (invalid[1]!.palette) invalid[1]!.palette.matrices[0] = NaN;
    else invalid[1]!.morphWeights!.values[0] = NaN;
    expect(() => f.owner.updatePoses(invalid)).toThrow();
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(count);
    const mutated = structuredClone(initial.poses);
    if (mutated[0]!.palette) mutated[0]!.palette.matrices[12] = 7;
    else mutated[0]!.morphWeights!.values[0] = 0.7;
    expect(() => f.owner.updatePoses(mutated)).toThrow("without a revision");
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(count);
    f.owner.dispose();
  });

  it("blocks partial uploads, preserves presentation and retries without static uploads", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind)); f.owner.encode(f.encoder); f.owner.commitFrame();
    const first = f.owner.drawStreams("a")!.current;
    const allocations = f.device.createBuffer.mock.calls.length;
    f.device.queue.writeBuffer.mockClear();
    const writesPerPose = kind === "morph-skin" ? 2 : 1;
    let calls = 0;
    f.device.queue.writeBuffer.mockImplementation(() => { if (++calls === writesPerPose + 1) throw new Error("write failure"); });
    const next = snapshot(kind, 1).poses;
    expect(() => f.owner.updatePoses(next)).toThrow("write failure");
    expect(f.owner.drawStreams("a")!.current).toBe(first); expect(f.owner.drawStreams("a")!.stale).toBe(true);
    expect(() => f.owner.encode(f.encoder)).toThrow("incomplete");
    expect(() => f.owner.commitFrame()).toThrow("No encoded");
    f.device.queue.writeBuffer.mockReset(); f.owner.updatePoses(next);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledTimes(writesPerPose);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(allocations);
    f.owner.encode(f.encoder); f.owner.commitFrame(); expect(f.owner.drawStreams("a")!.stale).toBe(false);
    f.owner.dispose();
  });

  it("rolls back failed preparation and cancels failed encoding", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind)); f.owner.encode(f.encoder); f.owner.commitFrame();
    const old = f.owner.drawStreams("a")!.current, count = f.owned.size;
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("bind"); });
    expect(() => f.owner.prepare(snapshot(kind, 1))).toThrow("bind");
    expect(f.owned.size).toBe(count); expect(f.owner.drawStreams("a")!.current).toBe(old);
    f.owner.updatePoses(snapshot(kind, 1).poses);
    f.pass.dispatchWorkgroups.mockImplementationOnce(() => { throw new Error("encode"); });
    expect(() => f.owner.encode(f.encoder)).toThrow("encode");
    expect(() => f.owner.commitFrame()).toThrow("No encoded");
    expect(f.owner.drawStreams("a")!.current).toBe(old);
    f.owner.encode(f.encoder); f.owner.commitFrame(); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("accepts a newer batch after failure, rejects stale attempts and owns caller arrays", () => {
    const f = fixture(); const original = snapshot(kind); f.owner.prepare(original);
    const changed = original.sources[0]!.morph?.positions ?? original.sources[0]!.skinning!.positions;
    changed[0] = 42;
    expect(() => f.owner.prepare(original)).toThrow("without a revision");
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("write"); });
    expect(() => f.owner.updatePoses(snapshot(kind, 1).poses)).toThrow("write");
    expect(() => f.owner.updatePoses(snapshot(kind).poses)).toThrow("Stale");
    f.owner.updatePoses(snapshot(kind, 2).poses);
    f.owner.encode(f.encoder); expect(f.owner.drawStreams("a")!.poseRevision).toBe(2);
    f.owner.commitFrame(); f.owner.dispose(); expect(f.owned.size).toBe(0);
  });

  it("preserves submitted streams until replacement commits and drains failing cleanup", () => {
    const f = fixture(); f.owner.prepare(snapshot(kind)); f.owner.encode(f.encoder); f.owner.commitFrame();
    const old = f.owner.drawStreams("a")!.current;
    f.owner.prepare(snapshot(kind, 1));
    expect(f.owner.drawStreams("a")!.current).toBe(old); expect(f.owner.drawStreams("a")!.stale).toBe(true);
    f.owner.encode(f.encoder);
    const next = f.owner.drawStreams("a")!.current;
    f.buffers[0]!.destroy.mockImplementation(() => { throw new Error("destroy"); });
    expect(() => f.owner.commitFrame()).toThrow(AggregateError);
    expect(f.owner.drawStreams("a")!.current).toBe(next); expect(f.owner.drawStreams("a")!.stale).toBe(false);
    f.owner.dispose(); expect(f.owned.size).toBe(0);
  });
});

it("orders all deformation computes before history copies and cancels a partial copy frame", () => {
  const f = fixture(); f.owner.prepare(snapshot("morph")); f.owner.encode(f.encoder); f.owner.commitFrame();
  const old = f.owner.drawStreams("a")!.current; f.events.length = 0;
  f.owner.updatePoses(snapshot("morph", 1).poses);
  const copy = f.encoder.copyBufferToBuffer as ReturnType<typeof vi.fn>;
  copy.mockImplementationOnce(() => { f.events.push("copy"); }).mockImplementationOnce(() => { throw new Error("copy failure"); });
  expect(() => f.owner.encode(f.encoder)).toThrow("copy failure");
  expect(f.events.slice(0, 2).every(event => event !== "copy")).toBe(true);
  expect(f.owner.drawStreams("a")!.current).toBe(old);
  expect(() => f.owner.commitFrame()).toThrow("No encoded");
  f.owner.encode(f.encoder); f.owner.commitFrame(); f.owner.dispose(); expect(f.owned.size).toBe(0);
});
