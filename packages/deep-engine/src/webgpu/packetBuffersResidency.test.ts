import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { GpuRenderResidencyHandle } from "./gpuRenderResidencyUploader.js";
import type { GpuTextureResidencyHandle } from "./gpuTextureResidencyUploader.js";
import type { MeshBuffers } from "./meshBuffers.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, type Pipelines } from "./pipelines.js";
import { createResidentPacketProjection } from "./residentPacketProjection.js";
import { bindGpuResidencyHandleDevice } from "./gpuResidencyDeviceAffinity.js";

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

interface BufferStub { readonly label?: string; readonly destroy: ReturnType<typeof vi.fn> }
interface TextureStub { readonly createView: ReturnType<typeof vi.fn>; readonly destroy: ReturnType<typeof vi.fn> }
interface MeshStub {
  readonly indexCount: number;
  readonly draw: ReturnType<typeof vi.fn>;
  readonly drawIndirect: ReturnType<typeof vi.fn>;
  readonly dispose: ReturnType<typeof vi.fn>;
}

function packet(options: { textured?: boolean; translation?: number; revision?: number } = {}): RenderPacket {
  const textured = options.textured ?? true;
  const transform = [...IDENTITY]; transform[12] = options.translation ?? 0;
  return {
    geometries: [{ id: "geometry", revision: options.revision ?? 1,
      vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    textures: textured ? [{ id: "albedo", revision: 1, semantic: "baseColor",
      width: 1, height: 1, data: new Uint8Array([255, 128, 64, 255]) }] : [],
    materials: [{ id: "material", baseColor: [1, 1, 1], metallic: 0, roughness: 1,
      ...(textured ? { baseColorTexture: { texture: "albedo" } } : {}) }],
    instances: [{ id: "instance", geometry: "geometry", material: "material", transform }],
  };
}

function mesh(): MeshStub {
  return { indexCount: 3, draw: vi.fn(), drawIndirect: vi.fn(), dispose: vi.fn() };
}

function fixture() {
  const owned = new Set<object>(), buffers: BufferStub[] = [], textures: TextureStub[] = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 16_384 },
    features: new Set<string>(),
    createBuffer: vi.fn(({ label }: GPUBufferDescriptor) => {
      const value = { label, destroy: vi.fn() }; buffers.push(value); return value as unknown as GPUBuffer;
    }),
    createTexture: vi.fn(() => {
      const value = { createView: vi.fn(() => ({})), destroy: vi.fn() };
      textures.push(value); return value as unknown as GPUTexture;
    }),
    createSampler: vi.fn(() => ({})), createBindGroup: vi.fn(() => ({})),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(value: T): T { owned.add(value); return value; },
    release(value: { destroy(): void }): void { if (owned.delete(value)) value.destroy(); },
  } as unknown as DeviceSession;
  const cache = new PacketBuffers(session, { material: {} as GPUBindGroupLayout });
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(),
    setIndexBuffer: vi.fn(), drawIndexed: vi.fn(), drawIndexedIndirect: vi.fn() };
  const mainPipelines = new Map([
    [mainPipelineKey("plain", false, "ccw"), {} as GPURenderPipeline],
    [mainPipelineKey("material", false, "ccw"), {} as GPURenderPipeline],
  ]);
  const pipelines = { mainPipelines, shadowPipelines: new Map() } as unknown as Pipelines;
  const draw = () => cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, "opaque");
  const labels = () => buffers.map(value => value.label);
  return { buffers, cache, device, draw, labels, owned, pass, session, textures };
}

