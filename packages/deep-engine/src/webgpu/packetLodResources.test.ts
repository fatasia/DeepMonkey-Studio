import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { planCascadedShadows } from "../shadows/cascadedShadowPlanner.js";
import { PacketBuffers } from "./packetBuffers.js";
import { PACKET_LOD_BUDGET_WGSL, PACKET_LOD_INDIRECT_WGSL } from "./packetLodWgsl.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";
import type { GpuRenderResidencyHandle } from "./gpuRenderResidencyUploader.js";
import type { MeshBuffers } from "./meshBuffers.js";
import { createResidentPacketProjection } from "./residentPacketProjection.js";

interface FakeBuffer extends GPUBuffer { readonly label: string; readonly destroy: ReturnType<typeof vi.fn> }
interface Write { readonly buffer: FakeBuffer; readonly data: ArrayBuffer }

function fixture() {
  const owned = new Set<FakeBuffer>(), allocated: FakeBuffer[] = [], writes: Write[] = [], groups: GPUBindGroupDescriptor[] = [];
  const buffer = ({ label = "", size, usage }: GPUBufferDescriptor): FakeBuffer =>
    ({ label, size, usage, mapState: "unmapped", destroy: vi.fn() } as unknown as FakeBuffer);
  const copy = (data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => data instanceof ArrayBuffer
    ? data.slice(0) : data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  const device = { limits: { maxBufferSize: 256 * 1024 * 1024, maxStorageBufferBindingSize: 128 * 1024 * 1024,
      maxUniformBufferBindingSize: 65_536, maxComputeWorkgroupsPerDimension: 65_535 },
    createBuffer: vi.fn((descriptor: GPUBufferDescriptor) => { const value = buffer(descriptor); allocated.push(value); return value; }),
    createShaderModule: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroupLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createPipelineLayout: vi.fn(({ label }: { label: string }) => ({ label })),
    createComputePipeline: vi.fn(({ label }: { label: string }) => ({ label })),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => { groups.push(descriptor); return { descriptor }; }),
    queue: { writeBuffer: vi.fn((target: FakeBuffer, _offset: number,
      data: ArrayBuffer | ArrayBufferView<ArrayBuffer>) => writes.push({ buffer: target, data: copy(data) })) } };
  const session = { state: "ready", device,
    own<T extends FakeBuffer>(resource: T): T { owned.add(resource); return resource; },
    release(resource: FakeBuffer): void { if (owned.delete(resource)) resource.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession);
  const computePass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), dispatchWorkgroups: vi.fn(), end: vi.fn() };
  const encoder = { beginComputePass: vi.fn(() => computePass) };
  const renderPass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const pipelines = { mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "main"]]),
    shadowPipelines: new Map([[shadowPipelineKey("solid", "ccw"), "shadow"]]) } as unknown as Pipelines;
  const byLabel = (label: string) => allocated.filter(value => value.label === label);
  const lastWrite = (label: string) => writes.findLast(value => value.buffer.label === label)!.data;
  return { cache, device, owned, allocated, writes, groups, encoder, computePass, renderPass, pipelines, byLabel, lastWrite };
}

const transform = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1];
function geometry(id: string, triangles: number) {
  return { id, revision: 0, vertices: new Float32Array([
    0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
  ]), indices: new Uint32Array(Array.from({ length: triangles * 3 }, (_, index) => index % 3)) };
}
function packet(count = 64): RenderPacket {
  const lod = { levels: [
    { geometry: "high", minProjectedDiameterPixels: 120, geometricError: 0, resident: true },
    { geometry: "medium", minProjectedDiameterPixels: 32, geometricError: 0.25, resident: false },
    { geometry: "low", minProjectedDiameterPixels: 0, geometricError: 1, resident: true },
  ] } as const;
  return { geometries: [geometry("high", 8), geometry("medium", 4), geometry("low", 1)],
    materials: [{ id: "surface", baseColor: [0.4, 0.5, 0.6], metallic: 0, roughness: 0.5 }],
    instances: Array.from({ length: count }, (_, index) => ({ id: `part-${index}`,
      geometry: "high", material: "surface", transform, lod })) };
}

