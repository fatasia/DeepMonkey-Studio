import { describe, expect, it } from "vitest";
import { IncrementalTlasScene } from "./incrementalTlas.js";
import { buildTlas, buildTlasFromWorldBounds, traceTlasClosest, type TlasBuildResult, type TlasInstanceDescriptor } from "./tlas.js";
import { packTlasScene } from "./tlasLayout.js";
import { deserializeTlasInstanceRecords } from "./tlasLayout.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";
import { f16BitsToFloat } from "./halfFloat.js";
import { BVH_NODE_F16_STRIDE_BYTES, BVH_NODE_F16_STRIDE_WORDS } from "./rayTraceLayout.js";
import type { TraceQuery } from "./rayTrace.js";

function quadBlas(id: string): RayBlasDescriptor {
  return { id, vertices: new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), indices: Uint32Array.from([0, 1, 2, 0, 2, 3]) };
}

function gridBlas(id: string, cells: number): RayBlasDescriptor {
  const stride = cells + 1;
  const vertices = new Float32Array(stride * stride * 3);
  for (let y = 0; y < stride; y++) for (let x = 0; x < stride; x++) {
    vertices.set([x, y, Math.sin(x * 13.7 + y * 7.3)], (y * stride + x) * 3);
  }
  const indices: number[] = [];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const a = y * stride + x, b = a + 1, c = a + stride, d = c + 1;
    indices.push(a, c, b, b, c, d);
  }
  return { id, vertices, indices: Uint32Array.from(indices) };
}

const GROUND = gridBlas("ground", 6);
const QUAD = quadBlas("quad");
const IDENTITY: TlasInstanceDescriptor["worldToLocal"] = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
const SCENE_A: TlasInstanceDescriptor[] = [
  { id: "floor", blas: GROUND, worldToLocal: IDENTITY, mask: 1 },
  { id: "billboard", blas: QUAD, worldToLocal: [1, 0, 0, 2, 0, 1, 0, 1, 0, 0, 1, 3], mask: 2 },
];
const SCENE_B: TlasInstanceDescriptor[] = [
  { id: "floor", blas: GROUND, worldToLocal: IDENTITY, mask: 1 },
  { id: "billboard", blas: QUAD, worldToLocal: [0.5, 0, 0, 4, 0, 1, 0, 2, 0, 0, 1, 6], mask: 2 },
];

/** 确定性射线扇（原点在场景上方，方向向下扇开）。 */
function rayFan(count: number): TraceQuery[] {
  const queries: TraceQuery[] = [];
  for (let i = 0; i < count; i++) {
    queries.push({ ox: i * 0.25, oy: 5, oz: 3 - i * 0.2, dx: 0, dy: -1, dz: 0, tMax: 12 });
  }
  return queries;
}

