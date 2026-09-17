import { afterEach, expect, it, vi } from "vitest";
import { sha256Bytes } from "@bim-studio/deep-engine/shader-package";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { RASTER_BYTES_LIMIT, snapshotRasterInput, verifyRaster } from "./dashboardRasterValidation";
import type { DashboardRasterCompileInput, DashboardRasterResult } from "./dashboardRasterTypes";

afterEach(() => vi.restoreAllMocks());
function input(bytes: Uint8Array): DashboardRasterCompileInput {
  return { document: source as DashboardRasterCompileInput["document"], locale: "zh-CN",
    packageId: "budget", packageVersion: "1.0.0", nodeAssets: {}, assets: {
      image: { bytes, sha256: sha256Bytes(bytes), mime: "image/png", identity: { id: "image", revision: 1 } },
    } };
}
function pixels(rgba: Uint8Array): DashboardRasterResult {
  return { width: 1, height: 1, rgba, requestHash: "a".repeat(64), sourceSha256: "b".repeat(64),
    sha256: sha256Bytes(rgba), format: "rgba8unorm-srgb", alphaMode: "straight", producer: { id: "test", version: "1" } };
}
it("copies only the resource view and isolates both bytes and metadata", () => {
  const backing = new Uint8Array(1024 * 1024), view = backing.subarray(50, 53);
  view.set([1, 2, 3]);
  const original = input(view), frozen = snapshotRasterInput(original);
  expect(frozen.assets.image!.bytes.buffer.byteLength).toBe(3);
  backing[50] = 9;
  expect([...frozen.assets.image!.bytes]).toEqual([1, 2, 3]);
  expect(frozen.assets.image!.identity).not.toBe(original.assets.image!.identity);
});
it("rejects aggregate resources before cloning or hashing their payload", () => {
  const original = input(new Uint8Array([1]));
  const bytes = new Uint8Array(RASTER_BYTES_LIMIT / 2 + 1);
  const asset = { ...original.assets.image!, bytes };
  const clone = vi.spyOn(globalThis, "structuredClone");
  expect(() => snapshotRasterInput({ ...original, assets: { a: asset, b: asset } })).toThrow("byte budget");
  expect(clone).not.toHaveBeenCalled();
});
it("preserves frozen resource hash rejection", () => {
  const original = input(new Uint8Array([1]));
  original.assets.image!.bytes[0] = 2;
  expect(() => snapshotRasterInput(original)).toThrow("identity mismatch");
});
it("copies only the pixel view and still validates its hash", () => {
  const bytes = new Uint8Array(1024 * 1024).subarray(40, 44);
  const result = pixels(bytes), frozen = verifyRaster(result, result.requestHash, 1, 1);
  expect(frozen.rgba.buffer.byteLength).toBe(4);
  bytes[0] = 9;
  expect(frozen.rgba[0]).toBe(0);
  expect(() => verifyRaster(result, result.requestHash, 1, 1)).toThrow("identity mismatch");
});
it("rejects invalid pixel dimensions and buffers before cloning", () => {
  const result = pixels(new Uint8Array(4));
  const clone = vi.spyOn(globalThis, "structuredClone");
  expect(() => verifyRaster({ ...result, rgba: new Uint8Array(8) }, result.requestHash, 1, 1)).toThrow("identity mismatch");
  expect(() => verifyRaster(result, result.requestHash, 8192, 8192)).toThrow("byte budget");
  expect(clone).not.toHaveBeenCalled();
});