function partialResident(value: RenderPacket, ids: ReadonlySet<string>) {
  const prepared = prepareRenderPacket(value);
  const meshes = new Map<string, MeshBuffers & { drawIndirect: ReturnType<typeof vi.fn> }>();
  const handles = new Map<string, GpuRenderResidencyHandle>();
  for (const source of prepared.geometries.values()) {
    if (!ids.has(source.id)) continue;
    const mesh = { indexCount: source.indices.length, drawIndirect: vi.fn() } as unknown as
      MeshBuffers & { drawIndirect: ReturnType<typeof vi.fn> };
    meshes.set(source.id, mesh);
    handles.set(source.id, { kind: "geometry", sourceId: source.id,
      sourceRevision: source.revision, level: 0, mesh });
  }
  const projection = createResidentPacketProjection(prepared,
    (kind, id) => kind === "geometry" && handles.has(id)
      ? { resource: handles.get(id)!, release: vi.fn() } : undefined,
    { allowPartialLod: true });
  return { meshes, projection };
}
const frustum = { planes: [[1, 0, 0, 100], [-1, 0, 0, 100], [0, 1, 0, 100],
  [0, -1, 0, 100], [0, 0, 1, 100], [0, 0, -1, 100]] } as const;
const view = { camera: { projection: "perspective" as const, position: [0, 0, 0] as const,
  forward: [0, 0, 1] as const, verticalFovRadians: Math.PI / 2, near: 0.1, far: 1_000 },
  viewport: { width: 800, height: 600 }, frustum, budget: { maxObjects: 12, maxTriangles: 50 } };

