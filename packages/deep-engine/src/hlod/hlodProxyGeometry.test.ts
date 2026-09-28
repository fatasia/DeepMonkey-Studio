import { describe, expect, it } from "vitest";
import { HlodError } from "./hlodTypes.js";
import {
  generateClusterProxyGeometry,
  resolveHlodProxyOptions,
  validateHlodShapes,
} from "./hlodProxyGeometry.js";
import type { HlodInstanceShape } from "./hlodProxyTypes.js";

/** 单位摘要构造:min/max 由中心与半跨度给出。 */
const shape = (id: string, cx: number, cy: number, cz: number, hx = 0.5, hy = 0.5, hz = 0.5): HlodInstanceShape =>
  ({ instanceId: id, min: [cx - hx, cy - hy, cz - hz], max: [cx + hx, cy + hy, cz + hz] });

describe("resolveHlodProxyOptions", () => {
  it("applies defaults and derives the effective box budget (multiple of 12 triangles)", () => {
    const config = resolveHlodProxyOptions();
    expect(config.maxProxyTriangles).toBe(96);
    expect(config.proxyBoxBudget).toBe(8);
    expect(resolveHlodProxyOptions({ maxProxyTriangles: 100 }).proxyBoxBudget).toBe(8);
    expect(resolveHlodProxyOptions({ maxProxyTriangles: 12 }).proxyBoxBudget).toBe(1);
  });

  it("rejects out-of-domain options fail-closed", () => {
    expect(() => resolveHlodProxyOptions({ maxProxyTriangles: 11 })).toThrow(HlodError);
    expect(() => resolveHlodProxyOptions({ maxProxyTriangles: 24577 })).toThrow(HlodError);
    expect(() => resolveHlodProxyOptions({ metricInstanceSampleLimit: 0 })).toThrow(HlodError);
    expect(() => resolveHlodProxyOptions({ metricEvalBudget: 0 })).toThrow(HlodError);
    expect(() => resolveHlodProxyOptions(null as never)).toThrow(HlodError);
  });
});

describe("validateHlodShapes", () => {
  it("canonicalizes the order independent of input permutation", () => {
    const ordered = validateHlodShapes([shape("b", 5, 0, 0), shape("a", 1, 0, 0), shape("c", 1, 0, 0)]);
    expect(ordered.map(value => value.instanceId)).toEqual(["a", "c", "b"]);
  });

  it("rejects duplicates, non-finite bounds and inverted bounds fail-closed", () => {
    expect(() => validateHlodShapes([shape("a", 0, 0, 0), shape("a", 1, 0, 0)])).toThrow(HlodError);
    expect(() => validateHlodShapes([{ instanceId: "a", min: [NaN, 0, 0], max: [1, 1, 1] }])).toThrow(HlodError);
    expect(() => validateHlodShapes([{ instanceId: "a", min: [2, 0, 0], max: [1, 1, 1] }])).toThrow(HlodError);
  });
});

