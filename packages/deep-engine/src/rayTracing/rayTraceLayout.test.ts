import { describe, expect, it } from "vitest";
import { buildBvh } from "./bvhBuilder.js";
import {
  BVH_LEAF_SENTINEL, BVH_NODE_STRIDE_BYTES, BVH_NODE_STRIDE_WORDS, BVH_NODE_WORD, deserializeBvhNodes,
  HIT_RECORD_STRIDE_BYTES, HIT_STATUS, packRayBatch, RAY_RECORD_WORDS, serializeBvhNodes, unpackHitRecords,
  unpackStackOverflows,
} from "./rayTraceLayout.js";
import type { RayBlasDescriptor } from "./rayBackendTypes.js";

function gridBlas(cells: number): RayBlasDescriptor {
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
  return { id: "layout-grid", vertices, indices: Uint32Array.from(indices) };
}

describe("bvh storage layout serialization", () => {
  it("round-trips every node field exactly, leaves carry the sentinel", () => {
    const built = buildBvh(gridBlas(6));
    const decoded = deserializeBvhNodes(serializeBvhNodes(built));
    expect(decoded).toHaveLength(built.nodes.length);
    let leafCount = 0;
    built.nodes.forEach((node, index) => {
      const restored = decoded[index]!;
      expect(restored.leftFirst).toBe(node.leftFirst);
      expect(restored.count).toBe(node.count);
      expect(restored.minX).toBe(node.minX);
      expect(restored.minY).toBe(node.minY);
      expect(restored.minZ).toBe(node.minZ);
      expect(restored.maxX).toBe(node.maxX);
      expect(restored.maxY).toBe(node.maxY);
      expect(restored.maxZ).toBe(node.maxZ);
      if (node.rightChild === undefined) {
        leafCount++;
        expect(restored.rightChild).toBeNull();
      } else {
        expect(restored.rightChild).toBe(node.rightChild);
      }
    });
    expect(leafCount).toBeGreaterThan(0);
  });

  it("places fields at the contracted byte offsets with zero pads", () => {
    const built = buildBvh(gridBlas(4));
    const buffer = serializeBvhNodes(built);
    expect(buffer.byteLength).toBe(built.nodes.length * BVH_NODE_STRIDE_BYTES);
    const floats = new Float32Array(buffer);
    const words = new Uint32Array(buffer);
    const node = built.nodes[3]!;
    const base = 3 * BVH_NODE_STRIDE_WORDS;
    const w = BVH_NODE_WORD;
    expect(floats[base + w.boundMinX]).toBe(node.minX);
    expect(floats[base + w.boundMinY]).toBe(node.minY);
    expect(floats[base + w.boundMinZ]).toBe(node.minZ);
    expect(floats[base + w.boundMinPad]).toBe(0);
    expect(floats[base + w.boundMaxX]).toBe(node.maxX);
    expect(floats[base + w.boundMaxY]).toBe(node.maxY);
    expect(floats[base + w.boundMaxZ]).toBe(node.maxZ);
    expect(floats[base + w.boundMaxPad]).toBe(0);
    expect(words[base + w.leftFirst]).toBe(node.leftFirst);
    expect(words[base + w.count]).toBe(node.count);
    expect(words[base + w.rightChild]).toBe(node.rightChild ?? BVH_LEAF_SENTINEL);
    expect(words[base + w.pad0]).toBe(0);
    // DataView 口径复核：boundMin.x 落在节点基址字节 0。
    expect(new DataView(buffer).getFloat32(3 * BVH_NODE_STRIDE_BYTES + 0, true)).toBe(node.minX);
  });

  it("serializes an empty bvh to a zero-length buffer", () => {
    expect(serializeBvhNodes({ nodes: Object.freeze([]), order: Object.freeze([]) }).byteLength).toBe(0);
  });

  it("rejects non-multiple buffers on deserialize", () => {
    expect(() => deserializeBvhNodes(new ArrayBuffer(BVH_NODE_STRIDE_BYTES + 4))).toThrow("multiple of 48");
  });
});

describe("ray stream packing", () => {
  it("interleaves origin/tMax and direction into vec4f slots", () => {
    const packed = packRayBatch({
      origins: new Float32Array([1, 2, 3, 4, 5, 6]),
      directions: new Float32Array([0, 0, -1, 1, 0, 0]),
      tMax: new Float32Array([10, 20]),
      mask: 0xff,
    });
    expect(packed).toHaveLength(2 * RAY_RECORD_WORDS);
    expect([...packed]).toEqual([1, 2, 3, 10, 0, 0, -1, 0, 4, 5, 6, 20, 1, 0, 0, 0]);
  });

  it("fails closed on stream length mismatch and non-positive tMax", () => {
    const query = { origins: new Float32Array(3), directions: new Float32Array(6),
      tMax: new Float32Array([1]), mask: 1 };
    expect(() => packRayBatch(query)).toThrow("agree in length");
    expect(() => packRayBatch({ ...query, directions: new Float32Array(3), tMax: new Float32Array([0]) }))
      .toThrow("finite and positive");
    expect(() => packRayBatch({ ...query, directions: new Float32Array(3), tMax: new Float32Array([Number.POSITIVE_INFINITY]) }))
      .toThrow("finite and positive");
  });
});

describe("hit record unpacking", () => {
  it("round-trips hit/miss/overflow records at 16-byte stride", () => {
    const buffer = new ArrayBuffer(3 * HIT_RECORD_STRIDE_BYTES);
    const floats = new Float32Array(buffer);
    const words = new Uint32Array(buffer);
    floats[0] = 3.5; words[1] = 7; words[2] = HIT_STATUS.hit;
    floats[4] = -1; words[5] = 0xffff_ffff; words[6] = HIT_STATUS.miss;
    words[10] = 2;
    const records = unpackHitRecords(buffer);
    expect(records).toEqual([
      { index: 0, t: 3.5, primitiveIndex: 7, status: HIT_STATUS.hit },
      { index: 1, t: -1, primitiveIndex: 0xffff_ffff, status: HIT_STATUS.miss },
      { index: 2, t: 0, primitiveIndex: 0, status: 2 },
    ]);
  });

  it("rejects malformed record and overflow buffers", () => {
    expect(() => unpackHitRecords(new ArrayBuffer(8))).toThrow("multiple of 16");
    expect(() => unpackStackOverflows(new ArrayBuffer(8))).toThrow("exactly 4 bytes");
    expect(unpackStackOverflows(new Uint32Array([0]).buffer)).toBe(0);
    expect(unpackStackOverflows(new Uint32Array([3]).buffer)).toBe(3);
  });
});
