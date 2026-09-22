import { describe, expect, it } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import { ProbeSurfaceCache } from "./probeSurfaceCache.js";
import { compilePacketSurfaceCacheEntries, ProbeSurfaceCachePacketConsumer } from "./probeSurfaceCachePacket.js";

const identity = (x = 0) => new Float32Array([
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, 0, 0, 1,
]);

function packet(x = 0, includeInstance = true): RenderPacket {
  return {
    geometries: [{ id: "triangle", revision: 1,
      vertices: new Float32Array([
        0, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 0, 1,
        0, 1, 0, 0, 0, 1,
      ]), indices: new Uint32Array([0, 1, 2]) }],
    materials: [{ id: "paint", baseColor: [1, 0, 0], metallic: 0.2, roughness: 0.4 }],
    instances: includeInstance ? [{ id: "robot", geometry: "triangle", material: "paint", transform: identity(x) }] : [],
  };
}

describe("render packet surface-cache consumption", () => {
  it("compiles validated geometry and transforms into world-space dynamic coverage", () => {
    expect(compilePacketSurfaceCacheEntries({ packet: packet(10), revision: 3,
      dynamicInstanceIds: new Set(["robot"]) })).toEqual([{
      id: "packet/robot", revision: 3, dynamic: true,
      bounds: { min: [10, 0, 0], max: [11, 1, 0] },
    }]);
  });

  it("invalidates motion unions and removes stale packet instances", () => {
    const cache = new ProbeSurfaceCache(), consumer = new ProbeSurfaceCachePacketConsumer(cache);
    const initial = packet(10);
    expect(consumer.sync({ packet: initial, revision: 1 })).toBe(true);
    expect(consumer.sceneBounds).toEqual({ min: [10, 0, 0], max: [11, 1, 0] });
    cache.commit(cache.beginFrame());
    expect(consumer.sync({ packet: packet(20), revision: 2 })).toBe(true);
    expect(cache.beginFrame().dirtyBounds).toEqual([{ min: [10, 0, 0], max: [21, 1, 0] }]);
    cache.commit(cache.beginFrame());
    const empty = packet(0, false);
    expect(consumer.sync({ packet: empty, revision: 3 })).toBe(true);
    expect(consumer.sceneBounds).toBeNull();
    expect(cache.beginFrame().dirtyBounds).toEqual([{ min: [20, 0, 0], max: [21, 1, 0] }]);
    expect(consumer.sync({ packet: empty, revision: 3 })).toBe(false);
    expect(() => consumer.sync({ packet: empty, revision: 3,
      dynamicInstanceIds: new Set(["robot"]) })).toThrow(/without advancing revision/);
  });

  it("fails closed before mutation for invalid revisions, references and transforms", () => {
    const cache = new ProbeSurfaceCache(), consumer = new ProbeSurfaceCachePacketConsumer(cache);
    expect(() => consumer.sync({ packet: packet(), revision: 0 })).toThrow(/positive integer/);
    expect(() => consumer.sync({ packet: packet(), revision: 1,
      dynamicInstanceIds: new Set(["missing"]) })).toThrow(/does not exist/);
    expect(cache.size).toBe(0);
    const invalid = packet(); (invalid.instances[0]!.transform as Float32Array)[12] = Number.NaN;
    expect(() => consumer.sync({ packet: invalid, revision: 1 })).toThrow();
    expect(cache.size).toBe(0);
  });
});
