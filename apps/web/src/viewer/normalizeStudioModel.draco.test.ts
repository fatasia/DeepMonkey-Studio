import { readFileSync } from "node:fs";
import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS, KHRDracoMeshCompression, KHRMaterialsSpecular, KHRMaterialsTransmission, type Specular } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import { afterEach, expect, it, vi } from "vitest";
import { parseGlb } from "@bim-studio/deep-engine/gltf";
import { optimizerIO } from "../optimizer/modelOptimizerIO";
import { normalizeStudioWasmModel } from "./normalizeStudioModel";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("decodes actual Draco while retaining material extensions, texture bytes and scene geometry", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(new Uint8Array(
    readFileSync(new URL(`../../node_modules/draco3dgltf/${url.split("/").at(-1)}`, import.meta.url))))));
  const encoder = await draco3d.createEncoderModule({ wasmBinary: new Uint8Array(
    readFileSync(new URL("../../node_modules/draco3dgltf/draco_encoder.wasm", import.meta.url))) });
  const io = new WebIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ "draco3d.encoder": encoder });
  const source = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url));
  const document = await io.readBinary(new Uint8Array(source));
  const root = document.getRoot(), material = root.listMaterials()[0]!, texture = root.listTextures()[0]!;
  const sourceImage = texture.getImage()!.slice(), factor = material.getBaseColorFactor();
  material.setName("source-window").setAlphaMode("BLEND");
  material.setExtension("KHR_materials_transmission", document.createExtension(KHRMaterialsTransmission).createTransmission().setTransmissionFactor(1));
  material.setExtension("KHR_materials_specular", document.createExtension(KHRMaterialsSpecular).createSpecular()
    .setSpecularFactor(.4).setSpecularColorFactor([.7, .8, .9]).setSpecularTexture(texture).setSpecularColorTexture(texture));
  const primitive = root.listMeshes()[0]!.listPrimitives()[0]!;
  const originalCount = primitive.getAttribute("POSITION")!.getCount(), originalIndices = primitive.getIndices()!.getCount();
  const originalMin = primitive.getAttribute("POSITION")!.getMin([]), originalMax = primitive.getAttribute("POSITION")!.getMax([]);
  document.createExtension(KHRDracoMeshCompression).setRequired(true);
  const compressed = await io.writeBinary(document);
  expect((parseGlb(compressed).json as { extensionsUsed: string[] }).extensionsUsed).toContain("KHR_draco_mesh_compression");
  const createEncoder = vi.spyOn(draco3d, "createEncoderModule"), createDecoder = vi.spyOn(draco3d, "createDecoderModule");
  const normalized = await normalizeStudioWasmModel(compressed, new AbortController().signal);
  expect(createEncoder).not.toHaveBeenCalled(); expect(createDecoder).toHaveBeenCalledOnce();
  expect(vi.mocked(fetch).mock.calls.map(([url]) => url)).toEqual(["/draco/draco_decoder_gltf.wasm"]);
  expect((parseGlb(normalized).json as { extensionsUsed: string[] }).extensionsUsed).not.toContain("KHR_draco_mesh_compression");
  const restored = await new WebIO().registerExtensions(ALL_EXTENSIONS).readBinary(normalized);
  const restoredRoot = restored.getRoot(), restoredMaterial = restoredRoot.listMaterials()[0]!;
  expect(restoredRoot.listTextures()).toHaveLength(1); expect(restoredRoot.listMeshes()).toHaveLength(root.listMeshes().length);
  expect(restoredRoot.listNodes()).toHaveLength(root.listNodes().length);
  expect(restoredRoot.listTextures()[0]!.getImage()).toEqual(sourceImage);
  expect(restoredMaterial.getName()).toBe("source-window"); expect(restoredMaterial.getAlphaMode()).toBe("BLEND");
  expect(restoredMaterial.getBaseColorFactor()).toEqual(factor);
  const restoredSpecular = restoredMaterial.getExtension<Specular>("KHR_materials_specular")!;
  expect(restoredSpecular.getSpecularTexture()).toBe(restoredRoot.listTextures()[0]);
  expect(restoredSpecular.getSpecularColorTexture()).toBe(restoredRoot.listTextures()[0]);
  const json = parseGlb(normalized).json as { materials: { extensions: Record<string, unknown> }[] };
  expect(json.materials[0]!.extensions.KHR_materials_transmission).toEqual({ transmissionFactor: 1 });
  expect(json.materials[0]!.extensions.KHR_materials_specular).toMatchObject({ specularFactor: .4,
    specularColorFactor: [.7, .8, .9], specularTexture: { index: expect.any(Number) }, specularColorTexture: { index: expect.any(Number) } });
  const positions = restoredRoot.listMeshes()[0]!.listPrimitives()[0]!.getAttribute("POSITION")!;
  expect(positions.getCount()).toBe(originalCount);
  expect(restoredRoot.listMeshes()[0]!.listPrimitives()[0]!.getIndices()!.getCount()).toBe(originalIndices);
  positions.getMin([]).forEach((value, index) => expect(value).toBeCloseTo(originalMin[index]!, 4));
  positions.getMax([]).forEach((value, index) => expect(value).toBeCloseTo(originalMax[index]!, 4));
  const optimizer = await optimizerIO();
  restored.createExtension(KHRDracoMeshCompression).setRequired(true);
  const recompressed = await optimizer.writeBinary(restored);
  expect((parseGlb(recompressed).json as { extensionsUsed: string[] }).extensionsUsed).toContain("KHR_draco_mesh_compression");
  expect(createEncoder).toHaveBeenCalledOnce(); expect(createDecoder).toHaveBeenCalledOnce();
}, 20_000);

it("returns ordinary GLB unchanged without fetching codec assets", async () => {
  const request = vi.fn(); vi.stubGlobal("fetch", request);
  const bytes = new Uint8Array(readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url)));
  expect(await normalizeStudioWasmModel(bytes, new AbortController().signal)).toBe(bytes);
  expect(request).not.toHaveBeenCalled();
});