describe("generateClusterProxyGeometry", () => {
  it("emits each shape as its exact box when within budget", () => {
    const result = generateClusterProxyGeometry([shape("a", 0, 0, 0), shape("b", 10, 0, 0)]);
    expect(result.budget.merged).toBe(false);
    expect(result.mesh.boxCount).toBe(2);
    expect(result.mesh.triangleCount).toBe(24);
    expect(result.mesh.vertices.length).toBe(2 * 24 * 6);
    expect(result.mesh.indices.length).toBe(2 * 36);
    // 顶点位置与摘要逐值吻合(f32 舍入内)。
    const xs = new Set<number>();
    for (let offset = 0; offset < result.mesh.vertices.length; offset += 6) xs.add(result.mesh.vertices[offset]!);
    expect([...xs].sort((a, b) => a - b)).toEqual([-0.5, 0.5, 9.5, 10.5]);
  });

  it("enforces the triangle budget as a hard constraint under merge", () => {
    const shapes: HlodInstanceShape[] = [];
    for (let index = 0; index < 20; index++) shapes.push(shape(`s${index}`, index * 3, 0, 0));
    const result = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 96 });
    expect(result.budget.merged).toBe(true);
    expect(result.mesh.boxCount).toBeLessThanOrEqual(8);
    expect(result.mesh.triangleCount).toBeLessThanOrEqual(96);
    expect(result.mesh.triangleCount).toBe(result.mesh.boxCount * 12);
    // 合并不丢内容:代理盒并集覆盖全部摘要(min/max 逐轴包含)。
    let minX = Infinity, maxX = -Infinity;
    for (let offset = 0; offset < result.mesh.vertices.length; offset += 6) {
      minX = Math.min(minX, result.mesh.vertices[offset]!);
      maxX = Math.max(maxX, result.mesh.vertices[offset]!);
    }
    expect(minX).toBeLessThanOrEqual(shapes[0]!.min[0]! + 1e-6);
    expect(maxX).toBeGreaterThanOrEqual(shapes[19]!.max[0]! - 1e-6);
  });

  it("merges two well-separated groups into their total bounds at budget 1", () => {
    const shapes = [shape("a", 0, 0, 0, 1, 1, 1), shape("b", 0.5, 0, 0, 1, 1, 1),
      shape("c", 100, 0, 0, 1, 1, 1), shape("d", 100.5, 0, 0, 1, 1, 1)];
    const result = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 12 });
    expect(result.mesh.boxCount).toBe(1);
    let minX = Infinity, maxX = -Infinity;
    for (let offset = 0; offset < result.mesh.vertices.length; offset += 6) {
      minX = Math.min(minX, result.mesh.vertices[offset]!);
      maxX = Math.max(maxX, result.mesh.vertices[offset]!);
    }
    expect(minX).toBeCloseTo(-1, 6);
    expect(maxX).toBeCloseTo(101.5, 6);
  });

  it("emits outward CCW faces with correct per-face normals", () => {
    const result = generateClusterProxyGeometry([shape("a", 0, 0, 0, 1, 2, 3)]);
    const axes = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
    for (const [face, axis] of axes.entries()) {
      for (let corner = 0; corner < 4; corner++) {
        const offset = (face * 4 + corner) * 6;
        expect(result.mesh.vertices[offset + 3]).toBe(axis[0]);
        expect(result.mesh.vertices[offset + 4]).toBe(axis[1]);
        expect(result.mesh.vertices[offset + 5]).toBe(axis[2]);
      }
      // 同一面的 4 顶点法向分量等于该面的极值坐标(外表面)。
      const component = axis[0] !== 0 ? 0 : axis[1] !== 0 ? 1 : 2;
      const sign = axis[component]!;
      for (let corner = 0; corner < 4; corner++) {
        const position = result.mesh.vertices[(face * 4 + corner) * 6 + component]!;
        expect(Math.sign(position)).toBe(sign);
      }
    }
    // 全部 6 面:前两个三角形构成的叉积与面法线同向(从外看 CCW,右手系)。
    const at = (vertex: number, axis: number): number => result.mesh.vertices[vertex * 6 + axis]!;
    for (let face = 0; face < 6; face++) {
      const base = face * 4;
      const u = [at(base + 1, 0) - at(base, 0), at(base + 1, 1) - at(base, 1), at(base + 1, 2) - at(base, 2)];
      const v = [at(base + 2, 0) - at(base, 0), at(base + 2, 1) - at(base, 1), at(base + 2, 2) - at(base, 2)];
      const cross = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
      const normal = [at(base, 3), at(base, 4), at(base, 5)];
      const dot = cross[0]! * normal[0]! + cross[1]! * normal[1]! + cross[2]! * normal[2]!;
      expect(dot).toBeGreaterThan(0);
    }
    // 索引构成 (0,1,2)/(0,2,3) 两三角,无越界引用。
    for (const index of result.mesh.indices) expect(index).toBeLessThan(24);
    expect(result.mesh.indices[3]).toBe(result.mesh.indices[0]);
  });

  it("handles degenerate zero-extent shapes without NaN", () => {
    const result = generateClusterProxyGeometry(
      [shape("p", 0, 0, 0, 0, 0, 0), shape("q", 1, 0, 0, 0, 0, 0), shape("r", 5, 0, 0, 0, 0, 0)],
      { maxProxyTriangles: 12 });
    expect(result.mesh.vertices.every(Number.isFinite)).toBe(true);
    expect(result.mesh.triangleCount).toBe(12);
  });

  it("is bit-identical across runs and input permutations", () => {
    const shapes: HlodInstanceShape[] = [];
    for (let index = 0; index < 37; index++) {
      shapes.push(shape(`s${index}`, (index * 7) % 23, (index * 13) % 17, index % 5, 0.4, 0.6, 0.3));
    }
    const reversed = [...shapes].reverse();
    const rotated = [...shapes.slice(11), ...shapes.slice(0, 11)];
    const reference = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 48 });
    for (const permutation of [shapes, reversed, rotated]) {
      const candidate = generateClusterProxyGeometry(permutation, { maxProxyTriangles: 48 });
      expect(candidate.mesh.triangleCount).toBe(reference.mesh.triangleCount);
      expect(candidate.mesh.vertices).toEqual(reference.mesh.vertices);
      expect(candidate.mesh.indices).toEqual(reference.mesh.indices);
    }
    // 逐字节复核(等于逐元素,typed array 口径的更强陈述)。
    const second = generateClusterProxyGeometry(shapes, { maxProxyTriangles: 48 });
    expect(Buffer.from(second.mesh.vertices).equals(Buffer.from(reference.mesh.vertices))).toBe(true);
    expect(second.algorithmVersion).toBe("t26-hlod-proxy-v1");
  });

  it("requires at least one shape and rejects empty input fail-closed", () => {
    expect(() => generateClusterProxyGeometry([])).toThrow(HlodError);
  });
});
