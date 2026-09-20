import { describe, expect, it } from "vitest";
import { packLocalTriangle } from "../geometry/localTriangle.js";
import type { MeshletBuildResult } from "../geometry/types.js";
import { buildVisibilityMeshletLayout, INSTANCE_ROW_FLOATS, invertMat4, isValidVisibilityPixel,
  packVisibilitySlotRow, packVisibilityTriangle, unpackVisibilitySlotRow, unpackVisibilityTriangle,
  VISIBILITY_CLEAR_SLOT, VISIBILITY_MAX_TRIANGLES_PER_MESHLET, VISIBILITY_SLOT_ROW_FLOATS,
  visibilitySlotRowFromInstance, type VisibilitySlotRow } from "./visibilityBufferEncoding.js";

describe("visibility buffer encoding contract", () => {
  it("round-trips triangle local indices through the 8-bit channel layout", () => {
    for (let triangle = 0; triangle < VISIBILITY_MAX_TRIANGLES_PER_MESHLET; triangle += 1) {
      expect(unpackVisibilityTriangle(packVisibilityTriangle(triangle))).toBe(triangle);
    }
  });

  it("keeps reserved bits zero and rejects out-of-domain triangles", () => {
    const packed = packVisibilityTriangle(125);
    expect(packed).toBe(125);
    expect(packed & ~0xff).toBe(0);
    expect(() => packVisibilityTriangle(VISIBILITY_MAX_TRIANGLES_PER_MESHLET)).toThrow(RangeError);
    expect(() => packVisibilityTriangle(-1)).toThrow(RangeError);
    expect(() => packVisibilityTriangle(1.5)).toThrow(RangeError);
    // 高位脏数据在解包时被掩蔽，但合同校验会拒绝它进入合法像素判定。
    expect(isValidVisibilityPixel(3, 0x00ff_00ff)).toBe(false);
  });

  it("treats the all-ones sentinel and oversized triangles as uncovered", () => {
    expect(isValidVisibilityPixel(VISIBILITY_CLEAR_SLOT, 0)).toBe(false);
    expect(isValidVisibilityPixel(VISIBILITY_CLEAR_SLOT, VISIBILITY_CLEAR_SLOT)).toBe(false);
    expect(isValidVisibilityPixel(0, VISIBILITY_CLEAR_SLOT)).toBe(false);
    expect(isValidVisibilityPixel(0, 126)).toBe(false);
    expect(isValidVisibilityPixel(0, 0)).toBe(true);
  });

  it("round-trips slot rows through the 16-float table layout", () => {
    const row: VisibilitySlotRow = { colorMetal: [0.25, 0.5, 0.75, 0.125], material: [0.4, 0.5, 1, 16],
      emissiveAlpha: [0.9, 0.8, 0.7, 1] };
    const packed = packVisibilitySlotRow(row);
    expect(packed.length).toBe(VISIBILITY_SLOT_ROW_FLOATS);
    const restored = unpackVisibilitySlotRow(packed, 0);
    [...restored.colorMetal, ...restored.material, ...restored.emissiveAlpha].forEach((value, index) => {
      const expected = [...row.colorMetal, ...row.material, ...row.emissiveAlpha][index]!;
      expect(value).toBeCloseTo(expected, 6);
    });
  });

  it("extracts slot rows from the same instance floats the forward shader consumes", () => {
    const instanceRow = new Float32Array(INSTANCE_ROW_FLOATS);
    instanceRow.set([1, 0, 0, 0], 24); instanceRow.set([0.7, 0.06, 0, 0], 28); instanceRow.set([0.1, 0.2, 0.3, 1], 32);
    const row = visibilitySlotRowFromInstance(instanceRow);
    [...row.colorMetal, ...row.material, ...row.emissiveAlpha].forEach((value, index) => {
      const expected = [1, 0, 0, 0, 0.7, 0.06, 0, 0, 0.1, 0.2, 0.3, 1][index]!;
      expect(value).toBeCloseTo(expected, 6);
    });
    expect(() => visibilitySlotRowFromInstance(new Float32Array(12))).toThrow(/36-float/);
  });
});

