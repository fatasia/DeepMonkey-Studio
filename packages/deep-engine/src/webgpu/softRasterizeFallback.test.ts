/// <reference types="@webgpu/types" />
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { DeviceSession } from "./deviceSession.js";
import { createSoftRasterTarget, rasterizeTriangle, VISIBILITY_CLEAR_SLOT,
  type SoftRasterTarget } from "./softRasterizeReference.js";
import { packSoftRasterTriangles, rasterizePackedTrianglesCpu, SoftRasterizeFallback,
  SOFT_RASTERIZE_TRIANGLE_FLOATS, unpackSoftRasterTriangle,
  type SoftRasterFallbackFrameInput, type SoftRasterTriangleInput } from "./softRasterizeFallback.js";
import { VISIBILITY_SLOT_ROW_FLOATS } from "./visibilityBufferEncoding.js";
import { VISIBILITY_RESOLVE_WGSL } from "./visibilityBufferWgsl.js";

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, STORAGE: 128, COPY_DST: 8, COPY_SRC: 4 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const tri = (dx: number, localIndex: number): SoftRasterTriangleInput =>
  ({ ax: 1 + dx, ay: 1, az: 0.25, bx: 3.5, by: 6, bz: 0.5, cx: 6 + dx, cy: 1, cz: 0.75, triangleLocalIndex: localIndex });

describe("soft rasterize fallback packing contract", () => {
  it("packs 10 floats per triangle and unpacks bit-identically", () => {
    const triangles = [tri(0, 7), tri(0.25, 125)];
    const packed = packSoftRasterTriangles(triangles);
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed.length).toBe(2 * SOFT_RASTERIZE_TRIANGLE_FLOATS);
    expect([...packed].slice(0, 10)).toEqual([1, 1, 0.25, 3.5, 6, 0.5, 6, 1, 0.75, 7]);
    expect(unpackSoftRasterTriangle(packed, 1)).toEqual(triangles[1]);
    expect(packSoftRasterTriangles([], new Float32Array(0))).toHaveLength(0);
  });

  it("rejects a pack target of the wrong size and out-of-range unpack indices", () => {
    expect(() => packSoftRasterTriangles([tri(0, 0)], new Float32Array(4))).toThrow(RangeError);
    expect(() => unpackSoftRasterTriangle(new Float32Array(10), -1)).toThrow(RangeError);
    expect(() => unpackSoftRasterTriangle(new Float32Array(10), 1)).toThrow(RangeError);
  });

  it("rasterizes the packed buffer with slotBase+i, bit-identical to per-triangle calls", () => {
    const triangles = [tri(0, 3), tri(0.5, 9)];
    const packed = packSoftRasterTriangles(triangles);
    const viaContract = createSoftRasterTarget(8, 8);
    const direct = createSoftRasterTarget(8, 8);
    rasterizePackedTrianglesCpu(viaContract, packed, triangles.length, 11);
    triangles.forEach((triangle, index) => rasterizeTriangle(direct, { ...triangle, slot: 11 + index }));
    expect([...viaContract.slot]).toEqual([...direct.slot]);
    expect([...viaContract.packedTriangle]).toEqual([...direct.packedTriangle]);
    expect([...viaContract.depth]).toEqual([...direct.depth]);
    // 可见性目标级 alias：目标初值（硬件已写内容）在未覆盖像素保持、覆盖像素被改写。
    const alias = createSoftRasterTarget(8, 8);
    alias.slot.fill(7); alias.packedTriangle.fill(5);
    expect(rasterizePackedTrianglesCpu(alias, packed, triangles.length, 21)).toBeGreaterThan(0);
    const covered = alias.slot.findIndex(slot => slot === 21);
    expect(covered).toBeGreaterThanOrEqual(0);
    expect(alias.packedTriangle[covered]).toBe(3);
    expect(alias.depth[covered]).toBeLessThan(1);
    for (let pixel = 0; pixel < alias.slot.length; pixel++) {
      if (alias.slot[pixel] === 7) { expect(alias.packedTriangle[pixel]).toBe(5); expect(alias.depth[pixel]).toBe(1); }
    }
  });

  it("fails closed when the packed buffer or slot space is inconsistent", () => {
    const target = createSoftRasterTarget(4, 4);
    expect(() => rasterizePackedTrianglesCpu(target, new Float32Array(9), 1, 0)).toThrow(RangeError);
    expect(() => rasterizePackedTrianglesCpu(target, new Float32Array(10), -1, 0)).toThrow(RangeError);
    expect(() => rasterizePackedTrianglesCpu(target, new Float32Array(10), 1, VISIBILITY_CLEAR_SLOT)).toThrow(RangeError);
  });
});

