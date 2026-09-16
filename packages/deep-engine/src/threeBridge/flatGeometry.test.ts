import { describe, expect, it } from "vitest";
import type { GeometryResource } from "../renderPacket.js";
import { flattenGeometry } from "./flatGeometry.js";
import { ProjectionFailure } from "./types.js";

type Source = Omit<GeometryResource, "id" | "revision">;

/** XY 平面上逆时针的单位三角形；顶点法线是占位的平滑法线，派生后必须被面法线覆盖。 */
function triangle(): Source {
  return {
    vertices: new Float32Array([
      0, 0, 0, 0, 0, 1,
      1, 0, 0, 0, 0, 1,
      0, 1, 0, 0, 0, 1,
    ]),
    indices: new Uint32Array([0, 1, 2]),
  };
}
function normal(resource: Source, vertex: number): readonly [number, number, number] {
  return [resource.vertices[vertex * 6 + 3]!, resource.vertices[vertex * 6 + 4]!, resource.vertices[vertex * 6 + 5]!];
}

describe("flat geometry derivation contract", () => {
  it("expands an indexed triangle into non-indexed vertices with a winding-derived face normal", () => {
    const flat = flattenGeometry(triangle());
    expect(flat.indices).toEqual(new Uint32Array([0, 1, 2]));
    expect(flat.vertices.length).toBe(18);
    expect(normal(flat, 0)).toEqual([0, 0, 1]);
    expect(normal(flat, 1)).toEqual([0, 0, 1]);
    expect(normal(flat, 2)).toEqual([0, 0, 1]);
  });

  it("unfolds shared indexed faces so every corner owns the normal of its own face", () => {
    const source = triangle();
    // 两个三角形共享边 0-1；第二个三角形（1-3-0）折向 -Z 一侧。
    source.vertices = new Float32Array([
      0, 0, 0, 0, 1, 0,
      1, 0, 0, 0, 1, 0,
      0, 1, 0, 0, 0, 1,
      1, -1, 0, 0, 1, 0,
    ]);
    source.indices = new Uint32Array([0, 1, 2, 1, 3, 0]);
    const flat = flattenGeometry(source);
    expect(flat.vertices.length).toBe(36);
    expect(Array.from(flat.indices)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(normal(flat, 0)).toEqual([0, 0, 1]);
    expect(normal(flat, 3)).toEqual([0, 0, -1]);
    // 共享顶点在源里是同一个位置；展开后两份拷贝位置一致而法线各随各面。
    expect([flat.vertices[0], flat.vertices[1], flat.vertices[2]])
      .toEqual([flat.vertices[30], flat.vertices[31], flat.vertices[32]]);
  });

  it("flips the derived normal on mirrored geometry so renderer-side mirrored batches keep fronts aligned", () => {
    const mirrored = triangle();
    for (let vertex = 0; vertex < 3; vertex++) mirrored.vertices[vertex * 6]! *= -1;
    const flat = flattenGeometry(mirrored);
    expect(normal(flat, 0)).toEqual([0, 0, -1]);
  });

  it("keeps unit face normals perpendicular to the face under baked non-uniform scaling", () => {
    const scaled = triangle();
    for (let vertex = 0; vertex < 3; vertex++) {
      scaled.vertices[vertex * 6]! *= 4;
      scaled.vertices[vertex * 6 + 1]! *= 0.25;
    }
    const flat = flattenGeometry(scaled);
    for (let vertex = 0; vertex < 3; vertex++) {
      const [x, y, z] = normal(flat, vertex);
      expect(Math.hypot(x, y, z)).toBeCloseTo(1, 5);
      expect(Math.abs(z)).toBeCloseTo(1, 5);
    }
  });

  it("carries uv and vertex-color streams through the expansion", () => {
    const source = triangle();
    source.uv0 = new Float32Array([0, 0, 1, 0, 0, 1]);
    source.colors = new Float32Array([0.1, 0.2, 0.3, 1, 0.4, 0.5, 0.6, 0, 0.7, 0.8, 0.9, 1]);
    const flat = flattenGeometry(source);
    expect(flat.uv0).toEqual(new Float32Array([0, 0, 1, 0, 0, 1]));
    expect(flat.colors).toEqual(source.colors);
  });

  it("rejects degenerate faces instead of emitting NaN normals", () => {
    const degenerate = triangle();
    // 顶点 1、2 与顶点 0 共线（X 轴上），cross 为零向量。
    degenerate.vertices.set([2, 0, 0, 0, 0, 1, 4, 0, 0, 0, 0, 1], 6);
    try {
      flattenGeometry(degenerate);
      expect.unreachable("degenerate faces must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionFailure);
      expect((error as ProjectionFailure).feature).toBe("degenerate flat face");
    }
  });

  it("rejects out-of-range indices and tangent inputs", () => {
    const indexed = triangle();
    indexed.indices = new Uint32Array([0, 1, 7]);
    expect(() => flattenGeometry(indexed)).toThrow(ProjectionFailure);
    const tangent = triangle();
    tangent.tangents = new Float32Array(12);
    try {
      flattenGeometry(tangent);
      expect.unreachable("tangent inputs must be rejected");
    } catch (error) {
      expect(error).toBeInstanceOf(ProjectionFailure);
      expect((error as ProjectionFailure).code).toBe("unsupported");
    }
  });
});
