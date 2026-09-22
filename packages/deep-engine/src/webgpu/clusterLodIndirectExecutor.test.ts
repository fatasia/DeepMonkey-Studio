/// <reference types="@webgpu/types" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClusterLodIndirectExecutor, MAX_CLUSTER_LOD_DRAWS } from "./clusterLodIndirectExecutor.js";
import type { ClusterLodRenderRequest } from "./clusterLodIndirectExecutor.js";
import type { ClusterLodIndirectPlan } from "../rayTracing/clusterLodIndirectPlan.js";
import type { DeviceSession } from "./deviceSession.js";

function plan(command = [3, 1, 0, 0, 0]): ClusterLodIndirectPlan {
  return { draws: [{ nodeIndex: 0, nodeId: "leaf", level: 0, clusterIndex: 0,
    firstTriangle: 0, triangleCount: 1, firstIndex: 0,
    indirectCommand: command as [number, number, number, number, number] }],
    levelSpans: [], drawCount: 1, commandsByteLength: 20, coveredRegions: 1, coveredLeafClusters: 1 };
}

function fixture() {
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 128, INDIRECT: 256, COPY_DST: 8, INDEX: 16, VERTEX: 32 });
  const owned = new Set<GPUBuffer>();
  const buffers: GPUBuffer[] = [];
  const encoder = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexedIndirect: vi.fn(), finish: vi.fn(() => ({} as GPURenderBundle)) };
  const device = { limits: { maxBufferSize: 2 ** 24, maxColorAttachments: 8, maxBindGroups: 4 },
    features: new Set<string>(), queue: { writeBuffer: vi.fn() },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => {
      const buffer = { size: descriptor.size, usage: descriptor.usage, destroy: vi.fn() } as unknown as GPUBuffer;
      buffers.push(buffer); return buffer;
    }), createRenderBundleEncoder: vi.fn(() => encoder) };
  const session = { state: "ready", device,
    own: (buffer: GPUBuffer) => { owned.add(buffer); return buffer; },
    release: vi.fn((buffer: GPUBuffer) => { if (owned.delete(buffer)) buffer.destroy(); }) };
  const executor = new ClusterLodIndirectExecutor(session as unknown as DeviceSession);
  const geometry = { indexBuffer: { usage: 16, size: 24 } as GPUBuffer,
    vertexBuffer: { usage: 32, size: 48 } as GPUBuffer, indexSize: 24, vertexSize: 48 };
  const request: ClusterLodRenderRequest = { pipeline: {} as GPURenderPipeline, colorFormats: ["rgba8unorm"] };
  return { executor, session, device, encoder, geometry, request, buffers, owned };
}

afterEach(() => vi.unstubAllGlobals());

