import { describe, expect, it } from "vitest";
import { planWorldChunkDemand, worldChunkKey, parseWorldChunkKey } from "./worldChunkBridge.js";
import { WORLD_CELL_LOD_COUNT } from "./worldPartition.js";

const camera = { cameraX: 900, cameraZ: -700, forwardX: 1, forwardZ: 0, speed: 10 };

describe("world chunk bridge", () => {
  it("expands each planned cell into lod-keyed demands in stable order", () => {
    const demands = planWorldChunkDemand(camera, 1);
    expect(demands).toHaveLength(9 * WORLD_CELL_LOD_COUNT);
    const keys = demands.map(demand => demand.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(parseWorldChunkKey(keys[0]!)).toBeDefined();
    // 同一单元的各 LOD 连续出现，紧迫度相同。
    const firstLods = demands.filter(demand => demand.cell.cx === demands[0]!.cell.cx
      && demand.cell.cz === demands[0]!.cell.cz);
    expect(firstLods).toHaveLength(WORLD_CELL_LOD_COUNT);
    expect(new Set(firstLods.map(demand => demand.urgency))).toHaveLength(1);
  });

  it("caps the demand set at maxCells and honours maxLod", () => {
    const demands = planWorldChunkDemand(camera, 3, { maxCells: 4, maxLod: 2 });
    expect(demands).toHaveLength(4 * 2);
    expect(demands.every(demand => demand.lod < 2)).toBe(true);
  });

  it("round-trips keys and rejects author-chunk keys", () => {
    const key = worldChunkKey({ cx: -3, cz: 12 }, 2);
    expect(parseWorldChunkKey(key)).toEqual({ cell: { cx: -3, cz: 12 }, lod: 2 });
    expect(parseWorldChunkKey("some-scene-geometry|deep-vg-0")).toBeUndefined();
    expect(parseWorldChunkKey("world|1|2|lod9")).toBeUndefined();
    expect(parseWorldChunkKey("world|1|2|core")).toBeUndefined();
  });

  it("normalises urgency by streaming priority rank", () => {
    const demands = planWorldChunkDemand(camera, 1);
    // 秩 0 = 最优先（相机单元），紧迫度 0；末秩紧迫度 1。
    expect(demands[0]!.cell).toEqual({ cx: 1, cz: -2 });
    expect(demands[0]!.urgency).toBe(0);
    expect(demands[demands.length - 1]!.urgency).toBe(1);
    // 单元首次出现顺序与紧迫度严格同序（worldStreamingPriority 升序）。
    const seenCells = new Set<string>();
    let lastUrgency = -1;
    for (const demand of demands) {
      const cellKey = `${demand.cell.cx}|${demand.cell.cz}`;
      if (seenCells.has(cellKey)) continue;
      seenCells.add(cellKey);
      expect(demand.urgency).toBeGreaterThan(lastUrgency);
      lastUrgency = demand.urgency;
    }
    expect(seenCells.size).toBe(9);
    expect(demands.filter(demand => demand.urgency === 0)).toHaveLength(WORLD_CELL_LOD_COUNT);
  });

  it("validates options fail-closed", () => {
    expect(() => planWorldChunkDemand(camera, 1, { maxCells: 0 })).toThrow(RangeError);
    expect(() => planWorldChunkDemand(camera, 1, { maxLod: 5 })).toThrow(RangeError);
  });
});
