import { afterEach, expect, it, vi } from "vitest";
import type { DeviceSession } from "../src/webgpu/deviceSession.js";
import { readSceneChunkPixels } from "./sceneChunkResidencyProbeSupport.js";

afterEach(() => vi.unstubAllGlobals());
it("maps one range and decodes all same-frame BGRA samples by offset", async () => {
  vi.stubGlobal("GPUBufferUsage", { COPY_DST: 8, MAP_READ: 1 }); vi.stubGlobal("GPUMapMode", { READ: 1 });
  const data = new ArrayBuffer(768);
  new Uint8Array(data, 0, 4).set([1, 2, 200, 255]);
  new Uint8Array(data, 256, 4).set([3, 210, 4, 255]);
  new Uint8Array(data, 512, 4).set([220, 5, 6, 255]);
  let mapped = false;
  const buffer = { mapState: "mapped", mapAsync: vi.fn(async () => {}),
    getMappedRange: vi.fn(() => { if (mapped) throw new Error("mapped range overlaps"); mapped = true; return data; }),
    unmap: vi.fn(), destroy: vi.fn() };
  const texture = {}, copyTextureToBuffer = vi.fn(), submit = vi.fn(), getCurrentTexture = vi.fn(() => texture);
  const session = { format: "bgra8unorm", context: { getCurrentTexture }, device: {
    createBuffer: vi.fn(() => buffer), createCommandEncoder: () => ({ copyTextureToBuffer, finish: () => ({}) }), queue: { submit },
  } } as unknown as DeviceSession;
  const pixels = await readSceneChunkPixels(session, { width: 480, height: 320 } as HTMLCanvasElement, [-1, 1, 0]);
  expect(pixels).toEqual([[200, 2, 1, 255], [4, 210, 3, 255], [6, 5, 220, 255]]);
  expect(buffer.getMappedRange).toHaveBeenCalledOnce(); expect(getCurrentTexture).toHaveBeenCalledOnce();
  expect(copyTextureToBuffer).toHaveBeenCalledTimes(3); expect(submit).toHaveBeenCalledOnce();
  expect(copyTextureToBuffer.mock.calls.map(call => call[1].offset)).toEqual([0, 256, 512]);
  expect(buffer.destroy).toHaveBeenCalledOnce();
});