function makeSession(): { session: DeviceSession; device: Record<string, ReturnType<typeof vi.fn>>; release: ReturnType<typeof vi.fn> } {
  const release = vi.fn();
  const layout = { getBindGroupLayout: vi.fn(() => ({})) };
  const pipelineMin = { label: "min", getBindGroupLayout: vi.fn(() => layout) };
  const pipelineWrite = { label: "write", getBindGroupLayout: vi.fn(() => layout) };
  const resolveVariant = { label: "resolve" };
  const device = {
    createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [] }) })),
    createBindGroupLayout: vi.fn((d: unknown) => d),
    createPipelineLayout: vi.fn((d: unknown) => d),
    createComputePipelineAsync: vi.fn(async (d: { label: string }) => d.label.includes("write") ? pipelineWrite : pipelineMin),
    createRenderPipelineAsync: vi.fn(async (d: { label: string }) => d.label.includes("fallback") ? resolveVariant : ({ label: d.label })),
    createBuffer: vi.fn((d: { label: string }) => ({ label: d.label })),
    createBindGroup: vi.fn((d: unknown) => d),
    queue: { writeBuffer: vi.fn() },
  };
  const session = { state: "ready", device, own: (value: unknown) => value, release } as unknown as DeviceSession;
  return { session, device, release };
}

function makeEncoder() {
  const computePasses: Record<string, unknown>[] = [];
  const events: string[] = [];
  const makePass = (kind: string) => {
    const pass: Record<string, ReturnType<typeof vi.fn>> = {
      setPipeline: vi.fn((p: { label: string }) => events.push(`${kind}:${p.label}`)),
      setBindGroup: vi.fn(() => events.push(`${kind}:bind`)),
      dispatchWorkgroups: vi.fn((x: number) => events.push(`${kind}:dispatch${x}`)),
      draw: vi.fn(() => events.push(`${kind}:draw`)),
      end: vi.fn(() => events.push(`${kind}:end`)),
    };
    return pass;
  };
  return {
    events, computePasses,
    beginComputePass: vi.fn((d: { label: string }) => { const pass = makePass("compute"); computePasses.push(pass); return pass; }),
    beginRenderPass: vi.fn((d: { label: string }) => makePass(`render:${d.label}`)),
  } as unknown as GPUCommandEncoder & { events: string[]; computePasses: Record<string, ReturnType<typeof vi.fn>>[] };
}

const frameInput = (triangleCount: number, slotBaseRows = triangleCount): SoftRasterFallbackFrameInput =>
  ({ triangles: packSoftRasterTriangles(Array.from({ length: triangleCount }, (_, i) => tri(i * 0.25, i + 1))),
    triangleCount, slotRows: new Float32Array(slotBaseRows * VISIBILITY_SLOT_ROW_FLOATS).fill(0.5) });

