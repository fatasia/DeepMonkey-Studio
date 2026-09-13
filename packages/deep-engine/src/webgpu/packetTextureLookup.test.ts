import { describe, expect, it } from "vitest";
import type { PreparedBatch } from "../renderPacket.js";
import type { PreparedTexture, TextureSemantic } from "../textures/decodedTexture.js";
import type { GpuTextureResidencyHandle } from "./gpuTextureResidencyUploader.js";
import {
  createResidentPacketTextureLookup,
  type PacketTextureLookup,
} from "./packetTextureLookup.js";
import type {
  ResidentPacketBatch,
  ResidentPacketProjection,
} from "./residentPacketProjection.js";
import type { TextureBinding } from "./textureResources.js";

function source(id = "base", semantic: TextureSemantic = "baseColor"): PreparedTexture {
  const levels = [
    { width: 4, height: 4, bytesPerRow: 16, byteLength: 64, data: new Uint8Array(64) },
    { width: 2, height: 2, bytesPerRow: 8, byteLength: 16, data: new Uint8Array(16) },
    { width: 1, height: 1, bytesPerRow: 4, byteLength: 4, data: new Uint8Array(4) },
  ];
  return { id, revision: 3, semantic, format: semantic === "baseColor"
    ? "rgba8unorm-srgb" : "rgba8unorm", levels, byteLength: 84,
  sampler: { addressModeU: "repeat", addressModeV: "repeat", magFilter: "linear",
    minFilter: "linear", mipmapFilter: "linear", maxAnisotropy: 1 }, samplerKey: "linear" };
}

function handle(texture: PreparedTexture, level = 0): GpuTextureResidencyHandle {
  const levels = texture.levels.slice(level), base = levels[0]!;
  return { kind: "texture", id: texture.id, revision: texture.revision, level,
    texture: { id: texture.id } as unknown as GPUTexture,
    view: { id: texture.id } as unknown as GPUTextureView,
    sampler: { id: texture.samplerKey } as unknown as GPUSampler,
    byteLength: levels.reduce((sum, mip) => sum + mip.byteLength, 0),
    semantic: texture.semantic, format: texture.format, width: base.width,
    height: base.height, mipLevelCount: levels.length };
}

function batch(key: string, texture: GpuTextureResidencyHandle): ResidentPacketBatch {
  const slot = Object.freeze({ texture: texture.id, uvSet: 0 as const,
    uvTransform: Object.freeze([1, 0, 0, 0, 1, 0] as const) });
  const prepared = { key, geometry: "mesh", instanceIds: [key], mirrored: false,
    doubleSided: false, alphaMode: "opaque", data: new Float32Array(0), count: 1,
    textures: { baseColor: slot } } satisfies PreparedBatch;
  return Object.freeze({ source: prepared, geometries: Object.freeze([]),
    textures: Object.freeze([{ role: "baseColor", slot, texture }]) });
}

function projection(
  batches: readonly ResidentPacketBatch[],
  sources: ReadonlyMap<string, PreparedTexture>,
  handles: ReadonlyMap<string, GpuTextureResidencyHandle>,
  released = false,
): ResidentPacketProjection {
  return { batches, released, geometry: () => undefined, geometrySource: () => undefined,
    texture: id => handles.get(id), textureSource: id => sources.get(id), release() {} };
}

function lookupFor(texture = source(), level = 0): {
  readonly lookup: PacketTextureLookup;
  readonly handle: GpuTextureResidencyHandle;
  readonly projection: ResidentPacketProjection;
} {
  const resident = handle(texture, level);
  const value = projection([batch("batch", resident)],
    new Map([[texture.id, texture]]), new Map([[texture.id, resident]]));
  return { lookup: createResidentPacketTextureLookup(value), handle: resident, projection: value };
}

