import { createHash } from "node:crypto";
import sharp from "sharp";
import { describe, expect, it, vi } from "vitest";
import type { SceneSnapshot } from "@bim-studio/contracts";
import { parseDeepRuntimePackage } from "@bim-studio/deep-engine/runtime-package";
import { compileSceneRuntimePackage } from "./compileSceneRuntimePackage";
import { authorTextureTestGlb } from "./sceneAuthorTextureTestFixture";

const glb = authorTextureTestGlb();
const options = { packageId: "texture.delivery", packageVersion: "1.0.0", loadModel: async () => glb,
  imageDecoder: { async decode(image: { data: Uint8Array }) {
    const decoded = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
  } } };
function scene(): SceneSnapshot {
  return { schemaVersion: 1, id: "textures", projectId: "project", name: "Textures", primitives: [], measurements: [],
    models: [{ modelId: "instance", assetModelId: "box", name: "Box", visible: true, opacity: 1,
      transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
      material: { baseColorMapUrl: "/base.png", normalMapUrl: "/normal.png", ambientOcclusionMapUrl: "/ao.png",
        roughnessMapUrl: "/rough.png", metalnessMapUrl: "/rough.png", normalScale: 2, textureRepeat: 2 } }],
    camera: { mode: "orbit", position: { x: 0, y: 2, z: 5 }, target: { x: 0, y: 0, z: 0 } }, createdAt: "", updatedAt: "" };
}
async function png(red = 200) {
  return new Uint8Array(await sharp({ create: { width: 8, height: 8, channels: 4,
    background: { r: red, g: 100, b: 220, alpha: 1 } } }).png().toBuffer());
}

describe("runtime author texture delivery", () => {
  it("ships all PBR slots with real PNG pixels, shared source evidence and no external texture URL", async () => {
    const bytes = await png(), loadTexture = vi.fn(async () => bytes);
    const compiled = await compileSceneRuntimePackage(scene(), { ...options, loadTexture });
    expect(loadTexture).toHaveBeenCalledTimes(4);
    expect(compiled.evidence.sourceTextures).toEqual([{ bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex") }]);
    const decoded = parseDeepRuntimePackage(compiled.packageJson);
    expect(decoded.valid).toBe(true);
    if (!decoded.valid) throw new Error("Texture package is invalid");
    const packet = decoded.value.payloads[decoded.value.entrypoints.renderPacket] as unknown as {
      materials: Array<Record<string, { texture: string; normalScale?: number; scale?: number[] }>>;
      textures: Array<{ id: string; semantic: string; width: number; height: number; data: number[] }>;
    };
    const material = packet.materials[0]!;
    for (const slot of ["baseColorTexture", "normalTexture", "occlusionTexture", "metallicRoughnessTexture"]) {
      expect(packet.textures.some(texture => texture.id === material[slot]!.texture)).toBe(true);
    }
    expect(material.normalTexture).toMatchObject({ normalScale: 2, scale: [2, 2] });
    const color = packet.textures.find(texture => texture.id === material.baseColorTexture!.texture)!;
    expect(color).toMatchObject({ semantic: "baseColor", width: 8, height: 8 });
    expect(Array.from(color.data).slice(0, 4)).toEqual([200, 100, 220, 255]);
    expect(compiled.packageJson).not.toContain("/base.png");
  });

  it("binds changing texture bytes to both artifact and compile graph identity", async () => {
    const source = scene();
    const first = await compileSceneRuntimePackage(source, { ...options, loadTexture: async () => png(200) });
    const second = await compileSceneRuntimePackage(source, { ...options, loadTexture: async () => png(50) });
    expect(second.evidence.sourceSemanticHash).toBe(first.evidence.sourceSemanticHash);
    expect(second.evidence.sourceTextures).not.toEqual(first.evidence.sourceTextures);
    expect(second.evidence.compileGraphHash).not.toBe(first.evidence.compileGraphHash);
    expect(second.evidence.targetArtifactHash).not.toBe(first.evidence.targetArtifactHash);
  });

  it("counts encoded images against the same scene budget as model sources", async () => {
    const bytes = await png();
    await expect(compileSceneRuntimePackage(scene(), { ...options, loadTexture: async () => bytes,
      maxSourceBytes: glb.length + bytes.length - 1 })).rejects.toThrow("贴图资源超出场景预算");
  });

  it("honors the decoded author texture budget", async () => {
    await expect(compileSceneRuntimePackage(scene(), { ...options, loadTexture: async () => png(),
      textureBudgetBytes: 8 })).rejects.toThrow("纹理解码预算");
  });

  it("stops after cancellation while a texture read is pending", async () => {
    const controller = new AbortController();
    await expect(compileSceneRuntimePackage(scene(), { ...options, signal: controller.signal,
      loadTexture: async () => { controller.abort(); return png(); } })).rejects.toThrow();
  });

  it("keeps missing image sources and unsupported images fail-closed", async () => {
    await expect(compileSceneRuntimePackage(scene(), options)).rejects.toThrow("baseColorMapUrl");
    await expect(compileSceneRuntimePackage(scene(), { ...options,
      loadTexture: async () => new Uint8Array([1, 2, 3]) })).rejects.toThrow("仅支持 PNG/JPEG");
    await expect(compileSceneRuntimePackage(scene(), { ...options,
      loadTexture: async () => { throw new Error("captured image missing"); } })).rejects.toThrow("captured image missing");
  });
});
