import { describe, expect, it } from "vitest";
import { packGpuLodScene } from "./gpuLodPacking.js";
import { decodeGpuLodRecords, selectGpuLodReference } from "./gpuLodReference.js";
import { GPU_LOD_FLAG_DRAWABLE, GPU_LOD_FLAG_HISTORY_RESET, GPU_LOD_FLAG_VISIBLE,
  GPU_LOD_LEVEL_STRIDE, GPU_LOD_MAX_LEVELS, GPU_LOD_OBJECT_STRIDE, GPU_LOD_OUTPUT_STRIDE } from "./gpuLodTypes.js";

const camera = { projection: "perspective" as const, position: [0, 0, 0] as const, forward: [0, 0, 1] as const,
  verticalFovRadians: Math.PI / 2, near: 0.1, far: 100 };
const viewport = { width: 200, height: 200 };

function source(overrides: Record<string, unknown> = {}) {
  return { bounds: { min: [-1, -1, 9] as const, max: [1, 1, 11] as const }, instanceIndex: 17, hysteresisRatio: 0.1,
    levels: [
      { minProjectedDiameterPixels: 30, geometricError: 1, triangles: 1_000, meshletOffset: 10, meshletCount: 20, resident: false },
      { minProjectedDiameterPixels: 10, geometricError: 2, triangles: 400, meshletOffset: 30, meshletCount: 8 },
      { minProjectedDiameterPixels: 0, geometricError: 8, triangles: 100, meshletOffset: 38, meshletCount: 2 },
    ], ...overrides };
}