describe("soft rasterize fallback executor", () => {
  it("is fail-closed before pipelines are ready", async () => {
    const { session } = makeSession();
    const fallback = new SoftRasterizeFallback(session);
    expect(fallback.resolvePipeline).toBeUndefined();
    expect(fallback.encodeRaster(makeEncoder(), frameInput(1), 0, 8, 8)).toBeUndefined();
    await fallback.ensure();
    expect(fallback.failureReason).toBeUndefined();
    expect(fallback.resolvePipeline).toBeDefined();
  });

  it("encodes one compute pass with both dispatches and the contract write sequence", async () => {
    const { session, device } = makeSession();
    const fallback = new SoftRasterizeFallback(session);
    await fallback.ensure();
    const encoder = makeEncoder();
    expect(fallback.encodeRaster(encoder, frameInput(68), 5, 16, 12)).toBe(68);
    const pass = encoder.computePasses[0]!;
    expect(pass.setPipeline).toHaveBeenCalledTimes(2);
    expect(pass.dispatchWorkgroups).toHaveBeenNthCalledWith(1, 2, 1, 1);
    expect(pass.dispatchWorkgroups).toHaveBeenNthCalledWith(2, 2, 1, 1);
    expect(pass.end).toHaveBeenCalledTimes(1);
    const writes = (device.queue.writeBuffer as ReturnType<typeof vi.fn>).mock.calls;
    expect(writes.map(call => (call[0] as { label: string }).label)).toEqual(
      ["Deep soft raster triangles", "Deep soft raster params", "Deep soft raster faults", "Deep soft raster depth-key scratch"]);
    expect([...(writes[1]![2] as Uint32Array)]).toEqual([16, 12, 68, 5]);
    expect([...(writes[2]![2] as Uint32Array)]).toEqual([0]);
    expect((writes[3]![2] as Uint32Array).every(word => word === 0xffff_ffff)).toBe(true);
    // 复用帧（同 viewport/容量）不再重建 bindGroup。
    (device.createBindGroup as ReturnType<typeof vi.fn>).mockClear();
    expect(fallback.encodeRaster(makeEncoder(), frameInput(4), 9, 16, 12)).toBe(4);
    expect(device.createBindGroup).not.toHaveBeenCalled();
  });

  it("rejects malformed inputs, exhausted slots, and a non-ready session", async () => {
    const { session } = makeSession();
    const fallback = new SoftRasterizeFallback(session);
    await fallback.ensure();
    expect(fallback.encodeRaster(makeEncoder(), frameInput(0), 0, 8, 8)).toBeUndefined();
    expect(fallback.encodeRaster(makeEncoder(),
      { triangles: new Float32Array(10), triangleCount: 2, slotRows: new Float32Array(32) }, 0, 8, 8)).toBeUndefined();
    expect(fallback.encodeRaster(makeEncoder(),
      { triangles: new Float32Array(20), triangleCount: 2, slotRows: new Float32Array(16) }, 0, 8, 8)).toBeUndefined();
    expect(fallback.encodeRaster(makeEncoder(), frameInput(2, 2), VISIBILITY_CLEAR_SLOT - 1, 8, 8)).toBeUndefined();
    (session as { state: string }).state = "suspended";
    expect(fallback.encodeRaster(makeEncoder(), frameInput(2), 0, 8, 8)).toBeUndefined();
  });

  it("surfaces shader failures as a reason and keeps encoding fail-closed", async () => {
    const device = {
      createShaderModule: vi.fn(() => ({ getCompilationInfo: async () => ({ messages: [
        { type: "error", lineNum: 3, message: "synthetic compile error" }] }) })),
      createBindGroupLayout: vi.fn(), createPipelineLayout: vi.fn(), queue: { writeBuffer: vi.fn() },
    };
    const session = { state: "ready", device, own: (value: unknown) => value, release: vi.fn() } as unknown as DeviceSession;
    const fallback = new SoftRasterizeFallback(session);
    await fallback.ensure();
    expect(fallback.failureReason).toContain("synthetic compile error");
    expect(fallback.encodeRaster(makeEncoder(), frameInput(1), 0, 8, 8)).toBeUndefined();
  });

  it("releases every owned buffer on dispose", async () => {
    const { session, release } = makeSession();
    const fallback = new SoftRasterizeFallback(session);
    await fallback.ensure();
    expect(fallback.encodeRaster(makeEncoder(), frameInput(1), 0, 8, 8)).toBe(1);
    const held = release.mock.calls.length;
    fallback.dispose();
    expect(release.mock.calls.length).toBeGreaterThan(held);
    expect(fallback.encodeRaster(makeEncoder(), frameInput(1), 0, 8, 8)).toBeUndefined();
  });
});

describe("soft rasterize fallback resolve variant", () => {
  it("shares one shading formula between the main and fallback fragment entries", () => {
    expect(VISIBILITY_RESOLVE_WGSL).toContain("fn fragmentVisibilityResolveFallback(@builtin(position) fragCoord: vec4f)");
    expect(VISIBILITY_RESOLVE_WGSL.split("fn shadeVisibility(").length - 1).toBe(1);
    expect(VISIBILITY_RESOLVE_WGSL.split("shadeVisibility(").length - 1).toBeGreaterThanOrEqual(3);
    for (const marker of ["@group(1) @binding(3) var<storage, read> fallbackSlot: array<u32>;",
      "@group(1) @binding(4) var<storage, read> fallbackPacked: array<u32>;",
      "@group(1) @binding(5) var<storage, read> fallbackDepth: array<f32>;"]) {
      expect(VISIBILITY_RESOLVE_WGSL).toContain(marker);
    }
    // 后备命中判定与编码哨兵同源：slot ≠ 0xffffffff。
    expect(VISIBILITY_RESOLVE_WGSL).toContain("let useSoft = softSlot != 0xffffffffu;");
  });

  it("exposes the three fallback channels as resolve group(1) bindings 3..5", async () => {
    const { session } = makeSession();
    const fallback = new SoftRasterizeFallback(session);
    await fallback.ensure();
    const encoder = makeEncoder();
    expect(fallback.encodeRaster(encoder, frameInput(1), 0, 8, 8)).toBe(1);
    const entries = fallback.resolveEntries();
    expect(entries.map(entry => entry.binding)).toEqual([3, 4, 5]);
    expect(fallback.resolvePipeline).toBeDefined();
  });
});
