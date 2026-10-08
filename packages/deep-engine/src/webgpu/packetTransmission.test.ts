import { it, expect, vi } from "vitest";
import { drawPacketBatches } from "./packetDraw.js";
import { hasSceneTransmission } from "./packetTransmission.js";
import { normalizeExtendedMaterialParameters } from "../shader/materialParameters.js";
import type { PreparedBatch } from "../renderPacket.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { Pipelines } from "./pipelines.js";
import type { PacketCullingResources } from "./packetCulling.js";

it("draws authored OPAQUE/alpha1 transmission after opaque depth without rewriting the batch", () => {
  const source = { key: "glass", geometry: "g", count: 1, alphaMode: "OPAQUE", mirrored: false, doubleSided: false,
    data: new Float32Array(36), textures: { emissiveStrength: 1,
      extendedParameters: normalizeExtendedMaterialParameters({ transmission: { factor: 1 } }) } } as PreparedBatch;
  source.data[35] = 1;
  const batch = { source, buffer: {}, previousBuffer: {}, material: { group: {} } } as CachedPacketBatch;
  const mesh = { indexCount: 3, draw: vi.fn() };
  const batches = new Map([["glass", batch]]), geometries = new Map([["g", { mesh } as unknown as CachedPacketGeometry]]);
  const pipeline = {} as GPURenderPipeline;
  const pipelines = { mainPipelines: new Map([["material/blend/ccw", pipeline], ["material/depth/ccw", pipeline]]),
    materialLayout: { advancedMaterials: true } } as unknown as Pipelines;
  const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn() } as unknown as GPURenderPassEncoder;
  const draw = (phase: "opaque" | "transparent", active = pipelines) => drawPacketBatches(pass, active,
    phase, batches, geometries, {} as PacketCullingResources);
  expect(draw("opaque").drawCalls).toBe(0); expect(draw("transparent").drawCalls).toBe(1);
  expect(source.alphaMode).toBe("OPAQUE"); expect(source.data[35]).toBe(1);
  const stock = { ...pipelines, materialLayout: {} } as Pipelines;
  expect(draw("opaque", stock).drawCalls).toBe(1); expect(draw("transparent", stock).drawCalls).toBe(0);
  expect(hasSceneTransmission({ ...source, textures: { ...source.textures!, extendedParameters: normalizeExtendedMaterialParameters({}) } }, true)).toBe(false);
});
