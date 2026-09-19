import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceSession } from "../webgpu/deviceSession.js";
import { MAX_FORWARD_PLUS_CLUSTER_COUNT } from "./clusterGrid.js";
import { createForwardPlusPbrGrid, ForwardPlusPbrRuntime } from "./forwardPlusPbrRuntime.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }

function fixture() {
  const owned = new Set<GPUBuffer>(), buffers: FakeBuffer[] = [], passes: Array<ReturnType<typeof computePass>> = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxComputeWorkgroupsPerDimension: 65_535, maxBindGroups: 4, maxStorageBuffersPerShaderStage: 8 },
    queue: { writeBuffer: vi.fn() }, createShaderModule: vi.fn(() => ({})), createBindGroupLayout: vi.fn(({ label }) => ({ label })),
    createPipelineLayout: vi.fn(() => ({})), createComputePipeline: vi.fn(() => ({})),
    createTexture: vi.fn(() => ({ createView: vi.fn(() => ({})), destroy: vi.fn() })),
    createSampler: vi.fn(() => ({})),
    createBuffer: vi.fn(({ label, size, usage }: GPUBufferDescriptor) => {
      const buffer = { label: label ?? "", size, usage, destroy: vi.fn() } as unknown as FakeBuffer;
      buffers.push(buffer); return buffer;
    }),
    createBindGroup: vi.fn(({ label, entries }: GPUBindGroupDescriptor) => ({ label, entries })),
  };
  const session = { state: "ready", device,
    own<T extends GPUBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: GPUBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  const encoder = { beginComputePass: vi.fn(() => { const pass = computePass(); passes.push(pass); return pass; }) } as unknown as GPUCommandEncoder;
  return { device, session: session as unknown as DeviceSession, rawSession: session, encoder, owned, buffers, passes };
}

