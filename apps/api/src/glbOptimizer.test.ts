import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { Accessor, Document, NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsPBRSpecularGlossiness, KHRTextureTransform, type Transform } from "@gltf-transform/extensions";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { generateGlbLods, optimizeNativeGlb } from "./glbOptimizer.js";
import { auditGlbGeometry } from "./converterOutputAudit.js";
import { hasLegacyGlbMaterials } from "./legacyGlbMaterials.js";

const LEGACY = "KHR_materials_pbrSpecularGlossiness", directories: string[] = [];
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
afterEach(async () => { vi.unstubAllEnvs(); await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });

function fixture(legacy = true) {
  const document = new Document(), buffer = document.createBuffer();
  document.getRoot().getAsset().copyright = "Fixture · CC-BY-4.0";
  const material = document.createMaterial("surface").setAlphaMode("MASK").setAlphaCutoff(.3).setDoubleSided(true).setExtras({ retained: true });
  const spec = legacy ? document.createExtension(KHRMaterialsPBRSpecularGlossiness).setRequired(true).createPBRSpecularGlossiness().setDiffuseFactor([.2, .4, .6, .35]).setSpecularFactor([.3, .5, .7]).setGlossinessFactor(.25) : undefined;
  if (spec) material.setExtension(LEGACY, spec);
  const position = document.createAccessor().setType(Accessor.Type.VEC3).setBuffer(buffer).setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]));
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(document.createPrimitive().setAttribute("POSITION", position).setMaterial(material))));
  return { document, material, spec };
}
async function save(document: Document) {
  const directory = await mkdtemp(path.join(tmpdir(), "bim-glb-material-")); directories.push(directory);
  const file = path.join(directory, "geometry.glb"); await writeFile(file, await io.writeBinary(document)); return file;
}

describe("API GLB legacy material compatibility", () => {
  it("migrates factors and preserves alpha, double-sidedness, extras and attribution below the compression threshold", async () => {
    const { document } = fixture(), file = await save(document);
    expect(await hasLegacyGlbMaterials(file)).toBe(true);
    expect(await auditGlbGeometry(file)).toMatchObject({ triangleCount: 1 });
    await optimizeNativeGlb(file);
    expect(await hasLegacyGlbMaterials(file)).toBe(false);
    const result = await io.read(file), material = result.getRoot().listMaterials()[0]!;
    expect(material.getBaseColorFactor()).toEqual([.2, .4, .6, .35]); expect(material.getRoughnessFactor()).toBe(.75);
    expect(material.getAlphaMode()).toBe("MASK"); expect(material.getAlphaCutoff()).toBe(.3); expect(material.getDoubleSided()).toBe(true);
    expect(material.getExtras()).toEqual({ retained: true }); expect(result.getRoot().getAsset().copyright).toContain("CC-BY-4.0");
    expect(material.getExtension(LEGACY)).toBeNull();
  });
  it("keeps diffuse texture bytes/UV transform and derives roughness from gloss alpha", async () => {
    const { document, spec } = fixture();
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 100, g: 150, b: 200, alpha: .5 } } }).png().toBuffer();
    const texture = document.createTexture().setImage(png).setMimeType("image/png"); spec!.setDiffuseTexture(texture).setSpecularGlossinessTexture(texture);
    spec!.getDiffuseTextureInfo()!.setTexCoord(1).setExtension("KHR_texture_transform", document.createExtension(KHRTextureTransform).createTransform().setOffset([.1, .2]));
    const file = await save(document); await optimizeNativeGlb(file);
    const material = (await io.read(file)).getRoot().listMaterials()[0]!;
    expect(Buffer.from(material.getBaseColorTexture()!.getImage()!)).toEqual(png);
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(1);
    expect(material.getBaseColorTextureInfo()!.getExtension<Transform>("KHR_texture_transform")!.getOffset()).toEqual([.1, .2]);
    expect([...await sharp(material.getMetallicRoughnessTexture()!.getImage()!).ensureAlpha().raw().toBuffer()]).toEqual([0, 223, 0, 255]);
  });
  it("keeps modern small GLB bytes identical including modern extensions", async () => {
    const { document, material } = fixture(false);
    material.setRoughnessFactor(.2).setExtension("KHR_materials_clearcoat", document.createExtension(KHRMaterialsClearcoat).setRequired(true).createClearcoat().setClearcoatFactor(.6));
    const file = await save(document), before = await readFile(file);
    expect(await optimizeNativeGlb(file)).toMatchObject({ compressed: false, optimizedBytes: before.length });
    expect(await readFile(file)).toEqual(before); expect(await auditGlbGeometry(file)).toMatchObject({ triangleCount: 1 });
  });
  it("still migrates legacy materials when Draco is disabled", async () => {
    vi.stubEnv("RVT_GLB_DRACO", "false"); const file = await save(fixture().document);
    expect((await optimizeNativeGlb(file)).compressed).toBe(false); expect(await hasLegacyGlbMaterials(file)).toBe(false);
  });
  it("migrates both LOD derivatives while leaving the original above-threshold GLB untouched", async () => {
    const { document } = fixture();
    document.createAccessor("size-fixture").setBuffer(document.getRoot().listBuffers()[0]!).setType(Accessor.Type.SCALAR).setArray(new Uint8Array(8_100_000));
    const file = await save(document), before = await readFile(file);
    const lods = await generateGlbLods(file); expect(lods).toHaveLength(2);
    for (const lod of lods) {
      const output = path.join(path.dirname(file), lod.fileName);
      expect(await hasLegacyGlbMaterials(output)).toBe(false); expect((await auditGlbGeometry(output)).triangleCount).toBeGreaterThan(0);
    }
    expect(createHash("sha256").update(await readFile(file)).digest("hex")).toBe(createHash("sha256").update(before).digest("hex"));
  });
  it("rejects unrelated unknown optional extensions without changing the input", async () => {
    const file = await save(fixture().document), original = await readFile(file), oldLength = original.readUInt32LE(12);
    const json = JSON.parse(original.subarray(20, 20 + oldLength).toString()); json.extensionsUsed.push("VENDOR_unhandled");
    const content = Buffer.from(JSON.stringify(json)), padded = Buffer.alloc(Math.ceil(content.length / 4) * 4, 32); content.copy(padded);
    const before = Buffer.concat([original.subarray(0, 20), padded, original.subarray(20 + oldLength)]); before.writeUInt32LE(before.length, 8); before.writeUInt32LE(padded.length, 12);
    await writeFile(file, before); await expect(optimizeNativeGlb(file)).rejects.toThrow("VENDOR_unhandled"); expect(await readFile(file)).toEqual(before);
  });
});
