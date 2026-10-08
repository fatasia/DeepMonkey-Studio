import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { parseGlb } from "@bim-studio/deep-engine/gltf";
import { compileSceneRenderPacket } from "../src/delivery/compileSceneRenderPacket";
import { decodeAuthorModel } from "../src/delivery/authorModelDecode";
import { describeDeepCompileNotice } from "../src/delivery/deepCompileNotice";

const [modelPath, scenePath, outputPath] = process.argv.slice(2);
if (!modelPath || !scenePath || !outputPath) throw new Error("usage: tsx audit-source-materials.mts MODEL.glb SCENE.json REPORT.json");
const bytes = new Uint8Array(await readFile(modelPath));
const scene = JSON.parse(await readFile(scenePath, "utf8"));
const [encoder, decoder] = await Promise.all([draco3d.createEncoderModule(), draco3d.createDecoderModule()]);
const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "draco3d.encoder": encoder, "draco3d.decoder": decoder });
const source = parseGlb(bytes).json as any;
const gltf = await io.readBinary(bytes);
for (const extension of gltf.getRoot().listExtensionsUsed()) {
  if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
}
const normalizedBytes = await io.writeBinary(gltf), normalized = parseGlb(normalizedBytes).json as any;
const imageDecoder = { async decode(image: { data: Uint8Array }) {
  const imageData = await sharp(image.data).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: imageData.info.width, height: imageData.info.height, data: new Uint8Array(imageData.data) };
} };
const compile = async (advancedMaterials: boolean) => compileSceneRenderPacket(scene, {
  loadModel: async () => bytes, liveDeformation: true, advancedMaterials,
  textureBudgetBytes: 112 * 1024 * 1024,
  decodeModel: (input, options, signal) => decodeAuthorModel(input, options, signal, async () => normalizedBytes, imageDecoder),
});
const [beforeProfile, afterProfile] = await Promise.all([compile(false), compile(true)]);
const sourceTuple = (document: any) => document.materials.map((material: any, index: number) => ({
  index, name: material.name, alphaMode: material.alphaMode ?? "OPAQUE",
  baseColorFactor: material.pbrMetallicRoughness?.baseColorFactor ?? [1, 1, 1, 1],
  roughness: material.pbrMetallicRoughness?.roughnessFactor ?? 1,
  metallic: material.pbrMetallicRoughness?.metallicFactor ?? 1,
  baseColorTexture: material.pbrMetallicRoughness?.baseColorTexture,
  metallicRoughnessTexture: material.pbrMetallicRoughness?.metallicRoughnessTexture,
  normalTexture: material.normalTexture, extensions: material.extensions,
}));
const packetSummary = (compiled: Awaited<ReturnType<typeof compile>>) => ({
  materials: compiled.packet.materials, materialLosses: compiled.materialLosses,
  notice: describeDeepCompileNotice(compiled), deformedModels: compiled.deformedModels,
  textures: compiled.packet.textures?.map(texture => ({ id: texture.id, semantic: texture.semantic,
    width: texture.width, height: texture.height, rgbaSha256: createHash("sha256").update(texture.data).digest("hex") })),
  geometryCount: compiled.packet.geometries.length, instanceCount: compiled.packet.instances.length,
  normalsCount: compiled.packet.geometries.reduce((sum, geometry) => sum + geometry.vertices.length / 6, 0),
  poseCount: compiled.packet.deformation?.poses.length ?? 0,
});
const report = { modelSha256: createHash("sha256").update(bytes).digest("hex"),
  source: sourceTuple(source), normalized: sourceTuple(normalized),
  defaultProfile: packetSummary(beforeProfile), advancedProfile: packetSummary(afterProfile),
  animationChannels: source.animations?.flatMap((clip: any) => clip.channels.map((channel: any) => channel.target)),
  scope: "CPU import and packet compilation; GPU transmission is verified separately" };
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputPath, instances: afterProfile.packet.instances.length,
  materialLosses: afterProfile.materialLosses?.length, glass: afterProfile.packet.materials.find(material => material.id.endsWith("/material/1")) }, null, 2));