describe("visibility meshlet layout", () => {
  // 两个 meshlet：m0 用顶点 0/1/2/3（两三角共享顶点 1），m1 用顶点 4/5/6。
  const built: MeshletBuildResult = {
    schemaVersion: 1, sourceVertexCount: 7, sourceTriangleCount: 3, meshletCount: 2, maxVertices: 64, maxTriangles: 126,
    descriptors: Uint32Array.from([0, 4, 0, 2, 4, 3, 2, 1]),
    vertexRemap: Uint32Array.from([0, 1, 2, 3, 4, 5, 6]),
    localTriangleIndices: Uint32Array.from([packLocalTriangle(0, 1, 2), packLocalTriangle(1, 3, 2), packLocalTriangle(0, 1, 2)]),
    bounds: new Float32Array(2 * 16),
  };
  const positions = Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0, 2, 0, 0, 3, 0, 0, 3, 1, 0]);

  it("keeps identity indices so the whole level draws with one drawIndexed", () => {
    const layout = buildVisibilityMeshletLayout(built, positions);
    expect([...layout.indices]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it("expands meshlets unshared so slots never collide across meshlets", () => {
    const layout = buildVisibilityMeshletLayout(built, positions);
    // m0: 三角 0 = 顶点 0/1/2，三角 1 = 顶点 1/3/2；m1: 三角 0 = 顶点 4/5/6。
    expect([...layout.positions.slice(0, 9)]).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
    expect([...layout.positions.slice(9, 18)]).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 0]);
    expect([...layout.positions.slice(18, 27)]).toEqual([2, 0, 0, 3, 0, 0, 3, 1, 0]);
  });

  it("carries the meshlet-local triangle index on every corner slot", () => {
    const layout = buildVisibilityMeshletLayout(built, positions);
    expect([...layout.triangleCarriers]).toEqual([0, 0, 0, 1, 1, 1, 0, 0, 0]);
    expect(layout.triangleCarriers.every(value => value < VISIBILITY_MAX_TRIANGLES_PER_MESHLET)).toBe(true);
  });

  it("flips winding consistently with the expanded index path", () => {
    const layout = buildVisibilityMeshletLayout(built, positions, "flip");
    expect([...layout.positions.slice(0, 9)]).toEqual([0, 0, 0, 0, 1, 0, 1, 0, 0]);
  });

  it("rejects non-XYZ positions and out-of-bounds remaps", () => {
    expect(() => buildVisibilityMeshletLayout(built, new Float32Array(4))).toThrow(/XYZ/);
    const broken: MeshletBuildResult = { ...built, vertexRemap: Uint32Array.from([0, 1, 2, 3, 4, 5, 99]) };
    expect(() => buildVisibilityMeshletLayout(broken, positions)).toThrow(/bounds/);
  });
});

describe("visibility resolve matrix inversion", () => {
  it("inverts a column-major perspective*view so that m*inv is the identity", () => {
    const view = Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -3, -2, -5, 1]);
    const projection = Float32Array.from([1.5, 0, 0, 0, 0, 2, 0, 0, 0, 0, 0.5, -1, 0, 0, 0.25, 0]);
    const viewProjection = multiply(projection, view);
    const inverse = invertMat4(viewProjection);
    const product = multiply(viewProjection, inverse);
    for (let index = 0; index < 16; index += 1) {
      const expected = index % 5 === 0 ? 1 : 0;
      expect(product[index]!).toBeCloseTo(expected, 5);
    }
  });

  it("refuses singular matrices instead of producing garbage world positions", () => {
    expect(() => invertMat4(new Float32Array(16))).toThrow(/singular/);
    expect(() => invertMat4(new Float32Array(8))).toThrow(/16 elements/);
  });
});

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let column = 0; column < 4; column++) for (let row = 0; row < 4; row++) {
    for (let k = 0; k < 4; k++) out[column * 4 + row]! += a[k * 4 + row]! * b[column * 4 + k]!;
  }
  return out;
}