function resident(value: RenderPacket, options: {
  mesh?: MeshStub;
  texture?: GpuTextureResidencyHandle;
  device?: GPUDevice;
  onRelease?: (key: string) => void;
} = {}) {
  const prepared = prepareRenderPacket(value), geometryMesh = options.mesh ?? mesh();
  const textureSource = prepared.textures[0];
  const textureStub = { createView: vi.fn(), destroy: vi.fn() };
  const texture = options.texture ?? (textureSource ? {
    kind: "texture", id: textureSource.id, revision: textureSource.revision, level: 0,
    texture: textureStub as unknown as GPUTexture, view: {} as GPUTextureView,
    sampler: {} as GPUSampler, byteLength: textureSource.byteLength,
    semantic: textureSource.semantic, format: textureSource.format,
    width: textureSource.levels[0]!.width, height: textureSource.levels[0]!.height,
    mipLevelCount: textureSource.levels.length,
  } satisfies GpuTextureResidencyHandle : undefined);
  const resources = new Map<string, GpuRenderResidencyHandle>();
  for (const source of prepared.geometries.values()) resources.set(`geometry:${source.id}`, {
    kind: "geometry", sourceId: source.id, sourceRevision: source.revision,
    level: 0, mesh: geometryMesh as unknown as MeshBuffers,
  });
  if (texture) resources.set(`texture:${texture.id}`, texture);
  if (options.device) for (const handle of resources.values()) {
    bindGpuResidencyHandleDevice(handle, options.device);
  }
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  const projection = createResidentPacketProjection(prepared, (kind, id) => {
    const key = `${kind}:${id}`, resource = resources.get(key);
    if (!resource) return undefined;
    const release = vi.fn(() => options.onRelease?.(key)); releases.set(key, release);
    return { resource, release };
  });
  return { mesh: geometryMesh, projection, releases, texture, textureStub };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8, STORAGE: 128, UNIFORM: 64 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("PacketBuffers streamed residency integration", () => {
  it("keeps an empty cache drawable while staging and publishes borrowed resources without duplicate uploads", () => {
    const f = fixture(), r = resident(packet());
    expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 });
    expect(f.cache.stageResidentProjection(r.projection)).toBe(true);
    expect(f.draw()).toEqual({ drawCalls: 0, triangles: 0 });
    // 参数池接管 160B 材质块后，池路径不再创建独立的 "Deep material textures" buffer。
    expect(f.labels()).toEqual([
      "Deep material parameter pool", "Deep packet instances", "Deep packet previous transforms",
    ]);
    expect(f.device.createTexture).not.toHaveBeenCalled();

    expect(f.cache.publishResidentProjection()).toBe(true);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(r.mesh.draw).toHaveBeenCalledOnce();
    expect(r.projection.released).toBe(false);
    f.cache.dispose();
  });

  it("installs a replacement before releasing the old lease and reuses batch buffers and material", () => {
    const f = fixture(); let duringRetirement: ReturnType<typeof f.draw> | undefined;
    const first = resident(packet(), { onRelease: key => {
      if (key === "geometry:geometry") duringRetirement = f.draw();
    } });
    f.cache.stageResidentProjection(first.projection); f.cache.publishResidentProjection();
    const secondMesh = mesh();
    const second = resident(packet(), { mesh: secondMesh, texture: first.texture });
    f.device.createBuffer.mockClear(); f.device.createBindGroup.mockClear();

    expect(f.cache.stageResidentProjection(second.projection)).toBe(true);
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.device.createBindGroup).not.toHaveBeenCalled();
    expect(f.cache.publishResidentProjection()).toBe(true);
    expect(duringRetirement).toEqual({ drawCalls: 1, triangles: 1 });
    expect(secondMesh.draw).toHaveBeenCalledOnce();
    expect(first.mesh.draw).not.toHaveBeenCalled();
    expect(first.projection.released).toBe(true);
    expect(second.projection.released).toBe(false);
    f.cache.dispose(); expect(second.projection.released).toBe(true);
  });

  it("cancels pending resident stages through set, update and a newer stage", () => {
    const f = fixture(), first = resident(packet());
    f.cache.stageResidentProjection(first.projection);
    const firstBuffers = f.buffers.slice();
    f.cache.set(packet({ textured: false }));
    expect(first.projection.released).toBe(true);
    for (const value of firstBuffers) expect(value.destroy).toHaveBeenCalledOnce();

    const second = resident(packet({ translation: 1 }));
    const secondStart = f.buffers.length;
    f.cache.stageResidentProjection(second.projection);
    const plain = packet({ textured: false, translation: 2 });
    f.cache.updateInstances({ materials: plain.materials, instances: plain.instances });
    expect(second.projection.released).toBe(true);
    for (const value of f.buffers.slice(secondStart)) expect(value.destroy).toHaveBeenCalledOnce();

    const third = resident(packet({ translation: 3 }));
    const thirdStart = f.buffers.length;
    f.cache.stageResidentProjection(third.projection);
    const fourth = resident(packet({ translation: 4 }));
    f.cache.stageResidentProjection(fourth.projection);
    expect(third.projection.released).toBe(true);
    for (const value of f.buffers.slice(thirdStart, thirdStart + 3)) {
      expect(value.destroy).toHaveBeenCalledOnce();
    }
    expect(fourth.projection.released).toBe(false);
    f.cache.dispose(); expect(fourth.projection.released).toBe(true);
  });

  it("rebuilds owned legacy geometry after a resident packet without disposing borrowed handles", () => {
    const f = fixture(), r = resident(packet());
    f.cache.stageResidentProjection(r.projection); f.cache.publishResidentProjection();
    f.device.createBuffer.mockClear(); r.mesh.draw.mockClear();
    expect(f.cache.set(packet({ textured: false, revision: 2 }))).toBe(true);
    expect(f.device.createBuffer.mock.calls.map(call => call[0].label)).toEqual([
      "Deep vertices", "Deep indices", "Deep packet instances", "Deep packet previous transforms",
    ]);
    expect(r.projection.released).toBe(true);
    for (const release of r.releases.values()) expect(release).toHaveBeenCalledOnce();
    expect(r.mesh.dispose).not.toHaveBeenCalled();
    expect(r.textureStub.destroy).not.toHaveBeenCalled();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(r.mesh.draw).not.toHaveBeenCalled();
    f.cache.dispose();
    for (const release of r.releases.values()) expect(release).toHaveBeenCalledOnce();
  });

  it("updates streamed textured instances through the active lookup and disposes only owned auxiliaries", () => {
    const f = fixture(), r = resident(packet());
    f.cache.stageResidentProjection(r.projection); f.cache.publishResidentProjection();
    const auxiliaries = f.buffers.slice();
    f.device.createBuffer.mockClear(); f.device.createTexture.mockClear(); f.device.createBindGroup.mockClear();
    const moved = packet({ translation: 5 });
    expect(f.cache.updateInstances({ materials: moved.materials, instances: moved.instances })).toBe(true);
    expect(f.device.createBuffer).not.toHaveBeenCalled();
    expect(f.device.createTexture).not.toHaveBeenCalled();
    expect(f.device.createBindGroup).not.toHaveBeenCalled();
    expect(r.projection.released).toBe(false);

    f.cache.dispose(); f.cache.dispose();
    expect(r.projection.released).toBe(true);
    for (const release of r.releases.values()) expect(release).toHaveBeenCalledOnce();
    for (const value of auxiliaries) expect(value.destroy).toHaveBeenCalledOnce();
    expect(r.mesh.dispose).not.toHaveBeenCalled();
    expect(r.textureStub.destroy).not.toHaveBeenCalled();
  });

  it("keeps the old packet drawable until resident auxiliary GPU validation completes", async () => {
    const f = fixture(); f.cache.set(packet({ textured: false }));
    const oldDraw = f.draw();
    const checks: Array<(error: GPUError | null) => void> = [];
    f.device.popErrorScope.mockImplementation(() =>
      new Promise<GPUError | null>(resolve => checks.push(resolve)));
    const r = resident(packet({ translation: 6 }));
    const validated = f.cache.stageResidentProjectionValidated(r.projection);
    expect(f.device.pushErrorScope).toHaveBeenCalledTimes(3);
    expect(f.device.popErrorScope).toHaveBeenCalledTimes(3);
    expect(f.draw()).toEqual(oldDraw);
    checks.forEach(resolve => resolve(null));
    await expect(validated).resolves.toBe(true);
    expect(f.draw()).toEqual(oldDraw);
    f.cache.publishResidentProjection();
    r.mesh.draw.mockClear();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(r.mesh.draw).toHaveBeenCalledOnce();
    f.cache.dispose();
  });

  it("rolls back a resident candidate rejected by GPU validation", async () => {
    const f = fixture(); f.cache.set(packet({ textured: false }));
    const r = resident(packet()), error = { message: "candidate rejected" } as GPUError;
    f.device.popErrorScope.mockReturnValueOnce(Promise.resolve(error))
      .mockReturnValueOnce(Promise.resolve(null)).mockReturnValueOnce(Promise.resolve(null));
    await expect(f.cache.stageResidentProjectionValidated(r.projection))
      .rejects.toThrow("GPU resident packet preparation failed: candidate rejected");
    expect(r.projection.released).toBe(true);
    expect(f.cache.publishResidentProjection()).toBe(false);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.dispose();
  });

  it("aborts a validating resident candidate without publishing or leaking it", async () => {
    const f = fixture(), r = resident(packet()), controller = new AbortController();
    f.device.popErrorScope.mockImplementation(() => new Promise<GPUError | null>(() => {}));
    const validated = f.cache.stageResidentProjectionValidated(r.projection, controller.signal);
    controller.abort();
    await expect(validated).rejects.toMatchObject({ name: "AbortError" });
    expect(r.projection.released).toBe(true);
    expect(f.cache.publishResidentProjection()).toBe(false);
    expect(f.owned.size).toBe(0);
    f.cache.dispose();
  });

  it("cancels only the unpublished resident candidate and preserves the active draw", () => {
    const f = fixture(), active = resident(packet({ translation: 1 }));
    f.cache.stageResidentProjection(active.projection);
    f.cache.publishResidentProjection();
    const candidate = resident(packet({ translation: 2 }));
    f.cache.stageResidentProjection(candidate.projection);

    f.cache.cancelPendingPacketStage();

    expect(candidate.projection.released).toBe(true);
    expect(active.projection.released).toBe(false);
    expect(f.cache.publishResidentProjection()).toBe(false);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.dispose();
    expect(active.projection.released).toBe(true);
  });

  it("rejects a stale device epoch before staging and preserves the active draw", () => {
    const f = fixture(), active = resident(packet({ textured: false }));
    f.cache.stageResidentProjection(active.projection); f.cache.publishResidentProjection();
    const stale = resident(packet({ textured: false, translation: 2 }),
      { device: {} as GPUDevice });

    expect(() => f.cache.stageResidentProjection(stale.projection)).toThrow("stale device epoch");
    expect(f.cache.publishResidentProjection()).toBe(false);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(active.projection.released).toBe(false);
    stale.projection.release(); f.cache.dispose();
  });
});