function computePass() {
  return { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
}

const input = (viewportWidth = 64) => ({ viewportWidth, viewportHeight: 32, near: 0.1, far: 200,
  verticalFovRadians: Math.PI / 4, tuning: { minimumTileSize: 32, zSlices: 4, maxLightsPerCluster: 4 },
  lights: {
    directional: [{ directionView: [0, -1, 0] as const, color: [1, 1, 1] as const, intensity: 2 }],
    points: [{ positionView: [0, 0, -4] as const, range: 3, color: [1, 0.5, 0.25] as const, intensity: 4 }],
    spots: [{ positionView: [1, 0, -5] as const, directionView: [0, 0, -1] as const, range: 5,
      color: [0.25, 0.5, 1] as const, intensity: 3, innerConeCos: 0.9, outerConeCos: 0.7 }],
  },
});

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 1, FRAGMENT: 2 });
  vi.stubGlobal("GPUBufferUsage", { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, UNIFORM: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 1 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("default PBR Forward+ frame runtime", () => {
  it("adapts the default grid at large output sizes without dropping depth slices", () => {
    const grid = createForwardPlusPbrGrid({ viewportWidth: 7680, viewportHeight: 4320, near: 0.1,
      far: 2_000, verticalFovRadians: Math.PI / 3 });
    expect(grid.tileSizeX).toBe(64); expect(grid.tileSizeY).toBe(64);
    expect(grid.zSlices).toBe(24); expect(grid.maxLightsPerCluster).toBe(64);
    expect(grid.clusterCount).toBeLessThanOrEqual(MAX_FORWARD_PLUS_CLUSTER_COUNT);
    expect(() => createForwardPlusPbrGrid({ viewportWidth: Number.POSITIVE_INFINITY, viewportHeight: 1,
      near: 0.1, far: 10, verticalFovRadians: 1 })).toThrow("viewportWidth");
  });

  it("encodes clustering before exposing one group-3 PBR binding and reuses stable resources", () => {
    const f = fixture(), runtime = new ForwardPlusPbrRuntime(f.session);
    const first = runtime.prepareAndEncode(f.encoder, input());
    const second = runtime.prepareAndEncode(f.encoder, input(63));
    expect(first).toMatchObject({ bindGroupIndex: 3, lightCount: 3 });
    expect(first.grid.clusterCount).toBe(8);
    expect(second.bindGroup).toBe(first.bindGroup);
    expect(second.resources.clusterHeaderBuffer).toBe(first.resources.clusterHeaderBuffer);
    expect(f.passes).toHaveLength(2);
    for (const pass of f.passes) {
      expect(pass.setPipeline).toHaveBeenCalledOnce(); expect(pass.setBindGroup).toHaveBeenCalledWith(0, expect.anything());
      expect(pass.dispatchWorkgroups).toHaveBeenCalledWith(1); expect(pass.end).toHaveBeenCalledOnce();
    }
    runtime.dispose(); runtime.dispose(); expect(f.owned.size).toBe(0);
    expect(f.buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });

  it("reuses stable cluster lists and rebuilds after a relevant light change or invalidation", () => {
    const f = fixture(), runtime = new ForwardPlusPbrRuntime(f.session);
    const first = runtime.prepareAndEncode(f.encoder, input());
    // E02：首帧上传含 IES 着色表占位缓冲（无 ies 场景为最小 -1 参数行）。
    expect(first.resources.uploadedInputBufferCount).toBe(6);
    f.device.queue.writeBuffer.mockClear();

    const stable = runtime.prepareAndEncode(f.encoder, input());
    expect(stable.resources.uploadedInputBufferCount).toBe(0);
    expect(f.device.queue.writeBuffer).not.toHaveBeenCalled();

    const moved = input();
    const changedInput = { ...moved, lights: { ...moved.lights,
      points: [{ ...moved.lights.points[0]!, positionView: [2, 0, -4] as const }] } };
    const changed = runtime.prepareAndEncode(f.encoder, changedInput);
    expect(changed.resources.uploadedInputBufferCount).toBe(2);
    expect(f.device.queue.writeBuffer.mock.calls.map(call => (call[0] as FakeBuffer).label)).toEqual([
      "Deep Forward+ point lights", "Deep Forward+ local light bounds", "Deep Forward+ overflow counter",
    ]);
    expect(f.passes).toHaveLength(2);
    runtime.invalidateAssignment(); runtime.prepareAndEncode(f.encoder, changedInput);
    expect(f.passes).toHaveLength(3);
    runtime.dispose();
  });

  it("rebuilds PBR bindings after grid capacity growth", () => {
    const f = fixture(), runtime = new ForwardPlusPbrRuntime(f.session);
    const first = runtime.prepareAndEncode(f.encoder, input());
    const grown = runtime.prepareAndEncode(f.encoder, input(160));
    expect(grown.grid.clusterCount).toBe(20);
    expect(grown.resources.clusterHeaderBuffer).not.toBe(first.resources.clusterHeaderBuffer);
    expect(grown.bindGroup).not.toBe(first.bindGroup);
    expect((first.resources.clusterHeaderBuffer as FakeBuffer).destroy).toHaveBeenCalledOnce();
    runtime.dispose(); expect(f.owned.size).toBe(0);
  });

  it("publishes and clears an external probe clipmap without taking its ownership", () => {
    const f = fixture(), runtime = new ForwardPlusPbrRuntime(f.session);
    const fallback = runtime.prepareAndEncode(f.encoder, input()).bindGroup;
    const view = { label: "published-gi" } as unknown as GPUTextureView;
    const sampler = { label: "published-gi" } as unknown as GPUSampler;
    const metadata = { label: "published-gi", destroy: vi.fn() } as unknown as GPUBuffer;
    runtime.setProbeClipmap({ view, sampler, levelMetadataBuffer: metadata });
    expect(runtime.hasProbeClipmap).toBe(true);
    const published = runtime.prepareAndEncode(f.encoder, input()).bindGroup as unknown as { entries: GPUBindGroupEntry[] };
    expect(published).not.toBe(fallback);
    expect(published.entries.slice(-3)).toEqual([{ binding: 9, resource: view }, { binding: 10, resource: sampler },
      { binding: 11, resource: { buffer: metadata } }]);
    runtime.setProbeClipmap({ view, sampler, levelMetadataBuffer: metadata });
    expect(runtime.prepareAndEncode(f.encoder, input()).bindGroup).toBe(published);
    runtime.setProbeClipmap(); expect(runtime.hasProbeClipmap).toBe(false);
    expect(runtime.prepareAndEncode(f.encoder, input()).bindGroup).not.toBe(published);
    runtime.dispose(); expect(metadata.destroy).not.toHaveBeenCalled();
  });

  it("fails early on insufficient limits, device loss, and use after disposal", () => {
    const lowLimits = fixture(); lowLimits.device.limits.maxStorageBuffersPerShaderStage = 6;
    expect(() => new ForwardPlusPbrRuntime(lowLimits.session)).toThrow("seven fragment storage buffers");
    const f = fixture(), runtime = new ForwardPlusPbrRuntime(f.session); f.rawSession.state = "lost";
    expect(() => runtime.prepareAndEncode(f.encoder, input())).toThrow("lost GPU session");
    runtime.dispose(); expect(() => runtime.prepareAndEncode(f.encoder, input())).toThrow("disposed");
  });
});