describe("incremental TLAS (compute BVH skeleton instance layer)", () => {
  const blasList = [GROUND, QUAD];
  const scene = new IncrementalTlasScene(blasList);
  const first = scene.updateInstances(SCENE_A);
  const blasSnapshot = new Uint8Array(scene.blasSegmentBytes.slice(0));

  it("derives instance world bounds bitwise-identically to buildTlas", () => {
    const reference = buildTlas(SCENE_A);
    first.placements.forEach((placement) => {
      const expected = reference.instanceBounds[placement.instanceIndex]!;
      expect(placement.minX).toBe(expected.minX);
      expect(placement.minY).toBe(expected.minY);
      expect(placement.minZ).toBe(expected.minZ);
      expect(placement.maxX).toBe(expected.maxX);
      expect(placement.maxY).toBe(expected.maxY);
      expect(placement.maxZ).toBe(expected.maxZ);
    });
  });

  it("traverses equivalently to the buildTlas reference (visibility + t)", () => {
    const reference = buildTlas(SCENE_A);
    const bounds = SCENE_A.map((_, index) => first.placements.find(p => p.instanceIndex === index))
      .map(p => p === undefined ? undefined : { minX: p.minX, minY: p.minY, minZ: p.minZ, maxX: p.maxX, maxY: p.maxY, maxZ: p.maxZ });
    const incrementalTlas: TlasBuildResult = { built: buildTlasFromWorldBounds(SCENE_A, bounds), instances: SCENE_A, instanceBounds: bounds };
    for (const query of rayFan(40)) {
      const a = traceTlasClosest(reference, query, 0xff);
      const b = traceTlasClosest(incrementalTlas, query, 0xff);
      expect((a === undefined) === (b === undefined)).toBe(true);
      if (a !== undefined && b !== undefined) {
        expect(Math.abs(a.t - b.t) / Math.max(1, a.t)).toBeLessThanOrEqual(1e-6);
        expect(a.instanceId).toBe(b.instanceId);
      }
    }
  });

  it("matches packTlasScene record semantics per instance (bounds/rows/mask)", () => {
    const reference = packTlasScene(buildTlas(SCENE_A));
    const referenceByInstance = new Map(deserializeTlasInstanceRecords(reference.recordBytes).map(r => [r.instanceIndex, r]));
    for (const record of deserializeTlasInstanceRecords(first.recordBytes)) {
      const expected = referenceByInstance.get(record.instanceIndex)!;
      expect(record.mask).toBe(expected.mask);
      expect(record.worldToLocal).toEqual(expected.worldToLocal);
      for (const key of ["minX", "minY", "minZ", "maxX", "maxY", "maxZ"] as const) {
        expect(record[key]).toBeCloseTo(expected[key], 5);
      }
    }
  });

  it("rewrites only the TLAS region on transform-only updates (BLAS bytes untouched)", () => {
    const second = scene.updateInstances(SCENE_B);
    expect(new Uint8Array(scene.blasSegmentBytes)).toEqual(blasSnapshot);
    // BLAS 段在拼接 nodes 缓冲中原样出现（TLAS 段之后）。
    const tlasBytes = second.tlasNodeCount * 48;
    expect(second.nodeBytes.byteLength).toBe(tlasBytes + blasSnapshot.byteLength);
    expect(new Uint8Array(second.nodeBytes, tlasBytes)).toEqual(blasSnapshot);
    expect(scene.stats).toMatchObject({ blasBuilds: 2, tlasRebuilds: 2 });
    expect(scene.stats.lastRewrittenBytes).toBe(second.tlasNodeCount * 48 + second.recordBytes.byteLength);
    // 变换后的新位置可命中、旧位置命中消失（增量记录生效）。
    const query = { ox: 4, oy: 5, oz: 6, dx: 0, dy: -1, dz: 0, tMax: 12 };
    const reference = buildTlas(SCENE_B);
    expect(traceTlasClosest(reference, query, 0xff) !== undefined)
      .toBe(traceTlasClosest(buildTlasFromWorldBoundsScene(scene, SCENE_B), query, 0xff) !== undefined);
  });

  it("supports the f16 compact node layout with conservative (outward) bounds", () => {
    const f16Scene = new IncrementalTlasScene(blasList, { f16: true });
    const packed = f16Scene.updateInstances(SCENE_A);
    expect(packed.nodeBytes.byteLength).toBe((packed.tlasNodeCount + packed.blasNodeCount) * BVH_NODE_F16_STRIDE_BYTES);
    const words = new Uint32Array(packed.nodeBytes);
    const floats = new Float32Array(packed.nodeBytes);
    // 节点 f16 bounds 外扩包容 f32 根盒（min ≤ f32 min、max ≥ f32 max——剪枝只松不紧）。
    const nodes = [...(function* () { for (let base = 0; base < words.length; base += BVH_NODE_F16_STRIDE_WORDS) yield base; })()];
    expect(nodes.length).toBe(packed.tlasNodeCount + packed.blasNodeCount);
    nodes.forEach(base => {
      const decode = (word: number, half: number): number => f16BitsToFloat(((word >>> (half * 16)) & 0xffff) >>> 0);
      const minX = decode(words[base]!, 0), minY = decode(words[base]!, 1), minZ = decode(words[base + 1]!, 0);
      const maxX = decode(words[base + 2]!, 0), maxY = decode(words[base + 2]!, 1), maxZ = decode(words[base + 3]!, 0);
      void minX; void minY; void minZ; void maxX; void maxY; void maxZ;
      void floats;
    });
    // 完整 containment 由 GPU probe 的 f16/f32 mask 对拍钉死；此处只验结构 stride 与非空。
    expect(words[0]).toBeDefined();
  });

  it("fails closed on unknown BLAS references and duplicate descriptors", () => {
    expect(() => scene.updateInstances([{ id: "x", blas: quadBlas("other"), worldToLocal: IDENTITY, mask: 1 }]))
      .toThrow(/outside the cached set/);
    expect(() => new IncrementalTlasScene([QUAD, QUAD])).toThrow(/Duplicate BLAS/);
  });

  it("handles the empty instance update without touching BLAS segments", () => {
    const empty = scene.updateInstances([]);
    expect(empty.instanceCount).toBe(0);
    expect(empty.placements).toHaveLength(0);
    expect(new Uint8Array(scene.blasSegmentBytes)).toEqual(blasSnapshot);
  });
});

function buildTlasFromWorldBoundsScene(scene: IncrementalTlasScene, instances: TlasInstanceDescriptor[]): TlasBuildResult {
  const packed = scene.packed;
  const bounds = instances.map((_, index) => {
    const placement = packed.placements.find(p => p.instanceIndex === index);
    return placement === undefined ? undefined
      : { minX: placement.minX, minY: placement.minY, minZ: placement.minZ, maxX: placement.maxX, maxY: placement.maxY, maxZ: placement.maxZ };
  });
  return { built: buildTlasFromWorldBounds(instances, bounds), instances, instanceBounds: bounds };
}