describe("createResidentPacketTextureLookup", () => {
  it("creates an empty structurally compatible lookup", () => {
    const lookup: PacketTextureLookup = createResidentPacketTextureLookup(
      projection([], new Map(), new Map()),
    );
    expect(lookup.semanticMap().size).toBe(0);
    expect(lookup.get("missing")).toBeUndefined();
    expect(Object.isFrozen(lookup)).toBe(true);
  });

  it("reuses one borrowed TextureBinding across batches", () => {
    const texture = source("shared"), resident = handle(texture, 1);
    const value = projection([batch("a", resident), batch("b", resident)],
      new Map([[texture.id, texture]]), new Map([[texture.id, resident]]));
    const lookup = createResidentPacketTextureLookup(value);
    const binding: TextureBinding | undefined = lookup.get("shared");

    expect(binding).toBe(resident);
    expect(binding).toMatchObject({ width: 2, height: 2, mipLevelCount: 2, byteLength: 20 });
    expect(lookup.semanticMap()).toEqual(new Map([["shared", "baseColor"]]));
  });

  it("rejects missing sources and inconsistent duplicate IDs", () => {
    const texture = source("shared"), resident = handle(texture);
    expect(() => createResidentPacketTextureLookup(projection([batch("a", resident)],
      new Map(), new Map([[texture.id, resident]]))))
      .toThrow("texture source is unavailable: shared");

    const conflicting = { ...resident, view: { other: true } as unknown as GPUTextureView };
    expect(() => createResidentPacketTextureLookup(projection(
      [batch("a", resident), batch("b", conflicting)], new Map([[texture.id, texture]]),
      new Map([[texture.id, resident]]),
    ))).toThrow("texture binding is inconsistent: shared");
  });

  it.each([
    ["revision", (value: GpuTextureResidencyHandle) => ({ ...value, revision: 2 })],
    ["semantic", (value: GpuTextureResidencyHandle) => ({ ...value, semantic: "normal" })],
    ["format", (value: GpuTextureResidencyHandle) => ({ ...value, format: "rgba8unorm" })],
    ["level", (value: GpuTextureResidencyHandle) => ({ ...value, level: 3 })],
    ["width", (value: GpuTextureResidencyHandle) => ({ ...value, width: 3 })],
    ["height", (value: GpuTextureResidencyHandle) => ({ ...value, height: 3 })],
    ["mip count", (value: GpuTextureResidencyHandle) => ({ ...value, mipLevelCount: 2 })],
    ["byte length", (value: GpuTextureResidencyHandle) => ({ ...value, byteLength: 83 })],
    ["GPU binding", (value: GpuTextureResidencyHandle) => ({ ...value, sampler: undefined })],
  ])("fails closed for a mismatched %s", (_label, mutate) => {
    const texture = source(), invalid = mutate(handle(texture)) as GpuTextureResidencyHandle;
    const value = projection([batch("batch", invalid)], new Map([[texture.id, texture]]),
      new Map([[texture.id, invalid]]));
    expect(() => createResidentPacketTextureLookup(value))
      .toThrow("texture differs from its prepared source: base");
  });

  it("rejects invalid mip suffix metadata", () => {
    const invalid = source();
    const broken = { ...invalid, levels: invalid.levels.map((mip, index) => index === 1
      ? { ...mip, width: 3 } : mip) };
    const resident = handle(broken);
    expect(() => createResidentPacketTextureLookup(projection([batch("batch", resident)],
      new Map([[broken.id, broken]]), new Map([[broken.id, resident]]))))
      .toThrow("texture mip suffix is invalid: base");
  });

  it("rejects released projections", () => {
    expect(() => createResidentPacketTextureLookup(
      projection([], new Map(), new Map(), true),
    )).toThrow("projection is already released");
  });

  it("returns isolated semantic snapshots", () => {
    const { lookup, handle: resident } = lookupFor();
    const snapshot = lookup.semanticMap() as Map<string, TextureSemantic>;
    snapshot.set("base", "normal"); snapshot.set("injected", "emissive");

    expect(lookup.semanticMap()).toEqual(new Map([["base", "baseColor"]]));
    expect(lookup.get("base")).toBe(resident);
    expect(lookup.get("injected")).toBeUndefined();
  });
});
