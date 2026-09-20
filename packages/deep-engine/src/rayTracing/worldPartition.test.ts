import { describe, expect, it } from "vitest";
import { worldCellCenter, worldCellOf, worldCellKey, worldStreamingPriority,
  worldStreamingPlan, WORLD_CELL_SIZE } from "./worldPartition.js";

const stationary = { cameraX: 0, cameraZ: 0, forwardX: 0, forwardZ: 0, speed: 0 };

describe("world partition contract", () => {
  it("maps positions to cells deterministically across negative quadrants", () => {
    expect(worldCellOf(100, -100)).toEqual({ cx: 0, cz: -1 });
    expect(worldCellOf(-1, -1)).toEqual({ cx: -1, cz: -1 });
    expect(worldCellCenter({ cx: 0, cz: -1 })).toEqual({ x: WORLD_CELL_SIZE / 2, z: -WORLD_CELL_SIZE / 2 });
    expect(worldCellKey({ cx: -3, cz: 7 })).toBe("-3|7");
    expect(() => worldCellOf(Number.NaN, 0)).toThrow(RangeError);
  });

  it("ranks nearer cells first for a stationary camera", () => {
    const plan = worldStreamingPlan(stationary, 2);
    expect(plan).toHaveLength(25);
    expect(plan[0]).toEqual({ cx: 0, cz: 0 });
    const first = worldStreamingPriority(plan[0]!, stationary);
    const second = worldStreamingPriority(plan[1]!, stationary);
    expect(first).toBeLessThanOrEqual(second);
  });

  it("prefers cells along velocity for a moving camera", () => {
    // 相机放在单元中心，取对称的 ±2 单元，避免单元网格原点偏置带来的距离差。
    const camera = { cameraX: 256, cameraZ: 256, forwardX: 1, forwardZ: 0, speed: 20 };
    const ahead = worldStreamingPriority({ cx: 2, cz: 0 }, camera);
    const behind = worldStreamingPriority({ cx: -2, cz: 0 }, camera);
    expect(ahead).toBeLessThan(behind);
  });

  it("ranks the camera's own cell absolutely first", () => {
    const input = { cameraX: 900, cameraZ: -700, forwardX: 1, forwardZ: 0, speed: 30 };
    const plan = worldStreamingPlan(input, 2);
    expect(plan[0]).toEqual(worldCellOf(900, -700));
  });

  it("produces an identical plan for identical input and validates the radius", () => {
    const input = { cameraX: 900, cameraZ: -700, forwardX: 0.6, forwardZ: 0.8, speed: 12 };
    expect(worldStreamingPlan(input, 3)).toEqual(worldStreamingPlan(input, 3));
    expect(() => worldStreamingPlan(input, -1)).toThrow(RangeError);
    expect(() => worldStreamingPlan(input, 65)).toThrow(RangeError);
  });
});
