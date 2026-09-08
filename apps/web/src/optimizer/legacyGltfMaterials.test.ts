import { Document, WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRMaterialsClearcoat, KHRMaterialsPBRSpecularGlossiness, KHRTextureTransform, type Transform } from "@gltf-transform/extensions";
import { describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { hasLegacySpecGloss, LEGACY_SPEC_GLOSS } from "../viewer/gltfLegacyMaterialDetection";
import { legacyGltfForRendering, migrateLegacyMaterials } from "./legacyGltfMaterials";

const io = () => new WebIO().registerExtensions(ALL_EXTENSIONS);
function source() {
  const document = new Document();
  document.getRoot().getAsset().copyright = "Fixture author · CC-BY-4.0";
  const extension = document.createExtension(KHRMaterialsPBRSpecularGlossiness).setRequired(true);
  const specGloss = extension.createPBRSpecularGlossiness().setDiffuseFactor([.2, .4, .6, .35]).setSpecularFactor([.3, .5, .7]).setGlossinessFactor(.25);
  const material = document.createMaterial("Legacy surface").setAlphaMode("BLEND").setDoubleSided(true).setExtras({ original: "retained" }).setExtension(LEGACY_SPEC_GLOSS, specGloss);
  return { document, material, specGloss };
}

describe("legacy spec/gloss material compatibility", () => {
  it("migrates factors without losing transparency, attribution, extras or modern materials", async () => {
    const { document, material } = source();
    const modern = document.createMaterial("Modern surface").setBaseColorFactor([.9, .1, .2, 1]).setMetallicFactor(.8);
    modern.setExtension("KHR_materials_clearcoat", document.createExtension(KHRMaterialsClearcoat).createClearcoat().setClearcoatFactor(.6));
    await migrateLegacyMaterials(document);
    expect(material.getBaseColorFactor()).toEqual([.2, .4, .6, .35]);
    expect(material.getRoughnessFactor()).toBe(.75);
    expect(material.getMetallicFactor()).toBe(0);
    expect(material.getAlphaMode()).toBe("BLEND"); expect(material.getDoubleSided()).toBe(true);
    expect(material.getExtras()).toEqual({ original: "retained" });
    expect(document.getRoot().getAsset().copyright).toContain("CC-BY-4.0");
    expect(material.getExtension(LEGACY_SPEC_GLOSS)).toBeNull();
    expect(document.getRoot().listExtensionsUsed().map(extension => extension.extensionName)).not.toContain(LEGACY_SPEC_GLOSS);
    expect(modern.getBaseColorFactor()).toEqual([.9, .1, .2, 1]); expect(modern.getMetallicFactor()).toBe(.8);
    expect(modern.getExtension("KHR_materials_clearcoat")).not.toBeNull();
  });

  it("uses original diffuse image/UV transform and remaps gloss alpha to roughness, not RGB", async () => {
    const { document, material, specGloss } = source();
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: { r: 100, g: 150, b: 200, alpha: .5 } } }).png().toBuffer();
    const texture = document.createTexture("Surface maps").setImage(png).setMimeType("image/png");
    specGloss.setDiffuseTexture(texture).setSpecularGlossinessTexture(texture);
    specGloss.getDiffuseTextureInfo()!.setTexCoord(1).setExtension("KHR_texture_transform", document.createExtension(KHRTextureTransform).createTransform().setOffset([.1, .2]).setScale([2, 3]));
    await migrateLegacyMaterials(document);
    expect(material.getBaseColorTexture()).toBe(texture);
    expect(material.getBaseColorTextureInfo()!.getTexCoord()).toBe(1);
    expect(material.getBaseColorTextureInfo()!.getExtension<Transform>("KHR_texture_transform")?.getOffset()).toEqual([.1, .2]);
    const pixels = await sharp(material.getMetallicRoughnessTexture()!.getImage()!).ensureAlpha().raw().toBuffer();
    expect([...pixels]).toEqual([0, 223, 0, 255]); // 255 - round(128 × .25)
    expect(texture.getImage()).toEqual(png);
  });

  it("keeps original GLB bytes unchanged and produces only modern renderable materials", async () => {
    const { document } = source();
    const original = await io().writeBinary(document), snapshot = original.slice();
    expect(hasLegacySpecGloss(original.buffer as ArrayBuffer)).toBe(true);
    const derived = await legacyGltfForRendering(original.buffer as ArrayBuffer, async () => { throw new Error("No external resources"); }, io());
    expect(original).toEqual(snapshot);
    expect(hasLegacySpecGloss(derived)).toBe(false);
    const result = await io().readBinary(new Uint8Array(derived));
    expect(result.getRoot().listMaterials()[0]!.getBaseColorFactor()).toEqual([.2, .4, .6, .35]);
  });

  it("handles JSON delivered as ArrayBuffer and loads each external resource once", async () => {
    const { document, specGloss } = source();
    const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: "red" } }).png().toBuffer();
    specGloss.setDiffuseTexture(document.createTexture("Diffuse").setImage(png).setMimeType("image/png"));
    const written = await io().writeJSON(document);
    const input = new TextEncoder().encode(JSON.stringify(written.json)).buffer;
    expect(hasLegacySpecGloss(input)).toBe(true);
    const load = vi.fn(async (uri: string) => Uint8Array.from(written.resources[uri]!).buffer);
    const derived = await legacyGltfForRendering(input, load, io());
    expect(load).toHaveBeenCalledTimes(1);
    expect((await io().readBinary(new Uint8Array(derived))).getRoot().listMaterials()[0]!.getBaseColorTexture()).not.toBeNull();
  });

  it("does not migrate modern materials or metadata that merely mentions the deprecated name", async () => {
    const document = new Document(), material = document.createMaterial("Modern").setRoughnessFactor(.25);
    expect(await migrateLegacyMaterials(document)).toBe(document);
    expect(material.getRoughnessFactor()).toBe(.25); expect(document.getRoot().listExtensionsUsed()).toEqual([]);
    expect(hasLegacySpecGloss(JSON.stringify({ asset: { version: "2.0", extras: { note: LEGACY_SPEC_GLOSS } }, materials: [{ pbrMetallicRoughness: {} }] }))).toBe(false);
    expect(hasLegacySpecGloss(new ArrayBuffer(3))).toBe(false);
  });

  it("rejects conversion that would silently discard an unrelated unsupported extension", async () => {
    const { document } = source(), written = await io().writeJSON(document);
    written.json.extensionsUsed!.push("VENDOR_unhandled");
    await expect(legacyGltfForRendering(JSON.stringify(written.json), async () => new ArrayBuffer(0), io())).rejects.toThrow("VENDOR_unhandled");
  });
});
