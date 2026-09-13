import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { PacketBuffers } from "./packetBuffers.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
function packet(revision = 0): RenderPacket {
  return {
    geometries: [{ id: "g", revision, vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
      uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    textures: [{ id: "color", revision, semantic: "baseColor", width: 1, height: 1,
      data: new Uint8Array([revision ? 64 : 255, 128, 32, 255]) }],
    materials: [{ id: "m", baseColor: [0.5, 0.6, 0.7], metallic: 0.25, roughness: 0.5,
      baseColorTexture: { texture: "color", offset: [0.25, 0.5] } }],
    instances: [{ id: "i", geometry: "g", material: "m", transform: identity }],
  };
}

function normalPacket(revision = 0): RenderPacket {
  const source = packet(revision);
  return {
    ...source,
    geometries: [{ ...source.geometries[0]!, tangents: new Float32Array([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]) }],
    textures: [...source.textures!, { id: "normal", revision, semantic: "normal", width: 1, height: 1,
      data: new Uint8Array([128, revision ? 96 : 128, 255, 255]) }],
    materials: [{ ...source.materials[0]!, normalTexture: { texture: "normal", normalScale: 0.65,
      offset: [0.1, 0.2], rotation: Math.PI / 2 } }],
  };
}

function occlusionPacket(revision = 0, normal = false): RenderPacket {
  const source = normal ? normalPacket(revision) : packet(revision);
  return { ...source,
    geometries: [{ ...source.geometries[0]!, uv1: new Float32Array([0.1, 0.2, 0.7, 0.2, 0.1, 0.8]) }],
    textures: [...source.textures!, { id: "mr", revision, semantic: "metallicRoughness", width: 1, height: 1,
      data: new Uint8Array([255, 128, 64, 255]) }, { id: "occlusion", revision, semantic: "occlusion", width: 1, height: 1,
      data: new Uint8Array([revision ? 96 : 64, 255, 255, 255]) }],
    materials: [{ ...source.materials[0]!, doubleSided: true,
      metallicRoughnessTexture: { texture: "mr" },
      occlusionTexture: { texture: "occlusion", texCoord: 1, strength: 0.4, offset: [0.2, 0.3], scale: [2, 3] } }],
  };
}

function emissivePacket(revision = 0): RenderPacket {
  const source = occlusionPacket(revision, true);
  return { ...source,
    textures: [...source.textures!, { id: "emissive", revision, semantic: "emissive", width: 1, height: 1,
      data: new Uint8Array([revision ? 32 : 255, 128, 64, 255]) }],
    materials: [{ ...source.materials[0]!, emissiveFactor: [0.8, 0.6, 0.4], emissiveStrength: 4,
      emissiveTexture: { texture: "emissive", offset: [0.3, 0.4], scale: [0.5, 0.75] } }],
  };
}

function fixture() {
  const owned = new Set<{ destroy(): void }>(), buffers: GPUBuffer[] = [], textures: GPUTexture[] = [], groups: GPUBindGroup[] = [];
  const device = {
    limits: { maxBufferSize: 256 * 1024 * 1024, maxTextureDimension2D: 8192 },
    createBuffer: vi.fn(() => { const value = { destroy: vi.fn() } as unknown as GPUBuffer; buffers.push(value); return value; }),
    createTexture: vi.fn(() => { const value = { destroy: vi.fn(), createView: vi.fn(() => ({ owner: value })) } as unknown as GPUTexture; textures.push(value); return value; }),
    createSampler: vi.fn(() => ({}) as GPUSampler),
    createBindGroup: vi.fn((descriptor: GPUBindGroupDescriptor) => { const value = { descriptor } as unknown as GPUBindGroup; groups.push(value); return value; }),
    pushErrorScope: vi.fn(), popErrorScope: vi.fn(() => Promise.resolve<GPUError | null>(null)),
    queue: { writeBuffer: vi.fn(), writeTexture: vi.fn() },
  };
  const session = { state: "ready", device,
    own<T extends { destroy(): void }>(resource: T): T { owned.add(resource); return resource; },
    release(resource: { destroy(): void }) { if (owned.delete(resource)) resource.destroy(); } };
  const cache = new PacketBuffers(session as unknown as DeviceSession,
    { material: {} as GPUBindGroupLayout });
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn(), setVertexBuffer: vi.fn(), setIndexBuffer: vi.fn(), drawIndexed: vi.fn() };
  const mainPipelines = new Map<string, GPURenderPipeline>();
  for (const raster of ["ccw", "cw", "double"] as const) {
    const suffix = raster === "ccw" ? "" : raster === "cw" ? "Mirror" : "Double";
    mainPipelines.set(mainPipelineKey("plain", false, raster), `main${suffix}` as unknown as GPURenderPipeline);
    mainPipelines.set(mainPipelineKey("material", false, raster), `textured${suffix}` as unknown as GPURenderPipeline);
    mainPipelines.set(mainPipelineKey("normal", false, raster), `normal${suffix}` as unknown as GPURenderPipeline);
    mainPipelines.set(mainPipelineKey("material", true, raster), `blend${suffix}` as unknown as GPURenderPipeline);
    mainPipelines.set(mainPipelineKey("normal", true, raster), `normalBlend${suffix}` as unknown as GPURenderPipeline);
  }
  const shadowPipelines = new Map([[shadowPipelineKey("solid", "ccw"), "shadow" as unknown as GPURenderPipeline]]);
  const pipelines = { main: "main", shadow: "shadow", mainPipelines, shadowPipelines } as unknown as Pipelines;
  const draw = () => { pass.setBindGroup.mockClear(); pass.setPipeline.mockClear(); return cache.draw(pass as unknown as GPURenderPassEncoder, pipelines, "opaque"); };
  return { cache, device, owned, buffers, textures, groups, pass, draw };
}

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, UNIFORM: 64, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("packet and material texture publication", () => {
  it("samples through a stable textured batch then atomically replaces texture and bind group", async () => {
    const f = fixture(); await expect(f.cache.setValidated(packet())).resolves.toBe(true);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    const oldTexture = f.textures[0]!, oldGroup = f.pass.setBindGroup.mock.calls[0]![1];
    expect(f.pass.setPipeline).toHaveBeenCalledWith("textured");
    expect(f.device.createTexture).toHaveBeenCalledWith(expect.objectContaining({ format: "rgba8unorm-srgb" }));
    const packedVertices = f.device.queue.writeBuffer.mock.calls[0]![2] as Float32Array;
    expect([...packedVertices.slice(0, 10)]).toEqual([0, 0, 0, 0, 0, 1, 0, 0, 0, 0]);
    expect([...packedVertices.slice(10, 20)]).toEqual([1, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
    const textureParameters = f.device.queue.writeBuffer.mock.calls[2]![2] as Float32Array;
    expect([...textureParameters]).toEqual([1, 0, 0.25, 1, 0, 1, 0.5, 0, 1, 0, 0, 0, 0, 1, 0, 0,
      1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1]);
    await expect(f.cache.setValidated(packet(1))).resolves.toBe(true);
    expect(oldTexture.destroy).toHaveBeenCalledOnce();
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).not.toBe(oldGroup);
    expect(f.device.createBindGroup.mock.calls[1]![0].entries).toEqual(expect.arrayContaining([
      expect.objectContaining({ binding: 0 }), expect.objectContaining({ binding: 4 }),
    ]));
  });

  it("keeps the old texture and draw binding when combined GPU validation rejects a candidate", async () => {
    const f = fixture(); f.cache.set(packet()); f.draw();
    const oldTexture = f.textures[0]!, oldGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.device.popErrorScope.mockResolvedValueOnce({ message: "candidate rejected" } as GPUError);
    await expect(f.cache.setValidated(packet(1))).rejects.toThrow("GPU packet preparation failed: candidate rejected");
    expect(oldTexture.destroy).not.toHaveBeenCalled(); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setBindGroup.mock.calls[0]![1]).toBe(oldGroup);
  });

  it("rolls back a staged texture when geometry allocation fails, without damaging the active draw", () => {
    const f = fixture(); f.cache.set(packet()); f.draw();
    const oldTexture = f.textures[0]!, oldGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.device.createBuffer.mockImplementationOnce(() => { throw new Error("geometry allocation failed"); });
    expect(() => f.cache.set(packet(1))).toThrow("geometry allocation failed");
    expect(oldTexture.destroy).not.toHaveBeenCalled(); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).toBe(oldGroup);
  });

  it("keeps the old packet and texture when the new texture upload fails", () => {
    const f = fixture(); f.cache.set(packet()); f.draw();
    const oldTexture = f.textures[0]!, oldGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.device.queue.writeTexture.mockImplementationOnce(() => { throw new Error("texture upload failed"); });
    expect(() => f.cache.set(packet(1))).toThrow("texture upload failed");
    expect(oldTexture.destroy).not.toHaveBeenCalled(); expect(f.textures[1]!.destroy).toHaveBeenCalledOnce();
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).toBe(oldGroup);
  });

  it("reuses texture bindings during transform updates and releases every owned GPU resource", () => {
    const f = fixture(), p = packet(); f.cache.set(p); const groups = f.groups.length, textures = f.textures.length;
    f.cache.updateInstances({ materials: p.materials, instances: [{ ...p.instances[0]!, transform: [...identity.slice(0, 12), 2, 0, 0, 1] }] });
    expect(f.groups).toHaveLength(groups); expect(f.textures).toHaveLength(textures);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    f.cache.dispose(); f.cache.dispose(); expect(f.owned.size).toBe(0);
    for (const resource of [...f.buffers, ...f.textures]) expect(resource.destroy).toHaveBeenCalledOnce();
  });

  it("interns one immutable material binding across geometry batches and releases it after the last batch", () => {
    const f = fixture(), source = packet();
    f.cache.set({
      ...source,
      geometries: [...source.geometries, { ...source.geometries[0]!, id: "g2" }],
      instances: [...source.instances, { ...source.instances[0]!, id: "i2", geometry: "g2" }],
    });
    expect(f.device.createBindGroup).toHaveBeenCalledTimes(1);
    const materialBuffers = f.buffers.filter(buffer => f.device.queue.writeBuffer.mock.calls
      .some(call => call[0] === buffer && (call[2] as Float32Array).length === 40));
    expect(materialBuffers).toHaveLength(1);
    expect(f.draw()).toEqual({ drawCalls: 2, triangles: 2 });
    expect(f.pass.setBindGroup.mock.calls.map(call => call[1])).toEqual([f.groups[0], f.groups[0]]);

    f.cache.updateInstances({ materials: source.materials, instances: [source.instances[0]!] });
    expect(materialBuffers[0]!.destroy).not.toHaveBeenCalled();
    f.cache.dispose();
    expect(materialBuffers[0]!.destroy).toHaveBeenCalledOnce();
  });

  it("uploads linear normal data and tangents, then selects the dedicated TBN pipeline", () => {
    const f = fixture(), p = normalPacket(); f.cache.set(p);
    expect(f.device.createTexture.mock.calls.map(call => call[0].format)).toEqual(["rgba8unorm-srgb", "rgba8unorm"]);
    expect(f.device.queue.writeBuffer.mock.calls[1]![2]).toEqual(p.geometries[0]!.tangents);
    const normalParameters = f.device.queue.writeBuffer.mock.calls[3]![2] as Float32Array;
    expect(normalParameters[24]).toBeCloseTo(0); expect(normalParameters[25]).toBe(-1);
    expect(normalParameters[26]).toBeCloseTo(0.1); expect(normalParameters[27]).toBe(1);
    expect(normalParameters[28]).toBe(1); expect(normalParameters[29]).toBeCloseTo(0);
    expect(normalParameters[30]).toBeCloseTo(0.2); expect(normalParameters[31]).toBeCloseTo(0.65);
    const entries = f.device.createBindGroup.mock.calls[0]![0].entries;
    expect(entries.map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setPipeline).toHaveBeenCalledWith("normal");
    expect(f.pass.setVertexBuffer).toHaveBeenCalledWith(3, f.buffers[1]);
    const instances = f.device.queue.writeBuffer.mock.calls[4]![2] as Float32Array;
    expect(instances[30]).toBe(1);
  });

  it("uploads linear AO parameters and selects AO/TBN/double-sided pipelines without extra ordinary samples", () => {
    const plain = fixture(), ao = occlusionPacket(); plain.cache.set(ao);
    expect(plain.device.createTexture.mock.calls.map(call => call[0].format)).toEqual(["rgba8unorm-srgb", "rgba8unorm", "rgba8unorm"]);
    const parameters = plain.device.queue.writeBuffer.mock.calls[2]![2] as Float32Array;
    expect([...parameters.slice(16, 22)]).toEqual([2, 0, Math.fround(0.2), 2, 0, 3]);
    expect(parameters[22]).toBeCloseTo(0.3); expect(parameters[23]).toBeCloseTo(0.4);
    expect(plain.device.createBindGroup.mock.calls[0]![0].entries.map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(plain.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(plain.pass.setPipeline).toHaveBeenCalledWith("texturedDouble");

    const combined = fixture(), normalAo = occlusionPacket(0, true);
    combined.cache.set({ ...normalAo, instances: [...normalAo.instances,
      { ...normalAo.instances[0]!, id: "mirror", transform: [-1, ...identity.slice(1)] }] });
    expect(combined.draw()).toEqual({ drawCalls: 1, triangles: 2 });
    expect(combined.pass.setPipeline).toHaveBeenCalledWith("normalDouble");
    expect(combined.device.createBindGroup.mock.calls[0]![0].entries.map(entry => entry.binding)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("uploads emissive as sRGB and places its independent transform in the bounded material block", () => {
    const f = fixture(); f.cache.set(emissivePacket());
    expect(f.device.createTexture.mock.calls.map(call => call[0].format)).toEqual([
      "rgba8unorm-srgb", "rgba8unorm", "rgba8unorm", "rgba8unorm", "rgba8unorm-srgb",
    ]);
    const parameters = f.device.queue.writeBuffer.mock.calls[3]![2] as Float32Array;
    expect([...parameters.slice(32, 40)]).toEqual([0.5, 0, Math.fround(0.3), 1, 0, 0.75, Math.fround(0.4), 4]);
    expect(f.draw()).toEqual({ drawCalls: 1, triangles: 1 });
    expect(f.pass.setPipeline).toHaveBeenCalledWith("normalDouble");
  });

  it("rolls a combined base/MR/normal/AO/emissive candidate back when bind-group creation fails", () => {
    const f = fixture(), current = emissivePacket(0); f.cache.set(current); f.draw();
    const oldTextures = f.textures.slice(), oldGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("combined material bind failed"); });
    expect(() => f.cache.set(emissivePacket(1))).toThrow("combined material bind failed");
    oldTextures.forEach(texture => expect(texture.destroy).not.toHaveBeenCalled());
    f.textures.slice(oldTextures.length).forEach(texture => expect(texture.destroy).toHaveBeenCalledOnce());
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).toBe(oldGroup);
    expect(f.pass.setPipeline).toHaveBeenCalledWith("normalDouble");
  });

  it("rebuilds normal parameters on scale changes and rolls binding failures back atomically", () => {
    const f = fixture(), p = normalPacket(); f.cache.set(p); f.draw();
    const oldGroup = f.pass.setBindGroup.mock.calls[0]![1], oldTextures = f.textures.slice();
    f.cache.updateInstances({ materials: [{ ...p.materials[0]!, normalTexture: { ...p.materials[0]!.normalTexture!, normalScale: 0.2 } }],
      instances: p.instances });
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).not.toBe(oldGroup);
    const updatedParameters = f.device.queue.writeBuffer.mock.calls
      .map(call => call[2]).filter((value): value is Float32Array => value instanceof Float32Array && value.length === 40).at(-1)!;
    expect(updatedParameters[31]).toBeCloseTo(0.2);

    const activeGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("normal bind group failed"); });
    expect(() => f.cache.set(normalPacket(1))).toThrow("normal bind group failed");
    oldTextures.forEach(texture => expect(texture.destroy).not.toHaveBeenCalled());
    for (const texture of f.textures.slice(2)) expect(texture.destroy).toHaveBeenCalledOnce();
    f.draw(); expect(f.pass.setBindGroup.mock.calls[0]![1]).toBe(activeGroup);
  });

  it("rebuilds only material data when HDR emissive strength changes", () => {
    const f = fixture(), p = emissivePacket(); f.cache.set(p); f.draw();
    const previousGroup = f.pass.setBindGroup.mock.calls[0]![1];
    f.cache.updateInstances({ materials: [{ ...p.materials[0]!, emissiveStrength: 8 }], instances: p.instances });
    f.draw();
    expect(f.pass.setBindGroup.mock.calls.at(-1)![1]).not.toBe(previousGroup);
    const parameters = f.device.queue.writeBuffer.mock.calls
      .map((call) => call[2]).filter((value): value is Float32Array => value instanceof Float32Array && value.length === 40).at(-1)!;
    expect(parameters[39]).toBe(8);
    expect(f.pass.setPipeline.mock.calls.at(-1)![0]).toBe("normalDouble");
  });
});
