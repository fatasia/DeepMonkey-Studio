import { afterEach, expect, it, vi } from "vitest";
import { sceneShader } from "./pbrShader.js";
import { composeLayeredMaterialSceneShader } from "./pbrLayeredMaterialShader.js";
import { MaterialBindingPool } from "./materialBindings.js";
import { prepareMaterialTextures } from "../renderPacketMaterials.js";
import { prepareRenderPacket } from "../renderPacket.js";
import type { PbrMaterial, RenderPacket } from "../renderPacketTypes.js";
import type { DeviceSession } from "./deviceSession.js";
import type { TextureBinding } from "./textureResources.js";
const base: PbrMaterial = { id: "m", baseColor: [0.1, 0.2, 0.3], metallic: 0, roughness: 0.6 };
function layered(): PbrMaterial { return { ...base, layered: { layers: [
  { coverage: 0, surface: { baseColorTexture: { texture: "ignored" } } },
  { coverage: 0.75, surface: { baseColor: [1, 0.1, 0.05], baseColorTexture: { texture: "color", texCoord: 1 }, metallicRoughnessTexture: { texture: "mr" } } },
] } }; }
function fixture(enabled = true) {
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  vi.stubGlobal("GPUTextureUsage", { TEXTURE_BINDING: 4, COPY_DST: 2 });
  const owned = new Set<object>();
  const device = { createBuffer: vi.fn((descriptor) => ({ ...descriptor, destroy: vi.fn() })),
    createBindGroup: vi.fn(value => value), queue: { writeBuffer: vi.fn() } };
  const session = { device, own<T extends object>(resource: T) { owned.add(resource); return resource; },
    release(resource: object) { owned.delete(resource); }, assertResourceAdmission() {} } as unknown as DeviceSession;
  const color = { view: {}, sampler: {} } as TextureBinding, mr = { view: {}, sampler: {} } as TextureBinding;
  const lookup = (id: string) => id === "color" ? color : mr;
  return { owned, device, pool: new MaterialBindingPool(session,
    { material: {} as GPUBindGroupLayout, ...(enabled ? { layeredMaterials: true } : {}) }), color, mr, lookup };
}
afterEach(() => vi.unstubAllGlobals());
it("uses the existing production evaluation and canonical blend, with guarded opt-in anchors", () => {
  const shader = composeLayeredMaterialSceneShader(sceneShader);
  expect(shader).toContain("deepLayerBaseShade"); expect(shader).toContain("deepLayerBlend(result, layer, layer, coverage");
  expect(shader).toContain("rows: array<DeepLayerSurfaceRow, 2>");
  expect(sceneShader).not.toContain("deepLayerSurface:");
  expect(() => composeLayeredMaterialSceneShader(shader)).toThrow("anchor changed");
});
it("zero coverage drops layer textures, UV requirements and resource preparation", () => {
  const prepared = prepareMaterialTextures(new Map([["m", { ...base, layered: { layers: [{ coverage: 0,
    surface: { baseColorTexture: { texture: "not-loaded", texCoord: 1 } } }] } }]]), new Map());
  expect(prepared.get("m")).toBeUndefined();
});
it("retains only active layer textures and validates their real UV stream", () => {
  const packet: RenderPacket = { geometries: [{ id: "g", revision: 0,
    vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
    uv0: new Float32Array([0, 0, 1, 0, 0, 1]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [layered()], instances: [{ id: "i", geometry: "g", material: "m", transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1] }],
    textures: ["color", "mr"].map(id => ({ id, revision: 0, semantic: id === "color" ? "baseColor" : "metallicRoughness",
      width: 1, height: 1, data: new Uint8Array([255, 128, 0, 255]) })) };
  expect(() => prepareRenderPacket(packet)).toThrow("requires UV1");
  const result = prepareRenderPacket({ ...packet, geometries: [{ ...packet.geometries[0]!, uv1: packet.geometries[0]!.uv0! }] });
  expect(result.textures.map(texture => texture.id).sort()).toEqual(["color", "mr"]);
});
it("interns the 304B block, borrows existing texture views and releases no borrowed resources", () => {
  const f = fixture(); const textures = prepareMaterialTextures(new Map([["m", layered()]]),
    new Map([["color", "baseColor"], ["mr", "metallicRoughness"]])).get("m")!;
  const first = f.pool.acquire(textures, f.lookup)!, second = f.pool.acquire(textures, f.lookup)!;
  expect(first).toBe(second); expect(first.layered!.textures.slice(0, 2)).toEqual([f.color, f.mr]);
  expect(f.device.createBuffer.mock.calls.map(([d]) => d.size)).toEqual([192, 304]);
  expect(f.device.createBindGroup.mock.calls[0]![0].entries).toHaveLength(20);
  f.pool.release(first); expect(f.owned.size).toBe(2);
  f.pool.release(second); expect(f.owned.size).toBe(0);
});
it("ordinary layouts upload only the existing 192B block and reject requested layers explicitly", () => {
  const f = fixture(false), textures = { emissiveStrength: 1, baseColor: { texture: "color", texCoord: 0 as const, uvTransform: [1, 0, 0, 0, 1, 0] as const } };
  const binding = f.pool.acquire(textures, f.lookup)!; expect(binding.layered).toBeUndefined();
  expect(f.device.createBuffer.mock.calls.map(([d]) => d.size)).toEqual([192]); f.pool.release(binding);
  const layer = prepareMaterialTextures(new Map([["m", layered()]]), new Map([["color", "baseColor"], ["mr", "metallicRoughness"]])).get("m")!;
  expect(() => f.pool.acquire(layer, f.lookup)).toThrow("layered-materials/not-enabled"); expect(f.owned.size).toBe(0);
});
it("failed bind group construction rolls back both parameter blocks and leaves active materials resident", () => {
  const f = fixture(), textures = prepareMaterialTextures(new Map([["m", layered()]]),
    new Map([["color", "baseColor"], ["mr", "metallicRoughness"]])).get("m")!;
  const active = f.pool.acquire(textures, f.lookup)!;
  f.device.createBindGroup.mockImplementationOnce(() => { throw new Error("driver rejection"); });
  expect(() => f.pool.acquire({ ...textures, emissiveStrength: 2 }, f.lookup)).toThrow("driver rejection");
  expect(f.owned.size).toBe(2); expect(f.pool.stats.bindGroups).toBe(1); f.pool.release(active); expect(f.owned.size).toBe(0);
});