describe("cluster LOD indirect executor", () => {
  it("uploads exact words, reuses commands and submits a cached bundle", () => {
    const f = fixture();
    const execution = f.executor.encode(plan());
    expect(f.device.queue.writeBuffer).toHaveBeenCalledWith(execution.commands, 0, new Uint32Array([3, 1, 0, 0, 0]));
    const reused = f.executor.encode(plan());
    expect(reused.updated).toBe(false);
    expect(f.device.createBuffer).toHaveBeenCalledTimes(1);
    const pass = { executeBundles: vi.fn() };
    const first = f.executor.execute(pass as unknown as GPURenderPassEncoder, execution, f.geometry, f.request);
    expect(f.encoder.drawIndexedIndirect).toHaveBeenCalledWith(execution.commands, 0);
    expect(pass.executeBundles).toHaveBeenCalledWith([first.bundle]);
    expect(f.executor.prepareBundle(reused, f.geometry, f.request).reused).toBe(true);
  });

  it("releases replaced commands and disposes exactly once without owning geometry", () => {
    const f = fixture();
    const old = f.executor.encode(plan());
    const next = f.executor.encode(plan([6, 1, 0, 0, 0]));
    expect(old.commands.destroy).toHaveBeenCalledTimes(1);
    expect(() => f.executor.prepareBundle(old, f.geometry, f.request)).toThrow("stale");
    f.executor.dispose(); f.executor.dispose();
    expect(next.commands.destroy).toHaveBeenCalledTimes(1);
    expect(f.owned.size).toBe(0);
    expect(() => f.executor.encode(plan())).toThrow("disposed");
  });

  it("rolls back failed uploads and can retry with the previous execution still usable", () => {
    const f = fixture();
    const old = f.executor.encode(plan());
    f.device.queue.writeBuffer.mockImplementationOnce(() => { throw new Error("upload failure"); });
    expect(() => f.executor.encode(plan([6, 1, 0, 0, 0]))).toThrow("upload failed");
    expect(f.buffers[1]!.destroy).toHaveBeenCalledTimes(1);
    expect(old.commands.destroy).not.toHaveBeenCalled();
    expect(f.executor.prepareBundle(old, f.geometry, f.request).drawCount).toBe(1);
    expect(f.executor.encode(plan([6, 1, 0, 0, 0])).generation).toBe(2);
  });

  it("preserves the previous plan when buffer allocation fails", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    f.device.createBuffer.mockImplementationOnce(() => { throw new Error("allocation failed"); });
    expect(() => f.executor.encode(plan([6, 1, 0, 0, 0]))).toThrow("allocation failed");
    expect(execution.commands.destroy).not.toHaveBeenCalled();
    expect(f.executor.prepareBundle(execution, f.geometry, f.request).drawCount).toBe(1);
    expect(f.owned.size).toBe(1);
  });

  it("retries failed bundle creation without releasing its command buffer", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    f.encoder.finish.mockImplementationOnce(() => { throw new Error("bundle failed"); });
    expect(() => f.executor.prepareBundle(execution, f.geometry, f.request)).toThrow("bundle failed");
    expect(execution.commands.destroy).not.toHaveBeenCalled();
    expect(f.executor.prepareBundle(execution, f.geometry, f.request).reused).toBe(false);
  });

  it("encodes multiple command records at twenty-byte offsets", () => {
    const f = fixture(); const first = plan(); const second = plan([3, 1, 3, 0, 0]);
    const execution = f.executor.encode({ ...first, draws: [...first.draws, ...second.draws], drawCount: 2, commandsByteLength: 40 });
    f.executor.prepareBundle(execution, f.geometry, f.request);
    expect(f.device.queue.writeBuffer).toHaveBeenCalledWith(execution.commands, 0,
      new Uint32Array([3, 1, 0, 0, 0, 3, 1, 3, 0, 0]));
    expect(f.encoder.drawIndexedIndirect.mock.calls).toEqual([[execution.commands, 0], [execution.commands, 20]]);
  });

  it("releases owned resources when the session is lost", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    f.session.state = "lost";
    expect(() => f.executor.prepareBundle(execution, f.geometry, f.request)).toThrow("not ready");
    expect(execution.commands.destroy).toHaveBeenCalledTimes(1);
    f.executor.dispose();
    expect(f.owned.size).toBe(0);
    expect(execution.commands.destroy).toHaveBeenCalledTimes(1);
  });

  it("encodes an empty plan with the minimum four-byte allocation", () => {
    const f = fixture();
    const empty = { ...plan(), draws: [], drawCount: 0, commandsByteLength: 0 };
    const execution = f.executor.encode(empty);
    expect(execution.commands.size).toBe(4);
    f.executor.prepareBundle(execution, f.geometry, f.request);
    expect(f.encoder.drawIndexedIndirect).not.toHaveBeenCalled();
    f.device.limits.maxBufferSize = 3;
    expect(() => f.executor.encode(empty)).toThrow("maxBufferSize");
  });

  it.each([NaN, Infinity, -1, 0.5, 2 ** 32, undefined])("rejects invalid command word %s before allocating", value => {
    const f = fixture();
    expect(() => f.executor.encode(plan([value as number, 1, 0, 0, 0]))).toThrow("command word");
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });

  it("rejects signed baseVertex overflow and gates nonzero firstInstance by feature", () => {
    const f = fixture();
    expect(() => f.executor.encode(plan([3, 1, 0, 2 ** 31, 0]))).toThrow("command word");
    expect(() => f.executor.encode(plan([3, 1, 0, 0, 1]))).toThrow("indirect-first-instance");
    f.device.features.add("indirect-first-instance");
    expect(f.executor.encode(plan([3, 1, 0, 0, 1])).drawCount).toBe(1);
  });

  it("rejects malformed, sparse, inconsistent and over-budget plans", () => {
    const f = fixture();
    for (const invalid of [null, { ...plan(), draws: null }, { ...plan(), drawCount: -1 },
      { ...plan(), commandsByteLength: 4 }, { ...plan(), draws: new Array(1) }, plan([3]),
      { ...plan(), draws: new Array(MAX_CLUSTER_LOD_DRAWS + 1), drawCount: MAX_CLUSTER_LOD_DRAWS + 1,
        commandsByteLength: (MAX_CLUSTER_LOD_DRAWS + 1) * 20 }]) {
      expect(() => f.executor.encode(invalid as unknown as ClusterLodIndirectPlan)).toThrow(/Cluster LOD/);
    }
    f.device.limits.maxBufferSize = 16;
    expect(() => f.executor.encode(plan())).toThrow("maxBufferSize");
    expect(f.device.createBuffer).not.toHaveBeenCalled();
  });

  it("rejects forged execution metadata and insufficient index ranges", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    for (const drawCount of [-1, NaN, 2]) {
      expect(() => f.executor.prepareBundle({ ...execution, drawCount }, f.geometry, f.request)).toThrow("stale");
    }
    expect(() => f.executor.prepareBundle({ ...execution, commandStride: 4 } as unknown as typeof execution,
      f.geometry, f.request)).toThrow("stale");
    expect(() => f.executor.prepareBundle(execution, { ...f.geometry, indexSize: 4 }, f.request)).toThrow("index geometry range");
    expect(f.device.createRenderBundleEncoder).not.toHaveBeenCalled();
  });

  it.each([0, -4, 5, NaN, Infinity, 28])("rejects invalid geometry size %s", indexSize => {
    const f = fixture(); const execution = f.executor.encode(plan());
    expect(() => f.executor.prepareBundle(execution, { ...f.geometry, indexSize }, f.request)).toThrow("geometry");
    expect(f.device.createRenderBundleEncoder).not.toHaveBeenCalled();
  });

  it("rejects invalid sample counts, binding indices and offsets before encoding", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    const binding = { index: 0, bindGroup: {} as GPUBindGroup };
    const requests = [ { ...f.request, sampleCount: 2 },
      ...[-1, 4, 0.5, NaN].map(index => ({ ...f.request, bindGroups: [{ ...binding, index }] })),
      ...[-1, 2 ** 32, NaN, 0.5].map(offset => ({ ...f.request, bindGroups: [{ ...binding, dynamicOffsets: [offset] }] })),
      { ...f.request, bindGroups: [binding, binding] } ];
    for (const request of requests) expect(() => f.executor.prepareBundle(execution, f.geometry, request)).toThrow(/cluster LOD|Cluster LOD/);
    expect(f.device.createRenderBundleEncoder).not.toHaveBeenCalled();
  });

  it("invalidates bundle snapshots after caller-owned arrays or geometry mutate", () => {
    const f = fixture(); const execution = f.executor.encode(plan());
    const offsets = [0]; const formats: GPUTextureFormat[] = ["rgba8unorm"];
    const request = { ...f.request, colorFormats: formats,
      bindGroups: [{ index: 0, bindGroup: {} as GPUBindGroup, dynamicOffsets: offsets }] };
    f.executor.prepareBundle(execution, f.geometry, request);
    offsets[0] = 256;
    expect(f.executor.prepareBundle(execution, f.geometry, request).reused).toBe(false);
    formats[0] = "bgra8unorm";
    expect(f.executor.prepareBundle(execution, f.geometry, request).reused).toBe(false);
    f.geometry.vertexSize = 24;
    expect(f.executor.prepareBundle(execution, f.geometry, request).reused).toBe(false);
    expect(f.executor.prepareBundle(execution, f.geometry, request).reused).toBe(true);
  });
});
