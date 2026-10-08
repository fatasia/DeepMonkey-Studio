import { expect, it, vi } from "vitest";
import type { PreparedBatch, PreparedMaterialTextures } from "../renderPacket.js";
import { packetMainPipelineKey, preparePacketMainPipelines } from "./packetPipelinePreparation.js";
import type { Pipelines } from "./pipelines.js";

function batch(values: Partial<PreparedBatch> = {}): PreparedBatch {
  return { key: "batch", geometry: "g", instanceIds: ["i"], mirrored: false, doubleSided: false,
    alphaMode: "OPAQUE", data: new Float32Array(), count: 1, ...values };
}
it("shares exact plain, mirrored, double-sided, normal, blend and coverage keys with draw routing", () => {
  expect(packetMainPipelineKey(batch(), false)).toBe("plain/depth/ccw");
  expect(packetMainPipelineKey(batch({ mirrored: true, alphaToCoverage: true }), false)).toBe("plain/depth/cw/a2c");
  expect(packetMainPipelineKey(batch({ alphaMode: "BLEND", doubleSided: true, alphaToCoverage: true }), false)).toBe("plain/blend/double");
  expect(packetMainPipelineKey(batch({ textures: { normal: {} } as PreparedMaterialTextures }), false)).toBe("normal/depth/ccw");
  expect(packetMainPipelineKey(batch({ alphaToCoverage: true }), false, true)).toBe("plain/depth/ccw");
});
it("admits authored transmission through the actual transparent key only in advanced pipelines", () => {
  const source = batch({ textures: { extendedParameters: { transmission: { factor: 1 } } } as PreparedMaterialTextures });
  expect(packetMainPipelineKey(source, true)).toBe("material/blend/ccw");
  expect(packetMainPipelineKey(source, false)).toBe("material/depth/ccw");
});
it("waits both selected and fallback pipeline sets, with no async work when all keys are resident", async () => {
  let resolve!: () => void;
  const prepare = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const fallback = vi.fn(() => undefined);
  const pipelines = { prepareMainKeys: prepare, textureArrayFallback: { prepareMainKeys: fallback } } as unknown as Pipelines;
  const pending = preparePacketMainPipelines(pipelines, [batch()]);
  expect(prepare).toHaveBeenCalledWith(["plain/depth/ccw"]); expect(fallback).toHaveBeenCalledWith(["plain/depth/ccw"]);
  resolve(); await pending;
  expect(preparePacketMainPipelines({} as Pipelines, [batch()])).toBeUndefined();
});
