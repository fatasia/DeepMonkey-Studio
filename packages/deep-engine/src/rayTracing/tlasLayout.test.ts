import { describe, expect, it } from "vitest";
import { deserializeBvhNodes } from "./rayTraceLayout.js";
import { buildTlas } from "./tlas.js";
import { deserializeTlasInstanceRecords, packTlasScene, TLAS_INSTANCE_SENTINEL, TLAS_INSTANCE_STRIDE_BYTES,
  TLAS_INSTANCE_STRIDE_WORDS, TLAS_INSTANCE_WORD, unpackTlasHitRecords } from "./tlasLayout.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

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

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

describe("tlas instance record layout", () => {
  const tlas = buildTlas([
    { id: "near", blas: quadBlas("near"), worldToLocal: IDENTITY, mask: 0b01 },
    { id: "far", blas: gridBlas("far", 4), worldToLocal: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 7], mask: 0b10 },
  ]);
  const packed = packTlasScene(tlas);

  it("packs one 128B record per TLAS order slot with self-describing fields", () => {
    expect(packed.instanceCount).toBe(tlas.built.order.length);
    expect(packed.recordBytes.byteLength).toBe(packed.instanceCount * TLAS_INSTANCE_STRIDE_BYTES);
    const records = deserializeTlasInstanceRecords(packed.recordBytes);
    records.forEach((record, slot) => {
      const bounds = tlas.instanceBounds[tlas.built.order[slot]!];
      expect(record.instanceIndex).toBe(tlas.built.order[slot]);
      expect(record.minX).toBe(bounds!.minX);
      expect(record.minY).toBe(bounds!.minY);
      expect(record.minZ).toBe(bounds!.minZ);
      expect(record.maxX).toBe(bounds!.maxX);
      expect(record.maxY).toBe(bounds!.maxY);
      expect(record.maxZ).toBe(bounds!.maxZ);
      expect(record.mask).toBe(tlas.instances[record.instanceIndex]!.mask);
      expect(record.worldToLocal).toEqual(tlas.instances[record.instanceIndex]!.worldToLocal);
    });
  });

  it("places BLAS node segments after the TLAS segment at contracted bases", () => {
    expect(packed.tlasNodeCount).toBe(tlas.built.nodes.length);
    const nodes = deserializeBvhNodes(packed.nodeBytes);
    expect(nodes).toHaveLength(packed.tlasNodeCount + packed.blasNodeCount);
    const records = deserializeTlasInstanceRecords(packed.recordBytes);
    const bases = records.map((record) => record.nodeBase);
    bases.forEach((base) => {
      expect(base).toBeGreaterThanOrEqual(packed.tlasNodeCount);
      expect(base).toBeLessThan(packed.tlasNodeCount + packed.blasNodeCount);
    });
    expect(new Set(bases).size).toBe(records.length);
  });

  it("concatenates vertices, remaps indices by vertexBase and composes a global order", () => {
    const records = deserializeTlasInstanceRecords(packed.recordBytes);
    const totalVertices = records.reduce((sum, record) => {
      const blas = tlas.instances[record.instanceIndex]!.blas;
      return sum + blas.vertices.length / 3;
    }, 0);
    expect(packed.vertices.length).toBe(totalVertices * 3);
    expect(packed.indices).toHaveLength(packed.triangleCount * 3);
    expect(packed.order).toHaveLength(packed.triangleCount);
    // 段基址按槽位前缀累计：vertexBase = 前序段顶点数；每段索引/全局 order 逐项核对。
    records.forEach((record, slot) => {
      const blas = tlas.instances[record.instanceIndex]!.blas;
      const vertexBase = records.slice(0, slot).reduce((sum, prev) =>
        sum + tlas.instances[prev.instanceIndex]!.blas.vertices.length / 3, 0);
      expect(record.nodeBase).toBeGreaterThanOrEqual(packed.tlasNodeCount);
      for (let local = 0; local < blas.indices.length; local++) {
        expect(packed.indices[record.triangleBase * 3 + local]).toBe(vertexBase + blas.indices[local]);
      }
      for (let local = 0; local < blas.indices.length / 3; local++) {
        const globalPrim = packed.order[record.triangleBase + local]!;
        expect(globalPrim).toBeGreaterThanOrEqual(record.triangleBase);
        expect(globalPrim).toBeLessThan(record.triangleBase + blas.indices.length / 3);
      }
    });
  });

  it("round-trips the packed scene through the plan-relevant counts", () => {
    const triangles = tlas.instances.reduce((sum, instance) => sum + instance.blas.indices.length / 3, 0);
    expect(packed.triangleCount).toBe(triangles);
    expect(packed.placements.map((placement) => placement.instanceIndex)).toEqual([...tlas.built.order]);
  });

  it("rejects non-multiple instance buffers and malformed record buffers", () => {
    expect(() => deserializeTlasInstanceRecords(new ArrayBuffer(TLAS_INSTANCE_STRIDE_BYTES + 4))).toThrow("multiple of 128");
    expect(() => unpackTlasHitRecords(new ArrayBuffer(12))).toThrow("multiple of 16");
  });

  it("reads instanceIndex from hit-record slot 4 and reports the sentinel contract", () => {
    const buffer = new ArrayBuffer(2 * 16);
    const floats = new Float32Array(buffer);
    const words = new Uint32Array(buffer);
    floats[0] = 2.5; words[1] = 9; words[2] = 1; words[3] = 5;
    floats[4] = -1; words[5] = 0xffff_ffff; words[7] = TLAS_INSTANCE_SENTINEL;
    const records = unpackTlasHitRecords(buffer);
    expect(records).toEqual([
      { index: 0, t: 2.5, primitiveIndex: 9, status: 1, instanceIndex: 5 },
      { index: 1, t: -1, primitiveIndex: 0xffff_ffff, status: 0, instanceIndex: TLAS_INSTANCE_SENTINEL },
    ]);
  });

  it("keeps record words inside the 32-word stride", () => {
    expect(Math.max(...Object.values(TLAS_INSTANCE_WORD))).toBeLessThan(TLAS_INSTANCE_STRIDE_WORDS);
  });
});
