import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { prepareRenderPacket } from "../renderPacket.js";
import { decodeGlb } from "./decodeGlb.js";
import { GltfImportError } from "./validation.js";

const jsonType = 0x4e4f534a, binType = 0x004e4942;
function chunked(chunks: { type: number; bytes: Uint8Array }[]): Uint8Array {
  const bytes = new Uint8Array(12 + chunks.reduce((sum, chunk) => sum + 8 + chunk.bytes.length, 0)), view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, bytes.length, true);
  let offset = 12;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.bytes.length, true); view.setUint32(offset + 4, chunk.type, true);
    bytes.set(chunk.bytes, offset + 8); offset += 8 + chunk.bytes.length;
  }
  return bytes;
}
function json(document: unknown) {
  const text = JSON.stringify(document);
  return { type: jsonType, bytes: new TextEncoder().encode(text + " ".repeat((4 - text.length % 4) % 4)) };
}
function failure(bytes: Uint8Array, code: string, path: string) {
  let error: unknown;
  try { decodeGlb(bytes); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(GltfImportError); expect(error).toMatchObject({ code });
  expect((error as GltfImportError).path).toContain(path);
}

describe("GLB byte envelope and official fixture import", () => {
  it.each(["Box", "BoxInterleaved"])("decodes Khronos %s to a complete renderable packet", name => {
    const bytes = readFileSync(new URL(`../../lab/assets/${name}.glb`, import.meta.url)), packet = decodeGlb(bytes, { resourcePrefix: name });
    expect(packet.geometries).toHaveLength(1); expect(packet.instances).toHaveLength(1);
    expect(packet.geometries[0]!.vertices).toHaveLength(24 * 6); expect(packet.geometries[0]!.indices).toHaveLength(36);
    expect(packet.instances[0]!.transform).toEqual([1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1]);
    expect(packet.materials[0]!.baseColor[0]).toBeCloseTo(0.8);
    expect(packet.materials[0]!.metallic).toBe(name === "Box" ? 0 : 1);
    expect(prepareRenderPacket(packet).batches[0]!.count).toBe(1);
  });
  it("decodes equivalent geometry from packed and interleaved upstream files", () => {
    const [a, b] = ["Box", "BoxInterleaved"].map(name => decodeGlb(readFileSync(new URL(`../../lab/assets/${name}.glb`, import.meta.url))));
    expect(a!.geometries[0]!.vertices).toEqual(b!.geometries[0]!.vertices);
    expect(a!.geometries[0]!.indices).toEqual(b!.geometries[0]!.indices);
  });
  it("accepts JSON-only empty scenes, byte subviews and unknown appended chunks", () => {
    const encoded = chunked([json({ asset: { version: "2.0" }, scenes: [{}] }), { type: 0x12345678, bytes: new Uint8Array(4) }]);
    const backing = new Uint8Array(encoded.length + 7); backing.set(encoded, 3);
    expect(decodeGlb(backing.subarray(3, encoded.length + 3))).toEqual({ geometries: [], materials: [], instances: [] });
  });
  it("validates GLB header, total length and chunk boundaries", () => {
    failure(new Uint8Array(19), "invalid", "glb");
    const original = chunked([json({ asset: { version: "2.0" }, scenes: [{}] })]);
    for (const [offset, value, code, path] of [[0, 1, "invalid", "magic"], [4, 1, "unsupported", "version"], [8, 20, "invalid", "length"], [12, 1, "invalid", "chunks"]] as const) {
      const bytes = original.slice(); new DataView(bytes.buffer).setUint32(offset, value, true); failure(bytes, code, path);
    }
    const truncated = original.slice(0, -4); new DataView(truncated.buffer).setUint32(8, truncated.length, true);
    failure(truncated, "invalid", "chunks");
  });
  it("rejects wrong chunk order, duplicate JSON and duplicate BIN", () => {
    const document = json({ asset: { version: "2.0" }, scenes: [{}], buffers: [{ byteLength: 4 }] }), bin = { type: binType, bytes: new Uint8Array(4) };
    failure(chunked([bin, document]), "invalid", "chunks[0]");
    failure(chunked([document, document]), "invalid", "chunks[1]");
    failure(chunked([document, bin, bin]), "invalid", "chunks[2]");
    failure(chunked([document, { type: 1, bytes: new Uint8Array(4) }, bin]), "invalid", "chunks[2]");
  });
  it("rejects malformed UTF-8 and JSON before scene conversion", () => {
    failure(chunked([{ type: jsonType, bytes: new Uint8Array([0xff, 0xff, 0xff, 0xff]) }]), "invalid", "chunks[0]");
    failure(chunked([{ type: jsonType, bytes: new TextEncoder().encode("{  \u0000") }]), "invalid", "chunks[0]");
  });
  it("honors declared BIN length and zero padding", () => {
    const document = (byteLength: number) => json({ asset: { version: "2.0" }, scenes: [{}], buffers: [{ byteLength }] });
    expect(decodeGlb(chunked([document(1), { type: binType, bytes: new Uint8Array(4) }])).instances).toEqual([]);
    failure(chunked([document(1), { type: binType, bytes: new Uint8Array([0, 0, 1, 0]) }]), "invalid", "bin");
    failure(chunked([document(5), { type: binType, bytes: new Uint8Array(4) }]), "invalid", "bin");
    failure(chunked([document(1), { type: binType, bytes: new Uint8Array(8) }]), "invalid", "bin");
  });
  it("reports external/multiple GLB buffers explicitly and forbids an embedded buffer URI", () => {
    const document = (buffers: unknown[]) => json({ asset: { version: "2.0" }, scenes: [{}], buffers });
    failure(chunked([document([{ byteLength: 4, uri: "external.bin" }])]), "unsupported", "buffers");
    failure(chunked([document([{ byteLength: 4 }, { byteLength: 4 }]), { type: binType, bytes: new Uint8Array(4) }]), "unsupported", "buffers");
    failure(chunked([document([{ byteLength: 4, uri: "bad.bin" }]), { type: binType, bytes: new Uint8Array(4) }]), "invalid", "uri");
  });
});
