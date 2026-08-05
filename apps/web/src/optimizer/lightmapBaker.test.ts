import { Document, WebIO } from "@gltf-transform/core";
import { describe, expect, it } from "vitest";
import { bakeWebLightmap } from "./lightmapBaker";

const ONE_PIXEL_PNG = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nXsAAAAASUVORK5CYII="), (character) => character.charCodeAt(0));

describe("bakeWebLightmap", () => {
  it("exports TEXCOORD_1 and a standard occlusion texture in GLB", async () => {
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
    const material = document.createMaterial("Lightmapped material");
    const primitive = document.createPrimitive().setAttribute("POSITION", position).setAttribute("NORMAL", normal).setMaterial(material);
    const mesh = document.createMesh().addPrimitive(primitive);
    document.createScene().addChild(document.createNode().setMesh(mesh));

    const result = await bakeWebLightmap(document, {
      resolution: 256,
      strength: 0.5,
      ambient: 0.3,
      lights: [],
      ambientOcclusion: false,
      aoSamples: 4,
      shadows: false
    }, undefined, async () => ONE_PIXEL_PNG);
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
    expect(exportedMaterial.getExtras().bimStudioLightmap).toMatchObject({ mode: "occlusion", texCoord: 1, resolution: 256 });
  });
});
