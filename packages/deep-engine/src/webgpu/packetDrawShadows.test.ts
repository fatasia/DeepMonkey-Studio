import { describe, expect, it, vi } from "vitest";
import { drawPacketBatches } from "./packetDraw.js";
import type { CachedPacketBatch, CachedPacketGeometry } from "./packetBufferTypes.js";
import type { Pipelines } from "./pipelines.js";
import type { PacketCullingResources } from "./packetCulling.js";
import type { PacketLodResources } from "./packetLodResources.js";

describe("non-caster GPU draw rejection before route selection", () => {
  it.each(["ordinary", "indirect", "lod"])("skips %s shadow routes without consuming draw resources", route => {
    const source = { key: "no-shadow", geometry: "missing-on-purpose", count: 128,
      alphaMode: "OPAQUE", castShadow: false,
      ...(route === "lod" ? { lod: { levels: [] } } : {}) };
    const batches = new Map([[source.key, { source } as unknown as CachedPacketBatch]]);
    const pass = { setPipeline: vi.fn() }, culling = { phase: vi.fn() }, lod = { draws: vi.fn() };
    const result = drawPacketBatches(pass as unknown as GPURenderPassEncoder, {} as Pipelines,
      "shadow", batches, new Map(), culling as unknown as PacketCullingResources,
      lod as unknown as PacketLodResources, undefined, route === "indirect", 2);
    expect(result).toEqual({ drawCalls: 0, triangles: 0 });
    expect(pass.setPipeline).not.toHaveBeenCalled(); expect(culling.phase).not.toHaveBeenCalled();
    expect(lod.draws).not.toHaveBeenCalled();
  });
});

describe("author transparent caster routes", () => {
  it.each(["ordinary", "indirect", "lod"])("uses solid untextured shadow depth for textured BLEND in %s", route => {
    const source = { key: "blend", geometry: "g", count: 128, alphaMode: "BLEND",
      textures: { baseColor: "alpha-map" },
      ...(route === "lod" ? { lod: { levels: [{ triangles: 1 }] } } : {}) };
    const batches = new Map([[source.key, { source } as unknown as CachedPacketBatch]]);
    const mesh = { indexCount: 3, draw: vi.fn(), drawIndirect: vi.fn() };
    const geometries = new Map([["g", { mesh } as unknown as CachedPacketGeometry]]);
    const pass = { setPipeline: vi.fn(), setBindGroup: vi.fn() };
    const culling = { phase: vi.fn(() => ({ compacted: {}, indirect: {} })) };
    const lod = { draws: vi.fn(() => [{ geometry: "g" }]) };
    const pipelines = { shadowPipelines: new Map([["solid/ccw", "solid-depth"]]) } as unknown as Pipelines;
    expect(drawPacketBatches(pass as unknown as GPURenderPassEncoder, pipelines,
      "shadow", batches, geometries, culling as unknown as PacketCullingResources,
      lod as unknown as PacketLodResources, undefined, route === "indirect", 0, false, true))
      .toEqual({ drawCalls: 1, triangles: 128 });
    expect(pass.setPipeline).toHaveBeenCalledWith("solid-depth");
    expect(pass.setBindGroup).not.toHaveBeenCalled();
    expect(route === "ordinary" ? mesh.draw : mesh.drawIndirect).toHaveBeenCalledOnce();
  });
});
