import { expect, it, vi } from "vitest";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { decodedAssetImageDecoder } from "./decodedAssetImages";

function glb(textures: unknown[]) {
  const json = JSON.stringify({ asset: { version: "2.0" }, textures });
  const body = new TextEncoder().encode(json.padEnd(Math.ceil(json.length / 4) * 4));
  const bytes = new Uint8Array(20 + body.length), view = new DataView(bytes.buffer);
  [0x46546c67, 2, bytes.length, body.length, 0x4e4f534a].forEach((value, index) => view.setUint32(index * 4, value, true));
  bytes.set(body, 20); return bytes;
}
it("shares matching normalized image pixels while keeping fallback and cancellation semantics", async () => {
  const data = new Uint8Array([10, 20, 30, 255]);
  const texture = { id: "asset/texture/0/baseColor", revision: 0, semantic: "baseColor" as const, width: 1, height: 1, data };
  const packet: RenderPacket = { geometries: [], materials: [], instances: [], textures: [texture] };
  const fallback = { decode: vi.fn(async () => ({ width: 1, height: 1, data: new Uint8Array(4) })) };
  const bytes = glb([{ source: 2 }]);
  const decoder = decodedAssetImageDecoder(bytes, packet, "asset", fallback);
  const image = { id: "asset/image/2", imageIndex: 2, mimeType: "image/png" as const, data: new Uint8Array(0) };
  expect((await decoder.decode(image)).data).toBe(data);
  expect(fallback.decode).not.toHaveBeenCalled();
  await decoder.decode({ ...image, imageIndex: 1 });
  await decodedAssetImageDecoder(bytes, packet, "another-asset", fallback).decode(image);
  await decodedAssetImageDecoder(glb([{ source: 2, extensions: { KHR_texture_basisu: { source: 3 } } }]), packet, "asset", fallback).decode(image);
  expect(fallback.decode).toHaveBeenCalledTimes(3);
  expect(() => decoder.decode(image, AbortSignal.abort())).toThrow();
});
