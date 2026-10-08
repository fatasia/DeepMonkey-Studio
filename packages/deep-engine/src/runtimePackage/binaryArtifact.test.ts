import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { inflateSync } from "node:zlib";
import { expect, it } from "vitest";
import { buildDeepRuntimePackageBinaryArtifactAsync, RUNTIME_BINARY_MAGIC } from "./binaryArtifact.js";
import type { RenderPacket } from "../renderPacket.js";

const goldenUrl = new URL("../../../deep-engine-native/tests/fixtures/runtime-transfer-v1.json", import.meta.url);
const compressedGoldenUrl = new URL("../../../deep-engine-native/tests/fixtures/runtime-transfer-deflate-v1.json", import.meta.url);
function input() {
  const packet = JSON.parse(readFileSync(new URL("../../../deep-engine-native/fixtures/render_packet_v1.json", import.meta.url), "utf8"));
  for (const geometry of packet.geometries) {
    geometry.vertices = new Float32Array(geometry.vertices); geometry.indices = new Uint32Array(geometry.indices);
    geometry.uv0 = new Float32Array(geometry.vertices.length / 3);
  }
  packet.materials[0].baseColorTexture = { texture: "paint" };
  packet.textures = [{ id: "paint", revision: 1, semantic: "baseColor", width: 2, height: 2,
    data: new Uint8Array([200,100,220,255,1,2,3,255,4,5,6,255,7,8,9,255]),
    mipmaps: [{ width: 1, height: 1, data: new Uint8Array([53,29,60,255]) }] }];
  return { packageId: "binary.golden", packageVersion: "0.2.0", renderPacket: { id: "scene", revision: 1, value: packet as RenderPacket } };
}
function fixture(bytes: Uint8Array) {
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  return { header: new TextDecoder().decode(bytes.subarray(12, 12 + size)), bodyHex: Buffer.from(bytes.subarray(12 + size)).toString("hex"),
    transportHash: createHash("sha256").update(bytes.subarray(0, 12 + size)).digest("hex"),
    wireHash: createHash("sha256").update(bytes).digest("hex") };
}
it("matches the same complete typed-plane golden consumed by Rust", async () => {
  const artifact = await buildDeepRuntimePackageBinaryArtifactAsync(input());
  expect(new TextDecoder().decode(artifact.packageBytes.subarray(0, 8))).toBe(RUNTIME_BINARY_MAGIC);
  const actual = fixture(artifact.packageBytes);
  if (process.env.UPDATE_RUNTIME_TRANSFER_GOLDEN === "1") writeFileSync(goldenUrl, JSON.stringify(actual, null, 2) + "\n");
  expect(actual).toEqual(JSON.parse(readFileSync(goldenUrl, "utf8")));
  const header = JSON.parse(actual.header);
  expect(header.sections).toHaveLength(8);
  expect(header.envelope.payloads.scene.geometries[0].vertices).toEqual([]);
  expect(header.envelope.payloads.scene.textures[0].data).toEqual([]);
  expect(artifact.packageBytes.length).toBeLessThan(6500);
});
it("owns metadata and all streams before hashing yields", async () => {
  const source = input(), expected = await buildDeepRuntimePackageBinaryArtifactAsync(source);
  const pending = buildDeepRuntimePackageBinaryArtifactAsync(source);
  source.renderPacket.value.geometries[0]!.vertices.fill(0);
  source.renderPacket.value.textures![0]!.data.fill(0);
  (source.renderPacket.value.materials[0]! as { roughness: number }).roughness = 3;
  expect((await pending).packageBytes).toEqual(expected.packageBytes);
});
it("compresses full-resolution planes losslessly and matches the Rust deflate golden", async () => {
  const source = input(), rgba = new Uint8Array(256 * 256 * 4);
  for (let offset = 0; offset < rgba.length; offset += 4) rgba.set([200,100,220,255], offset);
  source.renderPacket.value = { ...source.renderPacket.value, textures: [{ ...source.renderPacket.value.textures![0]!,
    width: 256, height: 256, data: rgba, mipmaps: [] }] };
  const artifact = await buildDeepRuntimePackageBinaryArtifactAsync(source), actual = fixture(artifact.packageBytes);
  if (process.env.UPDATE_RUNTIME_TRANSFER_GOLDEN === "1") writeFileSync(compressedGoldenUrl, JSON.stringify(actual, null, 2) + "\n");
  expect(actual).toEqual(JSON.parse(readFileSync(compressedGoldenUrl, "utf8")));
  const header = JSON.parse(actual.header), section = header.sections.find((value: { path: string }) => value.path === "/textures/0/data");
  expect(section).toMatchObject({ compression: "deflate", decodedLength: rgba.length });
  const body = Buffer.from(actual.bodyHex, "hex");
  expect(new Uint8Array(inflateSync(body.subarray(section.offset, section.offset + section.length)))).toEqual(rgba);
  expect(artifact.packageBytes.length).toBeLessThan(6500);
});
it("keeps raw-plane bytes in resource identity", async () => {
  const first = input(), second = input(); second.renderPacket.value.textures![0]!.data[0] = 123;
  const a = await buildDeepRuntimePackageBinaryArtifactAsync(first), b = await buildDeepRuntimePackageBinaryArtifactAsync(second);
  expect(a.runtimePackage.resources.find(value => value.kind === "render-packet")!.contentHash)
    .not.toEqual(b.runtimePackage.resources.find(value => value.kind === "render-packet")!.contentHash);
  expect(a.runtimePackage.packageHash).not.toEqual(b.runtimePackage.packageHash);
});
it("rejects invalid source, cancellation and the separate static-lightmap hash profile", async () => {
  const source = input(); (source.renderPacket.value.materials[0]! as { roughness: number }).roughness = 3;
  await expect(buildDeepRuntimePackageBinaryArtifactAsync(source)).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(buildDeepRuntimePackageBinaryArtifactAsync(input(), { signal: controller.signal })).rejects.toThrow();
  await expect(buildDeepRuntimePackageBinaryArtifactAsync({ ...input(), environment: { staticLightmap: {} } } as never)).rejects.toThrow(/JSON runtime/);
});
