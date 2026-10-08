import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WebIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import draco3d from "draco3dgltf";
import sharp from "sharp";
import { Box3, Vector3, Matrix4, SkinnedMesh, Mesh } from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { decodeDeformablePacketGlb } from "../../../packages/deep-engine/src/gltf/decodeDeformablePacketGlb.js";
import { parseGlb } from "../../../packages/deep-engine/src/gltf/parseGlb.js";

const [modelPath, outputPath] = process.argv.slice(2);
if (!modelPath || !outputPath) throw new Error("usage: tsx audit-initial-pose.mts MODEL.glb REPORT.json");
const bytes = new Uint8Array(await readFile(modelPath));
const io = new WebIO().registerExtensions(ALL_EXTENSIONS)
  .registerDependencies({ "draco3d.decoder": await draco3d.createDecoderModule() });
const document = await io.readBinary(bytes);
for (const extension of document.getRoot().listExtensionsUsed()) {
  if (extension.extensionName === "KHR_draco_mesh_compression") extension.dispose();
}
const normalized = await io.writeBinary(document);
const imageDecoder = { async decode(image: { data: Uint8Array }) {
  const decoded = await sharp(image.data).resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: decoded.info.width, height: decoded.info.height, data: new Uint8Array(decoded.data) };
} };
const options = { resourcePrefix: "smt", advancedMaterials: true, preserveTexCoords: true,
  textureBudgetBytes: 112 * 1024 * 1024 };
const live = await decodeDeformablePacketGlb(normalized, imageDecoder, { ...options, liveDeformation: true });
const baked = await decodeDeformablePacketGlb(normalized, imageDecoder, options);
function packetBounds(packet: typeof baked.packet) {
  const bounds = new Box3(), point = new Vector3(), matrix = new Matrix4();
  for (const instance of packet.instances) {
    const geometry = packet.geometries.find(g => g.id === instance.geometry)!;
    matrix.fromArray(instance.transform);
    for (let v = 0; v < geometry.vertices.length; v += 6) {
      point.fromArray(geometry.vertices, v).applyMatrix4(matrix); bounds.expandByPoint(point);
    }
  }
  return { min: bounds.min.toArray(), max: bounds.max.toArray() };
}
// The independent Three loader uses the same normalized geometry/skin/morph, without DOM image loading.
const parsed = parseGlb(normalized), oracle = structuredClone(parsed.json) as any;
delete oracle.images; delete oracle.textures; delete oracle.materials;
delete oracle.extensionsUsed; delete oracle.extensionsRequired;
for (const mesh of oracle.meshes ?? []) for (const primitive of mesh.primitives) delete primitive.material;
oracle.buffers = parsed.buffers.map(buffer => ({ byteLength: buffer.length,
  uri: `data:application/octet-stream;base64,${Buffer.from(buffer).toString("base64")}` }));
if (!("ProgressEvent" in globalThis)) Object.assign(globalThis, { ProgressEvent: class { constructor(readonly type: string) {} } });
const three = await new GLTFLoader().parseAsync(JSON.stringify(oracle), "");
three.scene.updateMatrixWorld(true);
const bounds = new Box3(), point = new Vector3();
let triangleCount = 0;
three.scene.traverse(object => {
  if (!(object instanceof Mesh)) return;
  const geometry = object.geometry, positions = geometry.getAttribute("position");
  triangleCount += (geometry.index?.count ?? positions.count) / 3;
  for (let vertex = 0; vertex < positions.count; vertex++) {
    point.fromBufferAttribute(positions, vertex);
    const targets = geometry.morphAttributes.position ?? [];
    for (let target = 0; target < targets.length; target++) {
      const delta = new Vector3().fromBufferAttribute(targets[target]!, vertex);
      if (!geometry.morphTargetsRelative) delta.sub(new Vector3().fromBufferAttribute(positions, vertex));
      point.addScaledVector(delta, object.morphTargetInfluences?.[target] ?? 0);
    }
    if (object instanceof SkinnedMesh) object.applyBoneTransform(vertex, point);
    point.applyMatrix4(object.matrixWorld); bounds.expandByPoint(point);
  }
});
const actual = packetBounds(baked.packet), expected = { min: bounds.min.toArray(), max: bounds.max.toArray() };
const maximumBoundsError = Math.max(...actual.min.map((v, i) => Math.abs(v - expected.min[i]!)),
  ...actual.max.map((v, i) => Math.abs(v - expected.max[i]!)));
const textureIdentity = (packet: typeof baked.packet) => packet.textures?.map(texture => ({ id: texture.id,
  sha256: createHash("sha256").update(texture.data).digest("hex"), width: texture.width, height: texture.height }));
const report = { modelPath, modelSha256: createHash("sha256").update(bytes).digest("hex"),
  normalizedSha256: createHash("sha256").update(normalized).digest("hex"), triangleCount,
  previousUnposedBounds: packetBounds(live.packet), bakedBounds: actual, threeInitialPoseBounds: expected,
  maximumBoundsError, materialsEqual: JSON.stringify(baked.packet.materials) === JSON.stringify(live.packet.materials),
  texturesEqual: JSON.stringify(textureIdentity(baked.packet)) === JSON.stringify(textureIdentity(live.packet)),
  textures: textureIdentity(baked.packet), instances: baked.packet.instances.length, mode: baked.mode,
  hasDeformation: baked.packet.deformation !== undefined };
await writeFile(outputPath, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ outputPath, maximumBoundsError, triangles: triangleCount,
  bakedBounds: actual, threeBounds: expected, materialsEqual: report.materialsEqual, texturesEqual: report.texturesEqual }));
if (maximumBoundsError > 0.0001 || !report.materialsEqual || !report.texturesEqual) process.exitCode = 1;