describe("GPU LOD ABI and CPU reference", () => {
  it("requires descending thresholds to survive the float32 upload", () => {
    const run = (thresholds: readonly number[]) => packGpuLodScene([source({ levels: source().levels.map((level, index) =>
      ({ ...level, minProjectedDiameterPixels: thresholds[index]! })) })]);
    expect(() => run([30 + 1e-8, 30, 0])).toThrow("float32");
    expect(() => run([30, 1e-50, 0])).toThrow("float32");
    expect(() => run([30 + 2 ** -19, 30, 0])).not.toThrow();
  });
  it("packs compact fixed-slot object and level data with exact residency and meshlet fields", () => {
    const packed = packGpuLodScene([source()]);
    expect(packed.objectData.byteLength).toBe(GPU_LOD_OBJECT_STRIDE);
    expect(packed.levelData.byteLength).toBe(GPU_LOD_LEVEL_STRIDE * GPU_LOD_MAX_LEVELS);
    const objectF = new Float32Array(packed.objectData), objectU = new Uint32Array(packed.objectData);
    expect([...objectF.slice(0, 4)]).toEqual([0, 0, 10, expect.closeTo(Math.sqrt(3), 5)]);
    expect([...objectU.slice(4, 7)]).toEqual([3, 0b110, 17]); expect(objectF[7]).toBeCloseTo(0.1);
    const levelF = new Float32Array(packed.levelData), levelU = new Uint32Array(packed.levelData);
    expect([...levelF.slice(0, 2)]).toEqual([30, 1]); expect([...levelU.slice(2, 5)]).toEqual([1_000, 10, 20]);
  });

  it("preserves an exact packet-runtime sphere without inflating it through an AABB", () => {
    const packed = packGpuLodScene([source({ bounds: undefined, sphere: [2, 3, 10, 1] })]);
    expect([...new Float32Array(packed.objectData).slice(0, 4)]).toEqual([2, 3, 10, 1]);
    expect(() => packGpuLodScene([source({ sphere: [0, 0, 0, 1] })])).toThrow("exactly one");
    expect(() => packGpuLodScene([source({ bounds: undefined, sphere: [0, 0, 0, -1] })])).toThrow("sphere");
  });

  it("matches perspective projection, persistent hysteresis, coarser residency fallback, and packed output exactly", () => {
    const packed = packGpuLodScene([source()]);
    const first = selectGpuLodReference(packed, camera, viewport);
    expect(first.records[0]).toMatchObject({ baseLevel: 0, desiredLevel: 0, selectedLevel: 1, instanceIndex: 17,
      triangles: 400, meshletOffset: 30, meshletCount: 8,
      flags: GPU_LOD_FLAG_VISIBLE | GPU_LOD_FLAG_DRAWABLE | GPU_LOD_FLAG_HISTORY_RESET });
    expect(first.records[0]!.pixelsPerWorldUnit).toBe(10);
    expect(first.records[0]!.projectedDiameterPixels).toBeCloseTo(34.641, 3);
    expect(first.records[0]!.projectedErrorPixels).toBe(20);
    const held = selectGpuLodReference(packed, { ...camera, position: [0, 0, -1] }, viewport, new Uint32Array([1]), false);
    expect(held.records[0]).toMatchObject({ baseLevel: 0, desiredLevel: 1, selectedLevel: 1 });
    expect(decodeGpuLodRecords(first.packedRecords, 1)).toEqual(first.records);
  });

  it("supports orthographic projection and emits explicit unavailable records for depth or residency misses", () => {
    const packed = packGpuLodScene([source(), source({ bounds: { min: [-1, -1, 199], max: [1, 1, 201] } }),
      source({ levels: source().levels.map(level => ({ ...level, resident: false })) })]);
    const result = selectGpuLodReference(packed, { projection: "orthographic", position: [0, 0, 0], forward: [0, 0, 1],
      verticalSize: 200, near: 0.1, far: 100 }, viewport);
    expect(result.records[0]).toMatchObject({ baseLevel: 2, desiredLevel: 2, selectedLevel: 2,
      projectedDiameterPixels: expect.closeTo(3.464, 3), triangles: 100 });
    expect(result.records[1]).toMatchObject({ selectedLevel: null, triangles: 0, flags: GPU_LOD_FLAG_HISTORY_RESET });
    expect(result.records[2]).toMatchObject({ selectedLevel: null, triangles: 0,
      flags: GPU_LOD_FLAG_VISIBLE | GPU_LOD_FLAG_HISTORY_RESET });
  });

  it("rejects invalid budgets, tables, bounds, and uint32 meshlet ranges before upload", () => {
    expect(() => packGpuLodScene([source({ levels: [] })])).toThrow("1-8");
    expect(() => packGpuLodScene([source({ levels: [...source().levels, ...source().levels, ...source().levels] })])).toThrow("1-8");
    expect(() => packGpuLodScene([source({ bounds: { min: [2, 0, 0], max: [1, 1, 1] } })])).toThrow("bounds");
    expect(() => packGpuLodScene([source({ levels: [{ ...source().levels[0], minProjectedDiameterPixels: 0 }] })])).not.toThrow();
    expect(() => packGpuLodScene([source({ levels: [{ ...source().levels[0], minProjectedDiameterPixels: 1,
      meshletOffset: 0xffff_ffff, meshletCount: 1 }] })])).toThrow("overflows");
    expect(() => packGpuLodScene([source({ levels: source().levels.map((level, index) => ({ ...level, triangles: 100 + index })) })])).toThrow("triangle counts");
  });

  it("reserves object and triangle budgets for deterministic stable-prefix consumption", () => {
    const packed = packGpuLodScene(Array.from({ length: 32 }, (_, index) => source({ instanceIndex: index })));
    const result = selectGpuLodReference(packed, camera, viewport);
    expect(result.records).toHaveLength(32);
    expect(result.packedRecords.byteLength).toBe(32 * GPU_LOD_OUTPUT_STRIDE);
    expect(result.records.every(record => record.triangles === 400 && record.meshletCount === 8)).toBe(true);
  });

  it("packs and selects a 10k-object scene deterministically", () => {
    const objects = Array.from({ length: 10_000 }, (_, index) => source({ instanceIndex: index,
      bounds: { min: [-1, -1, 9 + index % 7], max: [1, 1, 11 + index % 7] } }));
    const first = packGpuLodScene(objects), second = packGpuLodScene(objects);
    expect(hashBytes(first.objectData)).toBe(hashBytes(second.objectData));
    expect(hashBytes(first.levelData)).toBe(hashBytes(second.levelData));
    const selection = selectGpuLodReference(first, camera, viewport);
    expect(selection.records).toHaveLength(10_000);
    expect(hashBytes(selection.packedRecords)).toBe(hashBytes(selectGpuLodReference(second, camera, viewport).packedRecords));
  });
});

function hashBytes(data: ArrayBuffer): number {
  let hash = 0x811c9dc5;
  for (const byte of new Uint8Array(data)) { hash ^= byte; hash = Math.imul(hash, 0x01000193); }
  return hash >>> 0;
}
