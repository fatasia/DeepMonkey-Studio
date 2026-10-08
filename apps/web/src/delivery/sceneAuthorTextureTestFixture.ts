import { readFileSync } from "node:fs";

/** Keep the official Box UV geometry, replacing its embedded texture with author images. */
export function authorTextureTestGlb(): Buffer {
  const bytes = readFileSync(new URL("../../../../packages/deep-engine/lab/assets/BoxTextured.glb", import.meta.url));
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString("utf8"));
  for (const material of gltf.materials) delete material.pbrMetallicRoughness.baseColorTexture;
  delete gltf.images;
  delete gltf.textures;
  delete gltf.samplers;
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 0x20);
  json.copy(padded);
  const rest = bytes.subarray(20 + jsonLength), header = Buffer.from(bytes.subarray(0, 20));
  header.writeUInt32LE(20 + padded.length + rest.length, 8);
  header.writeUInt32LE(padded.length, 12);
  return Buffer.concat([header, padded, rest]);
}
