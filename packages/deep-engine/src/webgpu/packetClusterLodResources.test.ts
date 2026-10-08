import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareRenderPacket, type RenderPacket } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import { PacketClusterLodResources } from "./packetClusterLodResources.js";
import { drawPacketBatches } from "./packetDraw.js";
import { mainPipelineKey, shadowPipelineKey, type Pipelines } from "./pipelines.js";
import type { PacketCullingResources } from "./packetCulling.js";

const slots = vi.hoisted(() => [] as Array<{ warming: boolean; stale: boolean; dispose: ReturnType<typeof vi.fn>; drawWithGeometry: ReturnType<typeof vi.fn> }>);
vi.mock("./clusterLodRenderSlot.js", () => ({ ClusterLodRenderSlot: { create: () => {
  const slot = { warming: true, stale: false, dispose: vi.fn(), hasFallback: () => false,
    metrics: () => ({ warming: slot.warming, stale: slot.stale }),
    drawWithGeometry: vi.fn(() => ({ draws: 3, triangles: 16 })),
    updateCameraFromView: vi.fn(), encodeFrame: vi.fn(), ingest: async () => {}, cancelPendingFrame: vi.fn() };
  slots.push(slot); return slot;
} } }));

function fixture() {
  const positions: number[] = [], indices: number[] = [];
  for (let z = 0; z <= 20; z++) for (let x = 0; x <= 20; x++) positions.push(x, 0, z, 0, 1, 0);
  for (let z = 0; z < 20; z++) for (let x = 0; x < 20; x++) {
    const a = z * 21 + x; indices.push(a, a + 21, a + 1, a + 1, a + 21, a + 22);
  }
  const packet: RenderPacket = { geometries: ["grid", "grid-blue"].map(id => ({ id, revision: 1, vertices: Float32Array.from(positions), indices: Uint32Array.from(indices) })),
    materials: [{ id: "red", baseColor: [1, 0, 0], metallic: 0, roughness: 0.2 }, { id: "blue", baseColor: [0, 0, 1], metallic: 0.8, roughness: 0.9 }],
    instances: ["red", "blue"].flatMap(material => [0, 1].map(index => ({ id: `${material}-${index}`, geometry: material === "blue" ? "grid-blue" : "grid", material,
      transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, index * 25, 0, 0, 1] }))) };
  const owned = new Set<GPUBuffer>();
  const session = { device: { queue: { writeBuffer: vi.fn() }, createBuffer: vi.fn(() => ({ destroy: vi.fn() })) },
    own(buffer: GPUBuffer) { owned.add(buffer); return buffer; }, release(buffer: GPUBuffer) { if (owned.delete(buffer)) buffer.destroy(); } } as unknown as DeviceSession;
  const prepared = prepareRenderPacket(packet);
  const batches = new Map(prepared.batches.map(source => [source.key, { source, buffer: {} as GPUBuffer, previousBuffer: {} as GPUBuffer }] as const));
  const ordinary = { draw: vi.fn() };
  const geometries = new Map(packet.geometries.map(source => [source.id, { source, mesh: { ...ordinary, indexCount: 2400 } } as CachedPacketGeometry]));
  const resources = new PacketClusterLodResources(session, batches, geometries);
  const pass = { setPipeline: vi.fn() } as unknown as GPURenderPassEncoder;
  const pipelines = { mainPipelines: new Map([[mainPipelineKey("plain", false, "ccw"), "pbr"]]),
    shadowPipelines: new Map([[shadowPipelineKey("solid", "ccw"), "shadow"]]) } as unknown as Pipelines;
  const draw = (phase: "opaque" | "shadow" = "opaque") => drawPacketBatches(pass, pipelines, phase, batches, geometries,
    {} as PacketCullingResources, undefined, undefined, false, 0, false, false, undefined,
    (pass, batch, previous) => resources.draw(pass, batch, previous));
  return { resources, batches, draw, ordinary, owned };
}

beforeEach(() => { slots.length = 0; vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 }); });
afterEach(() => vi.unstubAllGlobals());

describe("production packet cluster replacement", () => {
  it("draws original sections while warming, then replaces every instance once and retains shadow geometry", () => {
    const f = fixture(); expect(slots).toHaveLength(4);
    expect(f.draw()).toEqual({ drawCalls: 2, triangles: 3200 });
    expect(f.ordinary.draw).toHaveBeenCalledTimes(2); f.ordinary.draw.mockClear();
    slots.forEach(slot => { slot.warming = false; });
    expect(f.draw()).toEqual({ drawCalls: 12, triangles: 64 });
    expect(f.ordinary.draw).not.toHaveBeenCalled();
    const batchList = [...f.batches.values()];
    for (const [index, slot] of slots.entries()) {
      const call = slot.drawWithGeometry.mock.calls[0]!;
      expect(call[3]).toBe(batchList[Math.floor(index / 2)]!.buffer);
      expect(call[4]).toBe(batchList[Math.floor(index / 2)]!.previousBuffer);
      expect(call[5]).toBe(index % 2);
    }
    expect(f.draw("shadow")).toEqual({ drawCalls: 2, triangles: 3200 });
    expect(f.ordinary.draw).toHaveBeenCalledTimes(2);
    f.resources.dispose(); f.resources.dispose(); expect(f.owned.size).toBe(0);
    slots.forEach(slot => expect(slot.dispose).toHaveBeenCalledOnce());
  });

  it("retires changed sections and discloses ordinary draw fallback", () => {
    const f = fixture(); slots.forEach(slot => { slot.warming = false; });
    const [key, batch] = [...f.batches][0]!;
    f.batches.set(key, { ...batch } as CachedPacketBatch);
    expect(f.draw()).toEqual({ drawCalls: 7, triangles: 1632 });
    expect(f.resources.metrics().fallbackReasons).toContain(`${key}:author-revision-changed`);
    expect(slots[0]!.dispose).toHaveBeenCalledOnce(); expect(slots[1]!.dispose).toHaveBeenCalledOnce();
    f.resources.dispose(); expect(f.owned.size).toBe(0);
  });
  it("keeps original geometry while a new camera selection is in flight", () => {
    const f = fixture(); slots.forEach(slot => { slot.warming = false; slot.stale = true; });
    expect(f.draw()).toEqual({ drawCalls: 2, triangles: 3200 });
    slots.forEach(slot => expect(slot.drawWithGeometry).not.toHaveBeenCalled());
    slots.forEach(slot => { slot.stale = false; });
    expect(f.draw()).toEqual({ drawCalls: 12, triangles: 64 }); f.resources.dispose();
  });
});
