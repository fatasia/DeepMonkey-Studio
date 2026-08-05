import { Document, WebIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { bakeWebLightmap } from "./lightmapBaker";

const ONE_PIXEL_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));

describe("bakeWebLightmap", () => {
  it("exports TEXCOORD_1 with standard occlusion and colored emissive textures in GLB", async () => {
    const document = new Document();
    const buffer = document.createBuffer();
    const position = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      -1, 0, -1,
      1, 0, -1,
      0, 0, 1
    ]));
    const normal = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
      0, 1, 0,
      0, 1, 0,
      0, 1, 0
    ]));
    const material = document.createMaterial("Lightmapped material").setBaseColorFactor([0.2, 0.6, 0.1, 1]);
    const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(material);
    const mesh = document.createMesh().addPrimitive(primitive);
    document.createScene().addChild(document.createNode().setMesh(mesh));

    const encodedImages: Uint8ClampedArray[] = [];
    const result = await bakeWebLightmap(document, {
      resolution: 256,
      strength: 0.5,
      ambient: 1,
      ambientColor: "#ff0000",
      lights: [],
      ambientOcclusion: false,
      aoSamples: 4,
      shadows: false,
      shadowSamples: 1,
      indirectSamples: 0,
      denoise: false
    }, undefined, async (pixels) => {
      encodedImages.push(pixels.slice());
      return ONE_PIXEL_PNG;
    });
    const binary = await new WebIO().writeBinary(document);
    const exported = await new WebIO().readBinary(binary);
    const exportedPrimitive = exported.getRoot().listMeshes()[0]!.listPrimitives()[0]!;
    const exportedMaterial = exportedPrimitive.getMaterial()!;

    expect(result.primitives).toBe(1);
    expect(result.generatedUvs).toBe(1);
    expect(result.coveredTexels).toBeGreaterThan(0);
    expect(exportedPrimitive.getAttribute("TEXCOORD_1")?.getCount()).toBe(3);
    expect(exportedMaterial.getOcclusionTexture()?.getMimeType()).toBe("image/png");
    expect(exportedMaterial.getOcclusionTextureInfo()?.getTexCoord()).toBe(1);
    expect(exportedMaterial.getEmissiveTexture()?.getMimeType()).toBe("image/png");
    expect(exportedMaterial.getEmissiveTextureInfo()?.getTexCoord()).toBe(1);
    expect(exportedMaterial.getBaseColorFactor()).toEqual([0.2, 0.6, 0.1, 1]);
    expect(encodedImages).toHaveLength(2);
    const coloredPixel = findColoredPixel(encodedImages[1]!);
    expect(coloredPixel[0]).toBeGreaterThan(coloredPixel[1]);
    expect(coloredPixel[0]).toBeGreaterThan(coloredPixel[2]);
    expect(exportedMaterial.getExtras().bimStudioLightmap).toMatchObject({ mode: "occlusion+chroma-emissive", colored: true, preservesBaseColor: true, texCoord: 1, resolution: 256 });
  });

  it("keeps neutral white lighting out of the additive emissive map", async () => {
    const document = createSingleTriangleDocument();
    const encodedImages: Uint8ClampedArray[] = [];
    await bakeWebLightmap(document, {
      resolution: 256,
      strength: 0.5,
      ambient: 1,
      ambientColor: "#ffffff",
      lights: [],
      ambientOcclusion: false,
      aoSamples: 4,
      shadows: false,
      shadowSamples: 1,
      indirectSamples: 0,
      denoise: false
    }, undefined, async (pixels) => {
      encodedImages.push(pixels.slice());
      return ONE_PIXEL_PNG;
    });

    expect(encodedImages[1]!.some((value, index) => index % 4 !== 3 && value !== 0)).toBe(false);
  });
});

function createSingleTriangleDocument(): Document {
  const document = new Document();
  const buffer = document.createBuffer();
  const position = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
    -1, 0, -1,
    1, 0, -1,
    0, 0, 1
  ]));
  const normal = document.createAccessor().setType("VEC3").setBuffer(buffer).setArray(new Float32Array([
    0, 1, 0,
    0, 1, 0,
    0, 1, 0
  ]));
  const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(document.createMaterial());
  document.createScene().addChild(document.createNode().setMesh(document.createMesh().addPrimitive(primitive)));
  return document;
}

function findColoredPixel(pixels: Uint8ClampedArray): [number, number, number] {
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index] || pixels[index + 1] || pixels[index + 2]) return [pixels[index]!, pixels[index + 1]!, pixels[index + 2]!];
  }
  return [0, 0, 0];
}