beforeEach(() => {
  vi.stubGlobal("GPUShaderStage", { COMPUTE: 4 });
  vi.stubGlobal("GPUBufferUsage", { COPY_SRC: 4, COPY_DST: 8, INDEX: 16, VERTEX: 32,
    UNIFORM: 64, STORAGE: 128, INDIRECT: 256 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet LOD GPU path", () => {
  it.runIf(Boolean(process.env.DEEP_SHADER_NAGA_BIN))("passes Naga validation", () => {
    for (const [name, source] of [["budget", PACKET_LOD_BUDGET_WGSL], ["draw", PACKET_LOD_INDIRECT_WGSL]] as const) {
      const result = spawnSync(process.env.DEEP_SHADER_NAGA_BIN!,
        ["--stdin-file-path", `deep-packet-lod-${name}.wgsl`, "--input-kind", "wgsl"],
        { input: source, encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("Validation successful");
    }
  });

  it("connects packet order, one global budget, residency, compaction, and per-level indirect draws", () => {
    const f = fixture(); f.cache.set(packet());
    const stats = f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view);
    expect(stats).toEqual({ inputObjects: 64, selectionBatches: 1, indirectDraws: 2, historyReset: true });
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(3);
    expect(f.cache.encodeCulling(f.encoder as unknown as GPUCommandEncoder, frustum, "opaque"))
      .toEqual({ phase: "opaque", frustumBatches: 0, occlusionBatches: 0 });
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(3);
    expect(f.computePass.dispatchWorkgroups.mock.calls.map(call => call[0])).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    expect([...new Uint32Array(f.lastWrite("Deep packet LOD global budget")).slice(0, 4)]).toEqual([64, 1, 12, 50]);
    const objects = new Uint32Array(f.lastWrite("Deep packet LOD objects"));
    expect(objects[5]).toBe(0b101);
    const uniforms = new Uint32Array(f.lastWrite("Deep packet LOD draw parameters"));
    expect([...uniforms.slice(4, 16).filter((_value, index) => index % 4 === 0)]).toEqual([24, 12, 3]);
    const drawStats = f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder,
      f.pipelines, "opaque", undefined, true);
    expect(drawStats).toEqual({ drawCalls: 2, triangles: 512 });
    expect(f.renderPass.drawIndexed).not.toHaveBeenCalled();
    expect(f.renderPass.drawIndexedIndirect.mock.calls.map(call => call[1])).toEqual([0, 40]);
    expect(f.renderPass.setVertexBuffer.mock.calls.filter(call => call[0] === 1).map(call => call[2])).toEqual([0, 2 * 64 * 144]);
    expect(f.renderPass.setVertexBuffer.mock.calls.filter(call => call[0] === 2).map(call => call[2])).toEqual([0, 2 * 64 * 48]);
    f.cache.commitLodFrame();
    f.renderPass.drawIndexedIndirect.mockClear();
    f.renderPass.setVertexBuffer.mockClear();
    expect(() => f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "shadow"))
      .toThrow("was not encoded");
    f.cache.encodeShadowLod(f.encoder as unknown as GPUCommandEncoder, shadowPlan());
    expect(f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "shadow"))
      .toEqual({ drawCalls: 2, triangles: 512 });
    expect(f.renderPass.drawIndexed).not.toHaveBeenCalled();
    expect(f.renderPass.drawIndexedIndirect.mock.calls.map(call => call[1])).toEqual([0, 40]);
    expect(f.renderPass.setVertexBuffer.mock.calls.filter(call => call[0] === 1).map(call => call[2])).toEqual([0, 2 * 64 * 144]);
    expect(f.renderPass.setVertexBuffer.mock.calls.some(call => call[0] === 2)).toBe(false);
    f.cache.commitLodFrame(); f.cache.dispose();
  });

  it("draws only a resident coarsest mesh while complete fine bounds drive selection", () => {
    const f = fixture(), source = packet(1);
    const fine = { ...source.geometries[0]!, vertices: new Float32Array([
      -10, 0, 0, 0, 0, 1, 10, 0, 0, 0, 0, 1, 0, 10, 0, 0, 0, 1,
    ]) };
    const resident = partialResident({ ...source,
      geometries: [fine, ...source.geometries.slice(1)] }, new Set(["low"]));
    f.cache.stageResidentProjection(resident.projection);
    f.cache.publishResidentProjection();

    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view))
      .toMatchObject({ indirectDraws: 1 });
    const sphere = new Float32Array(f.lastWrite("Deep packet LOD objects")).slice(0, 4);
    expect(sphere[3]).toBeGreaterThan(10);
    expect(f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder,
      f.pipelines, "opaque")).toEqual({ drawCalls: 1, triangles: 8 });
    expect(resident.meshes.get("low")!.drawIndirect).toHaveBeenCalledOnce();
    expect(resident.meshes.has("high")).toBe(false);
    expect(resident.meshes.has("medium")).toBe(false);
    f.cache.cancelLodFrame(); f.cache.dispose();
  });

  it.each([1, -1])("uploads a conservative LOD sphere for a sheared basis with handedness %s", (handedness) => {
    const f = fixture(), source = packet(1);
    const transform = [handedness, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1];
    f.cache.set({ ...source, instances: [{ ...source.instances[0]!, transform }] });
    f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view);
    const sphere = new Float32Array(f.lastWrite("Deep packet LOD objects")).slice(0, 4);
    expect(sphere[3]).toBeGreaterThanOrEqual(Math.sqrt(1.5));
    expect(sphere[3]).toBeCloseTo(Math.sqrt(1.5), 5);
    // Local vertex (0, 1, 0) transforms to (1, 1, 10), inside the uploaded sphere.
    expect(Math.hypot(1 - sphere[0]!, 1 - sphere[1]!, 10 - sphere[2]!)).toBeLessThanOrEqual(sphere[3]!);
    f.cache.cancelLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("does not inflate a rotating object's uploaded LOD diameter", () => {
    const f = fixture(), source = packet(1), r = Math.SQRT1_2;
    f.cache.set({ ...source, instances: [{ ...source.instances[0]!,
      transform: [r, r, 0, 0, -r, r, 0, 0, 0, 0, 1, 0, 0, 0, 10, 1] }] });
    f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view);
    const sphere = new Float32Array(f.lastWrite("Deep packet LOD objects")).slice(0, 4);
    expect(sphere[3]).toBeCloseTo(Math.SQRT1_2, 6);
    f.cache.cancelLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });
  it("dispatches 1K objects as four parallel budget and per-level blocks", () => {
    const f = fixture(); f.cache.set(packet(1_024));
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view).inputObjects).toBe(1_024);
    expect(f.computePass.dispatchWorkgroups.mock.calls.map(call => call[0])).toEqual([16, 4, 4, 1, 4, 4, 1, 4]);
    f.cache.cancelLodFrame(); f.cache.dispose();
  });

  it("keeps LOD history and draws on the submit boundary, then releases every owned resource", () => {
    const f = fixture(); f.cache.set(packet(2));
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view).historyReset).toBe(true);
    expect(() => f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view)).toThrow("pending submission");
    f.cache.failLodFrame();
    expect(() => f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "opaque"))
      .toThrow("was not encoded");
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view).historyReset).toBe(true);
    f.cache.commitLodFrame();
    f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view);
    f.cache.failLodFrame();
    expect(() => f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "opaque"))
      .toThrow("was not encoded");
    f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view);
    f.cache.commitLodFrame();
    const source = packet(2), moved = source.instances.map(instance => ({ ...instance,
      transform: transform.map((value, index) => index === 14 ? 11 : value) }));
    expect(f.cache.updateInstances({ materials: source.materials, instances: moved })).toBe(true);
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view).historyReset).toBe(false);
    f.cache.cancelLodFrame();
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view).historyReset).toBe(false);
    f.cache.commitLodFrame();
    expect(f.encoder.beginComputePass).toHaveBeenCalledTimes(16);
    f.cache.dispose(); f.cache.dispose();
    expect(f.owned.size).toBe(0);
    expect(f.allocated.every(resource => resource.destroy.mock.calls.length === 1)).toBe(true);
  });
  it("shares one scene upload but isolates every cascade from color budgets and other light views", () => {
    const f = fixture(); f.cache.set(packet(4));
    const encoder = f.encoder as unknown as GPUCommandEncoder;
    f.cache.encodeLod(encoder, { ...view, budget: { maxObjects: 0 } });
    const stats = f.cache.encodeShadowLod(encoder, shadowPlan());
    expect(stats).toEqual({ inputObjects: 4, selectionBatches: 3, indirectDraws: 6, historyReset: true });
    for (const label of ["Deep packet LOD objects", "Deep packet LOD levels"]) {
      expect(f.byLabel(label)).toHaveLength(1);
      expect(f.writes.filter(write => write.buffer.label === label)).toHaveLength(1);
    }
    const uniforms = f.writes.filter(write => write.buffer.label === "Deep packet LOD global budget");
    expect(new Set(uniforms.map(write => write.buffer)).size).toBe(4);
    expect(uniforms.map(write => new Uint32Array(write.data)[2])).toEqual([0, 4, 4, 4]);
    const outputs: GPUBuffer[] = [];
    for (let cascade = 0; cascade < 3; cascade++) {
      f.renderPass.drawIndexedIndirect.mockClear();
      f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "shadow", undefined, true, cascade);
      outputs.push(f.renderPass.drawIndexedIndirect.mock.calls[0]![0]);
    }
    expect(new Set(outputs).size).toBe(3);
    f.cache.commitLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

  it("retires shared LOD input buffers as soon as a packet no longer contains LOD batches", () => {
    const f = fixture(), source = packet(1); f.cache.set(source);
    f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view); f.cache.commitLodFrame();
    const inputs = [...f.byLabel("Deep packet LOD objects"), ...f.byLabel("Deep packet LOD levels")];
    expect(inputs).toHaveLength(2);
    const instances = source.instances.map(instance => ({ id: instance.id,
      geometry: instance.geometry, material: instance.material, transform: instance.transform }));
    f.cache.set({ ...source, instances });
    expect(inputs.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
    expect(f.cache.encodeLod(f.encoder as unknown as GPUCommandEncoder, view))
      .toEqual({ inputObjects: 0, selectionBatches: 0, indirectDraws: 0, historyReset: false });
    f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

  it("cancels partial multi-cascade encoding and resets history after an uncertain submission", () => {
    const f = fixture(); f.cache.set(packet(2));
    const encoder = f.encoder as unknown as GPUCommandEncoder, plan = shadowPlan();
    f.cache.encodeLod(encoder, view);
    f.encoder.beginComputePass.mockImplementationOnce(() => { throw new Error("encoder rejected"); });
    expect(() => f.cache.encodeShadowLod(encoder, plan)).toThrow("encoder rejected");
    f.cache.cancelLodFrame();
    expect(f.cache.encodeShadowLod(encoder, plan).historyReset).toBe(true);
    f.cache.failLodFrame();
    expect(() => f.cache.draw(f.renderPass as unknown as GPURenderPassEncoder, f.pipelines, "shadow"))
      .toThrow("was not encoded");
    expect(f.cache.encodeShadowLod(encoder, plan).historyReset).toBe(true);
    f.cache.commitLodFrame();
    expect(f.cache.encodeShadowLod(encoder, plan).historyReset).toBe(false);
    f.cache.cancelLodFrame(); f.cache.dispose(); expect(f.owned.size).toBe(0);
  });

});

function shadowPlan() {
  return planCascadedShadows({ eye: [0, 0, 0], target: [0, 0, 1], near: 0.1, far: 100,
    verticalFovRadians: Math.PI / 2, aspect: 1 }, [0, -1, 0], { cascadeCount: 3, shadowMapSize: 64 });
}
